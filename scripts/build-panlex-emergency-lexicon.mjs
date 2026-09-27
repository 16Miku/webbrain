import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_URL = 'https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/panlex_swadesh.zip';
const SOURCE_SHA256 = 'dc028da016ba7d5f9bcc39263b0c3dc27bd56025672b18ccaec4578833fe4dff';
const CANONICAL_ENGLISH = Object.freeze([
  'all', 'ashes', 'bark', 'belly', 'big', 'bird', 'bite', 'black', 'blood', 'bone',
  'breast', 'burn', 'claw', 'cloud', 'cold', 'come', 'die', 'dog', 'drink', 'dry',
  'ear', 'earth', 'eat', 'egg', 'eye', 'fat', 'feather', 'fire', 'fish', 'fly',
  'foot', 'full', 'give', 'good', 'green', 'hair', 'hand', 'head', 'hear', 'heart',
  'horn', 'I', 'kill', 'knee', 'know', 'leaf', 'lie', 'liver', 'long', 'louse',
  'man', 'many', 'meat', 'moon', 'mountain', 'mouth', 'name', 'neck', 'new', 'night',
  'nose', 'not', 'one', 'person', 'rain', 'red', 'road', 'root', 'round', 'sand',
  'say', 'see', 'seed', 'sit', 'skin', 'sleep', 'small', 'smoke', 'stand', 'star',
  'stone', 'sun', 'swim', 'tail', 'that', 'this', 'you', 'tongue', 'tooth', 'tree',
  'two', 'walk', 'warm', 'water', 'we', 'what', 'white', 'who', 'woman', 'yellow',
  'far', 'heavy', 'near', 'salt', 'short', 'snake', 'thin', 'wind', 'worm', 'year',
]);

function parseLanguage(line) {
  const [uid, iso, type, script, name] = line.split('\t');
  if (!uid || !iso || !['i', 'm'].includes(type)) return null;
  return { uid, iso, script, name };
}

function compactTerms(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== CANONICAL_ENGLISH.length) return null;
  return lines.map(line => [...new Set(line.split('\t').map(value => value.trim()).filter(Boolean))].slice(0, 4));
}

async function main() {
  const response = await fetch(SOURCE_URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`PanLex corpus returned HTTP ${response.status}.`);
  const archive = Buffer.from(await response.arrayBuffer());
  const checksum = createHash('sha256').update(archive).digest('hex');
  if (checksum !== SOURCE_SHA256) throw new Error(`PanLex corpus checksum mismatch (${checksum}).`);

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'webbrain-panlex-'));
  try {
    const archivePath = path.join(temporaryDirectory, 'panlex-swadesh.zip');
    const extractPath = path.join(temporaryDirectory, 'corpus');
    await writeFile(archivePath, archive);
    await mkdir(extractPath);
    await execFileAsync('unzip', ['-q', archivePath, '-d', extractPath]);

    const corpusPath = path.join(extractPath, 'panlex_swadesh');
    const languages = (await readFile(path.join(corpusPath, 'langs110.txt'), 'utf8'))
      .replace(/\r/g, '').split('\n').map(parseLanguage).filter(Boolean);
    const entries = [];
    for (const language of languages) {
      let terms = compactTerms(await readFile(path.join(corpusPath, 'swadesh110', `${language.uid}.txt`), 'utf8'));
      if (!terms) throw new Error(`${language.uid} does not contain exactly 110 concepts.`);
      // PanLex preserves every attested synonym, including a few obviously
      // misaligned English attestations in this historical snapshot. Keep the
      // source-faithful target-language rows, but make the reader's English
      // baseline the canonical Swadesh-Yakhontov concept labels above.
      if (language.uid === 'eng-000') terms = CANONICAL_ENGLISH.map(concept => [concept]);
      entries.push({ ...language, terms });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name) || left.uid.localeCompare(right.uid));
    const isoLanguageCount = new Set(entries.map(entry => entry.iso)).size;
    const payload = {
      schemaVersion: 1,
      source: {
        title: 'PanLex Swadesh Corpus',
        version: 'January 2017',
        publisher: 'PanLex, a project of The Long Now Foundation',
        license: 'CC0 1.0 Universal',
        sourceUrl: 'https://dev.panlex.org/panlex-swadesh-corpus/',
        archiveUrl: SOURCE_URL,
        archiveSha256: SOURCE_SHA256,
      },
      conceptCount: CANONICAL_ENGLISH.length,
      languageCount: isoLanguageCount,
      varietyCount: entries.length,
      concepts: CANONICAL_ENGLISH,
      languages: entries,
    };
    const output = `${JSON.stringify(payload)}\n`;
    for (const browser of ['chrome', 'firefox']) {
      const outputDirectory = path.join(ROOT, 'src', browser, 'src', 'ui', 'data');
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(path.join(outputDirectory, 'panlex-swadesh-110.json'), output);
    }
    console.log(`Wrote ${entries.length} PanLex varieties across ${isoLanguageCount} ISO languages (${Buffer.byteLength(output)} bytes per browser).`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
