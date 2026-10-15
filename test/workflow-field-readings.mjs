import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { fixedChoiceQuestion, fixtureFixedChoiceReply, fixturePageTextReading } from './semantic-decision-stub.mjs';

// A video's details page in Polish. Which saved field holds which requested
// detail is read from the field's labels by a model, in any language; the done
// tool reads those labels before it compares the saved values with the
// requested ones, and a write's labels are read before the write is recorded.
// Only page capture and the model are simulated here (the model's readings are
// the fixture oracles); the agent's own done tool runs.
const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: v => `extension://fixture/${v}` } };
const videoUrl = 'https://studio.youtube.com/video/owned-qa/edit';
const task = 'Zmień tytuł filmu na "Launch Video" i opis na "Nowy opis filmu", a potem zapisz.';
const requirements = [{ field: 'title', value: 'Launch Video' }, { field: 'description', value: 'Nowy opis filmu' }];
const tree = ({ title = 'Launch Video', description = 'Nowy opis filmu', extra = [] } = {}) => [
  'main "Szczegóły filmu"',
  ` textbox "Tytuł (wymagany)" [ref_title] value="${title}"`,
  ` textbox "Opis" [ref_description] value="${description}"`,
  ' combobox "Kategoria" [ref_category] value="Ludzie i blogi"',
  ...extra,
  ' button "Zapisz" [ref_save]',
  ' status "Zapisano wszystkie zmiany."',
].join('\n');

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const cdp = build === 'chrome' ? (await import('../src/chrome/src/cdp/cdp-client.js')).cdpClient : null;

  // `read(kind, item)` answers the field questions (a choice, or null when the
  // model cannot tell); every other question is read with the oracles.
  async function fixture({ saved = {}, read = null, writes = true } = {}) {
    const savedChrome = globalThis.chrome, savedBrowser = globalThis.browser;
    const savedCdp = cdp ? Object.fromEntries(['attach', 'sendCommand', 'evaluate'].map(k => [k, cdp[k]])) : null;
    const h = { url: videoUrl, asked: [], judges: 0, tree: tree({ title: 'Stary tytuł', description: 'Stary opis' }) };
    const status = { innerText: 'Zapisano wszystkie zmiany.', hidden: false, parentElement: null,
      getBoundingClientRect: () => ({ width: 200, height: 20 }), getAttribute: () => null };
    const context = () => ({ location: { href: h.url }, performance: { timeOrigin: 1000 },
      document: { title: 'Szczegóły filmu', readyState: 'complete', body: { innerText: h.tree },
        querySelector: () => null, querySelectorAll: selector => /role=status|aria-live/.test(selector) ? [status] : [] },
      window: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), URL, Map, Set });
    const evaluate = code => vm.runInNewContext(code, context());
    const api = { storage: { local: area, session: area }, runtime: { getURL: v => `extension://fixture/${v}` },
      tabs: { get: async () => ({ id: 61, url: h.url }), executeScript: async (_tab, { code }) => [evaluate(code)] } };
    globalThis.chrome = globalThis.browser = api;
    if (cdp) { cdp.attach = async () => {}; cdp.sendCommand = async () => ({}); cdp.evaluate = async (_tab, code) => ({ result: { value: evaluate(code) } }); }
    h.provider = { model: 'owned-offline', supportsVision: false, config: { category: 'local' }, chat() {} };
    const agent = h.agent = new Agent({ getActive: () => h.provider });
    agent.useSiteAdapters = true;
    agent.conversationModes.set(61, 'act');
    agent._progressTaskKeyHash = () => 'owned-video-task';
    agent._progressTaskAnchorText = () => task;
    agent._captureViewportProbe = async () => ({ url: h.url, title: 'Szczegóły filmu', readyState: 'complete' });
    agent.systemOneContext = () => ({ isCurrent: () => true });
    agent._checkAbort = () => false;
    agent._hasPendingSteering = () => false;
    agent.recordSystemOneVerdict = () => {};
    agent._chatWithCostAllowance = async (_provider, messages) => {
      const question = fixedChoiceQuestion(messages);
      if (question) {
        if (['metadata_field', 'publication_field'].includes(question.kind)) {
          h.asked.push(...question.items.map(item => ({ kind: question.kind, text: item.text })));
          if (read) {
            const answers = question.items.flatMap((item, index) => {
              const choice = read(question.kind, item);
              return choice ? [{ item: index, choice, evidence: item.text }] : [];
            });
            return { content: JSON.stringify({ answers }) };
          }
        }
        return { content: fixtureFixedChoiceReply(messages) };
      }
      h.judges++;
      return { content: JSON.stringify({ outcome: 'succeeded', reason: 'The saved details page shows the requested values.' }) };
    };
    const siteWorkflow = agent._resolvePlannerSiteWorkflow(videoUrl, { request_kind: 'execute', site_job: 'update-metadata' });
    h.guard = agent._startPlanExecutionGuard(61, 'act', { requestKind: 'execute', siteWorkflow, siteWorkflowUrl: videoUrl,
      requiresStateChange: true, requiresSubmission: true });
    h.guard.workflowMetadataRequirements = agent._normalizeWorkflowMetadataRequirements(requirements);
    h.guard.workflowMetadataRequirementsResolved = true;
    agent._beginCompletionInvariant(61);
    const scope = () => agent._lastAxScopes.set(61, { pageUrl: h.url, documentToken: 'owned-video-document' });
    const record = (name, args, result, consequential = false) => {
      scope();
      agent._markPlanExecutionToolCall(61, name, result, { consequential });
      agent._recordCompletionToolResult(61, name, args, result);
    };
    h.read = () => record('get_accessibility_tree', {}, { success: true, pageUrl: h.url, pageContent: h.tree });
    // A write runs the way the agent loop runs it: its field's labels are
    // read first, then the write is recorded.
    h.write = async (ref, text, fieldMeta) => {
      const args = { ref_id: ref, text, clear: true };
      const result = { success: true, dispatched: true, verified: true, fieldMeta, documentToken: 'owned-video-document', refScopeUrl: h.url };
      scope();
      await agent._readWorkflowAuthoredFieldLabels?.(61, 'set_field', args, result);
      record('set_field', args, result);
    };
    h.read();
    if (writes) {
      await h.write('ref_title', 'Launch Video', { tag: 'textarea', type: 'textarea', id: 'textbox', name: null,
        labelText: 'Tytuł (wymagany)', ariaLabel: 'Dodaj tytuł opisujący film', contentEditable: false });
      await h.write('ref_description', 'Nowy opis filmu', { tag: 'textarea', type: 'textarea', id: 'textbox', name: null,
        labelText: 'Opis', ariaLabel: 'Opowiedz widzom o swoim filmie', contentEditable: false });
    }
    const click = { success: true, tag: 'button', name: 'Zapisz', verified: true };
    await agent._readControlEffect(61, agent._controlCaption('click_ax', { ref_id: 'ref_save' }, click));
    record('click_ax', { ref_id: 'ref_save' }, click, true);
    h.submit = agent._recordCompletionSubmitAttempt(61, null, 'click_ax', { ref_id: 'ref_save' }, videoUrl, videoUrl, click,
      'owned-video-document', 'owned-video-document');
    assert.equal(h.submit?.dispatched, true, 'The save click arms the submit state.');
    h.tree = tree(saved);
    h.read();
    agent.executeTool = async (_tab, name) => {
      assert.equal(name, 'get_accessibility_tree');
      return { success: true, pageUrl: h.url, pageContent: h.tree };
    };
    h.done = () => agent._executeToolImpl(61, 'done', { outcome: 'success', summary: 'Zapisano nowy tytuł i opis filmu.' });
    h.close = () => { globalThis.chrome = savedChrome; globalThis.browser = savedBrowser; if (cdp) Object.assign(cdp, savedCdp); };
    return h;
  }

  test(`${build}: saved details in Polish are matched to the requested ones by reading the field labels`, async () => {
    const h = await fixture();
    try {
      // The writes read their fields' labels and names, and each write
      // stands for the detail it changed.
      assert.deepEqual(Object.keys(h.guard.workflowAuthoredMetadataEvidence?.fields || {}).sort(), ['description', 'title']);
      assert.deepEqual(h.submit.workflowBinding.authoredMetadataRequirements, requirements);
      const result = await h.done();
      assert.equal(result.done, true);
      assert.equal(h.guard.verifiedSubmissionEvidence, true, 'The exact saved readback earns the job certificate.');
      assert.equal(h.guard.workflowTerminalEvidence?.source, 'saved_state_with_exact_metadata_readback');
      assert.equal(h.agent._executionEvidenceSatisfied(h.guard), true);
      // Only the saved fields' labels are asked about at done, never a
      // button or a status line.
      const doneLabels = h.asked.filter(entry => entry.kind === 'metadata_field').map(entry => entry.text);
      assert.ok(doneLabels.includes('Tytuł (wymagany)') && doneLabels.includes('Opis') && doneLabels.includes('Kategoria'));
      assert.ok(!doneLabels.some(text => /Zapisz|Zapisano/.test(text)), doneLabels.join(' | '));
    } finally { h.close(); }
  });

  test(`${build}: a saved value that differs from the requested one is not a verified save, in any language`, async () => {
    const h = await fixture({ saved: { title: 'Launch Vide' } });
    try {
      await h.done();
      assert.notEqual(h.guard.verifiedSubmissionEvidence, true);
      assert.equal(h.agent._executionEvidenceSatisfied(h.guard), false);
    } finally { h.close(); }
  });

  test(`${build}: two saved fields read as the title cannot stand for one requested title`, async () => {
    const h = await fixture({ saved: { extra: [' textbox "Tytuł w napisach" [ref_caption_title] value="Inny tytuł"'] } });
    try {
      await h.done();
      assert.notEqual(h.guard.verifiedSubmissionEvidence, true);
    } finally { h.close(); }
  });

  test(`${build}: labels nobody could read hold no detail, so nothing is verified from them`, async () => {
    const h = await fixture({ read: () => null });
    try {
      // An unread write names no field: it is not tracked as an authored
      // detail, and the requested values still have to be read back.
      assert.equal(h.guard.workflowAuthoredMetadataEvidence ?? null, null);
      await h.done();
      assert.notEqual(h.guard.verifiedSubmissionEvidence, true);
      assert.ok(h.asked.some(entry => entry.text === 'Tytuł (wymagany)'), 'The done tool asked about the saved fields.');
    } finally { h.close(); }
  });

  test(`${build}: an unread extra field is not counted against the one read as the title`, async () => {
    const extra = [' textbox "Napisy: tytuł alternatywny" [ref_alt] value="Inny tytuł"'];
    const h = await fixture({ saved: { extra }, read: (kind, item) => (item.text === 'Napisy: tytuł alternatywny'
      ? null : fixturePageTextReading(kind, item.text)) });
    try {
      await h.done();
      assert.equal(h.guard.verifiedSubmissionEvidence, true);
    } finally { h.close(); }
  });
}

test('the agent loop reads a write\'s field labels before it records the write, in both builds', () => {
  for (const build of ['chrome', 'firefox']) {
    const source = fs.readFileSync(new URL(`../src/${build}/src/agent/agent.js`, import.meta.url), 'utf8');
    const read = source.indexOf('await this._readWorkflowAuthoredFieldLabels(tabId, fnName, fnArgs, toolResult);');
    const recorded = source.indexOf('const completionStateAfterTool = this._recordCompletionToolResult(');
    assert.ok(read > 0 && recorded > read && recorded - read < 400, `${build}: the labels are not read just before the write is recorded`);
  }
});
