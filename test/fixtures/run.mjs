#!/usr/bin/env node
// Fixtures runner for v4.0.1 overlay defenses.
//
// Loads fixture HTML in Chromium, plus targeted Firefox-engine regressions,
// injects the matching build's content.js with a stubbed extension runtime,
// and drives tools through the message handler. Asserts on response shape +
// which DOM element actually received the interaction.
//
// No LLM, no API keys, no real sites — just deterministic regression checks
// for _findTopmostModal scoping, the occlusion hit-test, and the rich
// ambiguity payload.
//
// Run: npm run test:fixtures

import { chromium, firefox as playwrightFirefox } from 'playwright';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../../src/chrome/src/agent/agent.js';
import { Agent as FirefoxAgent } from '../../src/firefox/src/agent/agent.js';
import { CDPClient, cdpClient } from '../../src/chrome/src/cdp/cdp-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const accessibilityTreeJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'accessibility-tree.js');
const firefoxAccessibilityTreeJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'accessibility-tree.js');
const contentJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'content.js');
const firefoxContentJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'content.js');
const redactionRegionsJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'redaction-regions.js');
const firefoxRedactionRegionsJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'redaction-regions.js');
const filePickerGuardPageJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'file-picker-guard-page.js');
const firefoxFilePickerGuardPageJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'file-picker-guard-page.js');
const selectionShortcutJsPath = path.join(root, 'src', 'chrome', 'src', 'content', 'selection-shortcut.js');
const firefoxSelectionShortcutJsPath = path.join(root, 'src', 'firefox', 'src', 'content', 'selection-shortcut.js');
const smdJsPath = path.join(root, 'src', 'chrome', 'src', 'agent', 'social-media-downloader.js');

function fixtureUrl(name) {
  return 'file://' + path.join(__dirname, name);
}

// Stub enough of `chrome.runtime` for content.js to register its handler
// without throwing. We capture the handler on window.__wb_handler.
const stubChrome = `
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.runtime.onMessage = {
    addListener: (fn) => { window.__wb_handler = fn; }
  };
`;

const stubFirefoxBrowser = `
  window.browser = window.browser || {};
  window.browser.runtime = window.browser.runtime || {};
  window.browser.runtime.getURL = (path) => path;
  window.browser.runtime.onMessage = {
    addListener: (fn) => { window.__wb_handler = fn; }
  };
`;

