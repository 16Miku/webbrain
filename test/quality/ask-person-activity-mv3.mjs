import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// The WhatsApp trace: in Ask mode the person asked what to reply, and while
// the answer was being written they typed a draft into the chat's composer,
// clicked and scrolled. The answer appeared and vanished twice before a third
// one stayed. Through the installed MV3 extension, with real page events from
// real input: the answer that is being written stays, and is written once.
// The page and the model are owned local fixtures; nothing leaves the host.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/quality-audit-2026-10-15/ask-person-activity-mv3');
await fs.mkdir(out, { recursive: true });
const textContent = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const question = 'Owned Ask person activity. What should I reply to the last message here?';
const answer = 'You could reply: "Thanks, 70,000 works for me if the insulation is included." OWNED-ASK-PERSON-ANSWER';
const chatHtml = `<!doctype html><meta charset="utf-8"><title>Owned chat</title>
<style>body{font:16px sans-serif;margin:0;display:flex;flex-direction:column;height:100vh}
#messages{flex:1;overflow:auto;padding:16px}#messages p{margin:0 0 12px;padding:8px;background:#eef;border-radius:6px;width:60%}
footer{display:flex;gap:8px;padding:12px;border-bottom:1px solid #ccc}#composer{flex:1;min-height:40px;border:1px solid #888;padding:8px}</style>
<footer><div id="composer" role="textbox" contenteditable="true" aria-label="Type a message"></div><button id="attach" type="button" aria-label="Attach">+</button></footer>
<main id="messages" aria-label="Messages"><p id="last">Last message: 70,000 for the whole job.</p>
${Array.from({ length: 30 }, (_, index) => `<p>Earlier message ${index + 1}: the balcony and the roof.</p>`).join('')}</main>
<script>
// Like a chat app, the page reacts to typing: a typing hint appears.
const hint=document.createElement('div');hint.id='hint';document.body.prepend(hint);
document.querySelector('#composer').addEventListener('input',()=>{hint.textContent='Draft: '+document.querySelector('#composer').textContent.length+' characters';});
document.querySelector('#attach').addEventListener('click',()=>{hint.textContent='Attach menu opened';});
</script>`;

