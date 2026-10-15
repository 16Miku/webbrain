import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { stubPageTextReadings } from './semantic-decision-stub.mjs';

const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: value => `extension://test/${value}` } };

for (const [build, launcher] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: iframe submit completion uses the exact fresh dispatched document`, async t => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const { createCompletionInvariantState } = await import(`../src/${build}/src/agent/completion-invariant.js`);
    const { verifyBrowserCompletion } = await import(`../src/${build}/src/agent/completion-runtime.js`);
    const instance = await launcher.launch({ headless: true });
    const page = await instance.newPage();
    const topUrl = 'https://top.owned.invalid/task', editorUrl = 'https://editor.owned.invalid/form';
    const oldScripting = chrome.scripting, oldTabs = browser.tabs, oldNavigation = browser.webNavigation;
    let restore;
    try {
      await page.route('**/*', route => {
        const host = new URL(route.request().url()).hostname;
        return route.fulfill({ contentType: 'text/html', body: host === 'top.owned.invalid'
          ? '<iframe src="https://middle.owned.invalid/wrapper"></iframe><iframe src="https://other.owned.invalid/form"></iframe>'
          : host === 'middle.owned.invalid' ? `<iframe src="${editorUrl}"></iframe>`
            : '<form><input name="subject" value="Owned QA"><button id="save" type="submit">Save document</button></form><p id="receipt" role="status"></p>' });
      });
      await page.goto(topUrl);
      const frames = () => page.frames().map((frame, frameId) => ({ frame, frameId, url: frame.url() }));
      const editor = () => page.frames().find(frame => frame.url() === editorUrl);
      const target = id => frames().find(frame => frame.frameId === id)?.frame;
      browser.tabs = { get: async () => ({ url: page.url() }),
        executeScript: async (_tabId, { code, frameId, allFrames }) => Promise.all((allFrames ? page.frames() : [frameId === undefined ? page.mainFrame() : target(frameId)])
          .map(frame => frame.evaluate(code))) };
      browser.webNavigation = { getAllFrames: async () => frames().map(({ frameId, url }) => ({ frameId, url })) };
      chrome.scripting = build === 'chrome' ? { executeScript: async ({ target: scope, func, args = [] }) => Promise.all((scope.allFrames ? frames()
        : (scope.frameIds || [0]).map(frameId => frames().find(frame => frame.frameId === frameId))).map(async entry => ({
          frameId: entry.frameId, result: await entry.frame.evaluate(({ source, args }) => Function(`return (${source})(...arguments)`)(...args), { source: func.toString(), args }),
        }))) } : undefined;
      if (build === 'chrome') {
        const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
        const original = cdpClient.evaluate;
        cdpClient.evaluate = async (_tabId, code) => ({ result: { value: await page.evaluate(code) } });
        restore = () => { cdpClient.evaluate = original; };
      }
      const provider = { name: 'owned fixture', model: 'test', supportsVision: false, config: { category: 'local' }, chat() {} };
      const agent = new Agent({ getActive: () => provider });
      agent.systemOneContext = () => ({ isCurrent: () => true });
      agent.recordSystemOneVerdict = () => {};
      // A model reads what the frame's status messages say.
      const readings = new Map([['Dokument gespeichert; Beleg 789.', 'success'], ['Ungültige Eingabe im Feld Betreff.', 'error'],
        ['保存しました。受付番号 790。', 'success']]);
      const asked = stubPageTextReadings(agent, (kind, item) => readings.get(item.text)
        || (kind === 'status_message' && /saved successfully/i.test(item.text) ? 'success'
          : kind === 'status_message' && /rejected/i.test(item.text) ? 'error' : 'other'));
      const task = 'Save this owned iframe document once and read its receipt.';
      const actionArgs = { urlFilter: 'editor.owned.invalid/form', selector: '#save', matchIndex: 0 };
      async function arm(baseline = '') {
        await editor().locator('#receipt').evaluate((element, value) => { element.textContent = value; }, baseline);
        agent.conversations.set(1, [{ role: 'system', content: 'Act' }, { role: 'user', content: task, webbrainUserAuthoredText: task }]);
        agent.completionInvariants.set(1, createCompletionInvariantState('owned-frame-run'));
        agent._planExecutionGuards.set(1, { enabled: true, taskKey: agent._progressTaskKeyHash(1), requiresSubmission: true });
        const detected = await agent._detectLikelySubmitAction(1, 'iframe_click', actionArgs);
        assert.equal(detected?.isSubmit, true); assert.equal(detected.frameId, frames().find(frame => frame.url === editorUrl).frameId);
        const result = { success: true, dispatched: true, frameId: detected.frameId, frame: { url: editorUrl, tag: 'BUTTON', type: 'submit' } };
        agent._recordCompletionToolResult(1, 'iframe_click', actionArgs, result, { detectedSubmit: detected });
        agent._recordCompletionSubmitAttempt(1, detected, 'iframe_click', actionArgs, topUrl, topUrl, result);
        return detected;
      }
      async function observe() {
        const frame = frames().find(frame => frame.url === editorUrl);
        const result = { success: true, pageUrl: topUrl, frames: [{ frameId: frame.frameId, ok: true, url: frame.url,
          documentIdentity: await frame.frame.evaluate(() => [location.href, performance.timeOrigin].join('|')),
          text: await frame.frame.locator('#receipt').textContent() }] };
        agent._recordCompletionToolResult(1, 'iframe_read', { ...actionArgs, selector: '#receipt' }, result);
      }
      const options = { pageUrl: topUrl, pageState: { relevantFormCount: 0, successMessages: [] }, summary: 'The document was saved.' };
      const verified = async () => agent._completionSubmissionEvidence(1, { ...options.pageState, iframeSubmissionEvidence: await agent._completionIframeEvidence(1) }, topUrl).verifiedFinalSubmit;
      await t.test('a fresh exact-frame receipt verifies after an explicit post-action iframe read', async () => {
        await arm(); await editor().locator('#receipt').evaluate(element => { element.textContent = 'Document saved successfully; owned receipt 123.'; });
        assert.equal(await agent._completionIframeSnapshot(1), null, 'A changed status without the required explicit read is not completion.');
        await observe(); assert.equal(await verified(), true);
        assert.match((await agent._completionIframeSnapshot(1)).text, /owned receipt 123/);
      });
      await t.test('a receipt in any language counts only as a model reads it; an error message in the frame blocks it', async () => {
        await arm(); await editor().locator('#receipt').evaluate(element => { element.textContent = '保存しました。受付番号 790。'; });
        await observe(); assert.equal(await verified(), true);
        assert.ok(asked.some(item => item.kind === 'status_message' && item.text === '保存しました。受付番号 790。'));
        await arm(); await editor().locator('#receipt').evaluate(element => { element.textContent = 'Dokument gespeichert; Beleg 789.'; });
        await editor().locator('form').evaluate(form => { const p = document.createElement('p'); p.id = 'frame-error'; p.setAttribute('role', 'alert'); p.textContent = 'Ungültige Eingabe im Feld Betreff.'; form.append(p); });
        await observe(); assert.equal(await verified(), false, 'A message read as an error in the submitted frame blocks success');
        await editor().locator('#frame-error').evaluate(element => element.remove());
        assert.equal(await verified(), true);
        await arm(); await editor().locator('#receipt').evaluate(element => { element.textContent = 'Wird gespeichert …'; });
        await observe(); assert.equal(await verified(), false, 'A message read as neither success nor error proves nothing');
      });
      await t.test('pre-existing receipt and another iframe cannot prove this submission', async () => {
        await arm('Document saved successfully; old receipt.'); await observe(); assert.equal(await verified(), false);
        await arm();
        const other = page.frames().find(frame => frame.url().includes('other.owned.invalid'));
        await other.locator('#receipt').evaluate(element => { element.textContent = 'Saved successfully in the unrelated app.'; });
        await observe(); assert.equal(await verified(), false);
      });
      await t.test('frame validation errors and unrelated parent acknowledgements cannot certify a save', async () => {
        await arm(); await editor().locator('#receipt').evaluate(element => { element.textContent = 'Document saved successfully; owned receipt.'; }); await observe();
        await editor().locator('input').evaluate(element => { element.setAttribute('aria-invalid', 'true'); });
        assert.equal(await verified(), false);
        await editor().locator('input').evaluate(element => { element.removeAttribute('aria-invalid'); });
        await editor().locator('#receipt').evaluate(element => { element.textContent = ''; });
        assert.equal(agent._completionSubmissionEvidence(1, { relevantFormCount: 0, successMessages: ['Saved successfully on the parent page.'] }, topUrl).verifiedFinalSubmit, false);
      });
      await t.test('fresh frame content reaches the judge and changes during judgment invalidate success', async () => {
        await arm(); await editor().locator('#receipt').evaluate(element => { element.textContent = 'Document saved successfully; owned receipt 456.'; }); await observe();
        const actualExecute = agent.executeTool;
        agent.executeTool = async () => ({ success: true, pageContent: 'Parent document with embedded editor.' });
        agent._chatWithCostAllowance = async (_provider, messages) => {
          const [info] = JSON.parse(messages[1].content);
          assert.match(info.submitted_frame, /owned receipt 456/); assert.doesNotMatch(info.submitted_frame, /unrelated app/);
          return { content: JSON.stringify({ outcome: 'succeeded', reason: 'Fresh exact-frame receipt.' }) };
        };
        const accepted = await verifyBrowserCompletion(agent, 1, options);
        assert.equal(accepted.outcome, 'succeeded');
        assert.equal(accepted.submittedFrameStamp, (await agent._completionIframeSnapshot(1)).stamp);
        agent._completionVerdicts.clear();
        const judge = agent._chatWithCostAllowance;
        agent._chatWithCostAllowance = async (...args) => { const response = await judge(...args);
          await editor().locator('#receipt').evaluate(element => { element.textContent = 'Submission rejected.'; }); return response; };
        assert.equal((await verifyBrowserCompletion(agent, 1, options)).outcome, 'pending');
        assert.equal(await verified(), false); agent.executeTool = actualExecute;
      });
      await t.test('same-URL frame replacement cannot inherit an old read', async () => {
        await arm(); await editor().locator('#receipt').evaluate(element => { element.textContent = 'Saved successfully; owned receipt.'; }); await observe();
        await editor().goto(editorUrl); await editor().locator('#receipt').evaluate(element => { element.textContent = 'Saved successfully; replacement receipt.'; });
        assert.equal(await agent._completionIframeSnapshot(1), null); assert.equal(await verified(), false);
      });
      await t.test('Stop received during a frame capture rejects the deferred proof', async () => {
        await arm(); await editor().locator('#receipt').evaluate(element => { element.textContent = 'Saved successfully; owned receipt.'; }); await observe();
        const read = agent._readCompletionFrame;
        let captured, release;
        const ready = new Promise(resolve => { captured = resolve; });
        const pending = new Promise(resolve => { release = resolve; });
        agent._readCompletionFrame = async (...args) => { const result = await read.apply(agent, args); captured(); await pending; return result; };
        const proof = agent._completionIframeSnapshot(1);
        await ready; agent.abortFlags.set(1, true); release();
        assert.equal(await proof, null); agent.abortFlags.delete(1); agent._readCompletionFrame = read;
      });
      await t.test('changed task, run, latest action or Stop cannot reuse the proof', async () => {
        for (const change of ['task', 'run', 'action', 'stop']) {
          await arm(); await editor().locator('#receipt').evaluate(element => { element.textContent = 'Saved successfully; owned receipt.'; }); await observe();
          if (change === 'task') agent.conversations.get(1).push({ role: 'user', content: 'Save a different document.', webbrainUserAuthoredText: 'Save a different document.' });
          if (change === 'run') agent.completionInvariants.get(1).runToken = 'another-run';
          if (change === 'action') agent.completionInvariants.get(1).lastAction.sequence++;
          if (change === 'stop') agent.abortFlags.set(1, true);
          assert.equal(await agent._completionIframeSnapshot(1), null, change); assert.equal(await verified(), false, change);
          agent.abortFlags.delete(1);
        }
      });
    } finally { restore?.(); chrome.scripting = oldScripting; browser.tabs = oldTabs; browser.webNavigation = oldNavigation; await instance.close(); }
  });
}
