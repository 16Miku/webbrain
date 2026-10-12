import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { requirePrivateLocation, loadConfig, lockFiles } from './config.mjs';
import { suiteRoot, repositoryRoot, sessionLockDirectory } from './paths.mjs';
import { runFixture, fixtureScenarios } from './fixtures.mjs';

async function workspace(t) {
  const base = path.join(suiteRoot, 'artifacts'); await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'layout-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}

test('suite-local configuration paths and production source root stay separate', async t => {
  const dir = await workspace(t);
  await fs.copyFile(path.join(suiteRoot, '.env.example'), path.join(dir, '.env'));
  await fs.copyFile(path.join(suiteRoot, 'config.example.json'), path.join(dir, '.env.authenticated.json'));
  const config = await loadConfig({ cwd: dir, env: {} });
  assert.equal(config.cwd, dir); assert.equal(config.artifacts, path.join(dir, 'artifacts'));
  assert.equal(config.repositoryRoot, repositoryRoot); assert.equal(path.basename(suiteRoot), 'website-tests');
  assert.equal(JSON.parse(await fs.readFile(path.join(config.repositoryRoot, 'src/chrome/manifest.json'))).name, 'WebBrain');
});

test('nested suite cwd cannot bypass private-path checks for tracked or sibling repository files', async () => {
  await requirePrivateLocation(path.join(suiteRoot, '.env'), suiteRoot);
  await assert.rejects(requirePrivateLocation(path.join(suiteRoot, '.env.example'), suiteRoot), { code: 'private_path_not_ignored' });
  await assert.rejects(requirePrivateLocation(path.join(repositoryRoot, 'AGENT.md'), suiteRoot), { code: 'private_path_not_ignored' });
});

test('fixture execution uses repository code while every persistent result goes into suite artifacts', async t => {
  const dir = await workspace(t); let dispatched;
  const config = { cwd: suiteRoot, repositoryRoot, actors: { A: { backend: 'local' } }, totalTimeoutMs: 1000 };
  const result = await runFixture(fixtureScenarios.find(row => row.id === 'fixture-file-transfer'), config, dir, { spawnImpl: (executable, args, options) => {
    dispatched = { args, options };
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const once = child.once.bind(child);
    child.once = (type, listener) => { const result = once(type, listener); if (type === 'close') queueMicrotask(() => child.emit('close', 0)); return result; };
    return child;
  } });
  assert.equal(result.status, 'passed'); assert.equal(dispatched.options.cwd, repositoryRoot);
  assert.equal(dispatched.args[0], path.join(repositoryRoot, 'test/quality/download-upload-mv3.mjs'));
  assert.equal(dispatched.options.env.WEBBRAIN_QUALITY_ARTIFACTS, dir);
  assert.equal(dispatched.options.env.WEBBRAIN_QUALITY_EXTENSION_SOURCE, path.join(repositoryRoot, 'src/chrome'));
  assert.ok((await fs.stat(path.join(dir, 'fixture.private.log'))).isFile());
});

test('session ownership remains shared and stored under website-tests regardless of report directory', async () => {
  const config = { artifacts: path.join(suiteRoot, 'artifacts'), actors: { A: { backend: 'cloud', sessionId: 'owned-fixture-selection', baseUrl: 'https://webbrain.cloud' } }, sites: {}, allowedActions: [], allowedRecipients: [], allowedDestinations: [] };
  const session = lockFiles(config).find(file => path.basename(file).startsWith('session-'));
  assert.equal(path.dirname(session), sessionLockDirectory());
  assert.ok(session.includes(path.join('website-tests', 'artifacts')));
  const changed = { ...config, artifacts: path.join(suiteRoot, 'artifacts', 'another'), allowedActions: ['compose'] };
  assert.equal(lockFiles(changed).find(file => path.basename(file).startsWith('session-')), session);
});
