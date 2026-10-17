#!/usr/bin/env node
/**
 * Build the WebBrain new tab page and install it into both extensions.
 *
 *   npm --prefix newtab run build      (or: npm run build:newtab from the repo root)
 *
 * The extensions themselves have no build step and are loaded straight from
 * src/chrome and src/firefox, so the bundle is generated here and COMMITTED to
 * src/chrome/newtab and src/firefox/newtab (the store zips are made from git
 * HEAD). Source of truth is this directory; never edit the generated output.
 */
import { build } from 'vite';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const newtabRoot = path.resolve(here, '..');
const repoRoot = path.resolve(newtabRoot, '..');
const chromeOut = path.join(repoRoot, 'src', 'chrome', 'newtab');
const firefoxOut = path.join(repoRoot, 'src', 'firefox', 'newtab');

rmSync(chromeOut, { recursive: true, force: true });
await build({ root: newtabRoot, configFile: path.join(newtabRoot, 'vite.config.mjs'), logLevel: 'info' });

// Mue refers to bundled photos by a literal relative URL
// ("src/assets/offline-images/N.webp"), so they are copied, not bundled.
const assets = path.join(newtabRoot, 'src', 'assets', 'offline-images');
if (existsSync(assets)) {
  const dest = path.join(chromeOut, 'src', 'assets', 'offline-images');
  mkdirSync(dest, { recursive: true });
  cpSync(assets, dest, { recursive: true });
}

rmSync(firefoxOut, { recursive: true, force: true });
cpSync(chromeOut, firefoxOut, { recursive: true });
console.log(`newtab built -> ${path.relative(repoRoot, chromeOut)} and ${path.relative(repoRoot, firefoxOut)}`);