async function setup(page, fixture) {
  await page.addInitScript(stubChrome);
  await page.goto(fixtureUrl(fixture));
  const axSrc = await readFile(accessibilityTreeJsPath, 'utf-8');
  await page.addScriptTag({ content: axSrc });
  const src = await readFile(contentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  // Ensure handler is registered.
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupContentFixture(page, fixture, browserKind) {
  const firefox = browserKind === 'firefox';
  await page.addInitScript(firefox ? stubFirefoxBrowser : stubChrome);
  await page.goto(fixtureUrl(fixture));
  const axSrc = await readFile(firefox ? firefoxAccessibilityTreeJsPath : accessibilityTreeJsPath, 'utf-8');
  await page.addScriptTag({ content: axSrc });
  const contentSrc = await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8');
  await page.addScriptTag({ content: contentSrc });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupContentHtml(page, html, browserKind) {
  const firefox = browserKind === 'firefox';
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const pageGuardSrc = await readFile(
    firefox ? firefoxFilePickerGuardPageJsPath : filePickerGuardPageJsPath,
    'utf-8',
  );
  await page.addScriptTag({ content: pageGuardSrc });
  // Simulate manifest injection followed by extension-reload recovery.
  await page.addScriptTag({ content: pageGuardSrc });
  await page.addScriptTag({ content: firefox ? stubFirefoxBrowser : stubChrome });
  const src = await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupIsolatedContentHtml(page, html, browserKind) {
  const firefox = browserKind === 'firefox';
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const pageGuardSrc = await readFile(
    firefox ? firefoxFilePickerGuardPageJsPath : filePickerGuardPageJsPath,
    'utf-8',
  );
  await page.addScriptTag({ content: pageGuardSrc });
  // Simulate recovery reinjection while keeping the content world separate.
  await page.addScriptTag({ content: pageGuardSrc });

  const session = await page.context().newCDPSession(page);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  const frameTree = await session.send('Page.getFrameTree');
  const isolatedWorld = await session.send('Page.createIsolatedWorld', {
    frameId: frameTree.frameTree.frame.id,
    worldName: `webbrain-${browserKind}-fixture`,
  });
  const contextId = isolatedWorld.executionContextId;
  const contentSrc = await readFile(firefox ? firefoxContentJsPath : contentJsPath, 'utf-8');
  const injected = await session.send('Runtime.evaluate', {
    contextId,
    expression: `${firefox ? stubFirefoxBrowser : stubChrome}\n${contentSrc}`,
    awaitPromise: true,
  });
  if (injected.exceptionDetails) {
    throw new Error(`isolated content injection failed: ${injected.exceptionDetails.text}`);
  }

  const rawIsolatedCall = async (action, params) => {
    const message = JSON.stringify({ target: 'content', action, params });
    const evaluated = await session.send('Runtime.evaluate', {
      contextId,
      expression: `new Promise((resolve) => {
        const ret = window.__wb_handler(${message}, {}, (resp) => resolve(resp));
        if (ret !== true && ret !== undefined) resolve(ret);
      })`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluated.exceptionDetails) {
      throw new Error(`isolated content call failed: ${evaluated.exceptionDetails.text}`);
    }
    return evaluated.result.value;
  };

  return async (action, params) => {
    const response = await rawIsolatedCall(action, params);
    const guardId = response?._filePickerGuardId;
    if (!guardId) return response;

    const originalResponse = { ...response };
    delete originalResponse._filePickerGuardId;
    await page.waitForTimeout(525);
    let settled = await rawIsolatedCall('consume_file_picker_guard', { guardId });
    if (settled?.settled === false) {
      await page.waitForTimeout(50);
      settled = await rawIsolatedCall('consume_file_picker_guard', { guardId });
    }
    if (!settled?.filePickerBlocked) return originalResponse;

    const blockedResponse = { ...settled };
    delete blockedResponse.settled;
    return {
      ...blockedResponse,
      ...(originalResponse.rect ? { rect: originalResponse.rect } : {}),
      ...(originalResponse.ref_id ? { ref_id: originalResponse.ref_id } : {}),
    };
  };
}

async function setupFirefoxHtml(page, html) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: stubFirefoxBrowser });
  const src = await readFile(firefoxContentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupChromeHtml(page, html) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: stubChrome });
  const src = await readFile(contentJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__wb_handler === 'function');
}

async function setupAccessibilityTreeHtml(page, html, sourcePath) {
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const src = await readFile(sourcePath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__generateAccessibilityTree === 'function');
}

async function rawContentCall(page, action, params) {
  return page.evaluate(({ action, params }) => new Promise((resolve) => {
    const ret = window.__wb_handler(
      { target: 'content', action, params },
      {},
      (resp) => resolve(resp),
    );
    if (ret !== true && ret !== undefined) resolve(ret);
  }), { action, params });
}

async function call(page, action, params) {
  const response = await rawContentCall(page, action, params);
  const guardId = response?._filePickerGuardId;
  if (!guardId) return response;

  const originalResponse = { ...response };
  delete originalResponse._filePickerGuardId;
  await page.waitForTimeout(525);
  let settled = await rawContentCall(page, 'consume_file_picker_guard', { guardId });
  if (settled?.settled === false) {
    await page.waitForTimeout(50);
    settled = await rawContentCall(page, 'consume_file_picker_guard', { guardId });
  }
  if (!settled?.filePickerBlocked) return originalResponse;

  const blockedResponse = { ...settled };
  delete blockedResponse.settled;
  return {
    ...blockedResponse,
    ...(originalResponse.rect ? { rect: originalResponse.rect } : {}),
    ...(originalResponse.ref_id ? { ref_id: originalResponse.ref_id } : {}),
  };
}

async function readThroughCdpMirror(page, opts = {}) {
  const client = new CDPClient();
  client.evaluate = async (_tabId, expression) => ({
    result: { value: await page.evaluate(expression) },
  });
  return client.readPage(1, opts);
}

async function clickedSentinel(page) {
  return page.evaluate(() => window.__clicked);
}

async function setupSmd(page, url, html) {
  const u = new URL(url);
  await page.route(`${u.origin}/**`, route => {
    if (route.request().resourceType() === 'document') {
      return route.fulfill({ body: html, contentType: 'text/html' });
    }
    return route.fulfill({ body: '', contentType: 'text/plain' });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const src = await readFile(smdJsPath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.SocialMediaDownloader === 'object');
}

async function collectSmd(page, mode = 'auto') {
  return page.evaluate((m) => {
    const r = window.SocialMediaDownloader._collect(m);
    return { urls: r.urls, mode: r.mode, profile: r.profile.name };
  }, mode);
}

async function setupSelectionShortcut(page, sourcePath, { enabled = true, requiresManualOpen = false, locale = 'en' } = {}) {
  await page.setViewportSize({ width: 360, height: 280 });
  await page.setContent(`<!doctype html>
    <style>body{margin:0;font:18px/1.5 sans-serif} #copy{position:absolute;right:2px;bottom:2px;width:210px}</style>
    <p id="copy">Selected words near the viewport edge for WebBrain.</p>
    <div id="editor" contenteditable="true">Editable selection text.</div>`);
  await page.addScriptTag({ content: `
    window.__selectionMessages = [];
    window.__selectionStorage = { selectionShortcutEnabled: ${enabled ? 'true' : 'false'}, wbLocale: '${locale}' };
    window.__selectionRuntimeListeners = [];
    window.__selectionStorageListeners = [];
    window.chrome = {
      runtime: {
        sendMessage: async (message) => {
          window.__selectionMessages.push(message);
          return { ok: true, queued: true, requiresManualOpen: ${requiresManualOpen ? 'true' : 'false'} };
        },
        onMessage: { addListener: (listener) => window.__selectionRuntimeListeners.push(listener) }
      },
      storage: {
        local: {
          get: async (defaults) => ({ ...defaults, ...window.__selectionStorage }),
          set: async (update) => {
            const changes = {};
            for (const [key, value] of Object.entries(update)) {
              changes[key] = { oldValue: window.__selectionStorage[key], newValue: value };
              window.__selectionStorage[key] = value;
            }
            window.__selectionStorageListeners.forEach((listener) => listener(changes, 'local'));
          }
        },
        onChanged: { addListener: (listener) => window.__selectionStorageListeners.push(listener) }
      }
    };
    window.__setSelectionShortcutEnabled = async (value) => {
      await window.chrome.storage.local.set({ selectionShortcutEnabled: value });
    };
    window.__setSelectionShortcutLocale = async (value) => {
      await window.chrome.storage.local.set({ wbLocale: value });
    };
    window.__sendSelectionRuntimeMessage = (message) => {
      window.__selectionRuntimeListeners.forEach((listener) => listener(message, {}, () => {}));
    };
  ` });
  const src = await readFile(sourcePath, 'utf-8');
  await page.addScriptTag({ content: src });
  await page.waitForFunction(() => typeof window.__webbrainSelectionShortcut?.getState === 'function');
}

async function selectFixtureText(page, selector = '#copy') {
  await page.evaluate(async (targetSelector) => {
    const target = document.querySelector(targetSelector);
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, selector);
  await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().shortcutVisible);
  await page.waitForTimeout(20);
  return page.evaluate(() => window.__webbrainSelectionShortcut.getState());
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const firefoxTests = [];
function firefoxTest(name, fn) { firefoxTests.push({ name, fn }); }

test('exact iframe rect handshake distinguishes same-URL sibling frames', async (page) => {
  for (const [browserKind, sourcePath] of [
    ['chrome', redactionRegionsJsPath],
    ['firefox', firefoxRedactionRegionsJsPath],
  ]) {
    await page.setContent(`<!doctype html>
      <style>
        body { margin: 0; height: 1200px; }
        #first { position: absolute; top: 180px; left: 100px; width: 300px; height: 180px; border: 0; }
      </style>
      <iframe id="first" srcdoc="<input>"></iframe>
      <div id="shadow-host"></div>
      <script>
        (() => {
          const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
          root.innerHTML = '<iframe id="second" style="position:absolute;top:180px;left:600px;width:300px;height:180px;border:0" srcdoc="<input>"></iframe>';
        })();
      </script>`);
    await page.waitForFunction(() => {
      const first = document.getElementById('first');
      const second = document.getElementById('shadow-host')?.shadowRoot?.getElementById('second');
      return !!first?.contentWindow && !!second?.contentWindow;
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => window.scrollTo(0, 100));
    const runtimeStub = browserKind === 'firefox' ? `
      window.browser = window.browser || {};
      window.browser.runtime = {
        onMessage: { addListener: fn => { window.__redaction_handler = fn; } }
      };` : `
      window.chrome = window.chrome || {};
      window.chrome.runtime = {
        onMessage: { addListener: fn => { window.__redaction_handler = fn; } }
      };`;
    const source = await readFile(sourcePath, 'utf-8');
    for (const frame of page.frames()) {
      await frame.addScriptTag({ content: runtimeStub });
      await frame.addScriptTag({ content: source });
    }
    const childFrames = page.frames().filter(frame => frame !== page.mainFrame());
    if (childFrames.length !== 2) throw new Error(`${browserKind}: expected two child frames, got ${childFrames.length}`);
    const shadowChildFrame = (await Promise.all(childFrames.map(async frame => ({
      frame,
      id: await frame.evaluate(() => window.frameElement?.id || ''),
    })))).find(entry => entry.id === 'second')?.frame;
    if (!shadowChildFrame) throw new Error(`${browserKind}: shadow child frame was not reachable`);
    const token = `fixture-${browserKind}-${Date.now()}`;
    const parentWait = page.evaluate(probeToken => new Promise(resolve => {
      const keepAlive = window.__redaction_handler({
        target: 'redaction-content',
        action: 'wait_for_exact_child_frame_rect',
        params: { token: probeToken },
      }, {}, resolve);
      if (keepAlive !== true) resolve({ found: false, keepAlive });
    }), token);
    await new Promise(resolve => setTimeout(resolve, 10));
    const announced = await shadowChildFrame.evaluate(probeToken => new Promise(resolve => {
      window.__redaction_handler({
        target: 'redaction-content',
        action: 'announce_exact_child_frame',
        params: { token: probeToken },
      }, {}, resolve);
    }), token);
    const exact = await parentWait;
    if (
      announced?.announced !== true
      || exact?.found !== true
      || Math.round(exact.outerRect?.x) !== 600
      || Math.round(exact.outerRect?.y) !== 80
      || Math.round(exact.outerRect?.pageY) !== 180
    ) {
      throw new Error(`${browserKind}: expected exact shadow-frame geometry, got: ${JSON.stringify({ announced, exact })}`);
    }
  }
});

for (const [label, browserKind] of [['Chrome', 'chrome'], ['Firefox', 'firefox']]) {
  test(`${label}: type_text verifies after controlled field reconciliation`, async (page) => {
    await setupContentHtml(page, `<!doctype html>
      <input id="controlled" value="requested content already">
      <textarea id="accepted"></textarea>
      <script>
        const controlled = document.getElementById('controlled');
        controlled.addEventListener('input', () => {
          setTimeout(() => { controlled.value = 'requested content alreadY'; }, 0);
        });
      </script>`, browserKind);
    const rejected = await call(page, 'type', {
      selector: '#controlled',
      text: 'requested content',
      clear: false,
    });
    if (rejected?.success !== true || rejected?.verified !== false) {
      throw new Error(`controlled normalization without the requested insertion must not be verified: ${JSON.stringify(rejected)}`);
    }
    const accepted = await call(page, 'type', {
      selector: '#accepted',
      text: 'requested content',
      clear: true,
    });
    if (accepted?.success !== true || accepted?.verified !== true) {
      throw new Error(`persisted text must be verified: ${JSON.stringify(accepted)}`);
    }
  });
}

for (const [label, browserKind] of [['Chrome', 'chrome'], ['Firefox', 'firefox']]) {
  test(`${label}: blocking NYTimes registration dialog suppresses article DOM`, async (page) => {
    await setupContentFixture(page, 'nyt-registration-gate.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate?.blocking !== true || result.pageGate?.surface !== 'dialog' || result.pageGate?.type !== 'registration') {
      throw new Error(`registration pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    const serializedResult = JSON.stringify(result);
    if (result.textSource !== 'page-gate' || /SECRET_NYT_(?:ARTICLE|LINK|IMAGE|FORM|SHADOW)/.test(serializedResult)) {
      throw new Error(`blocked article data leaked: ${serializedResult}`);
    }
    if (result.links?.length || result.forms?.length || result.shadowDOM?.length || result.iframes?.length || result.media?.imageCount || result.media?.videoCount) {
      throw new Error(`blocking gate retained auxiliary page data: ${serializedResult}`);
    }
    if (JSON.stringify(result).indexOf('"pageGate"') > JSON.stringify(result).indexOf('"text"')) {
      throw new Error('pageGate must serialize before long article text for trace visibility');
    }
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 5 });
    if (tree.pageGate?.blocking !== true || !/Create a free account/i.test(tree.pageGate.label || '')) {
      throw new Error(`accessibility tree omitted structured pageGate: ${JSON.stringify(tree.pageGate)}`);
    }
    if (tree.textSource !== 'page-gate' || /SECRET_NYT_ARTICLE_BODY/.test(tree.pageContent || '')) {
      throw new Error(`accessibility tree leaked blocked article text: ${JSON.stringify(tree)}`);
    }
    const gateButtonRef = /button "Continue" \[(ref_\d+)\]/.exec(tree.pageContent || '')?.[1];
    const gateEmailRef = /textbox "Email" \[(ref_\d+)\]/.exec(tree.pageContent || '')?.[1];
    if (!gateButtonRef || !gateEmailRef) {
      throw new Error(`accessibility tree omitted visible gate controls: ${JSON.stringify(tree)}`);
    }
    const clickResult = await call(page, 'click_ax', { ref_id: gateButtonRef });
    const gateControlClicked = await page.evaluate(() => window.__gateControlClicked === true);
    if (clickResult?.success !== true || !gateControlClicked) {
      throw new Error(`gate control ref was not actionable: ${JSON.stringify(clickResult)}`);
    }
    const basicResult = await call(page, 'get_page_info', {});
    if (/SECRET_NYT_(?:ARTICLE|LINK|IMAGE|FORM|SHADOW)/.test(JSON.stringify(basicResult))) {
      throw new Error(`basic page info leaked blocked article data: ${JSON.stringify(basicResult)}`);
    }
  });

  test(`${label}: The Athletic covering subscription overlay suppresses server-rendered body`, async (page) => {
    await setupContentFixture(page, 'athletic-subscription-overlay.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate?.type !== 'subscription' || result.pageGate?.surface !== 'dialog') {
      throw new Error(`Athletic pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    if (/SECRET_ATHLETIC_(?:ARTICLE|LINK|FORM)/.test(JSON.stringify(result)) || result.textSource !== 'page-gate') {
      throw new Error(`Athletic article data leaked: ${JSON.stringify(result)}`);
    }
  });

  test(`${label}: inline article gate returns only the visible preview`, async (page) => {
    await setupContentFixture(page, 'inline-article-paywall.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate?.blocking !== true || result.pageGate?.surface !== 'inline') {
      throw new Error(`inline pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
    }
    if (!/VISIBLE_PREVIEW_PARAGRAPH/.test(result.text || '') || /SECRET_POST_GATE_PARAGRAPH/.test(result.text || '')) {
      throw new Error(`inline preview boundary mismatch: ${JSON.stringify(result.text)}`);
    }
    if (!/\(pre-gate\)$/.test(result.textSource || '')) {
      throw new Error(`inline textSource missing pre-gate marker: ${result.textSource}`);
    }
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 5 });
    if (!/VISIBLE_PREVIEW_PARAGRAPH/.test(tree.pageContent || '') || /SECRET_POST_GATE_PARAGRAPH/.test(tree.pageContent || '')) {
      throw new Error(`inline accessibility boundary mismatch: ${JSON.stringify(tree)}`);
    }
  });

  test(`${label}: readable article ignores header controls, inline upsells, and hidden gate markup`, async (page) => {
    await setupContentFixture(page, 'readable-article-no-gate.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate) throw new Error(`false-positive pageGate: ${JSON.stringify(result.pageGate)}`);
    if (!/READABLE_ARTICLE_BODY/.test(result.text || '') || !/READABLE_ARTICLE_AFTER_UPSELL/.test(result.text || '') || result.textSource === 'page-gate') {
      throw new Error(`readable article body missing: ${JSON.stringify({ textSource: result.textSource, text: result.text })}`);
    }
  });

  test(`${label}: non-article signup dialog preserves form controls`, async (page) => {
    await setupContentFixture(page, 'non-article-signup-dialog.html', browserKind);
    const result = await call(page, 'get_page_info_cdp', {});
    if (result.pageGate) throw new Error(`non-article dialog became a page gate: ${JSON.stringify(result.pageGate)}`);
    if (result.forms?.length !== 1 || result.forms[0]?.inputs?.[0]?.name !== 'email') {
      throw new Error(`signup form was stripped from page info: ${JSON.stringify(result.forms)}`);
    }
    const basicResult = await call(page, 'get_page_info', {});
    if (basicResult.pageGate || basicResult.forms?.length !== 1) {
      throw new Error(`basic page info stripped the signup form: ${JSON.stringify(basicResult)}`);
    }
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 6 });
    if (tree.pageGate || !/Work email/.test(tree.pageContent || '')) {
      throw new Error(`signup accessibility tree was stripped: ${JSON.stringify(tree)}`);
    }
  });
}

test('Chrome CDP mirror suppresses a blocking Athletic article body', async (page) => {
  await page.goto(fixtureUrl('athletic-subscription-overlay.html'));
  const result = await readThroughCdpMirror(page);
  if (result.pageGate?.type !== 'subscription' || result.pageGate?.surface !== 'dialog') {
    throw new Error(`CDP pageGate mismatch: ${JSON.stringify(result.pageGate)}`);
  }
  if (result.textSource !== 'page-gate' || /SECRET_ATHLETIC_(?:ARTICLE|LINK|FORM)/.test(JSON.stringify(result))) {
    throw new Error(`CDP mirror leaked blocked article data: ${JSON.stringify(result)}`);
  }
  if (result.links?.length || result.forms?.length || result.shadowHosts?.length || result.iframes?.length) {
    throw new Error(`CDP blocking gate retained auxiliary page data: ${JSON.stringify(result)}`);
  }
});

test('Chrome CDP mirror preserves a readable article across an inline upsell', async (page) => {
  await page.goto(fixtureUrl('readable-article-no-gate.html'));
  const result = await readThroughCdpMirror(page);
  if (result.pageGate || !/READABLE_ARTICLE_BODY/.test(result.text || '') || !/READABLE_ARTICLE_AFTER_UPSELL/.test(result.text || '')) {
    throw new Error(`CDP readable article mismatch: ${JSON.stringify({ pageGate: result.pageGate, text: result.text })}`);
  }
});

test('Chrome CDP mirror preserves a non-article signup dialog', async (page) => {
  await page.goto(fixtureUrl('non-article-signup-dialog.html'));
  const result = await readThroughCdpMirror(page);
  if (result.pageGate || result.forms?.length !== 1 || result.forms[0]?.inputs?.[0]?.name !== 'email') {
    throw new Error(`CDP non-article signup mismatch: ${JSON.stringify(result)}`);
  }
});

for (const [label, sourcePath, manualOpen] of [
  ['Chrome', selectionShortcutJsPath, false],
  ['Firefox', firefoxSelectionShortcutJsPath, true],
]) {
  test(`${label}: selection shortcut clamps to the viewport and supports keyboard dismissal`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const state = await selectFixtureText(page);
    const rect = state.shortcutRect;
    if (!rect || rect.left < 8 || rect.top < 8 || rect.right > 352 || rect.bottom > 272) {
      throw new Error(`shortcut was not clamped to the viewport: ${JSON.stringify(rect)}`);
    }
    await page.mouse.click(rect.left + rect.width / 2, rect.top + rect.height / 2);
    let popupState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!popupState.popupVisible) throw new Error('popup did not open for the selected text');
    await page.keyboard.press('Escape');
    popupState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (popupState.popupVisible || !popupState.shortcutVisible) {
      throw new Error(`Escape should close the popup and retain the shortcut: ${JSON.stringify(popupState)}`);
    }
  });

  test(`${label}: selection dialog contains page shortcuts and keeps the selected text highlighted`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await page.evaluate(() => {
      window.__selectionPageKeys = [];
      window.addEventListener('keydown', (event) => window.__selectionPageKeys.push(`window-capture:${event.key}`), true);
      document.addEventListener('keydown', (event) => window.__selectionPageKeys.push(`document-capture:${event.key}`), true);
      document.addEventListener('keydown', (event) => window.__selectionPageKeys.push(`down:${event.key}`));
      document.addEventListener('keypress', (event) => window.__selectionPageKeys.push(`press:${event.key}`));
      document.addEventListener('keyup', (event) => window.__selectionPageKeys.push(`up:${event.key}`));
    });
    const selectedState = await selectFixtureText(page);
    await page.mouse.click(
      selectedState.shortcutRect.left + selectedState.shortcutRect.width / 2,
      selectedState.shortcutRect.top + selectedState.shortcutRect.height / 2,
    );
    const openState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!openState.questionRect || openState.highlightRectCount < 1) {
      throw new Error(`popup should preserve a visual marker for the selected text: ${JSON.stringify(openState)}`);
    }
    await page.mouse.click(
      openState.questionRect.left + openState.questionRect.width / 2,
      openState.questionRect.top + openState.questionRect.height / 2,
    );
    await page.keyboard.type('j');
    const typedState = await page.evaluate(() => ({
      surface: window.__webbrainSelectionShortcut.getState(),
      pageKeys: window.__selectionPageKeys,
    }));
    if (typedState.surface.questionValue !== 'j' || typedState.surface.highlightRectCount < 1) {
      throw new Error(`typing should keep the custom question and sticky highlight: ${JSON.stringify(typedState)}`);
    }
    if (typedState.pageKeys.length) {
      throw new Error(`dialog keystrokes leaked to the page: ${JSON.stringify(typedState.pageKeys)}`);
    }
    await page.keyboard.press('Escape');
    const closedState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (closedState.popupVisible || closedState.highlightRectCount !== 0) {
      throw new Error(`closing the popup should remove the sticky highlight: ${JSON.stringify(closedState)}`);
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().popupVisible);
    const reopenedState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    await page.mouse.click(
      reopenedState.questionRect.left + reopenedState.questionRect.width / 2,
      reopenedState.questionRect.top + reopenedState.questionRect.height / 2,
    );
    await page.keyboard.type('What is the point?');
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const submittedState = await page.evaluate(() => ({
      message: window.__selectionMessages[0],
      surface: window.__webbrainSelectionShortcut.getState(),
      pageKeys: window.__selectionPageKeys,
    }));
    if (submittedState.message.action !== 'custom' || submittedState.message.question !== 'What is the point?') {
      throw new Error(`capture-phase containment broke keyboard submission: ${JSON.stringify(submittedState)}`);
    }
    if (submittedState.surface.popupVisible || submittedState.surface.highlightRectCount !== 0) {
      throw new Error(`keyboard submission should dismiss the surface and highlight: ${JSON.stringify(submittedState)}`);
    }
    if (submittedState.pageKeys.length) {
      throw new Error(`capture-phase dialog keystrokes leaked to the page: ${JSON.stringify(submittedState.pageKeys)}`);
    }
  });

  test(`${label}: selection highlight stays bounded for long documents`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const rawRectCount = await page.evaluate(() => {
      const article = document.createElement('article');
      article.id = 'long-selection';
      for (let index = 0; index < 600; index += 1) {
        const line = document.createElement('div');
        line.textContent = `Selected article line ${index + 1}`;
        article.appendChild(line);
      }
      document.body.appendChild(article);
      const range = document.createRange();
      range.selectNodeContents(article);
      return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).length;
    });
    if (rawRectCount <= 200) throw new Error(`fixture should create more than 200 selection rectangles, got ${rawRectCount}`);

    const selectedState = await selectFixtureText(page, '#long-selection');
    await page.mouse.click(
      selectedState.shortcutRect.left + selectedState.shortcutRect.width / 2,
      selectedState.shortcutRect.top + selectedState.shortcutRect.height / 2,
    );
    const openState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (openState.highlightRectCount < 1 || openState.highlightRectCount > 200) {
      throw new Error(`long selections should render 1-200 highlight rectangles: ${JSON.stringify(openState)}`);
    }
    if (openState.highlightRectCount >= rawRectCount) {
      throw new Error(`offscreen selection rectangles should not all render: ${JSON.stringify({ rawRectCount, openState })}`);
    }
  });

  test(`${label}: selection shortcut submits once and dismisses before delivery`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    const selectedState = await selectFixtureText(page, '#editor');
    const shortcutRect = selectedState.shortcutRect;
    await page.mouse.click(shortcutRect.left + shortcutRect.width / 2, shortcutRect.top + shortcutRect.height / 2);
    const openState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    const summarizeRect = openState.summarizeRect;
    if (!summarizeRect) throw new Error('Summarize action was not visible after opening the popup');
    await page.mouse.click(summarizeRect.left + summarizeRect.width / 2, summarizeRect.top + summarizeRect.height / 2);
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('summarize'));
    const result = await page.evaluate(() => ({
      messages: window.__selectionMessages,
      state: window.__webbrainSelectionShortcut.getState(),
    }));
    if (result.messages.length !== 1) throw new Error(`expected exactly one submission, got ${result.messages.length}`);
    if (result.messages[0].action !== 'summarize' || !/Editable selection text/.test(result.messages[0].selectionText)) {
      throw new Error(`unexpected selection request: ${JSON.stringify(result.messages[0])}`);
    }
    if (result.state.shortcutVisible || result.state.popupVisible) {
      throw new Error(`surface should dismiss before delivery: ${JSON.stringify(result.state)}`);
    }

    await selectFixtureText(page);
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitCustom('   '));
    let messages = await page.evaluate(() => window.__selectionMessages.length);
    if (messages !== 1) throw new Error('blank custom questions should not submit');
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitCustom('What is the point?'));
    messages = await page.evaluate(() => window.__selectionMessages);
    if (messages.length !== 2 || messages[1].action !== 'custom' || messages[1].question !== 'What is the point?') {
      throw new Error(`custom question was not submitted correctly: ${JSON.stringify(messages)}`);
    }

    await page.evaluate(() => window.__setSelectionShortcutLocale('tr'));
    const translationSelection = await selectFixtureText(page);
    const translationShortcutRect = translationSelection.shortcutRect;
    await page.mouse.click(
      translationShortcutRect.left + translationShortcutRect.width / 2,
      translationShortcutRect.top + translationShortcutRect.height / 2,
    );
    const translateState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    const translateRect = translateState.translateRect;
    if (!translateRect) throw new Error('Translate action was not visible in the popup');
    await page.mouse.click(translateRect.left + translateRect.width / 2, translateRect.top + translateRect.height / 2);
    await page.waitForFunction(() => window.__selectionMessages.length === 3);
    const translated = await page.evaluate(() => ({
      message: window.__selectionMessages[2],
      state: window.__webbrainSelectionShortcut.getState(),
    }));
    if (translated.message.action !== 'translate' || translated.message.language !== 'tr') {
      throw new Error(`translation request was not submitted correctly: ${JSON.stringify(translated.message)}`);
    }
    if (translated.state.popupVisible || translated.state.shortcutVisible) {
      throw new Error(`Translate should submit directly and dismiss the surface: ${JSON.stringify(translated.state)}`);
    }

    await page.evaluate(() => window.__setSelectionShortcutLocale('fr'));
    const updatedLocaleSelection = await selectFixtureText(page);
    const updatedLocaleShortcutRect = updatedLocaleSelection.shortcutRect;
    await page.mouse.click(
      updatedLocaleShortcutRect.left + updatedLocaleShortcutRect.width / 2,
      updatedLocaleShortcutRect.top + updatedLocaleShortcutRect.height / 2,
    );
    const updatedLocaleState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    await page.mouse.click(
      updatedLocaleState.translateRect.left + updatedLocaleState.translateRect.width / 2,
      updatedLocaleState.translateRect.top + updatedLocaleState.translateRect.height / 2,
    );
    await page.waitForFunction(() => window.__selectionMessages.length === 4);
    const updatedLocaleMessage = await page.evaluate(() => window.__selectionMessages[3]);
    if (updatedLocaleMessage.action !== 'translate' || updatedLocaleMessage.language !== 'fr') {
      throw new Error(`Translate did not follow the updated plugin locale: ${JSON.stringify(updatedLocaleMessage)}`);
    }
  });

  test(`${label}: selection shortcut persists hiding and suppresses screenshot-time UI`, async (page) => {
    await setupSelectionShortcut(page, sourcePath, { requiresManualOpen: manualOpen });
    await selectFixtureText(page);
    if (manualOpen) {
      await page.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('summarize'));
      const toastState = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
      if (!toastState.toastVisible) throw new Error(`manual-open guidance toast was not visible: ${JSON.stringify(toastState)}`);
    }
    await page.evaluate(() => window.__sendSelectionRuntimeMessage({ type: 'WB_HIDE_FOR_TOOL_USE' }));
    let state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (!state.suppressed || state.shortcutVisible || state.toastVisible) {
      throw new Error(`tool-use hide should suppress the complete surface: ${JSON.stringify(state)}`);
    }
    await page.evaluate(() => window.__sendSelectionRuntimeMessage({ type: 'WB_SHOW_AFTER_TOOL_USE' }));
    await selectFixtureText(page);
    await page.evaluate(() => window.__webbrainSelectionShortcut.hideShortcut());
    let stored = await page.evaluate(() => window.__selectionStorage.selectionShortcutEnabled);
    if (stored !== false) throw new Error('Hide selection shortcut did not persist false');

    await page.evaluate(() => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.waitForTimeout(20);
    state = await page.evaluate(() => window.__webbrainSelectionShortcut.getState());
    if (state.shortcutVisible) throw new Error('disabled shortcut reappeared after selection');

    await page.evaluate(() => window.__setSelectionShortcutEnabled(true));
    state = await selectFixtureText(page);
    stored = await page.evaluate(() => window.__selectionStorage.selectionShortcutEnabled);
    if (stored !== true || !state.shortcutVisible) throw new Error('settings re-enable did not restore future shortcut detection');
  });
}

const gmailComposeRecipientFixture = `<!doctype html>
  <style>
    body { margin: 0; font: 16px sans-serif; }
    [role="dialog"] { width: 620px; min-height: 360px; padding: 16px; }
    .recipient { width: 500px; height: 40px; }
    .field { display: block; width: 500px; height: 32px; margin-top: 8px; }
    .body { width: 500px; height: 160px; margin-top: 8px; }
    .hidden-to { position: absolute; width: 0; height: 0; opacity: 0; }
    .hidden-wrapper { display: none; }
  </style>
  <div role="dialog" aria-label="Compose: New Message">
    <div role="region" aria-label="New Message">
      <input class="hidden-to" role="combobox" aria-label="To recipients">
      <div class="recipient" tabindex="1">
        <span>Alex Russell (gmail.com)</span>
        <span style="display:none">Hidden stale recipient</span>
        <span style="opacity:0">Opacity hidden override</span>
        <span style="position:absolute;left:-10000px;width:200px">Offscreen hidden override</span>
        <span aria-hidden="true">ARIA hidden override</span>
      </div>
      <input class="field" aria-label="Subject" placeholder="Subject">
      <div class="body" role="textbox" contenteditable="true" aria-label="Message Body"></div>
      <div class="composite" tabindex="0"><span>Composite controls</span><button>Remove</button></div>
      <div class="hidden-wrapper" tabindex="0"><span>Hidden wrapper text</span></div>
      <div class="empty" tabindex="0"><span></span></div>
      <div class="overlong" tabindex="0"><span>${'x'.repeat(101)}</span></div>
    </div>
  </div>`;

let chromeGmailComposeTree = '';

function normalizeTreeRefs(content) {
  const refs = new Map();
  return String(content || '').replace(/ref_\d+/g, ref => {
    if (!refs.has(ref)) refs.set(ref, `ref_${refs.size + 1}`);
    return refs.get(ref);
  });
}

function assertGmailComposeRecipientTree(tree, label) {
  const content = String(tree?.pageContent || '');
  if (!/generic "Alex Russell \(gmail\.com\)" \[ref_\d+\]/.test(content)) {
    throw new Error(`${label}: selected recipient label missing from visible tree: ${content}`);
  }
  if (!/textbox "Subject" \[ref_\d+\]/.test(content)) {
    throw new Error(`${label}: Subject missing from visible tree: ${content}`);
  }
  if (!/textbox "Message Body" \[ref_\d+\]/.test(content)) {
    throw new Error(`${label}: Message Body missing from visible tree: ${content}`);
  }
  for (const forbidden of ['To recipients', 'Hidden stale recipient', 'Opacity hidden override', 'Offscreen hidden override', 'ARIA hidden override', 'Hidden wrapper text', 'generic "Composite controls', 'x'.repeat(101)]) {
    if (content.includes(forbidden)) throw new Error(`${label}: tree promoted forbidden generic text: ${forbidden}`);
  }
  return normalizeTreeRefs(content);
}

test('accessibility tree (Chrome): existing Gmail compose exposes the selected recipient chip', async (page) => {
  await setupAccessibilityTreeHtml(page, gmailComposeRecipientFixture, accessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('visible', 10, null, null, 1));
  chromeGmailComposeTree = assertGmailComposeRecipientTree(tree, 'chrome');
});

test('accessibility tree (Firefox): existing Gmail compose exposes the selected recipient chip with parity', async (page) => {
  await setupAccessibilityTreeHtml(page, gmailComposeRecipientFixture, firefoxAccessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('visible', 10, null, null, 1));
  const firefoxTree = assertGmailComposeRecipientTree(tree, 'firefox');
  if (firefoxTree !== chromeGmailComposeTree) throw new Error('Chrome/Firefox Gmail compose trees differ');
});

const richEditorVariantsFixture = `<!doctype html>
  <style>
    body { margin: 0; font: 16px sans-serif; }
    .editor { display: block; width: 520px; min-height: 72px; margin: 12px; border: 1px solid #888; }
  </style>
  <div class="editor" contenteditable="" aria-label="Email body">Draft body text</div>
  <div class="editor" contenteditable="plaintext-only" aria-label="Plain message">Plain draft text</div>
  <div class="editor" contenteditable="false" aria-label="Read-only copy">Do not edit</div>`;

let chromeRichEditorTree = '';

function assertRichEditorVariants(tree, label) {
  const content = String(tree?.pageContent || '');
  if (!/textbox "Email body" \[ref_\d+\] value="Draft body text"/.test(content)) {
    throw new Error(`${label}: contenteditable="" editor missing as a valued textbox: ${content}`);
  }
  if (!/textbox "Plain message" \[ref_\d+\] value="Plain draft text"/.test(content)) {
    throw new Error(`${label}: plaintext-only editor missing as a valued textbox: ${content}`);
  }
  if (/Read-only copy|Do not edit/.test(content)) {
    throw new Error(`${label}: contenteditable=false leaked into the interactive tree: ${content}`);
  }
  const textboxes = content.match(/^\s*textbox\b/gm) || [];
  if (textboxes.length !== 2) throw new Error(`${label}: expected exactly two editable roots, got ${textboxes.length}: ${content}`);
  return normalizeTreeRefs(content);
}

test('accessibility tree (Chrome): contenteditable variants are actionable valued textboxes', async (page) => {
  await setupAccessibilityTreeHtml(page, richEditorVariantsFixture, accessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('interactive', 10, null, null, 1));
  chromeRichEditorTree = assertRichEditorVariants(tree, 'chrome');
});

test('accessibility tree (Firefox): contenteditable variants keep Chrome parity', async (page) => {
  await setupAccessibilityTreeHtml(page, richEditorVariantsFixture, firefoxAccessibilityTreeJsPath);
  const tree = await page.evaluate(() => window.__generateAccessibilityTree('interactive', 10, null, null, 1));
  const firefoxTree = assertRichEditorVariants(tree, 'firefox');
  if (firefoxTree !== chromeRichEditorTree) throw new Error('Chrome/Firefox rich editor trees differ');
});

// ─── modal-scoping ────────────────────────────────────────────────────────
test('modal scoping: click({text:"Create"}) resolves to dialog Create', async (page) => {
  await setup(page, 'modal-scoping.html');
  const resp = await call(page, 'click', { text: 'Create' });
  if (!resp?.success) throw new Error(`expected success, got: ${JSON.stringify(resp)}`);
  const clicked = await clickedSentinel(page);
  if (clicked !== 'dlg-create') {
    throw new Error(`expected dlg-create, actually clicked: ${clicked}`);
  }
});

test('modal scoping: click({text:"Publish"}) returns no-match (scoped out)', async (page) => {
  await setup(page, 'modal-scoping.html');
  const resp = await call(page, 'click', { text: 'Publish release' });
  if (resp?.success) throw new Error(`expected failure, got success`);
  if (resp?.dispatched !== false) throw new Error(`no-match must report dispatched:false, got: ${JSON.stringify(resp)}`);
  if (!/scoped to the open modal/i.test(resp?.error || '')) {
    throw new Error(`expected modal-scope note in error, got: ${resp?.error}`);
  }
});

async function assertModalAutoSelectTargetsResolvedSelect(page, browserKind) {
  const label = browserKind === 'chrome' ? 'Chrome' : 'Firefox';
  const setupHtml = browserKind === 'chrome' ? setupChromeHtml : setupFirefoxHtml;
  await setupHtml(page, `<!doctype html>
    <style>
      select { width: 180px; height: 40px; }
      #dialog { position: fixed; left: 40px; top: 100px; padding: 20px; background: white; }
    </style>
    <select id="background-select">
      <option value="monthly">Monthly</option>
      <option value="yearly">Yearly</option>
    </select>
    <div id="dialog" role="dialog" aria-modal="true">
      <select id="dialog-select">
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </select>
    </div>`);

  const response = await call(page, 'click', { text: 'Yearly' });
  if (!response?.success || response?.method !== 'auto-select') {
    throw new Error(`${label}: expected modal select auto-selection, got: ${JSON.stringify(response)}`);
  }
  const values = await page.evaluate(() => ({
    background: document.getElementById('background-select').value,
    dialog: document.getElementById('dialog-select').value,
  }));
  if (values.background !== 'monthly' || values.dialog !== 'yearly') {
    throw new Error(`${label}: auto-select mutated the wrong dropdown: ${JSON.stringify(values)}`);
  }
}

test('Chrome: modal auto-select changes the resolved select, not a background select', async (page) => {
  await assertModalAutoSelectTargetsResolvedSelect(page, 'chrome');
});

test('Firefox: modal auto-select changes the resolved select, not a background select', async (page) => {
  await assertModalAutoSelectTargetsResolvedSelect(page, 'firefox');
});

async function assertAmbiguousNativeSelectOptionsAreRejected(page, browserKind) {
  const label = browserKind === 'chrome' ? 'Chrome' : 'Firefox';
  const setupHtml = browserKind === 'chrome' ? setupChromeHtml : setupFirefoxHtml;
  await setupHtml(page, `<!doctype html>
    <style>select, button { width: 180px; height: 40px; display: block; margin: 8px; }</style>
    <button id="contact" onclick="window.__contactClicked = true">Contact us</button>
    <label>Billing country
      <select id="billing">
        <option value="CA">Canada</option>
        <option value="US">United States</option>
      </select>
    </label>
    <label>Shipping country
      <select id="shipping">
        <option value="CA">Canada</option>
        <option value="US">United States</option>
      </select>
    </label>`);

  const response = await call(page, 'click', { text: 'US' });
  const state = await page.evaluate(() => ({
    billing: document.getElementById('billing').value,
    shipping: document.getElementById('shipping').value,
    contactClicked: window.__contactClicked === true,
  }));
  if (
    response?.success !== false
    || response?.dispatched !== false
    || response?.failureScope !== 'ambiguous-select-option:us'
    || !/Ambiguous select option match/.test(response?.error || '')
  ) {
    throw new Error(`${label}: expected explicit select-option ambiguity, got: ${JSON.stringify(response)}`);
  }
  if (state.billing !== 'CA' || state.shipping !== 'CA' || state.contactClicked) {
    throw new Error(`${label}: ambiguous select rescue mutated page state: ${JSON.stringify(state)}`);
  }
}

test('Chrome: ambiguous native select options do not mutate the first dropdown', async (page) => {
  await assertAmbiguousNativeSelectOptionsAreRejected(page, 'chrome');
});

test('Firefox: ambiguous native select options do not mutate the first dropdown', async (page) => {
  await assertAmbiguousNativeSelectOptionsAreRejected(page, 'firefox');
});

test('Chrome Agent: modal auto-select ignores background/hidden clickables and keeps the exact target', async (page) => {
  await page.setContent(`<!doctype html>
    <style>
      select { width: 180px; height: 40px; }
      #dialog { position: fixed; left: 40px; top: 100px; padding: 20px; background: white; }
    </style>
    <button id="background-yearly" onclick="window.__backgroundYearlyClicked = true">Yearly</button>
    <select id="background-select">
      <option value="monthly">Monthly</option>
      <option value="yearly">Yearly</option>
    </select>
    <div id="dialog" role="dialog" aria-modal="true">
      <button style="display: none">Yearly</button>
      <select id="dialog-select">
        <option value="monthly">Monthly</option>
        <option value="yearly">Yearly</option>
      </select>
    </div>
    <script>
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && document.activeElement?.id === 'dialog-select') {
          document.activeElement.blur();
        }
      }, true);
    </script>`);

  const session = await page.context().newCDPSession(page);
  const client = {
    async evaluate(_tabId, expression) {
      return { result: { value: await page.evaluate(expression) } };
    },
    async sendCommand(_tabId, method, params) {
      // Headless Chromium does not apply the native <select> default action
      // for this raw CDP key sequence consistently. Model that one browser
      // action on whichever exact control the production code focused; the
      // Escape event itself still goes through CDP and triggers the blur above.
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown' && /^(ArrowDown|ArrowUp)$/.test(params.key || '')) {
        await page.evaluate((key) => {
          const target = document.activeElement;
          if (!(target instanceof HTMLSelectElement)) return;
          const delta = key === 'ArrowDown' ? 1 : -1;
          target.selectedIndex = Math.max(0, Math.min(target.options.length - 1, target.selectedIndex + delta));
        }, params.key);
        return {};
      }
      return session.send(method, params);
    },
  };
  const agent = new Agent({});
  const result = await agent._autoSelectOption(42, client, 'Yearly');
  const values = await page.evaluate(() => ({
    background: document.getElementById('background-select').value,
    dialog: document.getElementById('dialog-select').value,
    backgroundButtonClicked: window.__backgroundYearlyClicked === true,
    leakedTargetSlots: Object.keys(globalThis).filter((key) => key.startsWith('__webbrainAutoSelectTarget_')),
  }));

  if (!result?.success || result.method !== 'auto-select-keyboard') {
    throw new Error(`expected exact-target auto-selection, got: ${JSON.stringify(result)}`);
  }
  if (values.background !== 'monthly' || values.dialog !== 'yearly' || values.backgroundButtonClicked) {
    throw new Error(`auto-select changed the wrong dropdown after refocus: ${JSON.stringify(values)}`);
  }
  if (values.leakedTargetSlots.length) {
    throw new Error(`auto-select target reference was not cleaned up: ${JSON.stringify(values.leakedTargetSlots)}`);
  }
});

// ─── occlusion ────────────────────────────────────────────────────────────
test('occlusion: click({text:"Submit"}) refuses when covered', async (page) => {
  await setup(page, 'occlusion.html');
  const resp = await call(page, 'click', { text: 'Submit' });
  if (resp?.success) throw new Error(`expected failure, got success`);
  if (resp?.dispatched !== false) throw new Error(`occluded preflight must report dispatched:false, got: ${JSON.stringify(resp)}`);
  if (!resp?.occluded) throw new Error(`expected occluded:true, got: ${JSON.stringify(resp)}`);
  if (!resp?.occludedBy) throw new Error(`expected occludedBy payload`);
  const clicked = await clickedSentinel(page);
  if (clicked !== null) throw new Error(`target should not have been clicked, got: ${clicked}`);
});

test('occlusion: click({x,y}) force-clicks (skips occlusion check)', async (page) => {
  await setup(page, 'occlusion.html');
  // Force via coords — the check is supposed to skip for x,y, so click
  // hits whatever elementFromPoint returns (the cover). Target stays unclicked.
  const resp = await call(page, 'click', { x: 180, y: 120 });
  if (!resp?.success) throw new Error(`expected success for coord click, got: ${JSON.stringify(resp)}`);
  // Either the cover or the button — we just verify no occlusion error thrown.
  if (resp?.occluded) throw new Error(`coord click should bypass occlusion check`);
});

// ─── ambiguity candidates ─────────────────────────────────────────────────
test('ambiguity: two Cancels return rich candidates with ancestor', async (page) => {
  await setup(page, 'ambiguity-candidates.html');
  const resp = await call(page, 'click', { text: 'Cancel' });
  if (resp?.success) throw new Error(`expected ambiguity, got success`);
  if (resp?.dispatched !== false) throw new Error(`ambiguity must report dispatched:false, got: ${JSON.stringify(resp)}`);
  if (!Array.isArray(resp?.candidates)) throw new Error(`expected candidates array`);
  if (resp.candidates.length < 2) throw new Error(`expected ≥2 candidates, got ${resp.candidates.length}`);
  const ancestors = resp.candidates.map(c => c.ancestor || '');
  const hasForm = ancestors.some(a => /form/i.test(a) && /payment/i.test(a));
  const hasSection = ancestors.some(a => /section/i.test(a) && /shipping/i.test(a));
  if (!hasForm || !hasSection) {
    throw new Error(`expected form:Payment + section:Shipping ancestors, got: ${JSON.stringify(ancestors)}`);
  }
  for (const c of resp.candidates) {
    if (typeof c.cx !== 'number' || typeof c.cy !== 'number') {
      throw new Error(`candidate missing cx/cy: ${JSON.stringify(c)}`);
    }
  }
});

// ─── CDP upload selector bridge ─────────────────────────────────────────────
test('CDP upload selector bridge resolves hidden and open-shadow file inputs', async (page) => {
  await page.setContent(`<!doctype html>
    <input id="upload-addon" type="file" hidden>
    <div id="shadow-host"></div>
    <script>
      document.querySelector('#shadow-host')
        .attachShadow({ mode: 'open' })
        .innerHTML = '<input id="shadow-upload" type="file">';
    </script>`);

  const session = await page.context().newCDPSession(page);
  const client = new CDPClient();
  client.sendCommand = async (_tabId, method, params = {}) => session.send(method, params);

  const fixtureFile = path.join(root, 'package.json');
  const attachThroughSelector = async (selector) => {
    const query = await client.querySelectorPierce(42, selector);
    if (query.objectIds.length !== 1 || !query.objectIds[0]) {
      throw new Error(`file input did not resolve to one CDP object handle: ${JSON.stringify(query)}`);
    }
    try {
      // Refreshing Chrome's DOM mirror invalidates frontend nodeIds. Runtime
      // object handles must remain valid across an unrelated DOM traversal.
      await session.send('DOM.getDocument', { depth: -1, pierce: true });
      await client.setFileInputFiles(42, query.objectIds[0], [fixtureFile]);
      const files = await client.getFileInputFiles(42, query.objectIds[0]);
      if (files?.[0]?.name !== 'package.json') {
        throw new Error(`attached FileList was not readable through the Runtime handle: ${JSON.stringify(files)}`);
      }
    } finally {
      await client.releaseObjectGroup(42, query.objectGroup);
    }
  };

  await attachThroughSelector('#upload-addon');
  await attachThroughSelector('#shadow-upload');
  const attached = await page.evaluate(() => ({
    hidden: document.querySelector('#upload-addon').files[0]?.name || '',
    shadow: document.querySelector('#shadow-host').shadowRoot
      .querySelector('#shadow-upload').files[0]?.name || '',
  }));
  if (attached.hidden !== 'package.json' || attached.shadow !== 'package.json') {
    throw new Error(`DOM.setFileInputFiles did not attach through resolved nodes: ${JSON.stringify(attached)}`);
  }
});

test('CDP toolbar selector probe traverses shadow hosts for dense clusters', async (page) => {
  await page.setContent(`<!doctype html>
    <style>
      #formatting-row { display:flex; align-items:center; gap:6px; width:420px; height:44px; }
      #editor-body { width:420px; height:160px; }
    </style>
    <div id="formatting-row">
      <button type="button">Bold</button>
      <span id="family-host"></span>
    </div>
    <div id="editor-body" role="textbox" contenteditable="true">Enter text</div>
    <script>
      document.querySelector('#family-host').attachShadow({ mode: 'open' }).innerHTML =
        '<input id="shadow-family" aria-label="Font family" value="Default" style="width:118px;height:22px">';
    </script>`);

  const session = await page.context().newCDPSession(page);
  const client = new CDPClient();
  client.sendCommand = async (_tabId, method, params = {}) => session.send(method, params);
  client.resolveSelector = async () => ({ found: true, nodeId: null, inViewport: true });

  const probe = await client.probeRichTextToolbarSelector(42, '#shadow-family');
  const candidate = probe?.fieldMeta?.toolbarCandidate;
  if (
    !probe?.resolved
    || Number(candidate?.score) < 4
    || !candidate?.reasons?.includes('dense_control_cluster')
    || candidate?.associatedEditorIdentity?.id !== 'editor-body'
  ) {
    throw new Error(`shadow-host dense toolbar cluster was not audited by the CDP selector probe: ${JSON.stringify(probe)}`);
  }

  await page.setContent(`<!doctype html>
    <style>
      #color-row { display:flex; align-items:center; gap:6px; width:420px; height:44px; }
      #editor-body { width:420px; height:160px; }
    </style>
    <div id="color-row">
      <button type="button">Bold</button>
      <input id="text-color" aria-label="Text color" value="#111111" style="width:118px;height:22px">
    </div>
    <div id="editor-body" role="textbox" contenteditable="true">Enter text</div>`);
  const colorProbe = await client.probeRichTextToolbarSelector(42, '#text-color');
  if (
    !colorProbe?.resolved
    || !colorProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('formatting_control_label')
    || !colorProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('dense_control_cluster')
    || colorProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
    || colorProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'editor-body'
  ) {
    throw new Error(`conventional text-color control was not audited by the CDP selector probe: ${JSON.stringify(colorProbe)}`);
  }

  await page.setContent(`<!doctype html>
    <style>
      #slotted-toolbar-editor { width:420px; margin-top:1400px; }
      #slot-editor-component { display:block; width:420px; height:160px; }
    </style>
    <div id="slotted-toolbar-editor">
      <span id="slot-toolbar-host">
        <input id="slotted-family" type="text" aria-label="Font family" value="Default" style="width:118px;height:22px">
        <input id="slotted-search" type="search" aria-label="Search links" value="" style="width:118px;height:22px">
        <input id="slotted-unlabelled-search" type="search" value="" style="width:118px;height:22px">
        <input id="slotted-filter" type="text" aria-label="Filter" value="" style="width:118px;height:22px">
        <input id="slotted-link" type="url" aria-label="Link URL" value="https://example.test" style="width:118px;height:22px">
        <select id="slotted-style" aria-label="Paragraph style" style="width:118px;height:24px">
          <option>Body</option><option>Heading 1</option><option>Heading 2</option>
        </select>
        <div id="slotted-editable-family" contenteditable="true" role="combobox" aria-label="Font family"
          style="width:118px;height:22px">Default</div>
      </span>
      <div id="slot-editor-component"></div>
    </div>
    <script>
      document.querySelector('#slot-toolbar-host').attachShadow({ mode: 'open' }).innerHTML =
        '<div role="toolbar" style="height:44px;display:flex;align-items:center"><slot></slot></div>';
      document.querySelector('#slot-editor-component').attachShadow({ mode: 'open' }).innerHTML =
        '<div id="slot-editor-body" role="textbox" contenteditable="true" style="width:420px;height:160px">Enter text</div>';
    </script>`);
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.documentElement.style.scrollBehavior = 'smooth';
  });
  const slottedProbe = await client.probeRichTextToolbarSelector(42, '#slotted-family');
  const settledSlottedRect = await page.evaluate(() => {
    const rect = document.querySelector('#slotted-family').getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    document.documentElement.style.scrollBehavior = 'auto';
    return { y: rect.y, h: rect.height, viewportHeight };
  });
  if (
    !slottedProbe?.resolved
    || !slottedProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
    || !slottedProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('labelled_toolbar_control')
    || slottedProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'slot-editor-body'
    || !slottedProbe.toolbarRegionKey
    || slottedProbe.toolbarRegionKey !== slottedProbe.fieldMeta.toolbarCandidate.regionKey
    || Math.abs(slottedProbe.rect.y - settledSlottedRect.y) > 2
    || slottedProbe.rect.y < 0
    || slottedProbe.rect.y + slottedProbe.rect.h > settledSlottedRect.viewportHeight
  ) {
    throw new Error(`labelled assigned-slot toolbar must settle before CDP audit: ${JSON.stringify({ slottedProbe, settledSlottedRect })}`);
  }
  const ordinarySearchProbe = await client.probeRichTextToolbarSelector(42, '#slotted-search');
  if (!ordinarySearchProbe?.resolved || ordinarySearchProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`ordinary labelled toolbar search was audited as formatting by the CDP selector probe: ${JSON.stringify(ordinarySearchProbe)}`);
  }
  const unlabelledSearchProbe = await client.probeRichTextToolbarSelector(42, '#slotted-unlabelled-search');
  if (
    !unlabelledSearchProbe?.resolved
    || unlabelledSearchProbe.fieldMeta?.type !== 'search'
    || unlabelledSearchProbe.fieldMeta?.toolbarCandidate
    || unlabelledSearchProbe.toolbarRegionKey !== slottedProbe.toolbarRegionKey
  ) {
    throw new Error(`unlabelled native search must remain ordinary while preserving its toolbar region: ${JSON.stringify(unlabelledSearchProbe)}`);
  }
  const ordinaryFilterProbe = await client.probeRichTextToolbarSelector(42, '#slotted-filter');
  if (!ordinaryFilterProbe?.resolved || ordinaryFilterProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`ordinary labelled toolbar text filter was audited as formatting by the CDP selector probe: ${JSON.stringify(ordinaryFilterProbe)}`);
  }
  const linkProbe = await client.probeRichTextToolbarSelector(42, '#slotted-link');
  if (
    !linkProbe?.resolved
    || linkProbe.fieldMeta?.type !== 'url'
    || !linkProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('formatting_control_label')
  ) {
    throw new Error(`URL-typed rich-text link control was not audited by the CDP selector probe: ${JSON.stringify(linkProbe)}`);
  }
  const editableProbe = await client.probeRichTextToolbarSelector(42, '#slotted-editable-family');
  if (
    !editableProbe?.resolved
    || editableProbe.fieldMeta?.contentEditable !== true
    || !editableProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('formatting_control_label')
  ) {
    throw new Error(`contenteditable rich-text formatting control was not audited by the CDP selector probe: ${JSON.stringify(editableProbe)}`);
  }
  const nativeStyleProbe = await client.probeRichTextToolbarSelector(42, '#slotted-style');
  if (
    !nativeStyleProbe?.resolved
    || nativeStyleProbe.fieldMeta?.type !== 'select'
    || !nativeStyleProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
    || !nativeStyleProbe.fieldMeta.toolbarCandidate.availablePresetValues?.includes('Heading 1')
  ) {
    throw new Error(`native rich-text style select was not audited by the CDP selector probe: ${JSON.stringify(nativeStyleProbe)}`);
  }

  await page.setContent(`<!doctype html>
    <label for="ordinary-status">Status</label>
    <select id="ordinary-status"><option>Draft</option><option>Published</option></select>`);
  const ordinarySelectProbe = await client.probeRichTextToolbarSelector(42, '#ordinary-status');
  if (!ordinarySelectProbe?.resolved || ordinarySelectProbe.fieldMeta?.type !== 'select' || ordinarySelectProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`labelled ordinary select was audited as formatting by the CDP selector probe: ${JSON.stringify(ordinarySelectProbe)}`);
  }

  await page.setContent(`<!doctype html>
    <div style="display:flex;align-items:center;gap:6px;width:320px;height:44px">
      <div id="compact-composer" role="textbox" contenteditable="true"
        style="width:190px;height:28px">Draft reply</div>
      <button type="button">Emoji</button>
      <button type="button">Send</button>
    </div>`);
  const compactComposerProbe = await client.probeRichTextToolbarSelector(42, '#compact-composer');
  if (!compactComposerProbe?.resolved || compactComposerProbe.fieldMeta?.toolbarCandidate) {
    throw new Error(`compact contenteditable composer was audited as formatting by the CDP selector probe: ${JSON.stringify(compactComposerProbe)}`);
  }
});

test('CDP type_text binds dispatch to the selector node approved by toolbar preflight', async (page) => {
  await page.setContent(`<!doctype html>
    <input class="shared-target" value="ordinary" style="width:180px;height:32px">`);
  const session = await page.context().newCDPSession(page);
  const client = new CDPClient();
  client.sendCommand = async (_tabId, method, params = {}) => session.send(method, params);

  const staleProbe = await client.probeRichTextToolbarSelector(42, '.shared-target');
  if (!staleProbe?.resolved || !staleProbe.selectorBackendNodeId) {
    throw new Error(`CDP selector preflight did not expose an exact node identity: ${JSON.stringify(staleProbe)}`);
  }
  await page.evaluate(() => {
    const previous = document.querySelector('.shared-target');
    const replacement = previous.cloneNode();
    replacement.value = '11';
    previous.replaceWith(replacement);
  });
  const rejected = await client.typeText(
    42,
    '.shared-target',
    'Document prose',
    true,
    staleProbe.selectorBackendNodeId,
  );
  const rejectedValue = await page.locator('.shared-target').inputValue();
  if (rejected?.success !== false || rejected?.dispatched !== false || !rejected?.retryable || rejectedValue !== '11') {
    throw new Error(`rerendered CDP selector target did not fail closed: ${JSON.stringify({ rejected, rejectedValue })}`);
  }

  const cloneProbe = await client.probeRichTextToolbarSelector(42, '.shared-target');
  await page.evaluate(() => {
    const observer = new MutationObserver(records => {
      if (!records.some(record => record.attributeName === 'data-webbrain-rich-text-preflight-target')) return;
      observer.disconnect();
      const previous = document.querySelector('.shared-target');
      const replacement = previous.cloneNode();
      replacement.value = '12';
      previous.replaceWith(replacement);
    });
    observer.observe(document.querySelector('.shared-target'), {
      attributes: true,
      attributeFilter: ['data-webbrain-rich-text-preflight-target'],
    });
  });
  const cloneRejected = await client.typeText(
    42,
    '.shared-target',
    'Document prose',
    true,
    cloneProbe.selectorBackendNodeId,
  );
  const cloneRejectedValue = await page.locator('.shared-target').inputValue();
  if (cloneRejected?.success !== false || cloneRejected?.dispatched !== false || !cloneRejected?.retryable || cloneRejectedValue !== '12') {
    throw new Error(`a replacement that copied the preflight attribute bypassed node identity: ${JSON.stringify({ cloneRejected, cloneRejectedValue })}`);
  }

  const stableProbe = await client.probeRichTextToolbarSelector(42, '.shared-target');
  const accepted = await client.typeText(
    42,
    '.shared-target',
    '14',
    false,
    stableProbe.selectorBackendNodeId,
  );
  const acceptedValue = await page.locator('.shared-target').inputValue();
  const leakedMarkers = await page.locator('[data-webbrain-rich-text-preflight-target]').count();
  if (!accepted?.success || accepted?.verified !== true || acceptedValue !== '1214' || leakedMarkers !== 0) {
    throw new Error(`stable CDP selector target did not type and clean up exactly: ${JSON.stringify({ accepted, acceptedValue, leakedMarkers })}`);
  }
});

for (const browserKind of ['chrome', 'firefox']) {
  test(`file picker guard (${browserKind}): blocks the native chooser and returns the exact input`, async (page) => {
    await setupContentHtml(page, `<!doctype html>
      <button id="choose">Select a file...</button>
      <input type="file" hidden>
      <input type="file" hidden>
      <script>
        document.querySelector('#choose').addEventListener('click', () => {
          document.querySelectorAll('input[type=file]')[1].click();
        });
      </script>`, browserKind);

    let chooserOpened = false;
    page.once('filechooser', () => { chooserOpened = true; });
    const result = await call(page, 'click', { text: 'Select a file...' });
    await page.waitForTimeout(20);
    if (chooserOpened) throw new Error('native file chooser was not suppressed');
    if (!result?.filePickerBlocked || result.success !== false || !result.selector) {
      throw new Error(`expected blocked picker with exact selector, got ${JSON.stringify(result)}`);
    }
    const selectorCheck = await page.evaluate((selector) => {
      const inputs = document.querySelectorAll('input[type=file]');
      const matches = document.querySelectorAll(selector);
      return { count: matches.length, correct: matches[0] === inputs[1] };
    }, result.selector);
    if (selectorCheck.count !== 1 || !selectorCheck.correct) {
      throw new Error(`selector did not uniquely resolve the clicked input: ${JSON.stringify({ result, selectorCheck })}`);
    }
  });

  test(`file picker guard (${browserKind}): withholds selectors that collide across shadow roots`, async (page) => {
    await setupContentHtml(page, `<!doctype html>
      <button id="choose">Select a shadow file...</button>
      <div id="host-a"></div>
      <div id="host-b"></div>
      <script>
        for (const id of ['host-a', 'host-b']) {
          document.querySelector('#' + id).attachShadow({ mode: 'open' }).innerHTML = '<input type="file">';
        }
        document.querySelector('#choose').addEventListener('click', () => {
          document.querySelector('#host-b').shadowRoot.querySelector('input').click();
        });
      </script>`, browserKind);

    const result = await call(page, 'click', { text: 'Select a shadow file...' });
    if (!result?.filePickerBlocked || result.success !== false) {
      throw new Error(`expected blocked picker, got ${JSON.stringify(result)}`);
    }
    if (Object.hasOwn(result, 'selector')) {
      throw new Error(`ambiguous shadow-root input must not return selector ${result.selector}`);
    }
    if (!/exact, unique/.test(result.error || '') || !/generic input\[type="file"\]/.test(result.error || '')) {
      throw new Error(`missing unique-selector recovery guidance: ${JSON.stringify(result)}`);
    }
  });
}

const deferredFilePickerOpeners = [
  ['promise', 'Promise.resolve().then(openPicker)'],
  ['timer', 'setTimeout(openPicker, 0)'],
  ['debounce-150ms', 'setTimeout(openPicker, 150)'],
  ['debounce-300ms', 'setTimeout(openPicker, 300)'],
  ['animation-frame', 'requestAnimationFrame(openPicker)'],
];
const showPickerOpeners = [
  ['immediate', 'openPicker()'],
  ...deferredFilePickerOpeners,
];

for (const browserKind of ['chrome', 'firefox']) {
  for (const [deferral, scheduleOpen] of deferredFilePickerOpeners) {
    test(`file picker guard (${browserKind}): blocks lazy ${deferral} chooser activation`, async (page) => {
      const inputId = `lazy-${browserKind}-${deferral}`;
      await setupContentHtml(page, `<!doctype html>
        <button id="choose">Add a deferred file...</button>
        <script>
          document.querySelector('#choose').addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.id = ${JSON.stringify(inputId)};
            input.hidden = true;
            document.body.appendChild(input);
            const openPicker = () => input.click();
            ${scheduleOpen};
          });
        </script>`, browserKind);

      let chooserOpened = false;
      page.once('filechooser', () => { chooserOpened = true; });
      const result = await call(page, 'click', { text: 'Add a deferred file...' });
      await page.waitForTimeout(20);
      if (chooserOpened) throw new Error(`${deferral} native file chooser was not suppressed`);
      if (!result?.filePickerBlocked || result.success !== false || result.selector !== `#${inputId}`) {
        throw new Error(`expected blocked lazy picker with #${inputId}, got ${JSON.stringify(result)}`);
      }
      const selectorCheck = await page.evaluate((selector) => {
        const matches = document.querySelectorAll(selector);
        return { count: matches.length, id: matches[0]?.id || '' };
      }, result.selector);
      if (selectorCheck.count !== 1 || selectorCheck.id !== inputId) {
        throw new Error(`lazy selector did not resolve uniquely: ${JSON.stringify({ result, selectorCheck })}`);
      }
    });
  }

  for (const [deferral, scheduleOpen] of showPickerOpeners) {
    test(`file picker guard (${browserKind}): blocks ${deferral} showPicker activation`, async (page) => {
      const inputId = `show-picker-${browserKind}-${deferral}`;
      const isolatedCall = await setupIsolatedContentHtml(page, `<!doctype html>
        <button id="choose">Show a file picker...</button>
        <input id=${JSON.stringify(inputId)} type="file" hidden>
        <script>
          document.querySelector('#choose').addEventListener('click', () => {
            const input = document.querySelector('#' + ${JSON.stringify(inputId)});
            const openPicker = () => input.showPicker();
            ${scheduleOpen};
          });
        </script>`, browserKind);

      let chooserOpened = false;
      page.once('filechooser', () => { chooserOpened = true; });
      const result = await isolatedCall('click', { text: 'Show a file picker...' });
      await page.waitForTimeout(20);
      if (chooserOpened) throw new Error(`${deferral} showPicker native chooser was not suppressed`);
      if (!result?.filePickerBlocked || result.success !== false || result.selector !== `#${inputId}`) {
        throw new Error(`expected blocked showPicker with #${inputId}, got ${JSON.stringify(result)}`);
      }
      const footprint = await page.evaluate(() => ({
        stableGlobal: Object.hasOwn(window, '__webbrainFilePickerGuardBridge'),
        attributes: Array.from(document.documentElement.attributes)
          .map(attribute => attribute.name)
          .filter(name => name.startsWith('data-webbrain-file-picker-')),
      }));
      if (footprint.stableGlobal || footprint.attributes.length) {
        throw new Error(`page-world guard left a detectable marker: ${JSON.stringify(footprint)}`);
      }
    });
  }

  test(`file picker guard (${browserKind}): blocks programmatic clicks inside closed shadow roots`, async (page) => {
    const isolatedCall = await setupIsolatedContentHtml(page, `<!doctype html>
      <button id="choose">Open a closed-shadow picker...</button>
      <div id="host"></div>
      <script>
        const input = document.querySelector('#host')
          .attachShadow({ mode: 'closed' })
          .appendChild(document.createElement('input'));
        input.type = 'file';
        document.querySelector('#choose').addEventListener('click', () => input.click());
      </script>`, browserKind);

    let chooserOpened = false;
    page.once('filechooser', () => { chooserOpened = true; });
    const result = await isolatedCall('click', { text: 'Open a closed-shadow picker...' });
    await page.waitForTimeout(20);
    if (chooserOpened) throw new Error('closed-shadow native chooser was not suppressed');
    if (!result?.filePickerBlocked || result.success !== false) {
      throw new Error(`expected blocked closed-shadow picker, got ${JSON.stringify(result)}`);
    }
    if (Object.hasOwn(result, 'selector')) {
      throw new Error(`closed-shadow picker must not expose an unusable selector: ${result.selector}`);
    }
  });

  test(`file picker guard (${browserKind}): suppresses long programmatic debounce after result settlement`, async (page) => {
    const isolatedCall = await setupIsolatedContentHtml(page, `<!doctype html>
      <button id="choose">Schedule a late picker...</button>
      <input id="late-picker" type="file" hidden>
      <script>
        document.querySelector('#choose').addEventListener('click', () => {
          setTimeout(() => {
            window.__latePickerAttempted = true;
            document.querySelector('#late-picker').click();
          }, 800);
        });
      </script>`, browserKind);

    let chooserOpened = false;
    page.once('filechooser', () => { chooserOpened = true; });
    const result = await isolatedCall('click', { text: 'Schedule a late picker...' });
    if (!result?.success || result.filePickerBlocked) {
      throw new Error(`late picker should settle before its callback, got ${JSON.stringify(result)}`);
    }
    await page.waitForTimeout(350);
    const attempted = await page.evaluate(() => window.__latePickerAttempted === true);
    if (!attempted) throw new Error('late picker callback did not execute');
    if (chooserOpened) throw new Error('post-settlement native chooser was not suppressed');
  });
}

test('Chrome CDP file picker guard blocks trusted showPicker activation and restores the prototype', async (page) => {
  await page.setContent(`<!doctype html>
    <style>
      #closed-host { display: block; width: 220px; height: 40px; }
    </style>
    <button id="choose">Open trusted picker</button>
    <button id="choose-closed">Open trusted closed picker</button>
    <input id="trusted-show-picker" type="file" hidden>
    <div id="closed-host"></div>
    <script>
      window.__originalShowPicker = HTMLInputElement.prototype.showPicker;
      window.__originalInputClick = HTMLInputElement.prototype.click;
      const closedInput = document.querySelector('#closed-host')
        .attachShadow({ mode: 'closed' })
        .appendChild(document.createElement('input'));
      closedInput.type = 'file';
      closedInput.style.cssText = 'display:block;width:220px;height:40px';
      document.querySelector('#choose').addEventListener('click', () => {
        document.querySelector('#trusted-show-picker').showPicker();
      });
      document.querySelector('#choose-closed').addEventListener('click', () => closedInput.click());
    </script>`);
  const pageGuardSrc = await readFile(filePickerGuardPageJsPath, 'utf-8');
  await page.addScriptTag({ content: pageGuardSrc });

  const client = new CDPClient();
  const protocolSession = await page.context().newCDPSession(page);
  client.sendCommand = async (_tabId, method, params = {}) => protocolSession.send(method, params);
  protocolSession.on('Page.fileChooserOpened', (params) => {
    const handlers = client.eventHandlers.get(77)?.['Page.fileChooserOpened'] || [];
    for (const handler of handlers) handler(params);
  });
  client.evaluate = async (_tabId, expression) => ({
    result: { value: await page.evaluate(expression) },
  });

  let chooserOpened = false;
  page.once('filechooser', () => { chooserOpened = true; });
  await client.armFileInputClickGuard(77, 500);
  await page.click('#choose');
  const blocked = await client.consumeFileInputClickGuard(77, 0);
  await page.waitForTimeout(20);

  if (chooserOpened) throw new Error('trusted showPicker native chooser was not suppressed');
  if (!blocked?.blocked || blocked.selector !== '#trusted-show-picker') {
    throw new Error(`expected trusted showPicker block, got ${JSON.stringify(blocked)}`);
  }
  const restored = await page.evaluate(
    () => ({
      showPicker: HTMLInputElement.prototype.showPicker === window.__originalShowPicker,
      click: HTMLInputElement.prototype.click === window.__originalInputClick,
    }),
  );
  if (!restored.showPicker || !restored.click) {
    throw new Error(`input prototypes were not restored after guard consumption: ${JSON.stringify(restored)}`);
  }

  let closedChooserOpened = false;
  page.once('filechooser', () => { closedChooserOpened = true; });
  await client.armFileInputClickGuard(77, 500);
  await page.click('#choose-closed');
  const closedBlocked = await client.consumeFileInputClickGuard(77, 0);
  await page.waitForTimeout(20);
  if (closedChooserOpened) throw new Error('trusted closed-shadow native chooser was not suppressed');
  if (!closedBlocked?.blocked || closedBlocked.selector !== null) {
    throw new Error(`expected trusted closed-shadow block without selector, got ${JSON.stringify(closedBlocked)}`);
  }

  let directChooserEventObserved = false;
  page.once('filechooser', () => { directChooserEventObserved = true; });
  await client.armFileInputClickGuard(77, 500);
  await page.click('#closed-host');
  const directBlocked = await client.consumeFileInputClickGuard(77, 0);
  await page.waitForTimeout(20);
  if (!directChooserEventObserved) {
    throw new Error('direct trusted closed-shadow chooser did not emit the intercepted protocol event');
  }
  if (!directBlocked?.blocked || directBlocked.selector !== null) {
    throw new Error(`expected protocol-level closed-shadow block, got ${JSON.stringify(directBlocked)}`);
  }

  await page.evaluate(() => {
    const root = document.documentElement;
    root.setAttribute('data-webbrain-file-picker-guard', 'residual-content-guard');
    document.dispatchEvent(new Event('webbrain:file-picker-guard-arm'));
    root.removeAttribute('data-webbrain-file-picker-guard');
  });
  const residualInstalled = await page.evaluate(
    () => HTMLInputElement.prototype.click !== window.__originalInputClick,
  );
  if (!residualInstalled) throw new Error('residual page-world guard was not installed');

  await client.armFileInputClickGuard(77, 250);
  const noPickerBlocked = await client.consumeFileInputClickGuard(77, 0);
  if (noPickerBlocked) throw new Error(`unexpected picker during restore-stack test: ${JSON.stringify(noPickerBlocked)}`);
  await page.waitForTimeout(350);
  const stackRestored = await page.evaluate(() => ({
    showPicker: HTMLInputElement.prototype.showPicker === window.__originalShowPicker,
    click: HTMLInputElement.prototype.click === window.__originalInputClick,
  }));
  if (!stackRestored.showPicker || !stackRestored.click) {
    throw new Error(`stacked page/CDP guards did not restore native prototypes: ${JSON.stringify(stackRestored)}`);
  }
});

test('Firefox upload_file resolves one open-shadow input and rejects ambiguous pierced selectors', async (page) => {
  await page.setContent(`<!doctype html>
    <div id="host-a"></div>
    <div id="host-b"></div>
    <script>
      const inputA = document.createElement('input');
      inputA.type = 'file';
      inputA.id = 'shadow-upload';
      window.__uploadEvents = { input: 0, change: 0 };
      inputA.addEventListener('input', () => window.__uploadEvents.input++);
      inputA.addEventListener('change', () => window.__uploadEvents.change++);
      document.querySelector('#host-a').attachShadow({ mode: 'open' }).appendChild(inputA);
      const inputB = document.createElement('input');
      inputB.type = 'file';
      document.querySelector('#host-b').attachShadow({ mode: 'open' }).appendChild(inputB);
    </script>`);

  const originalBrowser = globalThis.browser;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.browser = {
      downloads: {
        async search(query) {
          if (query?.id !== 9001) throw new Error(`unexpected download query ${JSON.stringify(query)}`);
          return [{
            id: 9001,
            state: 'complete',
            url: 'https://example.com/shadow-upload.txt',
            filename: '/home/user/Downloads/shadow-upload.txt',
            mime: 'text/plain',
          }];
        },
      },
      tabs: {
        async get(tabId) {
          return { id: tabId, url: 'https://example.com/form' };
        },
        async executeScript(_tabId, details) {
          return [await page.evaluate((source) => window.eval(source), details.code)];
        },
      },
    };
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name) {
          const key = String(name).toLowerCase();
          if (key === 'content-length') return '2';
          if (key === 'content-type') return 'text/plain';
          return null;
        },
      },
      async arrayBuffer() {
        return new Uint8Array([111, 107]).buffer;
      },
    });

    const agent = new FirefoxAgent({});
    const uploaded = await agent.executeTool(77, 'upload_file', {
      selector: '#shadow-upload',
      downloadId: 9001,
    });
    if (!uploaded?.success || uploaded.attached?.name !== 'shadow-upload.txt' || uploaded.attached?.size !== 2) {
      throw new Error(`open-shadow upload failed: ${JSON.stringify(uploaded)}`);
    }
    const state = await page.evaluate(() => {
      const input = document.querySelector('#host-a').shadowRoot.querySelector('#shadow-upload');
      return {
        count: input.files.length,
        name: input.files[0]?.name || '',
        size: input.files[0]?.size ?? -1,
        events: window.__uploadEvents,
      };
    });
    if (
      state.count !== 1
      || state.name !== 'shadow-upload.txt'
      || state.size !== 2
      || state.events.input !== 1
      || state.events.change !== 1
    ) {
      throw new Error(`open-shadow upload state mismatch: ${JSON.stringify(state)}`);
    }

    const ambiguous = await agent.executeTool(77, 'upload_file', {
      selector: 'input[type="file"]',
      downloadId: 9001,
    });
    if (
      ambiguous?.success !== false
      || ambiguous.dispatched !== false
      || ambiguous.ambiguous !== true
      || ambiguous.matchCount !== 2
      || !/exact, unique selector/.test(ambiguous.error || '')
    ) {
      throw new Error(`ambiguous pierced selector did not fail closed: ${JSON.stringify(ambiguous)}`);
    }
  } finally {
    if (originalBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = originalBrowser;
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

for (const browserKind of ['chrome', 'firefox']) {
  test(`click_ax (${browserKind}): stale refs are explicit pre-dispatch failures`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const result = await call(page, 'click_ax', { ref_id: 'ref_999999' });
    if (
      result?.success !== false
      || result?.dispatched !== false
      || result?.noDispatch !== true
      || result?.fallbackAttempted !== false
    ) {
      throw new Error(`expected explicit pre-dispatch markers, got: ${JSON.stringify(result)}`);
    }
    if (!/not found/i.test(result.error || '')) {
      throw new Error(`expected stale-ref error, got: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): refs are rejected after a same-document route change`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const match = String(tree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
    if (!match || !tree?.documentToken || !tree?.refScopeUrl) {
      throw new Error(`expected scoped AX ref, got: ${JSON.stringify(tree)}`);
    }
    await page.evaluate(() => history.pushState({}, '', '#different-route'));
    const result = await call(page, 'click_ax', {
      ref_id: match[1],
      expectedDocumentToken: tree.documentToken,
      expectedPageUrl: tree.refScopeUrl,
    });
    if (
      result?.success !== false
      || result?.staleRef !== true
      || result?.routeChanged !== true
      || result?.dispatched !== false
    ) {
      throw new Error(`expected route-scoped stale-ref failure, got: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): an old ref cannot alias after the new route tree is read`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const firstTree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const firstMatch = String(firstTree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
    if (!firstMatch) throw new Error(`expected first-route ref, got: ${JSON.stringify(firstTree)}`);

    await page.evaluate(() => history.pushState({}, '', '#new-tree-route'));
    const secondTree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const secondMatch = String(secondTree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
    if (!secondMatch || !secondTree?.documentToken || !secondTree?.refScopeUrl) {
      throw new Error(`expected second-route scoped AX ref, got: ${JSON.stringify(secondTree)}`);
    }
    if (firstMatch[1] === secondMatch[1]) {
      throw new Error(`route-scoped refs must not reuse the same identifier: ${firstMatch[1]}`);
    }

    // Simulate the reviewed failure exactly: the agent has already cached the
    // latest route scope but the model reuses a ref string from the old tree.
    const stale = await call(page, 'click_ax', {
      ref_id: firstMatch[1],
      expectedDocumentToken: secondTree.documentToken,
      expectedPageUrl: secondTree.refScopeUrl,
    });
    if (
      stale?.success !== false
      || stale?.dispatched !== false
      || stale?.noDispatch !== true
      || stale?.fallbackAttempted !== false
      || !/not found/i.test(stale?.error || '')
    ) {
      throw new Error(`expected old ref to fail before dispatch, got: ${JSON.stringify(stale)}`);
    }

    const fresh = await call(page, 'click_ax', {
      ref_id: secondMatch[1],
      expectedDocumentToken: secondTree.documentToken,
      expectedPageUrl: secondTree.refScopeUrl,
    });
    if (!fresh?.success) {
      throw new Error(`expected current-route ref to remain usable, got: ${JSON.stringify(fresh)}`);
    }
  });

  test(`click_ax (${browserKind}): unnamed broad generic targets are rejected`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
    const match = String(tree?.pageContent || '').match(/group \[(ref_\d+)\]/);
    if (!match) throw new Error(`could not find unnamed broad group in AX tree: ${tree?.pageContent}`);
    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== false
      || result?.ambiguousTarget !== true
      || result?.dispatched !== false
      || result?.targetContext?.truncated !== true
    ) {
      throw new Error(`expected ambiguous generic target failure, got: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): disabled controls are visible and rejected before dispatch`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const content = String(tree?.pageContent || '');
    for (const label of ['Disabled native action', 'Disabled ARIA action']) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = content.match(new RegExp(`button "${escaped}" \\[(ref_\\d+)\\][^\\n]*disabled=true`));
      if (!match) throw new Error(`expected disabled state for ${label} in AX tree: ${content}`);
      const result = await call(page, 'click_ax', { ref_id: match[1] });
      if (
        result?.success !== false
        || result.disabled !== true
        || result.dispatched !== false
        || result.noDispatch !== true
        || result.fallbackAttempted !== false
      ) {
        throw new Error(`disabled ${label} should fail before dispatch: ${JSON.stringify(result)}`);
      }
    }
  });

  test(`input tools (${browserKind}): invalid targets and keys are explicit pre-dispatch failures`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const calls = [
      ['type', { text: 'should not be typed' }],
      ['type_ax', { ref_id: 'ref_999999', text: 'should not be typed' }],
      ['set_field', { ref_id: 'ref_999999', text: 'should not be typed' }],
      ['press_keys', { key: 'F5' }],
    ];
    for (const [action, params] of calls) {
      const result = await call(page, action, params);
      if (
        result?.success !== false
        || result?.dispatched !== false
        || result?.noDispatch !== true
      ) {
        throw new Error(`${action} should be an explicit pre-dispatch failure, got: ${JSON.stringify(result)}`);
      }
    }
  });

  test(`checkbox tools (${browserKind}): AX state and set_checked are explicit and idempotent`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const content = String(tree?.pageContent || '');
    const match = content.match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*type="checkbox"[^\n]*checked=false/);
    if (!match) throw new Error(`expected native unchecked state in AX tree: ${content}`);

    const checked = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      checked?.success !== true
      || checked.checkedBefore !== false
      || checked.checkedAfter !== true
      || checked.checkedChanged !== true
      || checked.verified !== true
    ) {
      throw new Error(`click_ax did not report native checkbox transition: ${JSON.stringify(checked)}`);
    }

    const unchecked = await call(page, 'set_checked', { ref_id: match[1], checked: false });
    if (
      unchecked?.success !== true
      || unchecked.checkedBefore !== true
      || unchecked.checkedAfter !== false
      || unchecked.changed !== true
      || unchecked.verified !== true
    ) {
      throw new Error(`set_checked did not reach desired false state: ${JSON.stringify(unchecked)}`);
    }

    const idempotent = await call(page, 'set_checked', { ref_id: match[1], checked: false });
    if (
      idempotent?.success !== true
      || idempotent.idempotent !== true
      || idempotent.dispatched !== false
      || idempotent.checkedBefore !== false
      || idempotent.checkedAfter !== false
    ) {
      throw new Error(`set_checked repeated action was not idempotent: ${JSON.stringify(idempotent)}`);
    }
  });

  test(`set_checked (${browserKind}): wrapped labels and confirmation-gated state are explicit`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const content = String(tree?.pageContent || '');
    const match = content.match(/checkbox "Firefox for Android compatibility" \[(ref_\d+)\][^\n]*type="checkbox"[^\n]*checked=false/);
    if (!match) throw new Error(`expected wrapped Android checkbox label in AX tree: ${content}`);

    const result = await call(page, 'set_checked', { ref_id: match[1], checked: true });
    if (
      result?.success !== false
      || result.dispatched !== true
      || result.checkedBefore !== false
      || result.checkedAfter !== false
      || result.verified !== false
      || result.confirmationRequired !== true
      || result.recoveryRequired !== 'confirmation_dialog'
      || result.noProgress === true
      || result.error
      || result.confirmation?.title !== 'Firefox for Android compatibility'
      || !result.confirmation?.actions?.includes('Yes, I’ve tested my extension with Firefox for Android')
      || !result.confirmation?.actions?.includes('No, I have not tested')
    ) {
      throw new Error(`confirmation-gated checkbox was reported as ordinary no-progress: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): waits for controlled checkbox reconciliation`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
    if (!match) throw new Error(`expected controlled checkbox ref in AX tree: ${tree?.pageContent}`);

    await page.evaluate(() => {
      const checkbox = document.getElementById('firefox-checkbox');
      checkbox.addEventListener('click', () => {
        setTimeout(() => {
          checkbox.checked = false;
        }, 0);
      });
    });
    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== false
      || result.noProgress !== true
      || result.verified !== false
      || result.checkedBefore !== false
      || result.checkedAfter !== false
      || result.desiredChecked !== true
      || result.checkboxState?.actualChecked !== false
    ) {
      throw new Error(`controlled checkbox rollback was accepted too early: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): an already-selected radio keeps desired checked state`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const match = String(tree?.pageContent || '').match(/radio "Selected channel" \[(ref_\d+)\][^\n]*checked=true/);
    if (!match) throw new Error(`expected selected radio state in AX tree: ${tree?.pageContent}`);

    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== true
      || result.checkedBefore !== true
      || result.checkedAfter !== true
      || result.checkedChanged !== false
      || result.desiredChecked !== true
      || result.checkboxState?.desiredChecked !== true
      || result.checkboxState?.actualChecked !== true
    ) {
      throw new Error(`selected radio was represented as needing an uncheck: ${JSON.stringify(result)}`);
    }
  });

  test(`click_ax (${browserKind}): a prevented radio selection is an explicit failure`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
    const match = String(tree?.pageContent || '').match(/radio "Blocked channel" \[(ref_\d+)\][^\n]*checked=false/);
    if (!match) throw new Error(`expected blocked radio state in AX tree: ${tree?.pageContent}`);

    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (
      result?.success !== false
      || result.noProgress !== true
      || result.verified !== false
      || result.checkedBefore !== false
      || result.checkedAfter !== false
      || result.desiredChecked !== true
      || result.checkboxState?.actualChecked !== false
      || !/Radio remained unselected/.test(String(result.error || ''))
    ) {
      throw new Error(`prevented radio selection was not reported as a failure: ${JSON.stringify(result)}`);
    }
  });

  test(`verify_form refs (${browserKind}): form controls receive actionable AX refs`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const result = await call(page, 'resolve_form_field_refs', { selector: 'form' });
    if (
      result?.success !== true
      || !Array.isArray(result.refs)
      || result.refs.length < 4
      || result.refs.some(ref => !/^ref_\d+$/.test(String(ref || '')))
      || typeof result.documentToken !== 'string'
      || !result.documentToken
      || result.refScopeUrl !== page.url()
    ) {
      throw new Error(`form controls did not receive actionable refs: ${JSON.stringify(result)}`);
    }
  });
}

async function assertSemicolonShortcutEvent(page, browserKind, expectedKeyCode) {
  await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
  await page.evaluate(() => {
    window.__semicolonShortcutEvents = [];
    document.addEventListener('keydown', (event) => {
      if (event.key !== ';') return;
      window.__semicolonShortcutEvents.push({
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        which: event.which,
      });
    });
  });

  const result = await call(page, 'press_keys', { key: ';' });
  if (result?.success !== true || result?.dispatched !== true || result?.key !== ';') {
    throw new Error(`semicolon should dispatch successfully, got: ${JSON.stringify(result)}`);
  }
  const events = await page.evaluate(() => window.__semicolonShortcutEvents);
  if (
    events?.length !== 1
    || events[0]?.key !== ';'
    || events[0]?.code !== 'Semicolon'
    || events[0]?.keyCode !== expectedKeyCode
    || events[0]?.which !== expectedKeyCode
  ) {
    throw new Error(`semicolon shortcut metadata mismatch: ${JSON.stringify(events)}`);
  }
}

test('press_keys (chrome): semicolon dispatches Chromium-compatible metadata', async (page) => {
  await assertSemicolonShortcutEvent(page, 'chrome', 186);
});

firefoxTest('press_keys (firefox engine): semicolon dispatches Gecko-compatible metadata', async (page) => {
  await assertSemicolonShortcutEvent(page, 'firefox', 59);
});

test('set_checked (chrome): post-click verification survives same-document route changes', async (page) => {
  await setupContentFixture(page, 'trusted-click-fallback.html', 'chrome');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected Chrome checkbox ref in AX tree: ${tree?.pageContent}`);

  const preflight = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    expectedPageUrl: tree.refScopeUrl,
    probeOnly: true,
    markForTrustedClick: true,
  });
  if (preflight?.needsTrustedClick !== true || !preflight.marker) {
    throw new Error(`expected trusted checkbox preflight marker: ${JSON.stringify(preflight)}`);
  }

  await page.locator('#firefox-checkbox').click();
  await page.evaluate(() => history.pushState({}, '', '#checked-filter'));
  const verified = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    probeOnly: true,
    markForTrustedClick: false,
    cleanupMarker: preflight.marker,
  });
  if (
    verified?.success !== true
    || verified.checkedAfter !== true
    || verified.verified !== true
    || verified.staleRef === true
  ) {
    throw new Error(`same-document route change invalidated marker verification: ${JSON.stringify(verified)}`);
  }
});

test('set_checked (chrome): markers are one-shot, unique, and self-cleaning', async (page) => {
  await setupContentFixture(page, 'trusted-click-fallback.html', 'chrome');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected Chrome checkbox ref in AX tree: ${tree?.pageContent}`);

  await page.evaluate(() => {
    window.__wbOriginalSetTimeout = window.setTimeout;
    window.__wbMarkerCleanup = null;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 15000 && !window.__wbMarkerCleanup) {
        window.__wbMarkerCleanup = callback;
        return 1;
      }
      return window.__wbOriginalSetTimeout(callback, delay, ...args);
    };
  });
  const expiring = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    expectedPageUrl: tree.refScopeUrl,
    probeOnly: true,
    markForTrustedClick: true,
  });
  const expiredCount = await page.evaluate((marker) => {
    window.__wbMarkerCleanup?.();
    window.setTimeout = window.__wbOriginalSetTimeout;
    delete window.__wbOriginalSetTimeout;
    delete window.__wbMarkerCleanup;
    return document.querySelectorAll(`[data-webbrain-set-checked-target="${marker}"]`).length;
  }, expiring.marker);
  if (expiredCount !== 0) throw new Error(`trusted marker did not self-clean: ${expiring.marker}`);

  const ambiguous = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    expectedPageUrl: tree.refScopeUrl,
    probeOnly: true,
    markForTrustedClick: true,
  });
  await page.evaluate((marker) => {
    document.getElementById('trusted-firefox-checkbox')
      .setAttribute('data-webbrain-set-checked-target', marker);
  }, ambiguous.marker);
  const uniqueClient = new CDPClient();
  uniqueClient.sendCommand = async (_tabId, method) => {
    if (method === 'Runtime.enable') return {};
    throw new Error(`unexpected CDP command while resolving marker: ${method}`);
  };
  uniqueClient.evaluate = async (_tabId, expression) => ({
    result: { value: await page.evaluate(expression) },
  });
  const duplicateResolution = await uniqueClient.resolveSelector(
    42,
    `[data-webbrain-set-checked-target="${ambiguous.marker}"]`,
    { requireUnique: true, retries: 0 },
  );
  if (!duplicateResolution?.error || duplicateResolution?.matchCount !== 2) {
    throw new Error(`CDP trusted selector did not reject duplicate markers: ${JSON.stringify(duplicateResolution)}`);
  }
  const verified = await call(page, 'set_checked', {
    ref_id: match[1],
    checked: true,
    expectedDocumentToken: tree.documentToken,
    probeOnly: true,
    markForTrustedClick: false,
    cleanupMarker: ambiguous.marker,
  });
  const remaining = await page.locator(`[data-webbrain-set-checked-target="${ambiguous.marker}"]`).count();
  if (
    verified?.success !== false
    || verified.markerConflict !== true
    || verified.markerMatchCount !== 2
    || remaining !== 0
  ) {
    throw new Error(`ambiguous trusted marker did not fail closed and clean up: ${JSON.stringify({ verified, remaining })}`);
  }
});

