import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, test } from 'node:test';
import { chromium, firefox } from 'playwright';

// Every browser request is fulfilled locally. These are owned HTML fixtures,
// even though their URL exercises the real GitHub host/resource policy.
const browsers = { chrome: await chromium.launch({ headless: true }), firefox: await firefox.launch({ headless: true }) };
after(() => Promise.all(Object.values(browsers).map(browser => browser.close())));
const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: p => `extension://fixture/${p}` } };
const origin = 'https://github.com', repository = 'owned/release-fixture';
const formUrl = `${origin}/${repository}/releases/new`, savedUrl = `${origin}/${repository}/releases/tag/v40.3.0`;
const notes = '## Changes\n\n* Fixed **publication verification**.\n* ' + 'Complete reviewed notes. '.repeat(20);
const escaped = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const formHtml = fields => `<html><body><form method="post" action="/${repository}/releases">
  <input type="hidden" name="tag_name" value="${escaped(fields.tag)}">
  <input id="release-title" name="release[name]" value="${escaped(fields.title)}">
  <textarea name="release[body]">${escaped(fields.notes)}</textarea>
  <button id="publish" type="submit">Yayımla</button></form></body></html>`;
const detailHtml = h => `<html><body><main><h1>40.3.0</h1><p>Latest</p><p>v40.3.0</p><p>${h.visibility}</p>
  <div class="markdown-body"><h2>Changes</h2><ul><li>Fixed <strong>publication verification</strong>.</li></ul></div>
  <ul>${h.assets.map(name => `<li><a href="/${repository}/releases/download/v40.3.0/${escaped(name)}">${escaped(name)}</a></li>`).join('')}</ul></main></body></html>`;

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const cdp = build === 'chrome' ? (await import('../src/chrome/src/cdp/cdp-client.js')).cdpClient : null;

  const axSource = await fs.readFile(new URL(`../src/${build}/src/content/accessibility-tree.js`, import.meta.url), 'utf8');

  async function fixture({ requirements = [], resolved = true, review = true, dispatch = true, read = true, keepForm = false } = {}) {
    // Firefox rejects fulfilled routes in offline mode. All its requests are
    // fulfilled below; the local form response changes history without any
    // HTTP redirect, which would bypass interception for the redirected GET.
    const context = await browsers[build].newContext(), page = await context.newPage();
    if (build === 'chrome') await context.setOffline(true);
    const h = { key: 'owned-release-task', task: 'Create release 40.3.0 using the UI.', posts: 0, reads: 0,
      saved: { tag: 'v40.3.0', title: '40.3.0', notes }, editReads: 0, stopped: false, steering: false, duringEdit: null,
      assets: ['owned.zip'], visibility: 'Public', transports: [] };
    await context.route('**/*', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && path === `/${repository}/releases`) {
        h.posts++;
        assert.match(request.postData(), /release%5Bbody%5D=/);
        return route.fulfill({ contentType: 'text/html', body: detailHtml(h)
          + `<script>history.replaceState(null, '', ${JSON.stringify(new URL(savedUrl).pathname)});</script>` });
      }
      if (path === `/${repository}/releases/new`) return route.fulfill({ contentType: 'text/html', body: formHtml(h.saved) });
      if (path === `/${repository}/releases/edit/v40.3.0`) {
        h.editReads++;
        await h.duringEdit?.();
        return route.fulfill({ contentType: 'text/html', body: formHtml(h.saved) });
      }
      return route.fulfill({ contentType: 'text/html', body: detailHtml(h) });
    });
    await page.goto(formUrl);
    const session = build === 'chrome' ? await context.newCDPSession(page) : null;
    // Chrome content scripts own an isolated registry. CDP's default Runtime
    // evaluation stays in MAIN, so installing helpers there would hide a real
    // transport mismatch. Recreate the named isolated world after navigation.
    const evaluateContent = async (source, args = [], functionSource = false) => {
      const expression = functionSource ? `(${source})(...${JSON.stringify(args)})`
        : `(function () { return eval(${JSON.stringify(source)}); }).apply(null, ${JSON.stringify(args)})`;
      if (!session) return page.evaluate(({ axSource, expression }) => {
        (0, eval)(axSource);
        return (0, eval)(expression);
      }, { axSource, expression });
      const { frameTree } = await session.send('Page.getFrameTree');
      const { executionContextId } = await session.send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id, worldName: 'webbrain-owned-content', grantUniveralAccess: true,
      });
      for (const code of [axSource, expression]) {
        const result = await session.send('Runtime.evaluate', { expression: code, contextId: executionContextId,
          returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        if (code === expression) return result.result.value;
      }
    };
    await evaluateContent('typeof window.__wb_ax_ref');
    if (build === 'chrome') assert.equal(await page.evaluate(() => typeof window.__wb_ax_ref), 'undefined',
      'The main world must not contain the content-script AX registry.');
    const oldChrome = globalThis.chrome, oldBrowser = globalThis.browser;
    const oldCdp = cdp ? Object.fromEntries(['attach', 'sendCommand', 'evaluate'].map(key => [key, cdp[key]])) : null;
    const api = { storage: { local: area, session: area }, runtime: { getURL: p => `extension://fixture/${p}` },
      tabs: { get: async id => ({ id, url: page.url(), title: 'Owned release' }), executeScript: async (_id, { code, args = [] }) => {
        h.transports.push('tabs.executeScript');
        // Only the release form capture fails or waits; the submit probe and
        // every other script go through.
        const isCapture = code.includes(Agent._githubReleaseFormSnapshot.toString());
        if (!review && page.url() === formUrl && isCapture) throw new Error('Owned capture transport failure');
        if (page.url() === formUrl && isCapture) await h.beforeCapture?.();
        return [await evaluateContent(code, args)];
      } },
      ...(build === 'chrome' ? { scripting: { executeScript: async ({ target, world = 'ISOLATED', func, args = [] }) => {
        assert.equal(target.tabId, 51); assert.ok(!target.frameIds || target.frameIds.every(id => id === 0));
        h.transports.push(`scripting.executeScript:${world}`);
        const source = func.toString();
        const isCapture = func === Agent._githubReleaseFormSnapshot;
        if (!review && isCapture) throw new Error('Owned capture transport failure');
        if (isCapture) await h.beforeCapture?.();
        const result = world === 'MAIN' ? await page.evaluate(({ source, args }) => (0, eval)(`(${source})`)(...args), { source, args })
          : await evaluateContent(source, args, true);
        return [{ frameId: 0, result }];
      } } } : {}) };
    globalThis.chrome = globalThis.browser = api;
    if (cdp) { cdp.attach = async () => {}; cdp.sendCommand = async () => ({}); cdp.evaluate = async (_id, code) => {
      h.transports.push('cdpClient.evaluate');
      if (!review && page.url() === formUrl && code.includes(Agent._githubReleaseFormSnapshot.toString())) throw new Error('Owned capture transport failure');
      return { result: { value: await page.evaluate(code) } };
    }; }
    const provider = h.provider = { model: 'owned-offline', supportsVision: false, config: { category: 'local' }, chat() {} };
    const agent = h.agent = new Agent({ getActive: () => h.provider });
    agent.useSiteAdapters = true;
    agent.conversationModes.set(51, 'act');
    agent._progressTaskKeyHash = () => h.key;
    agent._progressTaskAnchorText = () => h.task;
    agent._currentUrl = async () => page.url();
    agent._captureViewportProbe = async () => ({ url: page.url(), title: 'Owned release', readyState: 'complete' });
    agent.systemOneContext = () => ({ isCurrent: () => !h.stopped && !h.steering && h.key === 'owned-release-task' });
    agent._checkAbort = () => h.stopped;
    agent._hasPendingSteering = agent._hasUnvalidatedSteering = () => h.steering;
    agent.recordSystemOneVerdict = () => {};
    agent._chatWithCostAllowance = async (_provider, messages, options) => {
      assert.equal(options.tools, undefined);
      assert.match(messages[0].content, /^Evaluate only the observable requirements/);
      const [, observation] = JSON.parse(messages[1].content);
      assert.match(observation.observation, /40\.3\.0/, 'The independent judge must see the locally owned release page.');
      return { content: JSON.stringify({ outcome: 'succeeded', reason: 'Owned saved release observed.' }) };
    };
    const workflow = agent._resolvePlannerSiteWorkflow(formUrl, { request_kind: 'execute', site_job: 'publish-release' });
    h.guard = agent._startPlanExecutionGuard(51, 'act', { requestKind: 'execute', siteWorkflow: workflow,
      siteWorkflowUrl: formUrl, requiresStateChange: true, requiresSubmission: true });
    h.guard.workflowMetadataRequirements = requirements;
    h.guard.workflowMetadataRequirementsResolved = resolved;
    agent._beginCompletionInvariant(51);
    h.rawProbe = async () => ({ ...await evaluateContent(Agent._submitActionProbe.toString(), ['click', { selector: '#publish' }], true), frameId: 0 });
    h.capture = detected => agent._captureGithubReleaseReview(51, detected);
    h.recordRead = async () => {
      agent._lastAxScopes.set(51, { pageUrl: page.url(), documentToken: 'owned-release-document' });
      const result = { success: true, pageUrl: page.url(), pageContent: await page.locator('body').innerText() };
      agent._recordCompletionToolResult(51, 'get_accessibility_tree', {}, result);
      return result;
    };
    if (dispatch) {
      const detected = await agent._detectLikelySubmitAction(51, 'click', { selector: '#publish' });
      assert.equal(detected?.isSubmit, true, 'The localized native submit must be detected by the actual probe.');
      assert.match(detected.formRef, /^ref_\d+$/, 'The actual probe binds the native form in its content-script registry.');
      if (review) {
        assert.equal(detected.githubReleaseReview?.complete, true);
        assert.equal(detected.githubReleaseReview.formRef, detected.formRef, 'Review and submit must use the same form registry.');
        assert.equal(detected.githubReleaseReview.notes, notes, 'Complete Markdown survives the shortened form summary.');
      } else assert.equal(detected.githubReleaseReview?.complete, false);
      await Promise.all([page.waitForURL(savedUrl), page.locator('#publish').click()]);
      const result = { success: true, dispatched: true, name: 'Yayımla', verified: true, pageUrlChanged: true,
        previousUrl: formUrl, currentUrl: savedUrl };
      agent._markPlanExecutionToolCall(51, 'click', result, { consequential: true });
      agent._recordCompletionToolResult(51, 'click', { selector: '#publish' }, result);
      h.submit = agent._recordCompletionSubmitAttempt(51, detected, 'click', { selector: '#publish' }, formUrl, savedUrl, result);
    } else if (!keepForm) await page.goto(savedUrl);
    if (read) await h.recordRead();
    agent.executeTool = async (_tab, name) => { assert.equal(name, 'get_accessibility_tree'); h.reads++; return h.recordRead(); };
    h.done = () => agent._executeToolImpl(51, 'done', { outcome: 'success', summary: 'Release 40.3.0 was published.' });
    h.close = async () => { globalThis.chrome = oldChrome; globalThis.browser = oldBrowser; if (cdp) Object.assign(cdp, oldCdp); await context.close(); };
    h.page = page;
    return h;
  }

  test(`${build}: native publish and exact saved Markdown readback certify a resolved implicit release`, async () => {
    const h = await fixture();
    try {
      const result = await h.done();
      assert.equal(result.outcome, 'success');
      assert.equal(h.posts, 1);
      assert.equal(h.editReads, 1, JSON.stringify({ result, failure: h.guard.workflowTerminalEvidenceFailure, binding: {
        identity: h.submit?.workflowBinding?.publishedResourceIdentity, task: h.submit?.workflowBinding?.publicationTaskBinding,
        review: !!h.submit?.workflowBinding?.githubReleaseReview, resolved: h.submit?.workflowBinding?.metadataRequirementsResolved,
      } }));
      assert.equal(h.guard.workflowTerminalEvidence?.source, 'dispatch_bound_published_resource');
      if (build === 'chrome') {
        assert.ok(h.transports.filter(name => name === 'scripting.executeScript:ISOLATED').length >= 2,
          'Submit probe and review both execute in the content-script world.');
        assert.ok(h.transports.includes('cdpClient.evaluate'), 'Saved HTML readback still uses the independent CDP transport.');
      } else assert.ok(h.transports.filter(name => name === 'tabs.executeScript').length >= 3,
        'The Firefox content-script transport captures the probe, review and saved readback.');
      assert.equal(h.agent._executionEvidenceSatisfied(h.guard), true);
      assert.equal(JSON.stringify(result).includes(notes), false, 'Private reviewed notes must not reach done output.');
    } finally { await h.close(); }
  });

  test(`${build}: requested tag, title, and Markdown retain exact payload constraints`, async () => {
    for (const mismatch of [null, 'tag', 'title', 'notes']) {
      const requirements = ['tag', 'title', 'notes'].map(field => ({ field, value: mismatch === field ? 'Wrong exact value' : { tag: 'v40.3.0', title: '40.3.0', notes }[field] }));
      const h = await fixture({ requirements });
      try {
        await h.done();
        assert.equal(h.agent._executionEvidenceSatisfied(h.guard), mismatch === null, mismatch || 'exact payload');
        if (mismatch) {
          assert.equal(h.guard.workflowTerminalEvidenceFailure.reason, 'requested_payload_mismatch');
          assert.deepEqual(h.guard.workflowTerminalEvidenceFailure.fields, [mismatch]);
        }
      } finally { await h.close(); }
    }
  });

  test(`${build}: changed saved fields and unreadable review cannot downgrade to empty-field success`, async () => {
    for (const field of ['tag', 'title', 'notes', 'unreadable']) {
      const h = await fixture();
      try {
        if (field === 'unreadable') h.saved.title = '';
        else h.saved[field] = 'Changed saved value';
        await h.done();
        assert.equal(h.agent._executionEvidenceSatisfied(h.guard), false, field);
        assert.match(h.agent._workflowPublicationRecoveryInstruction(h.guard), /do not repeat Publish or Update/);
        assert.equal(h.posts, 1, 'Verification never performs another submit.');
      } finally { await h.close(); }
    }
  });

  test(`${build}: unresolved metadata and missing dispatch fail with their actual predicate`, async () => {
    for (const options of [{ resolved: false }, { dispatch: false }]) {
      const h = await fixture(options);
      try {
        await h.done();
        assert.equal(h.agent._executionEvidenceSatisfied(h.guard), false);
        assert.equal(h.guard.workflowTerminalEvidenceFailure.reason, options.dispatch === false ? 'dispatch_binding_missing' : 'payload_requirements_unresolved');
      } finally { await h.close(); }
    }
  });

  test(`${build}: another resource and task changes during saved GET cannot certify the release`, async () => {
    for (const change of ['resource', 'task', 'provider', 'cancel', 'steering']) {
      const h = await fixture();
      try {
        if (change === 'resource') { await h.page.goto(`${origin}/other/repo/releases/tag/v40.3.0`); await h.recordRead(); }
        else h.duringEdit = () => {
          if (change === 'task') { h.key = 'another-task'; h.task = 'Another task'; }
          if (change === 'provider') h.provider = { ...h.provider };
          if (change === 'cancel') h.stopped = true;
          if (change === 'steering') h.steering = true;
        };
        await h.done();
        assert.equal(h.guard.workflowTerminalEvidence, null, change);
      } finally { await h.close(); }
    }
  });

  test(`${build}: shared publication rule accepts only explicitly resolved empty constraints`, () => {
    const agent = new Agent({});
    const state = { siteWorkflow: { adapterName: 'douyin', job: { template: 'publish', requiresLedger: false } } };
    for (const resolved of [true, false, undefined]) {
      assert.equal(agent._workflowPublishedResourcePayloadMatch({ metadataRequirements: [], metadataRequirementsResolved: resolved }, state, {}, '', {}), resolved === true);
    }
    assert.equal(agent._workflowPublishedResourcePayloadMatch({ metadataRequirements: [], metadataRequirementsResolved: true, metadataRequirementsIncomplete: true }, state, {}, '', {}), false);
    assert.equal(agent._workflowPublishedResourcePayloadMatch({ metadataRequirements: [{ field: 'title', value: 'Requested exact title' }] }, state,
      { workflowPageText: 'Some other title' }, '', {}), false);
  });

  test(`${build}: failed native release capture cannot downgrade to empty-field success`, async () => {
    const h = await fixture({ review: false });
    try {
      await h.done();
      assert.equal(h.posts, 1);
      assert.equal(h.editReads, 0);
      assert.equal(h.agent._executionEvidenceSatisfied(h.guard), false);
      assert.equal(h.guard.workflowTerminalEvidenceFailure.reason, 'release_review_unavailable');
    } finally { await h.close(); }
  });

  test(`${build}: captured release retains visibility and attachment checks`, async () => {
    for (const mismatch of [null, 'visibility', 'attachment']) {
      const h = await fixture({ requirements: [{ field: 'visibility', value: mismatch === 'visibility' ? 'Private' : 'Public' },
        { field: 'attachment', value: mismatch === 'attachment' ? 'missing.zip' : 'owned.zip' }] });
      try {
        await h.done();
        assert.equal(h.editReads, 1, 'Exact native release readback remains mandatory.');
        assert.equal(h.agent._executionEvidenceSatisfied(h.guard), mismatch === null, JSON.stringify({ failure: h.guard.workflowTerminalEvidenceFailure,
          requirements: h.submit.workflowBinding.metadataRequirements, pageText: await h.page.locator('body').innerText() }));
        if (mismatch) assert.deepEqual(h.guard.workflowTerminalEvidenceFailure.fields, [mismatch]);
      } finally { await h.close(); }
    }
  });

  test(`${build}: review stays bound to the probed form, document and current task`, async () => {
    for (const change of ['none', 'wrong-form', 'replaced-form', 'document', 'stop', 'task', 'run', 'provider', 'steering']) {
      const h = await fixture({ dispatch: false, read: false, keepForm: true });
      try {
        const detected = await h.rawProbe();
        assert.equal(detected.isSubmit, true); assert.match(detected.formRef, /^ref_\d+$/);
        if (change === 'wrong-form') detected.formRef = 'ref_999999';
        else if (change === 'replaced-form') await h.page.locator('form').evaluate(form => form.replaceWith(form.cloneNode(true)));
        else if (change === 'document') await h.page.reload();
        else if (change !== 'none') h.beforeCapture = () => {
          if (change === 'stop') h.stopped = true;
          if (change === 'task') { h.key = 'new-task'; h.task = 'Another task'; }
          if (change === 'run') h.agent._beginCompletionInvariant(51);
          if (change === 'provider') h.provider = { ...h.provider };
          if (change === 'steering') h.steering = true;
        };
        const captured = await h.capture(detected);
        assert.equal(captured.complete, change === 'none', `${change}: ${JSON.stringify(captured)}`);
        if (change === 'none') { assert.equal(captured.formRef, detected.formRef); assert.equal(captured.notes, notes); }
        assert.equal(h.posts, 0, 'Review is read-only, including stale-binding failures.');
      } finally { await h.close(); }
    }
  });
}
