#!/usr/bin/env node

import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqlite3InitModule = (await import(
  new URL('../src/chrome/vendor/sqlite/index.mjs', import.meta.url)
)).default;
const indexRuntime = await import(new URL('../src/chrome/src/agent/offline-rag-index.js', import.meta.url));
const ragRuntime = await import(new URL('../src/chrome/src/agent/offline-rag.js', import.meta.url));

function positiveInteger(value, fallback, maximum) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const passageCount = positiveInteger(process.argv[2], 10_000, 250_000);
const queryRounds = positiveInteger(process.argv[3], 200, 10_000);
const previousLocation = globalThis.location;
globalThis.location = { href: 'https://offline.invalid/?opfs-disable&opfs-wl-disable' };
let sqlite3;
try {
  sqlite3 = await sqlite3InitModule({
    wasmBinary: await (await import('node:fs/promises')).readFile(
      path.join(root, 'src/chrome/vendor/sqlite/sqlite3.wasm'),
    ),
    print: () => {},
    printErr: () => {},
  });
} finally {
  if (previousLocation === undefined) delete globalThis.location;
  else globalThis.location = previousLocation;
}
sqlite3.config.log = () => {};

const db = new sqlite3.oo1.DB(':memory:', 'c');
const heapBefore = process.memoryUsage().heapUsed;
const started = performance.now();
try {
  db.exec(indexRuntime.EMERGENCY_FTS_SCHEMA_SQL);
  const insert = db.prepare(indexRuntime.EMERGENCY_FTS_INSERT_SQL);
  db.exec('BEGIN');
  try {
    for (let index = 0; index < passageCount; index += 1) {
      const cjk = index % 2 === 1;
      const documentId = `benchmark-${index}`;
      const title = cjk ? `急救处理 ${index}` : `Emergency airway guide ${index}`;
      const locator = cjk ? '呼吸道' : 'Airway';
      const text = cjk
        ? `保持呼吸道畅通，并观察呼吸。基准段落 ${index}。`
        : `Keep the airway open and monitor breathing. Benchmark passage ${index}.`;
      const language = cjk ? 'zho' : 'eng';
      const searchTerms = ragRuntime.tokenizeForLexicalSearch(
        `${title}\nhealth\n${locator}\n${text}`,
        { language },
      ).join(' ');
      insert.bind([
        `${documentId}:0`, documentId, 'benchmark-v1', title, language,
        'health', 'https://example.invalid/emergency-source', 'CC BY-SA 4.0',
        locator, text, searchTerms, 'a'.repeat(64), 24, 0,
        `webbrain-reader://emergency-box/${documentId}?passage=${documentId}%3A0`,
      ]).stepReset().clearBindings();
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    insert.finalize();
  }
  const indexMs = performance.now() - started;
  const queryStats = {};
  for (const [label, query] of [['english', 'airway breathing'], ['cjk', '急救 呼吸道']]) {
    const ftsQuery = indexRuntime.buildFts5Query(query);
    db.selectObjects(indexRuntime.EMERGENCY_FTS_SEARCH_SQL, [ftsQuery, 40]);
    const samples = [];
    let resultCount = 0;
    for (let round = 0; round < queryRounds; round += 1) {
      const queryStarted = performance.now();
      const results = db.selectObjects(indexRuntime.EMERGENCY_FTS_SEARCH_SQL, [ftsQuery, 40]);
      samples.push(performance.now() - queryStarted);
      resultCount = results.length;
    }
    samples.sort((left, right) => left - right);
    queryStats[label] = {
      query,
      resultCount,
      medianMs: Number(percentile(samples, 0.5).toFixed(3)),
      p95Ms: Number(percentile(samples, 0.95).toFixed(3)),
      maximumMs: Number(samples.at(-1).toFixed(3)),
    };
  }
  const pageCount = Number(db.selectValue('PRAGMA page_count'));
  const pageSize = Number(db.selectValue('PRAGMA page_size'));
  const heapAfter = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({
    runtime: `node ${process.version}`,
    passageCount,
    queryRounds,
    indexMs: Number(indexMs.toFixed(3)),
    passagesPerSecond: Number((passageCount / (indexMs / 1000)).toFixed(1)),
    databaseBytes: pageCount * pageSize,
    heapDeltaBytes: heapAfter - heapBefore,
    quickCheck: db.selectValue('PRAGMA quick_check'),
    queries: queryStats,
  }, null, 2));
} finally {
  db.close();
}