test('set_checked (firefox): waits for controlled checkbox reconciliation before verifying', async (page) => {
  await setupContentFixture(page, 'trusted-click-fallback.html', 'firefox');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected Firefox checkbox ref in AX tree: ${tree?.pageContent}`);

  await page.evaluate(() => {
    const checkbox = document.getElementById('firefox-checkbox');
    checkbox.addEventListener('click', () => {
      setTimeout(() => {
        checkbox.checked = false;
      }, 0);
    }, { once: true });
  });

  const result = await call(page, 'set_checked', { ref_id: match[1], checked: true });
  if (
    result?.success !== false
    || result.dispatched !== true
    || result.checkedBefore !== false
    || result.checkedAfter !== false
    || result.verified !== false
    || result.noProgress !== true
  ) {
    throw new Error(`Firefox set_checked verified before controlled rollback settled: ${JSON.stringify(result)}`);
  }
});

for (const browserKind of ['chrome', 'firefox']) {
  test(`click_ax (${browserKind}): aria-labelledby action returns bounded nearest card context`, async (page) => {
    await setupContentFixture(page, 'trusted-click-fallback.html', browserKind);
    const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 10, maxChars: 20000 });
    const match = String(tree?.pageContent || '').match(/button "Add to cart" \[(ref_\d+)\]/);
    if (!match) throw new Error(`could not find product action in AX tree: ${tree?.pageContent}`);

    const result = await call(page, 'click_ax', { ref_id: match[1] });
    if (!result?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(result)}`);
    if (
      result.name !== 'Add to cart'
      || result.targetContext?.heading !== 'Cola Zero 6-pack'
      || !String(result.targetContext?.text || '').includes('Cola Zero 6-pack')
      || !String(result.targetContext?.href || '').endsWith('/products/cola-zero-six-pack')
    ) {
      throw new Error(`nearest product context missing or wrong: ${JSON.stringify(result)}`);
    }
    if (
      String(result.targetContext.text).length > 240
      || String(result.targetContext.heading).length > 160
      || String(result.targetContext.href).length > 500
    ) {
      throw new Error(`product context bounds regressed: ${JSON.stringify(result.targetContext)}`);
    }
  });
}

