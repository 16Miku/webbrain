import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const url = 'https://huggingface.co/join';
const credentials = 'textbox "Email Address" [email] field_name="email"\ntextbox "Password" [password] field_name="password"';
const profile = 'textbox "Username" [username] field_name="username"\ntextbox "Full name" [fullname] field_name="fullname"';

for (const build of ['chrome', 'firefox']) {
  const { advanceHuggingFaceSignupRecovery: advance, normalizeHuggingFaceSignupRecovery: normalize,
    huggingFaceSignupRecoveryNote: note, huggingFaceSignupUrl } = await import(`../src/${build}/src/agent/huggingface-signup-recovery.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { getActiveAdapter } = await import(`../src/${build}/src/agent/adapters.js`);
  function flow() {
    let state = null;
    const step = (name, args = {}, result = {}, extra = {}) => {
      state = advance(state, { url, taskKey: 'task-1', name, args, result, ...extra });
      return state;
    };
    const read = (pageContent, extra = {}, args = { filter: 'visible' }) => step('get_accessibility_tree', args, { pageContent }, extra);
    return { step, read, state: () => state };
  }
  const fillProfile = f => {
    f.read(profile);
    f.step('set_field', { text: 'private profile value' }, { success: true, verified: true, fieldMeta: { name: 'username' } });
    f.step('upload_file', { downloadId: 1971, filePath: '/private/avatar.webp', selector: '#old-input' },
      { success: true, attachmentState: 'input_attached' });
    f.step('click_ax', {}, { success: true }, { submitted: true });
  };

  test(`${build}: signup recovery is confined to actual Hugging Face signup URLs`, () => {
    assert.equal(huggingFaceSignupUrl(url + '?next=/settings'), url);
    assert.equal(huggingFaceSignupUrl('https://www.huggingface.co/join/'), 'https://www.huggingface.co/join');
    for (const value of ['https://huggingface.co.evil.test/join', 'https://evil.test/?next=https://huggingface.co/join',
      'https://huggingface.co/settings/profile', 'https://huggingface.co/me', 'https://huggingface.co/model/upload/main',
      'https://huggingface.co:8443/join', 'https://user@huggingface.co/join', 'not a URL']) {
      assert.equal(huggingFaceSignupUrl(value), '', value);
      assert.equal(advance(null, { url: value, taskKey: 'task', name: 'get_accessibility_tree', args: { filter: 'visible' }, result: { pageContent: profile } }), null);
    }
  });

  test(`${build}: challenge-free signup never receives recovery or reload instructions`, () => {
    const f = flow();
    assert.equal(note(f.read(credentials)), '');
    fillProfile(f);
    assert.equal(note(f.state()), '');
    assert.equal(note(f.read('paragraph "CAPTCHA, human verification, country, name"\n' + credentials)), '');
    assert.equal(f.state().recovering, false);
    assert.equal(f.state().interrupted, false);
  });

  test(`${build}: observed CAPTCHA followed by a preserved form does not restart signup`, () => {
    const f = flow(); fillProfile(f);
    f.read('heading "Human verification"', { gate: { status: 'solve_required', selectedType: 'hcaptcha' } });
    assert.equal(f.state().interrupted, true);
    f.step('solve_captcha', { type: 'hcaptcha' }, { success: true }, { gate: { status: 'verification_pending' } });
    assert.match(note(f.state()), /Only perform a recovery reload when the runtime explicitly requests it/);
    f.read(profile, { gate: { status: 'cleared' } });
    assert.equal(f.state().recovering, false);
    assert.match(note(f.state()), /continue the existing form/);
    assert.match(note(f.state()), /Do not restart signup or reload/);
  });

  test(`${build}: hCaptcha then AWS and a confirmed reset retain the profile checkpoint`, () => {
    const f = flow(); fillProfile(f);
    f.step('solve_captcha', { type: 'hcaptcha' }, { success: true }, { gate: { status: 'verification_pending' } });
    f.read('heading "Let us confirm you are human"', { gate: { status: 'cleared' } });
    f.step('solve_captcha', { type: 'aws_waf' }, { success: true, cookiesUpdated: 1 }, { gate: { status: 'verification_pending' } });
    f.step('navigate', { url }, { success: true });
    assert.equal(f.state().recovering, false, 'navigation alone cannot prove a reset');
    f.read(credentials, { gate: { status: 'cleared' } });
    assert.equal(f.state().recovering, true);
    assert.deepEqual(f.state().fields, ['username']);
    assert.deepEqual(f.state().avatar, { downloadId: 1971 });
    assert.match(note(f.state()), /Earlier Create Account|earlier Create Account/);
    assert.match(note(f.state()), /reconcile any signed-in, verification-pending, or already-registered evidence/);
    assert.match(note(f.state()), /restore only missing requested details/);
    assert.doesNotMatch(JSON.stringify(f.state()), /private profile value|private\/avatar|old-input/);
    f.read(profile);
    assert.equal(f.state().stage, 'profile');
    assert.match(note(f.state()), /reattach the original avatar only if absent/);
    assert.equal(f.step('navigate', {}, { success: true }, { url: 'https://huggingface.co/settings/profile' }), null);
  });

  test(`${build}: manual verification can resume, while scoped or failed reads cannot prove a reset`, () => {
    const f = flow(); fillProfile(f);
    f.read('heading "Challenge"', { gate: { status: 'manual_required' } });
    assert.equal(f.state().challengeActive, true);
    f.read(credentials);
    assert.equal(f.state().recovering, false, 'do not ignore an active CAPTCHA gate');
    for (const args of [{ filter: 'visible', ref_id: 'frame' }, { filter: 'visible', page: 2 }, { filter: 'visible', frameId: 4 }, { filter: 'all' }, {}]) {
      f.read(credentials, { gate: { status: 'cleared' } }, args);
      assert.equal(f.state().recovering, false);
    }
    f.step('get_accessibility_tree', { filter: 'visible' }, { success: false, pageContent: credentials });
    f.step('get_accessibility_tree', { filter: 'visible' }, { error: 'read failed', pageContent: credentials });
    assert.equal(f.state().recovering, false);
    f.read(credentials, { gate: { status: 'cleared' } });
    assert.equal(f.state().recovering, true);
  });

  test(`${build}: a different task, expired checkpoint or other site cannot inherit signup recovery`, () => {
    const f = flow(); fillProfile(f);
    f.read('heading "Challenge"', { gate: { status: 'solve_required' } });
    const saved = f.state();
    assert.equal(normalize({ ...saved, updatedAt: Date.now() - 7 * 60 * 60 * 1000 }), null);
    assert.deepEqual(normalize({ ...saved, fields: ['password', 'token', 'password'], password: 'secret', avatar: { attachmentId: 'bad ] instruction' } }).fields, ['password']);
    assert.equal(normalize({ ...saved, avatar: { attachmentId: 'bad ] instruction' } }).avatar, null);
    f.read(credentials, { taskKey: 'task-2', gate: { status: 'cleared' } });
    assert.equal(f.state().interrupted, false); assert.equal(f.state().avatar, null);
    assert.equal(note(f.state()), '');
    assert.equal(f.step('navigate', {}, {}, { url: 'https://other.test/join' }), null);
  });

  test(`${build}: saved checkpoint survives worker restart and continuation, and respects the adapter setting`, async t => {
    const stored = {};
    const apiName = build === 'chrome' ? 'chrome' : 'browser';
    const prior = globalThis[apiName];
    globalThis[apiName] = { tabs: { get: async () => ({ url }) }, storage: { session: {
      get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, structuredClone(value)),
    } } };
    t.after(() => { globalThis[apiName] = prior; });
    const agent = new Agent({ getActive: () => ({ promptTier: 'full' }) });
    agent.useSiteAdapters = true;
    agent.conversations.set(1, [{ role: 'system', content: 'test' }, { role: 'user', content: 'Create my requested Hugging Face account and profile.' }]);
    agent.conversationIds.set(1, 'test-conversation');
    const observe = (name, args, result, gate) => agent._observeHuggingFaceSignupRecovery(1, name, args, result, gate);
    assert.equal(await observe('get_accessibility_tree', { filter: 'visible' }, { pageContent: profile }), '');
    await observe('upload_file', { attachmentId: 'attachment_1' }, { success: true, attachmentState: 'input_attached' });
    await observe('solve_captcha', {}, { success: true }, { status: 'verification_pending' });
    assert.equal((await agent._persistNow(1)).ok, true);
    assert.ok(stored[agent._convKey(1)].huggingFaceSignupRecovery);
    const restored = new Agent({ getActive: () => ({ promptTier: 'full' }) });
    restored.useSiteAdapters = true;
    await restored._hydrate(1);
    restored.conversations.get(1).push({ role: 'user', content: 'continue' });
    const recovery = await restored._observeHuggingFaceSignupRecovery(1, 'get_accessibility_tree', { filter: 'visible' }, { pageContent: credentials }, { status: 'cleared' });
    assert.match(recovery, /returned to the credentials step/);
    assert.match(recovery, /attachment_1/);
    restored.useSiteAdapters = false;
    assert.equal(await restored._observeHuggingFaceSignupRecovery(1, 'get_accessibility_tree', { filter: 'visible' }, { pageContent: credentials }), '');
    assert.equal(restored._huggingFaceSignupRecoveries.has(1), false);
  });

  test(`${build}: a CAPTCHA preflight interruption reaches the model again after manual recovery`, async () => {
    const agent = new Agent({ getActive: () => ({ promptTier: 'full' }) });
    agent.useSiteAdapters = true;
    agent.conversationModes.set(1, 'act');
    agent._persist = () => {};
    agent._ensureGateSetting = async () => {};
    agent._skipPermissionGate = true;
    agent._currentUrl = async () => url;
    const messages = [{ role: 'system', content: 'test' }, { role: 'user', content: 'Create my requested Hugging Face account and profile.' }];
    agent.conversations.set(1, messages);
    await agent._observeHuggingFaceSignupRecovery(1, 'get_accessibility_tree', { filter: 'visible' }, { pageContent: profile });
    agent._captchaMutationPreflight = async () => {
      const publicGate = { status: 'manual_required' };
      agent._captchaGateStates.set(1, { key: url + '\nchallenge', pageUrl: url, status: 'manual_required', publicGate });
      return publicGate;
    };
    const call = (name, args) => agent._executeToolBatch(1, [{ id: name, function: { name, arguments: JSON.stringify(args) } }],
      messages, () => {}, { supportsVision: false }, '', new Set([name]), 1);
    const blocked = await call('click_ax', { ref_id: 'create-account' });
    assert.equal(blocked.status, 'captcha_manual_required');
    assert.equal(agent._huggingFaceSignupRecoveries.get(1).interrupted, true);
    assert.match(messages.find(m => m.tool_call_id === 'click_ax').content, /HUGGING FACE SIGNUP RECOVERY/);
    // A fresh read confirms manual completion and the returned credentials
    // form. Exercise the real batch hook and model-visible result, not only
    // the pure checkpoint helper.
    agent._captchaMutationPreflight = async () => null;
    agent._observeCaptchaChallenge = async () => {
      agent._captchaGateStates.delete(1);
      return { gate: { status: 'cleared' }, loopCheck: { kind: 'none' } };
    };
    agent.executeTool = async () => ({ pageUrl: url, pageContent: credentials });
    const resumed = await call('get_accessibility_tree', { filter: 'visible' });
    assert.equal(resumed.action, 'continue');
    assert.match(messages.find(m => m.tool_call_id === 'get_accessibility_tree').content, /returned to the credentials step/);
  });

  test(`${build}: Hugging Face adapter keeps upload guidance and conditional signup within eight bullets`, () => {
    const adapter = getActiveAdapter(url);
    assert.equal(adapter.name, 'huggingface');
    assert.equal(adapter.notes.split('\n').filter(line => line.startsWith('- ')).length, 8);
    assert.match(adapter.notes, /never assume one from a person's name, country, IP, or geography/);
    assert.match(adapter.notes, /Only when an actual CAPTCHA interrupts signup/);
    assert.match(adapter.notes, /A filename chip.*staged only/);
  });
}

test('signup recovery implementation stays mirrored', async () => {
  assert.equal(await readFile('src/chrome/src/agent/huggingface-signup-recovery.js', 'utf8'),
    await readFile('src/firefox/src/agent/huggingface-signup-recovery.js', 'utf8'));
});
