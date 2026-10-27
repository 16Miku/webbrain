import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { cdpClient } from '../src/chrome/src/cdp/cdp-client.js';

// A coordinate click, type_text without a selector and press_keys reach the
// document under the point or holding focus. The permission gate charges that
// document's host, so the production CDP resolver must find an embedded
// cross-origin (process-isolated) frame the way Chrome delivers the input, and
// not be talked out of it by the top page. Only chrome.debugger is bridged to
// Playwright's CDP sessions; no website is contacted.
const TAB = 31;
const MERCHANT = 'https://merchant.invalid/checkout';
const WALLET = 'https://wallet.invalid/pay';
const SANDBOXED = 'https://wallet.invalid/sandboxed';
const OBJECT = 'https://wallet.invalid/object';
const top = `<!doctype html><style>
body{margin:0;height:1800px}iframe{position:absolute;left:20px;width:320px;border:3px solid;padding:0}
#topField{position:absolute;left:20px;top:50px;width:200px;height:30px}
</style><input id="topField" aria-label="Top field">
<iframe id="wallet" src="${WALLET}" style="top:100px;height:150px"></iframe>
<iframe id="same" srcdoc="<style>body{margin:0}</style><input id=inner style='margin:20px;width:200px;height:30px'>" style="top:300px;height:100px"></iframe>
<iframe id="sandboxed" sandbox="allow-scripts" src="${SANDBOXED}" style="top:450px;height:100px"></iframe>
<object id="object" type="text/html" data="${OBJECT}" style="position:absolute;left:400px;top:100px;width:320px;height:150px"></object>`;
const walletHtml = '<!doctype html><style>body{margin:0}</style><input id="card" aria-label="Card" style="margin:30px;width:200px;height:30px">';