test('set_field (chrome): trusted contenteditable input updates framework state and enables submit', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const content = String(tree?.pageContent || '');
  const editorMatch = content.match(/textbox "Framework post text" \[(ref_\d+)\]/);
  if (!editorMatch || !/button "Framework Post" \[(ref_\d+)\][^\n]*disabled=true/.test(content)) {
    throw new Error(`expected empty framework editor and disabled submit: ${content}`);
  }

  const preflight = await call(page, 'set_field', {
    ref_id: editorMatch[1],
    text: 'Trusted framework post',
    clear: true,
  });
  if (
    preflight?.success !== false
    || preflight.trustedTypeRequired !== true
    || preflight.dispatched !== false
    || preflight.noDispatch !== true
  ) {
    throw new Error(`contenteditable set_field should route to trusted typing before DOM mutation: ${JSON.stringify(preflight)}`);
  }

  const before = await page.evaluate(() => ({
    text: document.getElementById('framework-editor').innerText,
    disabled: document.getElementById('framework-post').getAttribute('aria-disabled'),
    events: window.__frameworkInputEvents,
  }));
  if (before.text || before.disabled !== 'true' || before.events.length !== 0) {
    throw new Error(`contenteditable preflight mutated framework state: ${JSON.stringify(before)}`);
  }

  const originalChrome = globalThis.chrome;
  const originals = {
    attach: cdpClient.attach,
    sendCommand: cdpClient.sendCommand,
  };
  const session = await page.context().newCDPSession(page);
  globalThis.chrome = {
    tabs: {
      async sendMessage(_tabId, message) {
        return call(page, message.action, message.params || {});
      },
    },
  };
  try {
    cdpClient.attach = async () => ({ tabId: 42, attached: true });
    cdpClient.sendCommand = async (_tabId, method, params) => session.send(method, params);
    const agent = new Agent({});
    const result = await agent._maybeFallbackFieldWithCdp(
      42,
      'set_field',
      { ref_id: editorMatch[1], text: 'Trusted framework post', clear: true },
      preflight,
    );
    const after = await page.evaluate(() => ({
      text: document.getElementById('framework-editor').innerText,
      disabled: document.getElementById('framework-post').getAttribute('aria-disabled'),
      events: window.__frameworkInputEvents,
    }));
    if (
      result?.success !== true
      || result.trusted !== true
      || result.verified !== true
      || result.dispatched !== true
      || after.text !== 'Trusted framework post'
      || after.disabled !== 'false'
      || after.events.length !== 1
      || after.events[0].trusted !== true
    ) {
      throw new Error(`trusted contenteditable path did not update framework state: ${JSON.stringify({ result, after })}`);
    }
  } finally {
    cdpClient.attach = originals.attach;
    cdpClient.sendCommand = originals.sendCommand;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('click_ax: Agent.executeTool keeps synthetic-first behavior and uses trusted CDP only for an ignored generic row', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
  const trustedMatch = String(tree?.pageContent || '').match(/listitem "Defne Sokullu Yesterday Photo" \[(ref_\d+)\]/);
  const syntheticMatch = String(tree?.pageContent || '').match(/listitem "Normal synthetic row" \[(ref_\d+)\]/);
  const disclosureMatch = String(tree?.pageContent || '').match(/"Native disclosure" \[(ref_\d+)\]/);
  if (!trustedMatch || !syntheticMatch || !disclosureMatch) {
    throw new Error(`expected trusted, synthetic, and disclosure fixture rows in AX tree: ${tree?.pageContent}`);
  }

  const originalChrome = globalThis.chrome;
  const originals = {
    attach: cdpClient.attach,
    evaluate: cdpClient.evaluate,
    dispatch: cdpClient.dispatchMouseEvent,
  };
  const session = await page.context().newCDPSession(page);
  const dispatched = [];
  const listener = { addListener() {}, removeListener() {} };
  globalThis.chrome = {
    runtime: {},
    tabs: {
      async get(tabId) {
        return { id: tabId, url: page.url(), title: 'Trusted click fixture' };
      },
      async query() {
        return [{ id: 42, url: page.url() }];
      },
      async sendMessage(_tabId, message) {
        return call(page, message.action, message.params || {});
      },
    },
    downloads: { onCreated: listener },
    webRequest: { onBeforeRequest: listener },
    scripting: { async executeScript() {} },
  };

  try {
    cdpClient.attach = async () => ({ tabId: 42, attached: true });
    cdpClient.evaluate = async (_tabId, expression) => ({
      result: { value: await page.evaluate(expression) },
    });
    cdpClient.dispatchMouseEvent = async (_tabId, type, x, y) => {
      dispatched.push({ type, x, y });
      return session.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: type === 'mouseMoved' ? 'none' : 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: type === 'mouseMoved' ? 0 : 1,
      });
    };

    const agent = new Agent({});
    agent._isPdfTab = async () => false;
    agent._currentUrl = async () => page.url();
    agent._clickAxFinalSettleMs = () => 60;

    const trustedResult = await agent.executeTool(42, 'click_ax', { ref_id: trustedMatch[1] });
    const afterTrusted = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      ambientStatus: document.getElementById('ambient-status').textContent,
      events: window.__trustedClickEvents,
      selected: document.getElementById('trusted-row').classList.contains('trusted-opened'),
      semanticSelected: document.getElementById('trusted-row').getAttribute('aria-current'),
    }));
    if (
      trustedResult?.success !== true
      || trustedResult.fallback !== 'cdp_after_synthetic_no_progress'
      || trustedResult.trusted !== true
      || trustedResult.verified !== true
    ) {
      throw new Error(`actual Agent/content/CDP chain did not complete trusted fallback: ${JSON.stringify(trustedResult)}`);
    }
    if (
      !trustedResult.observedHints?.includes('page_text')
      || !trustedResult.observedHints?.includes('target_state_weak')
    ) {
      throw new Error(`unrelated page/target churn should be retained only as diagnostic hints: ${JSON.stringify(trustedResult)}`);
    }
    if (
      afterTrusted.status !== 'trusted-opened'
      || afterTrusted.ambientStatus !== 'unrelated-chat-churn'
      || !afterTrusted.selected
      || afterTrusted.semanticSelected !== 'true'
    ) {
      throw new Error(`trusted CDP fallback did not activate the row: ${JSON.stringify(afterTrusted)}`);
    }
    if (
      afterTrusted.events.length !== 2
      || afterTrusted.events[0].trusted !== false
      || afterTrusted.events[1].trusted !== true
    ) {
      throw new Error(`expected one synthetic then one trusted event: ${JSON.stringify(afterTrusted.events)}`);
    }
    if (dispatched.map(event => event.type).join(',') !== 'mouseMoved,mousePressed,mouseReleased') {
      throw new Error(`unexpected trusted input sequence: ${JSON.stringify(dispatched)}`);
    }
    if (Object.keys(trustedResult).some(key => key.startsWith('_fallback') || key === '_syntheticClickStartedAt')) {
      throw new Error(`internal click state leaked into the agent result: ${JSON.stringify(trustedResult)}`);
    }

    await page.evaluate(() => { document.getElementById('status').textContent = 'idle'; });
    const dispatchCountBeforeNormal = dispatched.length;
    const normalResult = await agent.executeTool(42, 'click_ax', { ref_id: syntheticMatch[1] });
    const normalState = await page.evaluate(() => ({
      status: document.getElementById('status').textContent,
      events: window.__syntheticClickEvents,
      selected: document.getElementById('synthetic-row').classList.contains('synthetic-opened'),
    }));
    if (
      normalResult?.success !== true
      || normalResult.trusted !== false
      || normalResult.verified !== true
      || normalResult.observedEffects?.[0] !== 'target_state'
    ) {
      throw new Error(`working synthetic target was not accepted from its local state change: ${JSON.stringify(normalResult)}`);
    }
    if (
      normalState.status !== 'synthetic-opened'
      || !normalState.selected
      || normalState.events.length !== 1
      || normalState.events[0].trusted !== false
    ) {
      throw new Error(`working synthetic click path regressed or double-activated: ${JSON.stringify(normalState)}`);
    }
    if (dispatched.length !== dispatchCountBeforeNormal) {
      throw new Error('working synthetic target unexpectedly received a trusted second click');
    }

    const dispatchCountBeforeDisclosure = dispatched.length;
    const disclosureResult = await agent.executeTool(42, 'click_ax', { ref_id: disclosureMatch[1] });
    const disclosureOpen = await page.evaluate(() => document.getElementById('native-details').open);
    if (
      disclosureResult?.success !== true
      || disclosureResult.trusted !== false
      || !/native\/button-like/.test(disclosureResult.fallbackSkipped || '')
    ) {
      throw new Error(`native disclosure did not stay on its synthetic-only path: ${JSON.stringify(disclosureResult)}`);
    }
    if (!disclosureOpen) {
      throw new Error('synthetic summary click should open the native disclosure exactly once');
    }
    if (dispatched.length !== dispatchCountBeforeDisclosure) {
      throw new Error('native disclosure unexpectedly received a trusted second click');
    }
  } finally {
    cdpClient.attach = originals.attach;
    cdpClient.evaluate = originals.evaluate;
    cdpClient.dispatchMouseEvent = originals.dispatch;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    await session.detach();
  }
});

