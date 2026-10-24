#!/usr/bin/env node
/**
 * Vendor DuckDuckGo's autoconsent (MPL-2.0) into both extension trees.
 *
 *   node scripts/update-autoconsent.mjs           # copy the pinned version
 *   node scripts/update-autoconsent.mjs --check   # verify the vendored copies, no network
 *
 * Why vendored with a documented patch, with no bundler: MPL-2.0 keeps any edited
 * autoconsent file under the MPL, and the extension loads from source with no
 * build step (AGENT.md). WebBrain's glue lives in its own files, under
 * WebBrain's license: src/<browser>/src/content/autoconsent-bridge.js,
 * src/<browser>/src/agent/cookie-banner-host.js and
 * src/<browser>/src/agent/cookie-banner-rules.js.
 *
 * To update: set VERSION and INTEGRITY from
 *   npm view @duckduckgo/autoconsent@<version> dist.integrity
 * run this script, read upstream's CHANGELOG for message or rule-format
 * changes, then run `node --test test/cookie-banner-host.mjs` and
 * `node test/cookie-banner-ui.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGE = '@duckduckgo/autoconsent';
export const VERSION = '16.61.0';
export const INTEGRITY = 'sha512-XRHCE4J9Q3tpF6TgbCilKDemBQsAWHBFR9S93UEwCnFA9jP54FTENz8nYez8/zyxh2O3O3r/K/gI8+DwtE4p6Q==';
export const VENDOR_DIRS = ['src/chrome/vendor/autoconsent', 'src/firefox/vendor/autoconsent'];
// Path inside the npm package -> vendored file name.
export const FILES = Object.freeze({
  'dist/autoconsent.playwright.js': 'autoconsent.playwright.js',
  'dist/autoconsent.esm.js': 'autoconsent.esm.js',
  'rules/compact-rules.json': 'compact-rules.json',
  LICENSE: 'LICENSE',
});
export const VENDOR_MANIFEST = 'vendor-manifest.json';
export const REGEX_PATCH = 'deduplicate-acknowledgement-cookie-nouns';
const PATCH_HEADER = '// WebBrain modification (MPL-2.0): remove redundant acknowledgement regex alternatives to prevent exponential backtracking.\n';
const UPSTREAM_NOUNS = '|hier|des cookies|de cookies|x)';
const PATCHED_NOUNS = '|hier|x)';

// "des cookies" and "de cookies" are already matched by the optional
// des/de article followed by cookie\\w*. Keeping both parses makes repeated
// cookie phrases exponential on a non-matching suffix (CodeQL js/redos).
export function patchAutoconsentRegex(source) {
  if (source.split(UPSTREAM_NOUNS).length !== 2) throw new Error('Upstream acknowledgement regex changed; review the patch');
  return PATCH_HEADER + source.replace(UPSTREAM_NOUNS, PATCHED_NOUNS);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readme(manifest) {
  const rows = Object.entries(manifest.files)
    .map(([name, hash]) => `| \`${name}\` | \`${hash}\` |`)
    .join('\n');
  return `# autoconsent (vendored)

DuckDuckGo's [autoconsent](https://github.com/duckduckgo/autoconsent) declines
cookie-consent banners. WebBrain uses it for the "Cookie banners" setting; see
\`docs/cookie-banners.md\`.

- Package: \`${manifest.package}@${manifest.version}\` (npm integrity \`${manifest.integrity}\`)
- Source: ${manifest.source}
- License: Mozilla Public License 2.0 (\`LICENSE\` here, and \`LICENSES/MPL-2.0.txt\` at the repository root)

The JavaScript bundles carry one reproducible WebBrain patch: remove the
redundant 'des cookies' / 'de cookies' acknowledgement-regex alternatives
that cause exponential backtracking. The optional articles already cover
those phrases. The patch is in 'scripts/update-autoconsent.mjs'; upstream
and patched hashes are recorded in 'vendor-manifest.json'.
These modified files remain MPL-2.0 and their complete source is published
here. Rules and license text are copied unmodified. WebBrain's own code lives outside this folder
(\`src/content/autoconsent-bridge.js\`, \`src/agent/cookie-banner-host.js\`, and
WebBrain's own rules in \`src/agent/cookie-banner-rules.js\`) and is under
WebBrain's license, GPL-3.0-or-later; MPL-2.0 allows that combination
(section 3.3).

To update, change the version in \`scripts/update-autoconsent.mjs\` and run
\`node scripts/update-autoconsent.mjs\`. \`node scripts/update-autoconsent.mjs --check\`
verifies these copies against the hashes below.

| File | SHA-256 |
|---|---|
${rows}
`;
}

function fetchPackage(dir) {
  const output = execFileSync('npm', ['pack', `${PACKAGE}@${VERSION}`, '--json', '--pack-destination', dir], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const [info] = JSON.parse(output);
  if (info?.integrity !== INTEGRITY) {
    throw new Error(`${PACKAGE}@${VERSION} integrity ${info?.integrity} does not match the pinned ${INTEGRITY}`);
  }
  execFileSync('tar', ['-xzf', path.join(dir, info.filename), '-C', dir]);
  return path.join(dir, 'package');
}

export function vendorAutoconsent(root = ROOT) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'webbrain-autoconsent-'));
  try {
    const pkg = fetchPackage(tmp);
    const files = {};
    const upstreamFiles = {};
    for (const [from, to] of Object.entries(FILES)) {
      const source = path.join(pkg, from);
      if (!existsSync(source)) throw new Error(`${PACKAGE}@${VERSION} has no ${from}`);
      upstreamFiles[to] = sha256(source);
      if (to.endsWith('.js')) writeFileSync(source, patchAutoconsentRegex(readFileSync(source, 'utf8')));
      files[to] = sha256(source);
    }
    const manifest = {
      package: PACKAGE,
      version: VERSION,
      integrity: INTEGRITY,
      source: `https://github.com/duckduckgo/autoconsent/tree/v${VERSION}`,
      license: 'MPL-2.0',
      patches: [REGEX_PATCH],
      upstreamFiles,
      files,
    };
    for (const dir of VENDOR_DIRS) {
      const target = path.join(root, dir);
      mkdirSync(target, { recursive: true });
      for (const [from, to] of Object.entries(FILES)) copyFileSync(path.join(pkg, from), path.join(target, to));
      writeFileSync(path.join(target, VENDOR_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(path.join(target, 'README.md'), readme(manifest));
    }
    mkdirSync(path.join(root, 'LICENSES'), { recursive: true });
    copyFileSync(path.join(pkg, 'LICENSE'), path.join(root, 'LICENSES', 'MPL-2.0.txt'));
    return manifest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Returns a list of problems; empty when both trees hold the pinned files.
export function checkVendoredAutoconsent(root = ROOT) {
  const problems = [];
  for (const dir of VENDOR_DIRS) {
    const manifestPath = path.join(root, dir, VENDOR_MANIFEST);
    if (!existsSync(manifestPath)) {
      problems.push(`${dir}/${VENDOR_MANIFEST} is missing`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.version !== VERSION || manifest.integrity !== INTEGRITY) {
      problems.push(`${dir} holds ${manifest.version}, expected ${VERSION}`);
    }
    if (JSON.stringify(manifest.patches) !== JSON.stringify([REGEX_PATCH])) problems.push(`${dir} is missing the regex hardening patch`);
    for (const name of Object.values(FILES)) {
      const file = path.join(root, dir, name);
      if (!existsSync(file)) {
        problems.push(`${dir}/${name} is missing`);
      } else if (sha256(file) !== manifest.files?.[name]) {
        problems.push(`${dir}/${name} differs from its recorded patched hash`);
      } else if (name.endsWith('.js')) {
        const patched = readFileSync(file, 'utf8');
        const original = patched.slice(PATCH_HEADER.length).replace(PATCHED_NOUNS, UPSTREAM_NOUNS);
        if (!patched.startsWith(PATCH_HEADER) || patched.split(PATCHED_NOUNS).length !== 2
          || createHash('sha256').update(original).digest('hex') !== manifest.upstreamFiles?.[name]) {
          problems.push(`${dir}/${name} cannot be reconstructed as the pinned upstream file plus the documented patch`);
        }
      }
    }
  }
  if (!existsSync(path.join(root, 'LICENSES', 'MPL-2.0.txt'))) problems.push('LICENSES/MPL-2.0.txt is missing');
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (process.argv.includes('--check')) {
    const problems = checkVendoredAutoconsent();
    if (problems.length) {
      for (const problem of problems) console.error(problem);
      process.exit(1);
    }
    console.log(`autoconsent ${VERSION}: vendored copies match`);
  } else {
    const manifest = vendorAutoconsent();
    console.log(`Vendored ${manifest.package}@${manifest.version} into ${VENDOR_DIRS.join(' and ')}`);
  }
}
