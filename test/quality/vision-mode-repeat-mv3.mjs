import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { fixtureFixedChoiceReply } from '../semantic-decision-stub.mjs';

// The same point clicked again and again in vision mode, end to end in the
// installed MV3 extension. Loop detection used to count every click_at at one
// point and stop the run at the eighth ("the page never responded") although
// each click visibly changed the screen, and a DOM text snapshot called a
// click on a canvas a failure. Here the model presses a "+" button ten times
// (the counter it changes is drawn on a canvas, so the DOM text never moves),
// then a dead button below it: the ten presses all go out, and the dead
// button is stopped once its clicks keep leaving the screen unchanged.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/vision-mode-repeat-mv3');
await fs.mkdir(out, { recursive: true });
const LAYOUT = {
  plus: { x: 60, y: 120, w: 80, h: 48 },
  dead: { x: 60, y: 260, w: 160, h: 40 },
};
const PRESSES = 10;
const body = `<!doctype html><meta charset="utf-8"><title>Counter</title>
<style>body{margin:0;font:16px sans-serif}h1{position:absolute;left:60px;top:30px;margin:0}
#plus{position:absolute;left:${LAYOUT.plus.x}px;top:${LAYOUT.plus.y}px;width:${LAYOUT.plus.w}px;height:${LAYOUT.plus.h}px;font:28px sans-serif}
#count{position:absolute;left:180px;top:110px}
#dead{position:absolute;left:${LAYOUT.dead.x}px;top:${LAYOUT.dead.y}px;width:${LAYOUT.dead.w}px;height:${LAYOUT.dead.h}px}</style>
<h1>Counter</h1><button id="plus" type="button" aria-label="Add one">+</button><canvas id="count" width="220" height="68"></canvas>
<button id="dead" type="button">Does nothing</button>
<script>
let count = 0;
const draw = () => { const c = document.getElementById('count').getContext('2d'); c.clearRect(0, 0, 220, 68); c.fillStyle = '#000'; c.font = '48px sans-serif'; c.fillText(String(count), 10, 52); };
draw();
document.getElementById('plus').addEventListener('click', () => { count++; draw(); fetch('/press', { method: 'POST' }); });
</script>`;

const providerCalls = [];
let presses = 0;
let keyframe = null;
let actionCalls = 0;
const centre = (rect, image) => ({ x: Math.round((rect.x + rect.w / 2) / image.ratio), y: Math.round((rect.y + rect.h / 2) / image.ratio) });
const server = http.createServer(async (incoming, response) => {
  if (incoming.url === '/press') { presses++; response.writeHead(204); response.end(); return; }
  if (incoming.url === '/v1/chat/completions') {
    let text = ''; for await (const chunk of incoming) text += chunk;
    const input = JSON.parse(text); providerCalls.push(input);
    const isAction = Array.isArray(input.tools) && input.tools.length > 0;
    const fixedChoice = fixtureFixedChoiceReply(input.messages);
    let completion;
    if (fixedChoice) completion = { role: 'assistant', content: fixedChoice };
    else if (!isAction) completion = { role: 'assistant', content: JSON.stringify({ outcome: 'uncertain', reason: 'Scripted fixture.' }) };
    else {
      for (const message of input.messages) {
        if (!Array.isArray(message.content)) continue;
        const label = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        const declared = /SCREENSHOT f\d+[\s\S]*?(\d+)x(\d+) image; 1 image px = ([\d.]+) CSS px/.exec(label);
        if (declared) keyframe = { width: Number(declared[1]), height: Number(declared[2]), ratio: Number(declared[3]) };
      }
      const step = actionCalls++;
      const results = new Map(input.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, String(message.content)]));
      const clicks = input.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || [])
        .filter(item => item.function.name === 'click_at').map(item => ({ ok: /"success":true/.test(results.get(item.id) || ''), result: results.get(item.id) || '' }));
      const pressed = clicks.filter(click => click.ok).length;
      let call;
      if (!keyframe) call = { name: 'take_screenshot', args: {} };
      else if (pressed < PRESSES) call = { name: 'click_at', args: centre(LAYOUT.plus, keyframe) };
      // Then the dead button, until WebBrain stops the run.
      else call = { name: 'click_at', args: centre(LAYOUT.dead, keyframe) };
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `vision-repeat-${step}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `completion-${providerCalls.length}`, choices: [{ message: completion, finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/counter`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-vision-repeat-mv3-'));
let context;
try {
  const extension = path.resolve('src/chrome');
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1280,900'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const id = new URL(worker.url()).host;
  const harness = await context.newPage(); await harness.goto(`chrome-extension://${id}/src/ui/settings.html`);
  const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await harness.evaluate(() => chrome.storage.local.set({ helpImproveWebBrain: false, planBeforeActMode: 'off', planBeforeAct: false,
    planReviewMode: 'never', screenshotFallback: false, autoScreenshot: 'navigation', maxAgentSteps: 30, systemOneEnabled: false,
    tracingEnabled: false, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
  assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'anthropic/claude-sonnet-4.5', contextWindow: 200000,
    enabled: true, supportsAskStreaming: false, supportsVision: true } })).ok, true);
  assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
  const page = await context.newPage(); await page.goto(url);
  const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
  const result = await message('chat', { tabId, text: `Press the + button ${PRESSES} times.`, mode: 'act', requestId: 'vision-repeat-mv3', locale: 'en' });
  const blocked = result.updates.filter(event => event.type === 'tool_result' && event.data?.result?.success === false)
    .map(event => ({ tool: event.data.name, error: String(event.data.result.error || '').slice(0, 200) }));
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, presses, blocked, actionCalls },
    (_key, item) => typeof item === 'string' && item.startsWith('data:image/') ? '[screenshot omitted]' : item, 2));
  // The model moves on to the dead button only after ten successful presses.
  assert.equal(presses, PRESSES, `every press went out: ${presses}; ${JSON.stringify(blocked).slice(0, 800)}`);
  const finalText = String(result.response || result.text || result.finalResponse || JSON.stringify(result.updates.filter(event => event.type === 'text').at(-1)?.data || ''));
  // The dead button is stopped by the loop guard, with the model's own point.
  assert.match(finalText, /in the screenshot several times and the screen did not change/, finalText.slice(0, 600));
  const deadClicks = actionCalls - PRESSES - 1;
  assert.ok(deadClicks <= 9, `the dead button was stopped after ${deadClicks} clicks`);
  console.log(JSON.stringify({ passed: true, installedMV3: true, presses, deadClicks, actionCalls }));
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-vision-repeat-mv3-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
