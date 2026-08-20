#!/usr/bin/env node

/**
 * Reproducible source build of the Xapian/libzim WebAssembly runtime.
 *
 * Runs on any host with Docker (Windows, macOS, Linux). Everything compiles
 * inside the pinned Emscripten image, so the host only needs Docker, Node, and
 * git. No GPU is involved: this is a CPU-bound C++ cross-compile, and it wants
 * cores and RAM, not a graphics card.
 *
 * It deliberately does NOT use upstream's `libzim_release` target, which
 * downloads a prebuilt libzim tarball. WebBrain cannot provide corresponding
 * source for a binary it did not build. See docs/offline-rag-licensing.md.
 *
 *   node scripts/build-zim-xapian.mjs                 # full build
 *   node scripts/build-zim-xapian.mjs --dry-run       # validate setup, compile nothing
 *   node scripts/build-zim-xapian.mjs --keep          # resume, reusing what already built
 *   node scripts/build-zim-xapian.mjs --work <dir>    # build outside the repo
 *   node scripts/build-zim-xapian.mjs --link-opt 1    # pin the final optimizer level
 *
 * Expect roughly 40-90 minutes on a fast machine: ICU and Xapian dominate.
 *
 * On Windows, prefer a --work directory on the WSL2 filesystem rather than a
 * path under C:\. Docker bind mounts from NTFS stamp files with the host clock,
 * which runs slightly ahead of the container and makes meson abort with "Clock
 * skew detected", and they are far slower for builds with many small files.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const keepWorkTree = process.argv.includes('--keep');
const workOverride = (() => {
  const index = process.argv.indexOf('--work');
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : '';
})();
const linkOptOverride = (() => {
  const index = process.argv.indexOf('--link-opt');
  if (index < 0) return 0;
  const level = Number(process.argv[index + 1]);
  if (![1, 2, 3].includes(level)) fail('--link-opt takes 1, 2, or 3.');
  return level;
})();

// Every version here must match the table in docs/offline-rag-licensing.md.
const PIN = Object.freeze({
  repository: 'https://github.com/openzim/javascript-libzim.git',
  tag: 'v0.95',
  commit: '470b36920fba421a4c1a83b326e66d8aa0533870',
  emscripten: '3.1.41',
  libzim: '9.8.1',
  xapian: '1.4.31',
  xz: '5.2.6',
  zlib: '1.3.1',
  zstd: '1.5.7',
  icu: '73.2',
});

// Only the WebAssembly build ships. The asm.js variant and the large-file test
// harness double the build time and are never loaded by the extension. The
// dependency build and the final link are separate steps so a failed link can
// be retried on its own: everything up to libzim.a takes minutes, the link
// takes seconds, and the link is the part that goes wrong.
const COMPILE_TARGETS = ['rename_pjsn', 'build/lib/libzim.a'];
const SHIPPED_ARTIFACTS = ['libzim-wasm.js', 'libzim-wasm.wasm'];

// wasm-opt runs last and walks the whole linked module, which for libzim plus
// Xapian plus ICU is a large one. It dies with SIGSEGV when it runs out of
// stack, so hand the container a big *finite* limit: glibc sizes worker-thread
// stacks from RLIMIT_STACK and falls back to a smaller default when that reads
// as unlimited. If it still crashes, step the optimizer down a level at a time
// rather than shipping nothing.
const LINK_STACK_BYTES = 536870912;
const LINK_OPT_LADDER = [3, 2, 1];
let linkOptimization = '';
const IMAGE_TAG = 'webbrain-emscripten-libzim:3.1.41';
const workTree = workOverride || path.join(root, '.build', 'zim-xapian');
const vendorDirectories = [
  path.join(root, 'src', 'chrome', 'vendor', 'libzim'),
  path.join(root, 'src', 'firefox', 'vendor', 'libzim'),
];
const correspondingSourceDir = path.join(root, 'dist', 'corresponding-source', `zim-xapian-${PIN.tag}`);

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`\nERROR: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  log(`  $ ${command} ${args.join(' ')}`);
  if (dryRun && options.skipOnDryRun !== false) return '';
  const result = spawnSync(command, args, { stdio: options.capture ? 'pipe' : 'inherit', cwd: options.cwd || root, encoding: 'utf8' });
  if (result.error) fail(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with status ${result.status}.`);
  return String(result.stdout || '');
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// Inside WSL, Docker Desktop is installed on the Windows host but only reaches
// the distro when its WSL integration is switched on, so "not on PATH" here
// almost never means "not installed".
function insideWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); }
  catch { return false; }
}

function dockerMissingHelp() {
  if (!insideWsl()) {
    return 'Docker is not on PATH. Install Docker Desktop (Windows/macOS) or docker-ce (Linux).';
  }
  return [
    `Docker is not on PATH inside WSL${process.env.WSL_DISTRO_NAME ? ` (${process.env.WSL_DISTRO_NAME})` : ''}.`,
    'Docker Desktop is probably running on Windows but not shared with this distro.',
    '',
    'In Docker Desktop: Settings -> Resources -> WSL Integration, enable this',
    'distro, then Apply & Restart. Settings -> General must also have the WSL 2',
    'based engine switched on.',
    '',
    'Open a new WSL shell afterwards, because the integration is added to PATH at',
    'shell start, and confirm with:  docker ps',
  ].join('\n');
}

function preflight() {
  log('Preflight');
  try {
    const version = execFileSync('docker', ['--version'], { encoding: 'utf8' }).trim();
    log(`  docker: ${version}`);
  } catch {
    fail(dockerMissingHelp());
  }
  const daemon = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  if (daemon.status !== 0) {
    fail(insideWsl()
      ? 'The Docker daemon is not reachable from WSL. Start Docker Desktop on Windows, and check Settings -> Resources -> WSL Integration for this distro.'
      : 'The Docker daemon is not running. Start Docker Desktop and try again.');
  }
  log(`  daemon: ${String(daemon.stdout || '').trim()}`);
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    fail('git is not on PATH.');
  }
  // The container writes as the invoking user on POSIX so build outputs are not
  // left root-owned. Windows containers have no equivalent and need no mapping.
  log(`  host: ${process.platform}${process.platform === 'win32' ? ' (no uid mapping needed)' : ''}`);
}

function fetchSource() {
  if (existsSync(workTree) && !keepWorkTree) {
    // A fresh clone is the right default for a build whose output has to be
    // reproducible, but say what is being thrown away: the dependency compile
    // is the expensive part and --keep reuses it.
    if (existsSync(path.join(workTree, 'build', 'lib', 'libzim.a'))) {
      log('  the previous work tree holds a finished dependency build; --keep would reuse it');
    }
    log(`  removing previous work tree ${workTree}`);
    if (!dryRun) rmSync(workTree, { recursive: true, force: true });
  }
  if (!existsSync(workTree)) {
    mkdirSync(path.dirname(workTree), { recursive: true });
    run('git', ['clone', '--branch', PIN.tag, '--depth', '1', PIN.repository, workTree]);
  } else {
    log(`  reusing ${workTree}`);
  }
  if (dryRun) return;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workTree, encoding: 'utf8' }).trim();
  if (head !== PIN.commit) {
    fail(`Pinned commit mismatch.\n  expected ${PIN.commit}\n  actual   ${head}\nRefusing to build an unpinned tree.`);
  }
  log(`  commit verified: ${head}`);
}

function dockerMount(hostPath) {
  // Docker Desktop on Windows accepts a drive-letter path; POSIX passes through.
  return process.platform === 'win32' ? hostPath.replace(/\\/g, '/') : hostPath;
}

// meson aborts on any timestamp it reads as being in the future, and a Docker
// bind mount from NTFS stamps files with the Windows clock while the container
// runs its own slightly behind. That surfaces two dependencies deep as an
// opaque "Clock skew detected", so measure it up front against the real mount.
function checkClockSkew() {
  log('\nChecking mount clock skew');
  const probe = path.join(workTree, '.clock-probe');
  writeFileSync(probe, 'probe');
  const hostSeconds = Math.floor(statSync(probe).mtimeMs / 1000);
  const args = ['run', '--rm', '-v', `${dockerMount(workTree)}:/src`, IMAGE_TAG,
    'bash', '-c', 'echo "$(date +%s) $(stat -c %Y /src/.clock-probe)"'];
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  rmSync(probe, { force: true });
  if (result.status !== 0) {
    log('  could not measure skew; continuing');
    return;
  }
  const [containerNow, mountStamp] = String(result.stdout || '').trim().split(/\s+/).map(Number);
  if (!Number.isFinite(containerNow) || !Number.isFinite(mountStamp)) {
    log('  could not measure skew; continuing');
    return;
  }
  const ahead = mountStamp - containerNow;
  log(`  host stamp ${hostSeconds}, container now ${containerNow}, mount is ${ahead}s ahead`);
  if (ahead <= 0) {
    log('  ok');
    return;
  }
  fail([
    `The mounted filesystem is ${ahead}s ahead of the container clock.`,
    'meson refuses to build against a future timestamp and will abort on zstd.',
    '',
    'Fix:',
    '  1. Build on the WSL2 filesystem rather than a path under C:\\. This removes',
    '     the skew for good and is markedly faster, because an NTFS bind mount is',
    '     slow for a build made of many small files. From inside a WSL shell:',
    '       npm run build:zim-xapian -- --work ~/zim-xapian-build',
    '  2. Or restart Docker Desktop ("wsl --shutdown", then start it) to resync the',
    '     VM clock, and rerun with --keep. Quicker to try, but the drift returns',
    '     after the host sleeps.',
  ].join('\n'));
}

function buildImage() {
  log('\nBuilding the Emscripten image');
  run('docker', ['build', '-t', IMAGE_TAG, '--build-arg', `VERSION=${PIN.emscripten}`, path.join(workTree, 'docker')]);
}

function dockerRun(command, { env = {}, allowFailure = false } = {}) {
  const args = ['run', '--rm', '-v', `${dockerMount(workTree)}:/src`,
    '--ulimit', `stack=${LINK_STACK_BYTES}:${LINK_STACK_BYTES}`];
  if (process.platform !== 'win32') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const gid = typeof process.getgid === 'function' ? process.getgid() : 0;
    args.push('-u', `${uid}:${gid}`);
  }
  for (const [name, value] of Object.entries(env)) args.push('-e', `${name}=${value}`);
  args.push(IMAGE_TAG, ...command);
  if (!allowFailure) {
    run('docker', args);
    return 0;
  }
  log(`  $ docker ${args.join(' ')}`);
  const result = spawnSync('docker', args, { stdio: 'inherit', cwd: root });
  if (result.error) fail(`docker could not be started: ${result.error.message}`);
  return result.status === 0 ? 0 : (result.status ?? 1);
}

// The Makefile moves package.json aside while libzim builds and moves it back
// afterwards, because Emscripten trips over it. A build that dies in between
// leaves only package.json.temp, and the next run's `mv package.json` then
// fails on a missing file, so a resume has to put the tree back first.
function normalizeWorkTree() {
  const live = path.join(workTree, 'package.json');
  const stashed = path.join(workTree, 'package.json.temp');
  if (!existsSync(stashed) || existsSync(live)) return;
  log('  restoring package.json stashed by an interrupted build');
  copyFileSync(stashed, live);
  rmSync(stashed, { force: true });
}

function compile() {
  log('\nCompiling from source (ICU, Xapian, and libzim dominate this step)');
  normalizeWorkTree();
  dockerRun(['make', ...COMPILE_TARGETS]);
  linkRuntime();
  dockerRun(['make', 'restore_pjsn']);
}

// EMCC_CFLAGS is appended to the compiler's own argument list, so it overrides
// the -O3 baked into the upstream recipe without patching the Makefile.
function linkRuntime() {
  const ladder = linkOptOverride ? [linkOptOverride] : LINK_OPT_LADDER;
  for (const level of ladder) {
    log(`\nLinking the runtime at -O${level}`);
    // make treats a half-written artifact from the last attempt as up to date.
    for (const name of SHIPPED_ARTIFACTS) rmSync(path.join(workTree, name), { force: true });
    const status = dockerRun(['make', 'libzim-wasm.js'], { env: { EMCC_CFLAGS: `-O${level}` }, allowFailure: true });
    if (status === 0) {
      linkOptimization = `O${level}`;
      log(`  linked at -O${level}`);
      return;
    }
    if (level !== ladder[ladder.length - 1]) {
      log(`\n  The -O${level} link failed. Retrying one optimizer level lower.`);
    }
  }
  fail(linkFailureHelp());
}

function linkFailureHelp() {
  return [
    'Linking libzim-wasm.js failed at every optimizer level tried.',
    '',
    'Check what the last error actually was. "wasm-opt ... failed (received',
    'SIGSEGV)" means Emscripten\'s optimizer ran out of room, not that anything',
    'is wrong with the code; a compiler or linker error means something else.',
    '',
    'The compiled libraries under build/ survive, so each retry only repeats the',
    'final link, which takes seconds:',
    '',
    '  1. Give the Docker VM more memory. Under WSL2 it takes half the host by',
    '     default: put "memory=16GB" under [wsl2] in %UserProfile%\\.wslconfig,',
    '     run "wsl --shutdown", restart Docker Desktop, and rerun with --keep.',
    '  2. Rerun with --keep --link-opt 1 to pin the lightest optimizer pipeline.',
  ].join('\n');
}

function collectLicenseFiles() {
  const found = [];
  const candidates = [
    ['javascript-libzim', path.join(workTree, 'LICENSE')],
    ['libzim', path.join(workTree, `libzim-${PIN.libzim}`, 'COPYING')],
    ['xapian-core', path.join(workTree, `xapian-core-${PIN.xapian}`, 'COPYING')],
    ['xz', path.join(workTree, `xz-${PIN.xz}`, 'COPYING')],
    ['zlib', path.join(workTree, `zlib-${PIN.zlib}`, 'LICENSE')],
    ['zstd', path.join(workTree, `zstd-${PIN.zstd}`, 'LICENSE')],
    ['icu', path.join(workTree, 'icu', 'LICENSE')],
  ];
  for (const [name, file] of candidates) {
    if (existsSync(file)) found.push({ name, file });
  }
  return found;
}

function archiveCorrespondingSource() {
  log('\nArchiving corresponding source');
  mkdirSync(correspondingSourceDir, { recursive: true });
  const manifest = [];
  const tarballs = readdirSync(workTree).filter(name => /\.(tar\.(gz|xz)|tgz)$/.test(name));
  if (!tarballs.length && !dryRun) {
    fail('No source tarballs found in the work tree. The build did not run from source.');
  }
  for (const name of tarballs) {
    const from = path.join(workTree, name);
    const to = path.join(correspondingSourceDir, name);
    copyFileSync(from, to);
    manifest.push({ file: name, bytes: statSync(to).size, sha256: sha256(to) });
    log(`  ${name} (${statSync(to).size} bytes)`);
  }
  // The Makefile patches libzim in place with sed. Ship the recipe that produced
  // those edits, because the patched tree is what the binary was built from.
  const makefile = path.join(workTree, 'Makefile');
  if (existsSync(makefile)) {
    copyFileSync(makefile, path.join(correspondingSourceDir, 'Makefile'));
    manifest.push({ file: 'Makefile', bytes: statSync(makefile).size, sha256: sha256(makefile), note: 'contains the in-place libzim patches applied before compilation' });
  }
  for (const [name, file] of [['libzim_bindings.cpp', path.join(workTree, 'libzim_bindings.cpp')],
    ['prejs_file_api.js', path.join(workTree, 'prejs_file_api.js')],
    ['postjs_file_api.js', path.join(workTree, 'postjs_file_api.js')],
    ['Dockerfile', path.join(workTree, 'docker', 'Dockerfile')],
    ['emscripten-crosscompile.ini', path.join(workTree, 'emscripten-crosscompile.ini')]]) {
    if (!existsSync(file)) continue;
    copyFileSync(file, path.join(correspondingSourceDir, name));
    manifest.push({ file: name, bytes: statSync(file).size, sha256: sha256(file) });
  }
  for (const { name, file } of collectLicenseFiles()) {
    const to = path.join(correspondingSourceDir, `LICENSE.${name}.txt`);
    copyFileSync(file, to);
    manifest.push({ file: path.basename(to), bytes: statSync(to).size, sha256: sha256(to) });
  }
  return manifest;
}

function vendorArtifacts() {
  log('\nVendoring build outputs');
  const artifacts = [];
  for (const name of SHIPPED_ARTIFACTS) {
    const produced = path.join(workTree, name);
    if (!existsSync(produced)) {
      if (dryRun) { log(`  (dry run) would expect ${name}`); continue; }
      fail(`The build did not produce ${name}.`);
    }
    const digest = sha256(produced);
    const bytes = statSync(produced).size;
    artifacts.push({ file: name, bytes, sha256: digest });
    for (const directory of vendorDirectories) {
      mkdirSync(directory, { recursive: true });
      copyFileSync(produced, path.join(directory, name));
    }
    log(`  ${name}  ${bytes} bytes  sha256 ${digest}`);
  }
  for (const { name, file } of collectLicenseFiles()) {
    for (const directory of vendorDirectories) {
      mkdirSync(directory, { recursive: true });
      copyFileSync(file, path.join(directory, `LICENSE.${name}.txt`));
    }
  }
  return artifacts;
}

function writeRecords(artifacts, correspondingSource) {
  const sbom = {
    component: 'zim-xapian-wasm',
    builtAt: new Date().toISOString(),
    builtFrom: 'source',
    upstream: { repository: PIN.repository, tag: PIN.tag, commit: PIN.commit },
    toolchain: { emscripten: PIN.emscripten, image: IMAGE_TAG, linkOptimization: linkOptimization || `O${LINK_OPT_LADDER[0]}` },
    dependencies: [
      { name: 'javascript-libzim', version: PIN.tag, license: 'GPL-3.0-or-later' },
      { name: 'libzim', version: PIN.libzim, license: 'GPL-2.0-or-later' },
      { name: 'xapian-core', version: PIN.xapian, license: 'GPL-2.0-or-later' },
      { name: 'xz', version: PIN.xz, license: 'public-domain with per-file exceptions' },
      { name: 'zlib', version: PIN.zlib, license: 'Zlib' },
      { name: 'zstd', version: PIN.zstd, license: 'BSD-3-Clause OR GPL-2.0' },
      { name: 'icu', version: PIN.icu, license: 'Unicode-DFS-2016' },
    ],
    artifacts,
    correspondingSource,
    effectiveReleaseLicense: 'GPL-3.0-or-later',
  };
  if (dryRun) { log('\n(dry run) SBOM not written'); return; }
  for (const directory of vendorDirectories) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'sbom.json'), `${JSON.stringify(sbom, null, 2)}\n`);
    writeFileSync(path.join(directory, 'README.webbrain.md'), vendorReadme(artifacts));
  }
  writeFileSync(path.join(correspondingSourceDir, 'sbom.json'), `${JSON.stringify(sbom, null, 2)}\n`);
}

function vendorReadme(artifacts) {
  const rows = artifacts.map(item => `- \`${item.file}\`: ${item.bytes} bytes, SHA-256 \`${item.sha256}\``).join('\n');
  const fallback = linkOptimization && linkOptimization !== `O${LINK_OPT_LADDER[0]}`
    ? `\n\nLinked at \`-${linkOptimization}\` rather than \`-O${LINK_OPT_LADDER[0]}\`, because Emscripten's wasm-opt\ncould not optimize this module at the higher level. The module is correct and\nsomewhat larger.`
    : '';
  return `# Vendored Xapian/libzim WebAssembly runtime

Built from source by \`scripts/build-zim-xapian.mjs\`. Do not hand-copy an
upstream release asset here: WebBrain cannot provide corresponding source for a
binary it did not build. See \`docs/offline-rag-licensing.md\`.

- Upstream: ${PIN.repository} \`${PIN.tag}\` (\`${PIN.commit}\`)
- Toolchain: Emscripten ${PIN.emscripten}
- libzim ${PIN.libzim}, Xapian ${PIN.xapian}, ICU ${PIN.icu}, zstd ${PIN.zstd}, xz ${PIN.xz}, zlib ${PIN.zlib}

${rows}${fallback}

## License

This runtime is GPL. Any release artifact that bundles it is conveyed under
**GPL-3.0-or-later**, which is why the store packages carry that license even
though the repository itself stays MIT. Complete corresponding source for these
binaries is published under \`dist/corresponding-source/\` and must accompany
every release.

To rebuild: \`npm run build:zim-xapian\`
`;
}

log(`Xapian/libzim runtime build${dryRun ? ' (dry run)' : ''}\n`);
preflight();
log('\nFetching pinned source');
fetchSource();
if (!dryRun) {
  buildImage();
  checkClockSkew();
  compile();
}
const artifacts = vendorArtifacts();
const correspondingSource = dryRun ? [] : archiveCorrespondingSource();
writeRecords(artifacts, correspondingSource);

log(`\n${dryRun ? 'Dry run complete. Setup looks usable.' : 'Build complete.'}`);
if (!dryRun) {
  log('\nNext steps:');
  log('  1. Commit src/{chrome,firefox}/vendor/libzim/ and dist/corresponding-source/.');
  log('  2. Flip ZIM_XAPIAN_RUNTIME_BUNDLED to true in both zim-xapian.js files.');
  log('  3. Run npm test.');
}
