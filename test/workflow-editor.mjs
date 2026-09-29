import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, firefox } from 'playwright';
import { fileURLToPath } from 'node:url';
import { importPortableWorkflowDefinition as importChromeWorkflow } from '../src/chrome/src/agent/workflows.js';
import { importPortableWorkflowDefinition as importFirefoxWorkflow } from '../src/firefox/src/agent/workflows.js';

const pageURL = new URL('../web/workflow-editor/index.html', import.meta.url).href;
const scriptPath = fileURLToPath(new URL('../web/workflow-editor/workflow-editor.js', import.meta.url));
const fixture = {
  schema: 'webbrain-workflow/1', name: 'Example workflow', id: 'workflow_1',
  createdAt: 1790572374560, source: { version: '1', extra: null },
  parameters: [{ id: 'email', label: 'Email', required: true, sensitive: false, type: 'text' }],
  steps: [
    { id: 'step_1', tool: 'set_field', args: { text: { $workflowParam: 'email' }, clear: true }, target: { name: 'Email' } },
    { id: 'step_2', tool: 'click_ax', args: {}, target: { name: 'Save' } }
  ],
  extra: JSON.parse('{"__proto__":{"safe":true},"nested":[null,false,12.5,"<img src=x onerror=alert(1)>"]}')
};
const val = (page, path) => page.getByRole('textbox', { name: `Value ${JSON.stringify(path)}`, exact: true });
async function edit(locator, value) { await locator.fill(value); await locator.dispatchEvent('change'); }

