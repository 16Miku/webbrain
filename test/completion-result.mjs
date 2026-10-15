import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';

// Offline DOM/transport fixture for the trace's floating support conversation.
// No real account, message, or network request is used.
function conversation() {
  let nextRef = 10;
  const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
  const box = rect(650, 80, 420, 620);
  class Element {
    constructor(tag, bounds = box, attributes = {}) {
      this.tagName = tag.toUpperCase(); this.bounds = bounds; this.attributeValues = attributes;
      this.children = []; this.isConnected = true; this.style = {}; this.ref = `ref_${nextRef++}`;
    }
    append(child) { child.parentElement = this; this.children.push(child); return child; }
    getBoundingClientRect() { return this.bounds; }
    get attributes() { return Object.entries(this.attributeValues).map(([name, value]) => ({ name, value })); }
    getAttribute(key) { return this.attributeValues[key] ?? null; }
    get textContent() { return this.children.map(child => child.textContent || '').join(''); }
    editor() { return this.tagName === 'TEXTAREA' || this.getAttribute('contenteditable') === 'true' || this.getAttribute('contenteditable') === '' || this.getAttribute('role') === 'textbox'; }
    closest() {
      for (let n = this; n; n = n.parentElement) if (n.editor() || ['SCRIPT', 'STYLE', 'INPUT', 'SELECT'].includes(n.tagName)) return n;
      return null;
    }
    querySelectorAll(selector) {
      const result = [];
      const omittedControls = selector.includes('input,textarea');
      const visit = n => { for (const c of n.children || []) {
        if (omittedControls ? c.tagName && (/^(INPUT|TEXTAREA|SELECT|OPTION|BUTTON)$/.test(c.tagName)
          || c.getAttribute('contenteditable') !== null || c.getAttribute('role') !== null) : c.editor?.()) result.push(c);
        visit(c);
      } };
      visit(this); return result;
    }
    text(text, bounds = this.bounds) {
      const node = { textContent: text, bounds, parentElement: this }; this.children.push(node); return node;
    }
  }
  const body = new Element('body', rect(0, 0, 1200, 800));
  const root = body.append(new Element('section'));
  root.append(new Element('h2')).text('Support team conversation');
  const pane = root.append(new Element('div', rect(650, 150, 420, 550)));
  const message = pane.append(new Element('p'));
  message.text('Earlier unrelated conversation.');
  const hidden = root.append(new Element('p', box, { 'aria-hidden': 'true' })); hidden.text('PRIVATE_HIDDEN_KEY');
  root.append(new Element('p')).text('PRIVATE_OFFSCREEN_KEY', rect(660, -100, 350, 20));
  const row = pane.append(new Element('form', rect(660, 620, 390, 60)));
  const editor = row.append(new Element('textarea', rect(660, 630, 320, 30)));
  editor.value = 'PRIVATE_UNSENT_KEY'; editor.text('PRIVATE_UNSENT_KEY');
  const send = row.append(new Element('button', rect(1000, 630, 30, 30))); send.text('Send');
  const window = { __wbElementMap: { [send.ref]: { deref: () => send } }, __wb_ax_ref: el => el.ref };
  const globals = { window, location: { href: 'https://owned.example.test/accounts' }, performance: { timeOrigin: 1000 },
    innerWidth: 1200, innerHeight: 800, NodeFilter: { SHOW_TEXT: 4 }, crypto: webcrypto, TextEncoder,
    getComputedStyle: el => ({ display: 'block', visibility: 'visible', opacity: '1', overflow: 'visible', ...el.style }),
    document: {
      createTreeWalker(root) {
        const nodes = []; const visit = n => { for (const c of n.children || []) c.tagName ? visit(c) : nodes.push(c); };
        visit(root); let i = 0; return { nextNode: () => nodes[i++] || null };
      },
      createRange() { let node; return { selectNodeContents: n => { node = n; }, getClientRects: () => [node.bounds], detach() {} }; },
    },
  };
  return { globals, root, message, editor, send, body, Element,
    evaluate: code => vm.runInNewContext(code, globals),
    sent() { message.children = []; message.text('Hi support team. Please hand over the two owned QA accounts. Please do not include passwords in your reply. Thank you.'); editor.value = ''; },
  };
}

