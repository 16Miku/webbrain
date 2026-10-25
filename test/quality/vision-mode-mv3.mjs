import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// Vision mode end to end in the installed MV3 extension: background, Agent,
// CDP capture and trusted input are real; a loopback provider plays the
// model. It reads each screenshot label, computes image coordinates for the
// fixture's controls and acts with click_at / type_text, so the whole chain
// (DPR-aware capture, model-size image, image → CSS mapping, exact-point
// dispatch, patches) has to be right for the form to be filled and sent.
//   node test/quality/vision-mode-mv3.mjs              DPR 1
//   node test/quality/vision-mode-mv3.mjs --dpr=2      retina
//   node test/quality/vision-mode-mv3.mjs --zoom=1.25  browser zoom 125%
const dpr = Number((process.argv.find(arg => arg.startsWith('--dpr=')) || '--dpr=1').slice(6)) || 1;
const zoom = Number((process.argv.find(arg => arg.startsWith('--zoom=')) || '--zoom=1').slice(7)) || 1;
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-mode-mv3');
await fs.mkdir(out, { recursive: true });

// Absolute positions keep the fixture's CSS geometry known to the "model".
const LAYOUT = {
  name: { x: 60, y: 140, w: 320, h: 36 },
  submit: { x: 60, y: 220, w: 180, h: 44 },
};
const body = `<!doctype html><meta charset="utf-8"><title>Vision MV3 fixture</title>
<style>body{margin:0;font:16px sans-serif}h1{position:absolute;left:60px;top:40px;margin:0}
#name{position:absolute;left:${LAYOUT.name.x}px;top:${LAYOUT.name.y}px;width:${LAYOUT.name.w}px;height:${LAYOUT.name.h}px;box-sizing:border-box;font:16px sans-serif}
#submit{position:absolute;left:${LAYOUT.submit.x}px;top:${LAYOUT.submit.y}px;width:${LAYOUT.submit.w}px;height:${LAYOUT.submit.h}px;background:#1a73e8;color:#fff;border:0;font:16px sans-serif}
#result{position:absolute;left:60px;top:300px;width:400px;height:30px}
label{position:absolute;left:60px;top:112px}</style>
<h1>Vision form</h1><label for="name">Name</label><input id="name" name="name" autocomplete="off"><button id="submit" type="button">Send name</button><div id="result" role="status"></div>
<script>document.getElementById('submit').addEventListener('click', async () => {
  const value = document.getElementById('name').value;
  await fetch('/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: value }) });
  document.getElementById('result').textContent = 'Saved: ' + value;
});</script>`;

