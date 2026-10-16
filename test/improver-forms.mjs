// Finishing a task is not held up by an unrelated sidebar search box that
// says what it is for only through a localized placeholder or button caption.
// Whether such a form only searches is read by a model in any language: a
// button caption with the control_effect question, the field's own label,
// when no button has a caption, with the field_purpose question (stubbed here
// as a model would answer). A form that holds a typed draft, whose button
// reads as sending something, or whose field reads as taking content to send
// (a comment box with an icon-only send button) still counts as unsent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureControlEffectReading, installModelStub, stubPageTextReadings } from './semantic-decision-stub.mjs';

const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area }, runtime: { getURL: value => `extension://test/${value}` },
};

const URL_AFTER_POST = 'https://mastodon.example.test/@alice/113';
// Mastodon's sidebar search, as the done probe reports it on a page with no
// main landmark: one unnamed text input whose only label is its localized
// placeholder, and an icon-only type=button that clears it.
const searchField = { tag: 'input', type: 'text', role: '', name: '', value: '', required: false, focused: false, label: 'Suchen' };
const mastodonSearch = (overrides = {}) => ({
  label: '', utilityRegion: false, outsidePrimaryContent: false, insideDialog: false, method: 'get', hiddenNamedCount: 0,
  editable: [searchField], submits: [{ label: '', type: 'button' }], ...overrides,
});
const withField = (changes, overrides = {}) => mastodonSearch({ editable: [{ ...searchField, ...changes }], ...overrides });
// How a model reads these field labels with the field_purpose question.
const FIELD_PURPOSE = {
  Suchen: 'search', '検索': 'search', 'Ara veya URL yapıştır': 'search',
  'Write a comment…': 'enter', 'Search people to invite': 'enter', 'Was gibt es Neues?': 'unclear',
};

