import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area }, runtime: { getURL: value => `extension://test/${value}` }, tabs: {},
};

for (const [build, launcher] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: completion status capture uses visible live regions and refreshes without body-clock noise`, async () => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const instance = await launcher.launch({ headless: true });
    const page = await instance.newPage();
    let restore;
    try {
      if (build === 'chrome') {
        const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
        const original = cdpClient.evaluate;
        cdpClient.evaluate = async (_tabId, expression) => ({ result: { value: await page.evaluate(expression) } });
        restore = () => { cdpClient.evaluate = original; };
      } else {
        const original = browser.tabs.executeScript;
        browser.tabs.executeScript = async (_tabId, { code }) => [await page.evaluate(code)];
        restore = () => { browser.tabs.executeScript = original; };
      }
      await page.setContent(`
        <form><label>Name<input value="WebBrain QA"></label><button>Submit</button></form>
        <aside id="clock">Time 0</aside>
        <div role="status" hidden>Hidden submitted</div>
        <div style="opacity:0"><p role="status">Invisible submitted</p></div>
        <div aria-hidden="true"><p role="alert">Inaccessible submitted</p></div>
        <p id="status" role="status">QA submission recorded</p>
        <p aria-live="polite">QA submission recorded</p>
        <p role="alert">Email required</p>
      `);
      const agent = new Agent({});
      const original = await agent._completionLiveStatusMessages(1);
      assert.deepEqual(original, ['QA submission recorded', 'Email required']);
      await page.locator('#clock').evaluate(element => { element.textContent = 'Time 999'; });
      assert.deepEqual(await agent._completionLiveStatusMessages(1), original, 'Unrelated changing body text must not invalidate status evidence.');
      await page.locator('#status').evaluate(element => { element.textContent = 'Submission rejected'; });
      assert.deepEqual(await agent._completionLiveStatusMessages(1), ['Submission rejected', 'QA submission recorded', 'Email required']);
      await page.evaluate(() => {
        document.querySelector('[aria-live]').remove();
        document.querySelector('#status').remove();
        document.querySelector('[role=alert]:not([aria-hidden] *)').textContent = '語'.repeat(1000);
        for (let index = 0; index < 20; index++) {
          const status = document.createElement('p'); status.setAttribute('role', 'status'); status.textContent = `Result ${index}`; document.body.append(status);
        }
      });
      const bounded = await agent._completionLiveStatusMessages(1);
      assert.equal(bounded.length, 6);
      assert.equal(bounded[0].length, 160);
      assert.equal(bounded.includes('QA submission recorded'), false, 'Removed statuses must disappear from the next capture.');
    } finally {
      restore?.(); await instance.close();
    }
  });

  test(`${build}: dispatched form completion stays fresh beside a changing page counter, but rejects changed result evidence`, async () => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const { verifyBrowserCompletion } = await import(`../src/${build}/src/agent/completion-runtime.js`);
    const instance = await launcher.launch({ headless: true });
    const page = await instance.newPage();
    const url = 'https://owned.example.test/form';
    const oldScripting = chrome.scripting, oldScript = browser.tabs.executeScript;
    let restore;
    try {
      await page.route(url, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <form id="qa" aria-label="QA form"><label>Name<input id="name" value="WebBrain QA"></label>
          <p id="error"></p><button type="submit">Submit QA form</button></form>
        <aside id="counter">Unrelated changing counter 0</aside>
        <p id="status" role="status">QA submission recorded</p>` }));
      await page.goto(url);
      await page.addScriptTag({ path: fileURLToPath(new URL(`../src/${build}/src/content/accessibility-tree.js`, import.meta.url)) });
      if (build === 'chrome') {
        const { cdpClient } = await import('../src/chrome/src/cdp/cdp-client.js');
        const original = cdpClient.evaluate;
        cdpClient.evaluate = async (_tabId, expression) => ({ result: { value: await page.evaluate(expression) } });
        restore = () => { cdpClient.evaluate = original; };
        // Inject the actual serialized submit probe, exactly as extension APIs
        // do, while keeping all page access inside the disposable browser.
        chrome.scripting = { executeScript: async ({ func, args }) => [{ result: await page.evaluate(
          ({ source, args }) => Function(`return (${source})(...arguments)`)(...args), { source: func.toString(), args }) }] };
      } else {
        chrome.scripting = undefined;
      }
      browser.tabs.executeScript = async (_tabId, { code }) => [await page.evaluate(code)];
      const provider = { name: 'owned fixture', model: 'test', supportsVision: false, config: { category: 'local' }, chat() {} };
      const agent = new Agent({ getActive: () => provider });
      agent.systemOneContext = () => ({ isCurrent: () => true });
      agent._progressTaskKeyHash = () => 'owned-submit-task';
      agent._progressTaskAnchorText = () => 'Fill the Name field with WebBrain QA and submit this QA form exactly once.';
      agent.recordSystemOneVerdict = () => {};
      agent._planExecutionGuards.set(1, { enabled: true, requiresSubmission: true, requiresStateChange: true });
      agent.completionInvariants.set(1, { runToken: 'owned-run', historyToolCallIdsBeforeRun: new Set(), lastAction: { name: 'click_ax', sequence: 4 } });
      const buttonRef = await page.evaluate(() => window.__wb_ax_ref(document.querySelector('button')));
      const formRef = await page.evaluate(() => window.__wb_ax_ref(document.querySelector('form')));
      const detected = await agent._detectLikelySubmitAction(1, 'click_ax', { ref_id: buttonRef });
      assert.equal(detected?.isSubmit, true);
      assert.equal(detected.formRef, formRef, 'The actual submit probe must retain the exact enclosing form reference.');
      const submit = agent._recordCompletionSubmitAttempt(1, detected, 'click_ax', { ref_id: buttonRef }, url, url,
        { success: true, dispatched: true }, 'owned-document', 'owned-document');
      assert.equal(submit.formRef, formRef);
      submit.observedAfterSubmit = true;
      const fullTree = await page.evaluate(() => window.__generateAccessibilityTree('all', 15, 5500).pageContent);
      assert.match(fullTree, /Unrelated changing counter 0/);
      let reads = [], judges = 0, change;
      agent.executeTool = async (_tabId, name, args) => {
        assert.equal(name, 'get_accessibility_tree'); reads.push(args);
        return page.evaluate(args => {
          const result = window.__generateAccessibilityTree(args.filter, args.maxDepth, args.maxChars, args.ref_id);
          return { ...result, success: !result.error, pageUrl: location.href };
        }, args);
      };
      agent._chatWithCostAllowance = async (_provider, messages) => {
        judges++;
        const [info, observation] = JSON.parse(messages[1].content);
        assert.match(info.page_status_messages, /QA submission recorded/);
        assert.match(observation.observation, /WebBrain QA/);
        assert.doesNotMatch(observation.observation, /Unrelated changing counter/);
        await page.locator('#counter').evaluate(element => { element.textContent = `Unrelated changing counter ${Number(element.dataset.tick || 0) + 1}`; element.dataset.tick = String(Number(element.dataset.tick || 0) + 1); });
        if (change) await change();
        return { content: JSON.stringify({ outcome: 'succeeded', reason: 'Exact form values and fresh recorded confirmation.' }) };
      };
      const options = { pageUrl: url, pageState: { relevantFormCount: 1, successMessages: ['QA submission recorded'] }, summary: 'QA form submitted.' };
      assert.equal((await verifyBrowserCompletion(agent, 1, options)).outcome, 'succeeded');
      assert.equal(judges, 1);
      assert.equal(reads.length, 2);
      assert.ok(reads.every(args => args.ref_id === formRef && args.filter === 'all'));
      await page.locator('#counter').evaluate(element => { element.textContent = 'Unrelated changing counter 999'; });
      assert.equal((await verifyBrowserCompletion(agent, 1, options)).outcome, 'succeeded');
      assert.equal(judges, 1, 'An unchanged form/result may reuse its success without another paid judge request.');
      for (const [kind, mutation] of [
        ['field value', () => page.locator('#name').fill('Unexpected name')],
        ['inline error', () => page.locator('#error').evaluate(element => { element.textContent = 'Submission failed: email invalid'; })],
        ['removed acknowledgement', () => page.locator('#status').evaluate(element => { element.textContent = ''; })],
        ['new dialog outside form', () => page.evaluate(() => { const modal = document.createElement('dialog'); modal.textContent = 'Submission requires confirmation'; document.body.append(modal); modal.showModal(); })],
      ]) {
        await page.evaluate(() => {
          document.querySelector('#name').value = 'WebBrain QA';
          document.querySelector('#error').textContent = '';
          document.querySelector('#status').textContent = 'QA submission recorded';
          document.querySelectorAll('dialog').forEach(element => element.remove());
        });
        agent._completionVerdicts.clear(); reads = []; change = mutation;
        const verdict = await verifyBrowserCompletion(agent, 1, options);
        assert.equal(verdict.outcome, 'pending', kind);
        assert.equal(verdict.engine, 'freshness', kind);
        assert.equal(reads.length, 2, kind);
      }
      await page.evaluate(() => {
        document.querySelectorAll('dialog').forEach(element => element.remove());
        document.querySelector('#status').textContent = 'QA submission recorded';
      });
      agent._completionVerdicts.clear(); reads = [];
      change = () => page.locator('form').evaluate(form => { form.replaceWith(form.cloneNode(true)); });
      const replaced = await verifyBrowserCompletion(agent, 1, options);
      assert.equal(replaced.engine, 'freshness', 'A replacement form cannot inherit the exact-node dispatch proof.');
      assert.equal(reads.length, 3, 'A lost form reference must fall back to fresh complete-page evidence.');
      assert.equal(reads.at(-1).ref_id, undefined);
    } finally {
      chrome.scripting = oldScripting; browser.tabs.executeScript = oldScript;
      restore?.(); await instance.close();
    }
  });
}
