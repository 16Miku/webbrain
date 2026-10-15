// Real paired pure helper security regressions. No browser or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helpers = await Promise.all(['chrome', 'firefox'].map(async build => ({ build,
  guardUrl: pathToFileURL(path.join(repo, 'src/' + build + '/src/agent/message-recipient-guard.js')).href,
  sheets: await import(pathToFileURL(path.join(repo, 'src/' + build + '/src/agent/sheets-tools.js')).href),
  guard: await import(pathToFileURL(path.join(repo, 'src/' + build + '/src/agent/message-recipient-guard.js')).href) })));

const legitimate = [
  ['https://docs.google.com/spreadsheets/d/x/edit', 'google-sheets'],
  ['http://docs.google.com/spreadsheets/d/x/edit', 'google-sheets'],
  ['https://DOCS.GOOGLE.COM/spreadsheets/d/x/edit#gid=123', 'google-sheets'],
  ['https://office.com/launch/excel/x', 'excel-online'],
  ['https://www.office.com/launch/excel/x', 'excel-online'],
  ['https://word-edit.officeapps.live.com/x/x', 'excel-online'],
  ['https://excel.officeapps.live.com/x/x?next=https://example.invalid/', 'excel-online'],
  ['https://onedrive.live.com/edit.aspx?resid=1', 'excel-online'],
  ['https://tenant.sharepoint.com/sites/team/book.xlsx?web=1', 'excel-online'],
  ['https://tenant.sharepoint.com/sites/team/My%20Book.xlsx?web=1', 'excel-online'],
];
const rejected = [
  'https://evil.example/path/.sharepoint.com/a.xlsx',
  'https://evil.example/path/.officeapps.live.com/x/x',
  'https://evil.example/?next=.sharepoint.com/a.xlsx',
  'https://evil.example/?next=.officeapps.live.com/x/x',
  'https://user:pass@word-edit.officeapps.live.com/x/x',
  'https://evil.example@tenant.sharepoint.com/a.xlsx',
  'https://word-edit.officeapps.live.com:443/x/x',
  'https://word-edit.officeapps.live.com:444/x/x',
  'https://tenant.sharepoint.com.evil.example/a.xlsx',
  'https://evilsharepoint.com/a.xlsx',
  'https://officeapps.live.com/x/x',
  'https://word-edit.officeapps.live.com.evil.example/x/x',
  'https://docs.google.com.evil.example/spreadsheets/d/x/edit',
  'https://onedrive.live.com/edit.aspx-evil',
  'https://tenant.sharepoint.com/book.xlsx/evil',
  'https://tenant.sharepoint.com/book.xlsx%2Fevil',
  'https://tenant.sharepoint.com/book.xlsx.exe',
  'https://tenant.sharepoint.com/?next=book.xlsx',
  'https://tenant%2esharepoint.com/book.xlsx',
  'javascript:https://tenant.sharepoint.com/book.xlsx',
  'ftp://tenant.sharepoint.com/book.xlsx',
  '//tenant.sharepoint.com/book.xlsx',
  ' https://tenant.sharepoint.com/book.xlsx',
  'https://tenant.sharepoint.com./book.xlsx',
  'https://tenant.sharepoint.com\\evil/book.xlsx',
];
for (const { build, sheets } of helpers) {
  for (const [value, expected] of legitimate) test(build + ' URL parser preserves supported ' + value,
    () => assert.equal(sheets.detectSheetSite(value), expected));
  for (const value of rejected) test(build + ' URL parser refuses spoof/unsupported ' + value,
    () => assert.equal(sheets.detectSheetSite(value), null));
}
// Recipient consent comes only from WebBrain's own card with fixed choices,
// so the recipient module keeps no parser of question or answer wording that
// a hostile page or answer could steer. What remains compares page identities
// with the task's structured target, in bounded time for hostile input.
const recipientExports = ['MESSAGE_RECIPIENT_ROLES', 'MESSAGE_TARGET_KINDS', 'messageRecipientUploadSourceKey',
  'messageTargetMatchesObservedIdentities', 'normalizeMessageTarget', 'normalizeRecipientIdentity', 'recipientMatchesObservedIdentity'];
const sources = await Promise.all(helpers.map(({ build }) => fs.readFile(path.join(repo, 'src/' + build + '/src/agent/message-recipient-guard.js'), 'utf8')));
test('recipient helpers are byte-identical in both builds', () => assert.equal(sources[0], sources[1]));

function boundedComparison(moduleUrl) {
  const code = `import {performance} from 'node:perf_hooks';
    const g=await import(${JSON.stringify(moduleUrl)});
    process.stdout.write('ready\\n');
    const started=performance.now();
    const hostile=['Alice,'+'+和'.repeat(4000)+'!', 'Alice'+'  与+'.repeat(4000), 'Alice'+' '.repeat(50000)+'x', 'A\\u200b'.repeat(20000)];
    let matched=0;
    for(const value of hostile){
      if(g.recipientMatchesObservedIdentity('Alice',value))matched++;
      if(g.messageTargetMatchesObservedIdentities({target_kind:'named',recipients:Array(64).fill(value)},Array(64).fill({identity:value,role:'bcc'})))matched++;
      g.messageRecipientUploadSourceKey({filePath:'\\\\'+'a'.repeat(50000)});
    }
    process.stdout.write(JSON.stringify({cases:hostile.length,matched,elapsedMs:performance.now()-started})+'\\n');`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errorText = '', timer = null, executionArmed = false;
    // Cold child loading is distinct from the 500 ms synchronous budget.
    const loading = setTimeout(() => { child.kill(); reject(Error('security_probe_child_load_deadline')); }, 5000);
    child.stdout.on('data', bytes => {
      output += bytes;
      if (!executionArmed && output.startsWith('ready\n')) {
        executionArmed = true; clearTimeout(loading);
        timer = setTimeout(() => { child.kill(); reject(Error('recipient_comparison_execution_deadline')); }, 500);
      }
    });
    child.stderr.on('data', bytes => { errorText += bytes; });
    child.once('error', error => { clearTimeout(loading); clearTimeout(timer); reject(error); });
    child.once('close', exit => {
      clearTimeout(loading); clearTimeout(timer);
      try {
        assert.equal(exit, 0, errorText); assert.equal(executionArmed, true);
        const result = JSON.parse(output.trim().split('\n').at(-1));
        assert.equal(result.cases, 4); assert.equal(result.matched, 0); assert.ok(result.elapsedMs < 500); resolve();
      } catch (error) { reject(error); }
    });
  });
}
for (const { build, guard, guardUrl } of helpers) {
  test(build + ' recipient module has no wording parser to attack', () => {
    assert.deepEqual(Object.keys(guard).sort(), recipientExports);
  });
  test(build + ' recipient comparison stays exact and bounded on hostile input', async () => {
    assert.equal(guard.recipientMatchesObservedIdentity('Alice', 'BCC: Alice'), false);
    assert.equal(guard.messageTargetMatchesObservedIdentities({ target_kind: 'named', recipients: [{ identity: 'Alice', role: 'to' }] },
      [{ identity: 'Alice', role: 'bcc' }]), false, 'A role is compared as data, never inferred from words');
    await boundedComparison(guardUrl);
  });
}
