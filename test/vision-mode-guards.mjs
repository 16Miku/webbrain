// The guards in a vision run (docs/vision-mode.md). Every click of a vision
// run is a coordinate click translated from click_at, typing goes to the
// focused field and no ref, selector or tree tool is offered, so a guard that
// needs one of those must bind what the run does have, or say what the model
// can do instead. Both builds; the probes and models are stubbed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultDecide, installModelStub } from './semantic-decision-stub.mjs';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

const pageUrl = 'https://social.example/@me';
const documentIdentity = `${pageUrl}|1700000000000.5`;
const post = 'My WebBrain test post';
const other = 'Another post from yesterday';
// What click_at becomes before the guards run (vision-tools.js translateVisionClick).
const visionClick = { x: 640, y: 420, coordinate_space: 'css' };

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  function fixture(request, { vision = true, decide = defaultDecide } = {}) {
    const provider = { model: 'owned-vision-guard-fixture', supportsVision: true, chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider });
    const tab = 11;
    agent._persist = () => {};
    agent.conversations.set(tab, [{ role: 'system', content: 'system' }, { role: 'user', content: request }]);
    const guard = agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
    agent._beginCompletionInvariant(tab);
    agent._visionRunState = () => (vision ? { active: true, coordinates: 'pixel' } : { active: false, reason: 'setting_off' });
    // The record the submit probe returns for the site's own confirmation
    // dialog of a post (as for the tree path, see guards-unbound-deletion.mjs).
    const detect = ({ text = post } = {}) => ({
      isSubmit: true, mutationKind: 'delete', publicationControl: false, url: pageUrl, frameDocumentIdentity: documentIdentity,
      actionRecord: { kind: 'record', text, owner: 'article', stage: 'confirmation', complete: true, scopeToken: 'owned-record-token-0002',
        document: documentIdentity, siblings: [other], siblingCount: 1, confirmationText: 'Delete this post?',
        footprint: agent._sha256TextSync(JSON.stringify({ document: documentIdentity, owner: 'article', text })),
        identity: agent._sha256TextSync(JSON.stringify({ origin: new URL(pageUrl).origin, owner: 'article', text })) },
      reconciliationResources: [], reconciliationResourceScanComplete: false });
    let current = detect();
    const probes = [];
    agent._detectLikelySubmitAction = async (_tab, name, args, options = {}) => {
      probes.push({ name, args, options });
      return structuredClone(current);
    };
    const calls = installModelStub(agent, { decide, provider });
    return {
      agent, guard, tab, provider, detect, calls, probes,
      get detected() { return current; }, set detected(value) { current = value; },
      check(name = 'click', args = visionClick, detected = current) {
        return agent._resourceMutationPreSubmitBlock(tab, name, args, structuredClone(detected), provider);
      },
    };
  }
  const reason = result => result?.actionGuard?.reason || null;

  test(`${build}: a vision click deletes the item the request names, bound to the control read at its point`, async () => {
    const f = fixture('Delete my WebBrain test post');
    assert.equal(await f.check(), null, 'authorized');
    const key = f.agent._resourceMutationActionKey(f.tab, 'click', visionClick, f.detected);
    assert.ok(key, 'a vision click has an action key');
    assert.equal(f.guard.resourceMutationAuthorization?.key, key);
    // The same point outside a vision run (a model with refs and selectors) stays unbound.
    const tree = fixture('Delete my WebBrain test post', { vision: false });
    assert.equal(tree.agent._resourceMutationActionKey(tree.tab, 'click', visionClick, tree.detected), '');
    const refused = await tree.check();
    assert.equal(reason(refused), 'click_required');
    assert.match(refused.error, /ref or selector click/);
  });

  test(`${build}: a vision deletion keeps every deletion rule: the card, a changed item, a forbidden item, keys`, async () => {
    // Not named by the request: WebBrain's own card asks, as on the tree path.
    const unnamed = fixture('Tidy up my profile page');
    const card = await unnamed.check();
    assert.equal(card?.mutationConfirmation?.kind, 'delete', JSON.stringify(card));
    assert.notEqual(reason(card), 'click_required');
    // The item under the point changes between the probe and the final read.
    const changed = fixture('Delete my WebBrain test post');
    const probed = structuredClone(changed.detected);
    let reads = 0;
    changed.agent._detectLikelySubmitAction = async () => (++reads >= 1 ? changed.detect({ text: other }) : probed);
    assert.match(reason(await changed.check('click', visionClick, probed)) || '', /^resource_changed/);
    // A request that says not to delete it.
    const forbidden = fixture("Don't delete my WebBrain test post");
    assert.equal(reason(await forbidden.check()), 'deletion_not_requested');
    // Enter on a focused Delete button cannot be bound; the advice names what a vision run has.
    const keys = fixture('Delete my WebBrain test post');
    const enter = await keys.check('press_keys', { key: 'Enter' });
    assert.equal(reason(enter), 'click_required');
    assert.match(enter.error, /click_at/);
    assert.doesNotMatch(enter.error, /ref or selector/);
  });

  test(`${build}: an authorized vision deletion is read again at its point right before input goes out`, async () => {
    const f = fixture('Delete my WebBrain test post');
    assert.equal(await f.check(), null);
    const authorized = structuredClone(f.detected);
    f.probes.length = 0;
    // Unchanged: no refusal.
    assert.equal(await f.agent._visionMutationBindingBlock(f.tab, visionClick, authorized), null);
    assert.deepEqual(f.probes.map(probe => probe.options.mutationReconciliation), [true], 'one fresh read at dispatch');
    // The dialog under the point now belongs to another post.
    f.detected = f.detect({ text: other });
    const refused = await f.agent._visionMutationBindingBlock(f.tab, visionClick, authorized);
    assert.equal(reason(refused), 'resource_changed_before_dispatch');
    assert.equal(refused.noDispatch, true);
    // A click no guard authorized is not read again.
    f.probes.length = 0;
    assert.equal(await f.agent._visionMutationBindingBlock(f.tab, { ...visionClick, x: 10 }, authorized), null);
    assert.equal(f.probes.length, 0);
  });

  test(`${build}: the vision click dispatch sends nothing when the authorized control moved away from the point`, async () => {
    const f = fixture('Delete my WebBrain test post');
    assert.equal(await f.check(), null);
    const authorized = structuredClone(f.detected);
    f.detected = f.detect({ text: other });
    f.agent._visionClickPreflight = async () => ({ target: { tag: 'button' } });
    const sent = [];
    if (build === 'firefox') {
      f.agent._visionContentInput = async (_tab, params) => { sent.push(params); return { success: true, dispatched: true }; };
      f.agent._settleContentFilePickerGuard = async (_tab, response) => response;
      const refused = await f.agent._visionDispatchClick(f.tab, visionClick, { vision: { tool: 'click_at' }, detectedSubmitAction: authorized });
      assert.equal(reason(refused), 'resource_changed_before_dispatch');
      assert.equal(sent.length, 0, 'no input was sent');
      // Unchanged, the click goes out.
      f.detected = authorized;
      const clicked = await f.agent._visionDispatchClick(f.tab, visionClick, { vision: { tool: 'click_at' }, detectedSubmitAction: authorized });
      assert.equal(clicked.success, true, JSON.stringify(clicked));
      assert.equal(sent.length, 1);
    } else {
      const saved = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand };
      cdpClient.attach = async () => {};
      cdpClient.sendCommand = async (_tab, method, params) => { sent.push({ method, params }); return {}; };
      try {
        const refused = await f.agent._visionDispatchClick(f.tab, visionClick, { vision: { tool: 'click_at' }, detectedSubmitAction: authorized });
        assert.equal(reason(refused), 'resource_changed_before_dispatch');
        assert.deepEqual(sent.filter(command => command.method === 'Input.dispatchMouseEvent'), [], 'no input was sent');
      } finally {
        Object.assign(cdpClient, saved);
      }
    }
  });
}

