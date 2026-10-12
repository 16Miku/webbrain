import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { uploadReleaseHtml } from '../lib/upload-release-fixture.mjs';

// Installed Chrome executes the production model wrapper, native download,
// target recovery, CDP file assignment and one owned server submission.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/upload-release-binding-mv3');
await fs.mkdir(out, { recursive: true });
const zip = Buffer.concat([Buffer.from([80, 75, 3, 4]), Buffer.from('Owned binary upload fixture exact bytes.')]);
const uploads = [], decisions = [], assetRequests = [];
let base, step = 0;
const html = uploadReleaseHtml.replace('<file-attachment id="binary-widget">',
  `<div aria-hidden="true" style="display:none">${'<span></span>'.repeat(5000)}</div><file-attachment id="binary-widget">`)
  .replace("document.getElementById('release-form').onsubmit=event=>event.preventDefault();", `
document.getElementById('release-form').onsubmit=async event=>{
 event.preventDefault();const form=new FormData();form.append('binary',document.getElementById('releases-upload').files[0]);
 const response=await fetch('/upload',{method:'POST',body:form});if(response.ok)document.getElementById('binary-status').textContent='Owned binary release saved';
};`);
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true, requires_submission: true,
  messaging: null, deliverables: ['Download and attach the exact owned ZIP only to the binary widget, submit once and verify saved.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false, completion_requirements: { download: true },
  read_scope: 'visible_page', summary: 'Download the exact ZIP, attach to the binary slot, submit once and verify.',
  steps: [{ id: '1', action: 'Download, inspect file inputs, attach ZIP to the binary slot, submit and verify.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
const server = http.createServer(async (request, response) => {
  if (request.url === '/owned-release.zip') {
    assetRequests.push(request.method); response.writeHead(200, { 'Content-Type': 'application/zip',
      'Content-Length': zip.length, 'Content-Disposition': 'attachment; filename="owned-release.zip"' }); response.end(zip); return;
  }
  if (request.url === '/upload') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks), start = body.indexOf(zip);
    uploads.push({ exactBytes: start >= 0 && body.subarray(start, start + zip.length).equals(zip),
      contentType: request.headers['content-type'] }); response.writeHead(200).end('saved'); return;
  }
  if (request.url === '/v1/chat/completions') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), system = textOf(input.messages?.[0]?.content);
    let message;
    if (system.startsWith('Evaluate only the observable requirements of the genuine user task'))
      message = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded', reason: 'Owned binary release saved appears on the current form.' }) };
    else if (!input.tools?.length) message = { role: 'assistant', content: JSON.stringify(intent) };
    else {
      let downloadId, submitRef;
      const tools = input.messages.filter(item => item.role === 'tool');
      for (const item of tools) {
        const content = textOf(item.content);
        try {
          const result = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
          downloadId ??= result.downloads?.[0]?.downloadId;
          submitRef ??= result.pageContent?.split('\n').find(line => /button "Publish release"/.test(line))?.match(/\[(ref_[A-Za-z0-9_-]+)\]/)?.[1];
        } catch {}
      }
      // A deep DOM leaves the first exact hidden input outside the capture
      // scan. Its rejected call must return before a fresh inventory and a
      // new model decision attach the same exact source to the intended slot.
      const calls = [
        { name: 'download_files', args: { urls: [`${base}/owned-release.zip`] } },
        { name: 'upload_file', args: { selector: '#releases-upload', downloadId } },
        { name: 'get_interactive_elements', args: {} },
        { name: 'upload_file', args: { selector: '#releases-upload', downloadId } },
        { name: 'get_accessibility_tree', args: { filter: 'visible', maxChars: 8000 } },
        { name: 'click_ax', args: { ref_id: submitRef } },
        { name: 'read_page', args: { limit: 3000 } },
        { name: 'done', args: { outcome: 'partial', summary: 'The owned binary ZIP was attached and submitted once. Local QA finished.' } },
      ];
      const selected = calls[Math.min(step, calls.length - 1)];
      decisions.push({ step, selected, precedingToolIds: tools.map(item => item.tool_call_id) });
      message = { role: 'assistant', content: '', tool_calls: [{ id: `owned-release-upload-${step++}`, type: 'function',
        function: { name: selected.name, arguments: JSON.stringify(selected.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `owned-response-${step}`, choices: [{ message,
      finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-upload-release-')); let context;
try {
  const extension = path.resolve('src/chrome'), downloadsPath = path.join(profile, 'downloads'); await fs.mkdir(downloadsPath);
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', acceptDownloads: true, downloadsPath,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)
      ? route.continue() : route.abort('blockedbyclient');
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    const original = fetch.bind(globalThis);
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.hostname === '127.0.0.1' || ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol)) return original(input, options);
      return Promise.reject(new Error('Owned release fixture blocks external requests.'));
    };
  });
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planReviewMode: 'never',
    screenshotFallback: false, autoScreenshot: false, maxAgentSteps: 12, systemOneEnabled: false, tracingEnabled: false,
    agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-key', baseUrl: `${base}/v1`,
    model: 'minimax/minimax-m3', enabled: true, contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(`${base}/owned/repository/releases/new`);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  const result = await message('chat', { tabId, text: `Download ${base}/owned-release.zip. Attach exactly that ZIP to the binary widget, leaving the Markdown slot empty. Submit exactly once and verify Owned binary release saved.`,
    mode: 'act', requestId: 'owned-upload-release', locale: 'en' });
  const state = await page.evaluate(() => ({ events: attachmentEvents, chooserClicks, status: document.getElementById('binary-status').textContent,
    files: [...document.getElementById('releases-upload').files].map(file => ({ name: file.name, size: file.size })) }));
  const toolResults = result.updates.filter(update => update.type === 'tool_result').map(update => update.data);
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, state, decisions, uploads, assetRequests,
    expectedBytes: zip.length, expectedSha256: crypto.createHash('sha256').update(zip).digest('hex') }, null, 2));
  const attachments = toolResults.filter(item => item.name === 'upload_file');
  assert.equal(attachments.length, 2, JSON.stringify(toolResults));
  assert.equal(attachments[0].result.errorCode, 'action_binding_unavailable');
  assert.equal(attachments[0].result.noDispatch, true); assert.equal(attachments[0].result.dispatched, false);
  assert.equal(attachments[1].result.success, true, JSON.stringify(attachments[1]));
  assert.ok(decisions[3].precedingToolIds.includes('owned-release-upload-1'), 'A rejected original call returns before the new attachment decision.');
  assert.ok(decisions[3].precedingToolIds.includes('owned-release-upload-2'), 'Fresh file inventory precedes the new decision.');
  assert.deepEqual(state.events.markdown, []); assert.equal(state.events.binary.length, 1); assert.equal(state.chooserClicks, 0);
  const downloaded = toolResults.find(item => item.name === 'download_files')?.result.downloads?.[0];
  assert.equal(downloaded?.success, true); assert.equal(downloaded.url, `${base}/owned-release.zip`);
  assert.deepEqual(state.files, [{ name: path.basename(downloaded.filename), size: zip.length }]);
  assert.deepEqual(assetRequests, ['GET']); assert.equal(uploads.length, 1); assert.equal(uploads[0].exactBytes, true);
  assert.equal(state.status, 'Owned binary release saved');
  console.log(JSON.stringify({ passed: true, firstUpload: 'known no-dispatch', recoveredUploads: 1, alternateSlotUploads: 0,
    chooserClicks: 0, serverSubmissions: uploads.length, exactBytes: uploads[0].exactBytes }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-upload-release-')) throw new Error('Unexpected owned profile path');
  await fs.rm(resolved, { recursive: true, force: true });
}
