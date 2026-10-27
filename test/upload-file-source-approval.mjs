// upload_file puts a local file into a page input, and the page can read the
// File the moment it lands. The permission gate therefore approves the exact
// file and host: a file the user attached or this run downloaded keeps the
// ordinary gate, any other local file is asked about one call at a time, even
// with permission prompts off, and a run that cannot show the card refuses it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const PAGE = 'https://forms.example.test/apply';
const HOST = 'forms.example.test';
const TAB = 4410;
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const downloads = new Map();
const search = (query, callback) => {
  const items = downloads.has(query?.id) ? [downloads.get(query.id)] : [];
  if (typeof callback === 'function') { callback(items); return undefined; }
  return Promise.resolve(items);
};
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}` },
  tabs: { get: async id => ({ id, url: PAGE }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
  downloads: { search },
};

// 7 is this run's own download; 41 is an older download the user once saved.
downloads.set(7, { id: 7, state: 'complete', filename: '/home/user/Downloads/report.pdf', url: 'https://files.example.test/report.pdf' });
downloads.set(41, { id: 41, state: 'complete', filename: '/home/user/Downloads/tax-return.pdf', url: 'https://bank.example.test/statement.pdf' });

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { Capability, uploadApprovalCard } = await import(`../src/${build}/src/agent/permission-gate.js`);

  function harness({ gateOff = false, unattended = false } = {}) {
    const provider = { promptTier: 'full', supportsVision: false };
    const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
    agent._skipPermissionGate = gateOff; agent._ensureGateSetting = async () => gateOff;
    agent._chromeProtectedPageFailure = async () => null;
    agent._captchaMutationPreflight = async () => null;
    agent._adoptLiveSocialPublishWorkflow = async () => false;
    agent._workflowPreSubmitDispatchBlock = async () => null;
    agent._messageRecipientGuardBlock = async () => null;
    agent._detectLikelySubmitAction = async () => null;
    agent._isFormValidationCandidate = () => false;
    agent._preflightRichTextToolbarTarget = async () => ({ block: null });
    agent._socialPublicationPreSubmitBlock = async () => null;
    agent._auditRichTextToolbarTarget = async () => {};
    agent._shouldAutoScreenshot = () => false;
    agent._persist = () => {};
    agent._currentUrl = async () => PAGE;
    agent._refreshPageFeedbackForCall = async () => false;
    if (unattended) agent.scheduledRunPolicies.set(TAB, { requireConsequentialConfirmation: false });
    agent._rememberRunDownloads?.(TAB, 'download_files', { success: true, downloads: [{ success: true, downloadId: 7 }] });
    const state = { prompts: [], dispatched: [], messages: [], answer: 'once' };
    agent._promptPermission = async (_tab, capability, host, _update, upload) => {
      state.prompts.push({ capability, host, upload });
      return state.answer;
    };
    agent.executeTool = async (_tab, name, args, _update, context) => {
      state.dispatched.push({ name, args, uploadSourceKey: context?.uploadSourceKey });
      return { success: true, attached: { name: 'file', size: 1 }, attachmentState: 'input_attached', verified: false, remoteStateVerified: false };
    };
    let sequence = 0;
    state.upload = args => agent._executeToolBatch(TAB, [{ id: `upload-${++sequence}`,
      function: { name: 'upload_file', arguments: JSON.stringify({ selector: '#resume', ...args }) } }],
    state.messages, () => {}, provider, null, new Set(['upload_file']), sequence, {});
    state.lastResult = () => JSON.parse(state.messages.filter(message => message.role === 'tool').at(-1).content);
    state.agent = agent;
    return state;
  }

  test(`${build}: with permission prompts off, an older download still needs approval of that exact file`, async () => {
    const h = harness({ gateOff: true });
    h.answer = 'deny';
    await h.upload({ downloadId: 41 });
    assert.equal(h.prompts.length, 1, 'turning prompts off does not approve a file from outside the run');
    assert.equal(h.prompts[0].capability, Capability.UPLOAD);
    assert.equal(h.prompts[0].host, HOST);
    assert.equal(h.prompts[0].upload.kind, 'download');
    assert.equal(h.prompts[0].upload.path, '/home/user/Downloads/tax-return.pdf');
    assert.equal(h.prompts[0].upload.sourceUrl, 'https://bank.example.test/statement.pdf');
    assert.equal(h.prompts[0].upload.runOwned, false);
    assert.equal(h.dispatched.length, 0, 'a declined file never reaches the page');
    assert.equal(h.lastResult().denied, true);
    assert.equal(h.lastResult().noDispatch, true);

    await h.upload({ downloadId: 41 });
    assert.equal(h.prompts.length, 1, 'the same declined file is refused again without a new card this turn');
    assert.equal(h.dispatched.length, 0);

    h.agent.permissions.beginTurn(TAB);
    h.answer = 'once';
    await h.upload({ downloadId: 41 });
    await h.upload({ downloadId: 41 });
    assert.equal(h.prompts.length, 3, 'an approval of a file from outside the run covers one call');
    assert.deepEqual(h.dispatched.map(item => item.uploadSourceKey), ['download:41', 'download:41']);
  });

  test(`${build}: the run's own downloads keep the ordinary gate`, async () => {
    const off = harness({ gateOff: true });
    await off.upload({ downloadId: 7 });
    assert.equal(off.prompts.length, 0, 'with prompts off the run\'s own download attaches as before');
    assert.deepEqual(off.dispatched.map(item => item.uploadSourceKey), ['download:7']);

    const on = harness();
    await on.upload({ downloadId: 7 });
    await on.upload({ downloadId: 7 });
    assert.equal(on.prompts.length, 1, 'one approval covers the same run download for the turn');
    assert.equal(on.prompts[0].upload.runOwned, true);
    await on.upload({ downloadId: 41 });
    assert.equal(on.prompts.length, 2, 'another file asks again');
    assert.equal(on.dispatched.length, 3);
  });

  test(`${build}: a host-wide upload grant no longer approves a file, but a standing deny still refuses`, async () => {
    const h = harness();
    await h.agent.permissions.record(HOST, Capability.UPLOAD, 'allow', 'always', TAB);
    await h.upload({ downloadId: 41 });
    assert.equal(h.prompts.length, 1, 'an "always allow upload" grant for the host does not choose the file');
    assert.equal(h.dispatched.length, 1);

    const denied = harness();
    await denied.agent.permissions.record(HOST, Capability.UPLOAD, 'deny', 'always', TAB);
    await denied.upload({ downloadId: 7 });
    assert.equal(denied.prompts.length, 0);
    assert.equal(denied.dispatched.length, 0);
    assert.equal(denied.lastResult().denied, true);
  });

  test(`${build}: an unattended run refuses a file from outside the run without a card`, async () => {
    const h = harness({ unattended: true });
    await h.upload({ downloadId: 41 });
    assert.equal(h.prompts.length, 0);
    assert.equal(h.dispatched.length, 0);
    assert.match(h.lastResult().error, /must approve this exact file/);
    await h.upload({ downloadId: 7 });
    assert.deepEqual(h.dispatched.map(item => item.uploadSourceKey), ['download:7'], 'the run\'s own download still attaches');
  });

  test(`${build}: a user attachment keeps the ordinary gate`, async () => {
    const h = harness({ gateOff: true });
    const [attachment] = h.agent._registerUserAttachments(TAB, [{ name: 'cv.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBERi0=' }]);
    await h.upload({ attachmentId: attachment.attachmentId });
    assert.equal(h.prompts.length, 0);
    assert.deepEqual(h.dispatched.map(item => item.uploadSourceKey), [`attachment:${attachment.attachmentId}`]);
  });

  test(`${build}: the upload card names the file and offers no "always"`, async () => {
    const agent = new Agent({ getVisionProvider: async () => null });
    const updates = [];
    const choice = agent._promptPermission(TAB, Capability.UPLOAD, HOST, (type, data) => updates.push({ type, data }),
      { kind: 'download', path: '/home/user/Downloads/tax-return.pdf', sourceUrl: 'https://bank.example.test/statement.pdf', runOwned: false });
    const card = updates[0].data;
    assert.deepEqual(card.options, ['once', 'deny']);
    assert.equal(card.permission.upload.path, '/home/user/Downloads/tax-return.pdf');
    assert.match(card.question, /tax-return\.pdf/);
    assert.match(card.question, /forms\.example\.test/);
    assert.match(card.question, /did not attach this file/);
    agent.submitClarifyResponse(TAB, card.clarifyId, 'always', 'test');
    assert.equal(await choice, 'deny', '"always" fails closed on an upload card');

    const staged = uploadApprovalCard({ kind: 'download', path: '/d/a.png', sourceUrl: 'blob:chrome-extension://id/1', runOwned: true });
    assert.equal(staged.sourceUrl, '', 'a staged blob address tells the user nothing and is not shown');
    assert.equal(staged.name, 'a.png');
  });

  test(`${build}: the handler attaches nothing when the approved source no longer matches`, async () => {
    const agent = new Agent({ getActive: () => ({ promptTier: 'full', supportsVision: false }) });
    agent._resolvePromptTier = () => 'full';
    agent._currentUrl = async () => PAGE;
    // The gate saw nothing it could read (say, an unfinished download); by
    // dispatch the download finished. That file was never shown to the user.
    const result = await agent.executeTool(TAB, 'upload_file', { selector: '#resume', downloadId: 41 }, null, { uploadSourceKey: 'none' });
    assert.equal(result.success, false);
    assert.equal(result.noDispatch, true);
    assert.match(result.error, /changed after it was approved/);
  });

  if (build === 'chrome') {
    test('chrome: a filePath outside the run needs approval each call; the run download\'s own path does not', async () => {
      const h = harness({ gateOff: true });
      h.answer = 'deny';
      await h.upload({ filePath: '/home/user/.ssh/id_ed25519' });
      assert.equal(h.prompts.length, 1);
      assert.equal(h.prompts[0].upload.kind, 'path');
      assert.equal(h.prompts[0].upload.path, '/home/user/.ssh/id_ed25519');
      assert.equal(h.dispatched.length, 0);

      await h.upload({ filePath: '/home/user/Downloads/report.pdf' });
      assert.equal(h.prompts.length, 1, 'the saved path of this run\'s download is the run\'s own file');
      assert.deepEqual(h.dispatched.map(item => item.uploadSourceKey), ['path:/home/user/Downloads/report.pdf']);

      // A run-owned downloadId that cannot be read falls back to filePath in
      // the handler, so the gate judges the path, not the id.
      downloads.set(8, { id: 8, state: 'in_progress', filename: '' });
      h.agent._rememberRunDownloads(TAB, 'download_resource_from_page', { success: true, downloadId: 8 });
      await h.upload({ downloadId: 8, filePath: '/etc/shadow' });
      assert.equal(h.prompts.length, 2);
      assert.equal(h.prompts[1].upload.path, '/etc/shadow');
      assert.equal(h.dispatched.length, 1);
      downloads.delete(8);
    });
  }
}