test('Chrome: the input receiving frame is the embedded frame under the point or holding focus', { timeout: 60000 }, async t => {
  const saved = { chrome: globalThis.chrome, attach: cdpClient.attach };
  const browser = await chromium.launch({ headless: true, args: ['--site-per-process'] });
  const children = new Map(); // fake sessionId -> Playwright CDP session of an OOPIF
  const frameByTarget = new Map();
  let session;
  let attaches = 0;
  const send = async (target, method, params) => {
    if (!target.sessionId && method === 'Target.attachToTarget') {
      const frame = frameByTarget.get(params.targetId);
      if (!frame) throw new Error(`No target ${params.targetId}`);
      const sessionId = `child-${++attaches}`;
      children.set(sessionId, await frame.page().context().newCDPSession(frame));
      return { sessionId };
    }
    if (!target.sessionId && method === 'Target.detachFromTarget') {
      await children.get(params.sessionId)?.detach();
      children.delete(params.sessionId);
      return {};
    }
    return (target.sessionId ? children.get(target.sessionId) : session).send(method, params);
  };
  globalThis.chrome = {
    runtime: {},
    debugger: { sendCommand: (target, method, params, callback) => {
      send(target, method, params).then(callback, error => {
        chrome.runtime.lastError = { message: error.message }; callback(); delete chrome.runtime.lastError;
      });
    } },
  };
  cdpClient.attach = async () => cdpClient.sessions.set(TAB, {});
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url === MERCHANT) return route.fulfill({ contentType: 'text/html', body: top });
      if (url === WALLET || url === SANDBOXED || url === OBJECT) return route.fulfill({ contentType: 'text/html', body: walletHtml });
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(MERCHANT);
    session = await context.newCDPSession(page);
    // Playwright gives no content frame for an <object>; find it by address.
    const frameOf = async selector => (await (await page.locator(selector).elementHandle()).contentFrame())
      || page.frames().find(frame => frame.url() === OBJECT);
    for (const id of ['wallet', 'sandboxed', 'object']) {
      const frame = await frameOf(`#${id}`);
      await frame.waitForSelector('#card');
      const { result } = await session.send('Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(id)})` });
      const { node } = await session.send('DOM.describeNode', { objectId: result.objectId });
      frameByTarget.set(node.frameId, frame);
    }
    const wallet = await (await page.locator('#wallet').elementHandle()).contentFrame();
    const same = await (await page.locator('#same').elementHandle()).contentFrame();
    await same.waitForSelector('#inner');
    // Scroll the top page so viewport points differ from document points.
    await page.evaluate(() => scrollTo(0, 30));
    const centre = async (frameSelector, fieldSelector) => {
      const box = await page.locator(frameSelector).evaluate(node => {
        const rect = node.getBoundingClientRect(); return { left: rect.left + 3, top: rect.top + 3 };
      });
      const frame = await frameOf(frameSelector);
      const field = await frame.locator(fieldSelector).evaluate(node => {
        const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      return { x: box.left + field.x, y: box.top + field.y };
    };

    await t.test('a point on the top document stays with the top document', async () => {
      const point = await page.locator('#topField').evaluate(node => {
        const rect = node.getBoundingClientRect(); return { x: rect.left + 5, y: rect.top + 5 };
      });
      assert.deepEqual(await cdpClient.resolveInputFrame(TAB, point), { topDocument: true });
    });

    await t.test('a point over a process-isolated cross-origin frame resolves to that frame', async () => {
      const frame = await cdpClient.resolveInputFrame(TAB, await centre('#wallet', '#card'));
      assert.equal(frame.topDocument, false);
      assert.equal(new URL(frame.url).hostname, 'wallet.invalid');
      assert.equal(children.size, 0, 'temporary child sessions are detached');
    });

    await t.test('an <object> hosting another site is a frame like an <iframe>', async () => {
      const frame = await cdpClient.resolveInputFrame(TAB, await centre('#object', '#card'));
      assert.equal(frame.topDocument, false);
      assert.equal(new URL(frame.url).hostname, 'wallet.invalid');
    });

    await t.test('a srcdoc frame keeps the origin it inherits from the top site', async () => {
      const frame = await cdpClient.resolveInputFrame(TAB, await centre('#same', '#inner'));
      assert.equal(frame.topDocument, false);
      assert.equal(new URL(frame.url).hostname, 'merchant.invalid');
    });

    await t.test('a sandboxed frame has no web origin to charge, so the gate fails closed', async () => {
      const frame = await cdpClient.resolveInputFrame(TAB, await centre('#sandboxed', '#card'));
      assert.deepEqual(frame, { topDocument: false, url: '' });
    });

    await t.test('focus resolves to the document that holds it', async () => {
      await page.locator('#topField').focus();
      assert.deepEqual(await cdpClient.resolveInputFrame(TAB, { focused: true }), { topDocument: true });
      await wallet.locator('#card').focus();
      const frame = await cdpClient.resolveInputFrame(TAB, { focused: true });
      assert.equal(frame.topDocument, false);
      assert.equal(new URL(frame.url).hostname, 'wallet.invalid');
    });

    await t.test('the top page cannot redefine activeElement or the scroll offset to hide the frame', async () => {
      await wallet.locator('#card').focus();
      await page.evaluate(() => {
        Object.defineProperty(Document.prototype, 'activeElement', { configurable: true, get() { return document.body; } });
        Object.defineProperty(window, 'scrollY', { configurable: true, get() { return 400; } });
        Object.defineProperty(window, 'origin', { configurable: true, get() { return 'https://merchant.invalid'; } });
      });
      const focused = await cdpClient.resolveInputFrame(TAB, { focused: true });
      assert.equal(new URL(focused.url).hostname, 'wallet.invalid');
      const pointed = await cdpClient.resolveInputFrame(TAB, await centre('#wallet', '#card'));
      assert.equal(new URL(pointed.url).hostname, 'wallet.invalid');
    });
  } finally {
    for (const child of children.values()) await child.detach().catch(() => {});
    cdpClient.attach = saved.attach;
    cdpClient.sessions.delete(TAB);
    globalThis.chrome = saved.chrome;
    await browser.close();
  }
});

// Firefox's synthetic input cannot enter a cross-origin frame, but trusted
// companion input (WebDriver BiDi) can. The content script prepares that
// input, so it must not hand over a frame element as the target. Firefox's
// content scripts run in Chromium here, as in other content tests.
test('Firefox: trusted companion input is not prepared on an embedded frame', { timeout: 60000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--site-per-process'] });
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const html = `<!doctype html><style>body{margin:0}iframe{position:absolute;left:20px;top:100px;width:320px;height:150px;border:0}
#pay{position:absolute;left:20px;top:20px;width:120px;height:40px}</style>
<button id="pay" type="button">Pay</button><iframe id="wallet" src="${WALLET}"></iframe>`;
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url === MERCHANT) return route.fulfill({ contentType: 'text/html', body: html });
      if (url === WALLET) return route.fulfill({ contentType: 'text/html', body: walletHtml });
      return route.abort();
    });
    const tab = await context.newPage();
    await tab.goto(MERCHANT);
    await tab.evaluate(() => {
      window.fixtureHandlers = [];
      const runtime = { onMessage: { addListener(fn) { window.fixtureHandlers.push(fn); } }, getURL: p => p, sendMessage: async () => ({}) };
      window.chrome = { runtime }; window.browser = { runtime };
    });
    for (const file of ['file-upload-policy.js', 'rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'content.js']) {
      await tab.addScriptTag({ content: await readFile(new URL(`../src/firefox/src/content/${file}`, import.meta.url), 'utf8') });
    }
    const wallet = await (await tab.locator('#wallet').elementHandle()).contentFrame();
    await wallet.waitForSelector('#card');
    const call = (action, params) => tab.evaluate(message => new Promise(resolve => {
      for (const handler of window.fixtureHandlers) handler(message, {}, resolve);
    }), { target: 'content', action, params: { ...params, _bidiPrepare: randomUUID() } });
    const centre = selector => tab.locator(selector).evaluate(node => {
      const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });

    const overFrame = await call('click', await centre('#wallet'));
    assert.equal(overFrame.embeddedFrameTarget, true, JSON.stringify(overFrame));
    assert.equal(overFrame.noDispatch, true);
    assert.equal(overFrame.bidiPrepared, undefined);
    assert.equal(await tab.evaluate(() => document.querySelector('[data-webbrain-bidi]')), null, 'the frame was marked for trusted input');
    const onPage = await call('click', await centre('#pay'));
    assert.equal(onPage.bidiPrepared, true, JSON.stringify(onPage));

    await wallet.locator('#card').focus();
    const enter = await call('press_keys', { key: 'Enter' });
    assert.equal(enter.embeddedFrameTarget, true, JSON.stringify(enter));
    assert.equal(enter.bidiPrepared, undefined);
    // Tab and Escape stay ungated, as on Chrome.
    const escape = await call('press_keys', { key: 'Escape' });
    assert.equal(escape.bidiPrepared, true, JSON.stringify(escape));
  } finally {
    await browser.close();
  }
});
