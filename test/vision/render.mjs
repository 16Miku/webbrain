#!/usr/bin/env node
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { CASES } from './fixtures/cases.mjs';
import { renderCaseHtml } from './fixtures/render-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMAGE_DIR = join(HERE, 'images');
const ASSET_DIR = join(HERE, 'assets');
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2);
  return [key, value];
}));
const only = args.has('only') ? new Set(args.get('only').split(',').map(v => String(parseInt(v, 10)).padStart(3, '0'))) : null;
const force = args.has('force');

async function assetDataUrl(name) {
  const path = join(ASSET_DIR, name);
  const bytes = await readFile(path);
  const ext = extname(name).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

const assetNames = [...new Set(CASES.flatMap(c => [c.render.asset, c.render.asset2]).filter(Boolean))];
const assets = Object.fromEntries(await Promise.all(assetNames.map(async name => [name, await assetDataUrl(name)])));
await mkdir(IMAGE_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
let rendered = 0;
try {
  for (const entry of CASES) {
    if (only && !only.has(entry.id)) continue;
    const output = join(IMAGE_DIR, `${entry.id}.png`);
    if (!force) {
      try { if ((await stat(output)).size > 0) continue; } catch {}
    }
    await page.setContent(renderCaseHtml(entry, assets), { waitUntil: 'load' });
    await page.screenshot({ path: output, type: 'png', animations: 'disabled' });
    rendered += 1;
    process.stdout.write(`\rRendered ${rendered} image(s); latest ${entry.id}`);
  }
} finally {
  await browser.close();
}
process.stdout.write(`\nDone. ${rendered} image(s) written to ${IMAGE_DIR}\n`);