test('set_checked: Agent.executeTool uses one trusted selector click and then becomes idempotent', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 30000 });
  const match = String(tree?.pageContent || '').match(/checkbox "Trusted Firefox compatibility" \[(ref_\d+)\][^\n]*checked=false/);
  if (!match) throw new Error(`expected trusted checkbox ref in AX tree: ${tree?.pageContent}`);

  const originalChrome = globalThis.chrome;
  const originalAttach = cdpClient.attach;
  const originalClickElement = cdpClient.clickElement;
  try {
    globalThis.chrome = {
      runtime: {},
      tabs: {
        async get(tabId) {
          return { id: tabId, url: page.url(), title: 'Trusted checkbox fixture' };
        },
        async query() {
          return [{ id: 42, url: page.url() }];
        },
        async sendMessage(_tabId, message) {
          return call(page, message.action, message.params || {});
        },
      },
    };
    let trustedClicks = 0;
    cdpClient.attach = async () => ({ attached: true });
    cdpClient.clickElement = async (_tabId, selector, options) => {
      if (options?.trustedOnly !== true || options?.requireUnique !== true) {
        throw new Error(`expected trusted-only checkbox click, got: ${JSON.stringify(options)}`);
      }
      trustedClicks += 1;
      const locator = page.locator(selector);
      const box = await locator.boundingBox();
      await locator.click();
      return {
        success: true,
        method: 'cdp-mouse',
        rect: box ? {
          x: Math.round(box.x),
          y: Math.round(box.y),
          w: Math.round(box.width),
          h: Math.round(box.height),
        } : undefined,
      };
    };

    const agent = new Agent({});
    agent._isPdfTab = async () => false;
    agent._currentUrl = async () => page.url();
    const first = await agent.executeTool(42, 'set_checked', { ref_id: match[1], checked: true });
    const eventsAfterFirst = await page.evaluate(() => window.__trustedCheckboxEvents);
    if (
      first?.success !== true
      || first.trusted !== true
      || first.verified !== true
      || first.checkedBefore !== false
      || first.checkedAfter !== true
      || first.changed !== true
      || first.idempotent !== false
      || trustedClicks !== 1
      || eventsAfterFirst.length !== 1
      || eventsAfterFirst[0].trusted !== true
    ) {
      throw new Error(`trusted set_checked transition failed: ${JSON.stringify({ first, trustedClicks, eventsAfterFirst })}`);
    }

    const second = await agent.executeTool(42, 'set_checked', { ref_id: match[1], checked: true });
    if (
      second?.success !== true
      || second.idempotent !== true
      || second.dispatched !== false
      || second.checkedAfter !== true
      || trustedClicks !== 1
    ) {
      throw new Error(`idempotent set_checked repeated a click: ${JSON.stringify({ second, trustedClicks })}`);
    }
  } finally {
    cdpClient.attach = originalAttach;
    cdpClient.clickElement = originalClickElement;
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('ax_resolve_rect: trusted fallback eligibility rejects interactive descendants, hidden, mutating, stateful, native, form, and download targets', async (page) => {
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
  const content = String(tree?.pageContent || '');
  const refs = {
    nestedButton: content.match(/listitem "Nested button row" \[(ref_\d+)\]/)?.[1],
    nestedLink: content.match(/listitem "Nested link row" \[(ref_\d+)\]/)?.[1],
    nestedInput: content.match(/listitem "Nested input row" \[(ref_\d+)\]/)?.[1],
    native: content.match(/button "Native button" \[(ref_\d+)\]/)?.[1],
    disclosure: content.match(/"Native disclosure" \[(ref_\d+)\]/)?.[1],
    destructive: content.match(/listitem "Delete account" \[(ref_\d+)\]/)?.[1],
    sendMessage: content.match(/listitem "Send message" \[(ref_\d+)\]/)?.[1],
    orderLunch: content.match(/listitem "Order lunch" \[(ref_\d+)\]/)?.[1],
    bookNow: content.match(/listitem "Book now" \[(ref_\d+)\]/)?.[1],
    indirectDestructive: content.match(/listitem "Delete account indirectly" \[(ref_\d+)\]/)?.[1],
    localizedDestructive: content.match(/listitem "Hesabı sil" \[(ref_\d+)\]/)?.[1],
    statefulRole: content.match(/treeitem "Expandable row" \[(ref_\d+)\]/)?.[1],
    statefulAttribute: content.match(/listitem "Stateful list row" \[(ref_\d+)\]/)?.[1],
    input: content.match(/textbox "Native input" \[(ref_\d+)\]/)?.[1],
    select: content.match(/combobox "Native select" \[(ref_\d+)\]/)?.[1],
    editable: content.match(/textbox "Editable row" \[(ref_\d+)\]/)?.[1],
    download: content.match(/listitem "Export report" \[(ref_\d+)\]/)?.[1],
    form: content.match(/listitem "Form row" \[(ref_\d+)\]/)?.[1],
    covered: content.match(/listitem "Covered row" \[(ref_\d+)\]/)?.[1],
    opacity: content.match(/listitem "Opacity row" \[(ref_\d+)\]/)?.[1],
    pointer: content.match(/listitem "Pointer disabled row" \[(ref_\d+)\]/)?.[1],
    zero: content.match(/listitem "Zero row" \[(ref_\d+)\]/)?.[1],
  };
  const safeRefs = {
    tabindexNegative: content.match(/listitem "Generic row with tabindex minus one wrapper" \[(ref_\d+)\]/)?.[1],
    tabindexZero: content.match(/listitem "Generic row with tabindex zero wrapper" \[(ref_\d+)\]/)?.[1],
    dataAction: content.match(/listitem "Generic data action row" \[(ref_\d+)\]/)?.[1],
    properName: content.match(/listitem "Post Malone" \[(ref_\d+)\]/)?.[1],
  };
  await page.evaluate(() => {
    document.getElementById('opacity-row').style.opacity = '0';
  });
  for (const [label, ref] of Object.entries(refs)) {
    if (!ref) throw new Error(`missing ${label} ref in AX tree: ${content}`);
    const result = await call(page, 'ax_resolve_rect', { ref_id: ref, forClickFallback: true });
    if (!result?.success) throw new Error(`${label} ref did not resolve: ${JSON.stringify(result)}`);
    if (result.fallbackEligible !== false || !result.fallbackBlockedReason) {
      throw new Error(`${label} target should be blocked from trusted fallback: ${JSON.stringify(result)}`);
    }
  }
  for (const [label, ref] of Object.entries(safeRefs)) {
    if (!ref) throw new Error(`missing ${label} ref in AX tree: ${content}`);
    const result = await call(page, 'ax_resolve_rect', { ref_id: ref, forClickFallback: true });
    if (!result?.success || result.fallbackEligible !== true || result.fallbackBlockedReason) {
      throw new Error(`${label} generic row should remain eligible for trusted fallback: ${JSON.stringify(result)}`);
    }
  }
  for (const label of ['nestedButton', 'nestedLink', 'nestedInput']) {
    const result = await call(page, 'ax_resolve_rect', { ref_id: refs[label], forClickFallback: true });
    if (!/interactive descendant/.test(result.fallbackBlockedReason || '')) {
      throw new Error(`${label} should be blocked specifically by its interactive center descendant: ${JSON.stringify(result)}`);
    }
    if (!result.interactiveDescendantTag) {
      throw new Error(`${label} should report the interactive descendant tag: ${JSON.stringify(result)}`);
    }
  }

  const ordinaryResolve = await call(page, 'ax_resolve_rect', { ref_id: refs.destructive });
  if (
    ordinaryResolve.fallbackEligible !== undefined
    || ordinaryResolve.fallbackState !== undefined
    || ordinaryResolve.fallbackStrongState !== undefined
    || ordinaryResolve.fallbackWeakState !== undefined
    || ordinaryResolve.documentToken !== undefined
  ) {
    throw new Error(`fallback-only metadata leaked into ordinary ref resolution: ${JSON.stringify(ordinaryResolve)}`);
  }
});

test('ax_resolve_rect: English action labels stay blocked under Turkish locale casing', async (page) => {
  await page.addInitScript(() => {
    const original = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function (...locales) {
      return original.apply(this, locales.length ? locales : ['tr-TR']);
    };
  });
  await setup(page, 'trusted-click-fallback.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'all', maxDepth: 10, maxChars: 20000 });
  const content = String(tree?.pageContent || '');
  const refs = {
    install: content.match(/listitem "Install app" \[(ref_\d+)\]/)?.[1],
    invite: content.match(/listitem "Invite teammate" \[(ref_\d+)\]/)?.[1],
  };
  for (const [label, ref] of Object.entries(refs)) {
    if (!ref) throw new Error(`missing ${label} ref in Turkish-locale AX tree: ${content}`);
    const result = await call(page, 'ax_resolve_rect', { ref_id: ref, forClickFallback: true });
    if (
      result?.fallbackEligible !== false
      || !/potentially mutating/.test(result.fallbackBlockedReason || '')
    ) {
      throw new Error(`${label} must remain blocked regardless of default locale casing: ${JSON.stringify(result)}`);
    }
  }
});

// ─── click_ax same-page anchors ─────────────────────────────────────────────
test('click_ax: same-page anchor reports hash and scroll completion', async (page) => {
  await setup(page, 'anchor-click.html');
  const before = await page.evaluate(() => ({ hash: location.hash, scrollY: window.scrollY }));
  if (before.hash !== '') throw new Error(`expected no initial hash, got ${before.hash}`);

  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "References" \[(ref_\d+)\] href="#References"/);
  if (!match) throw new Error(`could not find References link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#References') throw new Error(`expected href #References, got ${resp.href}`);
  if (resp.sameDocumentAnchor !== true) throw new Error(`expected sameDocumentAnchor:true, got ${JSON.stringify(resp)}`);
  if (resp.anchorTarget !== '#References') throw new Error(`expected anchorTarget #References, got ${resp.anchorTarget}`);
  if (!resp.afterUrl || !resp.afterUrl.endsWith('#References')) throw new Error(`expected afterUrl to end with #References, got ${resp.afterUrl}`);
  if (resp.scrollChanged !== true) throw new Error(`expected scrollChanged:true, got ${JSON.stringify(resp)}`);
  if (!(resp.afterScrollY > resp.beforeScrollY)) throw new Error(`expected afterScrollY > beforeScrollY, got ${JSON.stringify(resp)}`);
  if (!/Same-page anchor click completed/i.test(resp.hint || '')) throw new Error(`missing completion hint: ${resp.hint}`);

  const after = await page.evaluate(() => ({ hash: location.hash, scrollY: window.scrollY }));
  if (after.hash !== '#References') throw new Error(`expected page hash #References, got ${after.hash}`);
  if (!(after.scrollY > before.scrollY)) throw new Error(`expected page to scroll, before=${before.scrollY} after=${after.scrollY}`);
});

test('click_ax: base href fragment uses resolved anchor destination', async (page) => {
  await setup(page, 'anchor-base-click.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "References" \[(ref_\d+)\] href="#References"/);
  if (!match) throw new Error(`could not find References link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#References') throw new Error(`expected raw href #References, got ${resp.href}`);
  if (resp.resolvedHref !== 'https://example.com/docs/#References') throw new Error(`expected resolvedHref to honor <base>, got ${resp.resolvedHref}`);
  if (resp.targetUrl !== 'https://example.com/docs/#References') throw new Error(`expected targetUrl to honor <base>, got ${resp.targetUrl}`);
  if (resp.sameDocumentAnchor === true) throw new Error(`base-resolved off-document href must not be sameDocumentAnchor: ${JSON.stringify(resp)}`);
  if (resp.navigates !== true) throw new Error(`expected navigates:true, got ${JSON.stringify(resp)}`);
});

test('click_ax: placeholder popup anchor keeps popup guidance', async (page) => {
  await setup(page, 'anchor-popup-click.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "Options" \[(ref_\d+)\] href="#"/);
  if (!match) throw new Error(`could not find Options link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#') throw new Error(`expected href #, got ${resp.href}`);
  if (resp.sameDocumentAnchor === true) throw new Error(`placeholder href must not be sameDocumentAnchor: ${JSON.stringify(resp)}`);
  if (resp.opened_popup_likely !== true) throw new Error(`expected opened_popup_likely:true, got ${JSON.stringify(resp)}`);
  if (!/popup-opener/i.test(resp.hint || '')) throw new Error(`expected popup guidance, got: ${resp.hint}`);
  if (/Same-page anchor click completed/i.test(resp.hint || '')) throw new Error(`placeholder popup used same-page anchor hint: ${resp.hint}`);

  const opened = await page.evaluate(() => window.__menuOpened);
  if (opened !== true) throw new Error('expected click handler to run');
});

test('click_ax: hash popup anchor keeps popup guidance', async (page) => {
  await setup(page, 'anchor-popup-click.html');
  const tree = await call(page, 'get_accessibility_tree', { filter: 'visible', maxDepth: 8 });
  const match = String(tree?.pageContent || '').match(/link "More" \[(ref_\d+)\] href="#menu"/);
  if (!match) throw new Error(`could not find More link in tree: ${tree?.pageContent}`);

  const resp = await call(page, 'click_ax', { ref_id: match[1] });
  if (!resp?.success) throw new Error(`expected click_ax success, got: ${JSON.stringify(resp)}`);
  if (resp.href !== '#menu') throw new Error(`expected href #menu, got ${resp.href}`);
  if (resp.sameDocumentAnchor === true) throw new Error(`popup href must not be sameDocumentAnchor: ${JSON.stringify(resp)}`);
  if (resp.opened_popup_likely !== true) throw new Error(`expected opened_popup_likely:true, got ${JSON.stringify(resp)}`);
  if (!/popup-opener/i.test(resp.hint || '')) throw new Error(`expected popup guidance, got: ${resp.hint}`);
  if (/Same-page anchor/i.test(resp.hint || '')) throw new Error(`hash popup used same-page anchor hint: ${resp.hint}`);

  const opened = await page.evaluate(() => window.__hashMenuOpened);
  if (opened !== true) throw new Error('expected hash popup click handler to run');
});

// ─── Firefox index/focus parity ───────────────────────────────────────────
test('Firefox: click({index}) matches full interactive ordering and preserves type focus', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #late { position: absolute; left: 20px; top: 180px; width: 120px; height: 40px; }
      #search { position: absolute; left: 20px; top: 20px; width: 240px; height: 40px; }
    </style>
    <button id="late" onclick="window.__clicked='late'">Later button</button>
    <input id="search" role="combobox" placeholder="Search">`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements?.[0]?.id !== 'search') {
    throw new Error(`expected visually first element to be search input, got: ${JSON.stringify(elements?.[0])}`);
  }

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`expected click success, got: ${JSON.stringify(click)}`);
  if (click.tag !== 'INPUT') throw new Error(`expected click index 0 to hit INPUT, got: ${JSON.stringify(click)}`);

  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'search') throw new Error(`expected search input focus after click, got: ${activeId}`);

  const typed = await call(page, 'type', { text: 'mchiang0610' });
  if (!typed?.success) throw new Error(`expected type success, got: ${JSON.stringify(typed)}`);

  const value = await page.evaluate(() => document.getElementById('search').value);
  if (value !== 'mchiang0610') throw new Error(`expected typed value, got: ${value}`);
});

test('Firefox: indexed shadow-DOM click passes occlusion hit test', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #host { position: absolute; left: 20px; top: 20px; width: 180px; height: 44px; }
      #late { position: absolute; left: 20px; top: 160px; width: 120px; height: 40px; }
    </style>
    <div id="host"></div>
    <button id="late">Later button</button>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<style>button { width: 180px; height: 44px; }</style><button id="shadow-button">Shadow Action</button>';
      root.getElementById('shadow-button').addEventListener('click', () => { window.__shadowClicked = true; });
    </script>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const shadowIndex = elements.findIndex(e => e.text === 'Shadow Action');
  if (shadowIndex < 0) throw new Error(`expected shadow button in elements, got: ${JSON.stringify(elements)}`);
  if (elements[shadowIndex].inShadowDOM !== true) {
    throw new Error(`expected inShadowDOM:true, got: ${JSON.stringify(elements[shadowIndex])}`);
  }

  const click = await call(page, 'click', { index: shadowIndex });
  if (!click?.success) throw new Error(`expected shadow click success, got: ${JSON.stringify(click)}`);
  if (click.occluded) throw new Error(`shadow click should not be reported occluded: ${JSON.stringify(click)}`);

  const clicked = await page.evaluate(() => window.__shadowClicked === true);
  if (!clicked) throw new Error('expected shadow button click handler to run');
});

test('Firefox: click-then-type preserves shadow-root input focus', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #host { position: absolute; left: 20px; top: 20px; width: 220px; height: 44px; }
    </style>
    <div id="host"></div>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' });
      root.innerHTML = '<style>input { width: 220px; height: 44px; box-sizing: border-box; }</style><input id="shadow-input" placeholder="Shadow Name">';
    </script>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const shadowIndex = elements.findIndex(e => e.id === 'shadow-input');
  if (shadowIndex < 0) throw new Error(`expected shadow input in elements, got: ${JSON.stringify(elements)}`);
  if (elements[shadowIndex].inShadowDOM !== true) {
    throw new Error(`expected inShadowDOM:true, got: ${JSON.stringify(elements[shadowIndex])}`);
  }

  const click = await call(page, 'click', { index: shadowIndex });
  if (!click?.success) throw new Error(`expected shadow input click success, got: ${JSON.stringify(click)}`);

  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'host') throw new Error(`expected document focus on shadow host, got: ${activeId}`);

  const typed = await call(page, 'type', { text: 'Ada' });
  if (!typed?.success) throw new Error(`expected shadow input type success, got: ${JSON.stringify(typed)}`);

  const value = await page.evaluate(() => document.getElementById('host').shadowRoot.getElementById('shadow-input').value);
  if (value !== 'Ada') throw new Error(`expected typed shadow value, got: ${value}`);
});

test('Firefox: type_text returns an error after focus moves to a noneditable element', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #field { position: absolute; left: 20px; top: 20px; width: 220px; height: 40px; }
      #opener { position: absolute; left: 20px; top: 90px; width: 140px; height: 40px; }
    </style>
    <input id="field" placeholder="Name">
    <button id="opener">Open menu</button>`);

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`expected input click success, got: ${JSON.stringify(click)}`);

  const typed = await call(page, 'type', { text: 'Ada' });
  if (!typed?.success) throw new Error(`expected first type success, got: ${JSON.stringify(typed)}`);

  await page.evaluate(() => document.getElementById('opener').focus());
  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'opener') throw new Error(`expected opener focus, got: ${activeId}`);

  const staleType = await call(page, 'type', { text: ' Lovelace' });
  if (staleType?.success) throw new Error(`expected type failure after button focus, got: ${JSON.stringify(staleType)}`);
  if (!/Focused element <button> is not an editable field/.test(staleType?.error || '')) {
    throw new Error(`expected focused button error, got: ${JSON.stringify(staleType)}`);
  }

  const value = await page.evaluate(() => document.getElementById('field').value);
  if (value !== 'Ada') throw new Error(`expected stale fallback not to mutate input, got: ${value}`);
});

async function assertFullIndexedElementsExcludeModalBackground(page, browserKind) {
  const label = browserKind === 'chrome' ? 'Chrome' : 'Firefox';
  const setupHtml = browserKind === 'chrome' ? setupChromeHtml : setupFirefoxHtml;
  await setupHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #background { position: absolute; left: 20px; top: 20px; }
      #dialog { position: absolute; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      button { width: 160px; height: 40px; }
    </style>
    <main id="background" aria-hidden="true">
      <button id="background-action" onclick="window.__backgroundClicked = true">Publish</button>
    </main>
    <section id="disabled-zone" inert>
      <button id="inert-action" onclick="window.__inertClicked = true">Archive</button>
    </section>
    <div id="dialog" role="dialog" aria-modal="true">
      <button id="dialog-action" onclick="window.__dialogClicked = true">Create</button>
    </div>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements.some(e => e.id === 'background-action' || e.id === 'inert-action')) {
    throw new Error(`${label}: expected hidden/inert background controls to be filtered, got: ${JSON.stringify(elements)}`);
  }
  if (elements?.[0]?.id !== 'dialog-action') {
    throw new Error(`${label}: expected dialog action to be first actionable index, got: ${JSON.stringify(elements?.[0])}`);
  }

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`${label}: expected dialog click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    dialog: window.__dialogClicked === true,
    background: window.__backgroundClicked === true,
    inert: window.__inertClicked === true,
  }));
  if (!state.dialog || state.background || state.inert) {
    throw new Error(`${label}: expected only dialog action to run, got: ${JSON.stringify(state)}`);
  }
}

test('Chrome: full indexed elements exclude inert background controls', async (page) => {
  await assertFullIndexedElementsExcludeModalBackground(page, 'chrome');
});

test('Firefox: full indexed elements exclude inert background controls', async (page) => {
  await assertFullIndexedElementsExcludeModalBackground(page, 'firefox');
});

test('Firefox: blocking overlay resolves sibling dialog content for indexed controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .35); }
      #dialog-panel { position: fixed; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #dialog-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <div id="backdrop" data-overlay></div>
    <section id="dialog-panel" role="dialog">
      <button id="dialog-action" onclick="window.__dialogClicked = true">Confirm</button>
    </section>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements.some(e => e.id === 'page-action')) {
    throw new Error(`expected page action to be filtered behind overlay, got: ${JSON.stringify(elements)}`);
  }
  const dialogIndex = elements.findIndex(e => e.id === 'dialog-action');
  if (dialogIndex < 0) throw new Error(`expected sibling dialog action in elements, got: ${JSON.stringify(elements)}`);

  const click = await call(page, 'click', { index: dialogIndex });
  if (!click?.success) throw new Error(`expected dialog action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    dialog: window.__dialogClicked === true,
  }));
  if (state.page || !state.dialog) {
    throw new Error(`expected only dialog action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: non-modal dialogs do not hide full indexed page controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #help-widget { position: absolute; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #help-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <aside id="help-widget" role="dialog" aria-label="Help">
      <button id="help-action" onclick="window.__helpClicked = true">Open help</button>
    </aside>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const pageIndex = elements.findIndex(e => e.id === 'page-action');
  const helpIndex = elements.findIndex(e => e.id === 'help-action');
  if (pageIndex < 0 || helpIndex < 0) {
    throw new Error(`expected page and non-modal dialog controls in elements, got: ${JSON.stringify(elements)}`);
  }

  const click = await call(page, 'click', { index: pageIndex });
  if (!click?.success) throw new Error(`expected page action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    help: window.__helpClicked === true,
  }));
  if (!state.page || state.help) {
    throw new Error(`expected only page action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: native non-modal dialog does not hide full indexed page controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #native-help { position: absolute; left: 20px; top: 90px; width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #help-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <dialog id="native-help" open>
      <button id="help-action" onclick="window.__helpClicked = true">Open help</button>
    </dialog>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const pageIndex = elements.findIndex(e => e.id === 'page-action');
  const helpIndex = elements.findIndex(e => e.id === 'help-action');
  if (pageIndex < 0 || helpIndex < 0) {
    throw new Error(`expected page and native non-modal dialog controls in elements, got: ${JSON.stringify(elements)}`);
  }

  const click = await call(page, 'click', { index: pageIndex });
  if (!click?.success) throw new Error(`expected page action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    help: window.__helpClicked === true,
  }));
  if (!state.page || state.help) {
    throw new Error(`expected only page action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: native modal dialog scopes full indexed page controls', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #page-action { position: absolute; left: 20px; top: 20px; width: 160px; height: 40px; }
      #native-modal { width: 220px; padding: 16px; border: 1px solid #888; background: white; }
      #modal-action { width: 160px; height: 40px; }
    </style>
    <button id="page-action" onclick="window.__pageClicked = true">Save page</button>
    <dialog id="native-modal">
      <button id="modal-action" onclick="window.__modalClicked = true">Confirm</button>
    </dialog>
    <script>document.getElementById('native-modal').showModal();</script>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  if (elements.some(e => e.id === 'page-action')) {
    throw new Error(`expected page action to be filtered behind native modal, got: ${JSON.stringify(elements)}`);
  }
  if (elements?.[0]?.id !== 'modal-action') {
    throw new Error(`expected modal action to be first actionable index, got: ${JSON.stringify(elements?.[0])}`);
  }

  const click = await call(page, 'click', { index: 0 });
  if (!click?.success) throw new Error(`expected modal action click success, got: ${JSON.stringify(click)}`);

  const state = await page.evaluate(() => ({
    page: window.__pageClicked === true,
    modal: window.__modalClicked === true,
  }));
  if (state.page || !state.modal) {
    throw new Error(`expected only modal action to run, got: ${JSON.stringify(state)}`);
  }
});

test('Firefox: type_text rejects non-text input after it receives focus', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #field { position: absolute; left: 20px; top: 20px; width: 220px; height: 40px; }
      #button-input { position: absolute; left: 20px; top: 90px; width: 140px; height: 40px; }
    </style>
    <input id="field" placeholder="Name">
    <input id="button-input" type="button" value="Open" onclick="window.__buttonInputClicked = true">`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const fieldIndex = elements.findIndex(e => e.id === 'field');
  const buttonIndex = elements.findIndex(e => e.id === 'button-input');
  if (fieldIndex < 0 || buttonIndex < 0) throw new Error(`expected both controls in elements, got: ${JSON.stringify(elements)}`);

  const fieldClick = await call(page, 'click', { index: fieldIndex });
  if (!fieldClick?.success) throw new Error(`expected field click success, got: ${JSON.stringify(fieldClick)}`);

  const typed = await call(page, 'type', { text: 'Ada' });
  if (!typed?.success) throw new Error(`expected field type success, got: ${JSON.stringify(typed)}`);

  const buttonClick = await call(page, 'click', { index: buttonIndex });
  if (!buttonClick?.success) throw new Error(`expected button input click success, got: ${JSON.stringify(buttonClick)}`);

  const activeId = await page.evaluate(() => document.activeElement?.id || '');
  if (activeId !== 'button-input') throw new Error(`expected button input focus, got: ${activeId}`);

  const rejected = await call(page, 'type', { text: ' Lovelace' });
  if (rejected?.success) throw new Error(`expected non-text input type failure, got: ${JSON.stringify(rejected)}`);
  if (!/Focused element <input> is not an editable field/.test(rejected?.error || '')) {
    throw new Error(`expected focused input error, got: ${JSON.stringify(rejected)}`);
  }

  const values = await page.evaluate(() => ({
    field: document.getElementById('field').value,
    button: document.getElementById('button-input').value,
    clicked: window.__buttonInputClicked === true,
  }));
  if (values.field !== 'Ada' || values.button !== 'Open' || !values.clicked) {
    throw new Error(`expected no stale/non-text value mutation, got: ${JSON.stringify(values)}`);
  }
});

test('Firefox: type_text rejects disabled indexed text input fallback', async (page) => {
  await setupFirefoxHtml(page, `<!doctype html>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      #disabled-field { position: absolute; left: 20px; top: 20px; width: 220px; height: 40px; }
    </style>
    <input id="disabled-field" value="Locked" disabled>`);

  const elements = await call(page, 'get_interactive_elements_cdp', {});
  const disabledIndex = elements.findIndex(e => e.id === 'disabled-field');
  if (disabledIndex < 0) throw new Error(`expected disabled field in elements, got: ${JSON.stringify(elements)}`);

  const click = await call(page, 'click', { index: disabledIndex });
  if (!click?.success) throw new Error(`expected disabled field click path to complete, got: ${JSON.stringify(click)}`);

  const activeTag = await page.evaluate(() => document.activeElement?.tagName || '');
  if (activeTag === 'INPUT') throw new Error('disabled input should not receive focus');

  const rejected = await call(page, 'type', { text: ' hacked' });
  if (rejected?.success) throw new Error(`expected disabled input type failure, got: ${JSON.stringify(rejected)}`);

  const value = await page.evaluate(() => document.getElementById('disabled-field').value);
  if (value !== 'Locked') throw new Error(`expected disabled value to remain unchanged, got: ${value}`);
});

