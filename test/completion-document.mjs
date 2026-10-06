import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

for (const [build, browserType] of [['chrome', chromium], ['firefox', firefox]]) {
  const { COMPLETION_DOCUMENT_STAMP_SCRIPT } = await import(`../src/${build}/src/agent/completion-document.js`);
  const { verifyBrowserCompletion } = await import(`../src/${build}/src/agent/completion-runtime.js`);
  const { probeDecisionVision } = await import(`../src/${build}/src/agent/decision-vision-probe.js`);
  test(`${build}: completion stamp detects accessibility-only changes and rejects reverted checkbox success`, async () => {
    const browser = await browserType.launch();
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    try {
      const page = await browser.newPage();
      await page.setContent('<input id="check" type="checkbox" checked><input id="text" value="unchanged"><button id="button">Save</button><div id="state" role="status">Published</div>');
      const stamp = () => page.evaluate(COMPLETION_DOCUMENT_STAMP_SCRIPT);
      const initial = await stamp();
      for (const [selector, property] of [['#check', 'checked'], ['#check', 'indeterminate'], ['#text', 'disabled'], ['#text', 'readOnly']]) {
        await page.locator(selector).evaluate((element, property) => { element[property] = !element[property]; }, property);
        assert.notEqual(await stamp(), initial, property);
        await page.locator(selector).evaluate((element, property) => { element[property] = !element[property]; }, property);
        assert.equal(await stamp(), initial);
      }
      for (const attribute of ['aria-checked', 'aria-expanded', 'aria-busy', 'aria-disabled', 'aria-hidden', 'aria-selected', 'aria-pressed', 'aria-label', 'aria-valuenow']) {
        await page.locator('#state').evaluate((element, name) => element.setAttribute(name, 'true'), attribute);
        assert.notEqual(await stamp(), initial, attribute);
        await page.locator('#state').evaluate((element, name) => element.removeAttribute(name), attribute);
        assert.equal(await stamp(), initial);
      }
      globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: true }) } } };
      const provider = { model: 'active', supportsVision: false, config: { category: 'local' } };
      const agent = {
        _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
        _latestTaskText: () => 'Check this checkbox', _originalTaskText: () => '', _progressTaskKeyHash: () => 'check',
        _planExecutionGuards: new Map(), completionInvariants: new Map([[1, { runToken: 'run' }]]),
        _completionSubmitStates: new Map(), conversationIds: new Map(), conversations: new Map(), _completionDocumentStamp: stamp,
        executeTool: async () => ({ success: true, pageContent: 'Checkbox checked' }), recordSystemOneVerdict() {},
        evaluateSystemOne: async () => {
          await page.locator('#check').evaluate(element => { element.checked = false; });
          return { model: 'kev-latest', answers: { task_outcome: { choice: 'succeeded', probabilities: { succeeded: .99 } } } };
        },
      };
      const verdict = await verifyBrowserCompletion(agent, 1);
      assert.equal(verdict.outcome, 'pending');
      assert.equal(verdict.engine, 'freshness');
      assert.equal(await page.locator('#check').inputValue(), 'on', 'the value did not change with checked state');
    } finally {
      globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
      await browser.close();
    }
  });
  test(`${build}: astral text and ARIA changes invalidate in-flight AX success`, async () => {
    const browser = await browserType.launch();
    const previousChrome = globalThis.chrome, previousBrowser = globalThis.browser;
    try {
      const page = await browser.newPage();
      const stamp = () => page.evaluate(COMPLETION_DOCUMENT_STAMP_SCRIPT);
      globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: true }) } } };
      for (const attribute of [null, 'aria-label']) {
        await page.setContent('<div id="state" role="status">Published</div>');
        const replace = value => page.locator('#state').evaluate((element, { attribute, value }) => {
          if (attribute) element.setAttribute(attribute, value); else element.textContent = value;
        }, { attribute, value });
        await replace('😀');
        const initial = await stamp();
        await replace('😁');
        assert.notEqual(await stamp(), initial, 'same-length emojis with a shared leading surrogate must change the stamp');
        await replace('😀');
        assert.equal(await stamp(), initial);
        const provider = { model: 'active', supportsVision: false, config: { category: 'local' } };
        const agent = {
          _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
          _latestTaskText: () => 'Verify the requested emoji', _originalTaskText: () => '', _progressTaskKeyHash: () => 'emoji',
          _planExecutionGuards: new Map(), completionInvariants: new Map([[1, { runToken: 'run' }]]),
          _completionSubmitStates: new Map(), conversationIds: new Map(), conversations: new Map(), _completionDocumentStamp: stamp,
          executeTool: async () => ({ success: true, pageContent: 'Requested emoji: 😀' }), recordSystemOneVerdict() {},
          evaluateSystemOne: async () => {
            await replace('😁');
            return { model: 'kev-latest', answers: { task_outcome: { choice: 'succeeded', probabilities: { succeeded: .99 } } } };
          },
        };
        const verdict = await verifyBrowserCompletion(agent, 1);
        assert.equal(verdict.outcome, 'pending');
        assert.equal(verdict.engine, 'freshness');
        assert.equal(agent._completionVerdicts.get(1)?.outcome === 'succeeded', false);
      }
    } finally {
      globalThis.chrome = previousChrome; globalThis.browser = previousBrowser;
      await browser.close();
    }
  });
  test(`${build}: vision capability probe uses two distinct pixel facts and rejects constant answers`, async () => {
    const browser = await browserType.launch();
    try {
      const page = await browser.newPage();
      const result = await page.evaluate(async source => {
        const probe = (0, eval)(`(${source})`);
        const colors = [];
        const consume = async request => {
          const image = new Image(); image.src = request.state[0].image_url.url;
          await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
          const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
          const [r, g, b] = context.getImageData(32, 32, 1, 1).data;
          const choice = r && g ? 'yellow' : r ? 'red' : g ? 'green' : b ? 'blue' : 'unknown';
          colors.push(choice);
          return { answers: { image_color: { choice, probabilities: { [choice]: .99 } } } };
        };
        const accepted = await probe({}, consume, { random: () => .999 });
        const constantRejected = !await probe({}, async () => ({ answers: { image_color: { choice: 'red', probabilities: { red: .99 } } } }), { random: () => 0 });
        return { accepted, colors, constantRejected };
      }, probeDecisionVision.toString());
      assert.equal(result.accepted, true);
      assert.equal(new Set(result.colors).size, 2);
      assert.equal(result.constantRejected, true);
    } finally { await browser.close(); }
  });
}