for (const build of ['chrome', 'firefox']) {
  const { classifyCompletionForm: classify } = await import(`../src/${build}/src/agent/completion-invariant.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  test(`${build}: an unmarked sidebar search box is a search candidate read by its placeholder, never released by structure alone`, () => {
    const candidate = {
      label: '', relevant: true, utility: false, utilityReason: null, editableCount: 1, submitCount: 1,
      searchCandidate: true, searchUtilityReason: 'unmarked_search', submitLabels: [''], fieldLabel: 'Suchen',
    };
    assert.deepEqual(classify(mastodonSearch()), candidate);
    const reconstructed = Function(`return (${classify.toString()});`)();
    assert.deepEqual(reconstructed(mastodonSearch()), candidate, 'The classifier must stay self-contained for the page probe');
    // The placeholder a model read as only searching releases the form.
    assert.deepEqual(classify(mastodonSearch({ fieldReadings: { Suchen: 'search' } })), {
      label: '', relevant: false, utility: true, utilityReason: 'unmarked_search', editableCount: 1, submitCount: 1,
    });
    // A field label is never released by a control_effect reading: that
    // question calls a control that only opens an editor "view".
    assert.deepEqual(classify(mastodonSearch({ submitReadings: { Suchen: 'view' } })), candidate);
    // A caption, when there is one, is what gets read.
    const { fieldLabel: _placeholder, ...captionCandidate } = candidate;
    assert.deepEqual(classify(mastodonSearch({ submits: [{ label: 'Suchen', type: 'submit' }] })),
      { ...captionCandidate, submitLabels: ['Suchen'] });
    assert.equal(classify(mastodonSearch({ submits: [{ label: 'Suchen', type: 'submit' }], submitReadings: { Suchen: 'view' } })).utility, true);
    for (const [caption, reading] of [['Senden', 'commit'], ['Veröffentlichen', 'publish'], ['Weiter', 'next_step'], ['Hinzufügen', 'form_edit']]) {
      const result = classify(mastodonSearch({ submits: [{ label: caption, type: 'submit' }], submitReadings: { [caption]: reading } }));
      assert.equal(result.relevant, true, `${caption} read as ${reading} hid a task form`);
      assert.equal(result.searchCandidate, undefined, `${caption} read as ${reading} asked for another reading`);
    }
    // An icon-only form whose field label reads as taking content to send,
    // or as unclear, keeps counting and asks for nothing more.
    for (const [text, reading] of [['Nachricht senden', 'enter'], ['Write a comment…', 'enter'],
      ['Search people to invite', 'enter'], ['Was gibt es Neues?', 'unclear']]) {
      const result = classify(withField({ label: text }, { fieldReadings: { [text]: reading }, submitReadings: { [text]: 'view' } }));
      assert.equal(result.relevant, true, `${text} read as ${reading} hid a task form`);
      assert.equal(result.searchCandidate, undefined, `${text} read as ${reading} asked for another reading`);
    }
    // A caption is still read with control_effect: a field reading of it decides nothing.
    assert.equal(classify(mastodonSearch({ submits: [{ label: 'Suchen', type: 'submit' }], fieldReadings: { Suchen: 'search' } })).searchCandidate,
      true);
    // Nothing to read: no caption and no label keeps the form without a field label to read.
    const unlabeled = classify(withField({ label: '' }));
    assert.equal(unlabeled.relevant, true);
    assert.equal(unlabeled.fieldLabel, undefined);
  });

  test(`${build}: a typed draft and other task evidence keep the form relevant whatever a model read`, () => {
    for (const [name, form] of [
      ['draft', withField({ value: 'Hallo zusammen' })],
      ['draft outside the main content', withField({ value: 'Hallo zusammen' }, { outsidePrimaryContent: true })],
      ['focused field', withField({ focused: true })],
      ['required field', withField({ required: true })],
      ['named field', withField({ name: 'status' })],
      ['combobox field', withField({ role: 'combobox' })],
      ['password field', withField({ type: 'password' })],
      ['POST form', mastodonSearch({ method: 'post' })],
      ['dialog form', mastodonSearch({ insideDialog: true })],
      ['hidden submitted state', mastodonSearch({ hiddenNamedCount: 1 })],
      ['second field', mastodonSearch({ editable: [searchField, { ...searchField, label: 'Ort' }] })],
    ]) {
      const result = classify({ ...form, submitReadings: { Suchen: 'view', Ort: 'view' }, fieldReadings: { Suchen: 'search', Ort: 'search' } });
      assert.equal(result.relevant, true, `${name} was hidden as a search form`);
      assert.equal(result.utility, false, `${name} received a utility classification`);
      assert.equal(result.searchCandidate, undefined, `${name} asked for a reading`);
    }
  });

  test(`${build}: outside the primary content, a caption-less type=button or reset leaves a sidebar shell passive`, () => {
    for (const type of ['button', 'reset']) {
      assert.equal(classify(mastodonSearch({ outsidePrimaryContent: true, submits: [{ label: '', type }] })).utilityReason,
        'passive_utility_shell', `a caption-less type=${type} control kept the shell relevant`);
    }
    // A control that can send the form natively, or that has a caption, is
    // not passive; the form then waits for a reading.
    for (const control of [{ label: '', type: 'submit' }, { label: '', type: 'image' }, { label: '', type: '' }, { label: 'Ara', type: 'button' }]) {
      const result = classify(mastodonSearch({ outsidePrimaryContent: true, submits: [control] }));
      assert.equal(result.relevant, true, JSON.stringify(control));
      assert.equal(result.searchCandidate, true, JSON.stringify(control));
    }
  });

  test(`${build}: a search field with an icon-only button is read by its own label`, () => {
    const form = { outsidePrimaryContent: false,
      editable: [{ tag: 'input', type: 'search', role: '', name: '', value: '', label: 'Search posts' }],
      submits: [{ label: '', type: 'submit' }] };
    const candidate = classify(form);
    assert.equal(candidate.searchCandidate, true);
    assert.equal(candidate.searchUtilityReason, 'semantic_search');
    assert.equal(candidate.fieldLabel, 'Search posts');
    assert.equal(classify({ ...form, fieldReadings: { 'Search posts': 'search' } }).utilityReason, 'semantic_search');
    assert.equal(classify({ ...form, submitReadings: { 'Search posts': 'view' } }).relevant, true);
    // Captions beside an empty one stay as they were: the empty one decides
    // nothing, so the form is not released through its field label.
    const mixed = classify({ ...form, submits: [{ label: '', type: 'submit' }, { label: 'Ara', type: 'submit' }] });
    assert.deepEqual(mixed.submitLabels, ['', 'Ara']);
    assert.equal(mixed.fieldLabel, undefined);
  });

  test(`${build}: at done a field label read as searching releases its form; one read as writing or unsure does not`, async () => {
    const agent = new Agent({});
    // How a model reads each field label with field_purpose ("Ara veya URL
    // yapıştır" is Mastodon's Turkish "Search or paste URL"). control_effect
    // reads every text as "view", as a faithful reading of an editor-opening
    // label does: a field label must never be released through it.
    const asked = stubPageTextReadings(agent, (kind, item) => (kind === 'field_purpose' ? FIELD_PURPOSE[item.text] ?? null
      : kind === 'control_effect' ? (item.text === 'Senden' ? fixtureControlEffectReading(item.text) : 'view') : null));
    const forms = [
      classify(mastodonSearch()),
      classify(withField({ label: 'Ara veya URL yapıştır' })),
      classify(withField({ label: '検索' })),
      // A comment box with an icon-only send button in the main content, and
      // a people picker outside any dialog.
      classify(withField({ label: 'Write a comment…' }, { submits: [{ label: '', type: 'submit' }] })),
      classify(withField({ label: 'Search people to invite' })),
      classify(withField({ label: 'Was gibt es Neues?' })),
      classify(withField({ label: 'Unread label' })),
      classify(mastodonSearch({ submits: [{ label: 'Senden', type: 'submit' }] })),
      classify(withField({ value: 'Hallo zusammen' })),
      classify(withField({ label: '' })),
    ];
    const pageState = { url: URL_AFTER_POST, openDialogCount: 0, visibleFormCount: forms.length,
      relevantFormCount: forms.filter(form => form.relevant).length, formDescriptors: forms, successMessages: [] };
    await agent._readCompletionFormSubmits(1, pageState);
    assert.deepEqual(pageState.formDescriptors.map(form => form.relevant),
      [false, false, false, true, true, true, true, true, true, true]);
    assert.deepEqual(pageState.formDescriptors.slice(0, 3).map(form => form.utilityReason),
      ['unmarked_search', 'unmarked_search', 'unmarked_search']);
    assert.equal(pageState.relevantFormCount, 7);
    // Field labels are asked only as field purposes, captions only as control effects.
    const askedAs = kind => [...new Set(asked.filter(item => item.kind === kind).map(item => item.text))].sort();
    assert.deepEqual(askedAs('field_purpose'), ['Ara veya URL yapıştır', 'Search people to invite', 'Suchen',
      'Unread label', 'Was gibt es Neues?', 'Write a comment…', '検索'].sort());
    assert.deepEqual(askedAs('control_effect'), ['Senden'], 'A draft or a form with nothing to read is never read');
  });

  test(`${build}: a field label is its own fixed-choice question, read once, the label only as untrusted page data`, async () => {
    const provider = { model: 'owned-forms-fixture', chat: async () => ({ content: '{}' }) };
    const agent = new Agent({ getActive: () => provider });
    agent._jevSettings = async () => null;
    // The active model's answers. "Rechercher" is answered as a search
    // without quoting the label, which a search answer needs to count.
    const calls = installModelStub(agent, { provider, decide: (kind, { items }) => (kind !== 'field_purpose' ? null : {
      answers: items.map((item, index) => (item.text === 'Rechercher'
        ? { item: index, choice: 'search', evidence: '' }
        : { item: index, choice: FIELD_PURPOSE[item.text], evidence: FIELD_PURPOSE[item.text] === 'search' ? item.text : '' })),
    }) });
    const labels = ['Ara veya URL yapıştır', 'Write a comment…', 'Search people to invite', 'Rechercher'];
    const read = async () => {
      const forms = labels.map(label => classify(withField({ label })));
      const pageState = { relevantFormCount: forms.length, formDescriptors: forms };
      await agent._readCompletionFormSubmits(1, pageState);
      return pageState;
    };
    const first = await read();
    assert.deepEqual(first.formDescriptors.map(form => form.relevant), [false, true, true, true]);
    assert.equal(first.relevantFormCount, 3);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.kind, 'field_purpose');
    assert.equal(call.request, '');
    assert.match(call.system, /Decide what typing into this field is for/);
    assert.match(call.system, /"search": It searches, filters or finds things on this site/);
    assert.match(call.wrapped, /^<untrusted_page_content id="[a-z0-9]+">/);
    assert.deepEqual(call.items.map(item => item.text), labels);
    for (const label of labels) assert.equal(call.system.includes(label), false, `${label} reached the question itself`);
    // The same labels on the next check are not asked again; the unquoted
    // search answer was no answer and is asked again.
    const second = await read();
    assert.deepEqual(second.formDescriptors.map(form => form.relevant), [false, true, true, true]);
    assert.deepEqual(calls.slice(1).map(item => item.items.map(entry => entry.text)), [['Rechercher']]);
  });

  test(`${build}: done is not blocked by the sidebar search alone, and still is by a form whose button sends`, async () => {
    const agent = new Agent({});
    stubPageTextReadings(agent, (kind, item) => (kind === 'field_purpose' ? FIELD_PURPOSE[item.text] ?? null
      : kind === 'control_effect' ? fixtureControlEffectReading(item.text) : null));
    agent._planExecutionGuards.set(1, { enabled: true, requestKind: 'execute', requiresStateChange: true, requiresSubmission: true });
    const state = forms => ({ url: URL_AFTER_POST, openDialogCount: 0, visibleFormCount: forms.length,
      relevantFormCount: forms.filter(form => form.relevant).length, formDescriptors: forms, successMessages: [] });
    const sidebarOnly = state([classify(mastodonSearch())]);
    // Before the reading, the form counts; this is what blocked done twice.
    assert.match(agent._completionPageWarning(1, 'Posted.', 'success', sidebarOnly, URL_AFTER_POST)?.warning || '',
      /task-relevant form is still visible/);
    await agent._readCompletionFormSubmits(1, sidebarOnly);
    assert.equal(agent._completionPageWarning(1, 'Posted.', 'success', sidebarOnly, URL_AFTER_POST), null);
    for (const form of [classify(mastodonSearch({ submits: [{ label: 'Senden', type: 'submit' }] })),
      classify(withField({ value: 'Hallo zusammen' })),
      classify(withField({ label: 'Write a comment…' }, { submits: [{ label: '', type: 'submit' }] }))]) {
      const pending = state([classify(mastodonSearch()), form]);
      await agent._readCompletionFormSubmits(1, pending);
      assert.match(agent._completionPageWarning(1, 'Posted.', 'success', pending, URL_AFTER_POST)?.warning || '',
        /task-relevant form is still visible/);
    }
  });
}
