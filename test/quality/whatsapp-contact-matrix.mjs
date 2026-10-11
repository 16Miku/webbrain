import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// Each case installs its own intercepted MV3 clone and temporary browser.
// Keep cases serial so a real worker restart cannot affect another case.
const execute = promisify(execFile);
const base = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-07/whatsapp-contact-matrix');
const extension = path.resolve(process.env.WEBBRAIN_QUALITY_EXTENSION || 'src/chrome');
const fixture = path.resolve('test/quality/whatsapp-contact-mv3.mjs');
const scenarios = ['positive', 'bootstrap_native', 'native_scroll_latest', 'native_prepared_repair', 'postwrite_debt', 'stop', 'stop_pending', 'steering', 'peer_switch', 'virtual_floor',
  'restart_pending', 'restart_same_prompt', 'worker_resume', 'document_resume', 'late_drawer'];
await fs.mkdir(base, { recursive: true });

async function sourceSnapshot() {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.push(filename);
    }
  }
  await visit(extension);
  files.push(fixture);
  const hashes = {};
  for (const filename of files.sort()) {
    const name = filename === fixture ? 'test/quality/whatsapp-contact-mv3.mjs'
      : 'extension/' + path.relative(extension, filename).split(path.sep).join('/');
    hashes[name] = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
  }
  return { capturedAt: new Date().toISOString(), hashes };
}

const started = Date.now(), before = await sourceSnapshot(), cases = [];
await fs.writeFile(path.join(base, 'source-start.json'), JSON.stringify(before, null, 2));
let failure = null, sourceStable = false;
try {
  for (const scenario of scenarios) {
    const caseDirectory = path.join(base, scenario), caseStart = Date.now();
    await fs.mkdir(caseDirectory, { recursive: true });
    let stdout = '', stderr = '', childFailure = null;
    try {
      ({ stdout, stderr } = await execute(process.execPath, [fixture, `--case=${scenario}`], {
        windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, WEBBRAIN_QUALITY_ARTIFACTS: caseDirectory },
      }));
    } catch (error) {
      stdout = error.stdout || ''; stderr = error.stderr || '';
      childFailure = { code: error.code ?? null, signal: error.signal || null,
        killed: error.killed === true, message: error.message };
    }
    await fs.writeFile(path.join(caseDirectory, 'runner.log'), stdout + stderr);
    const evidence = JSON.parse(await fs.readFile(path.join(caseDirectory, 'evidence.json'), 'utf8').catch(() => '{}'));
    const terminal = evidence.run?.result?.updates?.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
    const result = { scenario, passed: !childFailure, elapsedMs: Date.now() - caseStart,
      ...(childFailure ? { failure: childFailure } : {}),
      replies: evidence.native?.replies?.length ?? null, doneOutcome: terminal?.outcome || null,
      successfulDone: evidence.runUi?.successfulDone ?? null,
      durablePending: !!evidence.durableChat?.pendingOutbound,
      workerRestart: evidence.metrics?.workerRestart?.freshGlobal === true,
      documentReplaced: evidence.metrics?.workerRestart?.documentReplaced === true,
      sourceSha256: evidence.metrics?.sourceSha256 || null };
    cases.push(result);
    console.log(JSON.stringify({ scenario, passed: result.passed, elapsedMs: result.elapsedMs }));
    assert.equal(childFailure, null, `${scenario} failed; retained evidence/log: ${caseDirectory}`);
  }
} catch (error) {
  failure = error.message;
} finally {
  const after = await sourceSnapshot();
  await fs.writeFile(path.join(base, 'source-finish.json'), JSON.stringify(after, null, 2));
  sourceStable = JSON.stringify(before.hashes) === JSON.stringify(after.hashes);
  await fs.writeFile(path.join(base, 'summary.json'), JSON.stringify({ passed: !failure && sourceStable && cases.length === scenarios.length,
    startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
    plannedCases: scenarios, cases, sourceStable, sourceFiles: Object.keys(before.hashes).length,
    failure, installedMV3: true, externalMessages: 0, accountsCreated: [] }, null, 2));
}
assert.equal(failure, null, failure || 'Installed WhatsApp matrix failed.');
assert.equal(sourceStable, true, 'Product/fixture source changed during the matrix; retained start/finish hashes.');
assert.equal(cases.length, scenarios.length);
console.log(JSON.stringify({ passed: true, installedMV3: true, cases: cases.length, elapsedMs: Date.now() - started,
  sourceStable, externalMessages: 0 }));
