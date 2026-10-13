import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { conformFixtureCompletionCall } from './completion-provider-contract.mjs';

// A requested Remove on an ordinary cart row (no permalink) runs through the
// installed MV3 extension: real probe, guards, dispatch and completion gates,
// once directly and once through a confirmation dialog. The provider and the
// site are owned local fixtures; nothing leaves the host.
const pageUrl = 'https://shop.example/cart';
const task = 'Remove the Wool socks from my cart. Keep everything else.';
const intent = { request_kind: 'execute', scope_relation: 'new', requires_state_change: true,
  requires_submission: true, messaging: null, deliverables: ['The Wool socks are removed from the cart.'],
  allows_planner_shaped_result: false, allows_app_state_tool_evidence: false,
  completion_requirements: { download: false }, read_scope: 'visible_page',
  summary: 'Remove only the Wool socks cart row.', steps: [{ id: '1', action: 'Remove the Wool socks row and verify it is gone.' }],
  memory: { use_progress_ledger: false, progress_action: null }, scheduling: null, risks: [] };
for (const confirmation of [false, true]) await runVariant(confirmation);

async function runVariant(confirmation) {
  const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS
    || `ci/artifacts/quality-audit-2026-10-07/unbound-deletion-mv3/${confirmation ? 'confirmation' : 'direct'}`);
  await fs.mkdir(out, { recursive: true });
  let actionCalls = 0, judgeCalls = 0, blockedRemote = 0;
  const completionRecovery = { reads: 0 };
  const deletes = [], providerRequests = [], authorizations = [];
  const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : '';
  const refFor = (input, name) => {
    for (const message of [...input.messages].reverse()) {
      if (message.role !== 'tool') continue;
      let data; try { data = JSON.parse(textOf(message.content)); } catch {
        const content = textOf(message.content), start = content.indexOf('{');
        try { data = JSON.parse(content.slice(start, content.lastIndexOf('}') + 1)); } catch { continue; }
      }
      const line = String(data.pageContent || '').split('\n').find(line => line.includes(`button "${name}"`));
      const ref = line?.match(/\[(ref_\d+)\]/)?.[1];
      if (ref) return ref;
    }
    throw new Error(`Owned fixture did not observe ${name}`);
  };
  const steps = confirmation
    ? [['tree'], ['click', 'Remove Wool socks'], ['tree'], ['click', 'Confirm removal'], ['tree'], ['done']]
    : [['tree'], ['click', 'Remove Wool socks'], ['tree'], ['done']];
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const input = JSON.parse(raw); providerRequests.push(input);
    const system = textOf(input.messages?.[0]?.content);
    let completion;
    if (system.startsWith('Evaluate only the observable requirements of the genuine user task')) {
      judgeCalls++;
      completion = { role: 'assistant', content: JSON.stringify({ outcome: 'succeeded',
        reason: 'The Wool socks row is no longer in the fresh cart observation and the Hat row remains.' }) };
    } else if (system.startsWith('Check one separately proposed consequential action')) {
      const untrusted = textOf(input.messages.at(-1).content);
      const proposed = JSON.parse(untrusted.slice(untrusted.indexOf('{'), untrusted.lastIndexOf('}') + 1));
      const authority = JSON.parse(textOf(input.messages[1].content));
      authorizations.push({ resource: proposed.resource, latest: authority.latestAcceptedRequest });
      completion = { role: 'assistant', content: JSON.stringify({ key: proposed.key,
        authorized: proposed.action === 'delete' && proposed.resource?.kind === 'record'
          && /Wool socks/.test(proposed.resource.text) && authority.latestAcceptedRequest === task,
        latestRequestEvidence: 'Remove the Wool socks from my cart.' }) };
    } else if (!input.tools?.length) completion = { role: 'assistant', content: JSON.stringify(intent) };
    else {
      const step = actionCalls++;
      const [kind, name] = steps[Math.min(step, steps.length - 1)];
      const call = kind === 'click' ? { name: 'click_ax', args: { ref_id: refFor(input, name) } }
        : kind === 'done' ? { name: 'done', args: { outcome: 'success', summary: 'Removed the Wool socks from the cart once; the Hat remains.' } }
        : { name: 'get_accessibility_tree', args: { filter: 'all' } };
      const emitted = conformFixtureCompletionCall(input, call, completionRecovery);
      completion = { role: 'assistant', content: '', tool_calls: [{ id: `owned-unbound-${step}`, type: 'function',
        function: { name: emitted.name, arguments: JSON.stringify(emitted.args) } }] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: `response-${providerRequests.length}`, choices: [{ message: completion,
      finish_reason: completion.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 30 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pageBody = `<!doctype html><meta charset="utf-8"><title>Owned cart fixture</title>
  <style>body{font:18px sans-serif;margin:25px}li{margin:12px}button{padding:8px}[role=dialog]{position:fixed;inset:120px 250px;background:white;border:2px solid black;padding:30px}</style>
  <main><h1>Your cart</h1><ul id="cart"><li data-id="1">Wool socks, size L, $12 <button type="button" aria-label="Remove Wool socks">Remove</button></li>
  <li data-id="2">Hat, size M, $20 <button type="button" aria-label="Remove Hat">Remove</button></li></ul></main><div id="modal"></div>
  <script>
  const remove = async row => { const r = await fetch('/api/cart/items/' + row.dataset.id, { method: 'DELETE' }); if (r.ok) row.remove(); };
  for (const button of document.querySelectorAll('#cart button')) button.onclick = () => {
    const row = button.closest('li');
    if (!${confirmation}) return remove(row);
    document.querySelector('#modal').innerHTML = '<div role="dialog" aria-modal="true" aria-label="Remove item"><p>Remove this item from your cart?</p><button type="button" id="cancel">Cancel</button><button type="button" id="confirm" aria-label="Confirm removal">Remove</button></div>';
    document.querySelector('#cancel').onclick = () => document.querySelector('#modal').replaceChildren();
    document.querySelector('#confirm').onclick = async () => { await remove(row); document.querySelector('#modal').replaceChildren(); };
  };
  </script>`;
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-unbound-delete-mv3-'));
  let context;
  try {
    const extension = path.join(profile, 'extension'); await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
    await fs.appendFile(path.join(extension, 'src/background.js'), `
  globalThis.unboundFixtureAgent = agent;
  globalThis.unboundFixtureReceipts = [];
  const recordOwnedUnboundReceipt = agent._recordCompletionSubmitAttempt;
  agent._recordCompletionSubmitAttempt = function (...args) {
    const receipt = recordOwnedUnboundReceipt.apply(this, args);
    if (receipt) unboundFixtureReceipts.push({ mutationKind: receipt.mutationKind, stage: receipt.actionRecord?.stage || null,
      footprint: receipt.actionRecord?.footprint || null, text: receipt.actionRecord?.text ?? null, resourceUrl: receipt.actionResource?.url || null });
    return receipt;
  };
  `);
    context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    await context.route('**/*', async route => {
      const request = route.request(), requested = new URL(request.url());
      if (requested.hostname === '127.0.0.1' && requested.port === String(server.address().port)) return route.continue();
      if (requested.origin === 'https://shop.example') {
        if (/^\/api\/cart\/items\/\d+$/.test(requested.pathname) && request.method() === 'DELETE') {
          deletes.push({ method: request.method(), path: requested.pathname });
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        }
        if (request.isNavigationRequest() && requested.href === pageUrl) return route.fulfill({ contentType: 'text/html', body: pageBody });
        return route.fulfill({ status: 404, body: '' });
      }
      if (/^https?:$/.test(requested.protocol)) { blockedRemote++; return route.abort('blockedbyclient'); }
      return route.continue();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const harness = await context.newPage(); await harness.goto(`chrome-extension://${new URL(worker.url()).host}/src/ui/settings.html`);
    const message = (action, data = {}) => harness.evaluate(({ action, data }) => chrome.runtime.sendMessage({ target: 'background', action, ...data }), { action, data });
    await harness.evaluate(() => chrome.storage.local.set({ helpImproveWebBrain: false, tracingEnabled: false,
      autoScreenshot: false, screenshotFallback: false, planBeforeActMode: 'off', planBeforeAct: false,
      planReviewMode: 'never', maxAgentSteps: 14, systemOneEnabled: false, agentAllowLocalNetwork: true,
      askBeforeConsequentialActions: false, openaiAskStreamingEnabled: false }));
    assert.equal((await message('update_provider', { providerId: 'openrouter', config: { apiKey: 'owned-fixture-fake-key',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'minimax/minimax-m3', enabled: true,
      contextWindow: 1000000, supportsAskStreaming: false } })).ok, true);
    assert.equal((await message('set_active_provider', { providerId: 'openrouter' })).ok, true);
    const page = await context.newPage(); await page.goto(pageUrl);
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, pageUrl);
    const result = await message('chat', { tabId, text: task, mode: 'act', requestId: 'owned-unbound-deletion', locale: 'en' });
    const diagnostic = await worker.evaluate(tabId => ({ submit: unboundFixtureAgent._completionSubmitStates.get(tabId),
      dispatches: unboundFixtureAgent._planExecutionGuards.get(tabId)?.resourceMutationDispatches || [],
      receipts: unboundFixtureReceipts }), tabId);
    const toolResults = result.updates.filter(event => event.type === 'tool_result').map(event => ({ name: event.data?.name,
      blocked: event.data?.result?.blocked === true, reason: event.data?.result?.actionGuard?.reason || null, error: event.data?.result?.error || null }));
    await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify({ result, diagnostic, deletes, judgeCalls, authorizations,
      toolResults, blockedRemote }, (_key, value) => typeof value === 'string' && value.startsWith('data:image/') ? '[owned fixture screenshot omitted]' : value, 2));
    assert.deepEqual(deletes, [{ method: 'DELETE', path: '/api/cart/items/1' }], `Only the named row is removed, once: ${JSON.stringify(toolResults)}`);
    assert.deepEqual(diagnostic.receipts.map(receipt => receipt.stage), confirmation ? ['record', 'confirmation'] : ['record']);
    // Receipts keep the record's identity, never its row text.
    assert.ok(diagnostic.receipts.every(receipt => receipt.mutationKind === 'delete' && receipt.resourceUrl === null
      && /^[0-9a-f]{64}$/.test(receipt.footprint) && receipt.text === null));
    assert.equal(new Set(diagnostic.receipts.map(receipt => receipt.footprint)).size, 1, 'The confirmation belongs to the same record');
    assert.equal(authorizations.length, confirmation ? 2 : 1);
    if (confirmation) assert.match(authorizations[1].resource.confirmationDialog, /Remove this item from your cart\?/);
    assert.equal(await page.locator('#cart li').count(), 1);
    assert.match(await page.locator('#cart').innerText(), /Hat/);
    const done = result.updates.findLast(event => event.type === 'tool_result' && event.data?.name === 'done')?.data?.result;
    assert.equal(done?.done, true, JSON.stringify(done));
    assert.equal(done?.outcome, 'success', JSON.stringify(done));
    assert.ok(judgeCalls > 0);
    console.log(JSON.stringify({ passed: true, installedMV3: true, confirmation, deletes: deletes.length,
      receipts: diagnostic.receipts.length, authorizations: authorizations.length, judgeCalls, blockedRemote }));
  } finally {
    await context?.close(); await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(profile);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-unbound-delete-mv3-')) throw new Error('Unexpected temporary profile path.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
