import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const readUi = (build, name) => fs.readFileSync(new URL(`../src/${build}/src/ui/${name}`, import.meta.url), 'utf8');
const panelFormatter = (build) => {
  const source = readUi(build, 'sidepanel.js');
  const start = source.indexOf('function formatMarkdown(');
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
// Reduced reproduction of a model-authored README with same-length nested
// fences. Keep user traces and their private page content out of the fixture.
const readme = [
  '# Example README', '', '## Role',
  '```text', 'User request', '  |', '  v', 'Browser tools', '```', '',
  '## Usage', '```javascript', 'const marker = "```";',
  'const html = "<script>alert(1)</script>";', '```', '',
  '### Parser notes', '```bash', 'node --test parser.test.mjs', '```', '',
  '## License', 'See `LICENSE`.', '',
].join('\n');
const draft = `Here is the draft:\n\n\`\`\`markdown\n${readme}\`\`\`\n\n## Next steps\nReview it.`;
const preContents = (html) => [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(match => match[1]);

for (const build of ['chrome', 'firefox']) {
  const helpers = await import(`../src/${build}/src/ui/markdown-render.js`);
  const { sanitizeMarkdownLinks } = await import(`../src/${build}/src/ui/markdown-link.js`);
  const { escapeHtml } = await import(`../src/${build}/src/ui/utils.js`);
  const { renderSkillMarkdown } = await import(`../src/${build}/src/ui/skill-markdown.js`);
  const { historyTextFromElement } = await import(`../src/${build}/src/ui/history-text.js`);
  const formatMarkdown = vm.runInNewContext(`(${panelFormatter(build)})`, {
    ...helpers, sanitizeMarkdownLinks, escapeHtml, t: key => key,
    scheduleMathRender() {}, setTimeout() {},
  });

  test(`${build}: nested README remains one complete, copyable Markdown block`, () => {
    for (const language of ['markdown', 'md', 'MARKDOWN']) {
      const source = draft.replace('```markdown', `\`\`\`${language}`);
      for (const [options, copyButton] of [[{ streaming: true }, true], [{ enhance: false }, false]]) {
        const html = formatMarkdown(source, options);
        assert.deepEqual(preContents(html), [helpers.escapeCodeHtml(readme)]);
        assert.equal((html.match(/class="code-copy-btn"/g) || []).length, copyButton ? 1 : 0);
        assert.match(html, /<h2>Next steps<\/h2>Review it\./);
        assert.doesNotMatch(html, /<script>|<h[1-6]>Role|<br>text<br>|<br>bash<br>/i);
      }
      assert.deepEqual(preContents(renderSkillMarkdown(source)), [escapeHtml(readme)]);
    }
  });

  test(`${build}: fence length, marker and whole-line closers protect literal code`, () => {
    const cases = [
      ['````markdown', '```js\nconst x = 1;\n```\n', '````'],
      ['~~~~text', '~~~\n```\n~~~~ trailing text\n', '~~~~~'],
      ['```javascript title="sample.js"', 'const s = "```";\n~~~\n``\n``` trailing text\n', '```'],
      ['  ```text', 'literal **bold** and [link](javascript:alert(1))\n', '   ```  '],
      ['```text', '````js\n## Literal heading\n', '```'],
    ];
    for (const [open, code, close] of cases) {
      for (const newline of ['\n', '\r\n']) {
        const source = `${open}\n${code}${close}\n## Outside`.replaceAll('\n', newline);
        const blocks = [];
        const remaining = helpers.replaceMarkdownCodeFences(source, (info, value) => {
          blocks.push({ info: info.trim(), code: value });
          return 'BLOCK';
        });
        assert.deepEqual(blocks, [{ info: open.trim().replace(/^[`~]+/, ''), code: code.replaceAll('\n', newline) }]);
        assert.equal(remaining, `BLOCK${newline}## Outside`);
        assert.match(formatMarkdown(source), /<h2>Outside<\/h2>/);
      }
    }
  });

  test(`${build}: container-prefixed markers do not close an outer fenced block`, () => {
    const source = '~~~markdown\n> ~~~\n- ~~~\n> ```text\n~~~\n## Outside';
    const blocks = [];
    const remaining = helpers.replaceMarkdownCodeFences(source, (info, code) => {
      blocks.push({ info, code });
      return 'BLOCK';
    });
    assert.deepEqual(blocks, [{ info: 'markdown', code: '> ~~~\n- ~~~\n> ```text\n' }]);
    assert.equal(remaining, 'BLOCK\n## Outside');
    assert.match(formatMarkdown(source), /<h2>Outside<\/h2>/);
  });

  test(`${build}: unmatched nested example fences do not steal an outer closer`, () => {
    const source = '```markdown\n```js\nconst value = true;\n```\n\nOutside\n```\nother\n```\nAfter';
    const blocks = [];
    const remaining = helpers.replaceMarkdownCodeFences(source, (info, code) => {
      blocks.push({ info, code });
      return 'BLOCK';
    });
    assert.deepEqual(blocks, [
      { info: 'markdown', code: '```js\nconst value = true;\n' },
      { info: '', code: 'other\n' },
    ]);
    assert.equal(remaining, 'BLOCK\n\nOutside\nBLOCK\nAfter');
    assert.match(formatMarkdown(source), /Outside/);
    assert.match(formatMarkdown(source), /After/);
    const incomplete = '```markdown\n```js\nconst value = true;\n```';
    assert.deepEqual(preContents(formatMarkdown(incomplete, { enhance: false })), [escapeHtml('```js\nconst value = true;\n```')]);
  });

  test(`${build}: streamed open fences keep headings, HTML and nested examples literal`, () => {
    for (const content of [readme, '## Heading\n<img src=x onerror=alert(1)>\n', '']) {
      const source = `\`\`\`markdown\n${content}`;
      const html = formatMarkdown(source, { enhance: false });
      assert.deepEqual(preContents(html), [escapeHtml(content)]);
      assert.deepEqual(preContents(renderSkillMarkdown(source)), [escapeHtml(content)]);
      assert.doesNotMatch(html, /<h[1-6]>|<img |code-copy-btn/);
    }
    const quoted = '> ```text\n> hello\n';
    assert.match(
      renderSkillMarkdown(quoted),
      /<blockquote><pre><code>hello\n<\/code><\/pre><\/blockquote>/,
      'an unfinished quoted fence should retain its container and strip its quote marker',
    );
    const start = '```markdown\n';
    for (let length = start.length; length <= start.length + readme.length; length += 1) {
      const prefix = (start + readme).slice(0, length);
      const blocks = preContents(formatMarkdown(prefix, { enhance: false }));
      assert.equal(blocks.length, 1, `stream prefix ${length} split the document`);
    }
  });

  test(`${build}: independent code blocks retain their surrounding Markdown`, () => {
    const source = '## Start\n```js\nconst x = 1;\n```\n**Between**\n~~~bash\necho ok\n~~~\n## End';
    const html = formatMarkdown(source);
    assert.equal(preContents(html).length, 2);
    assert.match(html, /syntax-keyword/);
    assert.match(html, /<strong>Between<\/strong>/);
    assert.match(html, /<h2>End<\/h2>/);
    assert.match(renderSkillMarkdown(source), /<strong>Between<\/strong>/);
    const prose = 'Use ``` inline; this is not a block.\n    ```js\nIndented example.';
    assert.equal(helpers.replaceMarkdownCodeFences(prose, () => 'BLOCK'), prose);
  });

  test(`${build}: fences inside list and quote containers do not consume following prose`, () => {
    const cases = [
      [
        'numbered list',
        '1. ```python\n   value = "**literal**"\n   ```\n\n2. Start the server.',
        /2\. Start the server\./,
        /<ol><li><pre><code>value = &quot;\*\*literal\*\*&quot;\n<\/code><\/pre><\/li><\/ol><br><br><ol><li>Start the server\.<\/li><\/ol>/,
      ],
      [
        'list marker',
        '- ```python\n  value = "**literal**"\n  ```\n\n## Next steps\nCheck the result.',
        /<h2>Next steps<\/h2>Check the result\./,
        /<ul><li><pre><code>value = &quot;\*\*literal\*\*&quot;\n<\/code><\/pre><\/li><\/ul>/,
      ],
      [
        'wide numbered list',
        '10. ```text\n    value\n    ```\n\n## Next steps\nCheck the result.',
        /<h2>Next steps<\/h2>Check the result\./,
        /<ol><li><pre><code>value\n<\/code><\/pre><\/li><\/ol>/,
      ],
      [
        'blockquote',
        '> ```text\n> hello\n>```\n\n## Next steps\nCheck the result.',
        /<h2>Next steps<\/h2>Check the result\./,
        /<blockquote><pre><code>hello\n<\/code><\/pre><\/blockquote>/,
      ],
    ];
    for (const [label, source, followingProse, expectedContainer] of cases) {
      const html = formatMarkdown(source);
      assert.equal(preContents(html).length, 1, `${label}: fence did not render as one code block`);
      assert.doesNotMatch(html, /<strong>literal<\/strong>/, `${label}: code formatting leaked into prose`);
      assert.match(html, followingProse, `${label}: closing fence consumed following prose`);
      const historyHtml = renderSkillMarkdown(source);
      assert.match(historyHtml, expectedContainer, `${label}: code block lost its Markdown container`);
      assert.doesNotMatch(historyHtml, /&gt; hello/, `${label}: blockquote marker leaked into code`);
    }
  });

  test(`${build}: over-indented list code does not close a contained fence`, () => {
    const source = '- ```text\n      ```\n  value\n  ```\nAfter';
    const blocks = [];
    const remaining = helpers.replaceMarkdownCodeFences(source, (info, code) => {
      blocks.push({ info, code });
      return 'BLOCK';
    });
    assert.deepEqual(blocks, [{ info: 'text', code: '    ```\nvalue\n' }]);
    assert.equal(remaining, '- BLOCK\nAfter');
    assert.match(formatMarkdown(source), /After/);
  });

  test(`${build}: list continuation fences use the preceding list indent`, () => {
    const cases = [
      ['10. Step\n    ```js\n    const value = true;\n    ```\nAfter', '10. Step\n    BLOCK\nAfter'],
      ['10. Step\n    continuation\n    ```js\n    const value = true;\n    ```\nAfter', '10. Step\n    continuation\n    BLOCK\nAfter'],
      ['> 10. Step\n>     ```js\n>     const value = true;\n>     ```\n> After', '> 10. Step\n>     BLOCK\n> After'],
    ];
    for (const [source, expected] of cases) {
      const blocks = [];
      const remaining = helpers.replaceMarkdownCodeFences(source, (info, code) => {
        blocks.push({ info, code });
        return 'BLOCK';
      });
      assert.deepEqual(blocks, [{ info: 'js', code: 'const value = true;\n' }]);
      assert.equal(remaining, expected);
      assert.equal(preContents(formatMarkdown(source)).length, 1);
    }
    assert.match(renderSkillMarkdown(cases[2][0]), /<blockquote>[\s\S]*<pre><code>const value = true;\n<\/code><\/pre>/);
  });

  test(`${build}: fences in nested list and quote containers preserve following content`, () => {
    const cases = [
      ['- - ```js\n    const x = 1;\n    ```\n    **After**', '- - BLOCK\n    **After**'],
      ['- > ```js\n  > const x = 1;\n  > ```\n  After', '- > BLOCK\n  After'],
    ];
    for (const [source, expected] of cases) {
      const blocks = [];
      const remaining = helpers.replaceMarkdownCodeFences(source, (info, code) => {
        blocks.push({ info, code });
        return 'BLOCK';
      });
      assert.deepEqual(blocks, [{ info: 'js', code: 'const x = 1;\n' }]);
      assert.equal(remaining, expected);
      assert.equal(preContents(formatMarkdown(source)).length, 1);
    }
  });

  test(`${build}: unfinished container fences stop at their container boundary`, () => {
    const cases = [
      ['> ```text\n> hello\n\nOutside', '> BLOCK\nOutside'],
      ['- ```text\n  hello\n\n- Next', '- BLOCK\n- Next'],
    ];
    for (const [source, expected] of cases) {
      const blocks = [];
      const remaining = helpers.replaceMarkdownCodeFences(source, (info, code) => {
        blocks.push({ info, code });
        return 'BLOCK';
      });
      assert.deepEqual(blocks, [{ info: 'text', code: 'hello\n' }]);
      assert.equal(remaining, expected);
      assert.equal(preContents(formatMarkdown(source)).length, 1);
    }
    assert.match(formatMarkdown(cases[0][0]), /Outside/);
    assert.match(formatMarkdown(cases[1][0]), /Next/);
    const unfinishedList = '- ```text\n  hello\n\n  again';
    const listBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(unfinishedList, (info, code) => {
      listBlocks.push({ info, code });
      return 'BLOCK';
    }), '- BLOCK');
    assert.deepEqual(listBlocks, [{ info: 'text', code: 'hello\n\nagain' }]);

    const escapedQuote = '> ```text\n> inside\nOutside\n> ```\nAfter';
    const quoteBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(escapedQuote, (info, code) => {
      quoteBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK\nOutside\n> ```\nAfter');
    assert.deepEqual(quoteBlocks, [{ info: 'text', code: 'inside\n' }]);

    const laterBlock = '> ```text\n> inside\nOutside\n```js\ncode\n```\nAfter';
    const laterBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(laterBlock, (info, code) => {
      laterBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK\nOutside\nBLOCK\nAfter');
    assert.deepEqual(laterBlocks, [
      { info: 'text', code: 'inside\n' },
      { info: 'js', code: 'code\n' },
    ]);

    const adjacentBlock = '> ```text\n> inside\n```js\ncode\n```\nAfter';
    const adjacentBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(adjacentBlock, (info, code) => {
      adjacentBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK\nBLOCK\nAfter');
    assert.deepEqual(adjacentBlocks, [
      { info: 'text', code: 'inside\n' },
      { info: 'js', code: 'code\n' },
    ]);

    const quotedList = '> - ```text\n>   hello\n>\n>   again\n>   ```';
    const quotedListBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(quotedList, (info, code) => {
      quotedListBlocks.push({ info, code });
      return 'BLOCK';
    }), '> - BLOCK');
    assert.deepEqual(quotedListBlocks, [{ info: 'text', code: 'hello\n\nagain\n' }]);
  });

  test(`${build}: tab-indented list fences use visual indentation columns`, () => {
    const source = '-\t```text\n\tvalue\n\t```\nAfter';
    const blocks = [];
    const remaining = helpers.replaceMarkdownCodeFences(source, (info, code) => {
      blocks.push({ info, code });
      return 'BLOCK';
    });
    assert.deepEqual(blocks, [{ info: 'text', code: 'value\n' }]);
    assert.equal(remaining, '-\tBLOCK\nAfter');
    assert.equal(helpers.replaceMarkdownCodeFences('\t```js\nIndented example.', () => 'BLOCK'), '\t```js\nIndented example.');
  });

  test(`${build}: saved history uses an outer fence longer than all literal backticks`, () => {
    const text = value => ({ nodeType: 3, nodeValue: value });
    const element = (tagName, ...childNodes) => ({ nodeType: 1, tagName, childNodes });
    for (const code of [readme, '````markdown\n```js\nconst x = 1;\n```\n````\n']) {
      const pre = element('PRE', element('CODE', text(code)));
      pre.parentElement = { querySelector: () => ({ textContent: 'markdown' }) };
      const saved = historyTextFromElement(element('DIV', pre));
      const firstFence = saved.match(/^(`+) markdown/)[1];
      assert.ok([...code.matchAll(/`+/g)].every(match => match[0].length < firstFence.length));
      assert.deepEqual(preContents(renderSkillMarkdown(saved)), [escapeHtml(code)]);
      assert.deepEqual(preContents(formatMarkdown(saved)), [helpers.escapeCodeHtml(code)]);
    }
  });

  test(`${build}: history uses tilde fences for language labels containing backticks`, () => {
    const text = value => ({ nodeType: 3, nodeValue: value });
    const element = (tagName, ...childNodes) => ({ nodeType: 1, tagName, childNodes });
    const code = '~~~\nconst value = true;\n';
    const pre = element('PRE', element('CODE', text(code)));
    pre.parentElement = { querySelector: () => ({ textContent: '`javascript`' }) };
    const saved = historyTextFromElement(element('DIV', pre));
    assert.match(saved, /^~~~~ `javascript`\n~~~\nconst value = true;\n~~~~$/);
    const source = `${saved}\n## After`;
    assert.deepEqual(preContents(formatMarkdown(source)), [helpers.escapeCodeHtml(code)]);
    assert.match(formatMarkdown(source), /<h2>After<\/h2>/);
  });

  test(`${build}: history keeps tilde-prefixed labels separate from the fence`, () => {
    const text = value => ({ nodeType: 3, nodeValue: value });
    const element = (tagName, ...childNodes) => ({ nodeType: 1, tagName, childNodes });
    const code = 'const value = true;\n';
    const pre = element('PRE', element('CODE', text(code)));
    pre.parentElement = { querySelector: () => ({ textContent: '~lang`x' }) };
    const saved = historyTextFromElement(element('DIV', pre));
    assert.match(saved, /^~~~ ~lang`x\nconst value = true;\n~~~$/);
    const source = `${saved}\n## After`;
    assert.deepEqual(preContents(formatMarkdown(source)), [helpers.escapeCodeHtml(code)]);
    assert.match(formatMarkdown(source), /<h2>After<\/h2>/);
  });

  // Opt-in native DOM checks: WEBBRAIN_MARKDOWN_DOM=1 npm run test:markdown.
  if (process.env.WEBBRAIN_MARKDOWN_DOM === '1') test(`${build}: browser render, Copy and history round trip`, async () => {
    const { chromium, firefox } = await import('playwright');
    const browser = await (build === 'chrome' ? chromium : firefox).launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 480, height: 1000 } });
      await page.route('http://markdown.test/**', async route => {
        const name = new URL(route.request().url()).pathname.slice(1);
        if (/^[\w-]+\.js$/.test(name)) {
          await route.fulfill({ contentType: 'text/javascript', body: readUi(build, name) });
        } else {
          await route.fulfill({ contentType: 'text/html', body: '<html data-theme="light"><body><div class="message assistant"><div class="message-content" id="message"></div></div><div id="history"></div></body></html>' });
        }
      });
      await page.goto('http://markdown.test/');
      await page.addStyleTag({ content: fs.readFileSync(new URL(`../src/${build}/styles/sidepanel.css`, import.meta.url), 'utf8') });
      const result = await page.evaluate(async ({ formatter, source, expected }) => {
        const helpers = await import('/markdown-render.js');
        const { sanitizeMarkdownLinks } = await import('/markdown-link.js');
        const { escapeHtml } = await import('/utils.js');
        const { historyTextFromElement } = await import('/history-text.js');
        const { renderSkillMarkdown } = await import('/skill-markdown.js');
        const dependencies = { ...helpers, sanitizeMarkdownLinks, escapeHtml, t: key => key, scheduleMathRender() {} };
        const format = new Function(...Object.keys(dependencies), `return (${formatter})`)(...Object.values(dependencies));
        let copied = null;
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
        const message = document.querySelector('#message');
        message.innerHTML = format(source, { streaming: true });
        const streamed = message.querySelector('pre code').textContent;
        message.innerHTML = format(source, { streaming: true });
        await new Promise(resolve => setTimeout(resolve, 20));
        message.querySelector('.code-copy-btn').click();
        await Promise.resolve();
        const saved = historyTextFromElement(message);
        const history = document.querySelector('#history');
        history.innerHTML = renderSkillMarkdown(saved);
        return {
          blocks: message.querySelectorAll('pre').length,
          streamedMatches: streamed === expected,
          copiedMatches: copied === expected,
          historyMatches: history.querySelector('pre code').textContent === expected,
          historyBlocks: history.querySelectorAll('pre').length,
          nextHeading: message.querySelector('h2').textContent,
          unsafeElements: message.querySelectorAll('script, img').length,
        };
      }, { formatter: panelFormatter(build), source: draft, expected: readme });
      assert.deepEqual(result, { blocks: 1, streamedMatches: true, copiedMatches: true, historyMatches: true, historyBlocks: 1, nextHeading: 'Next steps', unsafeElements: 0 });
      if (process.env.WEBBRAIN_MARKDOWN_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.WEBBRAIN_MARKDOWN_SCREENSHOT_DIR}/${build}-markdown.png`, fullPage: true });
      }
    } finally {
      await browser.close();
    }
  });
}