function imageSize(dataUrl) {
  const match = /^data:image\/(webp|jpeg|png);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (match[1] === 'png') return { type: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (match[1] === 'webp') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { type: 'webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { type: 'webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  let i = 2;
  while (i < bytes.length) {
    const marker = bytes[i + 1];
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { type: 'jpeg', height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return null;
}

const providerCalls = [];
const submissions = [];
const frames = [];
let cssViewport = null;
let actionCalls = 0;
let keyframe = null;
// The "model" converts the fixture's CSS geometry with the ratio the frame
// label declares, as a model reading the label would.
const centre = (rect, image) => ({
  x: Math.round((rect.x + rect.w / 2) / image.ratio),
  y: Math.round((rect.y + rect.h / 2) / image.ratio),
});

const server = http.createServer(async (request, response) => {
  if (request.url === '/submit') {
    let text = ''; for await (const chunk of request) text += chunk;
    submissions.push(JSON.parse(text)); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}'); return;
  }
  if (request.url === '/v1/chat/completions') {
    let text = ''; for await (const chunk of request) text += chunk;
    const input = JSON.parse(text); providerCalls.push(input);
    const isAction = Array.isArray(input.tools) && input.tools.length > 0;
    const fixedChoice = fixtureFixedChoiceReply(input.messages);
    let completion;
    if (fixedChoice) completion = { role: 'assistant', content: fixedChoice };
    else if (!isAction) completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'Scripted fixture.' }) };
    else {
      // Every image the extension sent in this request, with its label.
      for (const message of input.messages) {
        if (!Array.isArray(message.content)) continue;
        const label = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        for (const block of message.content) {
          if (block.type !== 'image_url') continue;
          const url = block.image_url?.url || block.image_url;
          const size = imageSize(url);
          const key = /SCREENSHOT (f\d+)/.exec(label)?.[1];
          if (key && !frames.some(frame => frame.id === key)) {
            const declared = /(\d+)x(\d+) image; 1 image px = ([\d.]+) CSS px/.exec(label);
            frames.push({ id: key, size, declared: declared ? { width: Number(declared[1]), height: Number(declared[2]), ratio: Number(declared[3]) } : null, call: providerCalls.length });
          }
        }
      }
      keyframe = frames.at(-1)?.declared || null;
      const step = actionCalls++;
      let call;
      if (!keyframe) call = { name: 'take_screenshot', args: {} };
      else if (step === 0) call = { name: 'click_at', args: centre(LAYOUT.name, keyframe) };
      else if (step === 1) call = { name: 'type_text', args: { text: 'Vision QA' } };
      else if (step === 2) call = { name: 'click_at', args: centre(LAYOUT.submit, keyframe) };
      else call = { name: 'done', args: { summary: 'The name was sent.', outcome: 'success' } };
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `vision-${step}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `completion-${providerCalls.length}`, choices: [{ message: completion, finish_reason: isAction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/form`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-vision-mv3-'));
let context;
try {
  const extension = path.resolve('src/chrome');
  // No viewport emulation: --force-device-scale-factor is how a retina
  // screen looks to Chrome (page DPR and compositor scale agree).
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--force-device-scale-factor=${dpr}`, '--window-size=1280,900'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(async () => {
    window.events = [];
    chrome.runtime.onMessage.addListener(event => { if (event.action === 'agent_update') events.push({ type: event.type, data: event.data }); });
    // visionMode is deliberately left unset: vision mode is the default.
    await chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false, autoScreenshot: 'navigation', maxAgentSteps: 12, systemOneEnabled: false, tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false, leanMode: 'on' });
  });
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'anthropic/claude-sonnet-4.5', contextWindow: 200000, enabled: true, supportsAskStreaming: false, supportsVision: true } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(url);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  if (zoom !== 1) {
    await harness.evaluate(async ({ tabId, zoom }) => chrome.tabs.setZoom(tabId, zoom), { tabId, zoom });
    await page.waitForFunction(expected => Math.abs(window.devicePixelRatio - expected) < 0.05, dpr * zoom);
  }
  // What the scripted model knows about the screen: its CSS size.
  cssViewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, dpr: devicePixelRatio }));
  const started = performance.now();
  const result = await message('chat', { tabId, text: 'Type Vision QA into the Name field and press Send name.', mode: 'act', requestId: 'vision-mv3', locale: 'en' });
  const elapsedMs = Math.round(performance.now() - started);
  const events = await harness.evaluate(() => events);
  const value = await page.locator('#name').inputValue();
  await fs.writeFile(path.join(out, `evidence-dpr${dpr}-zoom${zoom}.json`), JSON.stringify({ result, value, submissions, frames, cssViewport, elapsedMs, events, providerCalls },
    (_key, item) => typeof item === 'string' && item.startsWith('data:image/') ? `[image ${JSON.stringify(imageSize(item))}]` : item, 2));

  const actionRequests = providerCalls.filter(call => Array.isArray(call.tools) && call.tools.length);
  const tools = actionRequests[0]?.tools.map(tool => tool.function.name) || [];
  for (const name of ['click_at', 'type_text', 'scroll_at', 'zoom', 'take_screenshot']) assert.ok(tools.includes(name), `${name} offered: ${tools}`);
  for (const name of ['get_accessibility_tree', 'click_ax', 'set_field', 'click']) assert.ok(!tools.includes(name), `${name} not offered`);
  assert.ok(frames.length >= 1, 'the model received a full frame');
  const first = frames[0];
  assert.equal(first.id, 'f1');
  assert.ok(first.declared, 'the frame label declares its size');
  assert.deepEqual({ width: first.size.width, height: first.size.height }, { width: first.declared.width, height: first.declared.height },
    'the image the model receives has exactly the declared size');
  assert.equal(first.size.type, 'webp', 'Anthropic-family models get WebP');
  // Never device pixels: at most one image px per CSS px.
  assert.ok(first.size.width <= cssViewport.width, `image ${first.size.width}px for a ${cssViewport.width}px CSS viewport at DPR ${cssViewport.dpr}`);
  assert.equal(value, 'Vision QA', `the click focused the field and typing reached it: ${JSON.stringify(result).slice(0, 600)}`);
  assert.equal(submissions.length, 1, JSON.stringify(events.filter(event => event.type === 'tool_result').map(event => event.data), null, 1).slice(0, 3000));
  assert.deepEqual(submissions[0], { name: 'Vision QA' });
  // The model-facing click results (tool messages) name the exact-point path.
  const toolResults = actionRequests.at(-1).messages.filter(message => message.role === 'tool').map(message => String(message.content));
  const clickResults = toolResults.filter(text => /"method":"cdp-vision-pointer"/.test(text));
  assert.equal(clickResults.length, 2, toolResults.join('\n').slice(0, 2000));
  // After the first frame the model got patches or "no visible change", not
  // a new full frame per action.
  const laterImages = actionRequests.slice(1).flatMap(call => call.messages.filter(message => Array.isArray(message.content))
    .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')));
  assert.ok(laterImages.some(text => /UNTRUSTED SCREEN UPDATE|no visible change/.test(text)), 'incremental updates followed the first frame');
  const lastRequest = actionRequests.at(-1);
  const imagesInLast = lastRequest.messages.flatMap(message => (Array.isArray(message.content) ? message.content : [])).filter(block => block.type === 'image_url').length;
  assert.ok(imagesInLast <= 6, `old images were pruned (${imagesInLast} in the last request)`);
  console.log(JSON.stringify({ passed: true, dpr, zoom, cssViewport, firstFrame: first, frames: frames.length, actionRequests: actionRequests.length, submitted: submissions.length, elapsedMs }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-vision-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
