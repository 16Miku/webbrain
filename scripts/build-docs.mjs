#!/usr/bin/env node
/**
 * Ensures every documentation page includes the shared site analytics partial.
 *
 * This idempotent pass recursively covers new HTML pages added under web/docs,
 * so authors do not have to copy the analytics block page by page.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAUSIBLE_SCRIPT_URL, withPlausibleAnalytics } from '../web/build/plausible.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'web', 'docs');

async function listHtmlFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listHtmlFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(fullPath);
  }
  return files.sort();
}

async function main() {
  const files = await listHtmlFiles(DOCS_DIR);
  for (const file of files) {
    const original = await readFile(file, 'utf8');
    const generated = withPlausibleAnalytics(original);
    const occurrences = generated.split(PLAUSIBLE_SCRIPT_URL).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${path.relative(REPO_ROOT, file)} contains ${occurrences} Plausible scripts`);
    }
    if (generated !== original) await writeFile(file, generated, 'utf8');
    console.log(`wrote ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
