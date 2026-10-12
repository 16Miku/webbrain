import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Install an isolated, unmodified product copy. Only the owned page and provider
// are deterministic; Agent, background, monitor, scope and delivery are real.
const workspace = path.resolve('.');
const source = path.resolve(process.env.WEBBRAIN_QUALITY_EXTENSION_SOURCE || 'src/chrome');
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
  || 'ci/artifacts/quality-audit-2026-10-12/ask-completion-churn-mv3');
await fs.mkdir(out, { recursive: true });
const tempRoot = await fs.realpath(os.tmpdir());
const installRoot = await fs.mkdtemp(path.join(tempRoot, 'webbrain-owned-ask-churn-'));
const extension = path.join(installRoot, 'extension');
await fs.cp(source, extension, { recursive: true });
const sha = value => createHash('sha256').update(value).digest('hex');
async function sourceHashes(dir = extension, prefix = '') {
  const hashes = {};
  for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + item.name, absolute = path.join(dir, item.name);
    if (item.isDirectory()) Object.assign(hashes, await sourceHashes(absolute, name + '/'));
    else if (item.isFile()) hashes[name] = sha(await fs.readFile(absolute));
  }
  return hashes;
}
const installedBefore = await sourceHashes();
await fs.writeFile(path.join(out, 'installed-source-before.json'), JSON.stringify(installedBefore, null, 2));
const textContent = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n') : '';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, description, ms = 45000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description + ' timed out.')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
const cases = [
  { id: 'greeting-done', marker: 'Owned Ask case greeting-done.', action: 'chat', terminalTool: true,
    task: 'Owned Ask case greeting-done. Say hello using only this message.', answer: 'Hello! OWNED-ASK-GREETING-DONE' },
  { id: 'greeting-stream', marker: 'Owned Ask case greeting-stream.', action: 'chat_stream', terminalTool: false,
    task: 'Owned Ask case greeting-stream. Say hello using only this message.', answer: 'Hello! OWNED-ASK-GREETING-STREAM' },
  { id: 'draft-correction', marker: 'Owned Ask case draft-correction.', action: 'chat', terminalTool: false,
    task: 'Owned Ask case draft-correction. Post this update: our private fixture has a read-only Ask agent. If Ask cannot post, provide a draft from these supplied facts and do not claim publication.',
    answer: 'Ask cannot post. Draft: Our private fixture has a read-only Ask agent. OLD-DRAFT-MUST-NOT-DELIVER',
    correction: 'Replace that draft with exactly: Draft: The corrected private fixture remains read-only. OWNED-ASK-CORRECTED-DRAFT. Use only these supplied facts. Do not post or claim publication.',
    correctedAnswer: 'Draft: The corrected private fixture remains read-only. OWNED-ASK-CORRECTED-DRAFT.' },
  { id: 'dependent-status', marker: 'Owned Ask case dependent-status.', action: 'chat', terminalTool: false, dependent: true,
    task: 'Owned Ask case dependent-status. Report the current live status in the embedded child document. The answer must describe the current iframe, not a historical snapshot.',
    answer: 'The iframe is currently ready. OWNED-ASK-DEPENDENT-STATUS-MUST-NOT-DELIVER' },
].map(entry => ({ ...entry, calls: [], mainReached: deferred(), releaseMain: deferred(),
  scopeReached: deferred(), releaseScope: deferred() }));
