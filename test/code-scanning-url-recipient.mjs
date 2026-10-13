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

function boundedCall(moduleUrl) {
  const code = `import {performance} from 'node:perf_hooks';
    const {clarificationAuthorizesRecipientRole:f}=await import(${JSON.stringify(moduleUrl)});
    process.stdout.write('ready\\n');
    const started=performance.now();
    const cases=[
      ['Alice,'+'+和'.repeat(1000)+'!','bcc'],['Alice'+'  与+'.repeat(1000)+'!','bcc'],
      ['抄送+,'+'+和'.repeat(1000)+'! Alice','cc'],['抄送+'+'  与+'.repeat(1000)+'! Alice','cc'],
      ['To: '+Array(65).fill('Alice').join(', '),'to'],
      ['Alice,'+'+和'.repeat(32)+'!','bcc'],['抄送+'+'  与+'.repeat(32)+'! Alice','cc'],
      ['To: Alice '+'x'.repeat(8192),'to']];
    for(const [answer,role]of cases)if(f(null,answer,'Alice',role)!==false)throw Error('hostile_role_authorized');
    process.stdout.write(JSON.stringify({cases:cases.length,elapsedMs:performance.now()-started})+'\\n');`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errorText = '', timer = null, executionArmed = false;
    // Cold child loading is distinct from the500ms synchronous parser budget.
    const loading = setTimeout(() => { child.kill(); reject(Error('security_probe_child_load_deadline')); }, 5000);
    child.stdout.on('data', bytes => {
      output += bytes;
      if (!executionArmed && output.startsWith('ready\n')) {
        executionArmed = true; clearTimeout(loading);
        timer = setTimeout(() => { child.kill(); reject(Error('grouped_role_parser_execution_deadline')); }, 500);
      }
    });
    child.stderr.on('data', bytes => { errorText += bytes; });
    child.once('error', error => { clearTimeout(loading); clearTimeout(timer); reject(error); });
    child.once('close', exit => {
      clearTimeout(loading); clearTimeout(timer);
      try {
        assert.equal(exit, 0, errorText); assert.equal(executionArmed, true);
        const result = JSON.parse(output.trim().split('\n').at(-1));
        assert.equal(result.cases, 8); assert.ok(result.elapsedMs < 500); resolve();
      } catch (error) { reject(error); }
    });
  });
}
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
// Reuse the exact unchanged current main-runner role assertions, not handwritten expected clones.
const mainSource = await fs.readFile(path.join(repo, 'test/run.js'), 'utf8');
function balancedCall(source, at) {
  let depth = 0, quote = null, escaped = false;
  for (let i = at; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; }
    else if (["'", '"', '`'].includes(c)) quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return source.slice(at, i + 1);
  }
  throw Error('main_assertion_extract_failed');
}
const preserved = [];
const seenAssertions = new Set();
for (let at = mainSource.indexOf('helper.clarificationAuthorizesRecipientRole('); at >= 0;
  at = mainSource.indexOf('helper.clarificationAuthorizesRecipientRole(', at + 1)) {
  const callAt = mainSource.lastIndexOf('assert.equal(', at);
  if (callAt < 0 || seenAssertions.has(callAt)) continue;
  const code = 'assert.equal' + balancedCall(mainSource, callAt + 'assert.equal'.length);
  if (code.includes('helper.clarificationAuthorizesRecipientRole(')) {
    seenAssertions.add(callAt); preserved.push(code);
  }
}
assert.ok(preserved.length >= 30, 'actual current role assertion family required');
const contextAt = mainSource.indexOf('const modelAuthoredRoleContext = {');
const actualContextDeclaration = mainSource.slice(contextAt, mainSource.indexOf(';', contextAt) + 1);
assert.ok(actualContextDeclaration.endsWith('};'));
for (const { build, guard, guardUrl } of helpers) test(build + ' preserves all ' + preserved.length + ' exact existing role assertions', () => {
  for (const code of preserved) vm.runInNewContext(actualContextDeclaration + '\n' + code,
    { helper: guard, assert }, { timeout: 500 });
});
const groups = [
  ['BCC: Ali, Ayşe', 'Ali', 'bcc', true], ['BCC: Ali, Ayşe', 'Ayşe', 'bcc', true],
  ['BCC: Anna, Bärbel', 'Anna', 'bcc', true], ['BCC: Anna, Bärbel', 'Bärbel', 'bcc', true],
  ['把Alice和Bob设为密送', 'Alice', 'bcc', true],
  ['To: Alice; BCC: Bob', 'Alice', 'bcc', false],
  ['Do not move Alice and Bob to To', 'Alice', 'to', false],
  ['Do not move Alice and Bob to To', 'Bob', 'to', false],
  ['To: Alice; actually BCC: Alice', 'Alice', 'to', false],
  ['To: Alice; actually BCC: Alice', 'Alice', 'bcc', false],
];
for (const { build, guard, guardUrl } of helpers) {
  for (const [answer, who, role, expected] of groups) test(build + ' bounded coordination ' + answer + '/' + who + '/' + role,
    () => assert.equal(guard.clarificationAuthorizesRecipientRole(null, answer, who, role), expected));
  test(build + ' linear grouped-role parser safely rejects all eight bounded hostile/repeated inputs', async () => {
    await boundedCall(guardUrl);
  });
  test(build + ' explicit oversized clarification fails closed', () =>
    assert.equal(guard.clarificationAuthorizesRecipientRole(null, 'To: Alice ' + 'x'.repeat(8192), 'Alice', 'to'), false));
  test(build + ' question/options never supply user role authorization', () =>
    assert.equal(guard.clarificationAuthorizesRecipientRole({ question: 'Put Alice in BCC?', options: ['BCC'] }, 'yes', 'Alice', 'bcc'), false));
}
