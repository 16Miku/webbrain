#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'src', 'chrome', 'manifest.json');
const handlerHtmlPath = path.join(root, 'src', 'chrome', 'src', 'ui', 'pdf-handler.html');
const handlerJsPath = path.join(root, 'src', 'chrome', 'src', 'ui', 'pdf-handler.js');
const ocrModulePath = path.join(root, 'src', 'chrome', 'src', 'agent', 'pdf-ocr.js');
const selectionShortcutPath = path.join(root, 'src', 'chrome', 'src', 'content', 'selection-shortcut.js');

async function testManifestRegistration() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(manifest.mime_types_handler?.['application/pdf'], {
    handler_url: 'src/ui/pdf-handler.html',
    can_embed: true,
  });
}

async function testHandlerUsesChromeStreamAndTextLayer() {
  const html = await readFile(handlerHtmlPath, 'utf8');
  const source = await readFile(handlerJsPath, 'utf8');
  assert.match(html, /pdf-handler\.js/);
  assert.match(source, /mimeHandler\.getStreamInfo\(\)/);
  assert.match(source, /fetch\(streamInfo\.streamUrl/);
  assert.match(source, /getDocument\(\{ data:/);
  assert.match(source, /new (?:state\.)?(?:pdfjs\.)?TextLayer\(/);
  assert.match(source, /__webbrainSelectionShortcutConfig/);
  assert.match(source, /allowNestedFrame: true/);
  assert.match(source, /streamInfo\.embedded/);
}

async function testPdfHandlerProvidesCompleteViewerControls() {
  const html = await readFile(handlerHtmlPath, 'utf8');
  const source = await readFile(handlerJsPath, 'utf8');
  for (const id of [
    'previous-page', 'page-number', 'page-count', 'next-page',
    'zoom-out', 'fit-width', 'zoom-in', 'rotate-page',
    'document-search', 'download-pdf', 'print-pdf',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `viewer control ${id} is missing`);
  }
  assert.match(source, /for \(let pageNumber = 1; pageNumber <= (?:state\.)?pdf\.numPages; pageNumber\+\+\)/);
  assert.match(source, /getTextContent\(\)/);
  assert.match(source, /scrollIntoView\(/);
  assert.match(source, /rotation/);
  assert.match(source, /URL\.createObjectURL\(/);
  assert.match(source, /(?:globalThis|window)\.print\(\)/);
  assert.match(source, /abortAndFallbackToNativeHandler/);
}

async function testScannedPdfOcrContract() {
  const html = await readFile(handlerHtmlPath, 'utf8');
  const handlerSource = await readFile(handlerJsPath, 'utf8');
  const backgroundSource = await readFile(path.join(root, 'src', 'chrome', 'src', 'background.js'), 'utf8');
  const agentSource = await readFile(path.join(root, 'src', 'chrome', 'src', 'agent', 'agent.js'), 'utf8');
  assert.match(html, /id="ocr-page"/);
  assert.match(handlerSource, /action: 'ocr_pdf_page'/);
  assert.match(handlerSource, /toDataURL\('image\/png'\)/);
  assert.match(handlerSource, /normalizePdfOcrResult/);
  assert.match(backgroundSource, /case 'ocr_pdf_page'/);
  assert.match(backgroundSource, /agent\.ocrPdfPageWithVision/);
  assert.match(agentSource, /async ocrPdfPageWithVision\(/);
}

async function testOcrNormalizationKeepsOnlyBoundedNormalizedLines() {
  const { normalizePdfOcrResult } = await import(ocrModulePath);
  const result = normalizePdfOcrResult({
    lines: [
      { text: '  Keep this text  ', x: 0.1, y: 0.2, width: 0.7, height: 0.04, confidence: 0.91 },
      { text: 'outside', x: -0.4, y: 0.8, width: 1.8, height: 0.4 },
      { text: '', x: 0.2, y: 0.2, width: 0.2, height: 0.1 },
      { text: 'pixel coordinates must fail', x: 10, y: 20, width: 100, height: 10 },
    ],
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.lines.map(line => line.text), ['Keep this text', 'outside']);
  assert.deepEqual(result.lines[1].box, { x: 0, y: 0.8, width: 1, height: 0.2 });
  assert.equal(result.lines[0].confidence, 0.91);
  assert.equal(normalizePdfOcrResult({ lines: [] }).success, false);
}

async function testFirefoxProvidesAnExplicitOnlinePdfViewerFallback() {
  const firefoxManifest = JSON.parse(await readFile(path.join(root, 'src', 'firefox', 'manifest.json'), 'utf8'));
  const firefoxBackground = await readFile(path.join(root, 'src', 'firefox', 'src', 'background.js'), 'utf8');
  const firefoxHandlerHtml = await readFile(path.join(root, 'src', 'firefox', 'src', 'ui', 'pdf-handler.html'), 'utf8');
  const firefoxHandlerSource = await readFile(path.join(root, 'src', 'firefox', 'src', 'ui', 'pdf-handler.js'), 'utf8');
  const chromeHandlerSource = await readFile(handlerJsPath, 'utf8');
  assert.ok(firefoxManifest.permissions.includes('<all_urls>'));
  assert.match(firefoxBackground, /CONTEXT_MENU_OPEN_PDF_VIEWER_ID/);
  assert.match(firefoxBackground, /pdf-handler\.html\?url=/);
  assert.match(firefoxBackground, /WB_PDF_SELECTION_SHORTCUT_SUBMIT/);
  assert.match(firefoxHandlerHtml, /pdf-handler\.js/);
  assert.match(firefoxHandlerSource, /URLSearchParams\(globalThis\.location\.search\)/);
  assert.match(firefoxHandlerSource, /fetch\(streamInfo\.streamUrl/);
  assert.match(chromeHandlerSource, /URLSearchParams\(globalThis\.location\.search\)/);
}

async function testPdfSelectionCarriesItsTabScope() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
    await page.setContent(`<!doctype html>
      <style>body { margin: 0; font: 18px/1.5 sans-serif; } #pdf-text { margin: 80px; }</style>
      <div id="pdf-text">Selectable text rendered by the PDF text layer.</div>`);
    await page.addScriptTag({ content: `
      window.__selectionMessages = [];
      window.__selectionStorage = { selectionShortcutEnabled: true, wbLocale: 'en' };
      window.__selectionRuntimeListeners = [];
      window.__selectionStorageListeners = [];
      window.chrome = {
        runtime: {
          sendMessage: async (message) => {
            if (message.type === 'WB_SELECTION_SHORTCUT_LOCALIZATION') return { ok: false };
            window.__selectionMessages.push(message);
            return { ok: true, queued: true, requiresManualOpen: false };
          },
          onMessage: { addListener: (listener) => window.__selectionRuntimeListeners.push(listener) },
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
            },
          },
          onChanged: { addListener: (listener) => window.__selectionStorageListeners.push(listener) },
        },
      };
      window.__webbrainSelectionShortcutConfig = {
        submitMessage: 'WB_PDF_SELECTION_SHORTCUT_SUBMIT',
        submitFields: { tabId: 73, originalUrl: 'https://papers.example.test/reading.pdf' },
        allowNestedFrame: true,
      };
    ` });
    await page.addScriptTag({ content: await readFile(selectionShortcutPath, 'utf8') });
    await page.waitForFunction(() => typeof window.__webbrainSelectionShortcut?.getState === 'function');
    await page.evaluate(async () => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('pdf-text'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      await new Promise(resolve => requestAnimationFrame(resolve));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await page.waitForFunction(() => window.__webbrainSelectionShortcut.getState().shortcutVisible);
    await page.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('summarize'));
    await page.waitForFunction(() => window.__selectionMessages.length === 1);
    const message = await page.evaluate(() => window.__selectionMessages[0]);
    assert.equal(message.type, 'WB_PDF_SELECTION_SHORTCUT_SUBMIT');
    assert.equal(message.tabId, 73);
    assert.equal(message.originalUrl, 'https://papers.example.test/reading.pdf');
    assert.equal(message.action, 'summarize');
    assert.match(message.selectionText, /Selectable text rendered by the PDF text layer/);
  } finally {
    await browser.close();
  }
}

async function testPdfSelectionShortcutRunsInHandlerFrame() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
    await page.setContent('<iframe id="pdf-handler-frame" srcdoc="<div id=pdf-text>Text rendered inside the PDF handler frame.</div>"></iframe>');
    const frame = page.frames().find(item => item !== page.mainFrame());
    assert.ok(frame, 'PDF handler frame was not created');
    await frame.waitForSelector('#pdf-text');
    const bootstrap = `
      window.__selectionMessages = [];
      window.__selectionStorage = { selectionShortcutEnabled: true, wbLocale: 'en' };
      window.__selectionRuntimeListeners = [];
      window.__selectionStorageListeners = [];
      window.chrome = {
        runtime: {
          sendMessage: async (message) => {
            if (message.type === 'WB_SELECTION_SHORTCUT_LOCALIZATION') return { ok: false };
            window.__selectionMessages.push(message);
            return { ok: true, queued: true, requiresManualOpen: false };
          },
          onMessage: { addListener: (listener) => window.__selectionRuntimeListeners.push(listener) },
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
            },
          },
          onChanged: { addListener: (listener) => window.__selectionStorageListeners.push(listener) },
        },
      };
      window.__webbrainSelectionShortcutConfig = {
        submitMessage: 'WB_PDF_SELECTION_SHORTCUT_SUBMIT',
        submitFields: { tabId: 91, originalUrl: 'https://papers.example.test/frame.pdf' },
        allowNestedFrame: true,
      };
    `;
    await frame.addScriptTag({ content: bootstrap });
    await frame.addScriptTag({ content: await readFile(selectionShortcutPath, 'utf8') });
    await frame.waitForFunction(() => typeof window.__webbrainSelectionShortcut?.getState === 'function', null, { timeout: 5000 });
    await frame.evaluate(async () => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('pdf-text'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      await new Promise(resolve => requestAnimationFrame(resolve));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await frame.waitForFunction(() => window.__webbrainSelectionShortcut.getState().shortcutVisible, null, { timeout: 5000 });
    await frame.evaluate(() => window.__webbrainSelectionShortcut.submitPreset('summarize'));
    await frame.waitForFunction(() => window.__selectionMessages.length === 1);
    const message = await frame.evaluate(() => window.__selectionMessages[0]);
    assert.equal(message.type, 'WB_PDF_SELECTION_SHORTCUT_SUBMIT');
    assert.equal(message.tabId, 91);
    assert.match(message.selectionText, /inside the PDF handler frame/);
  } finally {
    await browser.close();
  }
}

const tests = [
  ['manifest registers a top-level application/pdf handler', testManifestRegistration],
  ['PDF handler consumes Chrome stream info and renders a text layer', testHandlerUsesChromeStreamAndTextLayer],
  ['PDF handler provides complete viewer controls', testPdfHandlerProvidesCompleteViewerControls],
  ['scanned PDF OCR has a bounded handler/background contract', testScannedPdfOcrContract],
  ['OCR normalization keeps bounded normalized text lines', testOcrNormalizationKeepsOnlyBoundedNormalizedLines],
  ['Firefox provides an explicit online PDF viewer fallback', testFirefoxProvidesAnExplicitOnlinePdfViewerFallback],
  ['PDF selection submission carries tab scope and original URL', testPdfSelectionCarriesItsTabScope],
  ['PDF selection shortcut runs in the handler frame', testPdfSelectionShortcutRunsInHandlerFrame],
];

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${error.message}`);
  }
}
console.log(`\n${tests.length - failed} pdf selection tests passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