for (const browserKind of ['chrome', 'firefox']) {
  test(`${browserKind}: compact native composer stays outside rich-text toolbar audit`, async (page) => {
    await setupContentHtml(page, `<!doctype html>
      <div style="display:flex;align-items:center;gap:6px;width:320px;height:44px">
        <input id="native-composer" type="text" style="width:190px;height:28px">
        <button type="button">Send</button>
      </div>`, browserKind);
    await page.focus('#native-composer');
    const probe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'type_text',
      args: { text: 'Quarterly roadmap' },
    });
    if (
      !probe?.resolved
      || probe.fieldMeta?.type !== 'text'
      || probe.fieldMeta?.toolbarCandidate
    ) {
      throw new Error(`compact native composer must stay outside formatting audit: ${JSON.stringify(probe)}`);
    }
  });

  test(`${browserKind}: rich-text toolbar metadata covers labelled controls and excludes labelled ordinary fields`, async (page) => {
    await setupContentFixture(page, 'rich-text-toolbar-target.html', browserKind);

    const refs = await page.evaluate(() => {
      const shadowHost = document.createElement('div');
      shadowHost.id = 'shadow-toolbar-host';
      const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
      shadowRoot.innerHTML = `
        <span id="shadow-quantity-label">Shadow quantity</span>
        <input id="shadow-labelled-size" aria-labelledby="shadow-quantity-label" value="11"
          style="width:34px;height:22px">
        <label for="shadow-explicit-size">Shadow explicit quantity</label>
        <input id="shadow-explicit-size" value="11" style="width:34px;height:22px">
        <div role="toolbar">
          <input id="shadow-family-input" value="Default" aria-controls="shadow-family-presets"
            style="width:118px;height:22px">
          <div id="shadow-family-presets" role="listbox">
            <div role="option">Roboto</div>
            <div role="option">Noto Sans</div>
          </div>
          <button type="button">B</button>
        </div>`;
      document.body.appendChild(shadowHost);

      const composedEditor = document.createElement('div');
      composedEditor.className = 'editor';
      composedEditor.innerHTML = `
        <div id="composed-toolbar" class="toolbar" role="toolbar"></div>
        <div id="composed-editor-body" class="body" contenteditable="true">Enter text</div>`;
      const composedHost = document.createElement('span');
      composedHost.id = 'composed-family-host';
      const composedRoot = composedHost.attachShadow({ mode: 'open' });
      composedRoot.innerHTML = `
        <input id="composed-family-input" value="Default" aria-controls="composed-family-presets"
          style="width:118px;height:22px">
        <div id="composed-family-presets" role="listbox">
          <div role="option">Roboto</div>
          <div role="option">Noto Sans</div>
        </div>`;
      composedEditor.querySelector('#composed-toolbar').appendChild(composedHost);
      const composedSiblingHost = document.createElement('span');
      composedSiblingHost.id = 'composed-sibling-host';
      const composedSiblingRoot = composedSiblingHost.attachShadow({ mode: 'open' });
      composedSiblingRoot.innerHTML = '<button id="composed-shadow-bold" type="button">B</button>';
      composedEditor.querySelector('#composed-toolbar').appendChild(composedSiblingHost);
      document.body.appendChild(composedEditor);

      const shadowToolbarEditor = document.createElement('div');
      shadowToolbarEditor.className = 'editor';
      const shadowToolbarHost = document.createElement('div');
      shadowToolbarHost.id = 'shadow-toolbar-component';
      const shadowToolbarRoot = shadowToolbarHost.attachShadow({ mode: 'open' });
      shadowToolbarRoot.innerHTML = `
        <div role="toolbar" style="height:42px;display:flex;align-items:center">
          <input id="shadow-toolbar-family-input" aria-label="Font family" value="Default" style="width:118px;height:22px">
        </div>`;
      shadowToolbarEditor.appendChild(shadowToolbarHost);
      const shadowToolbarBody = document.createElement('div');
      shadowToolbarBody.id = 'shadow-toolbar-editor-body';
      shadowToolbarBody.className = 'body';
      shadowToolbarBody.contentEditable = 'true';
      shadowToolbarBody.textContent = 'Enter text';
      shadowToolbarEditor.appendChild(shadowToolbarBody);
      document.body.appendChild(shadowToolbarEditor);

      const descendantShadowEditor = document.createElement('div');
      descendantShadowEditor.className = 'editor';
      descendantShadowEditor.innerHTML = `
        <div role="toolbar" style="height:42px;display:flex;align-items:center">
          <input id="descendant-shadow-family-input" type="text" aria-label="Font family" value="Default"
            style="width:118px;height:22px">
          <input id="descendant-toolbar-search" type="search" aria-label="Search links" value=""
            style="width:118px;height:22px">
          <input id="descendant-toolbar-unlabelled-search" type="search" value=""
            style="width:118px;height:22px">
          <input id="descendant-toolbar-filter" type="text" aria-label="Filter" value=""
            style="width:118px;height:22px">
        </div>`;
      const descendantBodyHost = document.createElement('div');
      descendantBodyHost.id = 'descendant-editor-component';
      descendantBodyHost.attachShadow({ mode: 'open' }).innerHTML = `
        <div id="descendant-shadow-editor-body" role="textbox" contenteditable="true"
          style="width:400px;height:180px">Enter text</div>`;
      descendantShadowEditor.appendChild(descendantBodyHost);
      document.body.appendChild(descendantShadowEditor);

      const compactComposer = document.createElement('div');
      compactComposer.style.cssText = 'display:flex;align-items:center;gap:6px;width:320px;height:44px';
      compactComposer.innerHTML = `
        <div id="compact-composer-body" role="textbox" contenteditable="true"
          style="width:190px;height:28px">Draft reply</div>
        <button type="button">Emoji</button>
        <button type="button">Send</button>`;
      document.body.appendChild(compactComposer);

      const conventionalToolbarEditor = document.createElement('div');
      conventionalToolbarEditor.className = 'editor';
      conventionalToolbarEditor.innerHTML = `
        <div style="height:42px;display:flex;align-items:center;gap:6px">
          <button type="button">B</button>
          <input id="conventional-toolbar-family" aria-label="Font family" value="Default"
            style="width:118px;height:22px">
          <input id="conventional-text-color" aria-label="Text color" value="#111111"
            style="width:118px;height:22px">
          <button type="button">I</button>
        </div>
        <div id="conventional-toolbar-editor-body" contenteditable="true"
          style="width:400px;height:180px">Enter text</div>`;
      document.body.appendChild(conventionalToolbarEditor);

      const conventionalShadowEditor = document.createElement('div');
      conventionalShadowEditor.className = 'editor';
      conventionalShadowEditor.innerHTML = `
        <div style="height:42px;display:flex;align-items:center;gap:6px">
          <button type="button">B</button>
          <span id="conventional-shadow-family-host"></span>
        </div>
        <div id="conventional-shadow-editor-body" contenteditable="true"
          style="width:400px;height:180px">Enter text</div>`;
      const conventionalShadowRoot = conventionalShadowEditor
        .querySelector('#conventional-shadow-family-host')
        .attachShadow({ mode: 'open' });
      conventionalShadowRoot.innerHTML = `
        <input id="conventional-shadow-family" aria-label="Font family" value="Default"
          style="width:118px;height:22px">`;
      document.body.appendChild(conventionalShadowEditor);

      const slottedToolbarEditor = document.createElement('div');
      slottedToolbarEditor.className = 'editor';
      const slottedToolbarHost = document.createElement('div');
      slottedToolbarHost.id = 'slotted-toolbar-component';
      slottedToolbarHost.attachShadow({ mode: 'open' }).innerHTML = `
        <div role="toolbar" style="height:42px;display:flex;align-items:center">
          <slot></slot>
        </div>`;
      const slottedToolbarInput = document.createElement('input');
      slottedToolbarInput.id = 'slotted-toolbar-family-input';
      slottedToolbarInput.value = 'Default';
      slottedToolbarInput.style.cssText = 'width:118px;height:22px';
      slottedToolbarHost.appendChild(slottedToolbarInput);
      slottedToolbarEditor.appendChild(slottedToolbarHost);
      const slottedToolbarBody = document.createElement('div');
      slottedToolbarBody.id = 'slotted-toolbar-editor-body';
      slottedToolbarBody.className = 'body';
      slottedToolbarBody.contentEditable = 'true';
      slottedToolbarBody.textContent = 'Enter text';
      slottedToolbarEditor.appendChild(slottedToolbarBody);
      document.body.appendChild(slottedToolbarEditor);

      const iframeBackedEditor = document.createElement('div');
      iframeBackedEditor.className = 'editor';
      iframeBackedEditor.innerHTML = `
        <div role="toolbar" style="height:42px;display:flex;align-items:center">
          <input id="iframe-toolbar-family-input" value="Default" style="width:118px;height:22px">
        </div>
        <iframe id="iframe-editor-body" style="width:400px;height:180px"
          srcdoc="<div id='inner-editor' contenteditable='true'>Enter text</div>"></iframe>`;
      document.body.appendChild(iframeBackedEditor);
      return {
        size: window.__wb_ax_ref(document.getElementById('font-size')),
        family: window.__wb_ax_ref(document.getElementById('font-family')),
        familyInput: window.__wb_ax_ref(document.getElementById('font-family-input')),
        editableFamily: window.__wb_ax_ref(document.getElementById('editable-font-family')),
        familyText: window.__wb_ax_ref(document.querySelector('#font-family span')),
        editor: window.__wb_ax_ref(document.getElementById('editor-body')),
        labelledBy: window.__wb_ax_ref(document.getElementById('labelled-by-size')),
        shadowLabelledBy: window.__wb_ax_ref(shadowRoot.getElementById('shadow-labelled-size')),
        shadowExplicitLabel: window.__wb_ax_ref(shadowRoot.getElementById('shadow-explicit-size')),
        shadowFamilyInput: window.__wb_ax_ref(shadowRoot.getElementById('shadow-family-input')),
        composedFamilyInput: window.__wb_ax_ref(composedRoot.getElementById('composed-family-input')),
        composedShadowBold: window.__wb_ax_ref(composedSiblingRoot.getElementById('composed-shadow-bold')),
        shadowToolbarFamilyInput: window.__wb_ax_ref(shadowToolbarRoot.getElementById('shadow-toolbar-family-input')),
        descendantShadowFamilyInput: window.__wb_ax_ref(descendantShadowEditor.querySelector('#descendant-shadow-family-input')),
        descendantToolbarSearch: window.__wb_ax_ref(descendantShadowEditor.querySelector('#descendant-toolbar-search')),
        descendantToolbarUnlabelledSearch: window.__wb_ax_ref(descendantShadowEditor.querySelector('#descendant-toolbar-unlabelled-search')),
        descendantToolbarFilter: window.__wb_ax_ref(descendantShadowEditor.querySelector('#descendant-toolbar-filter')),
        compactComposer: window.__wb_ax_ref(compactComposer.querySelector('#compact-composer-body')),
        conventionalToolbarFamily: window.__wb_ax_ref(conventionalToolbarEditor.querySelector('#conventional-toolbar-family')),
        conventionalTextColor: window.__wb_ax_ref(conventionalToolbarEditor.querySelector('#conventional-text-color')),
        conventionalShadowFamily: window.__wb_ax_ref(conventionalShadowRoot.getElementById('conventional-shadow-family')),
        slottedToolbarFamilyInput: window.__wb_ax_ref(slottedToolbarInput),
        iframeToolbarFamilyInput: window.__wb_ax_ref(iframeBackedEditor.querySelector('#iframe-toolbar-family-input')),
        title: window.__wb_ax_ref(document.getElementById('title-size')),
        linkUrl: window.__wb_ax_ref(document.getElementById('link-url')),
        paragraphStyle: window.__wb_ax_ref(document.getElementById('paragraph-style')),
        ordinary: window.__wb_ax_ref(document.getElementById('ordinary-size')),
        ordinaryStatus: window.__wb_ax_ref(document.getElementById('ordinary-status')),
        secondary: window.__wb_ax_ref(document.getElementById('secondary-notes')),
      };
    });

    await page.evaluate(() => {
      const target = document.getElementById('iframe-toolbar-family-input');
      target.closest('.editor').style.marginTop = '1400px';
      window.scrollTo({ top: 0, behavior: 'instant' });
      document.documentElement.style.scrollBehavior = 'smooth';
    });
    const smoothScrollProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.iframeToolbarFamilyInput, text: 'Roboto' },
    });
    const settledTarget = await page.evaluate(() => {
      const rect = document.getElementById('iframe-toolbar-family-input').getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      document.documentElement.style.scrollBehavior = 'auto';
      return {
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        viewportHeight,
      };
    });
    if (
      !smoothScrollProbe?.resolved
      || Math.abs(smoothScrollProbe.rect.y - settledTarget.rect.y) > 2
      || Math.abs(smoothScrollProbe.rect.pageX - (settledTarget.rect.x + settledTarget.scrollX)) > 2
      || Math.abs(smoothScrollProbe.rect.pageY - (settledTarget.rect.y + settledTarget.scrollY)) > 2
      || smoothScrollProbe.rect.y < 0
      || smoothScrollProbe.rect.y + smoothScrollProbe.rect.h > settledTarget.viewportHeight
    ) {
      throw new Error(`smooth-scroll toolbar probe must settle and re-measure the target: ${JSON.stringify({ smoothScrollProbe, settledTarget })}`);
    }

    const toolbar = await call(page, 'set_field', {
      ref_id: refs.size,
      text: '42',
      clear: true,
    });
    const candidate = toolbar?.fieldMeta?.toolbarCandidate;
    if (!candidate || candidate.score < 6) {
      throw new Error(`expected strong toolbar candidate, got: ${JSON.stringify(toolbar)}`);
    }
    if (toolbar.fieldMeta?.name !== 'fontSize') {
      throw new Error(`fixture must cover a named toolbar control, got: ${JSON.stringify(toolbar.fieldMeta)}`);
    }
    if (!candidate.reasons.includes('semantic_toolbar')) {
      throw new Error(`expected semantic toolbar evidence, got: ${JSON.stringify(candidate)}`);
    }
    if (!candidate.relatedRefs.includes(refs.family) && !candidate.relatedRefs.includes(refs.familyText)) {
      throw new Error(`expected font-family sibling ref in toolbar scope, got: ${JSON.stringify(candidate)}`);
    }
    if (candidate.associatedEditorRef !== refs.editor) {
      throw new Error(`expected exact associated editor ref, got: ${JSON.stringify(candidate)}`);
    }
    if (candidate.associatedEditorIdentity?.id !== 'editor-body' || candidate.associatedEditorIdentity?.tag !== 'div') {
      throw new Error(`expected stable associated editor identity, got: ${JSON.stringify(candidate)}`);
    }
    const familyProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.familyInput, text: 'Inter Display' },
    });
    const availableFamilies = familyProbe?.fieldMeta?.toolbarCandidate?.availablePresetValues || [];
    if (!availableFamilies.includes('Default') || !availableFamilies.includes('Inter Display') || !availableFamilies.includes('Times New Roman')) {
      throw new Error(`expected bounded control-owned font presets, got: ${JSON.stringify(familyProbe)}`);
    }
    const editableFamilyProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.editableFamily, text: 'Inter Display' },
    });
    if (
      !editableFamilyProbe?.resolved
      || editableFamilyProbe.fieldMeta?.contentEditable !== true
      || !editableFamilyProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
      || !editableFamilyProbe.fieldMeta.toolbarCandidate.reasons?.includes('formatting_control_label')
      || !editableFamilyProbe.fieldMeta.toolbarCandidate.availablePresetValues?.includes('Default')
      || editableFamilyProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'editor-body'
    ) {
      throw new Error(`contenteditable rich-text formatting control must enter the toolbar audit: ${JSON.stringify(editableFamilyProbe)}`);
    }
    const editorBodyProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.editor, text: 'Document prose' },
    });
    if (!editorBodyProbe?.resolved || editorBodyProbe.fieldMeta?.toolbarCandidate) {
      throw new Error(`rich-text editor body must not be classified as its own toolbar control: ${JSON.stringify(editorBodyProbe)}`);
    }
    const shadowFamilyProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.shadowFamilyInput, text: 'Roboto' },
    });
    const shadowAvailableFamilies = shadowFamilyProbe?.fieldMeta?.toolbarCandidate?.availablePresetValues || [];
    if (!shadowAvailableFamilies.includes('Default') || !shadowAvailableFamilies.includes('Roboto') || !shadowAvailableFamilies.includes('Noto Sans')) {
      throw new Error(`expected shadow-local aria-controls presets, got: ${JSON.stringify(shadowFamilyProbe)}`);
    }
    const composedFamilyProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.composedFamilyInput, text: 'Roboto' },
    });
    const composedCandidate = composedFamilyProbe?.fieldMeta?.toolbarCandidate;
    if (
      Number(composedCandidate?.score) < 4
      || !composedCandidate.reasons?.includes('semantic_toolbar')
      || composedCandidate.associatedEditorIdentity?.id !== 'composed-editor-body'
      || !composedCandidate.regionKey
      || !composedCandidate.relatedRefs?.includes(refs.composedShadowBold)
    ) {
      throw new Error(`expected toolbar ancestry through the input shadow host, got: ${JSON.stringify(composedFamilyProbe)}`);
    }
    const composedSiblingProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'click_ax',
      args: { ref_id: refs.composedShadowBold },
    });
    if (
      !composedSiblingProbe?.resolved
      || !composedSiblingProbe.toolbarContext
      || composedSiblingProbe.toolbarRegionKey !== composedCandidate.regionKey
    ) {
      throw new Error(`open-shadow toolbar siblings must share one stable region identity: ${JSON.stringify(composedSiblingProbe)}`);
    }
    const shadowToolbarProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.shadowToolbarFamilyInput, text: 'Roboto' },
    });
    if (
      !shadowToolbarProbe?.fieldMeta?.toolbarCandidate?.reasons?.includes('labelled_toolbar_control')
      || shadowToolbarProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'shadow-toolbar-editor-body'
    ) {
      throw new Error(`expected editor association through the toolbar shadow host, got: ${JSON.stringify(shadowToolbarProbe)}`);
    }
    const descendantShadowProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.descendantShadowFamilyInput, text: 'Roboto' },
    });
    if (
      !descendantShadowProbe?.fieldMeta?.toolbarCandidate?.reasons?.includes('labelled_toolbar_control')
      || descendantShadowProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'descendant-shadow-editor-body'
      || !descendantShadowProbe.fieldMeta.toolbarCandidate.associatedEditorRef
    ) {
      throw new Error(`expected descendant shadow editor association, got: ${JSON.stringify(descendantShadowProbe)}`);
    }
    const descendantSearchProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.descendantToolbarSearch, text: 'Quarterly roadmap' },
    });
    if (
      !descendantSearchProbe?.resolved
      || descendantSearchProbe.fieldMeta?.type !== 'search'
      || descendantSearchProbe.fieldMeta?.toolbarCandidate
    ) {
      throw new Error(`ordinary labelled toolbar search must stay outside formatting audit: ${JSON.stringify(descendantSearchProbe)}`);
    }
    const descendantUnlabelledSearchProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.descendantToolbarUnlabelledSearch, text: 'Quarterly roadmap' },
    });
    if (
      !descendantUnlabelledSearchProbe?.resolved
      || descendantUnlabelledSearchProbe.fieldMeta?.type !== 'search'
      || descendantUnlabelledSearchProbe.fieldMeta?.toolbarCandidate
    ) {
      throw new Error(`unlabelled native toolbar search must stay outside formatting audit: ${JSON.stringify(descendantUnlabelledSearchProbe)}`);
    }
    const descendantFilterProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.descendantToolbarFilter, text: 'Quarterly roadmap' },
    });
    if (
      !descendantFilterProbe?.resolved
      || descendantFilterProbe.fieldMeta?.type !== 'text'
      || descendantFilterProbe.fieldMeta?.toolbarCandidate
    ) {
      throw new Error(`ordinary labelled toolbar text filter must stay outside formatting audit: ${JSON.stringify(descendantFilterProbe)}`);
    }
    const compactComposerProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.compactComposer, text: 'Quarterly roadmap' },
    });
    if (
      !compactComposerProbe?.resolved
      || compactComposerProbe.fieldMeta?.contentEditable !== true
      || compactComposerProbe.fieldMeta?.toolbarCandidate
    ) {
      throw new Error(`compact contenteditable composer must stay outside formatting audit: ${JSON.stringify(compactComposerProbe)}`);
    }
    const conventionalToolbarProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.conventionalToolbarFamily, text: 'Inter Display' },
    });
    if (
      Number(conventionalToolbarProbe?.fieldMeta?.toolbarCandidate?.score) < 4
      || !conventionalToolbarProbe.fieldMeta.toolbarCandidate.reasons?.includes('formatting_control_label')
      || !conventionalToolbarProbe.fieldMeta.toolbarCandidate.reasons?.includes('dense_control_cluster')
      || conventionalToolbarProbe.fieldMeta.toolbarCandidate.reasons?.includes('semantic_toolbar')
      || conventionalToolbarProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'conventional-toolbar-editor-body'
    ) {
      throw new Error(`labelled formatting control in a conventional toolbar must enter the audit: ${JSON.stringify(conventionalToolbarProbe)}`);
    }
    const conventionalColorProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.conventionalTextColor, text: 'red' },
    });
    if (
      Number(conventionalColorProbe?.fieldMeta?.toolbarCandidate?.score) < 4
      || !conventionalColorProbe.fieldMeta.toolbarCandidate.reasons?.includes('formatting_control_label')
      || !conventionalColorProbe.fieldMeta.toolbarCandidate.reasons?.includes('dense_control_cluster')
      || conventionalColorProbe.fieldMeta.toolbarCandidate.reasons?.includes('semantic_toolbar')
      || conventionalColorProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'conventional-toolbar-editor-body'
    ) {
      throw new Error(`text-color control in a conventional toolbar must enter the audit: ${JSON.stringify(conventionalColorProbe)}`);
    }
    const conventionalShadowProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.conventionalShadowFamily, text: 'Inter Display' },
    });
    if (
      Number(conventionalShadowProbe?.fieldMeta?.toolbarCandidate?.score) < 4
      || !conventionalShadowProbe.fieldMeta.toolbarCandidate.reasons?.includes('formatting_control_label')
      || !conventionalShadowProbe.fieldMeta.toolbarCandidate.reasons?.includes('dense_control_cluster')
      || conventionalShadowProbe.fieldMeta.toolbarCandidate.reasons?.includes('semantic_toolbar')
      || conventionalShadowProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'conventional-shadow-editor-body'
    ) {
      throw new Error(`shadow-root target must count in its outer conventional toolbar: ${JSON.stringify(conventionalShadowProbe)}`);
    }
    const linkProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.linkUrl, text: 'https://openai.com' },
    });
    if (
      !linkProbe?.resolved
      || linkProbe.fieldMeta?.type !== 'url'
      || !linkProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('formatting_control_label')
      || linkProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'editor-body'
    ) {
      throw new Error(`URL-typed rich-text link control must enter the toolbar audit: ${JSON.stringify(linkProbe)}`);
    }
    const nativeStyleProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.paragraphStyle, text: 'Heading 1' },
    });
    if (
      !nativeStyleProbe?.resolved
      || nativeStyleProbe.fieldMeta?.type !== 'select'
      || !nativeStyleProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
      || !nativeStyleProbe.fieldMeta.toolbarCandidate.availablePresetValues?.includes('Heading 1')
      || nativeStyleProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'editor-body'
    ) {
      throw new Error(`native rich-text style select must enter the toolbar audit: ${JSON.stringify(nativeStyleProbe)}`);
    }
    const slottedToolbarProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.slottedToolbarFamilyInput, text: 'Roboto' },
    });
    if (
      !slottedToolbarProbe?.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
      || slottedToolbarProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'slotted-toolbar-editor-body'
    ) {
      throw new Error(`expected toolbar ancestry through the input assigned slot, got: ${JSON.stringify(slottedToolbarProbe)}`);
    }
    const iframeBackedProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.iframeToolbarFamilyInput, text: 'Roboto' },
    });
    if (
      iframeBackedProbe?.fieldMeta?.toolbarCandidate?.associatedEditorIdentity?.tag !== 'iframe'
      || iframeBackedProbe.fieldMeta.toolbarCandidate.associatedEditorIdentity?.id !== 'iframe-editor-body'
      || !iframeBackedProbe.fieldMeta.toolbarCandidate.associatedEditorRef
    ) {
      throw new Error(`expected adjacent iframe editor association, got: ${JSON.stringify(iframeBackedProbe)}`);
    }
    const focusedProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'type_text',
      args: { text: 'Paris' },
    });
    if (!focusedProbe?.resolved || focusedProbe.refId !== refs.size || !focusedProbe.selectorTargetToken || !focusedProbe.documentToken || !focusedProbe.refScopeUrl || !focusedProbe.toolbarContext || focusedProbe.toolbarRegionRef !== candidate.regionRef || focusedProbe.toolbarRegionKey !== candidate.regionKey || Number(focusedProbe.fieldMeta?.toolbarCandidate?.score) < 4) {
      throw new Error(`expected focused toolbar retry probe, got: ${JSON.stringify(focusedProbe)}`);
    }
    await page.evaluate(() => {
      document.querySelector('#shadow-toolbar-host').shadowRoot
        .querySelector('#shadow-family-input').focus();
    });
    const staleFocusedType = browserKind === 'chrome'
      ? await call(page, 'prepare_rich_text_toolbar_focused_type', {
          token: focusedProbe.selectorTargetToken,
          text: 'SHOULD_NOT_APPLY',
        })
      : await call(page, 'type', {
          text: 'SHOULD_NOT_APPLY',
          richTextToolbarTargetToken: focusedProbe.selectorTargetToken,
        });
    if (staleFocusedType?.success !== false || staleFocusedType?.dispatched !== false || staleFocusedType?.noDispatch !== true) {
      throw new Error(`focused typing must fail closed after focus moves from the preflight element: ${JSON.stringify(staleFocusedType)}`);
    }
    const shadowFocusedProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'type_text',
      args: { text: 'Paris' },
    });
    if (
      !shadowFocusedProbe?.resolved
      || shadowFocusedProbe.refId !== refs.shadowFamilyInput
      || !shadowFocusedProbe.selectorTargetToken
      || !shadowFocusedProbe.fieldMeta?.toolbarCandidate?.reasons?.includes('semantic_toolbar')
    ) {
      throw new Error(`expected deeply focused shadow toolbar target, got: ${JSON.stringify(shadowFocusedProbe)}`);
    }
    if (browserKind === 'chrome') {
      const preparedFocusedType = await call(page, 'prepare_rich_text_toolbar_focused_type', {
        token: shadowFocusedProbe.selectorTargetToken,
        text: 'Paris',
      });
      if (
        preparedFocusedType?.success !== true
        || !/^\d+:[0-9a-f]+$/.test(preparedFocusedType.beforeSignature || '')
        || Object.hasOwn(preparedFocusedType, 'value')
      ) {
        throw new Error(`trusted focused typing must prepare an exact secret-free target: ${JSON.stringify(preparedFocusedType)}`);
      }
      const unmodifiedVerification = await call(page, 'verify_rich_text_toolbar_focused_type', {
        token: shadowFocusedProbe.selectorTargetToken,
        text: 'Paris',
        clear: false,
        beforeSignature: preparedFocusedType.beforeSignature,
      });
      if (unmodifiedVerification?.success !== true || unmodifiedVerification.verified !== false) {
        throw new Error(`focused verification must reject an unmodified target: ${JSON.stringify(unmodifiedVerification)}`);
      }
      const insertedProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
        toolName: 'type_text',
        args: { text: 'Paris' },
      });
      const insertedPreparation = await call(page, 'prepare_rich_text_toolbar_focused_type', {
        token: insertedProbe.selectorTargetToken,
        text: 'Paris',
      });
      await page.evaluate(() => {
        const input = document.querySelector('#shadow-toolbar-host').shadowRoot
          .querySelector('#shadow-family-input');
        input.value += 'Paris';
      });
      const insertedVerification = await call(page, 'verify_rich_text_toolbar_focused_type', {
        token: insertedProbe.selectorTargetToken,
        text: 'Paris',
        clear: false,
        beforeSignature: insertedPreparation.beforeSignature,
      });
      if (insertedPreparation?.success !== true || insertedVerification?.verified !== true) {
        throw new Error(`focused verification must accept the exact requested insertion: ${JSON.stringify({ insertedPreparation, insertedVerification })}`);
      }
      await page.evaluate(() => {
        document.querySelector('#shadow-toolbar-host').shadowRoot
          .querySelector('#shadow-family-input').value = 'Default';
      });
    } else {
      await call(page, 'release_rich_text_toolbar_retry_target', {
        token: shadowFocusedProbe.selectorTargetToken,
      });
    }

    const editorPoint = await page.evaluate(() => {
      const editor = document.getElementById('editor-body');
      editor.scrollIntoView({ block: 'center' });
      const rect = editor.getBoundingClientRect();
      window.__richTextRetryProbeScrolls = 0;
      editor.scrollIntoView = () => { window.__richTextRetryProbeScrolls += 1; };
      return { x: rect.x + 12, y: rect.y + 12 };
    });
    const coordinateProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'click',
      args: editorPoint,
    });
    const coordinateProbeScrolls = await page.evaluate(() => window.__richTextRetryProbeScrolls);
    if (!coordinateProbe?.resolved || coordinateProbe.refId !== refs.editor || coordinateProbeScrolls !== 0) {
      throw new Error(`coordinate retry probe must preserve viewport coordinates, got: ${JSON.stringify({ coordinateProbe, coordinateProbeScrolls })}`);
    }
    const selectorProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'click',
      args: { selector: '#editor-body' },
    });
    const selectorProbeScrolls = await page.evaluate(() => window.__richTextRetryProbeScrolls);
    if (!selectorProbe?.resolved || selectorProbe.refId !== refs.editor || selectorProbeScrolls !== 1) {
      throw new Error(`selector retry probe must retain normal target scrolling, got: ${JSON.stringify({ selectorProbe, selectorProbeScrolls })}`);
    }

    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'toolbar-identity-rerender';
      input.value = 'ordinary';
      document.body.appendChild(input);
    });
    const identityProbe = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'type_text',
      args: { selector: '#toolbar-identity-rerender', text: 'Document prose' },
    });
    if (!identityProbe?.resolved || !identityProbe.selectorTargetToken) {
      throw new Error(`selector type probe must preserve exact target identity, got: ${JSON.stringify(identityProbe)}`);
    }
    await page.evaluate(() => {
      const current = document.getElementById('toolbar-identity-rerender');
      const replacement = current.cloneNode();
      replacement.value = '11';
      current.replaceWith(replacement);
    });
    const rerenderedType = await call(page, 'type', {
      selector: '#toolbar-identity-rerender',
      text: 'Document prose',
      clear: true,
      richTextToolbarTargetToken: identityProbe.selectorTargetToken,
    });
    const rerenderedValue = await page.evaluate(() => {
      const target = document.getElementById('toolbar-identity-rerender');
      const value = target.value;
      target.remove();
      return value;
    });
    if (rerenderedType?.success !== false || rerenderedType?.dispatched !== false || !rerenderedType?.retryable || rerenderedValue !== '11') {
      throw new Error(`rerendered selector target must fail closed before typing, got: ${JSON.stringify({ rerenderedType, rerenderedValue })}`);
    }

    const labelledBy = await call(page, 'set_field', {
      ref_id: refs.labelledBy,
      text: '12',
      clear: true,
    });
    if (
      !labelledBy?.success
      || labelledBy.fieldMeta?.ariaLabelledByText !== 'Quantity'
      || !labelledBy.fieldMeta?.toolbarCandidate?.reasons?.includes('labelled_toolbar_control')
      || !labelledBy.fieldMeta.toolbarCandidate.reasons.includes('semantic_toolbar')
    ) {
      throw new Error(`aria-labelledby toolbar field must enter the toolbar audit, got: ${JSON.stringify(labelledBy)}`);
    }

    const shadowLabelledBy = await call(page, 'set_field', {
      ref_id: refs.shadowLabelledBy,
      text: 'Document prose',
      clear: true,
    });
    if (!shadowLabelledBy?.success || shadowLabelledBy.fieldMeta?.toolbarCandidate || shadowLabelledBy.fieldMeta?.ariaLabelledByText !== 'Shadow quantity') {
      throw new Error(`shadow-local aria-labelledby field must stay outside toolbar audit, got: ${JSON.stringify(shadowLabelledBy)}`);
    }

    const shadowExplicitLabel = await call(page, 'set_field', {
      ref_id: refs.shadowExplicitLabel,
      text: 'Document prose',
      clear: true,
    });
    if (!shadowExplicitLabel?.success || shadowExplicitLabel.fieldMeta?.toolbarCandidate || shadowExplicitLabel.fieldMeta?.labelText !== 'Shadow explicit quantity') {
      throw new Error(`shadow-local explicit-label field must stay outside toolbar audit, got: ${JSON.stringify(shadowExplicitLabel)}`);
    }

    const title = await call(page, 'set_field', {
      ref_id: refs.title,
      text: '125%',
      clear: true,
    });
    if (
      !title?.success
      || title.fieldMeta?.title !== 'Zoom level'
      || !title.fieldMeta?.toolbarCandidate?.reasons?.includes('labelled_toolbar_control')
      || !title.fieldMeta.toolbarCandidate.reasons.includes('semantic_toolbar')
    ) {
      throw new Error(`title-labelled toolbar field must enter the toolbar audit, got: ${JSON.stringify(title)}`);
    }

    const ordinary = await call(page, 'set_field', {
      ref_id: refs.ordinary,
      text: '12',
      clear: true,
    });
    if (!ordinary?.success || ordinary.fieldMeta?.toolbarCandidate) {
      throw new Error(`labelled ordinary field must keep normal behavior, got: ${JSON.stringify(ordinary)}`);
    }
    const ordinarySelect = await call(page, 'probe_rich_text_toolbar_retry_target', {
      toolName: 'set_field',
      args: { ref_id: refs.ordinaryStatus, text: 'Published' },
    });
    if (!ordinarySelect?.resolved || ordinarySelect.fieldMeta?.type !== 'select' || ordinarySelect.fieldMeta?.toolbarCandidate) {
      throw new Error(`labelled ordinary select must keep normal behavior, got: ${JSON.stringify(ordinarySelect)}`);
    }
  });
}

