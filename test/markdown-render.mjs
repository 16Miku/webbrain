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
      for (const [options, copyButton] of [[{ recoverNestedMarkdown: true }, true], [{ enhance: false, recoverNestedMarkdown: true }, false]]) {
        const html = formatMarkdown(source, options);
        assert.deepEqual(preContents(html), [helpers.escapeCodeHtml(readme)]);
        assert.equal((html.match(/class="code-copy-btn"/g) || []).length, copyButton ? 1 : 0);
        assert.match(html, /<h2>Next steps<\/h2>Review it\./);
        assert.doesNotMatch(html, /<script>|<h[1-6]>Role|<br>text<br>|<br>bash<br>/i);
      }
    }
  });

  test(`${build}: completed Markdown keeps standard fence boundaries`, () => {
    const source = '```markdown\n```js\nliteral\n```\nVisible prose\n```js\nindependent\n```\nAfter';
    const html = formatMarkdown(source);
    assert.deepEqual(preContents(html), [
      helpers.escapeCodeHtml('```js\nliteral\n'),
      helpers.escapeCodeHtml('independent\n'),
    ]);
    assert.match(html, /Visible prose/);
    assert.match(html, /After/);
    assert.deepEqual(preContents(renderSkillMarkdown(source)), [
      escapeHtml('```js\nliteral\n'),
      escapeHtml('independent\n'),
    ]);
  });

  test(`${build}: Markdown wrappers retain longer nested fences`, () => {
    const nested = '# Example\n\n````js\nconst value = true;\n````\n\n## After';
    const source = `\`\`\`markdown\n${nested}\n\`\`\`\n\n## Outside`;
    assert.deepEqual(preContents(formatMarkdown(source, { recoverNestedMarkdown: true })), [helpers.escapeCodeHtml(`${nested}\n`)]);
    assert.match(formatMarkdown(source, { recoverNestedMarkdown: true }), /<h2>Outside<\/h2>/);
  });

  test(`${build}: Markdown wrappers retain list-prefixed nested fences`, () => {
    const nested = '- ```js\n  code\n  ```\n- after\n';
    const source = `\`\`\`markdown\n${nested}\`\`\`\nOutside`;
    assert.deepEqual(preContents(formatMarkdown(source, { recoverNestedMarkdown: true })), [helpers.escapeCodeHtml(nested)]);
    assert.match(formatMarkdown(source, { recoverNestedMarkdown: true }), /Outside/);
  });

  test(`${build}: Markdown wrappers keep over-indented fences literal`, () => {
    const nested = '    ```js\nliteral\n';
    const source = `\`\`\`markdown\n${nested}\`\`\`\nAfter`;
    assert.deepEqual(preContents(formatMarkdown(source, { recoverNestedMarkdown: true })), [helpers.escapeCodeHtml(nested)]);
    assert.match(formatMarkdown(source, { recoverNestedMarkdown: true }), /After/);
  });

  test(`${build}: Markdown wrappers retain alternate nested fence markers`, () => {
    const nested = '~~~text\n```\n~~~\n';
    const source = `\`\`\`markdown\n${nested}\`\`\`\nAfter`;
    assert.deepEqual(preContents(formatMarkdown(source, { recoverNestedMarkdown: true })), [helpers.escapeCodeHtml(nested)]);
    assert.match(formatMarkdown(source, { recoverNestedMarkdown: true }), /After/);
  });

  test(`${build}: Markdown wrappers retain distant alternate fence closers`, () => {
    const nested = `~~~text\n${'```x\n'.repeat(64)}~~~\n`;
    const source = `\`\`\`markdown\n${nested}\`\`\`\nAfter`;
    assert.deepEqual(preContents(formatMarkdown(source, { recoverNestedMarkdown: true })), [helpers.escapeCodeHtml(nested)]);
    assert.match(formatMarkdown(source, { recoverNestedMarkdown: true }), /After/);
  });

  test(`${build}: Markdown wrappers leave unmatched nested fences literal`, () => {
    const nested = '```js\ncode\n';
    const source = `\`\`\`\`markdown\n${nested}\`\`\`\`\nAfter`;
    assert.deepEqual(preContents(formatMarkdown(source, { recoverNestedMarkdown: true })), [helpers.escapeCodeHtml(nested)]);
    assert.match(formatMarkdown(source, { recoverNestedMarkdown: true }), /After/);
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

  test(`${build}: opening fence indentation is excluded from code`, () => {
    const source = '  ~~~text\n  hello\n  ~~~\nAfter';
    const blocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(source, (info, code) => {
      blocks.push({ info, code });
      return 'BLOCK';
    }), 'BLOCK\nAfter');
    assert.deepEqual(blocks, [{ info: 'text', code: 'hello\n' }]);

    const indentedListFence = '    - ```text\n      hello\n      ```\nAfter';
    assert.equal(helpers.replaceMarkdownCodeFences(indentedListFence, () => 'BLOCK'), indentedListFence);

    for (const indentedContainerFence of [
      '>     > ```text\n>     > hello\n>     > ```\nAfter',
      '>     - ```text\n>     - hello\n>     - ```\nAfter',
    ]) {
      assert.equal(helpers.replaceMarkdownCodeFences(indentedContainerFence, () => 'BLOCK'), indentedContainerFence);
    }

    const excessListPadding = '-     ```text\n    literal\n    ```\nAfter';
    assert.equal(helpers.replaceMarkdownCodeFences(excessListPadding, () => 'BLOCK'), excessListPadding);

    const paddedListFence = '-   ```text\n    hello\n    ```\nAfter';
    const paddedListBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(paddedListFence, (info, code) => {
      paddedListBlocks.push({ info, code });
      return 'BLOCK';
    }), '-   BLOCK\nAfter');
    assert.deepEqual(paddedListBlocks, [{ info: 'text', code: 'hello\n' }]);
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
    assert.deepEqual(preContents(formatMarkdown(incomplete, { enhance: false, recoverNestedMarkdown: true })), [escapeHtml('```js\nconst value = true;\n```')]);
  });

  test(`${build}: streamed open fences keep headings, HTML and nested examples literal`, () => {
    for (const content of [readme, '## Heading\n<img src=x onerror=alert(1)>\n', '']) {
      const source = `\`\`\`markdown\n${content}`;
      const html = formatMarkdown(source, { enhance: false, recoverNestedMarkdown: true });
      assert.deepEqual(preContents(html), [escapeHtml(content)]);
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
      const blocks = preContents(formatMarkdown(prefix, { enhance: false, recoverNestedMarkdown: true }));
      assert.equal(blocks.length, 1, `stream prefix ${length} split the document`);
    }

    const completeAlternateExample = '```markdown\n~~~text\n```\n~~~\n';
    assert.deepEqual(
      preContents(formatMarkdown(completeAlternateExample, { enhance: false, recoverNestedMarkdown: true })),
      [escapeHtml('~~~text\n```\n~~~\n')],
    );
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
    const indentedQuote = '    > ```text\n    > literal\n    > ```';
    assert.equal(helpers.replaceMarkdownCodeFences(indentedQuote, () => 'BLOCK'), indentedQuote);
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

    const allowedCloserIndent = '- ```text\n  hello\n   ```\nAfter';
    const allowedCloserBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(allowedCloserIndent, (info, code) => {
      allowedCloserBlocks.push({ info, code });
      return 'BLOCK';
    }), '- BLOCK\nAfter');
    assert.deepEqual(allowedCloserBlocks, [{ info: 'text', code: 'hello\n' }]);
  });

  test(`${build}: list continuation fences use the preceding list indent`, () => {
    const cases = [
      ['10. Step\n    ```js\n    const value = true;\n    ```\nAfter', '10. Step\n    BLOCK\nAfter'],
      ['10. Step\n    continuation\n    ```js\n    const value = true;\n    ```\nAfter', '10. Step\n    continuation\n    BLOCK\nAfter'],
      ['> 10. Step\n>     ```js\n>     const value = true;\n>     ```\n> After', '> 10. Step\n>     BLOCK\n> After'],
      ['- > - item\n  >     ```js\n  >     const value = true;\n  >     ```\nAfter', '- > - item\n  >     BLOCK\nAfter'],
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

    const shortIndent = '- item\n  ```text\n  hello\n\nAfter';
    const shortBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(shortIndent, (info, code) => {
      shortBlocks.push({ info, code });
      return 'BLOCK';
    }), '- item\n  BLOCK\nAfter');
    assert.deepEqual(shortBlocks, [{ info: 'text', code: 'hello\n' }]);

    const extraIndent = '10. item\n    continuation\n       ```js\n       code\n       ```';
    const extraIndentBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(extraIndent, (info, code) => {
      extraIndentBlocks.push({ info, code });
      return 'BLOCK';
    }), '10. item\n    continuation\n       BLOCK');
    assert.deepEqual(extraIndentBlocks, [{ info: 'js', code: 'code\n' }]);
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

    const listQuote = '- > ```text\n  >   hello\n  > ```';
    const listQuoteBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(listQuote, (info, code) => {
      listQuoteBlocks.push({ info, code });
      return 'BLOCK';
    }), '- > BLOCK');
    assert.deepEqual(listQuoteBlocks, [{ info: 'text', code: '  hello\n' }]);

    const nestedQuoteList = '> - > ```js\n>   > code\n>   > ```';
    const nestedQuoteListBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(nestedQuoteList, (info, code) => {
      nestedQuoteListBlocks.push({ info, code });
      return 'BLOCK';
    }), '> - > BLOCK');
    assert.deepEqual(nestedQuoteListBlocks, [{ info: 'js', code: 'code\n' }]);
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
    const siblingUnfinishedFences = '- item\n  ```js\n  one\n- next\n  ```\n  two\nOutside';
    const siblingBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(siblingUnfinishedFences, (info, code) => {
      siblingBlocks.push({ info, code });
      return 'BLOCK';
    }), '- item\n  BLOCK\n- next\n  BLOCK\nOutside');
    assert.deepEqual(siblingBlocks, [{ info: 'js', code: 'one\n' }, { info: '', code: 'two\n' }]);
    assert.match(formatMarkdown(cases[0][0]), /Outside/);
    assert.match(formatMarkdown(cases[1][0]), /Next/);
    const unfinishedList = '- ```text\n  hello\n\n  again';
    const listBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(unfinishedList, (info, code) => {
      listBlocks.push({ info, code });
      return 'BLOCK';
    }), '- BLOCK');
    assert.deepEqual(listBlocks, [{ info: 'text', code: 'hello\n\nagain' }]);

    const quoteListBoundary = '  > - ```text\n  >   hello\n  > Outside\n\nAfter';
    const quoteListBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(quoteListBoundary, (info, code) => {
      quoteListBlocks.push({ info, code });
      return 'BLOCK';
    }), '  > - BLOCK\n  > Outside\n\nAfter');
    assert.deepEqual(quoteListBlocks, [{ info: 'text', code: 'hello\n' }]);

    const quoteBlank = '> ```text\n> hello\n>\n>\n> again\n> ```';
    const quoteBlankBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(quoteBlank, (info, code) => {
      quoteBlankBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK');
    assert.deepEqual(quoteBlankBlocks, [{ info: 'text', code: 'hello\n\n\nagain\n' }]);

    const unprefixedQuoteBreak = '> ```text\n> first\n\n> second\n> ```\nAfter';
    const unprefixedQuoteBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(unprefixedQuoteBreak, (info, code) => {
      unprefixedQuoteBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK\n> second\n> BLOCK\nAfter');
    assert.deepEqual(unprefixedQuoteBlocks, [{ info: 'text', code: 'first\n' }, { info: '', code: '' }]);

    const mixedQuoteListBreak = '> - ```text\n>   first\n\n>   second\n>   ```\nAfter';
    const mixedQuoteListBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(mixedQuoteListBreak, (info, code) => {
      mixedQuoteListBlocks.push({ info, code });
      return 'BLOCK';
    }), '> - BLOCK\n>   second\n>   BLOCK\nAfter');
    assert.deepEqual(mixedQuoteListBlocks, [{ info: 'text', code: 'first\n' }, { info: '', code: '' }]);

    const quotedBlankReset = '> ```text\n> first\n\n>\n> second\n> ```\nAfter';
    const quotedBlankResetBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(quotedBlankReset, (info, code) => {
      quotedBlankResetBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK\n>\n> second\n> BLOCK\nAfter');
    assert.deepEqual(quotedBlankResetBlocks, [{ info: 'text', code: 'first\n' }, { info: '', code: '' }]);

    const wideQuotedListBlank = '10. > ```text\n    > hello\n    >\n    > again\n    > ```';
    const wideQuotedListBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(wideQuotedListBlank, (info, code) => {
      wideQuotedListBlocks.push({ info, code });
      return 'BLOCK';
    }), '10. > BLOCK');
    assert.deepEqual(wideQuotedListBlocks, [{ info: 'text', code: 'hello\n\nagain\n' }]);

    const quoteListContinuation = '- item\n  > ```text\n  > hello\n  > ```\nAfter';
    const quoteListContinuationBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(quoteListContinuation, (info, code) => {
      quoteListContinuationBlocks.push({ info, code });
      return 'BLOCK';
    }), '- item\n  > BLOCK\nAfter');
    assert.deepEqual(quoteListContinuationBlocks, [{ info: 'text', code: 'hello\n' }]);

    const lazyOrderedParagraph = '- item\n2. continuation\n  ```text\n  hi\nOutside';
    const lazyOrderedParagraphBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(lazyOrderedParagraph, (info, code) => {
      lazyOrderedParagraphBlocks.push({ info, code });
      return 'BLOCK';
    }), '- item\n2. continuation\n  BLOCK\nOutside');
    assert.deepEqual(lazyOrderedParagraphBlocks, [{ info: 'text', code: 'hi\n' }]);

    for (const continuation of ['2.', '2. ', '1.', '1. ', '---text', '-_*']) {
      const source = `- item\n${continuation}\n  \`\`\`text\n  hi\nOutside`;
      const blocks = [];
      assert.equal(helpers.replaceMarkdownCodeFences(source, (info, code) => {
        blocks.push({ info, code });
        return 'BLOCK';
      }), `- item\n${continuation}\n  BLOCK\nOutside`);
      assert.deepEqual(blocks, [{ info: 'text', code: 'hi\n' }]);
    }

    for (const continuation of ['lazy continuation', '2. continuation', '2.', '---text']) {
      const source = `> - item\n> ${continuation}\n>   \`\`\`text\n>   hi\n> Outside`;
      const blocks = [];
      assert.equal(helpers.replaceMarkdownCodeFences(source, (info, code) => {
        blocks.push({ info, code });
        return 'BLOCK';
      }), `> - item\n> ${continuation}\n>   BLOCK\n> Outside`);
      assert.deepEqual(blocks, [{ info: 'text', code: 'hi\n' }]);
    }

    const noCloser = '> ```text\n> inside\nOutside';
    const noCloserBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(noCloser, (info, code) => {
      noCloserBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK\nOutside');
    assert.deepEqual(noCloserBlocks, [{ info: 'text', code: 'inside\n' }]);

    for (const [source, expected] of [
      ['> ```text\nOutside', '> BLOCK\nOutside'],
      ['- ```text\nOutside', '- BLOCK\nOutside'],
    ]) {
      const emptyBlocks = [];
      assert.equal(helpers.replaceMarkdownCodeFences(source, (info, code) => {
        emptyBlocks.push({ info, code });
        return 'BLOCK';
      }), expected);
      assert.deepEqual(emptyBlocks, [{ info: 'text', code: '' }]);
    }

    const emptyListItem = '-\n  ```text\n  hi\nOutside';
    const emptyListBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(emptyListItem, (info, code) => {
      emptyListBlocks.push({ info, code });
      return 'BLOCK';
    }), '-\n  BLOCK\nOutside');
    assert.deepEqual(emptyListBlocks, [{ info: 'text', code: 'hi\n' }]);

    const emptyListBoundary = '-\n  ```text\n Outside';
    const emptyListBoundaryBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(emptyListBoundary, (info, code) => {
      emptyListBoundaryBlocks.push({ info, code });
      return 'BLOCK';
    }), '-\n  BLOCK\n Outside');
    assert.deepEqual(emptyListBoundaryBlocks, [{ info: 'text', code: '' }]);

    const trailingQuoteBlank = '> ```text\n> hello\n>\n';
    const trailingQuoteBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(trailingQuoteBlank, (info, code) => {
      trailingQuoteBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK');
    assert.deepEqual(trailingQuoteBlocks, [{ info: 'text', code: 'hello\n\n' }]);

    const unprefixedTrailingBlank = '> ~~~text\n> hello\n\n';
    const unprefixedTrailingBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(unprefixedTrailingBlank, (info, code) => {
      unprefixedTrailingBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK\n');
    assert.deepEqual(unprefixedTrailingBlocks, [{ info: 'text', code: 'hello\n' }]);

    const quotedBlankBeforeProse = '> ~~~text\n> hello\n>\nOutside';
    const quotedBlankBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(quotedBlankBeforeProse, (info, code) => {
      quotedBlankBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK\nOutside');
    assert.deepEqual(quotedBlankBlocks, [{ info: 'text', code: 'hello\n\n' }]);

    const escapedQuote = '> ```text\n> inside\nOutside\n> ```\nAfter';
    const quoteBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(escapedQuote, (info, code) => {
      quoteBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK\nOutside\n> BLOCK\nAfter');
    assert.deepEqual(quoteBlocks, [{ info: 'text', code: 'inside\n' }, { info: '', code: '' }]);

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

    const quotedList = '> -\t```text\n>   hello\n>   ```\nAfter';
    const quotedListBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(quotedList, (info, code) => {
      quotedListBlocks.push({ info, code });
      return 'BLOCK';
    }), '> -\tBLOCK\nAfter');
    assert.deepEqual(quotedListBlocks, [{ info: 'text', code: 'hello\n' }]);

    const quotedTab = '>   ~~~text\n> \thello\n>   ~~~';
    const quotedTabBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(quotedTab, (info, code) => {
      quotedTabBlocks.push({ info, code });
      return 'BLOCK';
    }), '> BLOCK');
    assert.deepEqual(quotedTabBlocks, [{ info: 'text', code: 'hello\n' }]);

    const nestedQuotedList = '- > -\t```text\n  > \thello\n  > \t```\nAfter';
    const nestedQuotedListBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(nestedQuotedList, (info, code) => {
      nestedQuotedListBlocks.push({ info, code });
      return 'BLOCK';
    }), '- > -\tBLOCK\nAfter');
    assert.deepEqual(nestedQuotedListBlocks, [{ info: 'text', code: 'hello\n' }]);

    const tabbedNestedQuote = '> \t> ```text\n> \t> hello\n> \t> ```\nAfter';
    const tabbedNestedQuoteBlocks = [];
    assert.equal(helpers.replaceMarkdownCodeFences(tabbedNestedQuote, (info, code) => {
      tabbedNestedQuoteBlocks.push({ info, code });
      return 'BLOCK';
    }), '> \t> BLOCK\nAfter');
    assert.deepEqual(tabbedNestedQuoteBlocks, [{ info: 'text', code: 'hello\n' }]);
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
        message.innerHTML = format(source, { recoverNestedMarkdown: true });
        const streamed = message.querySelector('pre code').textContent;
        message.innerHTML = format(source, { recoverNestedMarkdown: true });
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
