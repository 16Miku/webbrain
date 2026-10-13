import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const sourceRoot = process.env.WEBBRAIN_WORKFLOW_SOURCE_ROOT || path.resolve('.');
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  const source = path.resolve(sourceRoot, `src/${build}/src`);
  const { parseAccessibilityTreeDescriptors, findWorkflowTarget, scoreWorkflowTarget } = await import(pathToFileURL(path.join(source, 'agent/workflows.js')));
  async function withNativeTree(run) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<!doctype html><meta charset="utf-8"><form><label for="initial">QA native field</label><input id="initial" name="qa_value" type="text"><button type="button">Save "QA"</button></form>');
      await page.addScriptTag({ content: await fs.readFile(path.join(source, 'content/accessibility-tree.js'), 'utf8') });
      const tree = async () => page.evaluate(() => window.__generateAccessibilityTree({ filter: 'all', maxChars: 60000 }));
      const descriptors = async () => {
        const result = await tree();
        return parseAccessibilityTreeDescriptors(typeof result === 'string' ? result : result.pageContent || result.tree || result.content || '');
      };
      await run({ page, tree, descriptors });
    } finally { await browser.close(); }
  }

  test(`${build}: workflow parser consumes the actual native AX id and field-name grammar`, async () => {
    await withNativeTree(async ({ page, tree, descriptors }) => {
      const id = 'qa"id\\tail', fieldName = 'qa"field\\tail';
      await page.evaluate(({ id, fieldName }) => {
        const input = document.querySelector('input'); input.id = id; input.name = fieldName;
        document.querySelector('label').htmlFor = id;
      }, { id, fieldName });
      const raw = await tree(); assert.match(JSON.stringify(raw), /dom_id/); assert.match(JSON.stringify(raw), /field_name/);
      const target = (await descriptors()).find(entry => entry.role === 'textbox');
      assert.equal(target?.id, id); assert.equal(target?.fieldName, fieldName);
      assert.equal(target?.name, 'QA native field');
    });
  });

  test(`${build}: demonstrated semantic targets survive native document replacements and retain ambiguity fences`, async () => {
    await withNativeTree(async ({ page, descriptors }) => {
      const target = { role: 'textbox', label: 'QA native field', id: 'old-document-id', fieldName: 'qa_value', type: 'text' };
      await page.evaluate(() => {
        const input = document.querySelector('input'); input.id = 'fresh-document-id'; document.querySelector('label').htmlFor = input.id;
        const decoy = input.cloneNode(); decoy.id = 'old-document-id'; decoy.name = 'different_field'; input.before(decoy);
      });
      const match = findWorkflowTarget(target, await descriptors());
      assert.equal(match.status, 'matched'); assert.equal(match.candidate.id, 'fresh-document-id');
      await page.evaluate(() => { const copy = document.querySelector('input[name="qa_value"]').cloneNode(); copy.id = 'second-same-name'; document.querySelector('form').append(copy); });
      assert.equal(findWorkflowTarget(target, await descriptors()).status, 'ambiguous', 'A fresh duplicate cannot inherit the demonstrated target.');
    });
  });

  test(`${build}: recycled ids cannot override contradictory native field identities`, () => {
    const target = { role: 'textbox', id: 'shared-id', fieldName: 'qa_value', type: 'text' };
    const wrong = { refId: 'ref_wrong', ...target, fieldName: 'different_field' };
    assert.equal(scoreWorkflowTarget(target, wrong), 0);
    assert.equal(findWorkflowTarget(target, [wrong]).status, 'miss');
    assert.equal(findWorkflowTarget(target, [{ ...wrong, fieldName: 'QA_VALUE' }]).status, 'miss', 'Native field names are case-sensitive.');
    const correct = { refId: 'ref_correct', ...target, id: 'fresh-id' };
    assert.equal(findWorkflowTarget(target, [wrong, correct]).candidate.refId, 'ref_correct');
    assert.equal(findWorkflowTarget(target, [{ refId: 'ref_legacy', role: target.role, id: target.id, type: target.type }]).status, 'matched', 'Older descriptors without a field name remain compatible.');
    assert.equal(findWorkflowTarget({ role: target.role, id: target.id, type: target.type }, [wrong]).status, 'matched', 'An older saved target without a field name remains compatible.');
  });

  test(`${build}: actual quoted accessible names survive fresh-target parsing`, async () => {
    await withNativeTree(async ({ page, descriptors }) => {
      await page.evaluate(() => { document.querySelector('button').textContent = 'Save "QA" \\ literal'; });
      const name = 'Save "QA" \\ literal';
      const target = (await descriptors()).find(entry => entry.role === 'button');
      assert.equal(target?.name, name);
      assert.equal(findWorkflowTarget({ role: 'button', name }, [target]).status, 'matched');
    });
  });

  test(`${build}: legacy AX attributes remain compatible and unrelated escape sequences remain literal`, () => {
    const [legacy] = parseAccessibilityTreeDescriptors('textbox "Email" [ref_legacy] id="email" name="email_address" type="email"');
    assert.equal(legacy.id, 'email'); assert.equal(legacy.fieldName, 'email_address');
    const [current] = parseAccessibilityTreeDescriptors(String.raw`textbox "Literal" [ref_current] dom_id="literal\n\t\u0041" field_name="field\q" type="text"`);
    assert.equal(current.id, String.raw`literal\n\t\u0041`); assert.equal(current.fieldName, String.raw`field\q`);
  });
}
