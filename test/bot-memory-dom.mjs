import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';

const html = `<!doctype html><html><head><title>Invoice 103</title><link rel="canonical" href="/invoices/103"></head><body>
<section data-record-id="103"><h1>Invoice 103</h1><form aria-label="Invoice 103 reminder"><textarea name="reminder">Invoice 103 is due.</textarea>
<input type="password" name="password" value="never-copy-this-password"><label for="pin">PIN</label><input id="pin" type="number" value="804911"><input aria-label="CVV" autocomplete="cc-csc" value="486"><input name="api_key" value="never-copy-this-api-key"><input name="access-token" value="never-copy-this-token"><button type="submit">Send reminder</button></form>
<p id="receipt"></p><p id="credential-echo">never-copy-this-password 804911 486 never-copy-this-api-key never-copy-this-token</p></section><script>window.sentCount=0;window.nativeClicks=[];document.querySelector("button").addEventListener("click",e=>nativeClicks.push(e.isTrusted));document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.sentCount++;document.querySelector('#receipt').textContent='Reminder sent for invoice 103. Receipt reminder-103-'+window.sentCount;});</script></body></html>`;
const nativeCallbackRequests = [];
const server = createServer(async (request, response) => {
  if (request.url === '/bot-memory/credential-fields.js') {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end(await readFile(new URL('../src/chrome/src/agent/credential-fields.js', import.meta.url))); return;
  }
  const moduleName = /^\/bot-memory\/(chrome|firefox)\.js$/.exec(request.url);
  if (moduleName) {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end(await readFile(new URL(`../src/${moduleName[1]}/src/agent/bot-memory.js`, import.meta.url)));
    return;
  }
  const workerName = /^\/memory-worker\/(chrome|firefox)\.js$/.exec(request.url);
  if (workerName) {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end(`import {BotMemorySession} from '/bot-memory/${workerName[1]}.js';
      onmessage = async event => {try {const session = new BotMemorySession(event.data.config,
        event.data.explicit ? {fetchImpl:globalThis.fetch} : {});
        postMessage(await session.call('lookup', {actionKey:'remind',target:{kind:'id',namespace:'invoice',id:'103'}}));
        await session.close();}catch(error){postMessage({error:error.message});}};`);
    return;
  }
  if (request.method === 'POST' && /^\/api\/internal\/bot-memory\/run-(chrome|firefox)$/.test(request.url)) {
    let body = ''; for await (const chunk of request) body += chunk;
    nativeCallbackRequests.push({ ...JSON.parse(body), authorization: request.headers.authorization });
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ previous: null }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
let browser;
try {
  for (const [name, engine] of [['chrome', chromium], ['firefox', firefox]]) {
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage();
    await page.context().addInitScript(() => {
      window.qaListeners = []; window.qaRun = 'owned-bot-memory-run';
      window.chrome = window.browser = { runtime: { getURL: value => value,
        onMessage: { addListener: listener => qaListeners.push(listener), removeListener() {} },
        async sendMessage(message) {
          if (message.action === 'get_page_monitor_state') return { active: true, runToken: qaRun, documentToken: message.documentToken };
          return { accepted: true };
        } } };
      window.qaMessage = (action, params = {}) => new Promise(resolve => {
        let answered = false;
        for (const listener of qaListeners) {
          const result = listener({ target: 'content', action, params: { runToken: qaRun, ...params } }, {}, value => { answered = true; resolve(value); });
          if (answered || result === true) break;
        }
      });
    });
    for (const file of ['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']) {
      await page.context().addInitScript({ content: await readFile(new URL('../src/' + name + '/src/content/' + file, import.meta.url), 'utf8') });
    }
    await page.goto(`http://127.0.0.1:${port}/invoices/103`);
    const { BotMemorySession, observeMemoryPageInPage, observeBotMemoryPage } = await import(`../src/${name}/src/agent/bot-memory.js`);
    const { Agent } = await import(`../src/${name}/src/agent/agent.js`);
    const api = { tabs: { get: async () => ({ url: page.url(), title: await page.title() }) },
      scripting: { executeScript: async ({ args }) => {
        if (page.url() === 'about:blank') throw new Error('Extension manifest must request permission to access this host');
        return [{ result: await page.evaluate(observeMemoryPageInPage, args[0]), frameId: 0 }];
      } } };
    globalThis.chrome = { ...api, storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
      runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) } };
    globalThis.browser = globalThis.chrome;
    const attempts = new Map();
    let mutateAfterAck = false;
    let requestCount = 0;
    const envelope = () => ({ version: 1, policyVersion: 1, botId: 'bot-' + name, runId: 'run-' + name,
      callbackUrl: `http://127.0.0.1:${port}/api/internal/bot-memory/run-${name}`, callbackToken: 'local-test-only-token'.repeat(3),
      policy: { schemaVersion: 1, summary: 'Send one reminder for each invoice.', timezone: 'UTC', confidence: 1,
        actions: [{ key: 'remind', label: 'Send reminder', target: 'Invoice', effect: 'write', repeat: { mode: 'unique' }, evidenceFields: ['receipt'] }] }, context: {} });
    // Exercise actual browser-native fetch in both Window and WorkerGlobalScope.
    // The Node fake callback below cannot reproduce the native receiver check.
    for (const explicit of [false, true]) {
      assert.deepEqual(await page.evaluate(async ({ name, config, explicit }) => {
        const { BotMemorySession } = await import(`/bot-memory/${name}.js`);
        const session = new BotMemorySession(config, explicit ? { fetchImpl: globalThis.fetch } : {});
        try { return await session.call('lookup', { actionKey: 'remind', target: { kind: 'id', namespace: 'invoice', id: '103' } }); }
        finally { await session.close(); }
      }, { name, config: envelope(), explicit }), { previous: null });
      assert.deepEqual(await page.evaluate(({ name, config, explicit }) => new Promise((resolve, reject) => {
        const worker = new Worker(`/memory-worker/${name}.js`, { type: 'module' });
        const timer = setTimeout(() => { worker.terminate(); reject(Error('Native worker callback timed out')); }, 5000);
        worker.onmessage = event => { clearTimeout(timer); worker.terminate(); resolve(event.data); };
        worker.onerror = () => { clearTimeout(timer); worker.terminate(); reject(Error('Native worker callback failed')); };
        worker.postMessage({ config, explicit });
      }), { name, config: envelope(), explicit }), { previous: null });
    }
    const fetchImpl = async (_url, options) => {
      const { operation, args } = JSON.parse(options.body);
      const visibleEvidence = JSON.stringify(args.observation?.elementFacts || args.evidence?.facts || {});
      for (const secret of ['never-copy-this-password', '804911', '486', 'never-copy-this-api-key', 'never-copy-this-token']) {
        assert.ok(!visibleEvidence.includes(secret), 'Callback observations never copy credential field values: ' + secret);
      }
      if (operation === 'prepare') {
        assert.equal(args.observation.elementFacts.label, 'Send reminder');
        assert.equal(args.observation.elementFacts.draftText, 'Invoice 103 is due.');
        assert.ok(args.observation.targets.some(target => target.kind === 'id' && target.id === '103'), 'Stable ID comes from actual DOM');
        if (attempts.size) return Response.json({ allowed: false, reason: 'duplicate' });
        const attempt = { id: 'attempt-' + (++requestCount), status: 'reserved', requestId: args.requestId };
        attempts.set(attempt.id, attempt);
        return Response.json({ allowed: true, reservation: { attemptId: attempt.id, requestId: args.requestId,
          actionKey: 'remind', target: args.observation.targets.find(target => target.kind === 'id' && target.id === '103') } });
      }
      if (operation === 'dispatch') {
        const attempt = attempts.get(args.attemptId); attempt.status = 'dispatched';
        if (mutateAfterAck) await page.locator('button').evaluate(node => node.setAttribute('aria-label', 'Send a different reminder'));
        return Response.json({ attempt });
      }
      if (operation === 'verify') {
        assert.match(args.evidence.facts.pageText, /Reminder sent for invoice 103/);
        assert.equal(JSON.parse(args.evidence.facts.observedTarget).id, '103', 'Read-back observes the actual DOM identity, never echoes a reservation');
        const attempt = attempts.get(args.attemptId); attempt.status = 'verified'; return Response.json({ attempt });
      }
      if (operation === 'resolve') { const attempt = attempts.get(args.attemptId); attempt.status = args.status; return Response.json({ attempt }); }
      return Response.json({ success: true });
    };
    const make = () => {
      const session = new BotMemorySession(envelope(), { fetchImpl, observe: (tab, args) => observeBotMemoryPage(tab, args, api) });
      const agent = new Agent({ getActive: () => ({ model: 'test' }) });
      agent._botMemorySessions.set(7, session);
      agent._executeToolWithLifecycle = async (_tab, tool, args) => {
        if (tool === 'navigate') { await page.goto(args.url); return { success: true }; }
        if (tool === 'click_ax') {
          const fence = await page.evaluate(async () => {
            const snapshot = window.qaOriginalSnapshot;
            const ref_id = __wb_ax_ref(document.querySelector('button'));
            const params = { operationId: 'owned-native-reminder', tool: 'click_ax', ref_id,
              expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true };
            const prepared = await qaMessage('page_monitor_prepare', params);
            if (prepared.modelBindingValid !== true) return { ready: false, prepared };
            return qaMessage('page_monitor_dispatch', { operationId: params.operationId, kind: 'click', tool: 'click_ax', ref_id });
          });
          if (!fence.ready) return { success: false, noDispatch: true, dispatched: false, pageFeedbackPending: true };
          await page.locator('button').click();
          await page.evaluate(() => qaMessage('page_monitor_finish', { operationId: 'owned-native-reminder' }));
          return { success: true, dispatched: true };
        }
        if (tool === 'read_page') return { success: true, text: await page.locator('body').innerText() };
        throw new Error('Unexpected fixture tool');
      };
      return { agent, session };
    };
    await page.goto('about:blank');
    let h = make();
    const opened = await h.agent.executeTool(7, 'navigate', { url: `http://127.0.0.1:${port}/invoices/103` });
    assert.equal(opened.success, true);
    assert.equal(attempts.size, 0, 'Initial navigation does not fabricate an action reservation');
    assert.equal(await page.evaluate(() => window.sentCount), 0);
    const capture = async () => {
      await page.waitForFunction(() => window.__wbPageMonitor?.active && window.__wb_ax_installed);
      await page.waitForTimeout(180);
      const snapshot = await page.evaluate(async () => { window.qaOriginalSnapshot = await qaMessage('page_monitor_capture_model', { includeTree: true }); return qaOriginalSnapshot; });
      assert.equal(snapshot.ready, true); return snapshot;
    };
    for (const selector of ['input[type=password]', '#pin', 'input[aria-label=CVV]', 'input[name=api_key]', 'input[name=access-token]']) {
      const observed = await page.evaluate(observeMemoryPageInPage, { selector });
      assert.equal(observed.elementFacts.credential, true, selector);
      for (const secret of ['never-copy-this-password', '804911', '486', 'never-copy-this-api-key', 'never-copy-this-token']) {
        assert.ok(!JSON.stringify(observed).includes(secret), 'Reader must redact echoed credential values: ' + selector);
      }
    }
    await capture();
    const sent = await h.agent.executeTool(7, 'click_ax', { selector: 'button' });
    assert.equal(sent.success, true);
    await h.agent.executeTool(7, 'read_page', {});
    assert.equal(h.session.pending.size, 0, 'Actual sanitized native receipt reconciles the dispatched action');
    await h.session.close();
    assert.equal(await page.evaluate(() => window.sentCount), 1);
    // A fresh browser run forgets its local session, while the app ledger still
    // recognizes the same generic invoice and blocks before another click.
    h = make();
    const repeated = await h.agent.executeTool(7, 'click_ax', { selector: 'button' });
    assert.equal(repeated.noDispatch, true);
    assert.equal(repeated.error, 'duplicate');
    assert.equal(await page.evaluate(() => window.sentCount), 1);
    assert.deepEqual(await page.evaluate(() => window.nativeClicks), [true], 'One actual browser-native trusted click');
    await h.session.close();
    // Memory acknowledges dispatch before native effects. A material page
    // change during that callback still fails the original monitor certificate.
    attempts.clear(); mutateAfterAck = true;
    await page.reload(); await capture(); h = make();
    const changed = await h.agent.executeTool(7, 'click_ax', { selector: 'button' });
    assert.equal(changed.noDispatch, true); assert.equal(changed.pageFeedbackPending, true);
    assert.equal(await page.evaluate(() => window.sentCount), 0);
    assert.deepEqual(await page.evaluate(() => window.nativeClicks), []);
    assert.equal([...attempts.values()][0].status, 'failed_before_dispatch');
    await h.session.close();
    await browser.close(); browser = null;
    console.log(`${name}: observed generic invoice, one verified reminder, repeated reminder blocked before click.`);
  }
  assert.equal(nativeCallbackRequests.length, 8, 'Each build calls native callbacks from Window and Worker with both dependency forms');
  assert.ok(nativeCallbackRequests.every(request => request.operation === 'lookup' && request.authorization === 'Bearer ' + 'local-test-only-token'.repeat(3)));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
