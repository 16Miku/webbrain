import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { repositoryRoot } from './paths.mjs';
import { HarnessError } from './config.mjs';

export const fixtureScenarios = [
  { id: 'fixture-shared-guards', sites: ['x', 'bluesky', 'neutral'], script: 'test/quality/shared-action-guards-mv3.mjs', coverage: 'Installed Chrome; owned DraftJS/ProseMirror, menus, steering and duplicate prevention.' },
  { id: 'fixture-native-chat', sites: ['telegram'], script: 'test/quality/native-chat-mv3.mjs', coverage: 'Installed Chrome; owned Telegram-shaped chat and independent local receipt.' },
  { id: 'fixture-whatsapp', sites: ['whatsapp'], script: 'test/quality/whatsapp-contact-matrix.mjs', coverage: 'Installed Chrome; owned WhatsApp-shaped contact and recipient matrix.' },
  { id: 'fixture-file-transfer', sites: ['neutral'], script: 'test/quality/download-upload-mv3.mjs', coverage: 'Installed Chrome; local download/upload byte and attachment checks; not a live mail/Drive test.' },
  { id: 'fixture-stop-continue-recovery', sites: ['neutral'], script: 'test/quality/bulk-resume-mv3.mjs', coverage: 'Installed Chrome; owned stop/continue and HTTP 429 model recovery, unchanged task context and no duplicate row submissions.' },
  { id: 'fixture-chat-interventions', sites: ['telegram'], script: 'test/quality/native-chat-presubmit-mv3.mjs', coverage: 'Installed Chrome; owned native chat intervention, draft replacement and pre-send duplication races.' },
  { id: 'fixture-mastodon-confirm', sites: ['mastodon'], script: 'test/quality/mastodon-deletion-mv3.mjs', env: { WEBBRAIN_QUALITY_DELETE_NATIVE_MODE: 'confirmation' }, coverage: 'Installed Chrome; owned native Mastodon confirmation deletion.' },
  { id: 'fixture-mastodon-direct', sites: ['mastodon'], script: 'test/quality/mastodon-deletion-mv3.mjs', env: { WEBBRAIN_QUALITY_DELETE_NATIVE_MODE: 'direct' }, coverage: 'Installed Chrome; owned native Mastodon direct deletion.' },
];

export async function runFixture(spec, config, directory, { spawnImpl = spawn } = {}) {
  if (config.actors.A.backend !== 'local') throw new HarnessError('cloud_loopback_fixture_unavailable', 'Local fixtures require the local driver.', 'unsupported');
  await fs.mkdir(directory, { recursive: true });
  const start = Date.now(), sourceRoot = config.repositoryRoot || repositoryRoot;
  // Existing fixture scripts use their own loopback scripted provider. Do not hand them live credentials.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|PASSWORD|SECRET|COOKIE/i.test(key)));
  Object.assign(env, spec.env, { WEBBRAIN_QUALITY_ARTIFACTS: directory, WEBBRAIN_QUALITY_EXTENSION_SOURCE: path.join(sourceRoot, 'src/chrome') });
  let exitCode, timedOut = false;
  const child = spawnImpl(process.execPath, [path.join(sourceRoot, spec.script)], { cwd: sourceRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = await fs.open(path.join(directory, 'fixture.private.log'), 'w', 0o600);
  let bytes = 0, writes = Promise.resolve();
  const write = chunk => { bytes += chunk.length; if (bytes <= 8 * 1024 * 1024) writes = writes.then(() => log.write(chunk)).catch(() => {}); };
  child.stdout?.on('data', write); child.stderr?.on('data', write);
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, config.totalTimeoutMs);
  try {
    exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally { clearTimeout(timer); await writes; await log.close(); }
  return { scenario: spec.id, target: 'fixtures', backend: 'local', layer: 'installed-extension-scripted-provider',
    status: timedOut ? 'failed' : exitCode === 0 ? 'passed' : 'failed', code: timedOut ? 'fixture_timeout' : exitCode === 0 ? 'verified' : 'fixture_assertion_failed',
    durationMs: Date.now() - start, exitCode, cleanup: 'fixture_owned', coverage: spec.coverage };
}