// The side panel card of both builds, run in Chromium and Firefox: the real
// renderClarifyCard, submitClarify and /dangerously-skip-permissions resolver.
const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(source, name) {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function: ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2).replace(/^export /, '');
}

async function panel(build, engine) {
  const source = read(build, 'src/ui/sidepanel.js');
  const english = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
  const content = `(() => {
    const STRINGS = ${JSON.stringify(english)};
    const t = (key, params) => String(STRINGS[key] ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => params?.[name] ?? '{' + name + '}');
    let currentTabId = 9;
    let currentAssistantEl = document.querySelector('.message.assistant');
    const submittedClarificationIds = new Set();
    const sent = [];
    function clarificationSubmissionKey(tabId, requestId, clarifyId) { return JSON.stringify([Number(tabId), String(requestId || ''), String(clarifyId || '')]); }
    function hideActivity() {} function playClarifySound() {} function scrollToBottom() {} function hideRecommendedActions() {}
    function resetChatNavigation() {} function addMessage() { return currentAssistantEl; } function applyClarifyTimeoutExtension() {}
    function clearClarifyCountdown() {} function placeAnsweredClarifyCardInTimeline() {} function startClarifyCountdown() {}
    function maybeShowPermissionEducationHint() { sent.push(['education_hint']); }
    function workflowHealingTargetLabel(value) { return String(value || ''); }
    function sameTabId(a, b) { return Number(a) === Number(b); } function restoreActiveRunState() {}
    const CAPABILITY_LABEL = {};
    async function sendToBackground(action, payload) { sent.push([action, payload]); return { matched: true }; }
    ${extract(read(build, 'src/agent/permission-gate.js'), 'uploadApprovalCard')}
    ${extract(source, 'renderClarifyCard')}
    ${extract(source, 'submitClarify')}
    ${extract(source, 'resolvePendingPermissionPromptsForTab')}
    window.panel = { render: renderClarifyCard, skipAll: resolvePendingPermissionPromptsForTab, sent };
  })();`;
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 700 } });
    await page.setContent(`<style>${read(build, 'styles/sidepanel.css')}</style>
      <div class="message assistant" data-run-request-id="request-1"><div class="message-content"></div></div>`);
    await page.addScriptTag({ content });
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

