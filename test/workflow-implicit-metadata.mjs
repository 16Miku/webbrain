import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area }, runtime: { getURL: value => `extension://fixture/${value}` },
};

// Generated text has no literal request value for the classifier to return.
// The verified complete write supplies that expectation; fresh app-owned
// composer/inventory evidence still has to prove the actual terminal state.
for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  function fixture(kind = 'metadata', requirements = []) {
    const agent = new Agent({ getActive: () => ({ chat: async () => ({ content: '{}' }) }) });
    agent.useSiteAdapters = true;
    agent._persist = () => {};
    const tabId = kind === 'draft' ? 611 : 612;
    const h = { agent, tabId, url: kind === 'draft'
      ? 'https://mail.google.com/mail/u/0/#drafts'
      : 'https://studio.youtube.com/video/owned-video/edit',
    documentToken: `${kind}-owned-document` };
    const task = kind === 'draft'
      ? 'Write a quarterly update and save it as a draft to alice@example.com.'
      : 'Improve this video description and save the changes.';
    agent.conversations.set(tabId, [{ role: 'system', content: 'system' }, { role: 'user', content: task }]);
    const siteWorkflow = agent._resolvePlannerSiteWorkflow(h.url, {
      request_kind: 'execute', site_job: kind === 'draft' ? 'draft-email' : 'update-metadata',
    });
    const guard = h.guard = agent._startPlanExecutionGuard(tabId, 'act', {
      requestKind: 'execute', requiresStateChange: true, requiresSubmission: kind !== 'draft', siteWorkflow,
      ...(kind === 'draft' ? { messaging: { target_kind: 'named', recipients: ['alice@example.com'] } } : {}),
    });
    guard.workflowMetadataRequirements = agent._normalizeWorkflowMetadataRequirements(requirements);
    guard.workflowMetadataRequirementsResolved = true;
    guard.successfulConsequentialToolCalls = 1;
    guard.evidenceTaskKey = guard.taskKey;
    agent._beginCompletionInvariant(tabId);
    h.scope = () => agent._lastAxScopes.set(tabId, { pageUrl: h.url, documentToken: h.documentToken });
    h.scope();
    h.observe = (lines = ['textbox "Description" [ref_description] value="Improved owned description"']) => {
      h.scope();
      agent._recordCompletionToolResult(tabId, 'get_accessibility_tree', {}, {
        success: true, pageUrl: h.url, documentToken: h.documentToken, pageContent: lines.join('\n'),
      });
    };
    h.write = (tool = kind === 'draft' ? 'type_text' : 'set_field', options = {}) => {
      h.scope();
      const field = options.field || (kind === 'draft' ? 'body' : 'description');
      const text = options.text ?? (field === 'subject' ? 'Q3 results'
        : kind === 'draft' ? 'Quarterly update' : 'Improved owned description');
      const fieldMeta = kind === 'draft'
        ? (field === 'subject' ? { tag: 'input', type: 'text', name: 'subjectbox', id: 'subject', labelText: 'Subject' }
          : { tag: 'div', type: 'div', name: null, contentEditable: true, role: 'textbox', ariaLabel: 'Message Body' })
        : { tag: 'textarea', type: 'textarea', name: field, id: field, contentEditable: false,
          labelText: field === 'title' ? 'Title' : 'Description', ariaLabel: field === 'title' ? 'Title' : 'Description' };
      const args = { text, clear: true, ...(tool === 'type_text' ? { selector: `[name="${field}"]` } : { ref_id: `ref_${field}` }),
        ...(options.args || {}) };
      const result = { success: true, dispatched: true, verified: true, fieldMeta,
        documentToken: h.documentToken, refScopeUrl: h.url, ...(options.result || {}) };
      agent._recordCompletionToolResult(tabId, tool, args, result);
      return { args, result };
    };
    h.save = () => {
      h.scope();
      agent._recordCompletionToolResult(tabId, 'click_ax', { ref_id: 'ref_save' }, { success: true, dispatched: true });
      h.submit = agent._recordCompletionSubmitAttempt(tabId, { isSubmit: true }, 'click_ax', { ref_id: 'ref_save' },
        h.url, h.url, { success: true, dispatched: true }, h.documentToken, h.documentToken);
      assert.equal(h.submit?.dispatched, true);
    };
    h.terminal = (pageState = {}, probe = {}) => agent._workflowTerminalEvidenceFromDone(tabId,
      kind === 'draft' ? pageState : { workflowPageText: 'Changes saved.', ...pageState }, h.url,
      { submit: h.submit || null, verifiedFinalSubmit: kind !== 'draft', relevantForms: 0 },
      kind === 'draft' ? {
        success: true, conclusive: true, composerAvailable: true, messageBody: 'Quarterly update',
        composerSubject: 'Q3 results', composerSubjectAvailable: true, composerStatusMessages: ['Draft saved'],
        strongRecipientCandidates: [{ identity: 'alice@example.com', role: 'to' }], ...probe,
      } : null);
    return h;
  }

  function nativeChoice(h, kind = 'select', options = {}) {
    h.scope();
    const ref_id = kind === 'select' ? 'ref_visibility' : 'ref_embedding';
    const tool = kind === 'select' ? 'type_ax' : 'set_checked';
    const args = kind === 'select' ? { ref_id, text: 'Public' } : { ref_id, checked: true };
    // Exact production content.js results captured from native controls in
    // Chromium and Firefox. A select replaces its choice without clear:true;
    // the native checkbox exposes Boolean state and identity, not fieldMeta.
    const result = kind === 'select' ? {
      success: true, verified: true, method: 'type_ax_select', ref_id, value: 'Public',
      fieldMeta: { tag: 'select', type: 'select', name: 'visibility', id: 'visibility', labelText: 'Visibility', contentEditable: false },
    } : {
      success: true, dispatched: true, verified: true, method: 'set_checked', ref_id,
      tag: 'input', type: 'checkbox', name: 'Embedding', selector: '#embedding', checkboxIdentity: 'id:embedding',
      desiredChecked: true, checkedBefore: false, checkedAfter: true, changed: true,
      checkboxState: { identity: 'id:embedding', desiredChecked: true, actualChecked: true },
    };
    Object.assign(args, options.args || {});
    Object.assign(result, options.result || {});
    h.agent._recordCompletionToolResult(h.tabId, tool, args, result);
    return { args, result };
  }
  const nativeChoiceInventory = [
    'combobox "Visibility" [ref_visibility] dom_id="visibility" field_name="visibility" value="Private"',
    'checkbox "Embedding" [ref_embedding] type="checkbox" dom_id="embedding" field_name="embedding" checked=false',
  ];
  const savedChoiceInventory = [
    'combobox "Visibility" [ref_visibility] dom_id="visibility" field_name="visibility" value="Public"',
    'checkbox "Embedding" [ref_embedding] type="checkbox" dom_id="embedding" field_name="embedding" checked=true',
  ];

  for (const tool of ['type_text', 'type_ax', 'set_field']) {
    test(`${build}: a verified ${tool} replacement can prove a generated Gmail draft`, () => {
      const h = fixture('draft'); h.write(tool);
      assert.equal(h.terminal()?.verificationKind, 'message_draft');
      assert.equal(h.terminal()?.source, 'draft_recipients_fields_and_saved_draft_state');
    });
  }
  test(`${build}: generated draft contents complement exact requested subject and body checks`, () => {
    const h = fixture('draft', [{ field: 'subject', value: 'Q3 results' }]);
    h.write('type_text');
    assert.equal(h.terminal()?.verificationKind, 'message_draft');
    assert.equal(h.terminal({}, { composerSubject: 'Q4 results' }), null);
    assert.equal(h.terminal({}, { messageBody: 'Quarterly update with drift' }), null);
    assert.equal(h.terminal({}, { strongRecipientCandidates: [{ identity: 'other@example.com', role: 'to' }] }), null);
    assert.equal(h.terminal({}, { composerStatusMessages: [] }), null);
  });
  for (const [label, mutate] of [
    ['empty expectation set', () => {}],
    ['unverified replacement', h => h.write('type_text', { result: { verified: false } })],
    ['missing native field metadata', h => h.write('type_text', { result: { fieldMeta: null } })],
    ['appending write', h => { h.write('type_text'); h.write('type_text', { args: { clear: false }, text: 'Extra text' }); }],
    ['incomplete classified requirements', h => { h.write(); h.guard.workflowMetadataRequirementsIncomplete = true; }],
    ['unresolved classifier', h => { h.write(); h.guard.workflowMetadataRequirementsResolved = false; }],
    ['another task', h => { h.write(); h.agent.conversations.get(h.tabId).push({ role: 'user', content: 'Write a different draft instead.' }); }],
  ]) {
    test(`${build}: ${label} cannot prove generated draft contents`, () => {
      const h = fixture('draft'); mutate(h); assert.equal(h.terminal(), null);
    });
  }

  for (const tool of ['type_text', 'type_ax', 'set_field']) {
    test(`${build}: a verified ${tool} metadata replacement must read back after Save`, () => {
      const h = fixture(); h.observe(['textbox "Description" [ref_description] value="Old description"']);
      h.write(tool); h.save();
      assert.equal(h.terminal(), null, 'The pre-save inventory cannot prove persistence.');
      h.observe();
      assert.equal(h.terminal()?.source, 'saved_state_with_exact_metadata_readback');
    });
  }
  test(`${build}: exact requested title and generated description both need persisted readback`, () => {
    const h = fixture('metadata', [{ field: 'title', value: 'Owned title' }]);
    h.write('set_field'); h.save();
    h.observe(['textbox "Title" [ref_title] value="Owned title"', 'textbox "Description" [ref_description] value="Improved owned description"']);
    assert.equal(h.terminal()?.verificationKind, 'saved_state');
    h.observe(['textbox "Title" [ref_title] value="Wrong title"', 'textbox "Description" [ref_description] value="Improved owned description"']);
    assert.equal(h.terminal(), null);
    h.observe(['textbox "Title" [ref_title] value="Owned title"', 'textbox "Description" [ref_description] value="Wrong description"']);
    assert.equal(h.terminal(), null);
  });
  test(`${build}: authored metadata cannot replace a conflicting exact user value`, () => {
    const h = fixture('metadata', [{ field: 'description', value: 'Requested exact description' }]);
    h.write(); h.save(); h.observe(); assert.equal(h.terminal(), null);
  });
  test(`${build}: an explicitly requested empty description can be verified after Save`, () => {
    const h = fixture('metadata', [{ field: 'description', value: '' }]);
    h.write('set_field', { text: '' }); h.save();
    h.observe(['textbox "Description" [ref_description] value=""']);
    assert.equal(h.terminal()?.verificationKind, 'saved_state');
  });
  test(`${build}: app-owned Continue preserves generated metadata before Save`, () => {
    const h = fixture(); h.write();
    h.agent._storeContinuationExecutionEvidence(h.tabId);
    const continued = h.agent._startPlanExecutionGuard(h.tabId, 'act', {
      requestKind: 'execute', requiresStateChange: true, requiresSubmission: true, siteWorkflow: h.guard.siteWorkflow,
    }, { trustedContinuation: true });
    assert.equal(continued.evidenceTaskKey, continued.taskKey);
    h.guard = continued; h.save(); h.observe();
    assert.equal(h.terminal()?.verificationKind, 'saved_state');
  });
  test(`${build}: ordinary restart cannot inherit a generated metadata replacement`, () => {
    const h = fixture(); h.write(); h.agent._storeContinuationExecutionEvidence(h.tabId);
    h.guard = h.agent._startPlanExecutionGuard(h.tabId, 'act', {
      requestKind: 'execute', requiresStateChange: true, requiresSubmission: true, siteWorkflow: h.guard.siteWorkflow,
    });
    h.guard.workflowMetadataRequirementsResolved = true; h.save(); h.observe();
    assert.equal(h.terminal(), null);
  });
  test(`${build}: contradictory native field identities cannot authorize metadata`, () => {
    const h = fixture(); h.write('set_field', { result: {
      fieldMeta: { tag: 'textarea', type: 'textarea', name: 'title', id: 'title', ariaLabel: 'Description', labelText: 'Description' },
    } });
    h.save(); h.observe(); assert.equal(h.terminal(), null);
  });

  for (const kind of ['select', 'checkbox']) {
    test(`${build}: a verified native ${kind} supplies an implicit saved-state expectation`, () => {
      const h = fixture(); h.observe(nativeChoiceInventory); nativeChoice(h, kind); h.save();
      assert.equal(h.terminal(), null, 'The initial unsaved choice inventory is stale.');
      h.observe(savedChoiceInventory);
      assert.equal(h.terminal()?.verificationKind, 'saved_state');
      h.observe(kind === 'select' ? nativeChoiceInventory : [savedChoiceInventory[0], nativeChoiceInventory[1]]);
      assert.equal(h.terminal(), null, 'A persisted mismatched native choice is not completion.');
    });
  }
  test(`${build}: native selected labels stay distinct from raw option values`, () => {
    const h = fixture(); h.observe(nativeChoiceInventory);
    nativeChoice(h, 'select', { result: { value: 'public', selectedText: 'Public' } });
    h.save(); h.observe(savedChoiceInventory);
    assert.equal(h.terminal()?.verificationKind, 'saved_state');
    h.observe([savedChoiceInventory[0].replace('value="Public"', 'value="Private"'), savedChoiceInventory[1]]);
    assert.equal(h.terminal(), null);
  });
  test(`${build}: actual multiline native option labels match the AX saved-state value`, { timeout: 120000 }, async () => {
    const engine = build === 'chrome' ? chromium : firefox;
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        window.qaListeners = [];
        window.chrome = window.browser = { runtime: {
          onMessage: { addListener: listener => qaListeners.push(listener) }, getURL: value => value,
          async sendMessage() { return { active: false }; },
        } };
        window.qaMessage = (action, params) => new Promise(resolve => {
          for (const listener of qaListeners) {
            if (listener({ target: 'content', action, params }, {}, resolve) === true) break;
          }
        });
      });
      for (const name of ['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
        await page.addInitScript({ content: await readFile(new URL(`../src/${build}/src/content/${name}`, import.meta.url), 'utf8') });
      }
      await page.route('https://studio.youtube.com/**', route => route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><form><label for="visibility">Visibility</label><select id="visibility" name="visibility">'
        + '<option value="private">Private</option><option value="public">  Public\n    visibility  </option></select></form>' }));
      const h = fixture();
      await page.goto(h.url);
      const observed = await page.evaluate(async () => {
        const before = __generateAccessibilityTree('all', 15, 6000).pageContent;
        const args = { ref_id: __wb_ax_ref(visibility), text: 'public' };
        const result = await qaMessage('type_ax', args);
        return { before, args, result, after: __generateAccessibilityTree('all', 15, 6000).pageContent };
      });
      assert.equal(observed.result.verified, true);
      assert.equal(observed.result.value, 'public');
      assert.equal(observed.result.selectedText, 'Public visibility');
      assert.match(observed.after, /combobox "Visibility".*value="Public visibility"/);
      h.observe(observed.before.split('\n'));
      h.agent._recordCompletionToolResult(h.tabId, 'type_ax', observed.args, observed.result);
      h.save(); h.observe(observed.after.split('\n'));
      assert.equal(h.terminal()?.verificationKind, 'saved_state');
    } finally { await browser.close(); }
  });
  for (const [label, options] of [
    ['unverified selection', { result: { verified: false } }],
    ['missing selected value', { result: { value: undefined } }],
    ['custom control posing as native', { result: { fieldMeta: { tag: 'div', type: 'div', role: 'combobox', ariaLabel: 'Visibility' } } }],
    ['unknown field identity', { result: { fieldMeta: { tag: 'select', type: 'select', name: 'unknown', id: 'unknown', labelText: 'Unknown option' } } }],
  ]) {
    test(`${build}: ${label} cannot prove native selected metadata`, () => {
      const h = fixture(); h.observe(nativeChoiceInventory); nativeChoice(h, 'select', options);
      h.save(); h.observe(savedChoiceInventory); assert.equal(h.terminal(), null);
    });
  }
  for (const [label, options, mutate] of [
    ['unverified state', { result: { verified: false } }],
    ['missing native identity', { result: { checkboxIdentity: '' } }],
    ['conflicting identity', { result: { checkboxState: { identity: 'id:other', desiredChecked: true, actualChecked: true } } }],
    ['wrong requested state', { result: { desiredChecked: false } }],
    ['wrong actual state', { result: { checkedAfter: false } }],
    ['custom control', { result: { tag: 'div', type: 'checkbox' } }],
    ['duplicate original inventory ref', {}, h => {
      const original = h.guard.workflowInventoryEvidence.items.find(item => item.ref_id === 'ref_embedding');
      h.guard.workflowInventoryEvidence.items.push({ ...original, id: `${original.id}-duplicate` });
    }],
    ['wrong inventory document', {}, h => { for (const item of h.guard.workflowInventoryEvidence.items) item.documentScope = 'other-document'; }],
    ['missing original inventory', {}, h => { h.guard.workflowInventoryEvidence = null; }],
  ]) {
    test(`${build}: ${label} cannot prove implicit checkbox metadata`, () => {
      const h = fixture(); h.observe(nativeChoiceInventory); mutate?.(h); nativeChoice(h, 'checkbox', options);
      h.save(); h.observe(savedChoiceInventory); assert.equal(h.terminal(), null);
    });
  }
  for (const [label, write] of [
    ['no authored replacement', () => {}],
    ['unverified replacement', h => h.write('set_field', { result: { verified: false } })],
    ['missing field metadata', h => h.write('set_field', { result: { fieldMeta: null } })],
    ['unknown native field', h => h.write('set_field', { result: { fieldMeta: { tag: 'textarea', type: 'textarea', name: 'unrelated', ariaLabel: 'Unrelated field' } } })],
    ['appended value', h => { h.write(); h.write('type_ax', { args: { clear: false }, text: 'Extra text' }); }],
    ['incomplete classifier', h => { h.write(); h.guard.workflowMetadataRequirementsIncomplete = true; }],
    ['unresolved classifier', h => { h.write(); h.guard.workflowMetadataRequirementsResolved = false; }],
  ]) {
    test(`${build}: ${label} cannot use a saved toast as metadata proof`, () => {
      const h = fixture(); write(h); h.save(); h.observe(); assert.equal(h.terminal(), null);
    });
  }
  test(`${build}: generated metadata needs one exact complete fresh field value`, () => {
    const h = fixture(); h.write(); h.save();
    for (const lines of [
      ['textbox "Description" [ref_description] value="Wrong description"'],
      ['textbox "Title" [ref_title] value="Improved owned description"'],
      ['textbox "Description" [ref_description] value="Improved owned description"', 'textbox "Description" [ref_other] value="Improved owned description"'],
      [],
    ]) {
      h.observe(lines); assert.equal(h.terminal(), null, JSON.stringify(lines));
    }
    h.observe();
    assert.equal(h.terminal()?.verificationKind, 'saved_state');
    assert.equal(h.terminal({ workflowPageText: 'Save failed.' }), null);
  });
  for (const change of ['task before Save', 'task after Save', 'document before Save', 'different video', 'other video after Save']) {
    test(`${build}: ${change} cannot inherit authored metadata evidence`, () => {
      const h = fixture(); h.write();
      if (change === 'task before Save') h.agent.conversations.get(h.tabId).push({ role: 'user', content: 'Improve a different description.' });
      if (change === 'document before Save') h.documentToken = 'replacement-metadata-document';
      if (change === 'different video') h.url = 'https://studio.youtube.com/video/other-video/edit';
      h.save();
      if (change === 'task after Save') h.agent.conversations.get(h.tabId).push({ role: 'user', content: 'Improve a different description.' });
      if (change === 'other video after Save') h.url = 'https://studio.youtube.com/video/other-video/edit';
      h.observe(); assert.equal(h.terminal(), null);
    });
  }
}
