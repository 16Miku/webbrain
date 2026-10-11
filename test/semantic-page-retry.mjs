import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile(new URL('./fixtures/mastoturk-rules-loop.json', import.meta.url), 'utf8'));
const root = 'https://rules.fixture.invalid/auth/sign_up';
const opaqueUrl = index => `${root}?accept=${index.toString(16).padStart(32, '0')}`;
const tree = (ref = 'ref_current', detail = '') => ({
  pageContent: `heading "Rules before joining" [${ref}]\nparagraph "Read the site rules before continuing."\nlink "Accept" [${ref}_accept] href="/auth/sign_up?accept=00000000000000000000000000000001"\n${detail}`,
});
const link = (before, current, extra = {}) => ({
  success: true, verified: true, tag: 'a', name: 'Accept', resolvedHref: current,
  pageUrlChanged: before !== current, previousUrl: before, currentUrl: current,
  observedEffects: ['url'], ...extra,
});

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { LoopDetector } = await import(`../src/${build}/src/agent/loop-detector.js`);
  test(`${build}: actual thirty-tool rules loop stops despite fresh refs and opaque acceptance URLs`, () => {
    const agent = new Agent({});
    let pageUrl = 'https://rules.fixture.invalid/auth/sign_up';
    let document = 0, clicks = 0;
    const decisions = [];
    for (const step of fixture.steps) {
      if (step.name === 'get_accessibility_tree') agent._rememberAxScope(1, `document-${++document}`, pageUrl);
      if (step.name === 'click_ax') clicks++;
      if (step.result.currentUrl) pageUrl = step.result.currentUrl;
      const decision = agent._checkLoop(1, step.name, step.args, step.result);
      decisions.push(decision);
      agent._checkAccessibilityReadLoop(1, step.name, step.args, step.result);
      agent._checkNoProgressScroll(1, step.name, step.args, step.result);
      if (decision.kind === 'stop') break;
    }
    assert.ok(decisions.some(value => value.kind === 'nudge'), 'Repeated unchanged returns must request a different recovery strategy.');
    assert.equal(decisions.at(-1).kind, 'stop', 'The real read/scroll/fresh-ref click cycle must not consume the thirty-step budget.');
    assert.ok(clicks <= 4, `Expected at most four acceptance retries; observed ${clicks}.`);
    assert.match(decisions.at(-1).message, /unchanged|same page/i);
  });

  test(`${build}: semantic nonce identity never changes navigation, search, pagination or hash identity`, () => {
    const agent = new Agent({});
    assert.equal(agent._semanticRetryUrl(opaqueUrl(1)), root);
    assert.equal(agent._normalizeUrl(opaqueUrl(1)), opaqueUrl(1));
    for (const query of ['page=00000000000000000000000000000001', 'q=00000000000000000000000000000001',
      'accept=yes', 'accept=42', 'account=00000000000000000000000000000001']) {
      assert.equal(agent._semanticRetryUrl(`${root}?${query}`), `${root}?${query}`);
    }
    assert.equal(agent._semanticRetryUrl(opaqueUrl(1) + '#step2'), root + '#step2');
    assert.equal(agent._semanticRetryUrl(`${root}?q=test&accept=${'1'.repeat(32)}&page=2`), `${root}?q=test&page=2`);
  });

  test(`${build}: browser-free replay uses verified link URLs without fabricating a page scope`, () => {
    const detector = new LoopDetector();
    let clicks = 0, final;
    for (const step of fixture.steps) {
      if (step.name === 'click_ax') clicks++;
      final = detector._checkLoop(1, step.name, step.args, step.result);
      if (final.kind === 'stop') break;
    }
    assert.equal(final.kind, 'stop');
    assert.ok(clicks <= 5, 'A verified before URL may establish scope after the initial unscoped read; no ninth retry is needed.');
  });

  test(`${build}: interleaved reads and successful scrolling cannot hide an unchanged navigation return`, () => {
    const agent = new Agent({});
    let url = root, last;
    agent._rememberAxScope(1, 'document-0', url);
    agent._checkLoop(1, 'get_accessibility_tree', {}, tree());
    for (let turn = 1; turn <= 4; turn++) {
      const next = opaqueUrl(turn);
      agent._checkLoop(1, 'read_page', {}, { text: 'Public rules', url });
      agent._checkLoop(1, 'scroll', { direction: 'down', amount: 400 }, { success: true, moved: true });
      agent._checkLoop(1, 'click_ax', { ref_id: `ref_${turn}` }, link(url, next));
      agent._rememberAxScope(1, `document-${turn}`, next);
      last = agent._checkLoop(1, 'get_accessibility_tree', {}, tree(`ref_${turn}`));
      if (turn === 2) assert.equal(last.kind, 'nudge');
      url = next;
    }
    assert.equal(last.kind, 'stop');
  });

  test(`${build}: genuine pagination and search views progress even when the root controls are unchanged`, () => {
    for (const view of ['?page=', '?q=', '#step']) {
      const agent = new Agent({});
      let url = root + view + '0';
      for (let turn = 1; turn <= 12; turn++) {
        agent._rememberAxScope(1, `document-${turn}`, url);
        assert.equal(agent._checkLoop(1, 'get_accessibility_tree', {}, tree(`ref_${turn}`)).kind, 'none');
        assert.equal(agent._checkLoop(1, 'scroll', { direction: 'down', amount: 400 }, { success: true, moved: true }).kind, 'none');
        const next = root + view + turn;
        assert.equal(agent._checkLoop(1, 'click_ax', { ref_id: `ref_${turn}_accept` }, link(url, next)).kind, 'none');
        url = next;
      }
    }
  });

  test(`${build}: changed page text and field values break semantic retry history`, () => {
    const agent = new Agent({});
    let url = root;
    for (let turn = 1; turn <= 12; turn++) {
      agent._rememberAxScope(1, `document-${turn}`, url);
      assert.equal(agent._checkLoop(1, 'get_accessibility_tree', {}, tree(`ref_${turn}`, `textbox "Name" value="Step ${turn}"`)).kind, 'none');
      agent._checkLoop(1, 'scroll', { direction: 'down', amount: 400 }, { success: true, moved: true });
      const next = opaqueUrl(turn);
      assert.equal(agent._checkLoop(1, 'click_ax', { ref_id: `ref_${turn}_accept` }, link(url, next)).kind, 'none');
      url = next;
    }
  });

  test(`${build}: only verified URL-only navigation with a real target label and href creates semantic retry evidence`, () => {
    for (const invalid of [{ verified: false }, { name: '' }, { resolvedHref: '' }, { observedEffects: ['url', 'content'] },
      { outcomeUnknown: true }, { noDispatch: true }, { tag: 'button' }, { inconclusive: true }]) {
      const agent = new Agent({});
      let url = root;
      for (let turn = 1; turn <= 8; turn++) {
        agent._rememberAxScope(1, `document-${turn}`, url);
        assert.equal(agent._checkLoop(1, 'get_accessibility_tree', {}, tree(`ref_${turn}`)).kind, 'none');
        agent._checkLoop(1, 'scroll', { direction: 'down', amount: 400 }, { success: true, moved: true });
        const next = opaqueUrl(turn);
        assert.equal(agent._checkLoop(1, 'click_ax', { ref_id: `ref_${turn}_accept`, expected_name: 'Accept' }, link(url, next, invalid)).kind, 'none');
        url = next;
      }
    }
  });

  test(`${build}: subtree, partial and conversation reads cannot assert an unchanged whole page`, () => {
    for (const [args, extra] of [[{ ref_id: 'subtree' }, {}], [{ page: 2 }, {}], [{}, { hasMore: true }],
      [{}, { depthTruncated: true }], [{}, { conversationRootRefId: 'chat-log' }]]) {
      const agent = new Agent({});
      let url = root;
      for (let turn = 1; turn <= 8; turn++) {
        agent._rememberAxScope(1, `document-${turn}`, url);
        assert.equal(agent._checkLoop(1, 'get_accessibility_tree', args, { ...tree(`ref_${turn}`), ...extra }).kind, 'none');
        agent._checkLoop(1, 'scroll', { direction: 'down', amount: 400 }, { success: true, moved: true });
        const next = opaqueUrl(turn);
        assert.equal(agent._checkLoop(1, 'click_ax', { ref_id: `ref_${turn}_accept` }, link(url, next)).kind, 'none');
        url = next;
      }
    }
  });

  test(`${build}: new incoming native chat deltas and successful field writes are real progress`, () => {
    for (const progress of ['chat', 'field']) {
      const agent = new Agent({});
      let url = root;
      for (let turn = 1; turn <= 12; turn++) {
        agent._rememberAxScope(1, `document-${turn}`, url);
        assert.equal(agent._checkLoop(1, 'get_accessibility_tree', {}, tree(`ref_${turn}`)).kind, 'none');
        const next = opaqueUrl(turn);
        agent._checkLoop(1, 'click_ax', { ref_id: `ref_${turn}_accept` }, link(url, next));
        if (progress === 'chat') {
          const threadKey = 'dom:telegram:k:123456:0';
          assert.equal(agent._checkLoop(1, 'chat_observe', {}, { success: true, threadKey,
            chatWorkflow: { threadKey, newMessages: [{ id: `incoming-${turn}` }] } }).kind, 'none');
        } else {
          assert.equal(agent._checkLoop(1, 'set_field', { ref_id: `field_${turn}`, text: `Value ${turn}` }, { success: true, verified: true }).kind, 'none');
        }
        url = next;
      }
    }
  });

  test(`${build}: semantic retry history survives document cleanup but clears at the run boundary`, () => {
    const agent = new Agent({});
    agent._rememberAxScope(1, 'document-1', root);
    agent._checkLoop(1, 'get_accessibility_tree', {}, tree());
    agent._checkLoop(1, 'click_ax', { ref_id: 'ref_current_accept' }, link(root, opaqueUrl(1)));
    agent.failedActionLoops.set(1, new Map([['stale-ref', 2]]));
    agent._rememberAxScope(1, 'document-2', opaqueUrl(1));
    assert.equal(agent.failedActionLoops.has(1), false, 'Fresh documents must still expire stale target/failure state.');
    assert.equal(agent.semanticPageRetries.get(1)?.pending?.pageKey, root);
    agent._clearRunLoopState(1);
    assert.equal(agent.semanticPageRetries.has(1), false, 'A new run must not inherit earlier failed navigation attempts.');
  });
}
