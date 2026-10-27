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
//   node test/quality/vision-mode-mv3.mjs --scroll=100 page scrolled 100 CSS px
// Two colored markers (one fixed, one in the document) must appear in the
// first frame exactly where the frame label's scale puts their CSS boxes.
const dpr = Number((process.argv.find(arg => arg.startsWith('--dpr=')) || '--dpr=1').slice(6)) || 1;
const zoom = Number((process.argv.find(arg => arg.startsWith('--zoom=')) || '--zoom=1').slice(7)) || 1;
const scroll = Number((process.argv.find(arg => arg.startsWith('--scroll=')) || '--scroll=0').slice(9)) || 0;
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-mode-mv3');
await fs.mkdir(out, { recursive: true });

// Absolute positions keep the fixture's CSS geometry known to the "model".
const LAYOUT = {
  name: { x: 60, y: 140, w: 320, h: 36 },
  submit: { x: 60, y: 220, w: 180, h: 44 },
  // Viewport-fixed and document-positioned markers for the pixel check.
  fixedMarker: { x: 700, y: 60, w: 80, h: 40 },
  pageMarker: { x: 600, y: 230, w: 60, h: 50 },
  // A viewport-fixed target=_blank link: the tab it opens is rerouted into
  // this tab, as for any click.
  link: { x: 60, y: 400, w: 220, h: 32 },
};
const body = `<!doctype html><meta charset="utf-8"><title>Vision MV3 fixture</title>
<style>body{margin:0;font:16px sans-serif}h1{position:absolute;left:60px;top:40px;margin:0}
#name{position:absolute;left:${LAYOUT.name.x}px;top:${LAYOUT.name.y}px;width:${LAYOUT.name.w}px;height:${LAYOUT.name.h}px;box-sizing:border-box;font:16px sans-serif}
#submit{position:absolute;left:${LAYOUT.submit.x}px;top:${LAYOUT.submit.y}px;width:${LAYOUT.submit.w}px;height:${LAYOUT.submit.h}px;background:#1a73e8;color:#fff;border:0;font:16px sans-serif}
#result{position:absolute;left:60px;top:300px;width:400px;height:30px}
label{position:absolute;left:60px;top:112px}
#fixed-marker{position:fixed;left:${LAYOUT.fixedMarker.x}px;top:${LAYOUT.fixedMarker.y}px;width:${LAYOUT.fixedMarker.w}px;height:${LAYOUT.fixedMarker.h}px;background:rgb(255,0,255)}
#page-marker{position:absolute;left:${LAYOUT.pageMarker.x}px;top:${LAYOUT.pageMarker.y}px;width:${LAYOUT.pageMarker.w}px;height:${LAYOUT.pageMarker.h}px;background:rgb(0,255,255)}
#tall{position:absolute;left:0;top:0;width:1px;height:2400px}
#hint{position:absolute;left:400px;top:148px;width:200px;height:20px;font:13px sans-serif}
#ticker{position:fixed;right:20px;bottom:20px;width:160px;height:24px;font:14px monospace}
#details{position:fixed;left:${LAYOUT.link.x}px;top:${LAYOUT.link.y}px;width:${LAYOUT.link.w}px;height:${LAYOUT.link.h}px;display:block;line-height:32px;font:16px sans-serif;background:#eee}</style>
<div id="tall"></div><div id="fixed-marker"></div><div id="page-marker"></div><div id="hint"></div><div id="ticker"></div>
<a id="details" href="/details" target="_blank">Open details</a>
<h1>Vision form</h1><label for="name">Name</label><input id="name" name="name" autocomplete="off"><button id="submit" type="button">Send name</button><div id="result" role="status"></div>
<script>// A hostile page cannot blind the dispatch checks: they run in an isolated world.
Document.prototype.elementFromPoint = function () { return null; };
// The page reacts to the click's focus, and a ticker keeps it changing while
// the model thinks (page churn far from the controls).
document.getElementById('name').addEventListener('focus', () => { document.getElementById('hint').textContent = 'Type your name'; });
let ticks = 0; setInterval(() => { document.getElementById('ticker').textContent = 'tick ' + (++ticks); }, 250);
document.getElementById('submit').addEventListener('click', async () => {
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
// The fixture page, for the scripted model to read the scroll position the
// wheel left before it clicks the link.
let livePage = null;
let scrollBeforeLink = null;
let valueBeforeLink = null;
// The "model" converts the fixture's CSS geometry with the ratio the frame
// label declares, as a model reading the label would.
const centre = (rect, image, { fixed = false } = {}) => ({
  x: Math.round((rect.x + rect.w / 2) / image.ratio),
  y: Math.round((rect.y - (fixed ? 0 : scroll) + rect.h / 2) / image.ratio),
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
            frames.push({ id: key, size, declared: declared ? { width: Number(declared[1]), height: Number(declared[2]), ratio: Number(declared[3]) } : null, call: providerCalls.length, ...(frames.length ? {} : { dataUrl: url }) });
          }
        }
      }
      keyframe = frames.at(-1)?.declared || null;
      const step = actionCalls++;
      // Decide from the history, not a step count: WebBrain may set a
      // response aside when the page changed while the model was thinking.
      const results = new Map(input.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, String(message.content)]));
      const pairs = input.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || [])
        .map(item => ({ name: item.function.name, ok: /"success":true/.test(results.get(item.id) || '') }));
      const typedAt = pairs.findLastIndex(pair => pair.name === 'type_text' && pair.ok);
      const submitted = typedAt >= 0 && pairs.slice(typedAt + 1).some(pair => pair.name === 'click_at' && pair.ok);
      const scrolled = pairs.some(pair => pair.name === 'scroll_at' && pair.ok);
      const clicked = pairs.filter(pair => pair.name === 'click_at' && pair.ok).length;
      let call;
      if (!keyframe) call = { name: 'take_screenshot', args: {} };
      else if (typedAt < 0) {
        const last = pairs.at(-1);
        call = last?.name === 'click_at' && last.ok
          ? { name: 'type_text', args: { text: 'Vision QA' } }
          : [{ name: 'click_at', args: centre(LAYOUT.name, keyframe) }, { name: 'type_text', args: { text: 'Vision QA' } }];
      } else if (!submitted) call = { name: 'click_at', args: centre(LAYOUT.submit, keyframe) };
      // A wheel at the middle of the screen while the ticker keeps changing.
      else if (!scrolled) call = { name: 'scroll_at', args: { direction: 'down', amount: 3, x: Math.round(keyframe.width / 2), y: Math.round(keyframe.height / 2) } };
      else if (clicked < 3) {
        scrollBeforeLink ??= await livePage?.evaluate(() => window.scrollY).catch(() => null);
        valueBeforeLink ??= await livePage?.evaluate(() => document.getElementById('name').value).catch(() => null);
        call = { name: 'click_at', args: centre(LAYOUT.link, keyframe, { fixed: true }) };
      }
      else call = { name: 'done', args: { summary: 'The name was sent.', outcome: 'success' } };
      completion = { role: 'assistant', content: '', tool_calls: [call].flat().map((item, index) => ({ id: `vision-${step}-${index}`, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.args) } })) };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `completion-${providerCalls.length}`, choices: [{ message: completion, finish_reason: isAction ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(request.url === '/details' ? '<!doctype html><meta charset="utf-8"><title>Details</title><h1>Details page</h1>' : body);
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
  livePage = page;
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  if (zoom !== 1) {
    await harness.evaluate(async ({ tabId, zoom }) => chrome.tabs.setZoom(tabId, zoom), { tabId, zoom });
    await page.waitForFunction(expected => Math.abs(window.devicePixelRatio - expected) < 0.05, dpr * zoom);
  }
  if (scroll) {
    await page.evaluate(y => window.scrollTo(0, y), scroll);
    await page.waitForFunction(y => Math.abs(window.scrollY - y) < 1, scroll);
  }
  // What the scripted model knows about the screen: its CSS size.
  cssViewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight, dpr: devicePixelRatio, scrollY: window.scrollY }));
  const started = performance.now();
  const result = await message('chat', { tabId, text: 'Type Vision QA into the Name field and press Send name.', mode: 'act', requestId: 'vision-mv3', locale: 'en' });
  const elapsedMs = Math.round(performance.now() - started);
  const events = await harness.evaluate(() => events);
  // The form page is gone once the link was followed: its field as it was
  // right before that click.
  const value = valueBeforeLink;
  const finalUrl = page.url();
  const webPages = context.pages().filter(item => /^http/.test(item.url())).map(item => item.url());
  await fs.writeFile(path.join(out, `evidence-dpr${dpr}-zoom${zoom}-scroll${scroll}.json`), JSON.stringify({ result, value, submissions, frames, cssViewport, elapsedMs, events, providerCalls },
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
  // The pixels show the page where the label's scale says: each marker's box
  // in the image, times the declared CSS px per image px, is its CSS box in
  // the viewport (browser zoom and scrolling included).
  const boxes = await page.evaluate(async dataUrl => {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const find = test => {
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (test(data[i], data[i + 1], data[i + 2])) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      }
      return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
    };
    return {
      fixed: find((r, g, b) => r > 200 && g < 90 && b > 200),
      page: find((r, g, b) => r < 90 && g > 200 && b > 200),
    };
  }, first.dataUrl);
  const ratio = first.declared.ratio;
  for (const [key, rect, offsetY] of [['fixed', LAYOUT.fixedMarker, 0], ['page', LAYOUT.pageMarker, cssViewport.scrollY]]) {
    const box = boxes[key];
    assert.ok(box, `${key} marker visible in f1`);
    const css = { x0: box.x0 * ratio, y0: box.y0 * ratio, x1: box.x1 * ratio, y1: box.y1 * ratio };
    // Clipped to the viewport (at 150% zoom it is only 853 CSS px wide).
    const expected = {
      x0: Math.max(0, rect.x), y0: Math.max(0, rect.y - offsetY),
      x1: Math.min(cssViewport.width, rect.x + rect.w), y1: Math.min(cssViewport.height, rect.y - offsetY + rect.h),
    };
    for (const side of ['x0', 'y0', 'x1', 'y1']) {
      assert.ok(Math.abs(css[side] - expected[side]) <= 3, `${key} marker ${side}: image says CSS ${css[side].toFixed(1)}, page has ${expected[side]} (${JSON.stringify({ box, ratio, cssViewport })})`);
    }
  }
  assert.equal(value, 'Vision QA', `the click focused the field and typing reached it: ${JSON.stringify(result).slice(0, 600)}`);
  assert.equal(submissions.length, 1, JSON.stringify(events.filter(event => event.type === 'tool_result').map(event => event.data), null, 1).slice(0, 3000));
  assert.deepEqual(submissions[0], { name: 'Vision QA' });
  // The model-facing click results (tool messages) name the exact-point path.
  const toolResults = actionRequests.at(-1).messages.filter(message => message.role === 'tool').map(message => String(message.content));
  const clickResults = toolResults.filter(text => /"method":"cdp-vision-pointer"/.test(text));
  assert.ok(clickResults.length >= 2, toolResults.join('\n').slice(0, 2000));
  // click_at + type_text in one response: the typing went into the field the
  // click focused although the page reacted to that focus (the hint) and kept
  // changing (the ticker).
  const typeResults = actionRequests.flatMap(request => request.messages)
    .filter(message => message.role === 'tool' && /vision-\d+-1$/.test(message.tool_call_id || ''));
  const firstType = typeResults[0] ? String(typeResults[0].content) : '';
  assert.match(firstType, /"success":true/, `type_text after click_at in the same response: ${firstType.slice(0, 400)}`);
  // No accessibility-tree text reaches a vision run's model.
  for (const request of actionRequests) {
    const text = JSON.stringify(request.messages.map(message => (Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'text') : message.content)));
    assert.doesNotMatch(text, /pageContent|\[BROWSER STATE: current page observed/, 'tree text in a vision request');
  }
  // scroll_at under the same churn: dispatched on the first try, and the page
  // moved by about the three wheel notches asked for.
  const history = actionRequests.at(-1).messages;
  const scrollIds = history.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || [])
    .filter(item => item.function.name === 'scroll_at').map(item => item.id);
  const firstScroll = String(history.find(message => message.role === 'tool' && message.tool_call_id === scrollIds[0])?.content || '');
  assert.match(firstScroll, /"success":true/, `scroll_at during page churn: ${firstScroll.slice(0, 400)}`);
  assert.ok(scrollBeforeLink - cssViewport.scrollY >= 150, `the wheel scrolled the page (${cssViewport.scrollY} -> ${scrollBeforeLink})`);
  // The link's new tab became this tab's page: one web page, now /details.
  assert.match(finalUrl, /\/details$/, `the tab the link opened was rerouted into the run's tab (${finalUrl})`);
  assert.deepEqual(webPages, [finalUrl], `no extra tab is left open: ${JSON.stringify(webPages)}`);
  const linkResult = String(history.find(message => message.role === 'tool' && /"redirectedFromNewTab":true/.test(String(message.content)))?.content || '');
  assert.ok(linkResult, 'the click result says the new tab was rerouted');
  // Churn did not make WebBrain throw decisions away: click+type, send,
  // scroll, link, done.
  assert.ok(actionRequests.length <= 6, `${actionRequests.length} model calls`);
  // Until the link navigates: one screen update per step, and no browser-
  // state message. The ticker and the caret never changed the screen by more
  // than a micro change between an update and the next decision.
  const beforeLink = actionRequests.slice(0, 4);
  const updatesIn = request => request.messages.filter(message => Array.isArray(message.content)
    && message.content.some(block => block.type === 'text' && /UNTRUSTED SCREEN UPDATE|UNTRUSTED SCREENSHOT f\d+|no visible change/.test(block.text))).length;
  for (let index = 1; index < beforeLink.length; index++) {
    assert.equal(updatesIn(beforeLink[index]) - updatesIn(beforeLink[index - 1]), 1, `one screen update before decision ${index + 1}`);
  }
  for (const request of beforeLink) {
    assert.doesNotMatch(JSON.stringify(request.messages), /\[BROWSER STATE UPDATE/, 'page churn alone sends no browser-state message');
  }
  // The pre-dispatch probe saw the real button although the page replaced
  // elementFromPoint in its own world.
  assert.ok(clickResults.some(text => /"target":\{"tag":"button"\}/.test(text)), clickResults.join('\n'));
  // After the first frame the model got patches or "no visible change", not
  // a new full frame per action.
  const laterImages = actionRequests.slice(1).flatMap(call => call.messages.filter(message => Array.isArray(message.content))
    .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')));
  assert.ok(laterImages.some(text => /UNTRUSTED SCREEN UPDATE|no visible change/.test(text)), 'incremental updates followed the first frame');
  // Pruning: every image in the last request belongs to the current frame
  // (the last full frame and the patches after it); older ones are placeholders.
  const lastRequest = actionRequests.at(-1);
  const labelOf = message => (Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '');
  const lastFrameAt = lastRequest.messages.findLastIndex(message => /UNTRUSTED SCREENSHOT f\d+/.test(labelOf(message))
    && message.content.some(block => block.type === 'image_url'));
  assert.ok(lastFrameAt >= 0, 'the current frame is in the request');
  const olderImages = lastRequest.messages.slice(0, lastFrameAt)
    .flatMap(message => (Array.isArray(message.content) ? message.content : [])).filter(block => block.type === 'image_url').length;
  assert.equal(olderImages, 0, 'images before the current frame were pruned');
  console.log(JSON.stringify({ passed: true, dpr, zoom, scroll, cssViewport, firstFrame: { ...first, dataUrl: undefined }, markers: boxes, frames: frames.length, actionRequests: actionRequests.length, submitted: submissions.length, elapsedMs }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-vision-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
