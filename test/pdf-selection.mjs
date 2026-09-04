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
const selectionShortcutPath = path.join(root, 'src', 'chrome', 'src', 'content', 'selection-shortcut.js');

async function testManifestRegistration() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(manifest.mime_types_handler?.['application/pdf'], {
    handler_url: 'src/ui/pdf-handler.html',
    can_embed: false,
  });
}

async function testHandlerUsesChromeStreamAndTextLayer() {
  const html = await readFile(handlerHtmlPath, 'utf8');
  const source = await readFile(handlerJsPath, 'utf8');
  assert.match(html, /pdf-handler\.js/);
  assert.match(source, /mimeHandler\.getStreamInfo\(\)/);
  assert.match(source, /fetch\(streamInfo\.streamUrl/);
  assert.match(source, /getDocument\(\{ data:/);
  assert.match(source, /new (?:pdfjs\.)?TextLayer\(/);
  assert.match(source, /__webbrainSelectionShortcutConfig/);
  assert.match(source, /allowNestedFrame: true/);
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
