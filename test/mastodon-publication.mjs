import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = { storage: { local: storage, session: storage }, scripting: {}, tabs: {},
  runtime: { getURL: value => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${value}` } };
globalThis.chrome = api; globalThis.browser = api;
const hash = text => createHash('sha256').update(text).digest('hex');
const origin = 'https://mastoturk.org', url = `${origin}/home`, account = `${origin}/@owned_qa`;
const body = 'A complete literal post with  two spaces and Turkish ıİşŞğĞüÜ.\nThis exact second line extends the body beyond one hundred twenty characters.';
const task = `Use password "not-post-secret" to log in to owned_qa. Publish exactly one public plain post: ${body}\nDo not post the password or anything else.`;
const raw = { kind: 'exact_plain_public_post', body: { source: 'task', start: body.slice(0, 28), end: body.slice(-30) },
  account: { source: 'task', start: 'owned_qa', end: 'owned_qa' } };
  const snapshot = () => ({ url, origin, documentIdentity: 'native-document', axDocumentToken: 'ax-original', capturedAt: 100000,
  activeAccount: account, composer: body, publicVisibility: true, plain: true, pending: false, otp: false,
  targetMatches: true, records: [{ id: '100', account, text: body, url: `${account}/100`, public: true, plain: true, createdAt: new Date(90000).toISOString() }] });
const context = () => ({ taskKey: 'task-key', runToken: 'current-run', sourceSha256: hash(task), bodySha256: hash(body),
  actionSequence: 8, observedAfterSubmit: true, verificationDebt: false, pageUrl: url, currentUrl: url });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const build of ['chrome', 'firefox']) {
  const module = await import(`../src/${build}/src/agent/mastodon-publication.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const intent = () => module.normalizeMastodonPublicationIntent(raw, task, origin);
  const binding = () => module.mastodonPublicationBinding(intent(), snapshot(), context());
  const published = () => ({ ...snapshot(), composer: '', capturedAt: 100100, records: [...snapshot().records,
    { id: '200', account, text: body, url: `${account}/200`, public: true, plain: true, createdAt: new Date(100050).toISOString() }] });
  const receipt = (proof = binding(), page = published(), ctx = context()) => module.mastodonPublicationReceipt(proof, page, ctx, hash);

  test(`${build}: anchored intent preserves complete literal bytes and excludes surrounding credentials`, () => {
    assert.deepEqual(intent(), { body, account });
    assert.ok(intent().body.length > 120); assert.ok(!intent().body.includes('not-post-secret'));
    assert.equal(module.mastodonAccountIdentity('@owned_qa@mastoturk.org', origin), account);
    assert.equal(module.mastodonAccountIdentity('https://other.test/@owned_qa', origin), '');
    assert.equal(module.mastodonAccountIdentity('owned_qa@other.test', origin), '');
  });
  test(`${build}: unsupported, invented, ambiguous and non-task anchors produce no receipt contract`, () => {
    for (const candidate of [{ ...raw, kind: 'unsupported' }, { ...raw, extra: true },
      { ...raw, body: { ...raw.body, start: 'invented post content' } },
      { ...raw, body: { ...raw.body, source: 'page' } }, { ...raw, account: { ...raw.account, start: 'invented-account' } }])
      assert.equal(module.normalizeMastodonPublicationIntent(candidate, task, origin), null);
    assert.equal(module.normalizeMastodonPublicationIntent(raw, task + body, origin), null, 'Repeated unqualified anchors must be rejected.');
    const messages = module.mastodonPublicationIntentMessages(task);
    assert.match(messages[0].content, /generated\/ambiguous body/); assert.equal(JSON.parse(messages[1].content).task, task);
  });
  test(`${build}: binding requires exact full draft, native public plain composer and active account`, () => {
    assert.ok(binding());
    for (const patch of [{ composer: body.slice(0, 120) }, { composer: body.replace('  ', ' ') },
      { activeAccount: `${origin}/@other` }, { targetMatches: false }, { pending: true }, { otp: true },
      { plain: false }, { publicVisibility: false }])
      assert.equal(module.mastodonPublicationBinding(intent(), { ...snapshot(), ...patch }, context()), null);
  });
  test(`${build}: exact newly created status proves publication while retaining an old same-body row`, () => {
    const result = receipt(); assert.equal(result.messageId, '200'); assert.equal(result.bodySha256, hash(body));
    assert.equal(result.permalink, `${account}/200`); assert.equal(result.actionSequence, 8);
  });
  test(`${build}: old, unrelated, wrong-account, private and media status cannot satisfy the current dispatch`, () => {
    const existing = published();
    assert.equal(receipt(binding(), { ...existing, records: snapshot().records }), null);
    for (const patch of [{ id: '99' }, { text: 'An unrelated new post' }, { text: body.replace('  ', ' ') },
      { account: `${origin}/@other` }, { public: false }, { plain: false }]) {
      const page = published(); page.records[1] = { ...page.records[1], ...patch };
      assert.equal(receipt(binding(), page), null);
    }
    const duplicate = published(); duplicate.records.push({ ...duplicate.records[1], id: '201', url: `${account}/201` });
    assert.equal(receipt(binding(), duplicate), null, 'Two new matching statuses are not proof of exactly one post.');
  });
  test(`${build}: task, run, exact source, URL, observation and pending composer all bind terminal proof`, () => {
    for (const patch of [{ taskKey: 'old-task' }, { runToken: 'old-run' }, { sourceSha256: hash('wrong task') },
      { actionSequence: 0 }, { observedAfterSubmit: false }, { verificationDebt: true },
      { pageUrl: `${origin}/other` }, { currentUrl: `${origin}/other` }])
      assert.equal(receipt(binding(), published(), { ...context(), ...patch }), null);
    for (const patch of [{ activeAccount: `${origin}/@other` }, { composer: body }, { pending: true }, { otp: true },
      { origin: 'https://other.test' }, { plain: false }, { publicVisibility: false }])
      assert.equal(receipt(binding(), { ...published(), ...patch }), null);
  });
  test(`${build}: empty baseline requires native creation time after capture, never a remounted old row`, () => {
    const start = snapshot(); start.records = [];
    const proof = module.mastodonPublicationBinding(intent(), start, context());
    const page = published(); page.records = [page.records[1]];
    assert.ok(receipt(proof, page));
    for (const createdAt of ['', new Date(90000).toISOString(), 'not a date']) {
      page.records[0].createdAt = createdAt; assert.equal(receipt(proof, page), null);
    }
  });
  test(`${build}: document replacement requires the new native permalink and fresh creation timestamp`, () => {
    const page = { ...published(), documentIdentity: 'replacement-document' };
    assert.equal(receipt(binding(), page), null, 'A same-URL replacement cannot borrow prior document evidence.');
    page.url = `${account}/200`;
    const ctx = { ...context(), pageUrl: page.url, currentUrl: page.url };
    assert.ok(receipt(binding(), page, ctx));
    page.records[1].createdAt = ''; assert.equal(receipt(binding(), page, ctx), null);
  });
  test(`${build}: full own-profile navigation needs a successful current action and matching fresh AX document`, () => {
    const proof = binding();
    const navigation = module.mastodonPublicationNavigation(proof, 'navigate', { url: account },
      { success: true, dispatched: true, verified: true, currentUrl: account }, { ...context(), actionSequence: 10 });
    assert.ok(navigation);
    proof.verificationNavigation = { ...navigation, documentToken: 'ax-new-profile' };
    const page = { ...published(), url: account, documentIdentity: 'full-profile-navigation', axDocumentToken: 'ax-new-profile' };
    const ctx = { ...context(), pageUrl: account, currentUrl: account };
    assert.ok(receipt(proof, page, ctx));
    for (const patch of [{ documentToken: '' }, { documentToken: 'stale-document' }, { actionSequence: 8 }, { url }]) {
      const invalid = { ...proof, verificationNavigation: { ...proof.verificationNavigation, ...patch } };
      assert.equal(receipt(invalid, page, ctx), null);
    }
    for (const result of [{ success: false, dispatched: true, verified: true }, { success: true, noDispatch: true, verified: true },
      { success: true, dispatched: true, verified: false }, { success: true, dispatched: true, verified: true, currentUrl: `${origin}/@other` }])
      assert.equal(module.mastodonPublicationNavigation(proof, 'navigate', { url: account }, result, { ...context(), actionSequence: 10 }), null);
  });
  test(`${build}: a previously unseen remounted old row above the visible ID floor cannot fake delivery`, () => {
    const page = published(); page.records[1].createdAt = new Date(90000).toISOString();
    assert.equal(receipt(binding(), page), null);
  });

  function agent() {
    const run = Object.create(Agent.prototype), guard = { enabled: true, taskKey: 'task-key', requiresSubmission: true, requiresStateChange: true };
    const completion = { runToken: 'current-run', sequence: 9, verificationDebt: false, lastAction: { sequence: 8 }, lastObservation: { sequence: 9 } };
    const provider = { chat() {}, model: 'owned-model', config: {} }, signal = new AbortController();
    run._planExecutionGuards = new Map([[1, guard]]); run.completionInvariants = new Map([[1, completion]]);
    run._completionSubmitStates = new Map(); run.currentCostState = new Map();
    run._progressTaskAnchorText = () => task; run._progressTaskKeyHash = () => 'task-key';
    run._sha256TextSync = hash; run._activeProvider = () => provider; run._providerMaxOutputTokens = () => 4096;
    run._runAbortSignal = () => signal.signal; run._checkAbort = () => signal.signal.aborted;
    run._hasUnvalidatedSteering = () => false; run._isCostAllowanceError = () => false;
    run._captureNativeMastodonPublication = async () => snapshot();
    return { run, guard, completion, provider, signal };
  }
  test(`${build}: supported selected provider compiles once and full dispatch snapshot binds exact intent`, async () => {
    const { run, provider } = agent(); let calls = 0;
    run._chatWithCostAllowance = async (_provider, messages, options) => {
      calls++; assert.equal(_provider, provider); assert.equal(options.maxTokens, 1024); assert.ok(options.signal);
      assert.equal(JSON.parse(messages[1].content).task, task); return { content: JSON.stringify(raw) };
    };
    const first = { isSubmit: true, url }, second = { isSubmit: true, url };
    await run._captureMastodonPublicationAttempt(1, 'click_ax', { ref_id: 'ref_1' }, first, provider);
    await run._captureMastodonPublicationAttempt(1, 'click_ax', { ref_id: 'ref_1' }, second, provider);
    assert.equal(calls, 1); assert.equal(first.mastodonPublication.bodySha256, hash(body)); assert.ok(second.mastodonPublication);
    assert.ok(!JSON.stringify(first.mastodonPublication).includes('not-post-secret'));
  });
  test(`${build}: Stop and accepted steering revoke compiler response and prevent late proof capture`, async () => {
    for (const mode of ['stop', 'steer', 'new-task', 'new-provider', 'changed-provider-config', 'changed-guard']) {
      const { run, provider, signal } = agent(), pending = deferred(), detected = { isSubmit: true, url };
      let snapshots = 0;
      run._captureNativeMastodonPublication = async () => { snapshots++; return snapshot(); };
      run._chatWithCostAllowance = () => pending.promise;
      const captured = run._captureMastodonPublicationAttempt(1, 'click_ax', { ref_id: 'ref_1' }, detected, provider);
      await Promise.resolve();
      if (mode === 'stop') signal.abort(new Error('User stopped'));
      if (mode === 'steer') run._hasUnvalidatedSteering = () => true;
      if (mode === 'new-task') run._progressTaskAnchorText = () => task + '\nRevised';
      if (mode === 'new-provider') run._activeProvider = () => ({ ...provider });
      if (mode === 'changed-provider-config') provider.model = 'different-model';
      if (mode === 'changed-guard') run._planExecutionGuards.set(1, { enabled: true });
      pending.resolve({ content: JSON.stringify(raw) });
      if (mode === 'stop') await assert.rejects(captured, /User stopped/); else await captured;
      assert.equal(detected.mastodonPublication, undefined); assert.equal(snapshots, 0);
    }
  });
  test(`${build}: steering during the native snapshot cannot retain an old-task attempt`, async () => {
    const { run, provider } = agent(), pending = deferred(), detected = { isSubmit: true, url };
    run._chatWithCostAllowance = async () => ({ content: JSON.stringify(raw) });
    run._captureNativeMastodonPublication = () => pending.promise;
    const capturing = run._captureMastodonPublicationAttempt(1, 'click_ax', { ref_id: 'ref_1' }, detected, provider);
    await new Promise(resolve => setImmediate(resolve));
    run._hasUnvalidatedSteering = () => true; pending.resolve(snapshot()); await capturing;
    assert.equal(detected.mastodonPublication, undefined);
  });
  test(`${build}: ordinary X/Bluesky and non-submit controls keep their existing contracts`, async () => {
    const { run, provider } = agent();
    run._chatWithCostAllowance = () => { throw new Error('Must not call publication compiler'); };
    for (const page of ['https://x.com/home', 'https://bsky.app/', url]) {
      const detected = { isSubmit: page !== url, url: page };
      await run._captureMastodonPublicationAttempt(1, 'click_ax', { ref_id: 'ref_1' }, detected, provider);
      assert.equal(detected.mastodonPublication, undefined);
    }
  });
  test(`${build}: failed, denied, no-dispatch and superseded sends cannot create native submit proof`, () => {
    for (const result of [{ success: false, error: 'rejected' }, { success: true, noDispatch: true },
      { success: true, dispatched: false }, { success: true, formValidationFailed: true }]) {
      const { run } = agent(); run._workflowSubmitBindingForAttempt = () => null;
      const state = run._recordCompletionSubmitAttempt(1, { isSubmit: true, url, mastodonPublication: binding() }, 'click_ax', {}, url, url, result);
      assert.equal(state.mastodonPublication, null); assert.equal(state.observedAfterSubmit, false);
    }
    const { run } = agent(); run._workflowSubmitBindingForAttempt = () => null; run._hasUnvalidatedSteering = () => true;
    const state = run._recordCompletionSubmitAttempt(1, { isSubmit: true, url, mastodonPublication: binding() }, 'click_ax', {}, url, url, { success: true });
    assert.equal(state.mastodonPublication, null);
  });
  test(`${build}: fresh native proof rejects late task/steering changes and disappeared post`, async () => {
    const { run } = agent();
    run._completionSubmitStates.set(1, { mastodonPublication: binding(), dispatched: true, actionSequence: 8, observedAfterSubmit: true, currentUrl: url });
    run._captureNativeMastodonPublication = async () => published(); assert.ok(await run._freshMastodonPublicationEvidence(1, url));
    run._captureNativeMastodonPublication = async () => ({ ...published(), records: snapshot().records });
    assert.equal(await run._freshMastodonPublicationEvidence(1, url), null);
    const pending = deferred(); run._captureNativeMastodonPublication = () => pending.promise;
    const capture = run._freshMastodonPublicationEvidence(1, url); run._hasUnvalidatedSteering = () => true;
    pending.resolve(published()); assert.equal(await capture, null);
  });
  test(`${build}: native DOM capture uses the actual supported top-frame browser API`, async () => {
    const run = Object.create(Agent.prototype);
    const oldChrome = api.scripting.executeScript, oldFirefox = api.tabs.executeScript;
    let calls = 0;
    api.scripting.executeScript = async options => { assert.equal(build, 'chrome'); assert.deepEqual(options.target, { tabId: 1, frameIds: [0] }); calls++; return [{ frameId: 0, result: snapshot() }]; };
    api.tabs.executeScript = async (tabId, options) => { assert.equal(build, 'firefox'); assert.equal(tabId, 1); assert.equal(options.frameId, 0); assert.match(options.code, /captureNativeMastodonPublication/); calls++; return [snapshot()]; };
    try { assert.deepEqual(await run._captureNativeMastodonPublication(1), snapshot()); assert.equal(calls, 1); }
    finally { api.scripting.executeScript = oldChrome; api.tabs.executeScript = oldFirefox; }
  });
}