// Loop detection in a vision run. Every click is a point, every scroll the
// same wheel and keys carry no target, so the arguments alone cannot tell a
// repeat from progress: the screen can. An action counts as repeated only on
// a screen that did not change since (vision-session.js screenVersion).
for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { VisionSession } = await import(`../src/${build}/src/agent/vision-session.js`);
  const { canRetainPageFeedbackCalls } = await import(`../src/${build}/src/agent/page-feedback-policy.js`);

  function loopFixture({ vision = true } = {}) {
    const provider = { model: 'owned-vision-loop-fixture', supportsVision: true, chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider });
    const tab = 21;
    agent._persist = () => {};
    agent._visionRunState = () => (vision ? { active: true, coordinates: 'pixel' } : { active: false, reason: 'setting_off' });
    const session = new VisionSession();
    session.registerKeyframe({ imageWidth: 64, imageHeight: 48, cssWidth: 64, cssHeight: 48, url: 'https://shop.example/invitations' },
      new Uint8ClampedArray(64 * 48 * 4));
    agent._visionSessions = new Map([[tab, session]]);
    const ok = { success: true, dispatched: true, method: 'cdp-vision-pointer' };
    return {
      agent, tab, session, provider,
      // What a screen update showing a change records (a patch).
      changeScreen() { session.registerPatches([{ x: 0, y: 0, width: 16, height: 16 }], null); },
      click(x = 300, y = 200, result = ok) {
        const args = { x, y, coordinate_space: 'css' };
        return { loop: agent._checkLoop(tab, 'click', args, structuredClone(result)), coord: agent._checkCoordClickLoop(tab, x, y) };
      },
      call(name, args, result = { success: true }) { return agent._checkLoop(tab, name, args, structuredClone(result)); },
    };
  }
  const kinds = checks => checks.map(check => (check.coord ? `${check.loop.kind}/${check.coord.kind}` : check.kind));

  test(`${build}: a vision click repeated after the screen changed each time is progress, not a loop`, () => {
    // "Accept all 10 invitations": the list moves up and the next Accept is
    // under the same point.
    const f = loopFixture();
    const checks = [];
    for (let i = 0; i < 10; i++) { checks.push(f.click()); f.changeScreen(); }
    assert.deepEqual(kinds(checks), Array(10).fill('none/none'));
    // Enter after each typed item, each adding a row.
    const typed = loopFixture();
    const keys = [];
    for (let i = 0; i < 12; i++) {
      keys.push(typed.call('type_text', { text: `Item ${i}` }));
      keys.push(typed.call('press_keys', { key: 'Enter' }));
      typed.changeScreen();
    }
    assert.ok(keys.every(check => check.kind === 'none'), JSON.stringify(keys.filter(check => check.kind !== 'none')));
    // "Scroll down until you find it": the same wheel, a new stretch each time.
    const scrolled = loopFixture();
    const wheels = [];
    for (let i = 0; i < 12; i++) { wheels.push(scrolled.call('scroll_at', { direction: 'down', amount: 5 })); scrolled.changeScreen(); }
    assert.ok(wheels.every(check => check.kind === 'none'), JSON.stringify(wheels));
  });

  test(`${build}: a vision click repeated on a screen that does not change still adds up to a stop`, () => {
    const f = loopFixture();
    const checks = [];
    for (let i = 0; i < 8; i++) checks.push(f.click());
    assert.deepEqual(checks.map(check => check.coord.kind), ['none', 'none', 'none', 'none', 'nudge', 'nudge', 'nudge', 'stop']);
    // The repeat is named as the model called it, with vision advice.
    const nudge = checks[2].loop;
    assert.equal(nudge.kind, 'nudge');
    assert.match(nudge.warning, /click_at 3 times/);
    assert.match(nudge.warning, /screen did not change/);
    assert.doesNotMatch(nudge.warning, /selector|page\/tree/);
    // The wheel at the bottom of a page, too.
    const bottom = loopFixture();
    const wheels = [];
    for (let i = 0; i < 4; i++) wheels.push(bottom.call('scroll_at', { direction: 'down', amount: 5 }));
    assert.deepEqual(kinds(wheels), ['none', 'none', 'nudge', 'nudge']);
    // A take_screenshot of the same screen is no change: it does not reset the count.
    const looked = loopFixture();
    const before = looked.session.screenVersion;
    looked.session.registerKeyframe({ imageWidth: 64, imageHeight: 48, cssWidth: 64, cssHeight: 48, url: 'https://shop.example/invitations' },
      new Uint8ClampedArray(64 * 48 * 4), { unchanged: true });
    assert.equal(looked.session.screenVersion, before);
    // Outside a vision run the old rule stands: coordinates alone.
    const tree = loopFixture({ vision: false });
    const treeChecks = [];
    for (let i = 0; i < 8; i++) { treeChecks.push(tree.click()); tree.changeScreen(); }
    assert.equal(treeChecks.at(-1).coord.kind, 'stop');
  });

  test(`${build}: vision loop messages name click_at, the model's point and only tools the run has`, () => {
    const f = loopFixture();
    const vision = { tool: 'click_at', modelArgs: { x: 412, y: 233 } };
    const warning = f.agent._coordinateClickRecoveryWarning({ x: 300, y: 200, coordinate_space: 'css' }, new Set(['click_at', 'zoom', 'type_text']), vision);
    assert.match(warning, /\(412, 233\)/);
    assert.doesNotMatch(warning, /get_interactive_elements|get_accessibility_tree|click\(\{text|selector/);
    const stop = f.agent._coordinateClickStopMessage({ x: 300, y: 200 }, vision);
    assert.match(stop, /\(412, 233\) in the screenshot/);
    // A failed point twice: look at the screen, not the tree.
    const failed = { success: false, dispatched: false, noDispatch: true, visionCoordinateError: 'stale_image', error: 'Image p3 is from an earlier screen.' };
    f.click(300, 200, failed);
    const second = f.click(300, 200, failed).loop;
    assert.equal(second.kind, 'nudge');
    assert.match(second.warning, /click_at has failed/);
    assert.match(second.warning, /current screen/);
    assert.doesNotMatch(second.warning, /page\/tree/);
    // The retired screenshot tool points to take_screenshot.
    assert.match(f.agent._unavailableToolResult('screenshot', f.tab).error, /call take_screenshot/);
    assert.match(loopFixture({ vision: false }).agent._unavailableToolResult('screenshot', 21).error, /call inspect_viewport/);
  });

  test(`${build}: choosing from a native dropdown with click_at is never counted as a failed click`, () => {
    const f = loopFixture();
    const focused = { success: false, dispatched: false, noDispatch: true, nativeSelect: true, tag: 'SELECT', error: 'That point is a native dropdown.' };
    assert.equal(f.agent._isToolResultErroredForLoop('click', {}, focused), false);
    // Size S, M and L of one product: the same dropdown three times.
    const checks = [];
    for (let i = 0; i < 3; i++) {
      checks.push(f.click(120, 340, focused));
      f.call('type_text', { text: ['S', 'M', 'L'][i] });
      f.changeScreen();
    }
    assert.ok(checks.every(check => check.loop.kind === 'none' && check.coord.kind === 'none'), JSON.stringify(checks));
  });

  test(`${build}: a vision arrow key is not judged by a DOM snapshot`, async () => {
    const f = loopFixture();
    f.agent._keyProgressSnapshot = async () => { throw new Error('no DOM snapshot in a vision run'); };
    const response = { success: true, dispatched: true, key: 'ArrowRight' };
    assert.deepEqual(await f.agent._verifyProvisionalKeyProgress(f.tab, 'ArrowRight', response, '{"page":"same"}'), response);
  });

  test(`${build}: a look, a zoom or a pause survives page focus churn in a vision run`, () => {
    const focus = [{ kind: 'activity', source: 'page', frameId: 0, target: 'input#chat' }];
    for (const name of ['take_screenshot', 'zoom', 'wait']) {
      const args = name === 'zoom' ? { x: 10, y: 10, width: 100, height: 80 } : name === 'wait' ? { seconds: 1 } : {};
      assert.equal(canRetainPageFeedbackCalls([{ function: { name, arguments: JSON.stringify(args) } }], { runMode: 'act' }, null, focus), true, name);
    }
  });

  test(`${build}: observing a screen that stays the same adds up; a screen that changed is new evidence`, async () => {
    const f = loopFixture();
    const streak = name => f.agent._checkDeliveryObservationStreak(f.tab, name, {}, { success: true }, {});
    assert.deepEqual(['take_screenshot', 'wait', 'scroll_at', 'take_screenshot'].map(name => streak(name).kind), ['none', 'none', 'none', 'nudge']);
    // The update after the batch showed a change: the streak starts over.
    f.agent._visionObserveAfterBatchOnce = async () => ({ kind: 'patch', patches: [] });
    await f.agent._visionObserveAfterBatch(f.tab, [], () => {}, { toolCalls: [{ id: 'w1', function: { name: 'scroll_at', arguments: '{}' } }] });
    assert.equal(f.agent.deliveryObservationStreaks.has(f.tab), false);
    assert.equal(streak('wait').kind, 'none');
    // A zoom reads part of the screen; reading a dense screen takes several.
    assert.equal(f.agent.constructor.DELIVERY_OBSERVATION_TOOLS.has('zoom'), false);
  });

  test(`${build}: every vision batch ends with one screen update, however it ended`, async () => {
    const f = loopFixture();
    const observed = [];
    f.agent._visionObserveAfterBatchOnce = async (_tab, _messages, _update, { toolCalls }) => { observed.push(toolCalls); return { kind: 'none' }; };
    // A batch that leaves early (a refused done, a completion hand-back).
    f.agent._executeToolBatchInner = async () => ({ action: 'continue' });
    const calls = [{ id: 'c1', type: 'function', function: { name: 'done', arguments: '{"outcome":"success","summary":"Saved."}' } }];
    const messages = [{ role: 'assistant', content: '', tool_calls: calls }];
    await f.agent._executeToolBatch(f.tab, calls, messages, () => {}, f.provider, null, new Set(['done', 'click_at']));
    assert.equal(observed.length, 1, 'the early exit was followed by a screen update');
    // A batch that reached its own update is not observed twice.
    f.agent._executeToolBatchInner = async (tabId, toolCalls, msgs, onUpdate) => {
      await f.agent._visionObserveAfterBatch(tabId, msgs, onUpdate, { toolCalls });
      return { action: 'continue' };
    };
    await f.agent._executeToolBatch(f.tab, calls, messages, () => {}, f.provider, null, new Set(['done', 'click_at']));
    assert.equal(observed.length, 2);
    // A run that ended needs no update.
    f.agent._executeToolBatchInner = async () => ({ action: 'return', value: 'Done.' });
    await f.agent._executeToolBatch(f.tab, calls, messages, () => {}, f.provider, null, new Set(['done', 'click_at']));
    assert.equal(observed.length, 2);
  });
}

// Completion and pre-dispatch guards in a vision run: what a check written for
// tree reads, refs and selectors accepts or advises when the run has screens.
for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { resolveVisionMode } = await import(`../src/${build}/src/agent/vision-mode.js`);
  const { createCompletionInvariantState, recordCompletionToolResult } = await import(`../src/${build}/src/agent/completion-invariant.js`);
  const { getToolsForMode } = await import(`../src/${build}/src/agent/tools.js`);
  const seeing = { model: 'anthropic/claude-sonnet-4.5', supportsVision: true, chat: async () => ({ content: '{}' }) };
  const agentFor = () => {
    const agent = new Agent({ getActive: () => seeing });
    agent._persist = () => {};
    return agent;
  };

  test(`${build}: a whole-thread read and WhatsApp Web or Telegram keep the tree path; other pages stay in vision`, () => {
    assert.equal(resolveVisionMode('on', { mode: 'act', provider: seeing, completeThreadRead: true }).reason, 'complete_thread_read');
    assert.equal(resolveVisionMode('on', { mode: 'act', provider: seeing, nativeChatPage: true }).reason, 'native_chat_needs_element_inventory');
    const agent = agentFor();
    agent.visionMode = 'on';
    const tab = 31;
    assert.equal(agent._visionRunState(tab, 'act').active, true);
    agent.readCompletenessStates.set(tab, { required: true, complete: false });
    assert.equal(agent._visionRunState(tab, 'act').reason, 'complete_thread_read');
    agent.readCompletenessStates.delete(tab);
    for (const [url, tree] of [['https://web.whatsapp.com/', true], ['https://web.telegram.org/k/#@someone', true],
      ['https://telegram.org/blog', false], ['https://mail.google.com/mail/u/0/#inbox', false]]) {
      agent._lastTabUrls = new Map([[tab, url]]);
      assert.equal(agent._visionRunState(tab, 'act').active, !tree, url);
    }
  });

  test(`${build}: Gmail's result counter, which takes no target, stays in the vision tool list`, () => {
    // Offered on a Gmail result list (getGmailResultCountPolicy).
    const names = getToolsForMode('act', { tier: 'full', gmailResultCounting: true, vision: { coordinates: 'pixel' } }).map(tool => tool.function.name);
    assert.ok(names.includes('click_at') && names.includes('gmail_count_results'), names.join(','));
  });

  test(`${build}: after a vision action a zoom or a captured frame is the observation, and the refusal names what the run has`, () => {
    const acted = recordCompletionToolResult(createCompletionInvariantState('run-1'), 'click',
      { x: 40, y: 60, coordinate_space: 'css' }, { success: true, dispatched: true, method: 'cdp-vision-pointer' });
    assert.equal(acted.verificationDebt, true);
    assert.equal(recordCompletionToolResult(acted, 'zoom', { x: 0, y: 0, width: 50, height: 40 }, { success: true, image: 'z1' }).verificationDebt, false);
    // take_screenshot only asks for a frame: the capture after the batch,
    // recorded as auto_screenshot when it succeeds, is the observation.
    const asked = recordCompletionToolResult(acted, 'take_screenshot', {}, { success: true, note: 'A fresh full frame follows this result.' });
    assert.equal(asked.verificationDebt, true, 'a requested frame that was never captured verifies nothing');
    assert.equal(recordCompletionToolResult(asked, 'auto_screenshot', {}, { success: true, method: 'image_attach', _attachImage: true }).verificationDebt, false);
    // A drag is a consequential action like the drag_drop it replaces.
    const dragged = recordCompletionToolResult(createCompletionInvariantState('run-2'), 'drag_at',
      { start_x: 10, start_y: 10, end_x: 200, end_y: 10 }, { success: true, dispatched: true, method: 'synthetic-vision-drag' });
    assert.equal(dragged.verificationDebt, true);
    assert.equal(dragged.lastAction?.name, 'drag_at');
    const agent = agentFor();
    const tab = 33;
    agent._effectiveRunMode = () => 'act';
    agent.completionInvariants.set(tab, acted);
    agent._visionRunState = () => ({ active: true, coordinates: 'pixel' });
    const block = agent._completionDoneBlock(tab, 'done', { outcome: 'success', summary: 'Saved.' });
    assert.equal(block?.reason, 'verification_required', JSON.stringify(block));
    assert.match(block.error, /screen update/);
    assert.match(block.error, /take_screenshot/);
    assert.doesNotMatch(block.error, /get_accessibility_tree|verify_form/);
  });

  test(`${build}: a status text on screen is recorded with the update while a submission waits for proof`, async () => {
    const agent = agentFor();
    const tab = 32;
    const recorded = [];
    agent._recordCompletionToolResult = (_tab, name, _args, result) => recorded.push({ name, result });
    let reads = 0;
    agent._completionLiveStatusMessages = async () => { reads++; return ['Profile saved']; };
    await agent._visionRecordObservation(tab, 'https://app.example/settings');
    assert.equal(reads, 0, 'nothing to prove, nothing read');
    assert.equal(recorded[0].result.statusMessages, undefined);
    agent._completionSubmitStates.set(tab, { dispatched: true, submitLike: true });
    await agent._visionRecordObservation(tab, 'https://app.example/settings');
    assert.deepEqual(recorded[1].result.statusMessages, ['Profile saved']);
    assert.ok(agent._completionObservedStatusTexts('auto_screenshot', recorded[1].result).includes('Profile saved'));
  });

  test(`${build}: the opening frame is the run's first look at the page`, async () => {
    const agent = agentFor();
    agent._visionRunState = () => ({ active: true, coordinates: 'pixel' });
    agent._visionPushKeyframe = async () => ({ id: 'f1' });
    const marked = [];
    agent._markPlanExecutionToolCall = (_tab, name, result) => marked.push({ name, success: result?.success });
    await agent._visionEnsureKeyframe(35, [], () => {}, { mode: 'act' });
    assert.deepEqual(marked, [{ name: 'take_screenshot', success: true }]);
  });

  test(`${build}: a pending CAPTCHA gate gets WebBrain's own root read before a vision action`, async () => {
    const agent = agentFor();
    const tab = 34;
    agent._visionRunState = () => ({ active: true, coordinates: 'pixel' });
    agent._observeAwsWafGate = async () => null;
    agent._captchaGateForTools = () => ({ status: 'verification_pending' });
    agent._shouldRetryCaptchaManualGate = () => false;
    const reads = [];
    agent.executeTool = async (_tab, name, args) => { reads.push({ name, args }); return { success: true, pageContent: 'main "Checkout"' }; };
    const observed = [];
    agent._observeCaptchaChallenge = async (_tab, name, result, args) => { observed.push({ name, args, result }); return { gate: null }; };
    assert.equal(await agent._inspectCaptchaBeforeMutation(tab, 'click', { x: 10, y: 20, coordinate_space: 'css' }), null);
    assert.deepEqual(reads.map(read => read.name), ['get_accessibility_tree']);
    assert.equal(observed[0]?.name, 'get_accessibility_tree');
    assert.equal(observed[0].args.maxDepth, 15, 'an authoritative root read');
    // Outside a vision run the model makes that read with its tree tool.
    agent._visionRunState = () => ({ active: false });
    await agent._inspectCaptchaBeforeMutation(tab, 'click', { selector: '#buy' });
    assert.equal(reads.length, 1);
  });

  test(`${build}: the rich-text toolbar check keeps a vision click on the vision dispatch`, async () => {
    const agent = agentFor();
    const tab = 36;
    agent._visionRunState = () => ({ active: true, coordinates: 'pixel' });
    agent._richTextToolbarGuard = { ...agent._richTextToolbarGuard, hasPending: () => true,
      evaluateProbe: () => ({ guarded: true }), blockRef: () => null };
    agent._probeRichTextToolbarRetryTarget = async () => ({ resolved: true, dispatchBinding: { token: 'bound-1', frameId: 0 } });
    const released = [];
    agent._releaseRichTextToolbarProbeTarget = async (_tab, probe) => released.push(probe);
    const context = {};
    assert.equal(await agent._richTextToolbarToolBlock(tab, 'click', { x: 10, y: 20, coordinate_space: 'css' }, context), null);
    assert.equal(context.dispatchBinding, undefined, 'not routed through the content click');
    assert.equal(released.length, 1);
  });
}