test('Agent rich-text toolbar audit accepts visual family classification, rejects ordinary fields, and blocks the full toolbar scope', async () => {
  for (const AgentClass of [Agent, FirefoxAgent]) {
    if (
      AgentClass._richTextToolbarRecoveryScopeMatches(
        'https://example.test/editor?mode=edit#/document/A',
        'https://example.test/editor?mode=edit#/document/B',
      )
    ) {
      throw new Error('hash-routed editor documents must remain separate recovery scopes');
    }
    if (
      !AgentClass._richTextToolbarRecoveryScopeMatches(
        'https://example.test/editor?mode=edit#/document/A',
        'https://example.test/editor?mode=edit#/document/A',
      )
    ) {
      throw new Error('an exact hash-routed editor document must remain recoverable');
    }
    const familyAudit = AgentClass._normalizeRichTextToolbarAudit({
      regionKind: 'rich_text_toolbar',
      targetKind: 'font_family',
      confidence: 0.94,
    });
    const candidate = {
      score: 4,
      reasons: ['unlabelled_text_control', 'compact_control', 'dense_control_cluster'],
      relatedRefs: ['ref_12', 'ref_13'],
      availablePresetValues: ['Default', 'Inter Display', 'Arial', 'Times New Roman'],
      regionRef: 'ref_10',
      regionKey: 'rtb:div:0:0:320:48',
      associatedEditorRef: 'ref_99',
      associatedEditorIdentity: {
        tag: 'div',
        id: 'editor-body',
        name: null,
        role: 'textbox',
        pageX: 20,
        pageY: 160,
        w: 400,
        h: 180,
      },
      regionRect: { x: 0, y: 0, w: 320, h: 48 },
      attemptedTextShape: {
        chars: 86,
        words: 14,
        lines: 1,
        numericPreset: false,
        urlLike: false,
      },
    };
    const familyDecision = AgentClass._richTextToolbarDecision(candidate, familyAudit);
    if (!familyDecision.wrongTarget || familyDecision.targetKind !== 'font_family') {
      throw new Error(`expected visual font-family rejection, got: ${JSON.stringify(familyDecision)}`);
    }
    const legitimateFamilyDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('Inter Display'),
      attemptedPresetMatch: AgentClass._richTextToolbarPresetMatch('Inter Display', candidate.availablePresetValues),
    }, familyAudit);
    if (legitimateFamilyDecision.wrongTarget) {
      throw new Error(`short font-family value must remain allowed: ${JSON.stringify(legitimateFamilyDecision)}`);
    }
    for (const documentText of ['Paris', 'Quarterly roadmap']) {
      const mistakenFamilyDecision = AgentClass._richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: AgentClass._richTextToolbarTextShape(documentText),
        attemptedPresetMatch: AgentClass._richTextToolbarPresetMatch(documentText, candidate.availablePresetValues),
      }, familyAudit);
      if (!mistakenFamilyDecision.wrongTarget) {
        throw new Error(`arbitrary short text must be rejected for font-family targets: ${JSON.stringify({ documentText, mistakenFamilyDecision })}`);
      }
    }
    const genericFamilyDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('system-ui'),
      attemptedPresetMatch: false,
    }, familyAudit);
    if (genericFamilyDecision.wrongTarget) {
      throw new Error(`standard generic font family must remain allowed: ${JSON.stringify(genericFamilyDecision)}`);
    }
    const styleAudit = {
      ...familyAudit,
      targetKind: 'style_preset',
    };
    const stylePresetValues = ['Body', 'Heading 1', 'Title'];
    const legitimateStyleDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('Heading 1'),
      attemptedPresetMatch: AgentClass._richTextToolbarPresetMatch('Heading 1', stylePresetValues),
    }, styleAudit);
    if (legitimateStyleDecision.wrongTarget) {
      throw new Error(`control-owned style preset must remain allowed: ${JSON.stringify(legitimateStyleDecision)}`);
    }
    const mistakenStyleDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('Quarterly roadmap'),
      attemptedPresetMatch: AgentClass._richTextToolbarPresetMatch('Quarterly roadmap', stylePresetValues),
    }, styleAudit);
    if (!mistakenStyleDecision.wrongTarget) {
      throw new Error(`arbitrary short text must be rejected for style-preset targets: ${JSON.stringify(mistakenStyleDecision)}`);
    }
    const semanticStyleDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('h2'),
      attemptedPresetMatch: false,
    }, styleAudit);
    if (semanticStyleDecision.wrongTarget) {
      throw new Error(`semantic style token must remain allowed: ${JSON.stringify(semanticStyleDecision)}`);
    }
    const colorAudit = {
      ...familyAudit,
      targetKind: 'color',
    };
    for (const color of ['red', 'transparent', 'rebeccapurple']) {
      const colorDecision = AgentClass._richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: AgentClass._richTextToolbarTextShape(color),
        attemptedPresetMatch: false,
      }, colorAudit);
      if (colorDecision.wrongTarget) {
        throw new Error(`CSS named color must remain allowed: ${JSON.stringify({ color, colorDecision })}`);
      }
    }
    const presetColorDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('Brand Accent'),
      attemptedPresetMatch: true,
    }, colorAudit);
    if (presetColorDecision.wrongTarget) {
      throw new Error(`control-owned color preset must remain allowed: ${JSON.stringify(presetColorDecision)}`);
    }
    const proseColorDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('Quarterly roadmap'),
      attemptedPresetMatch: false,
    }, colorAudit);
    if (!proseColorDecision.wrongTarget) {
      throw new Error(`ordinary prose must be rejected for color targets: ${JSON.stringify(proseColorDecision)}`);
    }
    const linkAudit = {
      ...familyAudit,
      targetKind: 'link',
    };
    for (const destination of [
      'https://example.com/docs',
      'www.example.com',
      '/docs/start',
      '../docs/start',
      'person@example.com',
      'mailto:person@example.com',
      'tel:+15551234567',
      '#overview',
    ]) {
      const linkDecision = AgentClass._richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: AgentClass._richTextToolbarTextShape(destination),
      }, linkAudit);
      if (linkDecision.wrongTarget) {
        throw new Error(`common link destination must remain allowed: ${JSON.stringify({ destination, linkDecision })}`);
      }
    }
    for (const prose of ['Quarterly roadmap', 'Contact the project team']) {
      const proseLinkDecision = AgentClass._richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: AgentClass._richTextToolbarTextShape(prose),
      }, linkAudit);
      if (!proseLinkDecision.wrongTarget) {
        throw new Error(`ordinary prose must be rejected for link targets: ${JSON.stringify({ prose, proseLinkDecision })}`);
      }
    }
    const numericSizeDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('14'),
    }, {
      ...familyAudit,
      targetKind: 'font_size',
    });
    if (numericSizeDecision.wrongTarget) {
      throw new Error(`numeric font-size preset must remain allowed: ${JSON.stringify(numericSizeDecision)}`);
    }
    const documentTextSizeDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('This is document content, not a size preset.'),
    }, {
      ...familyAudit,
      targetKind: 'font_size',
    });
    if (!documentTextSizeDecision.wrongTarget) {
      throw new Error(`document text must be rejected for font-size targets: ${JSON.stringify(documentTextSizeDecision)}`);
    }
    const otherFormattingAudit = {
      ...familyAudit,
      targetKind: 'other_formatting',
    };
    const numericFormattingDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('125%'),
    }, otherFormattingAudit);
    if (numericFormattingDecision.wrongTarget) {
      throw new Error(`numeric other-formatting value must remain allowed: ${JSON.stringify(numericFormattingDecision)}`);
    }
    const documentTextFormattingDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('This is document content, not a formatting preset.'),
    }, otherFormattingAudit);
    if (!documentTextFormattingDecision.wrongTarget) {
      throw new Error(`document text must be rejected for other-formatting targets: ${JSON.stringify(documentTextFormattingDecision)}`);
    }
    for (const prose of ['Paris', 'Quarterly roadmap']) {
      const shortProseFormattingDecision = AgentClass._richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: AgentClass._richTextToolbarTextShape(prose),
        attemptedPresetMatch: false,
      }, otherFormattingAudit);
      if (!shortProseFormattingDecision.wrongTarget) {
        throw new Error(`short prose must be rejected for other-formatting targets: ${JSON.stringify({ prose, shortProseFormattingDecision })}`);
      }
    }
    const formattingPresetDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('Single'),
      attemptedPresetMatch: true,
    }, otherFormattingAudit);
    if (formattingPresetDecision.wrongTarget) {
      throw new Error(`control-owned other-formatting preset must remain allowed: ${JSON.stringify(formattingPresetDecision)}`);
    }
    for (const targetKind of ['font_size', 'font_family', 'style_preset', 'color', 'link', 'other_formatting']) {
      const clearingDecision = AgentClass._richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: AgentClass._richTextToolbarTextShape(''),
        attemptedPresetMatch: false,
      }, {
        ...familyAudit,
        targetKind,
      });
      if (clearingDecision.wrongTarget) {
        throw new Error(`explicit empty formatting reset must remain allowed: ${JSON.stringify({ targetKind, clearingDecision })}`);
      }
    }
    const ordinaryDecision = AgentClass._richTextToolbarDecision(candidate, {
      regionKind: 'ordinary_form_field',
      targetKind: 'ordinary_input',
      confidence: 0.96,
    });
    if (ordinaryDecision.wrongTarget) {
      throw new Error(`ordinary field visual classification must override weak structure: ${JSON.stringify(ordinaryDecision)}`);
    }
    for (const [value, preset] of [
      ['14', false],
      ['Inter Display', true],
      ['h2', false],
      ['red', false],
      ['https://example.test/docs', false],
    ]) {
      const structuralFormattingDecision = AgentClass._richTextToolbarDecision({
        ...candidate,
        attemptedTextShape: AgentClass._richTextToolbarTextShape(value),
        attemptedPresetMatch: preset,
      }, null);
      if (structuralFormattingDecision.wrongTarget) {
        throw new Error(`plausible formatting value must survive no-vision structural fallback: ${JSON.stringify({ value, structuralFormattingDecision })}`);
      }
    }
    const structuralProseDecision = AgentClass._richTextToolbarDecision({
      ...candidate,
      attemptedTextShape: AgentClass._richTextToolbarTextShape('Paris'),
      attemptedPresetMatch: false,
    }, null);
    if (!structuralProseDecision.wrongTarget || structuralProseDecision.source !== 'structural_fallback') {
      throw new Error(`no-vision structural fallback must reject prose-like toolbar values: ${JSON.stringify(structuralProseDecision)}`);
    }
    const numericCandidate = {
      ...candidate,
      reasons: [...candidate.reasons, 'numeric_preset_value'],
      availablePresetValues: ['11', '14'],
    };
    for (const value of ['red', 'serif', 'h1', 'https://example.test/docs']) {
      const crossKindDecision = AgentClass._richTextToolbarDecision({
        ...numericCandidate,
        attemptedTextShape: AgentClass._richTextToolbarTextShape(value),
        attemptedPresetMatch: AgentClass._richTextToolbarPresetMatch(value, numericCandidate.availablePresetValues),
      }, null);
      if (!crossKindDecision.wrongTarget || crossKindDecision.source !== 'structural_fallback') {
        throw new Error(`numeric toolbar candidate accepted a cross-kind formatting value: ${JSON.stringify({ value, crossKindDecision })}`);
      }
    }
    for (const value of ['14', '16']) {
      const numericFallbackDecision = AgentClass._richTextToolbarDecision({
        ...numericCandidate,
        attemptedTextShape: AgentClass._richTextToolbarTextShape(value),
        attemptedPresetMatch: AgentClass._richTextToolbarPresetMatch(value, numericCandidate.availablePresetValues),
      }, null);
      if (numericFallbackDecision.wrongTarget) {
        throw new Error(`numeric toolbar candidate rejected a numeric value: ${JSON.stringify({ value, numericFallbackDecision })}`);
      }
    }

    const agent = new AgentClass({ getVisionProvider: async () => null });
    const tabId = 77;
    const focusAgent = new AgentClass({ getVisionProvider: async () => null });
    const extensionGlobal = AgentClass === Agent ? 'chrome' : 'browser';
    const originalExtensionApi = globalThis[extensionGlobal];
    const frameMessages = [];
    const focusedFrameWaits = new Map();
    globalThis[extensionGlobal] = {
      webNavigation: {
        async getAllFrames() {
          return [
            { frameId: 0, parentFrameId: -1, url: 'https://example.test/editor' },
            { frameId: 7, parentFrameId: 0, url: 'https://frames.example.test/editor' },
            { frameId: 8, parentFrameId: 0, url: 'https://frames.example.test/inactive' },
          ];
        },
      },
      tabs: {
        async sendMessage(_tabId, message, options) {
          frameMessages.push({ message, options });
          if (message.action === 'wait_for_rich_text_toolbar_focused_child_frame') {
            return new Promise(resolve => focusedFrameWaits.set(message.params.token, resolve));
          }
          if (message.action === 'announce_rich_text_toolbar_focused_child_frame') {
            const resolve = focusedFrameWaits.get(message.params.token);
            focusedFrameWaits.delete(message.params.token);
            resolve?.({ matched: options.frameId === 7 });
            return { announced: true };
          }
          if (options.frameId === 0) {
            return {
              resolved: true,
              rect: { x: 10, y: 20, w: 500, h: 300 },
              fieldMeta: { tag: 'iframe' },
            };
          }
          if (options.frameId === 7) {
            return {
              resolved: true,
              refId: 'ref_7',
              selectorTargetToken: 'focused-frame-token',
              rect: { x: 12, y: 9, w: 110, h: 24 },
              fieldMeta: {
                tag: 'input',
                toolbarCandidate: { score: 8, reasons: ['semantic_toolbar'] },
              },
              toolbarContext: true,
            };
          }
          return {
            resolved: true,
            refId: 'inactive_ref',
            selectorTargetToken: 'inactive-frame-token',
            rect: { x: 14, y: 11, w: 100, h: 22 },
            fieldMeta: {
              tag: 'input',
              toolbarCandidate: { score: 99, reasons: ['semantic_toolbar'] },
            },
            toolbarContext: true,
          };
        },
      },
    };
    try {
      focusAgent._richTextToolbarFrameRectToTop = async (_tabId, frames, frameId, rect) => ({
        ...rect,
        x: rect.x + (frames.length * 10),
        frameId,
      });
      const deepFrameProbe = await focusAgent._probeRichTextToolbarRetryTarget(
        tabId,
        'type_text',
        { text: 'Paris' },
        { mapAnnotation: true },
      );
      const probeMessages = frameMessages.filter(entry => entry.message.action === 'probe_rich_text_toolbar_retry_target');
      if (
        deepFrameProbe?.frameId !== 7
        || deepFrameProbe.refId !== 'ref_7'
        || deepFrameProbe.selectorTargetToken !== 'focused-frame-token'
        || deepFrameProbe.annotationRect?.x !== 42
        || probeMessages.length !== 2
        || probeMessages.map(entry => entry.options.frameId).join(',') !== '0,7'
        || !frameMessages.some(entry => entry.message.action === 'wait_for_rich_text_toolbar_focused_child_frame')
        || !frameMessages.some(entry => entry.message.action === 'announce_rich_text_toolbar_focused_child_frame' && entry.options.frameId === 7)
        || probeMessages.some(entry => entry.message.params.args.selector != null)
      ) {
        throw new Error(`focused type_text must probe only the handshaken focused frame branch: ${JSON.stringify({ deepFrameProbe, frameMessages })}`);
      }
    } finally {
      if (originalExtensionApi === undefined) delete globalThis[extensionGlobal];
      else globalThis[extensionGlobal] = originalExtensionApi;
    }
    let capturedVisionMessages = null;
    agent.providerManager.getVisionProvider = async () => ({
      config: { model: 'fixture-vision', baseUrl: 'https://vision.example.test' },
    });
    agent._chatWithCostAllowance = async (_vision, messages) => {
      capturedVisionMessages = messages;
      return { content: JSON.stringify(familyAudit) };
    };
    const targetOnlyAudit = await agent._classifyRichTextToolbarTarget(
      tabId,
      { supportsVision: true },
      'data:image/png;base64,dGVzdA==',
    );
    const serializedVisionMessages = JSON.stringify(capturedVisionMessages);
    if (
      !targetOnlyAudit
      || serializedVisionMessages.includes('TRUSTED USER TASK CONTEXT')
      || serializedVisionMessages.includes('PROPOSED TOOL VALUE')
      || serializedVisionMessages.includes('taskTargetIntent')
      || !serializedVisionMessages.includes('Classify only that target')
    ) {
      throw new Error(`vision prompt must remain target-only: ${serializedVisionMessages}`);
    }
    agent.providerManager.getVisionProvider = async () => null;
    agent._lastAxScopes.set(tabId, { documentToken: 'doc-a', pageUrl: 'https://example.test/editor' });
    const result = { success: true, verified: true, dispatched: true };
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_12', text: 'Paris' },
      result,
      candidate,
      familyDecision,
      familyAudit,
      { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
    );
    if (result.success || result.verified || !result.wrongTarget || result.dispatched !== false || result.noDispatch !== true) {
      throw new Error(`wrong target must be blocked before dispatch: ${JSON.stringify(result)}`);
    }
    const alternateControlBlock = {};
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'type_text',
      { selector: '#font-size', text: 'Paris', clear: true },
      alternateControlBlock,
      {
        ...candidate,
        relatedRefs: ['ref_14', 'ref_15'],
      },
      familyDecision,
      familyAudit,
      { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
    );
    const deduplicatedState = agent._richTextToolbarStates.get(tabId);
    const deduplicatedObligation = deduplicatedState?.recoveryObligations?.[0];
    if (
      deduplicatedState?.recoveryObligations?.length !== 1
      || !deduplicatedObligation?.blockedRefs?.includes('ref_12')
      || !deduplicatedObligation?.blockedRefs?.includes('ref_14')
      || !deduplicatedObligation?.blockedSelectors?.includes('#font-size')
      || !deduplicatedState.blockedRefs?.has('ref_14')
      || !deduplicatedState.blockedSelectors?.has('#font-size')
    ) {
      throw new Error(`equivalent editor mutations must merge toolbar targets into one recovery obligation: ${JSON.stringify(deduplicatedState)}`);
    }
    const siblingBlock = agent._richTextToolbarRefBlock(tabId, 'click_ax', { ref_id: 'ref_13' }, 'doc-a');
    if (!siblingBlock?.blockedToolbarRef || siblingBlock.dispatched !== false) {
      throw new Error(`expected sibling toolbar ref block, got: ${JSON.stringify(siblingBlock)}`);
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_12',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 10, y: 8, w: 60, h: 24 },
      fieldMeta: {},
      toolbarContext: true,
      toolbarRegionRef: '',
      toolbarRegionKey: candidate.regionKey,
    });
    const focusedRetryBlock = await agent._richTextToolbarToolBlock(tabId, 'type_text', { text: 'Paris' });
    if (!focusedRetryBlock?.wrongTarget || focusedRetryBlock.dispatched !== false) {
      throw new Error(`expected focused type_text toolbar retry block, got: ${JSON.stringify(focusedRetryBlock)}`);
    }
    const coordinateRetryBlock = await agent._richTextToolbarToolBlock(tabId, 'click', { x: 40, y: 20 });
    if (!coordinateRetryBlock?.wrongTarget || coordinateRetryBlock.dispatched !== false) {
      throw new Error(`expected coordinate toolbar retry block, got: ${JSON.stringify(coordinateRetryBlock)}`);
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_88',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 500, y: 8, w: 60, h: 24 },
      fieldMeta: {
        toolbarCandidate: {
          ...candidate,
          score: 8,
          reasons: ['unlabelled_text_control', 'compact_control', 'numeric_preset_value', 'semantic_toolbar'],
          relatedRefs: ['ref_88', 'ref_89'],
          regionRef: 'ref_80',
          associatedEditorRef: 'ref_199',
          associatedEditorIdentity: {
            ...candidate.associatedEditorIdentity,
            id: 'editor-body-b',
            pageX: 500,
          },
        },
      },
      toolbarContext: true,
      toolbarRegionRef: 'ref_80',
    });
    const otherToolbarBlock = await agent._richTextToolbarToolBlock(tabId, 'click', { selector: '#other-toolbar' });
    if (otherToolbarBlock) {
      throw new Error(`an unrelated toolbar must not be blocked: ${JSON.stringify(otherToolbarBlock)}`);
    }
    const otherToolbarPreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_88', text: 'Document prose' },
      { supportsVision: false },
    );
    if (!otherToolbarPreflight.block?.wrongTarget || otherToolbarPreflight.block.dispatched !== false) {
      throw new Error('a second toolbar must still be audited while recovery debt is open');
    }
    const preservedRecoveryState = agent._richTextToolbarStates.get(tabId);
    if (
      preservedRecoveryState?.associatedEditorRef !== 'ref_99'
      || preservedRecoveryState?.associatedEditorIdentity?.id !== 'editor-body'
      || preservedRecoveryState?.recoveryObligations?.length !== 2
      || !preservedRecoveryState.blockedRegionRefs?.has('ref_10')
      || !preservedRecoveryState.blockedRegionRefs?.has('ref_80')
      || agent._richTextToolbarDebts.get(tabId)?.ref_id !== 'ref_12'
    ) {
      throw new Error(`a later toolbar must not replace the first unresolved editor: ${JSON.stringify(preservedRecoveryState)}`);
    }
    await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_88', text: 'Document prose' },
      { supportsVision: false },
    );
    if (agent._richTextToolbarStates.get(tabId)?.recoveryObligations?.length !== 2) {
      throw new Error('an identical blocked retry must not create duplicate recovery obligations');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_199',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 500, y: 160, pageX: 500, pageY: 160, w: 400, h: 180 },
      fieldMeta: { tag: 'div', id: 'editor-body-b', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const secondEditorRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'set_field',
      { ref_id: 'ref_199', text: 'Paris' },
      { success: true, verified: true, method: 'set_field' },
    );
    if (secondEditorRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('editing the second toolbar\'s editor must not clear the first unresolved editor debt');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_99',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 20, y: 160, w: 400, h: 180 },
      fieldMeta: { contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const editorBodyBlock = await agent._richTextToolbarToolBlock(tabId, 'click', { selector: '#editor' });
    if (editorBodyBlock) {
      throw new Error(`editor-body recovery target must remain usable: ${JSON.stringify(editorBodyBlock)}`);
    }
    agent._effectiveRunMode = () => 'act';
    const doneBlock = agent._completionDoneBlock(tabId, 'done', { outcome: 'success' });
    if (doneBlock?.reason !== 'rich_text_toolbar_target_unresolved') {
      throw new Error(`expected unresolved toolbar completion block, got: ${JSON.stringify(doneBlock)}`);
    }
    const plainFinalBlock = agent._completionPlainFinalBlock(tabId);
    if (!plainFinalBlock?.includes('RUNTIME COMPLETION BLOCK') || !plainFinalBlock.includes('rich-text formatting toolbar')) {
      throw new Error(`expected unresolved toolbar plain-final block, got: ${JSON.stringify(plainFinalBlock)}`);
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_98',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      fieldMeta: { contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const unrelatedRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(tabId, 'type_text', { text: 'Paris', clear: true }, {
      success: true,
      verified: true,
      method: 'contenteditable',
    });
    if (unrelatedRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('an unrelated contenteditable must not clear toolbar completion debt');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_99',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      fieldMeta: { contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const unverifiedRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(tabId, 'type_text', { text: 'Paris', clear: true }, {
      success: true,
      method: 'contenteditable',
    });
    if (unverifiedRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('an unverified editor dispatch must retain toolbar completion debt');
    }
    for (const incorrectText of ['', 'Lyon']) {
      const incorrectTextRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(tabId, 'type_text', { text: incorrectText, clear: true }, {
        success: true,
        verified: true,
        method: 'contenteditable',
      });
      if (incorrectTextRecovery || !agent._richTextToolbarDebts.has(tabId)) {
        throw new Error(`an exact editor edit with mismatched text must retain toolbar completion debt: ${JSON.stringify(incorrectText)}`);
      }
    }
    const appendModeRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(tabId, 'type_text', { text: 'Paris' }, {
      success: true,
      verified: true,
      method: 'contenteditable',
    });
    if (appendModeRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('append-mode recovery must not discharge a blocked replacement edit');
    }
    const exactRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(tabId, 'type_text', { text: 'Paris', clear: true }, {
      success: true,
      verified: true,
      method: 'contenteditable',
    });
    const secondRecoveryState = agent._richTextToolbarStates.get(tabId);
    if (
      !exactRecovery
      || !agent._richTextToolbarDebts.has(tabId)
      || secondRecoveryState?.associatedEditorRef !== 'ref_199'
      || secondRecoveryState?.blockedAttemptedText !== 'Document prose'
      || secondRecoveryState?.recoveryObligations?.length !== 1
    ) {
      throw new Error('recovering the first editor must retain and promote the second toolbar obligation');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_199',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 500, y: 160, pageX: 500, pageY: 160, w: 400, h: 180 },
      fieldMeta: { tag: 'div', id: 'editor-body-b', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const finalRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(tabId, 'set_field', { ref_id: 'ref_199', text: 'Document prose' }, {
      success: true,
      verified: true,
      method: 'set_field',
    });
    if (!finalRecovery || agent._richTextToolbarDebts.has(tabId) || agent._richTextToolbarStates.has(tabId)) {
      throw new Error('every accumulated toolbar obligation must be recovered before debt clears');
    }
    if (agent._richTextToolbarRefBlock(tabId, 'click_ax', { ref_id: 'ref_13' }, 'doc-a')) {
      throw new Error('toolbar refs must be released after exact editor recovery');
    }

    const queuedFirstBlock = {};
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_queue_toolbar_a', text: 'First queued edit' },
      queuedFirstBlock,
      candidate,
      familyDecision,
      familyAudit,
      { documentToken: 'doc-queue-a', refScopeUrl: 'https://example.test/editor' },
    );
    const queuedSecondBlock = {};
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'type_text',
      { selector: '#queue-toolbar-b', text: 'Second queued edit' },
      queuedSecondBlock,
      {
        ...candidate,
        regionRef: 'ref_queue_region_b',
        associatedEditorRef: 'ref_queue_editor_b',
        associatedEditorIdentity: { ...candidate.associatedEditorIdentity, id: 'queue-editor-b', pageX: 500 },
      },
      familyDecision,
      familyAudit,
      { documentToken: 'doc-queue-a', refScopeUrl: 'https://example.test/editor' },
    );
    agent._clearRichTextToolbarDocumentState(tabId);
    const queuedNavigationState = agent._richTextToolbarStates.get(tabId);
    if (
      queuedNavigationState?.recoveryObligations?.length !== 2
      || queuedNavigationState.recoveryObligations.some(obligation => obligation.recoveryOnly !== true || obligation.associatedEditorRef)
      || !agent._richTextToolbarDebts.has(tabId)
    ) {
      throw new Error('navigation must preserve every accumulated recovery obligation while releasing document-scoped refs');
    }
    agent._resetRichTextToolbarAudit(tabId);

    for (const [frameId, documentToken] of [[7, 'sibling-frame-doc-a'], [8, 'sibling-frame-doc-b']]) {
      agent._applyRichTextToolbarWrongTarget(
        tabId,
        'iframe_type',
        { selector: '#font-size', text: 'Shared iframe edit', clear: true },
        {},
        candidate,
        familyDecision,
        familyAudit,
        { frameId, documentToken, refScopeUrl: 'https://frame.example.test/editor' },
      );
    }
    const siblingFrameState = agent._richTextToolbarStates.get(tabId);
    if (
      siblingFrameState?.recoveryObligations?.length !== 2
      || new Set(siblingFrameState.recoveryObligations.map(obligation => obligation.frameId)).size !== 2
    ) {
      throw new Error('identical editor templates in sibling frames must retain separate recovery obligations');
    }
    agent._resetRichTextToolbarAudit(tabId);

    const refLessIdentityRecoveryResult = {};
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'type_text',
      { selector: '#font-family', text: 'Document prose' },
      refLessIdentityRecoveryResult,
      { ...candidate, associatedEditorRef: '' },
      familyDecision,
      familyAudit,
      { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
    );
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_200',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
      fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const refLessIdentityRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'set_field',
      { ref_id: 'ref_200', text: 'Document prose', clear: false },
      { success: true, verified: true, method: 'set_field' },
    );
    if (!refLessIdentityRecovery || agent._richTextToolbarDebts.has(tabId) || agent._richTextToolbarStates.has(tabId)) {
      throw new Error('a selector-backed rejection without an editor ref must recover through matching editor identity');
    }

    const selectorRecoveryResult = {};
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'type_text',
      { selector: '#font-family', text: 'Document prose' },
      selectorRecoveryResult,
      { ...candidate, associatedEditorRef: '' },
      familyDecision,
      familyAudit,
      { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
    );
    if (!agent._richTextToolbarDebts.has(tabId) || !agent._richTextToolbarStates.has(tabId)) {
      throw new Error('selector rejection with a stable editor identity must retain recoverable completion debt');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: '',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 10, y: 8, pageX: 10, pageY: 8, w: 60, h: 24 },
      fieldMeta: { tag: 'input', type: 'text', toolbarCandidate: candidate },
      toolbarContext: true,
      toolbarRegionRef: '',
    });
    const selectorRetryBlock = await agent._richTextToolbarToolBlock(
      tabId,
      'type_text',
      { selector: '#font-family', text: 'Document prose' },
    );
    if (!selectorRetryBlock?.wrongTarget || selectorRetryBlock.dispatched !== false) {
      throw new Error(`the rejected toolbar selector must remain blocked while recovery debt exists: ${JSON.stringify(selectorRetryBlock)}`);
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: '',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
      fieldMeta: { tag: 'div', id: 'other-editor', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const unrelatedSelectorRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'type_text',
      { selector: '#other-editor', text: 'Document prose' },
      { success: true, verified: true, method: 'contenteditable' },
    );
    if (unrelatedSelectorRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('a selector resolving to a different editor must not clear toolbar completion debt');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: '',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
      fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const exactSelectorRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'type_text',
      { selector: '#editor-body', text: 'Document prose' },
      { success: true, verified: true, method: 'contenteditable' },
    );
    if (!exactSelectorRecovery || agent._richTextToolbarDebts.has(tabId) || agent._richTextToolbarStates.has(tabId)) {
      throw new Error('a selector resolving to the associated editor identity should clear toolbar debt');
    }

    const rerenderRecoveryResult = {};
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_12', text: 'Document prose' },
      rerenderRecoveryResult,
      candidate,
      familyDecision,
      familyAudit,
      { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
    );
    const validatedEditorProbe = {
      resolved: true,
      refId: 'ref_99',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
      fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    };
    agent._probeRichTextToolbarRetryTarget = async () => validatedEditorProbe;
    const rerenderPreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_99', text: 'Document prose' },
      { supportsVision: false },
    );
    if (rerenderPreflight.probe !== validatedEditorProbe) {
      throw new Error('toolbar-debt preflight must preserve the validated editor target through execution');
    }
    agent._probeRichTextToolbarRetryTarget = async () => null;
    await agent._auditRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_99', text: 'Document prose' },
      { success: true, method: 'set_field', fieldMeta: validatedEditorProbe.fieldMeta },
      rerenderPreflight.probe,
    );
    if (!agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('pre-dispatch recovery evidence must not clear debt without an explicitly verified edit');
    }
    await agent._auditRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_99', text: 'Document prose' },
      { success: true, verified: true, method: 'set_field', fieldMeta: validatedEditorProbe.fieldMeta },
      rerenderPreflight.probe,
    );
    if (agent._richTextToolbarDebts.has(tabId) || agent._richTextToolbarStates.has(tabId)) {
      throw new Error('a validated editor edit must clear toolbar debt when a controlled rerender invalidates its old ref');
    }

    const iframeCandidate = {
      ...candidate,
      score: 8,
      reasons: ['unlabelled_text_control', 'compact_control', 'numeric_preset_value', 'semantic_toolbar'],
      availablePresetValues: ['11', '14'],
    };
    agent._probeRichTextToolbarIframeTarget = async () => ({
      resolved: true,
      selectorTargetToken: 'iframe-toolbar-token',
      refId: 'ref_12',
      frameId: 7,
      documentToken: 'frame-doc-a',
      refScopeUrl: 'https://frame.example.test/editor',
      rect: { x: 10, y: 8, w: 60, h: 24 },
      annotationRect: { x: 110, y: 208, w: 60, h: 24 },
      fieldMeta: { toolbarCandidate: iframeCandidate },
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    const iframePreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'iframe_type',
      { urlFilter: 'frame.example.test', selector: '#font-size', text: 'Document prose' },
      { supportsVision: false },
    );
    if (!iframePreflight.block?.wrongTarget || iframePreflight.block.dispatched !== false) {
      throw new Error(`iframe_type must audit and block toolbar targets before dispatch: ${JSON.stringify(iframePreflight)}`);
    }
    if (agent._richTextToolbarStates.get(tabId)?.frameId !== 7) {
      throw new Error('iframe toolbar debt must retain its frame identity');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_12',
      documentToken: 'top-doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 10, y: 8, w: 60, h: 24 },
      fieldMeta: { toolbarCandidate: iframeCandidate },
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    const unrelatedTopFrameBlock = await agent._richTextToolbarToolBlock(
      tabId,
      'click',
      { selector: '#font-size' },
    );
    if (unrelatedTopFrameBlock || !agent._richTextToolbarStates.has(tabId) || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('top-frame ref collisions must not consume or enforce iframe-scoped toolbar state');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: '',
      frameId: 7,
      documentToken: 'frame-doc-a',
      refScopeUrl: 'https://frame.example.test/editor',
      rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
      fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const iframeRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'iframe_type',
      { urlFilter: 'frame.example.test', selector: '#editor-body', text: 'Document prose' },
      { success: true, verified: true, method: 'contenteditable' },
    );
    if (!iframeRecovery || agent._richTextToolbarDebts.has(tabId) || agent._richTextToolbarStates.has(tabId)) {
      throw new Error('the associated iframe editor edit should clear toolbar debt');
    }

    const iframeBackedCandidate = {
      ...candidate,
      associatedEditorRef: 'ref_200',
      associatedEditorIdentity: {
        tag: 'iframe',
        id: null,
        name: null,
        role: null,
        pageX: 20,
        pageY: 160,
        w: 400,
        h: 180,
      },
    };
    const iframeBackedBlock = {};
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_12', text: 'Document prose' },
      iframeBackedBlock,
      iframeBackedCandidate,
      familyDecision,
      familyAudit,
      {
        documentToken: 'top-doc-a',
        refScopeUrl: 'https://example.test/editor',
        rect: { x: 10, y: 8, w: 60, h: 24 },
      },
    );
    if (!iframeBackedBlock.wrongTarget || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('a top-frame toolbar with an iframe-backed editor must retain recovery debt');
    }
    const iframeBackedEditorProbe = {
      resolved: true,
      refId: 'ref_inner_editor',
      frameId: 7,
      documentToken: 'frame-doc-a',
      refScopeUrl: 'https://frame.example.test/editor',
      topFrameUrl: 'https://example.test/editor',
      rect: { x: 0, y: 0, w: 400, h: 180 },
      frameOwnerRect: { x: 20, y: 60, pageX: 20, pageY: 160, w: 400, h: 180 },
      frameOwnerMeta: { tag: 'iframe', id: 'other-frame', name: null, role: null },
      fieldMeta: { tag: 'div', id: 'inner-editor', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    };
    agent._probeRichTextToolbarRetryTarget = async () => iframeBackedEditorProbe;
    const unrelatedIframeRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'iframe_type',
      { selector: '#inner-editor', text: 'Document prose', clear: true },
      { success: true, verified: true, method: 'contenteditable' },
    );
    if (unrelatedIframeRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('an edit in a different iframe must not clear iframe-backed editor debt');
    }
    const matchingAnonymousFrameProbe = {
      ...iframeBackedEditorProbe,
      frameOwnerMeta: { ...iframeBackedEditorProbe.frameOwnerMeta, id: null },
    };
    agent._probeRichTextToolbarRetryTarget = async () => ({
      ...matchingAnonymousFrameProbe,
      topFrameUrl: '',
    });
    const unscopedIframeRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'iframe_type',
      { selector: '#inner-editor', text: 'Document prose', clear: true },
      { success: true, verified: true, method: 'contenteditable' },
    );
    if (unscopedIframeRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('an iframe edit without a verified top-page scope must retain toolbar debt');
    }
    agent._probeRichTextToolbarRetryTarget = async () => matchingAnonymousFrameProbe;
    const iframeBackedRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'iframe_type',
      { selector: '#inner-editor', text: 'Document prose', clear: true },
      { success: true, verified: true, method: 'contenteditable' },
    );
    if (!iframeBackedRecovery || agent._richTextToolbarDebts.has(tabId) || agent._richTextToolbarStates.has(tabId)) {
      throw new Error('a verified edit in the associated iframe editor must clear toolbar debt');
    }

    const nestedIframeBlock = {};
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_nested_toolbar', text: 'Document prose' },
      nestedIframeBlock,
      iframeBackedCandidate,
      familyDecision,
      familyAudit,
      {
        frameId: 7,
        documentToken: 'toolbar-frame-doc-a',
        refScopeUrl: 'https://toolbar-frame.example.test/editor',
        rect: { x: 10, y: 8, w: 60, h: 24 },
      },
    );
    if (!nestedIframeBlock.wrongTarget || agent._richTextToolbarStates.get(tabId)?.frameId !== 7) {
      throw new Error('a nested iframe editor must retain the toolbar frame scope');
    }
    const nestedEditorProbe = {
      ...matchingAnonymousFrameProbe,
      frameId: 9,
      parentFrameId: 7,
      documentToken: 'nested-editor-doc-a',
      refScopeUrl: 'https://nested-editor.example.test/editor',
      frameOwnerScopeUrl: 'https://unrelated-toolbar-frame.example.test/editor',
      topFrameUrl: 'https://example.test/editor',
    };
    agent._probeRichTextToolbarRetryTarget = async () => nestedEditorProbe;
    const wrongNestedScopeRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'iframe_type',
      { selector: '#inner-editor', text: 'Document prose', clear: true },
      { success: true, verified: true, method: 'contenteditable' },
    );
    if (wrongNestedScopeRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('a matching nested iframe owner in another toolbar frame must retain debt');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      ...nestedEditorProbe,
      frameOwnerScopeUrl: 'https://toolbar-frame.example.test/editor',
    });
    const nestedIframeRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'iframe_type',
      { selector: '#inner-editor', text: 'Document prose', clear: true },
      { success: true, verified: true, method: 'contenteditable' },
    );
    if (!nestedIframeRecovery || agent._richTextToolbarDebts.has(tabId) || agent._richTextToolbarStates.has(tabId)) {
      throw new Error('a verified nested iframe edit must use the owning toolbar-frame scope and clear debt');
    }

    agent.autoScreenshot = 'state_change';
    agent.autoScreenshotCount.delete(tabId);
    agent.providerManager.getVisionProvider = async () => ({
      config: { model: 'fixture-vision', baseUrl: 'https://vision.example.test' },
    });
    agent._probeRichTextToolbarIframeTarget = async () => ({
      resolved: true,
      selectorTargetToken: 'unmapped-iframe-toolbar-token',
      refId: 'ref_12',
      frameId: 7,
      documentToken: 'frame-doc-a',
      refScopeUrl: 'https://frame.example.test/editor',
      rect: { x: 10, y: 8, w: 60, h: 24 },
      annotationRect: null,
      fieldMeta: { toolbarCandidate: iframeCandidate },
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    const unmappedIframePreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'iframe_type',
      { urlFilter: 'frame.example.test', selector: '#font-family', text: 'Document prose' },
      { supportsVision: false },
    );
    if (!unmappedIframePreflight.block?.noDispatch || !unmappedIframePreflight.block?.retryable) {
      throw new Error(`an unmappable iframe toolbar target must fail closed when visual audit is available: ${JSON.stringify(unmappedIframePreflight)}`);
    }
    agent.providerManager.getVisionProvider = async () => null;

    const staleDocumentResult = {};
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_12', text: 'Document prose' },
      staleDocumentResult,
      candidate,
      familyDecision,
      familyAudit,
      { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
    );
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_12',
      documentToken: 'doc-b',
      refScopeUrl: 'https://example.test/next',
      fieldMeta: { toolbarCandidate: candidate },
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    const crossDocumentBlock = await agent._richTextToolbarToolBlock(tabId, 'click_ax', { ref_id: 'ref_12' });
    const navigatedRecoveryState = agent._richTextToolbarStates.get(tabId);
    if (
      crossDocumentBlock
      || !agent._richTextToolbarDebts.has(tabId)
      || navigatedRecoveryState?.recoveryOnly !== true
      || navigatedRecoveryState.associatedEditorRef
      || navigatedRecoveryState.blockedRefs?.size
      || navigatedRecoveryState.blockedSelectors?.size
    ) {
      throw new Error('navigation must release stale toolbar targets while preserving editor recovery identity');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_12',
      documentToken: 'doc-b',
      refScopeUrl: 'https://example.test/next',
      rect: { x: 10, y: 8, w: 60, h: 24 },
      fieldMeta: {
        toolbarCandidate: {
          ...candidate,
          score: 8,
          reasons: ['unlabelled_text_control', 'compact_control', 'numeric_preset_value', 'semantic_toolbar'],
        },
      },
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    const navigatedToolbarPreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_12', text: 'Document prose' },
      { supportsVision: false },
    );
    if (!navigatedToolbarPreflight.block?.wrongTarget || navigatedToolbarPreflight.block.dispatched !== false) {
      throw new Error('recovery-only debt must still block a newly scoped toolbar candidate');
    }
    if (agent._richTextToolbarStates.get(tabId)?.recoveryObligations?.length !== 2) {
      throw new Error('a newly scoped toolbar mistake after navigation must retain both recovery obligations');
    }
    agent._effectiveRunMode = () => 'act';
    const navigatedDoneBlock = agent._completionDoneBlock(tabId, 'done', { outcome: 'success' });
    if (navigatedDoneBlock?.reason !== 'rich_text_toolbar_target_unresolved') {
      throw new Error(`navigation must not permit false success after a blocked toolbar edit: ${JSON.stringify(navigatedDoneBlock)}`);
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_77',
      documentToken: 'doc-b',
      refScopeUrl: 'https://unrelated.test/editor',
      rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
      fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const unrelatedOriginRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'set_field',
      { ref_id: 'ref_77', text: 'Document prose' },
      { success: true, verified: true, method: 'set_field' },
    );
    if (unrelatedOriginRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('a same-shaped editor on another origin must not clear toolbar debt');
    }
    const unrelatedOriginSelectorRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'type_text',
      { selector: '#editor-body', text: 'Document prose' },
      { success: true, verified: true, method: 'contenteditable' },
    );
    if (unrelatedOriginSelectorRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('selector recovery on another origin must not clear toolbar debt');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_99',
      documentToken: 'doc-b',
      refScopeUrl: 'https://example.test/next',
      rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
      fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const navigatedRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'set_field',
      { ref_id: 'ref_99', text: 'Document prose' },
      { success: true, verified: true, method: 'set_field' },
    );
    if (
      !navigatedRecovery
      || !agent._richTextToolbarDebts.has(tabId)
      || agent._richTextToolbarStates.get(tabId)?.recoveryObligations?.length !== 1
    ) {
      throw new Error('the current-route edit must clear only the newly scoped obligation and retain the original route debt');
    }
    const originalRouteProbe = {
      resolved: true,
      refId: 'ref_78',
      documentToken: 'doc-c',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 20, y: 160, pageX: 20, pageY: 160, w: 400, h: 180 },
      fieldMeta: { tag: 'div', id: 'editor-body', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    };
    agent._probeRichTextToolbarRetryTarget = async () => originalRouteProbe;
    const originalRoutePreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_78', text: 'Document prose' },
      { supportsVision: false },
    );
    const originalRouteRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'set_field',
      { ref_id: 'ref_78', text: 'Document prose' },
      { success: true, verified: true, method: 'set_field' },
      originalRoutePreflight.probe,
    );
    if (!originalRouteRecovery || agent._richTextToolbarDebts.has(tabId) || agent._richTextToolbarStates.has(tabId)) {
      throw new Error('a verified matching editor edit on the original route must clear toolbar debt');
    }

    const anonymousEditorIdentity = {
      tag: 'div',
      id: null,
      name: null,
      role: 'textbox',
      pageX: 24,
      pageY: 620,
      w: 400,
      h: 180,
    };
    const anonymousEditorBlock = {};
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_anon_toolbar', text: 'Document prose' },
      anonymousEditorBlock,
      { ...candidate, associatedEditorRef: '', associatedEditorIdentity: anonymousEditorIdentity },
      familyDecision,
      familyAudit,
      { documentToken: 'doc-anon-a', refScopeUrl: 'https://example.test/editor' },
    );
    agent._clearRichTextToolbarDocumentState(tabId);
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_anon_editor_fresh',
      documentToken: 'doc-anon-b',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 24, y: 120, pageX: 24, pageY: 620, w: 400, h: 180 },
      fieldMeta: { tag: 'div', id: null, name: null, role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const anonymousEditorRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'set_field',
      { ref_id: 'ref_anon_editor_fresh', text: 'Document prose' },
      { success: true, verified: true, method: 'set_field' },
    );
    if (!anonymousEditorRecovery || agent._richTextToolbarDebts.has(tabId) || agent._richTextToolbarStates.has(tabId)) {
      throw new Error('fresh page coordinates must recover an unnamed editor identity after reload');
    }

    const unscopedBlock = {};
    agent._applyRichTextToolbarWrongTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_12', text: 'Document prose' },
      unscopedBlock,
      { ...candidate, associatedEditorRef: '', associatedEditorIdentity: null },
      familyDecision,
      familyAudit,
      { documentToken: 'doc-a', refScopeUrl: 'https://example.test/editor' },
    );
    const unknownRecoveryState = agent._richTextToolbarStates.get(tabId);
    if (
      !unscopedBlock.wrongTarget
      || !agent._richTextToolbarDebts.has(tabId)
      || unknownRecoveryState?.recoveryTargetUnknown !== true
    ) {
      throw new Error('ambiguous editor association must retain completion debt with an unknown recovery target');
    }
    const unknownDoneBlock = agent._completionDoneBlock(tabId, 'done', { outcome: 'success' });
    if (unknownDoneBlock?.reason !== 'rich_text_toolbar_target_unresolved') {
      throw new Error(`ambiguous editor debt must block successful completion: ${JSON.stringify(unknownDoneBlock)}`);
    }
    if (agent._completionDoneBlock(tabId, 'done', { outcome: 'partial' })) {
      throw new Error('ambiguous editor debt must still permit an explicit partial outcome');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_toolbar_editor_like',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 10, y: 8, w: 300, h: 120 },
      fieldMeta: { contentEditable: true, toolbarCandidate: candidate },
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    const toolbarLikeRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'type_ax',
      { ref_id: 'ref_toolbar_editor_like', text: 'Document prose', clear: true },
      { success: true, verified: true, method: 'contenteditable' },
    );
    if (toolbarLikeRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('an editor-like toolbar target must not clear ambiguous editor debt');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_quantity',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 10, y: 180, w: 180, h: 32 },
      fieldMeta: { tag: 'input', type: 'text' },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const ordinaryFieldRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'set_field',
      { ref_id: 'ref_quantity', text: 'Document prose' },
      { success: true, verified: true, method: 'set_field' },
    );
    if (ordinaryFieldRecovery || !agent._richTextToolbarDebts.has(tabId)) {
      throw new Error('an ordinary form field must not clear ambiguous editor debt');
    }
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_ambiguous_editor_a',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 10, y: 220, w: 300, h: 120 },
      fieldMeta: { tag: 'div', role: 'textbox', contentEditable: true },
      toolbarContext: false,
      toolbarRegionRef: '',
    });
    const unknownEditorRecovery = await agent._clearRichTextToolbarDebtAfterCorrectedEdit(
      tabId,
      'type_ax',
      { ref_id: 'ref_ambiguous_editor_a', text: 'Document prose', clear: true },
      { success: true, verified: true, method: 'contenteditable' },
    );
    if (!unknownEditorRecovery || agent._richTextToolbarDebts.has(tabId) || agent._richTextToolbarStates.has(tabId)) {
      throw new Error('a verified non-toolbar editor edit must clear ambiguous editor debt');
    }

    let classifierArgCount = 0;
    let classifierCaptureCount = 0;
    agent.autoScreenshot = 'state_change';
    agent.maxScreenshotsPerTurn = 1;
    agent.autoScreenshotCount.set(tabId, 1);
    agent._captureAutoScreenshot = async () => {
      classifierCaptureCount += 1;
      return {
        dataUrl: 'data:image/png;base64,dGVzdA==',
        width: 800,
        height: 600,
        cssWidth: 800,
        cssHeight: 600,
      };
    };
    agent._annotateScreenshot = async dataUrl => dataUrl;
    agent._classifyRichTextToolbarTarget = async (...classifierArgs) => {
      classifierArgCount = classifierArgs.length;
      return familyAudit;
    };
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      selectorBackendNodeId: 177,
      selectorTargetToken: 'selector-toolbar-token',
      refId: 'ref_12',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 10, y: 10, w: 120, h: 24 },
      fieldMeta: { toolbarCandidate: candidate },
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    const visualPreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'type_text',
      { selector: '#font-family', text: 'This document sentence is intentionally much too long to be a font family value.' },
      { supportsVision: true },
    );
    if (
      visualPreflight.shot
      || !visualPreflight.block?.wrongTarget
      || visualPreflight.block.dispatched !== false
      || !visualPreflight.block.rect
      || !visualPreflight.block.fieldMeta?.toolbarCandidate
      || visualPreflight.traceCapture
      || classifierArgCount !== 0
      || classifierCaptureCount !== 0
      || agent.autoScreenshotCount.get(tabId) !== 1
    ) {
      throw new Error(`exhausted screenshot budget must use structural toolbar preflight without capture: ${JSON.stringify({ visualPreflight, classifierArgCount, classifierCaptureCount, screenshotCount: agent.autoScreenshotCount.get(tabId) })}`);
    }
    agent._resetRichTextToolbarAudit(tabId);
    agent.autoScreenshotCount.delete(tabId);

    let annotationOptions = null;
    classifierArgCount = 0;
    agent._annotateScreenshot = async (_dataUrl, _rect, _viewport, options) => {
      annotationOptions = options;
      return null;
    };
    agent._classifyRichTextToolbarTarget = async (...classifierArgs) => {
      classifierArgCount = classifierArgs.length;
      return {
        regionKind: 'ordinary_form_field',
        targetKind: 'ordinary_input',
        confidence: 0.99,
      };
    };
    const annotationFailurePreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_12', text: 'This document sentence must not be typed into a toolbar control.' },
      { supportsVision: true },
    );
    if (
      !annotationFailurePreflight.block?.wrongTarget
      || annotationFailurePreflight.block.visualTargetAudit?.source !== 'structural_fallback'
      || annotationFailurePreflight.traceCapture
      || classifierArgCount !== 0
      || annotationOptions?.fallbackToOriginal !== false
    ) {
      throw new Error(`failed target annotation must skip vision and use structural toolbar evidence: ${JSON.stringify({ annotationFailurePreflight, classifierArgCount, annotationOptions })}`);
    }
    agent._resetRichTextToolbarAudit(tabId);

    agent._annotateScreenshot = async () => 'data:image/png;base64,YW5ub3RhdGVk';
    agent._classifyRichTextToolbarTarget = async () => familyAudit;
    const shortDocumentPreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_12', text: 'Paris' },
      { supportsVision: true },
    );
    if (!shortDocumentPreflight.block?.wrongTarget || shortDocumentPreflight.block.dispatched !== false) {
      throw new Error(`short non-preset document text must be blocked before dispatch: ${JSON.stringify(shortDocumentPreflight)}`);
    }
    agent._resetRichTextToolbarAudit(tabId);

    agent._classifyRichTextToolbarTarget = async () => styleAudit;
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_14',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 140, y: 10, w: 120, h: 24 },
      fieldMeta: {
        toolbarCandidate: {
          ...candidate,
          availablePresetValues: stylePresetValues,
        },
      },
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    const shortStylePreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_14', text: 'Quarterly roadmap' },
      { supportsVision: true },
    );
    if (!shortStylePreflight.block?.wrongTarget || shortStylePreflight.block.dispatched !== false) {
      throw new Error(`short non-preset style text must be blocked before dispatch: ${JSON.stringify(shortStylePreflight)}`);
    }
    agent._resetRichTextToolbarAudit(tabId);
    const allowedStylePreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_14', text: 'Heading 1' },
      { supportsVision: true },
    );
    if (allowedStylePreflight.block) {
      throw new Error(`control-owned style preset must pass preflight: ${JSON.stringify(allowedStylePreflight)}`);
    }

    agent._classifyRichTextToolbarTarget = async () => familyAudit;
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_12',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 10, y: 10, w: 120, h: 24 },
      fieldMeta: { toolbarCandidate: candidate },
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    const allowedPreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_12', text: 'Inter Display' },
      { supportsVision: true },
    );
    if (allowedPreflight.block || !allowedPreflight.shot || !agent._canTakeAutoScreenshot(tabId)) {
      throw new Error(`allowed toolbar formatting must preserve the post-edit screenshot slot: ${JSON.stringify(allowedPreflight)}`);
    }
    const postEditShot = await agent._captureBudgetedAutoScreenshot(tabId);
    if (!postEditShot || agent.autoScreenshotCount.get(tabId) !== 1 || agent._canTakeAutoScreenshot(tabId)) {
      throw new Error('the preserved model-facing slot must remain usable exactly once after preflight');
    }
    agent.autoScreenshotCount.delete(tabId);

    agent.autoScreenshot = 'navigation';
    agent._captureAutoScreenshot = async () => {
      throw new Error('navigation-only auto-screenshot must suppress non-navigation field capture');
    };
    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_12',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 10, y: 10, w: 120, h: 24 },
      fieldMeta: { toolbarCandidate: candidate },
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    const noScreenshotFamilyPreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_12', text: 'Paris' },
      { supportsVision: true },
    );
    if (
      !noScreenshotFamilyPreflight.block?.wrongTarget
      || noScreenshotFamilyPreflight.block.visualTargetAudit?.source !== 'structural_fallback'
      || noScreenshotFamilyPreflight.block.dispatched !== false
      || noScreenshotFamilyPreflight.shot
    ) {
      throw new Error(`expected no-screenshot nonnumeric toolbar preflight to fail closed: ${JSON.stringify(noScreenshotFamilyPreflight)}`);
    }
    agent._resetRichTextToolbarAudit(tabId);

    agent._probeRichTextToolbarRetryTarget = async () => ({
      resolved: true,
      refId: 'ref_20',
      documentToken: 'doc-a',
      refScopeUrl: 'https://example.test/editor',
      rect: { x: 10, y: 10, w: 24, h: 18 },
      fieldMeta: {
        toolbarCandidate: {
          score: 8,
          reasons: ['unlabelled_text_control', 'compact_control', 'numeric_preset_value', 'semantic_toolbar'],
          relatedRefs: ['ref_20', 'ref_21'],
          regionRef: 'ref_10',
          associatedEditorRef: 'ref_99',
        },
      },
      toolbarContext: true,
      toolbarRegionRef: 'ref_10',
    });
    const structuralPreflight = await agent._preflightRichTextToolbarTarget(
      tabId,
      'set_field',
      { ref_id: 'ref_20', text: 'This is document content, not a size preset.' },
      { supportsVision: true },
    );
    if (!structuralPreflight.block?.wrongTarget || structuralPreflight.block.visualTargetAudit?.source !== 'structural_fallback' || structuralPreflight.block.dispatched !== false) {
      throw new Error(`expected no-screenshot font-size mismatch preflight, got: ${JSON.stringify(structuralPreflight)}`);
    }
  }
});

