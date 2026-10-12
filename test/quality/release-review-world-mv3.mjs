import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// The copied extension only exposes its production classes to the owned lab.
// Browser APIs, manifest content scripts, AX registry and capture are real.
// Every HTTP request is fulfilled here; offline mode and DNS denial also cover
// worker/background requests that Playwright routing cannot intercept.
const out = path.resolve(process.env.WEBBRAIN_QUALITY_ARTIFACTS || 'ci/artifacts/release-review-world-mv3');
await fs.mkdir(out, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webbrain-release-review-world-'));
const extension = path.join(profile, 'product');
const formUrl = 'https://github.com/owned/release-world-fixture/releases/new';
const notes = '## Owned changes\n\n* Preserve **complete Markdown**.\n\n' + 'Owned reviewed notes. '.repeat(80);
const html = `<!doctype html><meta charset="utf-8"><title>Owned release review</title>
<form method="post" action="/owned/release-world-fixture/releases">
<input type="hidden" name="tag_name" value="v40.3.0">
<label for="release-title">Release title</label><input id="release-title" name="release[name]" value="40.3.0">
<label for="release-body">Release notes</label><textarea id="release-body" name="release[body]">${notes}</textarea>
<button id="publish" type="submit">Yayımla</button></form>`;
const evidence = { installedMV3: true, requests: [], cases: [] };
let context;
try {
  await fs.cp(path.resolve('src/chrome'), extension, { recursive: true });
  evidence.productionSourceSha256 = {};
  for (const relative of ['src/agent/agent.js', 'src/content/accessibility-tree.js']) {
    const source = await fs.readFile(path.resolve('src/chrome', relative));
    const installed = await fs.readFile(path.join(extension, relative));
    assert.deepEqual(installed, source, 'The installed lab uses unchanged production agent and AX source.');
    evidence.productionSourceSha256[relative] = createHash('sha256').update(installed).digest('hex');
  }
  await fs.appendFile(path.join(extension, 'src/background.js'), `
import { cdpClient as OwnedReleaseWorldCdp } from './cdp/cdp-client.js';
globalThis.__ownedReleaseWorld = { Agent, cdpClient: OwnedReleaseWorldCdp };
`);
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND'] });
  await context.setOffline(true);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    evidence.requests.push({ url: request.url(), method: request.method() });
    return route.fulfill(request.url() === formUrl && request.method() === 'GET'
      ? { contentType: 'text/html; charset=utf-8', body: html }
      : { status: 404, contentType: 'text/plain', body: 'Owned fixture has no such resource.' });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    const originalFetch = fetch.bind(globalThis);
    globalThis.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      return url.protocol === 'chrome-extension:' ? originalFetch(input, options)
        : Promise.reject(new Error('Owned release review lab blocks background network.'));
    };
    const { Agent } = __ownedReleaseWorld;
    const nativeExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
    __ownedReleaseWorld.transports = [];
    chrome.scripting.executeScript = async options => {
      const isCapture = options.func === Agent._githubReleaseFormSnapshot;
      __ownedReleaseWorld.transports.push({ kind: isCapture ? 'review' : options.func === Agent._submitActionProbe ? 'probe' : 'lab',
        world: options.world || 'ISOLATED', frameIds: options.target.frameIds || null });
      const result = await nativeExecuteScript(options);
      const lab = __ownedReleaseWorld;
      if (isCapture && lab.afterCapture) { const change = lab.afterCapture; lab.afterCapture = null; change(); }
      return result;
    };
  });
  const page = await context.newPage();
  await page.goto(formUrl);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, formUrl);
  assert.ok(Number.isInteger(tabId));
  const waitForAX = () => worker.evaluate(async tabId => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [probe] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
        func: () => typeof window.__wb_ax_ref });
      if (probe.result === 'function') return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  }, tabId);
  assert.equal(await waitForAX(), true, 'The installed manifest supplies the isolated AX registry.');
  evidence.worlds = await worker.evaluate(async tabId => {
    const { cdpClient } = __ownedReleaseWorld;
    await cdpClient.attach(tabId);
    const main = await cdpClient.evaluate(tabId, '({ axRef: typeof window.__wb_ax_ref, url: location.href })');
    const [isolated] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
      func: () => ({ axRef: typeof window.__wb_ax_ref, url: location.href }) });
    return { main: main.result.value, isolated: isolated.result };
  }, tabId);
  assert.deepEqual(evidence.worlds, { main: { axRef: 'undefined', url: formUrl }, isolated: { axRef: 'function', url: formUrl } });

  const setup = () => worker.evaluate(({ tabId, formUrl }) => {
    const lab = __ownedReleaseWorld, { Agent } = lab;
    lab.state = { key: 'owned-release-task', task: 'Create the owned release using its native form.', stopped: false, steering: false,
      provider: { model: 'owned-no-model', supportsVision: false, config: { category: 'local' }, chat() {} } };
    const agent = lab.agent = new Agent({ getActive: () => lab.state.provider });
    agent.useSiteAdapters = true;
    agent.conversationModes.set(tabId, 'act');
    agent._progressTaskKeyHash = () => lab.state.key;
    agent._progressTaskAnchorText = () => lab.state.task;
    agent._checkAbort = () => lab.state.stopped;
    agent._hasUnvalidatedSteering = () => lab.state.steering;
    const workflow = agent._resolvePlannerSiteWorkflow(formUrl, { request_kind: 'execute', site_job: 'publish-release' });
    agent._startPlanExecutionGuard(tabId, 'act', { requestKind: 'execute', siteWorkflow: workflow,
      siteWorkflowUrl: formUrl, requiresStateChange: true, requiresSubmission: true });
    agent._beginCompletionInvariant(tabId);
  }, { tabId, formUrl });
  await setup();
  evidence.detected = await worker.evaluate(tabId => __ownedReleaseWorld.agent._detectLikelySubmitAction(tabId, 'click', { selector: '#publish' }), tabId);
  assert.equal(evidence.detected.isSubmit, true);
  assert.equal(evidence.detected.validationSubmitEvidence, 'strong');
  assert.match(evidence.detected.formRef, /^ref_\d+$/);
  assert.equal(evidence.detected.githubReleaseReview.complete, true);
  assert.equal(evidence.detected.githubReleaseReview.formRef, evidence.detected.formRef);
  assert.equal(evidence.detected.githubReleaseReview.notes, notes);
  assert.ok(evidence.detected.summary.length < notes.length, 'The complete review is independent of shortened confirmation text.');

  for (const change of ['none', 'main-forged-helper', 'forged-main-ref', 'wrong-form', 'replaced-form', 'changed-action', 'document', 'stop', 'task', 'run', 'guard', 'provider', 'steering']) {
    await page.goto(formUrl);
    assert.equal(await waitForAX(), true);
    await setup();
    const detected = await worker.evaluate(async tabId => {
      const [entry] = await chrome.scripting.executeScript({ target: { tabId }, func: __ownedReleaseWorld.Agent._submitActionProbe,
        args: ['click', { selector: '#publish' }] });
      return { ...entry.result, frameId: entry.frameId };
    }, tabId);
    assert.match(detected.formRef, /^ref_\d+$/);
    if (change === 'wrong-form' || change === 'forged-main-ref') detected.formRef = 'ref_999999';
    if (change === 'main-forged-helper' || change === 'forged-main-ref') await page.evaluate(() => {
      window.__wb_ax_ref = () => 'ref_999999';
      window.__wb_ax_lookup = () => document.querySelector('form');
    });
    if (change === 'replaced-form') await page.locator('form').evaluate(form => form.replaceWith(form.cloneNode(true)));
    if (change === 'changed-action') await page.locator('form').evaluate(form => form.action = '/other/repository/releases');
    if (change === 'document') { await page.reload(); assert.equal(await waitForAX(), true); }
    const captured = await worker.evaluate(async ({ tabId, detected, change }) => {
      const lab = __ownedReleaseWorld, { agent, state } = lab;
      if (['stop', 'task', 'run', 'guard', 'provider', 'steering'].includes(change)) lab.afterCapture = () => {
        if (change === 'stop') state.stopped = true;
        if (change === 'task') { state.key = 'another-task'; state.task = 'Another task'; }
        if (change === 'run') agent._beginCompletionInvariant(tabId);
        if (change === 'guard') agent._planExecutionGuards.set(tabId, { ...agent._planExecutionGuards.get(tabId) });
        if (change === 'provider') state.provider = { ...state.provider };
        if (change === 'steering') state.steering = true;
      };
      return agent._captureGithubReleaseReview(tabId, detected);
    }, { tabId, detected, change });
    const expectedComplete = change === 'none' || change === 'main-forged-helper';
    assert.equal(captured.complete, expectedComplete, `${change}: ${JSON.stringify(captured)}`);
    if (expectedComplete) { assert.equal(captured.formRef, detected.formRef); assert.equal(captured.notes, notes); }
    evidence.cases.push({ change, complete: captured.complete, reason: captured.reason || null });
  }
  evidence.transports = await worker.evaluate(() => __ownedReleaseWorld.transports);
  const reviews = evidence.transports.filter(item => item.kind === 'review');
  assert.equal(reviews.length, evidence.cases.length + 1);
  assert.ok(reviews.every(item => item.world === 'ISOLATED' && JSON.stringify(item.frameIds) === '[0]'));
  assert.equal(await page.evaluate(() => typeof window.__wb_ax_ref), 'undefined');
  assert.ok(evidence.requests.length > 0);
  assert.ok(evidence.requests.every(item => item.method === 'GET'), 'Review never submits a form.');
  evidence.passed = true;
  // Keep fixture notes out of persisted artifacts; record only proof metadata.
  evidence.detected = { isSubmit: evidence.detected.isSubmit, formRef: evidence.detected.formRef,
    complete: evidence.detected.githubReleaseReview.complete, reviewedNotesLength: notes.length };
  await fs.writeFile(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, installedMV3: true, mainWorldAXAbsent: true, isolatedReview: true,
    forgedMainRegistryIgnored: true, staleBindingsRejected: evidence.cases.filter(item => !item.complete).length, serverSubmissions: 0 }));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, cases: evidence.cases }, null, 2));
  throw error;
} finally {
  await context?.close();
  if (!path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep + 'webbrain-release-review-world-')) throw new Error('Unexpected owned profile path.');
  await fs.rm(profile, { recursive: true, force: true });
}