for (const build of ['chrome', 'firefox']) {
  const { completionResultSnapshot, completionResultPixelRect } = await import(`../src/${build}/src/agent/completion-result.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { verifyBrowserCompletion } = await import(`../src/${build}/src/agent/completion-runtime.js`);
  test(`${build}: result crops use actual capture dimensions and reject invalid viewport bounds`, () => {
    const rect = { x: 600, y: 100, width: 400, height: 600 }, viewport = { width: 1200, height: 800 };
    assert.deepEqual(completionResultPixelRect(rect, viewport, 2400, 1600), { x: 1200, y: 200, width: 800, height: 1200 });
    assert.deepEqual(completionResultPixelRect(rect, viewport, 1200, 800), rect);
    for (const bad of [{ ...rect, x: -1 }, { ...rect, width: Infinity }, { ...rect, x: 1100 }, { ...rect, height: 0 }]) {
      assert.equal(completionResultPixelRect(bad, viewport, 2400, 1600), null);
    }
  });

  test(`${build}: scoped screenshot redacts the full viewport before cropping`, async () => {
    const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
    const cdp = build === 'chrome' ? (await import('../src/chrome/src/cdp/cdp-client.js')).cdpClient : null;
    const savedSend = cdp?.sendCommand, order = [];
    globalThis.chrome = globalThis.browser = { tabs: { captureTab: async () => 'data:image/png;base64,full-viewport' } };
    if (cdp) cdp.sendCommand = async () => ({ data: 'full-viewport' });
    const agent = new Agent({});
    agent.screenshotRedaction = true;
    agent._canTakeAutoScreenshot = () => true; agent._preparePageForCapture = async () => {};
    agent._withIndicatorsHidden = async (_tab, fn) => fn();
    agent._redactScreenshotDataUrl = async (_tab, image, options) => {
      assert.equal(image, 'data:image/png;base64,full-viewport'); assert.equal(options.coordinateSpace, 'viewport');
      order.push('redact'); return 'redacted-full-viewport';
    };
    const scope = { rect: { x: 600, y: 100, width: 400, height: 600 }, viewport: { width: 1200, height: 800 } };
    agent._cropDataUrl = async (image, rect, _mime, viewport) => {
      assert.equal(image, 'redacted-full-viewport'); assert.deepEqual(rect, scope.rect); assert.deepEqual(viewport, scope.viewport);
      order.push('crop'); return { dataUrl: 'redacted-conversation' };
    };
    agent._recordAutoScreenshot = () => order.push('record');
    try {
      assert.equal(await agent._captureCompletionJudgeImage(1, scope), 'redacted-conversation');
      assert.deepEqual(order, ['redact', 'crop', 'record']);
    } finally {
      if (cdp) cdp.sendCommand = savedSend;
      globalThis.chrome = savedChrome; globalThis.browser = savedBrowser;
    }
  });

  for (const changed of [false, true]) test(`${build}: scoped visual result ${changed ? 'rejects changed result pixels' : 'ignores unrelated sidebar pixels'}`, async () => {
    const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
    globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: true, decisionVisionMode: 'on' }) } } };
    const provider = { config: { category: 'local' }, model: 'local', supportsVision: true };
    const resultView = { rect: { x: 600, y: 100, width: 400, height: 600 }, viewport: { width: 1200, height: 800 } };
    const snapshot = { identity: 'doc', scopeRef: 'ref_1', text: 'Support team\nHandover request sent.', ...resultView };
    let captures = 0; const modalities = [];
    const agent = { _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
      _planExecutionGuards: new Map(), completionInvariants: new Map([[1, { runToken: 'run' }]]), conversations: new Map(),
      _completionDocumentStamp: async () => 'doc', _progressTaskKeyHash: () => 'task', _latestTaskText: () => 'Send the request',
      _currentCompletionSubmitState: () => null, _completionResultSnapshot: async () => ({ ...snapshot }),
      _budgetForCapture: () => ({ maxTargetPx: 1408, maxTargetTokens: 1400 }), _shrinkImageForBudget: async dataUrl => ({ dataUrl }),
      _captureCompletionJudgeImage: async (_tab, scope) => {
        assert.deepEqual(scope, resultView); captures++;
        return `data:image/png;base64,${changed && captures > 1 ? 'message-removed' : 'stable-sent-message'}`;
      },
      recordSystemOneVerdict() {}, evaluateSystemOne: async (_tab, _judge, args) => {
        const vision = args.state[1].type === 'image_url'; modalities.push(vision ? 'vision' : 'ax');
        return { answers: { task_outcome: { choice: vision ? 'succeeded' : 'uncertain', probabilities: { succeeded: .99, uncertain: .99 } } } };
      } };
    try {
      const verdict = await verifyBrowserCompletion(agent, 1);
      assert.equal(verdict.outcome, changed ? 'uncertain' : 'succeeded');
      assert.equal(captures, 2); assert.deepEqual(modalities, ['ax', 'vision']);
    } finally { globalThis.chrome = savedChrome; globalThis.browser = savedBrowser; }
  });
  test(`${build}: result capture reads visible conversation text and excludes drafts, hidden and clipped content`, async () => {
    const h = conversation(); h.sent();
    const capture = () => h.evaluate(`(${completionResultSnapshot.toString()})(${JSON.stringify(h.send.ref)})`);
    const result = await capture();
    assert.equal(result.scopeRef, h.root.ref);
    assert.match(result.text, /Support team conversation/);
    assert.match(result.text, /Please hand over the two owned QA accounts/);
    assert.doesNotMatch(result.text, /PRIVATE_/);
    assert.equal(result.composerEmpty, true);
    assert.match(result.controlFingerprint, /^[a-f0-9]{64}$/);
    assert.equal((await capture()).controlFingerprint, result.controlFingerprint);
    h.send.isConnected = false; assert.equal(await capture(), null);
  });

  test(`${build}: scoped capture declines when omitted controls cannot be fingerprinted completely`, async () => {
    const h = conversation();
    const capture = () => h.evaluate(`(${completionResultSnapshot.toString()})(${JSON.stringify(h.send.ref)})`);
    delete h.globals.crypto;
    assert.equal(await capture(), null);
    h.globals.crypto = { subtle: { digest: async () => { throw Error('Unavailable'); } } };
    assert.equal(await capture(), null);
    h.globals.crypto = webcrypto;
    for (let i = 0; i < 1001; i++) h.root.append(new h.Element('input'));
    assert.equal(await capture(), null);
  });

  test(`${build}: fresh changed conversation verifies the send without a whole-page screenshot`, async () => {
    const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
    const h = conversation();
    const area = { get: async () => ({}), set: async () => {} };
    const api = { storage: { local: area, session: area }, runtime: { getURL: x => x },
      scripting: { executeScript: async ({ func, args }) => [{ frameId: 0, result: await h.evaluate(`(${func.toString()})(${JSON.stringify(args[0])})`) }] },
      tabs: { executeScript: async (_tab, { code }) => [await h.evaluate(code)] } };
    globalThis.chrome = globalThis.browser = api;
    const provider = { config: { providerName: 'webbrain-cloud', baseUrl: 'https://api.webbrain.one/v1' }, model: 'webbrain-cloud 1.0', supportsVision: true, chat() {} };
    const agent = new Agent({ getActive: () => provider });
    const url = h.globals.location.href;
    agent._progressTaskKeyHash = () => 'owned-send'; agent._progressTaskAnchorText = () => 'Send the handover request, without passwords.';
    agent._planExecutionGuards.set(1, { enabled: true, taskKey: 'owned-send', requiresSubmission: true,
      approvedPlanAnchor: 'Send the handover request to the support team and verify the sent message.' });
    agent.completionInvariants.set(1, { runToken: 'run', historyToolCallIdsBeforeRun: new Set(), lastAction: { sequence: 1 } });
    agent._completionDocumentStamp = async () => [url, h.globals.performance.timeOrigin].join('|');
    agent._captureCompletionJudgeImage = async () => { throw Error('Unrelated sidebar animation must not require a screenshot'); };
    agent._chatWithCostAllowance = async () => { throw Error('No slow fallback is needed for a sure decision'); };
    const asks = [];
    agent.evaluateSystemOne = async (_tab, _judge, args) => {
      asks.push(args.state);
      assert.match(args.state[1].observation, /Please hand over the two owned QA accounts/);
      assert.doesNotMatch(args.state[1].observation, /PRIVATE_|passwords/);
      assert.match(args.state[0].approved_plan, /verify the sent message/);
      h.body.style.background = 'sidebar animation';
      return { model: args.config.model, answers: { task_outcome: { choice: 'succeeded', probabilities: { succeeded: .99 } } } };
    };
    try {
      const baseline = await agent._readCompletionResult(1, h.send.ref);
      const submit = agent._recordCompletionSubmitAttempt(1, { isSubmit: true, resultBaseline: {
        identity: baseline.identity, scopeRef: baseline.scopeRef, textSha256: agent._sha256TextSync(baseline.text) } },
      'click_ax', { ref_id: h.send.ref }, url, url, { success: true }, 'doc', 'doc');
      submit.observedAfterSubmit = true;
      assert.equal(submit.actionRef, h.send.ref);
      assert.equal(await agent._completionResultSnapshot(1), null, 'Pre-existing text is not new send evidence');
      h.editor.value = '';
      assert.equal(await agent._completionResultSnapshot(1), null, 'An emptied composer alone is not a sent result');
      h.sent();
      const verdict = await verifyBrowserCompletion(agent, 1, { pageUrl: url });
      assert.equal(verdict.outcome, 'succeeded'); assert.equal(verdict.modality, 'ax'); assert.equal(asks.length, 1);
      assert.doesNotMatch(JSON.stringify(submit.resultBaseline), /Earlier|PRIVATE_/, 'Persist only the baseline fingerprint');
      for (const flag of ['documentChanged', 'formValidationFailed']) {
        submit[flag] = true; assert.equal(await agent._completionResultSnapshot(1), null); submit[flag] = false;
      }
      h.globals.performance.timeOrigin++;
      assert.equal(await agent._completionResultSnapshot(1), null, 'Reloaded documents cannot reuse the old scope');
    } finally { globalThis.chrome = savedChrome; globalThis.browser = savedBrowser; }
  });

  for (const modality of ['ax', 'vision']) for (const change of ['textarea value', 'input value', 'checkbox state', 'selected option', 'contenteditable text', 'readonly state', 'ARIA state']) {
    test(`${build}: scoped ${modality} rejects stale success after omitted ${change} changes`, async () => {
      const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
      globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: true, decisionVisionMode: 'on' }) } } };
      const h = conversation(); h.root.tagName = 'FORM'; h.root.children[0].children[0].textContent = 'Profile bio';
      h.message.children[0].textContent = 'Profile saved.';
      h.editor.value = 'PRIVATE_INITIAL_BIO';
      let mutate;
      if (change === 'textarea value') mutate = () => { h.editor.value = 'PRIVATE_CHANGED_BIO'; };
      else if (change === 'contenteditable text') {
        h.editor.tagName = 'DIV'; h.editor.attributeValues.contenteditable = 'true'; delete h.editor.value;
        mutate = () => { h.editor.children[0].textContent = 'PRIVATE_CHANGED_BIO'; };
      } else if (change === 'readonly state') mutate = () => { h.editor.readOnly = true; };
      else if (change === 'ARIA state') mutate = () => { h.editor.attributeValues['aria-invalid'] = 'true'; };
      else {
        const field = h.root.append(new h.Element(change === 'selected option' ? 'select' : 'input'));
        field.value = 'PRIVATE_INITIAL_VALUE';
        if (change === 'input value') mutate = () => { field.value = 'PRIVATE_CHANGED_VALUE'; };
        else if (change === 'checkbox state') {
          field.checked = true; mutate = () => { field.checked = false; };
        } else {
          const option = field.append(new h.Element('option')); option.selected = true;
          mutate = () => { option.selected = false; };
        }
      }
      const capture = () => h.evaluate(`(${completionResultSnapshot.toString()})(${JSON.stringify(h.send.ref)})`);
      const before = await capture();
      assert.ok(before?.scopeRef, 'The inline one-textarea form qualifies for scoped evidence');
      const provider = { config: { category: 'local' }, model: 'local', supportsVision: modality === 'vision' };
      let after;
      const agent = { _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
        _planExecutionGuards: new Map(), completionInvariants: new Map([[1, { runToken: 'run' }]]), conversations: new Map(),
        _completionDocumentStamp: async () => before.identity, _progressTaskKeyHash: () => 'profile', _latestTaskText: () => 'Save my profile bio',
        _currentCompletionSubmitState: () => null, _completionResultSnapshot: capture,
        _budgetForCapture: () => ({ maxTargetPx: 1408, maxTargetTokens: 1400 }), _shrinkImageForBudget: async dataUrl => ({ dataUrl }),
        _captureCompletionJudgeImage: async () => 'data:image/png;base64,unchanged-pixels', recordSystemOneVerdict() {},
        evaluateSystemOne: async (_tab, _judge, args) => {
          assert.doesNotMatch(JSON.stringify(args.state), /PRIVATE_|controlFingerprint/, 'Omitted control state and its fingerprint stay local');
          const vision = args.state[1].type === 'image_url';
          if (modality === 'vision' && !vision) return { answers: { task_outcome: { choice: 'uncertain', probabilities: { uncertain: .99 } } } };
          mutate(); after = await capture();
          assert.equal(after.text, before.text, 'Visible result text is unchanged');
          assert.equal(after.composerEmpty, before.composerEmpty, 'The editor remains non-empty');
          assert.doesNotMatch(JSON.stringify(after), /PRIVATE_/, 'Only a fingerprint leaves the content script');
          return { answers: { task_outcome: { choice: 'succeeded', probabilities: { succeeded: .99 } } } };
        } };
      try {
        const verdict = await verifyBrowserCompletion(agent, 1);
        assert.ok(after, 'The independent judge evaluated the requested modality before the control changed');
        assert.notEqual(before.controlFingerprint, after.controlFingerprint);
        assert.notEqual(verdict.outcome, 'succeeded');
        if (modality === 'ax') assert.equal(verdict.engine, 'freshness');
        assert.notEqual(agent._completionVerdicts.get(1)?.outcome, 'succeeded');
      } finally { globalThis.chrome = savedChrome; globalThis.browser = savedBrowser; }
    });
  }

  for (const change of ['message edited', 'redacted message edited', 'recipient changed', 'scope replaced', 'scope lost']) {
    test(`${build}: changed conversation ${change} invalidates an in-flight success`, async () => {
      const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
      globalThis.chrome = globalThis.browser = { storage: { local: { get: async () => ({ decisionProvider: 'local', systemOneEnabled: true }) } } };
      const provider = { config: { category: 'local' }, model: 'local', supportsVision: false };
      const snapshot = { identity: 'doc', scopeRef: 'ref_1', text: 'Support team\nRequested handover message is sent.\npassword: PRIVATE_A', composerEmpty: true };
      const agent = { _activeProvider: () => provider, _runAbortSignal: () => null, systemOneContext: () => ({ isCurrent: () => true }),
        _planExecutionGuards: new Map(), completionInvariants: new Map([[1, { runToken: 'run' }]]), conversations: new Map(),
        _completionDocumentStamp: async () => 'doc', _progressTaskKeyHash: () => 'task', _latestTaskText: () => 'Send the request',
        _currentCompletionSubmitState: () => null, _completionResultSnapshot: async () => change === 'scope lost' && !snapshot.text ? null : { ...snapshot },
        recordSystemOneVerdict() {}, evaluateSystemOne: async () => {
          if (change === 'message edited' || change === 'recipient changed') snapshot.text = 'Different message or recipient';
          else if (change === 'redacted message edited') snapshot.text = snapshot.text.replace('PRIVATE_A', 'PRIVATE_B');
          else if (change === 'scope replaced') snapshot.scopeRef = 'ref_2'; else snapshot.text = '';
          return { answers: { task_outcome: { choice: 'succeeded', probabilities: { succeeded: .99 } } } };
        } };
      try { assert.equal((await verifyBrowserCompletion(agent, 1)).engine, 'freshness'); }
      finally { globalThis.chrome = savedChrome; globalThis.browser = savedBrowser; }
    });
  }
}