// ─── main ─────────────────────────────────────────────────────────────────
// Social media downloader focus safety
test('SMD: Instagram auto mode downloads the open dialog image, not the feed', async (page) => {
  await setupSmd(page, 'https://www.instagram.com/natgeo/', `<!doctype html>
    <style>
      body { margin: 0; }
      main { display: grid; grid-template-columns: repeat(3, 220px); gap: 12px; }
      main img { width: 220px; height: 220px; object-fit: cover; }
      [role="dialog"] { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.8); }
      [role="dialog"] img { width: 640px; height: 640px; object-fit: contain; }
    </style>
    <main>
      <article>
        ${Array.from({ length: 9 }, (_, i) =>
          `<img width="220" height="220" src="https://cdninstagram.com/feed-${i}.jpg">`
        ).join('')}
      </article>
    </main>
    <div role="dialog" aria-modal="true">
      <img width="640" height="640" src="https://cdninstagram.com/open-dialog-current.jpg">
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'instagram') throw new Error(`expected instagram profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!/open-dialog-current\.jpg/.test(auto.urls[0])) {
    throw new Error(`expected dialog image, got ${auto.urls[0]}`);
  }

  const all = await collectSmd(page, 'all');
  if (all.urls.length <= 1) throw new Error(`explicit all mode should still expose bulk media, got ${all.urls.length}`);
});

test('SMD: Instagram focused video keeps blob URL ahead of poster image', async (page) => {
  await setupSmd(page, 'https://www.instagram.com/reel/abc123/', `<!doctype html>
    <style>
      body { margin: 0; }
      main img { width: 220px; height: 220px; display: block; }
      [role="dialog"] { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(0,0,0,.85); }
      video { width: 540px; height: 720px; background: #000; }
    </style>
    <main>
      <img width="220" height="220" src="https://cdninstagram.com/feed-still.jpg">
    </main>
    <div role="dialog" aria-modal="true">
      <video width="540" height="720"
        src="blob:https://www.instagram.com/focused-reel-video"
        poster="https://cdninstagram.com/focused-reel-poster.jpg"></video>
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'instagram') throw new Error(`expected instagram profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!auto.urls[0].startsWith('blob:https://www.instagram.com/focused-reel-video')) {
    throw new Error(`expected focused blob video before poster, got ${auto.urls[0]}`);
  }
});

test('SMD: main mode orders focused video before poster when caller limits to one', async (page) => {
  await setupSmd(page, 'https://www.instagram.com/p/video123/', `<!doctype html>
    <style>
      body { margin: 0; }
      main article video { width: 640px; height: 640px; background: #000; }
    </style>
    <main>
      <article>
        <video width="640" height="640"
          src="blob:https://www.instagram.com/main-post-video"
          poster="https://cdninstagram.com/main-post-poster.jpg"></video>
      </article>
    </main>`);

  const main = await collectSmd(page, 'main');
  if (main.profile !== 'instagram') throw new Error(`expected instagram profile, got ${main.profile}`);
  if (main.mode !== 'main') throw new Error(`expected main mode, got ${main.mode}`);
  if (!main.urls.length) throw new Error('expected main-mode URLs');
  if (!main.urls[0].startsWith('blob:https://www.instagram.com/main-post-video')) {
    throw new Error(`expected main-mode video before poster, got ${main.urls[0]}`);
  }
});

test('SMD: YouTube focused video prefers signed HTTP video over blob and poster', async (page) => {
  await setupSmd(page, 'https://www.youtube.com/watch?v=abc123', `<!doctype html>
    <script>
      window.ytInitialPlayerResponse = {
        streamingData: {
          formats: [
            { url: 'https://rr1---sn.googlevideo.com/videoplayback?expire=999&mime=video%2Fmp4&itag=18' }
          ]
        }
      };
    </script>
    <style>
      body { margin: 0; }
      #movie_player { width: 960px; height: 540px; }
      #movie_player video { width: 960px; height: 540px; background: #000; }
    </style>
    <div id="movie_player">
      <video width="960" height="540"
        src="blob:https://www.youtube.com/focused-player-video"
        poster="https://i.ytimg.com/vi/abc123/hqdefault.jpg"></video>
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'youtube') throw new Error(`expected youtube profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!/googlevideo\.com\/videoplayback/.test(auto.urls[0])) {
    throw new Error(`expected signed HTTP video before blob/poster, got ${auto.urls[0]}`);
  }
});

test('SMD: X photo modal wins over background timeline media', async (page) => {
  await setupSmd(page, 'https://x.com/NASA/status/123/photo/1', `<!doctype html>
    <style>
      body { margin: 0; }
      main article img { width: 300px; height: 300px; display: block; margin: 16px; }
      [aria-modal="true"] { position: fixed; inset: 0; display: grid; place-items: center; background: #000; }
      [aria-modal="true"] img { width: 720px; height: 480px; object-fit: contain; }
    </style>
    <main>
      <article data-testid="tweet">
        <div data-testid="tweetPhoto"><img width="300" height="300" src="https://pbs.twimg.com/media/background-one.jpg?name=small"></div>
        <div data-testid="tweetPhoto"><img width="300" height="300" src="https://pbs.twimg.com/media/background-two.jpg?name=small"></div>
      </article>
    </main>
    <div aria-modal="true" role="dialog">
      <div data-testid="tweetPhoto">
        <img width="720" height="480" src="https://pbs.twimg.com/media/current-photo.jpg?name=small">
      </div>
    </div>`);

  const auto = await collectSmd(page, 'auto');
  if (auto.profile !== 'twitter') throw new Error(`expected twitter profile, got ${auto.profile}`);
  if (auto.mode !== 'focused') throw new Error(`expected focused mode, got ${auto.mode}`);
  if (auto.urls.length !== 1) throw new Error(`expected one focused URL, got ${auto.urls.length}: ${auto.urls.join(', ')}`);
  if (!/current-photo\.jpg\?name=orig/.test(auto.urls[0])) {
    throw new Error(`expected upgraded modal photo URL, got ${auto.urls[0]}`);
  }
});

(async () => {
  let passed = 0, failed = 0;
  const runTests = async (browserType, entries) => {
    const browser = await browserType.launch();
    const context = await browser.newContext();
    for (const t of entries) {
      const page = await context.newPage();
      try {
        await t.fn(page);
        console.log(`  ✓ ${t.name}`);
        passed++;
      } catch (e) {
        console.log(`  ✗ ${t.name}\n    ${e.message}`);
        failed++;
      } finally {
        await page.close();
      }
    }
    await browser.close();
  };

  await runTests(chromium, tests);
  await runTests(playwrightFirefox, firefoxTests);
  console.log(`\n  ${passed} passed, ${failed} failed (${tests.length + firefoxTests.length} total)`);
  process.exit(failed > 0 ? 1 : 0);
})();
