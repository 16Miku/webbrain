// WebBrain's own recipient confirmation card in the side panel of both
// builds: the real renderClarifyCard and submitClarify run in Chromium and
// Firefox with the real locale strings. The card names the person the open
// conversation shows, offers fixed choices only (no free text to interpret),
// sends a stable value back, never times out, and records no memory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const read = (build, file) => fs.readFileSync(new URL(`../src/${build}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(source, name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing function: ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

async function panel(build, engine, locale) {
  const source = read(build, 'src/ui/sidepanel.js');
  const strings = (await import(`../src/${build}/src/ui/locales/${locale}.js`)).default;
  const english = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
  const browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 380, height: 700 } });
  await page.setContent(`<style>${read(build, 'styles/sidepanel.css')}</style>
    <div class="message assistant" data-run-request-id="request-1"><div class="message-content"></div></div>`);
  await page.addScriptTag({ content: `(() => {
    const STRINGS = ${JSON.stringify({ ...english, ...strings })};
    const t = (key, params) => String(STRINGS[key] ?? key).replace(/\\{(\\w+)\\}/g, (_, name) => params?.[name] ?? '{' + name + '}');
    let currentTabId = 9;
    let currentAssistantEl = document.querySelector('.message.assistant');
    const submittedClarificationIds = new Set();
    const sent = [];
    function clarificationSubmissionKey(tabId, requestId, clarifyId) { return JSON.stringify([Number(tabId), String(requestId || ''), String(clarifyId || '')]); }
    function hideActivity() {} function playClarifySound() {} function scrollToBottom() {} function hideRecommendedActions() {}
    function resetChatNavigation() {} function addMessage() { return currentAssistantEl; } function applyClarifyTimeoutExtension() {}
    function clearClarifyCountdown() {} function placeAnsweredClarifyCardInTimeline() {} function startClarifyCountdown() { sent.push(['countdown']); }
    function maybeShowPermissionEducationHint() {} function workflowHealingTargetLabel(value) { return String(value || ''); }
    function sameTabId(a, b) { return Number(a) === Number(b); } function restoreActiveRunState() {}
    const CAPABILITY_LABEL = {};
    async function sendToBackground(action, payload) { sent.push([action, payload]); return { matched: true }; }
    ${extract(source, 'renderClarifyCard')}
    ${extract(source, 'submitClarify')}
    window.panel = { render: renderClarifyCard, sent };
  })();` });
  return { browser, page };
}

