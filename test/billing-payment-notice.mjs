import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

for (const browser of ['chrome', 'firefox']) {
  const settings = fs.readFileSync(new URL(`../src/${browser}/src/ui/settings.js`, import.meta.url), 'utf8');
  const source = settings.slice(settings.indexOf('async function refreshWebbrainPaymentNotice()'), settings.indexOf('function renderProviders()'));
  const en = (await import(new URL(`../src/${browser}/src/ui/locales/en.js`, import.meta.url))).default;
  const tr = (await import(new URL(`../src/${browser}/src/ui/locales/tr.js`, import.meta.url))).default;

  async function render(status, options = {}) {
    const notice = { hidden: true, isConnected: true, style: {}, children: [], replaceChildren(...children) { this.children = children; } };
    const requests = [];
    const context = vm.createContext({
      providersContainer: { querySelector: () => notice },
      providersData: { webbrain_cloud: { deviceGuid: options.deviceGuid ?? 'test-browser', baseUrl: 'https://untrusted.example/v1' } },
      AbortSignal,
      document: { createElement: tag => ({ tag }) },
      t: key => (options.locale === 'tr' ? tr : en)[key],
      webbrainAccountUrl: device => `https://api.webbrain.one/account?client_reference_id=${encodeURIComponent(device)}`,
      fetch: async (url, config) => {
        requests.push({ url, config });
        if (options.failure) throw new Error('offline');
        if (options.detached) notice.isConnected = false;
        return { ok: options.ok !== false, json: async () => ({ subscription_status: status }) };
      },
    });
    vm.runInContext(source, context, { filename: fileURLToPath(new URL(`../src/${browser}/src/ui/settings.js`, import.meta.url)) });
    await vm.runInContext('refreshWebbrainPaymentNotice()', context);
    return { notice, requests };
  }

  for (const status of ['past_due', 'unpaid']) {
    const { notice, requests } = await render(status);
    assert.equal(notice.hidden, false, `${browser}: ${status} must show a payment warning`);
    assert.equal(notice.children[0].textContent, en['st.account.payment_failed']);
    assert.equal(notice.children[1].textContent, en['st.account.update_payment']);
    assert.equal(notice.children[1].href, 'https://api.webbrain.one/account?client_reference_id=test-browser');
    assert.equal(notice.children[1].rel, 'noopener noreferrer');
    assert.equal(requests[0].url, 'https://api.webbrain.one/v1/billing/status', 'Device identity must only go to the billing service');
    assert.equal(requests[0].config.headers['X-WebBrain-Device-Id'], 'test-browser');
    assert.equal(requests[0].config.credentials, 'omit');
    assert.equal(requests[0].config.cache, 'no-store');
  }
  for (const status of ['active', 'trialing', 'canceled', null, '<script>']) {
    assert.equal((await render(status)).notice.hidden, true, `${browser}: ${status} must not show a payment warning`);
  }
  for (const options of [{ failure: true }, { ok: false }, { detached: true }]) {
    assert.equal((await render('past_due', options)).notice.hidden, true, 'Failed or stale responses must not disrupt settings');
  }
  assert.equal((await render('past_due', { deviceGuid: '' })).requests.length, 0, 'No billing request without a device identity');
  assert.equal((await render('past_due', { locale: 'tr' })).notice.children[1].textContent, 'Ödeme yöntemini güncelle');

  const { OpenAICompatibleProvider: OpenAIProvider } = await import(new URL(`../src/${browser}/src/providers/openai.js`, import.meta.url));
  const provider = new OpenAIProvider({ providerName: 'webbrain-cloud', deviceGuid: 'test-browser' });
  const error = provider._formatHttpError(402, JSON.stringify({
    error: { code: 'webbrain_cloud_payment_failed', message: 'Your payment could not be completed.' },
    manage_billing_url: 'https://api.webbrain.one/portal?client_reference_id=test-browser',
  }));
  assert.match(error, /Update payment method: https:\/\/api.webbrain.one\/portal/);
  assert.doesNotMatch(error, /Subscribe for more usage|buy.stripe.com/);
  const panel = fs.readFileSync(new URL(`../src/${browser}/src/ui/sidepanel.js`, import.meta.url), 'utf8');
  const declaration = panel.slice(panel.indexOf('const SUBSCRIBE_ERROR_RE'), panel.indexOf('\n', panel.indexOf('const SUBSCRIBE_ERROR_RE')));
  const parser = panel.slice(panel.indexOf('function parseSubscribeError(content)'), panel.indexOf('function openSubscribeUrl'));
  const parse = vm.runInNewContext(`${declaration}\n${parser}\nparseSubscribeError`);
  const parsed = parse(error);
  assert.equal(parsed.action, 'payment');
  assert.equal(parsed.url, 'https://api.webbrain.one/portal?client_reference_id=test-browser');
  assert.equal(parse('Just talking about a payment method'), null);
  const element = () => ({
    children: [], dataset: {}, classList: { add() {} },
    replaceChildren(...children) { this.children = children; },
    appendChild(child) { this.children.push(child); },
    addEventListener() {}, closest() { return null; },
  });
  const cardSource = panel.slice(panel.indexOf('function renderSubscribeError('), panel.indexOf('function renderCostAllowanceError('));
  const renderCard = vm.runInNewContext(`${cardSource}\nrenderSubscribeError`, {
    parseSubscribeError: parse, document: { createElement: element }, t: key => en[key],
  });
  const card = element();
  assert.equal(renderCard(card, error, 'ask'), true);
  assert.equal(card.children[1].children[0].textContent, en['st.account.update_payment']);
  assert.equal(card.children[1].children[1].textContent, en['sp.subscribe.resume_payment']);
  assert.equal(card.children[1].children[1].dataset.resumeMode, 'ask');
}
console.log('billing-payment-notice ok (Chrome + Firefox)');