test('chrome: a vision click result is not judged by a DOM text snapshot', async () => {
  const { Agent } = await import('../src/chrome/src/agent/agent.js');
  const provider = { model: 'anthropic/claude-sonnet-4.5', supportsVision: true, chat: async () => ({ content: '{}' }) };
  const agent = new Agent({ getActive: () => provider });
  const tab = 41;
  agent._visionRunState = () => ({ active: true, coordinates: 'pixel' });
  agent._visionClickPreflight = async () => ({ target: { tag: 'canvas' } });
  agent._visionMutationBindingBlock = async () => null;
  agent._clickProgressSnapshot = async () => { throw new Error('a vision click takes no DOM progress snapshot'); };
  agent._redirectTargetBlankClick = async () => null;
  agent._visionPlatformLateTab = async () => null;
  agent._showAgentTarget = () => {};
  const saved = { attach: cdpClient.attach, sendCommand: cdpClient.sendCommand, arm: cdpClient.armFileInputClickGuard, consume: cdpClient.consumeFileInputClickGuard };
  const savedTabs = globalThis.chrome?.tabs;
  globalThis.chrome = { ...(globalThis.chrome || {}), tabs: { ...(savedTabs || {}), query: async () => [{ id: tab }],
    onCreated: { addListener() {}, removeListener() {} }, onUpdated: { addListener() {}, removeListener() {} } } };
  cdpClient.attach = async () => {};
  cdpClient.sendCommand = async () => ({});
  cdpClient.armFileInputClickGuard = async () => {};
  cdpClient.consumeFileInputClickGuard = async () => null;
  try {
    // A canvas game: the same point twice, the DOM text unchanged.
    for (let i = 0; i < 2; i++) {
      const result = await agent._visionDispatchClick(tab, { x: 200, y: 150, coordinate_space: 'css' }, { vision: { tool: 'click_at', button: 'left', clickCount: 1 } });
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal(result.noProgress, undefined);
    }
  } finally {
    Object.assign(cdpClient, { attach: saved.attach, sendCommand: saved.sendCommand, armFileInputClickGuard: saved.arm, consumeFileInputClickGuard: saved.consume });
    if (savedTabs) globalThis.chrome.tabs = savedTabs;
  }
});