const card = (extra = {}) => ({ clarifyId: 'recipient_card', tabId: 9, promptKind: 'recipientConfirmation',
  question: 'Send to Gamze Çömlekçi?', options: ['once', 'deny'],
  recipientConfirmation: { recipients: [{ identity: 'Gamze Çömlekçi', role: 'to' }], requested: ['gamze'],
    host: 'www.instagram.com', offerAll: false }, ...extra });

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: the card names both people and sends a fixed value`, async () => {
    const { browser, page } = await panel(build, engine, 'en');
    try {
      await page.evaluate(data => window.panel.render(data), card());
      const view = await page.evaluate(() => {
        const element = document.querySelector('.clarify-card');
        return { question: element.querySelector('.clarify-question').textContent,
          reason: element.querySelector('.clarify-reason').textContent,
          buttons: [...element.querySelectorAll('.clarify-option')].map(button => [button.dataset.value, button.textContent]),
          input: !!element.querySelector('input, textarea'), memory: element.dataset.memorySource,
          flag: element.dataset.recipientConfirmation };
      });
      assert.equal(view.question, 'Send to Gamze Çömlekçi?');
      assert.equal(view.reason, 'Your request named “gamze”. The open conversation on www.instagram.com is with Gamze Çömlekçi.');
      assert.deepEqual(view.buttons, [['once', 'Send to Gamze Çömlekçi'], ['deny', 'Don’t send']]);
      assert.equal(view.input, false, 'no free text to interpret');
      assert.equal(view.memory, '', 'a recipient choice is not saved to memory');
      assert.equal(view.flag, '1');
      await page.click('button[data-value="once"]');
      const after = await page.evaluate(() => ({ sent: window.panel.sent,
        answered: document.querySelector('.clarify-your-answer')?.textContent,
        disabled: [...document.querySelectorAll('.clarify-option')].every(button => button.disabled) }));
      assert.deepEqual(after.sent, [['clarify_response', { tabId: 9, clarifyId: 'recipient_card', answer: 'once', source: 'option' }]]);
      assert.equal(after.answered, 'Your answer: Send to Gamze Çömlekçi');
      assert.equal(after.disabled, true);
    } finally { await browser.close(); }
  });

  test(`${build}: Turkish card, the remaining-sends choice, and copy roles`, async () => {
    const { browser, page } = await panel(build, engine, 'tr');
    try {
      await page.evaluate(data => window.panel.render(data), card({ options: ['once', 'always', 'deny'],
        recipientConfirmation: { recipients: [{ identity: 'ali@example.com', role: 'to' }, { identity: 'veli@example.com', role: 'cc' }],
          requested: [], host: 'mail.example.com', offerAll: true } }));
      const view = await page.evaluate(() => ({
        question: document.querySelector('.clarify-question').textContent,
        reason: document.querySelector('.clarify-reason').textContent,
        buttons: [...document.querySelectorAll('.clarify-option')].map(button => [button.dataset.value, button.textContent]) }));
      assert.equal(view.question, 'ali@example.com, veli@example.com (CC) adlı kişiye gönderilsin mi?');
      assert.equal(view.reason, 'mail.example.com üzerinde açık olan sohbet: ali@example.com, veli@example.com (CC).');
      assert.deepEqual(view.buttons.map(([value]) => value), ['once', 'always', 'deny']);
      assert.equal(view.buttons[1][1], 'Gönder, bu görevde bir daha sorma');
      await page.click('button[data-value="deny"]');
      assert.deepEqual(await page.evaluate(() => window.panel.sent.map(([action, payload]) => [action, payload.answer])),
        [['clarify_response', 'deny']]);
    } finally { await browser.close(); }
  });

  test(`${build}: page text in the card is shown as text, never as markup`, async () => {
    const { browser, page } = await panel(build, engine, 'en');
    try {
      await page.evaluate(data => window.panel.render(data), card({ recipientConfirmation: {
        recipients: [{ identity: '<img src=x onerror="window.injected=1">Mallory', role: 'to' }],
        requested: ['<b>gamze</b>'], host: 'www.instagram.com', offerAll: false } }));
      const view = await page.evaluate(() => ({ images: document.querySelectorAll('.clarify-card img').length,
        injected: window.injected === 1, question: document.querySelector('.clarify-question').textContent }));
      assert.equal(view.images, 0);
      assert.equal(view.injected, false);
      assert.match(view.question, /<img src=x/);
    } finally { await browser.close(); }
  });
}

test('every locale of both builds translates the card', async () => {
  const keys = ['sp.recipient.question', 'sp.recipient.reason_requested', 'sp.recipient.reason_open',
    'sp.recipient.send', 'sp.recipient.send_all', 'sp.recipient.dont_send'];
  for (const build of ['chrome', 'firefox']) {
    const directory = new URL(`../src/${build}/src/ui/locales/`, import.meta.url);
    const locales = fs.readdirSync(directory).filter(name => /^[a-z]{2}\.js$/.test(name));
    assert.equal(locales.length, 23, `${build}: locale count`);
    for (const file of locales) {
      const strings = (await import(new URL(file, directory))).default;
      for (const key of keys) {
        assert.equal(typeof strings[key], 'string', `${build}/${file}: ${key}`);
        for (const name of ['{recipient}'].concat(key.includes('reason') ? ['{host}'] : [])) {
          assert.ok(strings[key].includes(name) || ['sp.recipient.send_all', 'sp.recipient.dont_send'].includes(key),
            `${build}/${file}: ${key} lacks ${name}`);
        }
      }
      assert.ok(strings['sp.recipient.reason_requested'].includes('{requested}'), `${build}/${file}: requested name`);
    }
  }
});
