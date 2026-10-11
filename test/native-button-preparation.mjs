import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

// Firefox has no CDP/native-button preparation branch. Exercise Chrome's real
// content message handler and AX references; preparation must never click.
const scripts = await Promise.all([
  'accessibility-tree.js', 'rich-text-toolbar-heuristic.js', 'content.js',
].map(name => readFile(new URL(`../src/chrome/src/content/${name}`, import.meta.url), 'utf8')));

const html = `<!doctype html><style>
  body{margin:20px}#owner{width:280px}button{width:160px;height:44px}
  #label{pointer-events:none}#cover{position:fixed;background:white;z-index:999}
  #nested{display:flex;width:100%;height:100%;align-items:center;justify-content:center}
</style><main id="owner"><h1>Owned local composer</h1>
  <textarea aria-label="Draft">Local fixture draft</textarea>
  <button id="publish" type="button"><span id="label">Post</span></button>
</main><script>window.qaClicks=0;publish.addEventListener('click',()=>qaClicks++);</script>`;

test('Chrome native button preparation respects effective pointer events and actual physical targets', async t => {
  const browser = await chromium.launch({ headless: true });
  try {
    async function fixture(variant) {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.setContent(html);
      await page.evaluate(() => {
        window.qaListeners = [];
        window.chrome = { runtime: {
          getURL: path => path,
          sendMessage: (_message, callback) => { callback?.({}); return Promise.resolve({}); },
          onMessage: { addListener: listener => qaListeners.push(listener) },
        } };
        window.qaMessage = message => new Promise(resolve => {
          for (const listener of qaListeners) {
            let answered = false;
            const returned = listener(message, {}, value => { answered = true; resolve(value); });
            if (answered || returned === true) return;
          }
          resolve(undefined);
        });
      });
      for (const content of scripts) await page.addScriptTag({ content });
      await page.evaluate(variant => {
        const button = document.querySelector('#publish'), owner = button.parentElement;
        if (variant === 'ancestor-pointer-none') {
          owner.style.pointerEvents = 'none'; button.style.pointerEvents = 'auto';
        } else if (variant === 'target-pointer-none') button.style.pointerEvents = 'none';
        else if (variant === 'cover') {
          const rect = button.getBoundingClientRect(), cover = document.createElement('div');
          cover.id = 'cover';
          Object.assign(cover.style, { left: `${rect.left}px`, top: `${rect.top}px`,
            width: `${rect.width}px`, height: `${rect.height}px` });
          document.body.append(cover);
        } else if (variant === 'nested-control') {
          const control = document.createElement('span');
          control.id = 'nested'; control.setAttribute('role', 'button');
          control.textContent = 'Other action'; button.replaceChildren(control);
        } else if (variant === 'ancestor-display-none') owner.style.display = 'none';
        else if (variant === 'ancestor-visibility-hidden') {
          owner.style.visibility = 'hidden'; button.style.visibility = 'visible';
        } else if (variant === 'ancestor-transparent') owner.style.opacity = '0';
      }, variant);
      return page;
    }

    for (const [variant, allowed] of [
      ['passive-label', true], ['ancestor-pointer-none', true],
      ['cover', false], ['nested-control', false], ['target-pointer-none', false],
      ['ancestor-display-none', false], ['ancestor-visibility-hidden', false],
      ['ancestor-transparent', false],
    ]) await t.test(variant, async () => {
      const page = await fixture(variant);
      try {
        const facts = await page.evaluate(() => {
          const button = document.querySelector('#publish'), rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2),
            Math.round(rect.top + rect.height / 2));
          return { hitId: hit?.id, buttonPointerEvents: getComputedStyle(button).pointerEvents,
            ownerPointerEvents: getComputedStyle(button.parentElement).pointerEvents };
        });
        if (allowed) assert.equal(facts.hitId, 'publish', 'The inert label hits the native button itself.');
        if (variant === 'ancestor-pointer-none') {
          assert.equal(facts.buttonPointerEvents, 'auto'); assert.equal(facts.ownerPointerEvents, 'none');
        } else if (variant === 'cover') assert.equal(facts.hitId, 'cover');
        else if (variant === 'nested-control') assert.equal(facts.hitId, 'nested');
        const result = await page.evaluate(() => window.qaMessage({ target: 'content', action: 'click_ax',
          params: { ref_id: window.__wb_ax_ref(document.querySelector('#publish')),
            _prepareTrustedNativeButton: true, _requireTrustedNativeButton: true } }));
        assert.equal(result?.success, allowed, JSON.stringify(result));
        assert.equal(result.dispatched, false); assert.equal(result.noDispatch, true);
        if (allowed) {
          assert.equal(result.trustedButtonRequired, true); assert.equal(result.tag, 'button');
        }
        assert.equal(await page.evaluate(() => qaClicks), 0, 'Neither preparation nor its veto clicks.');
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