for (const [name, browserType] of Object.entries({ chromium, firefox })) {
  async function withEditor(run) {
    const browser = await browserType.launch();
    try {
      const page = await browser.newPage({ offline: true });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pageURL);
      await page.getByRole('button', { name: 'Start a new workflow' }).waitFor();
      await run(page);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }

  test(`${name}: marking a save complete preserves active edits and focus`, () => withEditor(async page => {
    await page.evaluate(value => editor.load(value), fixture);
    const nameInput = val(page, ['name']);
    await nameInput.fill('Typing while an earlier save finishes');
    const before = await nameInput.evaluate(input => ({ start: input.selectionStart, end: input.selectionEnd }));
    await page.evaluate(() => editor.markSaved());
    assert.equal(await nameInput.inputValue(), 'Typing while an earlier save finishes');
    assert.equal(await nameInput.evaluate(input => input.getRootNode().activeElement === input), true);
    assert.deepEqual(await nameInput.evaluate(input => ({ start: input.selectionStart, end: input.selectionEnd })), before);
    assert.equal(await page.evaluate(() => editor.isDirty()), true);
    assert.equal(await page.evaluate(() => editor.getValue().name), fixture.name);
    await nameInput.press('Tab');
    assert.equal(await page.evaluate(() => editor.getValue().name), 'Typing while an earlier save finishes');
    assert.equal(await page.evaluate(() => editor.isDirty()), true);
    await page.evaluate(() => editor.markSaved());
    assert.equal(await page.evaluate(() => editor.isDirty()), false);
    await page.getByRole('button', { name: 'JSON source', exact: true }).click();
    const source = page.getByRole('textbox', { name: 'Workflow JSON source' });
    await source.fill('{unfinished');
    await page.evaluate(() => editor.markSaved());
    assert.equal(await source.inputValue(), '{unfinished');
    assert.equal(await page.evaluate(() => editor.isDirty()), true);
  }));

  test(`${name}: actions immediately after a key rename use the new path`, () => withEditor(async page => {
    await page.evaluate(value => editor.load(value), { ...fixture, note: 'keep', settings: { child: 'remove', list: ['a', 'b'] } });
    await page.getByLabel('Field name ["note"]', { exact: true }).fill('renamedNote');
    await page.getByRole('button', { name: 'Remove ["note"]', exact: true }).click();
    assert.equal(await page.evaluate(() => Object.hasOwn(editor.getValue(), 'renamedNote')), false);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await page.evaluate(() => editor.getValue().renamedNote), 'keep');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal(await page.evaluate(() => editor.getValue().note), 'keep');
    await page.getByLabel('Field name ["settings"]', { exact: true }).fill('options');
    await page.getByRole('button', { name: 'Remove ["settings","child"]', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => editor.getValue().options), { list: ['a', 'b'] });
    await page.getByLabel('Field name ["options"]', { exact: true }).fill('config');
    await page.getByRole('button', { name: 'Move down ["options","list",0]', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => editor.getValue().config.list), ['b', 'a']);
    await page.getByLabel('Field name ["config"]', { exact: true }).fill('finalConfig');
    const list = page.locator('[data-path=\'["config","list"]\']');
    await list.getByRole('button', { name: '+ Add item', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => editor.getValue().finalConfig.list), ['b', 'a', '']);
  }));

  test(`${name}: new workflows expose a starting scope and can be imported`, () => withEditor(async page => {
    await page.getByRole('button', { name: 'Start a new workflow' }).click();
    assert.deepEqual(await page.evaluate(() => editor.getValue().start), { origin: '', pathFamily: '/' });
    assert.ok((await page.evaluate(() => editor.validate())).some(issue => issue.includes('start.origin')));
    await edit(val(page, ['start', 'origin']), 'https://example.com/path');
    assert.ok((await page.evaluate(() => editor.validate())).some(issue => issue.includes('start.origin')));
    await edit(val(page, ['start', 'origin']), 'https://example.com');
    await edit(val(page, ['start', 'pathFamily']), 'missing-leading-slash');
    assert.ok((await page.evaluate(() => editor.validate())).some(issue => issue.includes('start.pathFamily')));
    await edit(val(page, ['start', 'pathFamily']), '/');
    assert.ok((await page.evaluate(() => editor.validate())).some(issue => issue.includes('Add at least one workflow step')));
    assert.equal((name === 'chromium' ? importChromeWorkflow : importFirefoxWorkflow)(await page.evaluate(() => editor.getValue())).reason, 'invalid_workflow');
    await page.getByRole('button', { name: '+ Add', exact: true }).last().click();
    assert.deepEqual(await page.evaluate(() => editor.getValue().steps[0].scope), { origin: 'https://example.com', pathFamily: '/' });
    assert.ok((await page.evaluate(() => editor.validate())).some(issue => issue.includes('needs a replayable target')));
    await edit(val(page, ['steps', 0, 'target', 'name']), 'Continue');
    assert.deepEqual(await page.evaluate(() => editor.validate()), []);
    const output = JSON.parse(await page.evaluate(() => editor.toJSON()));
    const imported = (name === 'chromium' ? importChromeWorkflow : importFirefoxWorkflow)(output);
    assert.equal(imported.reason, '');
    assert.equal(imported.workflow.steps.length, 1);
  }));

  test(`${name}: parameter ids follow importer normalization and remain unique`, () => withEditor(async page => {
    const workflow = {
      ...fixture,
      start: { origin: 'https://example.com', pathFamily: '/' },
      parameters: [
        ...fixture.parameters,
        { id: 'NEW-ID', label: 'Legacy id', required: false, sensitive: false, type: 'text' },
        { id: 'PARAMETER_1', label: 'Legacy uppercase id', required: false, sensitive: false, type: 'text' }
      ]
    };
    await page.evaluate(value => editor.load(value), workflow);
    await page.getByRole('button', { name: 'Parameter 1: Email', exact: true }).click();
    await page.getByRole('heading', { name: 'Parameter 1', exact: true }).waitFor();
    const id = val(page, ['parameters', 0, 'id']);
    assert.ok((await page.evaluate(() => editor.validate())).some(issue => issue.includes('not canonical')));
    for (const invalid of ['Email', 'email address', 'x'.repeat(81)]) {
      await edit(id, invalid);
      assert.equal(await page.evaluate(() => editor.getValue().parameters[0].id), 'email');
      assert.equal(await page.evaluate(() => editor.getValue().steps[0].args.text.$workflowParam), 'email');
    }
    // `new-id` collides with the legacy uppercase id after importer normalization.
    await edit(id, 'new-id');
    assert.equal(await page.evaluate(() => editor.getValue().parameters[0].id), 'email');
    await edit(id, 'address_2');
    assert.equal(await page.evaluate(() => editor.getValue().parameters[0].id), 'address_2');
    assert.equal(await page.evaluate(() => editor.getValue().steps[0].args.text.$workflowParam), 'address_2');
    const normalized = (name === 'chromium' ? importChromeWorkflow : importFirefoxWorkflow)(await page.evaluate(() => editor.getValue()));
    assert.equal(normalized.reason, '');
    await page.getByRole('button', { name: '+ Add', exact: true }).first().click();
    assert.equal(await page.evaluate(() => editor.getValue().parameters.at(-1).id), 'parameter_2');
    await page.getByRole('button', { name: /Parameter 4: New parameter/ }).click();
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
    assert.equal(await page.evaluate(() => editor.getValue().parameters.at(-1).id), 'parameter_3');
    const ids = await page.evaluate(() => editor.getValue().parameters.map(parameter => parameter.id.toLowerCase()));
    assert.equal(new Set(ids).size, ids.length);
  }));

  test(`${name}: workflow size limits are visible and enforced`, () => withEditor(async page => {
    const oversized = {
      ...fixture,
      parameters: Array.from({ length: 51 }, (_, index) => ({ id: `parameter_${index + 1}`, label: `Parameter ${index + 1}`, type: 'text' })),
      steps: Array.from({ length: 101 }, (_, index) => ({ id: `step_${index + 1}`, tool: 'click_ax', args: {}, target: { name: `Step ${index + 1}` } }))
    };
    await page.evaluate(value => editor.load(value), oversized);
    const issues = await page.evaluate(() => editor.validate());
    assert.ok(issues.some(issue => issue.includes('parameters cannot contain more than 50')));
    assert.ok(issues.some(issue => issue.includes('steps cannot contain more than 100')));
    assert.equal((name === 'chromium' ? importChromeWorkflow : importFirefoxWorkflow)(oversized).reason, 'invalid_workflow');
    assert.equal(await page.getByRole('button', { name: '+ Add', exact: true }).first().isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '+ Add', exact: true }).last().isDisabled(), true);
    await page.getByRole('button', { name: 'Parameter 1: Parameter 1', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Duplicate', exact: true }).isDisabled(), true);
  }));

  test(`${name}: portable JSON byte limit is reported before export`, () => withEditor(async page => {
    const oversized = { ...fixture, extra: { payload: 'x'.repeat(1024 * 1024) } };
    await page.evaluate(value => editor.load(value), oversized);
    assert.ok((await page.evaluate(() => editor.validate())).some(issue => issue.includes('exceeds the importer 1 MiB file limit')));
    assert.equal((name === 'chromium' ? importChromeWorkflow : importFirefoxWorkflow)(oversized).reason, 'workflow_too_large');
  }));

  test(`${name}: offline file import, editing, preservation, export, embedding`, async () => {
    const browser = await browserType.launch();
    try {
      const context = await browser.newContext({ offline: true, acceptDownloads: true });
      const page = await context.newPage();
      const errors = [], network = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
      await page.goto(pageURL);
      await page.getByLabel('Open workflow file').setInputFiles({ name: 'example.webbrain-workflow.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
      await page.getByRole('heading', { name: 'Workflow details', exact: true }).waitFor();
      assert.deepEqual(JSON.parse(await page.evaluate(() => JSON.stringify(editor.getValue()))), fixture);
      assert.equal(await page.locator('img').count(), 0);
      await val(page, ['name']).fill('Renamed workflow');
      await page.getByRole('button', { name: 'Parameter 1: Email', exact: true }).click();
      await page.getByRole('heading', { name: 'Parameter 1', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => editor.getValue().name), 'Renamed workflow');
      await edit(val(page, ['parameters', 0, 'id']), 'address');
      assert.equal(await page.evaluate(() => editor.getValue().steps[0].args.text.$workflowParam), 'address');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.equal(await page.evaluate(() => editor.getValue().steps[0].args.text.$workflowParam), 'email');
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await page.getByRole('button', { name: 'Step 2: Save', exact: true }).click();
      await page.getByRole('button', { name: 'Move up', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => editor.getValue().steps.map(s => s.id)), ['step_2', 'step_1']);
      await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
      assert.equal(new Set(await page.evaluate(() => editor.getValue().steps.map(s => s.id))).size, 3);
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      // Drag reordering works as well as the keyboard-accessible move buttons.
      await page.getByRole('button', { name: 'Step 1: Save', exact: true }).dragTo(page.getByRole('button', { name: 'Step 2: Email', exact: true }));
      assert.deepEqual(await page.evaluate(() => editor.getValue().steps.map(s => s.id)), ['step_1', 'step_2']);
      await page.getByRole('button', { name: 'Workflow details', exact: true }).click();
      await page.getByLabel('New field name at []', { exact: true }).fill('newField');
      await page.getByRole('button', { name: '+ Add field', exact: true }).last().click();
      await edit(val(page, ['newField']), 'New value');
      await edit(page.getByLabel('Field name ["newField"]', { exact: true }), 'renamedField');
      assert.equal(await page.evaluate(() => editor.getValue().renamedField), 'New value');
      await page.getByRole('button', { name: 'Remove ["renamedField"]', exact: true }).click();
      await page.getByRole('button', { name: 'JSON source', exact: true }).click();
      const raw = page.getByRole('textbox', { name: 'Workflow JSON source' });
      await raw.fill('{bad json');
      assert.equal(await page.getByRole('button', { name: 'Download JSON' }).isDisabled(), true);
      await page.getByRole('button', { name: 'Apply JSON' }).click();
      assert.equal(await raw.inputValue(), '{bad json');
      assert.equal(await page.evaluate(() => editor.getValue().name), 'Renamed workflow');
      await page.getByRole('button', { name: 'Discard JSON edits' }).click();
      const next = JSON.parse(await page.evaluate(() => JSON.stringify(editor.getValue()))); next.extra.raw = 'preserved';
      await raw.fill(JSON.stringify(next)); await page.getByRole('button', { name: 'Apply JSON' }).click();
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download JSON' }).click();
      const download = await downloadPromise;
      const stream = await download.createReadStream(); const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const exported = JSON.parse(Buffer.concat(chunks).toString());
      assert.deepEqual(exported, next);
      assert.deepEqual(exported.extra.__proto__, { safe: true });
      assert.equal(download.suggestedFilename(), 'example.webbrain-workflow.json');
      assert.equal(await page.evaluate(() => editor.isDirty()), false);
      assert.equal(await page.evaluate(() => ({}).safe), undefined);
      // A focused field is included by the keyboard download shortcut.
      await page.getByRole('button', { name: 'Workflow details', exact: true }).click();
      await val(page, ['name']).fill('Keyboard save');
      assert.equal(await page.evaluate(() => editor.isDirty()), true);
      const keyboardDownload = page.waitForEvent('download');
      await val(page, ['name']).press('Control+s');
      const keyStream = await (await keyboardDownload).createReadStream(); const keyChunks = [];
      for await (const chunk of keyStream) keyChunks.push(chunk);
      assert.equal(JSON.parse(Buffer.concat(keyChunks).toString()).name, 'Keyboard save');
      const filenameDownload = page.waitForEvent('download');
      await page.getByLabel('Download filename').fill('keyboard-name.json');
      await page.getByLabel('Download filename').press('Control+s');
      assert.equal((await filenameDownload).suggestedFilename(), 'keyboard-name.json');
      let rejectedDownloads = 0;
      page.on('download', () => { rejectedDownloads++; });
      await page.getByRole('button', { name: 'Parameter 1: Email', exact: true }).click();
      await val(page, ['parameters', 0, 'id']).fill('Invalid ID');
      await val(page, ['parameters', 0, 'id']).press('Control+s');
      await page.waitForTimeout(100);
      assert.equal(rejectedDownloads, 0);
      assert.equal(await page.evaluate(() => editor.getValue().parameters[0].id), 'address');
      assert.match(await page.getByRole('status').innerText(), /Parameter ids must use/);
      await val(page, ['parameters', 0, 'id']).fill('Invalid ID');
      await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
      await page.waitForTimeout(100);
      assert.equal(rejectedDownloads, 0);
      assert.equal(await page.evaluate(() => editor.getValue().parameters[0].id), 'address');
      assert.match(await page.getByRole('status').innerText(), /Parameter ids must use/);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Workflow details', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(network, []); assert.deepEqual(errors, []);

      // File drop and malformed imports leave the current document intact.
      await page.evaluate(text => {
        const transfer = new DataTransfer(); transfer.items.add(new File([text], 'dropped.json', { type: 'application/json' }));
        document.querySelector('#editor').shadowRoot.querySelector('.app').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
      }, JSON.stringify(fixture));
      await page.getByRole('textbox', { name: 'Value ["name"]', exact: true }).filter({ visible: true }).waitFor();
      await page.waitForFunction(() => editor.filename === 'dropped.json');
      assert.equal(await page.evaluate(() => editor.getValue().name), fixture.name);
      await page.getByLabel('Open workflow file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('[]') });
      await page.getByRole('status').filter({ hasText: 'Could not open file' }).waitFor();
      assert.equal(await page.evaluate(() => editor.getValue().name), fixture.name);

      // Two independent instances, public API copies, events, and teardown.
      const embedded = await context.newPage();
      await embedded.setContent('<div id="one"></div><div id="two"></div>');
      await embedded.addScriptTag({ path: scriptPath });
      const result = await embedded.evaluate(fixture => {
        const one = WorkflowEditor.mount('#one', { value: fixture });
        const two = WorkflowEditor.mount('#two', { value: fixture });
        const external = one.getValue(); external.name = 'external';
        const original = one.getValue().name;
        let changes = 0; document.querySelector('#one').addEventListener('workflowchange', () => changes++);
        const input = document.querySelector('#one').shadowRoot.querySelector('[aria-label=\'Value ["name"]\']');
        input.value = 'embedded change'; input.dispatchEvent(new Event('change'));
        const second = two.getValue().name;
        const edited = one.getValue().name;
        one.destroy();
        return { original, second, edited, changes, empty: document.querySelector('#one').shadowRoot.childElementCount === 0 };
      }, fixture);
      assert.deepEqual(result, { original: fixture.name, second: fixture.name, edited: 'embedded change', changes: 1, empty: true });
    } finally { await browser.close(); }
  });
}