const calls = [], network = [], runtimeErrors = [];
const mainReached = deferred(), releaseMain = deferred();
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://owned.local');
    if (url.pathname === '/chat') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(chatHtml); return; }
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    assert.equal(url.pathname, '/v1/chat/completions');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), system = textContent(input.messages[0]?.content);
    if (input.messages?.length === 1 && input.messages[0].content === 'Hi' && !input.tools?.length) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      return;
    }
    const stage = system.startsWith('You classify whether one proposed terminal WebBrain Ask answer') ? 'scope'
      : system.startsWith('You classify whether a WebBrain Ask-mode answer') ? 'handoff' : 'main';
    const record = { stage, stream: input.stream === true, at: Date.now() };
    calls.push(record);
    let content;
    if (stage === 'scope') content = JSON.stringify({ pageIndependent: false });
    else if (stage === 'handoff') content = '{"mode_handoff":"none"}';
    else {
      assert.ok(JSON.stringify(input.messages).includes('Owned Ask person activity'), 'Only the owned question reaches the model');
      // The model takes its time, as in the trace; the person keeps using the page.
      if (calls.filter(call => call.stage === 'main').length === 1) { mainReached.resolve(); await releaseMain.promise; }
      content = answer;
    }
    if (input.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const half = Math.floor(content.length / 2);
      for (const part of [content.slice(0, half), content.slice(half)]) {
        response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: part }, finish_reason: null }] }) + '\n\n');
        await delay(30);
      }
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
    }
  } catch (error) {
    runtimeErrors.push(error.message);
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-ask-person-'));
let context;
try {
  const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  context = await chromium.launchPersistentContext(path.join(profile, 'user'), { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking', '--disable-sync'] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' || url.origin === origin) return route.continue();
    network.push(url.hostname); return route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extensionId = new URL(worker.url()).host;
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  const message = (page, action, data = {}) => page.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
  await settings.evaluate(() => chrome.storage.local.set({ helpImproveWebBrain: false, userMemoryEnabled: false,
    planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false, autoScreenshot: 'off',
    maxAgentSteps: 6, systemOneEnabled: false, tracingEnabled: true, losslessTrace: true, agentAllowLocalNetwork: true,
    askBeforeConsequentialActions: false, openaiAskStreamingEnabled: true, contextWindowMode: 'full' }));
  assert.equal((await message(settings, 'update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-loopback-fake-key',
    baseUrl: `${origin}/v1`, model: 'openai/gpt-5.4-mini', contextWindow: 128000, enabled: true, supportsAskStreaming: true,
    supportsVision: false, visionMode: 'off' } })).ok, true);
  assert.equal((await message(settings, 'set_active_provider', { providerId: 'openrouter' })).ok, true);
  const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html`);
  await panel.evaluate(() => {
    window.ownedRun = { finished: false }; window.ownedEvents = [];
    chrome.runtime.onMessage.addListener(event => { if (event.action === 'agent_update' || event.action === 'run_complete') ownedEvents.push(event); });
  });
  const page = await context.newPage();
  await page.goto(`${origin}/chat`);
  const tabId = await settings.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  assert.ok(tabId);
  const requestId = 'owned-ask-person-activity';
  await panel.evaluate(({ requestId, tabId, text }) => {
    chrome.runtime.sendMessage({ target: 'background', action: 'chat', requestId, tabId, text, mode: 'ask', locale: 'en' })
      .then(result => { window.ownedRun = { finished: true, result }; })
      .catch(error => { window.ownedRun = { finished: true, error: error.message }; });
  }, { requestId, tabId, text: question });
  await Promise.race([mainReached.promise, delay(45000).then(() => { throw new Error('The answer was never requested.'); })]);
  // The person keeps using the chat: they click into the composer, type a
  // draft, open a menu and scroll the messages, as real input.
  await page.bringToFront();
  await page.click('#composer');
  await page.keyboard.type('bi de bana sorumluluk', { delay: 20 });
  await page.click('#attach');
  await page.mouse.move(300, 200);
  await page.mouse.wheel(0, -600);
  await page.click('#last');
  await delay(1500);
  releaseMain.resolve();
  await panel.waitForFunction(() => window.ownedRun.finished, null, { timeout: 45000 });
  const run = await panel.evaluate(() => window.ownedRun);
  const events = await panel.evaluate(id => ownedEvents.filter(event => event.requestId === id), requestId);
  const current = await message(panel, 'agent_run_state', { tabId, requestId });
  const draft = await page.evaluate(() => document.querySelector('#composer').textContent);
  const descriptor = await message(panel, 'export_traces', { tabId, full: true });
  const decisions = descriptor?.ok ? await panel.evaluate(async ({ sessionId, extensionId }) => {
    const recorder = await import(`chrome-extension://${extensionId}/src/trace/recorder.js`);
    const runs = await recorder.listRuns({ conversationId: sessionId });
    const all = await Promise.all(runs.map(item => recorder.getRunEvents(item.runId)));
    return all.flat().filter(event => event.kind === 'note' && event.data?.note === 'page_feedback_decision').map(event => event.data.extra);
  }, { sessionId: descriptor.sessionId, extensionId }) : [];
  const retracted = events.filter(event => event.type === 'text' && event.data?.replace === true && event.data?.content === '');
  const main = calls.filter(call => call.stage === 'main');
  const evidence = { run, calls, current: { running: current?.running, finalContent: current?.runUi?.finalContent, status: current?.runUi?.status },
    retracted: retracted.length, decisions, draft, network, runtimeErrors };
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  assert.deepEqual(runtimeErrors, []);
  assert.equal(draft, 'bi de bana sorumluluk', 'The person really typed into the page');
  assert.ok(decisions.some(decision => (decision.context?.feedback?.observed?.events || []).some(event => event.source === 'user')),
    `The person's activity reached WebBrain as page feedback: ${JSON.stringify(decisions)}`);
  assert.equal(main.length, 1, `The answer was written once, not again after the person's activity: ${JSON.stringify(calls)}`);
  assert.equal(retracted.length, 0, 'The answer being shown was never taken back');
  assert.equal(run.error, undefined);
  assert.equal(run.result?.content, answer);
  assert.equal(current?.running, false);
  console.log(JSON.stringify({ passed: true, installedMV3: true, mainCalls: main.length, retracted: retracted.length,
    decisions: decisions.map(decision => `${decision.stage}:${decision.disposition}`), blockedNetwork: network.length }));
} finally {
  releaseMain.resolve();
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  const resolved = await fs.realpath(profile);
  if (!path.basename(resolved).startsWith('webbrain-ask-person-')) throw new Error('Unexpected temporary profile path.');
  await fs.rm(resolved, { recursive: true, force: true });
}
