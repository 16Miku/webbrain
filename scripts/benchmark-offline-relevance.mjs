#!/usr/bin/env node

/**
 * Relevance benchmark for offline retrieval.
 *
 * The sibling benchmark-offline-rag.mjs measures how fast the index builds and
 * answers; this one measures whether the right passage comes back at all. It
 * runs the shipped query builder and the shipped bm25 search SQL against the
 * fixture corpus, so a change to either shows up here before it reaches anyone
 * relying on the archive with no network to check against.
 *
 * Usage: node scripts/benchmark-offline-relevance.mjs [--json] [--verbose]
 * Exits non-zero when a metric falls below the floor recorded in FLOORS.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asJson = process.argv.includes('--json');
const verbose = process.argv.includes('--verbose');

const sqlite3InitModule = (await import(new URL('../src/chrome/vendor/sqlite/index.mjs', import.meta.url))).default;
const indexRuntime = await import(new URL('../src/chrome/src/agent/offline-rag-index.js', import.meta.url));
const ragRuntime = await import(new URL('../src/chrome/src/agent/offline-rag.js', import.meta.url));
const { RELAXED_RETRY_THRESHOLD } = await import(new URL('../src/chrome/src/agent/offline-retrieval.js', import.meta.url));
const { RELEVANCE_CORPUS, RELEVANCE_QUERIES } = await import(
  new URL('../test/fixtures/offline-relevance-corpus.mjs', import.meta.url)
);

// Regression floors. Raise these whenever a change improves a class of query, so
// the next change cannot quietly give the ground back.
const FLOORS = { 'recall@1': 0.90, 'recall@5': 0.97, mrr: 0.94 };

const previousLocation = globalThis.location;
globalThis.location = { href: 'https://offline.invalid/?opfs-disable&opfs-wl-disable' };
let sqlite3;
try {
  sqlite3 = await sqlite3InitModule({
    wasmBinary: await readFile(path.join(root, 'src/chrome/vendor/sqlite/sqlite3.wasm')),
    print: () => {},
    printErr: () => {},
  });
} finally {
  if (previousLocation === undefined) delete globalThis.location;
  else globalThis.location = previousLocation;
}
sqlite3.config.log = () => {};

const db = new sqlite3.oo1.DB(':memory:', 'c');
db.exec(indexRuntime.EMERGENCY_FTS_SCHEMA_SQL);
const insert = db.prepare(indexRuntime.EMERGENCY_FTS_INSERT_SQL);
db.exec('BEGIN');
try {
  for (const [ordinal, doc] of RELEVANCE_CORPUS.entries()) {
    const searchTerms = ragRuntime.tokenizeForLexicalSearch(
      `${doc.title}\n${doc.collection}\n${doc.locator}\n${doc.text}`,
      { language: doc.language },
    ).join(' ');
    insert.bind([
      `${doc.id}:0`, doc.id, 'relevance-fixture', doc.title, doc.language,
      doc.collection, 'fixture', 'CC0', doc.locator, doc.text, searchTerms,
      'a'.repeat(64), Math.ceil(doc.text.length / 4), ordinal,
      `webbrain-reader://emergency-box/${doc.id}?passage=${encodeURIComponent(`${doc.id}:0`)}`,
    ]).stepReset().clearBindings();
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  insert.finalize();
}
db.exec("INSERT INTO passages(passages) VALUES('optimize')");

function runMatch(match, limit) {
  if (!match) return [];
  const statement = db.prepare(indexRuntime.EMERGENCY_FTS_SEARCH_SQL);
  const documents = [];
  try {
    statement.bind([match, limit]);
    while (statement.step()) documents.push(statement.get({}).documentId);
  } finally {
    statement.finalize();
  }
  return documents;
}

// Mirrors searchEmergencyLexical: exact first, relaxed only when exact is thin,
// exact results always ranked above relaxed ones.
function search(queryText, limit = 5) {
  const exact = runMatch(indexRuntime.buildFts5Query(queryText), limit);
  if (exact.length >= RELAXED_RETRY_THRESHOLD) return exact;
  const relaxed = runMatch(indexRuntime.buildFts5Query(queryText, { relax: true }), limit);
  const merged = [...exact];
  for (const id of relaxed) if (!merged.includes(id)) merged.push(id);
  return merged.slice(0, limit);
}

const results = RELEVANCE_QUERIES.map(item => {
  const ranked = search(item.q);
  const rank = ranked.indexOf(item.expect);
  return { ...item, ranked, rank: rank < 0 ? null : rank + 1 };
});

function summarize(rows) {
  const total = rows.length || 1;
  return {
    n: rows.length,
    'recall@1': rows.filter(row => row.rank === 1).length / total,
    'recall@5': rows.filter(row => row.rank !== null).length / total,
    mrr: rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / total,
  };
}

const overall = summarize(results);
const byKind = {};
for (const kind of [...new Set(RELEVANCE_QUERIES.map(item => item.kind))]) {
  byKind[kind] = summarize(results.filter(row => row.kind === kind));
}

if (asJson) {
  console.log(JSON.stringify({ overall, byKind, results }, null, 2));
} else {
  const pct = value => `${(value * 100).toFixed(1)}%`;
  console.log(`Offline retrieval relevance: ${RELEVANCE_CORPUS.length} passages, ${results.length} queries\n`);
  console.log(`${'query class'.padEnd(14)} ${'n'.padStart(3)}  ${'recall@1'.padStart(8)} ${'recall@5'.padStart(8)} ${'MRR'.padStart(6)}`);
  for (const [kind, stats] of Object.entries(byKind)) {
    console.log(`${kind.padEnd(14)} ${String(stats.n).padStart(3)}  ${pct(stats['recall@1']).padStart(8)} ${pct(stats['recall@5']).padStart(8)} ${stats.mrr.toFixed(3).padStart(6)}`);
  }
  console.log(`${'OVERALL'.padEnd(14)} ${String(overall.n).padStart(3)}  ${pct(overall['recall@1']).padStart(8)} ${pct(overall['recall@5']).padStart(8)} ${overall.mrr.toFixed(3).padStart(6)}`);

  const missed = results.filter(row => row.rank === null);
  if (missed.length) {
    console.log(`\nnot found in top 5 (${missed.length}):`);
    for (const row of missed) console.log(`  [${row.kind}] "${row.q}" -> wanted ${row.expect}, got ${row.ranked.slice(0, 3).join(', ') || '(nothing)'}`);
  }
  if (verbose) {
    const demoted = results.filter(row => row.rank !== null && row.rank > 1);
    if (demoted.length) {
      console.log(`\nfound but not first (${demoted.length}):`);
      for (const row of demoted) console.log(`  [${row.kind}] "${row.q}" -> ${row.expect} at rank ${row.rank} (top: ${row.ranked[0]})`);
    }
  }
}

db.close();

const failures = Object.entries(FLOORS).filter(([metric, floor]) => overall[metric] < floor);
if (failures.length) {
  for (const [metric, floor] of failures) {
    console.error(`\nFAIL ${metric} ${(overall[metric] * 100).toFixed(1)}% is below the ${(floor * 100).toFixed(1)}% floor.`);
  }
  process.exit(1);
}
