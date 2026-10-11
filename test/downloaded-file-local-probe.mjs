import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { CDPClient } from '../src/chrome/src/cdp/cdp-client.js';

test('actual Chromium isolated saved-file probe reads bounded prefixes without page upload events', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-local-read-probe-'));
  const file = path.join(root, 'saved.txt'), bytes = Buffer.from('A'.repeat(80_000));
  const large = path.join(root, 'large.bin');
  await fs.writeFile(file, bytes); await fs.writeFile(large, Buffer.alloc(25 * 1024 * 1024 + 1, 3));
  const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<input id="real-upload" type="file"><script>window.uploadEvents=[];for(const name of ["input","change"])document.addEventListener(name,e=>uploadEvents.push(e.type));</script>');
    const session = await page.context().newCDPSession(page);
    const client = new CDPClient();
    client.sendCommand = async (_tab, method, params = {}) => session.send(method, params);
    const state = () => page.evaluate(() => ({ events: uploadEvents.slice(), files: document.querySelector('#real-upload').files.length }));
    await t.test('prefix is from the actual saved file with honest total size', async () => {
      const result = await client.probeLocalFile(71, file, { includeData: true, maxBytes: 64_004, readPrefixBytes: 64_004 });
      assert.equal(result.exists, true); assert.equal(result.readable, true); assert.equal(result.size, 80_000);
      assert.equal(result.dataBytesRead, 64_004); assert.equal(result.dataTruncated, true);
      assert.deepEqual(Buffer.from(result.base64, 'base64'), bytes.subarray(0, 64_004));
      assert.deepEqual(await state(), { events: [], files: 0 });
    });
    await t.test('default complete-payload behavior and recipient cap remain unchanged', async () => {
      const full = await client.probeLocalFile(71, file, { includeData: true });
      assert.equal(full.size, bytes.length); assert.deepEqual(Buffer.from(full.base64, 'base64'), bytes);
      assert.equal(full.dataBytesRead, undefined); assert.equal(full.dataTruncated, undefined);
      const rejected = await client.probeLocalFile(71, file, { includeData: true, maxBytes: 1 });
      assert.equal(rejected.readable, false); assert.equal(rejected.base64, undefined);
      assert.deepEqual(await state(), { events: [], files: 0 });
    });
    await t.test('a file above 25MB yields only the explicit bounded prefix', async () => {
      const prefix = await client.probeLocalFile(71, large, { includeData: true, maxBytes: 24_001, readPrefixBytes: 24_001 });
      assert.equal(prefix.size, 25 * 1024 * 1024 + 1); assert.equal(prefix.readable, true);
      assert.equal(prefix.dataBytesRead, 24_001); assert.equal(Buffer.from(prefix.base64, 'base64').length, 24_001);
      const rejected = await client.probeLocalFile(71, large, { includeData: true });
      assert.equal(rejected.readable, false); assert.equal(rejected.base64, undefined);
      assert.deepEqual(await state(), { events: [], files: 0 });
    });
    await t.test('requested prefix cannot exceed its caller byte bound', async () => {
      const result = await client.probeLocalFile(71, file, { includeData: true, maxBytes: 1, readPrefixBytes: 64_004 });
      assert.equal(result.size, bytes.length); assert.equal(result.dataBytesRead, 1);
      assert.equal(result.dataTruncated, true); assert.equal(Buffer.from(result.base64, 'base64').length, 1);
      assert.deepEqual(await state(), { events: [], files: 0 });
    });
    await t.test('actual zero-length file is readable while deleted zero-length path is not', async () => {
      const empty = path.join(root, 'empty.txt'); await fs.writeFile(empty, '');
      const result = await client.probeLocalFile(71, empty, { includeData: true, maxBytes: 64_004, readPrefixBytes: 64_004 });
      assert.equal(result.readable, true); assert.equal(result.size, 0); assert.equal(result.base64, '');
      assert.equal(result.dataBytesRead, 0); assert.equal(result.dataTruncated, false);
      await fs.unlink(empty);
      const missing = await client.probeLocalFile(71, empty, { includeData: true, maxBytes: 64_004, readPrefixBytes: 64_004 });
      assert.ok(!missing || missing.readable !== true); assert.equal(missing?.base64, undefined);
      assert.deepEqual(await state(), { events: [], files: 0 });
    });
    await t.test('deleted saved path never reports readable bytes', async () => {
      await fs.unlink(file);
      const missing = await client.probeLocalFile(71, file, { includeData: true, maxBytes: 64_004, readPrefixBytes: 64_004 });
      assert.ok(!missing || missing.readable !== true); assert.equal(missing?.base64, undefined);
      assert.deepEqual(await state(), { events: [], files: 0 });
    });
    await t.test('unavailable isolated world does not fall back to page globals', async () => {
      const methods = [];
      client.sendCommand = async (_tab, method) => { methods.push(method); return {}; };
      const missing = await client.probeLocalFile(71, large, { includeData: true, readPrefixBytes: 24_001 });
      assert.equal(missing, null); assert.equal(methods.includes('Runtime.evaluate'), false);
    });
  } finally {
    await browser.close();
    const real = await fs.realpath(root);
    assert.ok(real.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-local-read-probe-'));
    await fs.rm(real, { recursive: true, force: true });
  }
});
