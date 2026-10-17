// GitHub's file editor is CodeMirror 6: one .cm-line block per document line,
// with a lone placeholder BR in each empty line. Its rendered innerText
// doubles every blank line, so an exact write of a multi-paragraph file could
// never verify and the GitHub commit guard kept the commit blocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';

const post = [
  '---',
  'layout: post',
  'title: "Open-Weight Models Could Make AI an Automobile-Like Industry"',
  'date: 2026-10-17',
  '---',
  '',
  'People will still be paying around $200–$500 per month, but to inference providers like [Together](https://www.together.ai/), or through them—like leasing cars.',
  '',
  'Just as people prefer to drive to augment themselves physically, we’ll use AI/SI to augment ourselves mentally.',
  '',
  '',
  '\tIndented line with a tab',
  '',
  'Last paragraph. I\'m optimistic.',
].join('\n');

const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Each rendered line is split into highlight spans, as CodeMirror's markdown
// mode does; blank lines carry only the placeholder BR.
const line = value => value
  ? `<div class="cm-line"><span class="tok-meta">${escape(value.slice(0, 3))}</span>${escape(value.slice(3))}</div>`
  : '<div class="cm-line"><br></div>';
const editorHtml = (lines, extra = '') => `<!doctype html><meta charset="utf-8"><title>New File</title>
<div class="cm-editor"><div class="cm-scroller"><div id="editor" class="cm-content" contenteditable="true" role="textbox"
aria-multiline="true">${lines}${extra}</div></div></div>`;
const rendered = post.split('\n').map(line).join('');

async function call(page, action, params = {}) {
  return page.evaluate(({ action, params }) => new Promise(resolve => {
    window.__wb_handler({ target: 'content', action, params }, {}, resolve);
  }), { action, params });
}

for (const [kind, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${kind}: CodeMirror documents read back line for line, blank lines included`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const open = async html => {
        await page.setContent(html);
        const runtime = kind === 'firefox' ? 'browser' : 'chrome';
        await page.addScriptTag({ content: `window.${runtime}={runtime:{onMessage:{addListener(handler){window.__wb_handler=handler}}}}` });
        for (const name of ['accessibility-tree', 'rich-text-toolbar-heuristic', 'content'])
          await page.addScriptTag({ content: await readFile(new URL(`../src/${kind}/src/content/${name}.js`, import.meta.url), 'utf8') });
        await page.evaluate(() => { window.__wb_ax_lookup = id => document.getElementById(id); });
      };
      const verify = expected => call(page, 'ax_verify_field_value', { ref_id: 'editor', expected });

      await open(editorHtml(rendered));
      if (kind === 'chrome') {
        // The generic rendered text is what used to be compared.
        assert.notEqual(await page.evaluate(() => document.getElementById('editor').innerText), post,
          'Chromium innerText doubles CodeMirror blank lines');
      }
      const exact = await verify(post);
      assert.equal(exact.success, true, JSON.stringify(exact));
      assert.equal(exact.verified, true, JSON.stringify(exact));
      assert.equal(exact.actual, post.slice(0, 200));
      assert.equal((await verify(post.replace('$200–$500', '$200-$500'))).verified, false, 'One changed character never verifies');
      assert.equal((await verify(post.replace('---\n\nPeople', '---\n\n\nPeople'))).verified, false, 'An extra blank line never verifies');
      assert.equal((await verify(post + '\n')).verified, false, 'A trailing newline is a document line of its own');

      // An empty document shows CodeMirror's placeholder widget, which is not text.
      await open(editorHtml('<div class="cm-line"><img class="cm-widgetBuffer" aria-hidden="true"><span class="cm-placeholder" contenteditable="false" aria-label="placeholder Enter file contents here">Enter file contents here</span><br></div>'));
      assert.equal((await verify('')).verified, true);
      assert.equal((await verify('Enter file contents here')).verified, false);

      // A long document renders only its viewport (a gap stands in for the rest),
      // and a fold hides text behind a widget: neither establishes the document.
      await open(editorHtml(rendered, '<div class="cm-gap" style="height: 2000px"></div>'));
      assert.equal((await verify(post)).verified, false, 'A partly rendered document is never certified');
      // Even when the rendered lines alone are exactly what was asked for, the
      // gap stands for more of the document: rendered text must not certify
      // or fingerprint it.
      const head = 'line one\nline two\nline three';
      await open(editorHtml(head.split('\n').map(line).join(''), '<div class="cm-gap" style="height: 2000px"></div>'));
      const partial = await verify(head);
      assert.equal(partial.verified, false, JSON.stringify(partial));
      const partialDigest = await call(page, 'field_value_digest', { ref_id: 'editor', expected: head });
      assert.equal(partialDigest.success, false, JSON.stringify(partialDigest));
      assert.equal(partialDigest.valueSha256, undefined, 'An incomplete view has no document fingerprint');
      await open(editorHtml(post.split('\n').map(line).join('').replace('<div class="cm-line"><span class="tok-meta">Las',
        '<div class="cm-line"><span class="cm-foldPlaceholder" contenteditable="false">…</span><span class="tok-meta">Las')));
      assert.equal((await verify(post)).verified, false, 'Folded text is not readable from the DOM');
    } finally {
      await browser.close();
    }
  });
}