const network = [], mutations = [], runtimeErrors = [], pageRequests = [], connectionProbes = [];
const frameHtml = url => {
  const escaped = JSON.stringify(url.searchParams.get('case') || 'unknown');
  const navigationDelay = cases.find(entry => entry.id === url.searchParams.get('case'))?.dependent ? 200 : 350;
  const navigate = !url.searchParams.has('navigated')
    ? `setTimeout(()=>location.replace('/frame?case='+encodeURIComponent(${escaped})+'&epoch='+encodeURIComponent(${JSON.stringify(url.searchParams.get('epoch'))})+'&navigated=1'),${navigationDelay});` : '';
  return `<!doctype html><meta charset="utf-8"><title>Owned changing child document</title>
<style>body{font:16px sans-serif}</style><h2>Owned background child</h2><span id="tick">0</span>
<script>let tick=0;setInterval(()=>{document.querySelector('#tick').textContent=String(++tick);parent.postMessage({owned:'tick',case:${escaped}},location.origin);},240);${navigate}</script>`;
};
const pageHtml = caseId => `<!doctype html><meta charset="utf-8"><title>Owned Ask iframe churn fixture</title>
<style>body{font:18px sans-serif;margin:24px}iframe{width:600px;height:180px;border:1px solid #888}textarea{display:block;width:580px;height:50px;margin:14px 0}</style>
<h1>Owned read-only Ask completion fixture</h1><p>Background frames replace their documents while the assistant replies.</p>
<div id="frame-container"><iframe title="Owned background child" src="/frame?case=${caseId}&epoch=initial&navigated=1"></iframe></div>
<textarea id="draft" aria-label="Mutation sentinel"></textarea><button id="publish">Publish sentinel</button>
<script>
window.ownedStats={childTicks:0,replacements:0,mutations:0};let churnTimer;
addEventListener('message',event=>{if(event.origin===location.origin&&event.data?.owned==='tick')ownedStats.childTicks++;});
const mutation=()=>{ownedStats.mutations++;fetch('/forbidden-mutation',{method:'POST'});};
document.querySelector('#draft').addEventListener('input',mutation);document.querySelector('#publish').onclick=mutation;
window.startOwnedChurn=()=>{const replace=()=>{const frame=document.createElement('iframe');frame.title='Owned background child';frame.src='/frame?case=${caseId}&epoch='+String(++ownedStats.replacements);document.querySelector('#frame-container').replaceChildren(frame);};replace();churnTimer=setInterval(replace,${cases.find(entry => entry.id === caseId)?.dependent ? 700 : 2200});};
window.stopOwnedChurn=()=>clearInterval(churnTimer);
</script>`;

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://owned.local');
    if (url.pathname === '/forbidden-mutation') {
      mutations.push({ method: request.method, at: Date.now() }); response.writeHead(200); response.end('unexpected mutation'); return;
    }
    if (url.pathname === '/page' || url.pathname === '/frame') {
      assert.equal(request.method, 'GET');
      pageRequests.push({ path: url.pathname, case: url.searchParams.get('case'), epoch: url.searchParams.get('epoch'),
        navigated: url.searchParams.has('navigated'), at: Date.now() });
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(url.pathname === '/page' ? pageHtml(url.searchParams.get('case')) : frameHtml(url)); return;
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    assert.equal(url.pathname, '/v1/chat/completions', 'Only owned pages and provider endpoints are available.');
    assert.equal(request.method, 'POST');
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), system = textContent(input.messages[0]?.content);
    // The real sidepanel performs BaseProvider.testConnection on startup.
    // Handle its exact isolated health request without classifying it as a task.
    if (input.messages?.length === 1 && input.messages[0].role === 'user'
        && input.messages[0].content === 'Hi' && !input.tools?.length) {
      connectionProbes.push({ at: Date.now(), model: input.model });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: 'owned-connection-probe', choices: [{
        message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 } })); return;
    }
    const authority = JSON.stringify(input.messages);
    const matches = cases.filter(entry => authority.includes(entry.marker));
    assert.equal(matches.length, 1, 'Each inference retains exactly one authentic case.');
    const entry = matches[0];
    const stage = system.startsWith('You classify whether one proposed terminal WebBrain Ask answer') ? 'scope'
      : system.startsWith('You classify whether a WebBrain Ask-mode answer') ? 'handoff' : 'main';
    const record = { stage, at: Date.now(), stream: input.stream === true,
      advertisedTools: (input.tools || []).map(tool => tool.function?.name) };
    entry.calls.push(record);
    let message;
    if (stage === 'scope') {
      assert.equal(input.tools, undefined, 'Dependency classification cannot authorize or request a browser tool.');
      const data = JSON.parse(textContent(input.messages.at(-1).content));
      record.task = data.user_request; record.answer = data.candidate_answer;
      assert.ok(data.user_request.includes(entry.marker));
      const expected = [entry.answer, entry.correctedAnswer].filter(Boolean);
      assert.ok(expected.includes(data.candidate_answer), 'The classifier must receive the exact owned terminal candidate.');
      if (entry.calls.filter(call => call.stage === 'scope').length === 1) {
        entry.scopeReached.resolve(record); await entry.releaseScope.promise;
      }
      record.pageIndependent = !entry.dependent;
      message = { role: 'assistant', content: JSON.stringify({ pageIndependent: !entry.dependent }) };
    } else if (stage === 'handoff') {
      record.modeHandoff = 'none'; message = { role: 'assistant', content: '{"mode_handoff":"none"}' };
    } else {
      const count = entry.calls.filter(call => call.stage === 'main').length;
      assert.ok(count <= (entry.dependent ? 5 : entry.correction ? 2 : 1), 'Iframe churn must not consume unbounded main model turns.');
      const corrected = entry.correction && input.messages.some(item => item.role === 'user'
        && textContent(item.content).includes(entry.correction));
      record.corrected = !!corrected;
      const answer = corrected ? entry.correctedAnswer : entry.answer;
      if (count === 1) { entry.mainReached.resolve(record); await entry.releaseMain.promise; }
      else await delay(700); // Receive further genuine child DOM feedback before the corrected answer returns.
      record.answer = answer;
      message = entry.terminalTool ? { role: 'assistant', content: '', tool_calls: [{ id: `owned-${entry.id}-done`,
        type: 'function', function: { name: 'done', arguments: JSON.stringify({ summary: answer }) } }] }
        : { role: 'assistant', content: answer };
    }
    record.responseTools = (message.tool_calls || []).map(call => call.function.name);
    record.finishedAt = Date.now();
    if (input.stream) {
      assert.equal(message.tool_calls, undefined, 'The streaming case supplies genuine prose.');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const content = message.content, half = Math.floor(content.length / 2);
      for (const part of [content.slice(0, half), content.slice(half)]) {
        response.write('data: ' + JSON.stringify({ id: `owned-${entry.id}`, choices: [{ index: 0,
          delta: { content: part }, finish_reason: null }] }) + '\n\n'); await delay(25);
      }
      response.write('data: ' + JSON.stringify({ id: `owned-${entry.id}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 30 } }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: `owned-${entry.id}`, choices: [{ message,
        finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
    }
  } catch (error) {
    runtimeErrors.push(error.message);
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context, panel, worker;
const results = [], startedAt = Date.now();
const messageFrom = (page, action, data = {}) => page.evaluate(({ action, data }) =>
  chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
try {
  context = await chromium.launchPersistentContext(path.join(installRoot, 'profile'), { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking', '--disable-sync'] });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' || url.origin === origin) return route.continue();
    network.push({ host: url.hostname, method: route.request().method() }); return route.abort();
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
  const extensionId = new URL(worker.url()).host;
  const settings = await context.newPage(); await settings.goto(`chrome-extension://${extensionId}/src/ui/settings.html`);
  await settings.evaluate(async () => chrome.storage.local.set({ helpImproveWebBrain: false, userMemoryEnabled: false,
    planBeforeActMode: 'off', planBeforeAct: false, planReviewMode: 'never', screenshotFallback: false,
    autoScreenshot: 'off', maxAgentSteps: 6, systemOneEnabled: false, tracingEnabled: true,
    losslessTrace: true, agentAllowLocalNetwork: true, askBeforeConsequentialActions: false,
    openaiAskStreamingEnabled: false, contextWindowMode: 'full' }));
  assert.equal((await messageFrom(settings, 'update_provider', { providerId: 'openrouter', config: {
    apiKey: 'owned-loopback-fake-key', baseUrl: `${origin}/v1`, model: 'openai/gpt-5.4-mini',
    contextWindow: 128000, enabled: true, supportsAskStreaming: true, supportsVision: false, visionMode: 'off',
  } })).ok, true);
  assert.equal((await messageFrom(settings, 'set_active_provider', { providerId: 'openrouter' })).ok, true);
  await worker.evaluate(() => {
    globalThis.ownedAskProbe = { feedback: [], registrations: [], navigation: [] };
    // Observe real messages/events without replacing an API or response.
    chrome.runtime.onMessage.addListener((message, sender) => {
      const record = { tabId: sender.tab?.id, frameId: sender.frameId, documentId: sender.documentId, at: Date.now() };
      if (message.action === 'page_feedback') ownedAskProbe.feedback.push({ ...record,
        kind: message.feedback?.kind, source: message.feedback?.source });
      if (message.action === 'get_page_monitor_state') ownedAskProbe.registrations.push(record);
    });
    chrome.webNavigation.onCommitted.addListener(details => {
      if (details.url.startsWith('http://127.0.0.1:')) ownedAskProbe.navigation.push({ tabId: details.tabId,
        frameId: details.frameId, documentId: details.documentId, at: Date.now() });
    });
  });
  panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/src/ui/sidepanel.html`);
  await panel.evaluate(() => {
    window.ownedRuns = {}; window.ownedEvents = [];
    chrome.runtime.onMessage.addListener(event => {
      if (event.action === 'agent_update' || event.action === 'run_complete') ownedEvents.push(event);
    });
  });
  for (const entry of cases) {
    console.log(`Running installed Ask case ${entry.id}`);
    const page = await context.newPage(), requestId = `owned-ask-churn-${entry.id}`;
    await page.goto(`${origin}/page?case=${entry.id}`);
    const tabId = await settings.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
    assert.ok(tabId);
    await panel.evaluate(({ action, requestId, tabId, task }) => {
      ownedRuns[requestId] = { finished: false };
      chrome.runtime.sendMessage({ target: 'background', action, requestId, tabId, text: task, mode: 'ask', locale: 'en' })
        .then(result => { ownedRuns[requestId] = { finished: true, result }; })
        .catch(error => { ownedRuns[requestId] = { finished: true, error: error.message }; });
    }, { action: entry.action, requestId, tabId, task: entry.task });
    await bounded(entry.mainReached.promise, entry.id + ' first main inference');
    await page.evaluate(() => startOwnedChurn());
    await page.waitForFunction(() => ownedStats.childTicks >= 8 && ownedStats.replacements >= 2, null, { timeout: 12000 });
    entry.releaseMain.resolve();
    await bounded(entry.scopeReached.promise, entry.id + ' dependency inference');
    const scopeStartStats = await page.evaluate(() => ({ ...ownedStats }));
    await page.waitForFunction(before => ownedStats.replacements > before.replacements && ownedStats.childTicks > before.childTicks,
      scopeStartStats, { timeout: 12000 });
    // Allow the replacement document's genuine navigation and monitor to run.
    await delay(600);
    let steering = null;
    if (entry.correction) {
      steering = await messageFrom(panel, 'chat_steer', { tabId, requestId,
        messageId: `owned-${entry.id}-revision-1`, text: entry.correction });
      assert.equal(steering.accepted, true, JSON.stringify(steering));
    }
    entry.releaseScope.resolve();
    await panel.waitForFunction(id => ownedRuns[id]?.finished, requestId, { timeout: 45000 });
    const delivered = await panel.evaluate(id => ({ run: ownedRuns[id], events: ownedEvents.filter(event => event.requestId === id) }), requestId);
    const current = await messageFrom(panel, 'agent_run_state', { tabId, requestId });
    const stored = await panel.evaluate(async tabId => {
      const entries = await chrome.storage.session.get([`runUi:${tabId}`, `agentConv:${tabId}`]);
      return { runUi: entries[`runUi:${tabId}`], conversation: entries[`agentConv:${tabId}`] };
    }, tabId);
    const descriptor = await messageFrom(panel, 'export_traces', { tabId, full: true });
    assert.equal(descriptor.ok, true); assert.ok(descriptor.sessionId);
    const traced = await panel.evaluate(async ({ sessionId, extensionId }) => {
      const recorder = await import(`chrome-extension://${extensionId}/src/trace/recorder.js`);
      const runs = await recorder.listRuns({ conversationId: sessionId });
      return await Promise.all(runs.map(async run => ({ run, events: await recorder.getRunEvents(run.runId) })));
    }, { sessionId: descriptor.sessionId, extensionId });
    const probe = await worker.evaluate(tabId => Object.fromEntries(Object.entries(ownedAskProbe)
      .map(([key, records]) => [key, records.filter(record => record.tabId === tabId)])), tabId);
    const stats = await page.evaluate(() => ({ ...ownedStats, draft: document.querySelector('#draft').value }));
    await page.evaluate(() => stopOwnedChurn());
    const expected = entry.correctedAnswer || entry.answer, main = entry.calls.filter(call => call.stage === 'main'),
      scope = entry.calls.filter(call => call.stage === 'scope');
    const traceEvents = traced.flatMap(trace => trace.events);
    const decisions = traceEvents.filter(event => event.kind === 'note' && event.data?.note === 'page_feedback_decision')
      .map(event => event.data.extra);
    const result = { id: entry.id, requestId, tabId, expected, delivered, current, stored, calls: entry.calls,
      steering, stats, probe, decisions, traces: traced, traceRecorded: traced.length > 0, passed: false };
    results.push(result);
    await fs.writeFile(path.join(out, `${entry.id}-evidence.json`), JSON.stringify(result, null, 2));
    assert.equal(delivered.run.error, undefined);
    assert.equal(current.running, false);
    if (entry.dependent) {
      assert.notEqual(delivered.run.result?.content, expected, 'Live-page answer cannot borrow conversation-only retention.');
      assert.match(delivered.run.result?.content || '', /page kept changing|page keeps changing|incomplete/i);
      assert.equal(current.runUi?.runSucceeded, false);
      assert.ok(main.length >= 1 && main.length <= 5); assert.ok(scope.length >= 1 && scope.length <= 5);
      assert.equal(decisions.some(decision => decision.reason === 'page_independent_answer'), false);
      assert.ok(decisions.some(decision => decision.streak >= 5), 'Dependent churn must consume a bounded rejection budget.');
      assert.equal((stored.conversation?.messages || []).filter(message => message.role === 'assistant')
        .some(message => textContent(message.content).includes(entry.answer)), false);
    } else {
      assert.equal(delivered.run.result?.content, expected);
      assert.equal(current.runUi?.status, 'completed');
      assert.equal(current.runUi?.finalContent, expected); assert.equal(current.runUi?.runSucceeded, true);
      assert.equal(main.length, entry.correction ? 2 : 1);
      assert.ok(scope.length >= 1 && scope.length <= (entry.correction ? 2 : 1));
    }
    if (entry.action === 'chat_stream') assert.equal(main[0].stream, true, 'Prose must traverse the real streaming provider.');
    const tools = delivered.run.result?.updates?.filter(event => event.type === 'tool_call').map(event => event.data?.name) || [];
    assert.deepEqual(tools.filter(name => name !== 'auto_screenshot'), entry.terminalTool ? ['done'] : [],
      'Only the requested terminal and automatic read-only enrichment may execute.');
    assert.equal(stats.mutations, 0); assert.equal(stats.draft, '');
    assert.ok(stats.childTicks > 8 && stats.replacements >= 3);
    const descendantDocs = new Set(probe.navigation.filter(record => record.frameId > 0).map(record => record.documentId));
    assert.ok(descendantDocs.size >= 4, 'Multiple real child document commits must occur during inference.');
    assert.ok(probe.feedback.some(record => record.frameId > 0 && record.kind === 'dom' && record.source === 'page'),
      'Churn must reach the installed background from a genuine child monitor.');
    // Some existing chat_stream Ask entrypoints do not create a trace run.
    // Require trace proof wherever present; the SSE/monitor/delivery checks
    // independently exercise the installed streaming dependency path.
    if (!entry.dependent && (traced.length || entry.action !== 'chat_stream')) {
      assert.ok(decisions.some(decision => decision.disposition === 'retained' && decision.reason === 'page_independent_answer'),
        'The installed dependency policy must retain the terminal reply.');
      assert.ok(decisions.some(decision => (entry.correction
        ? decision.context?.feedback?.observed?.events : decision.feedback?.events)
        ?.some(event => event.frameId > 0 && event.kind === 'navigation')),
        'A source-backed descendant navigation must reach the normal response decision.');
    }
    assert.equal(traceEvents.some(event => event.kind === 'tool' && event.data?.name !== 'done'), false);
    assert.equal(entry.calls.some(call => call.stage === 'handoff' && call.modeHandoff !== 'none'), false);
    if (entry.correction) {
      assert.equal(main[0].corrected, false); assert.equal(main[1].corrected, true);
      const assistant = (stored.conversation?.messages || []).filter(message => message.role === 'assistant');
      assert.equal(assistant.some(message => textContent(message.content).includes('OLD-DRAFT-MUST-NOT-DELIVER')), false);
      const display = delivered.events.filter(event => event.type === 'text').map(event => event.data?.content || '');
      assert.equal(display.some(value => value.includes('OLD-DRAFT-MUST-NOT-DELIVER')), false);
      assert.equal((stored.conversation?.messages || []).filter(message => message.webbrainSteering).length, 1);
      assert.equal(delivered.events.filter(event => event.type === 'steering_applied').length, 1);
    }
    result.passed = true;
    await fs.writeFile(path.join(out, `${entry.id}-evidence.json`), JSON.stringify(result, null, 2));
    await page.close();
  }
  assert.equal(mutations.length, 0); assert.equal(runtimeErrors.length, 0);
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, stack: error.stack,
    cases: cases.map(({ id, calls }) => ({ id, calls })), results, runtimeErrors,
    liveRuns: panel ? await panel.evaluate(() => ({ runs: ownedRuns, events: ownedEvents })).catch(() => null) : null,
    probe: worker ? await worker.evaluate(() => ownedAskProbe).catch(() => null) : null }, null, 2));
  throw error;
} finally {
  for (const entry of cases) { entry.releaseMain.resolve(); entry.releaseScope.resolve(); }
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  const installedAfter = await sourceHashes();
  const changed = Object.keys(installedBefore).filter(name => installedBefore[name] !== installedAfter[name]);
  await fs.writeFile(path.join(out, 'installed-source-verification.json'), JSON.stringify({
    source, copiedInstall: true, sourceCount: Object.keys(installedBefore).length, sourceStable: changed.length === 0, changed }, null, 2));
  const resolved = await fs.realpath(installRoot);
  assert.equal(path.dirname(resolved).toLowerCase(), tempRoot.toLowerCase());
  assert.ok(path.basename(resolved).startsWith('webbrain-owned-ask-churn-'));
  await fs.rm(resolved, { recursive: true, force: true });
  assert.equal(changed.length, 0, 'The installed product source must remain unmodified.');
}
const summary = { passed: true, durationMs: Date.now() - startedAt, installedSourceStable: true, mutations: mutations.length,
  cases: results.map(result => ({ id: result.id, mainCalls: result.calls.filter(call => call.stage === 'main').length,
    scopeCalls: result.calls.filter(call => call.stage === 'scope').length, childTicks: result.stats.childTicks,
    replacements: result.stats.replacements, corrected: !!result.steering, traceRecorded: result.traceRecorded, passed: result.passed })),
  blockedNetwork: network, connectionProbes, pageRequests, artifactPath: out };
await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
await fs.rm(path.join(out, 'failure.json'), { force: true });
console.log(JSON.stringify(summary));
