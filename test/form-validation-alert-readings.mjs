// Form validation reads alert text by meaning, in any language. The page-side
// probe only sorts alerts by page structure (an invalid field pointing to it,
// a form holding an invalid field, the site's own error marks); a model reads
// what each alert says before a submit counts as rejected.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { stubPageTextReadings } from './semantic-decision-stub.mjs';

const area = { get: async () => ({ systemOneEnabled: false }), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area }, runtime: { getURL: value => `extension://test/${value}` },
};

const fixture = `<!doctype html><meta charset="utf-8">
<form id="profile">
  <label>E-posta <input id="email" type="email" aria-invalid="true" aria-errormessage="email-error"></label>
  <p id="email-error" role="alert">E-posta adresi geçersiz.</p>
  <div role="alert">Lütfen tüm zorunlu alanları doldurun.</div>
  <button>Kaydet</button>
</form>
<div role="alert" class="alert alert-danger">Sunucu isteği reddetti.</div>
<div role="alert">Lütfen geçerli bir telefon numarası girin.</div>
<div aria-live="polite">Kaydedildi.</div>
<div role="alert" hidden>Gizli uyarı</div>`;

const submitContext = {
  toolName: 'click', args: { text: 'Kaydet' },
  result: { success: true, tag: 'BUTTON', type: 'submit', isSubmitControl: true },
};
const state = (alerts = [], otherAlerts = []) => [{
  frameId: 0, url: 'https://owned.example.test/profile', activeInvalid: false,
  invalidFields: [], ariaInvalidFields: [], alerts, otherAlerts, controlFingerprint: 'same',
}];

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  test(`${build}: the validation probe sorts alerts by page structure, not by wording`, async () => {
    for (const launcher of [chromium, firefox]) {
      const browser = await launcher.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.setContent(fixture);
        const snapshot = await page.evaluate(`(${Agent._formValidationStateProbe.toString()})()`);
        assert.deepEqual(snapshot.alerts, ['E-posta adresi geçersiz.', 'Lütfen tüm zorunlu alanları doldurun.', 'Sunucu isteği reddetti.']);
        assert.deepEqual(snapshot.otherAlerts, ['Lütfen geçerli bir telefon numarası girin.', 'Kaydedildi.']);
        assert.equal('alertsAreValidationOnly' in snapshot, false);
      } finally { await browser.close(); }
    }
  });

  test(`${build}: an alert without a structural mark rejects a submit only when a model reads it as an error`, async () => {
    const text = 'Lütfen geçerli bir telefon numarası girin.';
    for (const [reading, rejected] of [['error', true], ['other', false], ['success', false], [null, false]]) {
      const agent = new Agent({});
      const asked = stubPageTextReadings(agent, () => reading);
      agent._captureFormValidationState = async () => state([], [text]);
      const result = await agent._waitForFormValidationFailure(41, state(), submitContext, { checkpointsMs: [0] });
      assert.equal(!!result, rejected, `${reading}`);
      if (rejected) assert.match(result.error, /telefon numarası/);
      assert.deepEqual(asked.map(item => [item.kind, item.text]), [['status_message', text]]);
    }
  });

  test(`${build}: an alert the page marks as an error rejects a submit unless a model reads it as success`, async () => {
    const text = 'Kaydedildi.';
    for (const [reading, rejected] of [['success', false], ['error', true], ['other', true], [null, true]]) {
      const agent = new Agent({});
      stubPageTextReadings(agent, () => reading);
      agent._captureFormValidationState = async () => state([text]);
      const result = await agent._waitForFormValidationFailure(42, state(), submitContext, { checkpointsMs: [0] });
      assert.equal(!!result, rejected, `${reading}`);
    }
  });

  test(`${build}: an alert already on the page is not new, whenever a model reads it`, async () => {
    const text = 'Oturumunuz yakında sona erecek.';
    const agent = new Agent({});
    const asked = stubPageTextReadings(agent, () => 'error');
    agent._captureFormValidationState = async () => state([], [text]);
    const result = await agent._waitForFormValidationFailure(43, state([], [text]), submitContext, { checkpointsMs: [0] });
    assert.equal(result, null);
    assert.deepEqual(asked, [], 'A pre-existing alert is not read again for a new submit');
    // After a rejected submit the same alert can still be the reason: read it.
    const retry = await agent._waitForFormValidationFailure(43, state([], [text]),
      { ...submitContext, priorValidationFailure: true, detectedSubmit: { isSubmit: true, validationSubmitEvidence: 'strong' } },
      { checkpointsMs: [0] });
    assert.ok(retry, 'A persistent alert read as an error still rejects a repeated submit');
    assert.deepEqual(asked.map(item => item.text), [text]);
  });
}
