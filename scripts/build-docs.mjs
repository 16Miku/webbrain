#!/usr/bin/env node
/**
 * Ensures every documentation page includes the shared site analytics partial
 * and the shared links that belong in its guide navigation.
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

function withGuideNavigation(html, file) {
  const normalized = file.replace(/\\/g, '/');
  // FAQ pages have a page-specific topic rail instead of the guide index.
  if (normalized.endsWith('/faq/index.html')) return html;

  const isChinese = normalized.includes('/web/docs/zh/');
  const overviewHref = isChinese ? '/docs/zh/' : '/docs/';
  const faqHref = isChinese ? '/docs/zh/faq/' : '/docs/faq/';
  const faqLabel = isChinese ? '常见问题' : 'FAQ';
  let generated = html;
  if (!generated.includes(`href="${faqHref}"`)) {
    const escapedOverview = overviewHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const overviewLink = new RegExp(`(<nav><a href="${escapedOverview}"[^>]*>[^<]*<\\/a>)`);
    const withFaq = generated.replace(overviewLink, `$1<a href="${faqHref}">${faqLabel}</a>`);
    if (withFaq === generated) {
      throw new Error(`${path.relative(REPO_ROOT, file)} is missing the docs overview navigation anchor`);
    }
    generated = withFaq;
  }

  const hasApocalypseModeNavigation = /<a href="\/docs\/apocalypse-mode\/"[^>]*>Apocalypse Mode<\/a>/.test(generated);
  if (!isChinese && !hasApocalypseModeNavigation) {
    const safetyLink = /(<a href="\/docs\/safety\/"[^>]*>[^<]*<\/a>)/;
    const withApocalypseMode = generated.replace(
      safetyLink,
      '$1<a href="/docs/apocalypse-mode/">Apocalypse Mode</a>',
    );
    if (withApocalypseMode === generated) {
      throw new Error(`${path.relative(REPO_ROOT, file)} is missing the safety guide navigation anchor`);
    }
    generated = withApocalypseMode;
  }

  return generated;
}

async function main() {
  const files = await listHtmlFiles(DOCS_DIR);
  for (const file of files) {
    const original = await readFile(file, 'utf8');
    const generated = withGuideNavigation(withPlausibleAnalytics(original), file);
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