const uploadCard = (clarifyId, upload) => ({ clarifyId, tabId: 9, promptKind: 'permission',
  permission: { capability: 'upload', host: HOST, upload }, question: 'fallback', options: ['once', 'deny'] });
const view = (page, id) => page.evaluate(clarifyId => {
  const card = document.querySelector(`.clarify-card[data-clarify-id="${clarifyId}"]`);
  return { question: card.querySelector('.clarify-question').textContent,
    lines: [...card.querySelectorAll('.clarify-reason')].map(element => element.textContent),
    buttons: [...card.querySelectorAll('.clarify-option')].map(button => [button.dataset.value, button.textContent]),
    exactFile: card.dataset.uploadExactFile || '', images: card.querySelectorAll('img').length };
}, id);

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: the side panel upload card shows the exact file, and only a click answers a file from outside the run`, async () => {
    const { browser, page } = await panel(build, engine);
    try {
      await page.evaluate(data => window.panel.render(data), uploadCard('upload_other', { kind: 'download', runOwned: false,
        path: 'C:\\Users\\me\\Downloads\\tax <img src=x>.pdf', sourceUrl: 'https://bank.example.test/statement.pdf' }));
      const other = await view(page, 'upload_other');
      assert.match(other.question, /attach a local file to a page on forms\.example\.test/);
      assert.deepEqual(other.lines.slice(0, 3), ['File: tax <img src=x>.pdf', 'Local path: C:\\Users\\me\\Downloads\\tax <img src=x>.pdf',
        'Downloaded from: https://bank.example.test/statement.pdf']);
      assert.match(other.lines[3], /did not attach this file/);
      assert.deepEqual(other.buttons.map(([value]) => value), ['once', 'deny'], 'no "always" on an upload card');
      assert.equal(other.exactFile, '1');
      assert.equal(other.images, 0, 'file names are text, never markup');

      await page.evaluate(data => window.panel.render(data), uploadCard('upload_run', { kind: 'download', runOwned: true,
        path: '/home/user/Downloads/report.pdf', sourceUrl: 'blob:chrome-extension://id/1' }));
      const own = await view(page, 'upload_run');
      assert.deepEqual(own.lines.slice(0, 2), ['File: report.pdf', 'Local path: /home/user/Downloads/report.pdf']);
      assert.match(own.lines[2], /this task downloaded it/);
      assert.equal(own.exactFile, '');

      // /dangerously-skip-permissions answers the run's own file, never the other one.
      assert.equal(await page.evaluate(() => window.panel.skipAll(9)), 1);
      const answered = await page.evaluate(() => window.panel.sent.filter(([action]) => action === 'clarify_response').map(([, payload]) => [payload.clarifyId, payload.answer]));
      assert.deepEqual(answered, [['upload_run', 'once']]);
      await page.click('.clarify-card[data-clarify-id="upload_other"] button[data-value="deny"]');
      const after = await page.evaluate(() => window.panel.sent.filter(([action]) => action === 'clarify_response').map(([, payload]) => [payload.clarifyId, payload.answer]));
      assert.deepEqual(after, [['upload_run', 'once'], ['upload_other', 'deny']]);
      assert.equal(await page.evaluate(() => window.panel.sent.some(([action]) => action === 'education_hint')), false,
        'the "always allow" hint is not offered on an upload card');
    } finally { await browser.close(); }
  });
}
