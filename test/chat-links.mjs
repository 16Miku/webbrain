import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const readUi = (build, file) => fs.readFileSync(new URL(`../src/${build}/src/ui/${file}`, import.meta.url), 'utf8');
const formatterSource = build => {
  const source = readUi(build, 'sidepanel.js');
  const start = source.indexOf('function formatMarkdown(');
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const anchorTags = html => [...html.matchAll(/<a\b[^>]*>/g)].map(match => match[0]);
const hrefs = html => anchorTags(html).map(tag => tag.match(/\bhref="([^"]*)"/)?.[1]);

for (const build of ['chrome', 'firefox']) {
  const links = await import(`../src/${build}/src/ui/markdown-link.js`);
  const helpers = await import(`../src/${build}/src/ui/markdown-render.js`);
  const { escapeHtml } = await import(`../src/${build}/src/ui/utils.js`);
  const { renderSkillMarkdown } = await import(`../src/${build}/src/ui/skill-markdown.js`);
  const formatMarkdown = vm.runInNewContext(`(${formatterSource(build)})`, {
    ...helpers, ...links, escapeHtml, t: key => key,
    scheduleMathRender() {}, setTimeout() {},
  });

  test(`${build}: plain Google Finance URLs become complete links that open new tabs`, () => {
    const source = "Here's the Google Finance page:\n\nhttps://www.google.com/finance/quote/BZ:NASDAQ\n\nThe Hong Kong listing is https://www.google.com/finance/quote/2076:HKG.";
    const html = formatMarkdown(source);
    assert.deepEqual(hrefs(html), [
      'https://www.google.com/finance/quote/BZ:NASDAQ',
      'https://www.google.com/finance/quote/2076:HKG',
    ]);
    for (const anchor of anchorTags(html)) {
      assert.match(anchor, /\btarget="_blank"/);
      assert.match(anchor, /\brel="noopener noreferrer"/);
    }
    assert.match(html, /2076:HKG<\/a>\./);
  });

  test(`${build}: URL query parameters survive HTML escaping exactly once`, () => {
    const html = formatMarkdown('https://example.com/search?q=fish&lang=en#result');
    assert.deepEqual(hrefs(html), ['https://example.com/search?q=fish&amp;lang=en#result']);
    assert.doesNotMatch(html, /&amp;amp;/);
    assert.match(html, />https:\/\/example.com\/search\?q=fish&amp;lang=en#result<\/a>/);
  });

  test(`${build}: sentence punctuation and surrounding parentheses stay outside links`, () => {
    const html = formatMarkdown('Read (https://en.wikipedia.org/wiki/JavaScript_(programming_language)), then https://example.com/help!');
    assert.deepEqual(hrefs(html), [
      'https://en.wikipedia.org/wiki/JavaScript_(programming_language)',
      'https://example.com/help',
    ]);
    assert.match(html, /programming_language\)<\/a>\),/);
    assert.match(html, /help<\/a>!/);
  });

  test(`${build}: angle-bracket links preserve escaped surrounding text`, () => {
    const html = formatMarkdown('See <https://example.com/path>.');
    assert.deepEqual(hrefs(html), ['https://example.com/path']);
    assert.match(html, /&lt;<a\b/);
    assert.match(html, /<\/a>&gt;\./);
  });

  test(`${build}: explicit Markdown links and URL labels never become nested anchors`, () => {
    const html = formatMarkdown('[https://example.com/label](https://example.com/destination) and https://other.example/path');
    assert.deepEqual(hrefs(html), ['https://example.com/destination', 'https://other.example/path']);
    assert.match(html, />https:\/\/example.com\/label<\/a>/);
    assert.doesNotMatch(html, /<a\b[^>]*>[^<]*<a\b/);
  });

  test(`${build}: inline and fenced code remain literal while adjacent prose is linked`, () => {
    const source = '`https://inline.example/path`\n\n```text\nhttps://code.example/path\n[x](https://code.example/markdown)\n```\n\nhttps://visible.example/path';
    const html = formatMarkdown(source, { enhance: false });
    assert.deepEqual(hrefs(html), ['https://visible.example/path']);
    assert.match(html, /<code>https:\/\/inline.example\/path<\/code>/);
    assert.match(html, /<pre><code>https:\/\/code.example\/path\n\[x\]\(https:\/\/code.example\/markdown\)\n<\/code><\/pre>/);
  });

  test(`${build}: streamed and final text both linkify without duplicate markup`, () => {
    const source = 'Reference: https://example.com/article';
    for (const enhance of [false, true]) {
      const html = formatMarkdown(source, { enhance, recoverNestedMarkdown: true });
      assert.deepEqual(hrefs(html), ['https://example.com/article']);
      assert.equal(links.linkifyPlainUrls(html), html);
    }
  });

  test(`${build}: linkification skips existing HTML attributes, anchors and code elements`, () => {
    const source = '<span title="https://attribute.example/path">https://visible.example/path</span><a href="https://existing.example/path" target="_blank" rel="noopener noreferrer">https://label.example/path</a><code>https://code.example/path</code><pre>https://pre.example/path</pre>';
    const html = links.linkifyPlainUrls(source);
    assert.deepEqual(hrefs(html), ['https://visible.example/path', 'https://existing.example/path']);
    assert.match(html, /title="https:\/\/attribute.example\/path"/);
    assert.match(html, /<code>https:\/\/code.example\/path<\/code>/);
    assert.match(html, /<pre>https:\/\/pre.example\/path<\/pre>/);
  });

  test(`${build}: unsafe URL schemes never become clickable`, () => {
    const html = formatMarkdown('javascript:alert(1) data:text/html,hello file:///etc/passwd [bad](javascript:alert(1)) [data](data:text/html,bad)');
    assert.deepEqual(hrefs(html), []);
    assert.doesNotMatch(html, /<script|<img|\son\w+=/i);
  });

  test(`${build}: model-authored HTML stays text and quotes cannot add attributes`, () => {
    const html = formatMarkdown('<img src=x onerror=alert(1)> https://example.com/path" onmouseover="alert(1)');
    assert.doesNotMatch(html, /<img\b|<script\b/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.equal(anchorTags(html).length, 1);
    assert.doesNotMatch(anchorTags(html)[0], /\son\w+=/i);
    assert.deepEqual(hrefs(html), ['https://example.com/path']);
  });

  test(`${build}: Markdown images remain inert and opt out of favicon loading`, () => {
    const html = formatMarkdown('![tracking](https://tracking.example/pixel?secret=value)');
    assert.doesNotMatch(html, /<img\b/);
    assert.equal(anchorTags(html).length, 1);
    assert.match(anchorTags(html)[0], /\bdata-no-favicon(?:=|\s|>)/);
  });

  test(`${build}: link restoration cannot interpret placeholder text inside a destination`, () => {
    for (const [render, token] of [[formatMarkdown, '__CHAT_LINK_1__'], [renderSkillMarkdown, '__SKILL_LINK_1__']]) {
      const firstHref = `https://trusted.com/${token}`;
      const secondHref = 'https://x style=background-image:url(https://tracker.com/secret) x=y';
      const html = render(`[a](${firstHref}) [b](${secondHref})`, { enhance: false });
      assert.deepEqual(hrefs(html), [firstHref, secondHref]);
      assert.doesNotMatch(html, /<a\b[^>]*<a\b/);
    }
  });

  test(`${build}: literal formatter tokens cannot steal generated links or code`, () => {
    const cases = [
      [formatMarkdown, '__CHAT_LINK_0__', '[link](https://trusted.com/docs)', /<a\b[^>]*>link<\/a>/],
      [formatMarkdown, '__INLINE_0__', '`literal code`', /<code>literal code<\/code>/],
      [formatMarkdown, '__CODEBLOCK_0__', '```text\nfenced code\n```', /<pre><code>fenced code\n<\/code><\/pre>/],
      [renderSkillMarkdown, '__SKILL_LINK_0__', '[link](https://trusted.com/docs)', /<a\b[^>]*>link<\/a>/],
      [renderSkillMarkdown, '__SKILL_INLINE_CODE_0__', '`literal code`', /<code>literal code<\/code>/],
      [renderSkillMarkdown, '__SKILL_CODE_BLOCK_0__', '```text\nfenced code\n```', /<pre><code>fenced code\n<\/code><\/pre>/],
    ];
    for (const [render, token, markdown, expected] of cases) {
      const html = render(`${token}\n\n${markdown}`, { enhance: false });
      assert.ok(html.startsWith(token), `source token ${token} must stay literal`);
      assert.match(html.slice(token.length), expected);
    }
  });

  test(`${build}: code placeholders inside links and other code remain source text`, () => {
    for (const [render, inline, fenced] of [
      [formatMarkdown, '__INLINE_0__', '__CODEBLOCK_0__'],
      [renderSkillMarkdown, '__SKILL_INLINE_CODE_0__', '__SKILL_CODE_BLOCK_0__'],
    ]) {
      const source = `[inline](https://trusted.com/${inline}) [fenced](https://trusted.com/${fenced})\n\n\`${fenced}\`\n\n\`\`\`text\n${inline}\n\`\`\``;
      const html = render(source, { enhance: false });
      assert.deepEqual(hrefs(html), [`https://trusted.com/${inline}`, `https://trusted.com/${fenced}`]);
      assert.ok(html.includes(`<code>${fenced}</code>`));
      assert.ok(html.includes(`<pre><code>${inline}\n</code></pre>`));
    }
  });

  test(`${build}: current placeholder namespaces in model text remain literal`, () => {
    const tokens = ['WBMD0TOKEN0END', 'WBMD1TOKEN1END', 'WBMD2TOKEN2END'];
    for (const render of [formatMarkdown, renderSkillMarkdown]) {
      const source = `${tokens.join(' ')}\n\n[a](https://trusted.com/${tokens[0]}) [b](https://trusted.com/${tokens[1]})\n\n\`${tokens[2]}\``;
      const html = render(source, { enhance: false });
      assert.ok(html.startsWith(tokens.join(' ')));
      assert.deepEqual(hrefs(html), [`https://trusted.com/${tokens[0]}`, `https://trusted.com/${tokens[1]}`]);
      assert.ok(html.includes(`<code>${tokens[2]}</code>`));
    }
  });

  test(`${build}: inline code in destinations is escaped attribute text while labels keep code markup`, () => {
    const code = '" style="background-image:url(https://tracker.com/inline-destination)';
    for (const render of [formatMarkdown, renderSkillMarkdown]) {
      const html = render(`[label \`visible code\`](https://trusted.com/\`${code}\`)`, { enhance: false });
      assert.deepEqual(hrefs(html), [`https://trusted.com/${code.replace(/"/g, '&quot;')}`]);
      assert.match(html, />label <code>visible code<\/code><\/a>/);
      assert.equal((html.match(/<code>/g) || []).length, 1);
    }
  });

  test(`${build}: every streamed image prefix keeps its URLs out of favicon discovery`, () => {
    const images = [
      '![private](https://private.customer.com/secret)',
      '![**private**](https://private.customer.com/secret_(nested_(value)))',
      '![https://private.customer.com/label](https://private.customer.com/image)',
    ];
    for (const render of [formatMarkdown, renderSkillMarkdown]) {
      for (const image of images) {
        for (let length = 1; length <= image.length; length++) {
          const html = render(image.slice(0, length), { enhance: false, recoverNestedMarkdown: true });
          assert.doesNotMatch(html, /<img\b/);
          for (const anchor of anchorTags(html)) {
            assert.match(anchor, /\bdata-no-favicon(?:=|\s|>)/, `image prefix ${JSON.stringify(image.slice(0, length))}`);
          }
        }
      }
    }
  });

  test(`${build}: completed images and literal image syntax in code do not hide following links`, () => {
    for (const render of [formatMarkdown, renderSkillMarkdown]) {
      for (const before of ['![private](https://private.customer.com/image)', '`![private`', '```text\n![private\n```']) {
        const html = render(`${before}\n\nhttps://public.customer.com/article`, { enhance: false });
        const eligible = anchorTags(html).filter(anchor => !/\bdata-no-favicon(?:=|\s|>)/.test(anchor));
        assert.equal(eligible.length, 1, `following ordinary link stays eligible after ${before}`);
        assert.match(eligible[0], /href="https:\/\/public\.customer\.com\/article"/);
      }
    }
  });

  test(`${build}: live and restored chat preserve wildcard destinations and code`, () => {
    const source = 'https://example.com/path/*wildcard* [Docs](https://example.com/docs/*wildcard*) ![Image](https://example.com/image/*wildcard*) `https://code.example/literal`';
    const expected = ['https://example.com/path/*wildcard*', 'https://example.com/docs/*wildcard*', 'https://example.com/image/*wildcard*'];
    for (const render of [formatMarkdown, renderSkillMarkdown]) {
      const html = render(source);
      assert.deepEqual(hrefs(html), expected);
      assert.match(html, />https:\/\/example.com\/path\/\*wildcard\*<\/a>/);
      assert.doesNotMatch(html, /<img\b/);
      assert.match(html, /<code>https:\/\/code.example\/literal<\/code>/);
    }
  });

  test(`${build}: emphasized URLs keep Markdown markers out of their destinations`, () => {
    for (const render of [formatMarkdown, renderSkillMarkdown]) {
      for (const source of ['**https://example.com/path**', '*https://example.com/path*', '**See https://example.com/path**']) {
        const html = render(source);
        assert.deepEqual(hrefs(html), ['https://example.com/path']);
        assert.match(html, /<(?:strong|em)>/);
        assert.doesNotMatch(html, /\*/);
      }
      const wildcard = render('**https://example.com/*wildcard***');
      assert.deepEqual(hrefs(wildcard), ['https://example.com/*wildcard*']);
      assert.match(wildcard, /<strong><a\b/);
    }
  });

  test(`${build}: sidepanel honors Strict Secret Mode before every favicon request`, async () => {
    const source = readUi(build, 'sidepanel.js');
    const start = source.indexOf('const disposeChatLinkIcons = installChatLinkIcons(');
    const end = source.indexOf('\nwindow.addEventListener(\'pagehide\'', start);
    assert.ok(start >= 0 && end > start);
    let strictSecretMode = true;
    let installedOptions;
    const requests = [];
    const storage = { local: { get: async key => {
      assert.equal(key, 'strictSecretMode');
      return { strictSecretMode };
    } } };
    vm.runInNewContext(source.slice(start, end), {
      messagesEl: {},
      chrome: { storage }, browser: { storage },
      installChatLinkIcons(_root, options) { installedOptions = options; return () => {}; },
      fetch(url, options) { requests.push({ url, options }); return Promise.resolve('mock icon response'); },
    });
    const requestOptions = { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' };
    await assert.rejects(installedOptions.fetchImpl('https://icons.duckduckgo.com/ip3/google.com.ico', requestOptions), /Strict Secret Mode/);
    assert.equal(requests.length, 0);
    strictSecretMode = false;
    assert.equal(await installedOptions.fetchImpl('https://icons.duckduckgo.com/ip3/google.com.ico', requestOptions), 'mock icon response');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options, requestOptions);
    strictSecretMode = true;
    await assert.rejects(installedOptions.fetchImpl('https://icons.duckduckgo.com/ip3/github.com.ico', requestOptions), /Strict Secret Mode/);
    assert.equal(requests.length, 1, 'a later settings change is checked before issuing another request');
  });

  if (process.env.WEBBRAIN_CHAT_LINKS_DOM === '1') test(`${build}: native rendering prevents placeholder injection and pending-image network requests`, async () => {
    const { chromium, firefox } = await import('playwright');
    const browser = await (build === 'chrome' ? chromium : firefox).launch({ headless: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const networkRequests = [];
      context.on('request', request => {
        if (new URL(request.url()).hostname !== 'chat-links.test') networkRequests.push(request.url());
      });
      // Real browser fetches and CSS/image requests are recorded, but every
      // request is fulfilled locally, including any regression's tracking URL.
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        const file = url.pathname.slice(1);
        if (url.hostname === 'chat-links.test' && /^[\w-]+\.js$/.test(file)) {
          await route.fulfill({ contentType: 'text/javascript', body: readUi(build, file) });
        } else if (url.hostname === 'chat-links.test') {
          await route.fulfill({ contentType: 'text/html', body: '<div id="messages"><div class="message-text" id="content"></div></div>' });
        } else {
          await route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, contentType: 'text/plain', body: '' });
        }
      });
      const page = await context.newPage();
      await page.goto('http://chat-links.test/');
      await page.evaluate(async ({ formatter }) => {
        const helpers = await import('/markdown-render.js');
        const links = await import('/markdown-link.js');
        const { escapeHtml } = await import('/utils.js');
        const { renderSkillMarkdown } = await import('/skill-markdown.js');
        const { installChatLinkIcons } = await import('/chat-link-icons.js');
        const dependencies = { ...helpers, ...links, escapeHtml, t: key => key, scheduleMathRender() {}, setTimeout() {} };
        window.chatRenderers = {
          live: new Function(...Object.keys(dependencies), `return (${formatter})`)(...Object.values(dependencies)),
          saved: renderSkillMarkdown,
        };
        window.strictSecretModeForTest = true;
        window.faviconFetchAttempts = [];
        window.stopSecurityIcons = installChatLinkIcons(document.querySelector('#messages'), {
          intersectionObserverImpl: null,
          fetchImpl: (url, options) => {
            if (window.strictSecretModeForTest) throw new Error('Strict Secret Mode');
            window.faviconFetchAttempts.push(String(url));
            return fetch(url, options);
          },
        });
      }, { formatter: formatterSource(build) });

      const injectionResults = await page.evaluate(async () => {
        const content = document.querySelector('#content');
        const results = [];
        for (const [name, render] of Object.entries(window.chatRenderers)) {
          const tokens = name === 'live'
            ? ['__CHAT_LINK_1__', '__INLINE_0__', '__CODEBLOCK_0__']
            : ['__SKILL_LINK_1__', '__SKILL_INLINE_CODE_0__', '__SKILL_CODE_BLOCK_0__'];
          const payloads = [
            `[a](https://trusted.com/${tokens[0]}) [b](https://x style=background-image:url(https://tracker.com/secret) x=y)`,
            '[a](https://trusted.com/WBMD0TOKEN1END) [b](https://x style=background-image:url(https://tracker.com/current-namespace) x=y)',
            `[a](https://trusted.com/${tokens[1]}) \`" style="background-image:url(https://tracker.com/inline)\``,
            `[a](https://trusted.com/${tokens[2]})\n\n\`\`\`text\n" style="background-image:url(https://tracker.com/fenced)\n\`\`\``,
            '[label `visible code`](https://trusted.com/`" style="background-image:url(https://tracker.com/inline-destination)`)',
          ];
          for (const payload of payloads) {
            content.innerHTML = render(payload, { enhance: false });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            results.push({
              name, payload,
              unsafeAttributes: [...content.querySelectorAll('*')].flatMap(element => [...element.attributes]
                .filter(attribute => /^(?:style|srcdoc|on\w+)$/i.test(attribute.name)).map(attribute => attribute.name)),
              externalImages: [...content.querySelectorAll('img[src]')].map(image => image.getAttribute('src')).filter(src => !src.startsWith('blob:')),
              anchors: [...content.querySelectorAll('a')].map(anchor => ({ href: anchor.getAttribute('href'), target: anchor.target, rel: anchor.rel })),
              code: [...content.querySelectorAll('code')].map(code => code.textContent),
            });
          }
        }
        return results;
      });
      assert.deepEqual(networkRequests, [], 'Strict Secret Mode must not be bypassed through injected CSS or image requests');
      for (const result of injectionResults) {
        assert.deepEqual(result.unsafeAttributes, [], `${result.name}: ${result.payload}`);
        assert.deepEqual(result.externalImages, [], `${result.name}: ${result.payload}`);
        assert.equal(result.anchors.length, result.payload.includes('[b]') ? 2 : 1);
        if (result.payload.includes('visible code')) {
          assert.deepEqual(result.code, ['visible code']);
          assert.equal(result.anchors[0].href, 'https://trusted.com/" style="background-image:url(https://tracker.com/inline-destination)');
        }
        for (const anchor of result.anchors) {
          assert.equal(anchor.target, '_blank');
          assert.match(anchor.rel, /\bnoopener\b/);
          assert.match(anchor.rel, /\bnoreferrer\b/);
        }
      }

      const streamedImages = await page.evaluate(async () => {
        window.strictSecretModeForTest = false;
        const content = document.querySelector('#content');
        const images = [
          '![private](https://private.customer.com/secret)',
          '![**private**](https://private.customer.com/secret_(nested_(value)))',
          '![https://private.customer.com/label](https://private.customer.com/image)',
        ];
        const decoratedImages = [];
        const renderers = { ...window.chatRenderers, legacy: source => source };
        for (const [name, render] of Object.entries(renderers)) {
          for (const image of images) {
            for (let length = 1; length <= image.length; length++) {
              const source = image.slice(0, length);
              if (name === 'legacy') content.textContent = source;
              else content.innerHTML = render(source, { enhance: false, recoverNestedMarkdown: true });
              // Let the real MutationObserver and queued favicon work run
              // for each prefix before replacing the streamed text again.
              await new Promise(resolve => setTimeout(resolve, 0));
              if (content.querySelector('.chat-link-icon, img[src]')) decoratedImages.push({ name, source });
            }
          }
        }
        for (const legacy of [
          '![<strong>private</strong>](https://private.customer.com/secret',
          '![private](<a href="https://private.customer.com/secret">https://private.customer.com/secret</a>',
        ]) {
          content.innerHTML = legacy;
          await new Promise(resolve => setTimeout(resolve, 0));
          if (content.querySelector('.chat-link-icon, img[src]')) decoratedImages.push({ name: 'legacy split nodes', source: legacy });
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        return { decoratedImages, attempts: window.faviconFetchAttempts };
      });
      assert.deepEqual(streamedImages.decoratedImages, [], 'pending and complete image syntax must never receive favicon decoration');
      assert.deepEqual(streamedImages.attempts, [], 'image prefixes cannot trigger even a partial-host favicon lookup');
      assert.deepEqual(networkRequests, [], 'actual browser network remains silent throughout streamed image prefixes');

      const controlRequest = page.waitForRequest('https://icons.duckduckgo.com/ip3/public.customer.com.ico');
      await page.evaluate(() => {
        document.querySelector('#content').innerHTML = '<pre><code>![literal image syntax</code></pre> Ordinary link https://public.customer.com/article';
      });
      await controlRequest;
      assert.deepEqual(networkRequests, ['https://icons.duckduckgo.com/ip3/public.customer.com.ico'], 'a normal restored URL still exercises the real favicon fetch path');
      await page.evaluate(() => window.stopSecurityIcons());
    } finally {
      await browser.close();
    }
  });

  if (process.env.WEBBRAIN_CHAT_LINKS_DOM === '1') test(`${build}: native chat links, favicon privacy, failures and streaming replacements`, async () => {
    const { chromium, firefox } = await import('playwright');
    const browser = await (build === 'chrome' ? chromium : firefox).launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 480, height: 1000 } });
      // Every browser request is fulfilled locally. Favicon fetching is also
      // injected below so these checks never contact an outside service.
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        const file = url.pathname.slice(1);
        if (url.hostname === 'chat-links.test' && /^[\w-]+\.js$/.test(file)) {
          await route.fulfill({ contentType: 'text/javascript', body: readUi(build, file) });
        } else {
          await route.fulfill({ contentType: 'text/html', body: '<html data-theme="light"><body><div id="chat-container"><div id="messages"><div class="message assistant"><div class="message-content"><div id="chat-test-content" class="message-text"></div></div></div></div></div></body></html>' });
        }
      });
      const page = await context.newPage();
      await page.goto('http://chat-links.test/');
      await page.addStyleTag({ content: fs.readFileSync(new URL(`../src/${build}/styles/sidepanel.css`, import.meta.url), 'utf8') });
      await page.evaluate(async ({ formatter }) => {
        const helpers = await import('/markdown-render.js');
        const links = await import('/markdown-link.js');
        const { escapeHtml } = await import('/utils.js');
        const { installChatLinkIcons } = await import('/chat-link-icons.js');
        const dependencies = { ...helpers, ...links, escapeHtml, t: key => key, scheduleMathRender() {} };
        window.formatChatForTest = new Function(...Object.keys(dependencies), `return (${formatter})`)(...Object.values(dependencies));
        const root = document.querySelector('#chat-test-content');
        root.innerHTML = window.formatChatForTest([
          'https://www.google.com/finance/quote/BZ:NASDAQ?secret=not-an-icon-query',
          '[Hong Kong](https://www.google.com/finance/quote/2076:HKG)',
          '[Unavailable icon](https://github.com/project)',
          '[Invalid icon](https://stackoverflow.com/questions/123)',
          '[Local](http://127.0.0.1/private)',
          '[Credentials](https://user:pass@github.com/private)',
          '![Untrusted image](https://tracking.example/pixel?private=value)',
          '`https://code.example/should-not-fetch`',
        ].join('\n\n'));
        const canvas = document.createElement('canvas');
        canvas.width = 14; canvas.height = 14;
        const paint = canvas.getContext('2d');
        paint.fillStyle = '#4285f4'; paint.fillRect(0, 0, 14, 14);
        paint.fillStyle = '#fff'; paint.font = 'bold 11px sans-serif'; paint.fillText('G', 2, 11);
        const png = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
        window.chatIconRequests = [];
        window.stopChatLinkIcons = installChatLinkIcons(document.querySelector('#messages'), {
          intersectionObserverImpl: null,
          fetchImpl: async (url, options) => {
            window.chatIconRequests.push({ url: String(url), credentials: options.credentials, referrerPolicy: options.referrerPolicy, redirect: options.redirect });
            if (String(url).includes('github.com')) return new Response('', { status: 404 });
            if (String(url).includes('stackoverflow.com')) return new Response('<html>not an image</html>', { headers: { 'content-type': 'text/html' } });
            return new Response(png, { headers: { 'content-type': 'image/png' } });
          },
        });
      }, { formatter: formatterSource(build) });
      await page.waitForFunction(() => document.querySelectorAll('#chat-test-content a.chat-link-icon-ready').length === 2);
      const first = await page.evaluate(() => ({
        requests: window.chatIconRequests,
        anchors: [...document.querySelectorAll('#chat-test-content a')].map(anchor => ({
          href: anchor.href, target: anchor.target, rel: anchor.rel,
          hasImage: !!anchor.querySelector('img[src]'),
          ready: anchor.classList.contains('chat-link-icon-ready'),
        })),
        unsafeImages: [...document.querySelectorAll('#chat-test-content img[src]')].filter(image => !image.src.startsWith('blob:')).length,
        displayedText: document.querySelector('#chat-test-content').textContent,
      }));
      assert.equal(first.requests.length, 3, 'one bounded request per eligible hostname, including failed icons');
      for (const request of first.requests) {
        assert.equal(request.credentials, 'omit');
        assert.equal(request.referrerPolicy, 'no-referrer');
        assert.equal(request.redirect, 'error');
        assert.doesNotMatch(request.url, /secret|private|BZ:|2076:|questions|user:pass|tracking|127\.0\.0\.1|code\.example/);
      }
      assert.equal(first.unsafeImages, 0);
      assert.equal(first.anchors.length, 7);
      for (const anchor of first.anchors) {
        assert.equal(anchor.target, '_blank');
        assert.ok(anchor.rel.split(/\s+/).includes('noopener'));
        assert.ok(anchor.rel.split(/\s+/).includes('noreferrer'));
        if (!anchor.href.startsWith('https://www.google.com/')) assert.equal(anchor.ready, false);
      }
      assert.match(first.displayedText, /Hong Kong/);
      assert.doesNotMatch(first.displayedText, /favicon/);

      // Streaming replaces the nodes, so observer decoration must reuse the
      // cached domain icon while discovering a new link without duplicate UI.
      await page.evaluate(() => {
        document.querySelector('#chat-test-content').innerHTML = window.formatChatForTest('https://www.google.com/finance/quote/BZ:NASDAQ\n\nhttps://developer.mozilla.org/docs?private=123', { enhance: false });
      });
      await page.waitForFunction(() => document.querySelectorAll('#chat-test-content a.chat-link-icon-ready').length === 2 && window.chatIconRequests.length === 4, null, { timeout: 5000 }).catch(async error => {
        const state = await page.evaluate(() => ({
          html: document.querySelector('#chat-test-content').innerHTML,
          requests: window.chatIconRequests,
          images: [...document.images].map(image => ({ complete: image.complete, width: image.naturalWidth, src: image.src })),
        }));
        throw new Error(`${error.message}\n${JSON.stringify(state)}`);
      });
      const after = await page.evaluate(() => ({
        requests: window.chatIconRequests,
        iconCount: document.querySelectorAll('#chat-test-content .chat-link-icon').length,
        links: document.querySelectorAll('#chat-test-content a').length,
      }));
      assert.equal(after.links, 2);
      assert.equal(after.iconCount, 2);
      assert.equal(after.requests.filter(request => request.url.includes('www.google.com')).length, 1);
      assert.doesNotMatch(after.requests[3].url, /private|\/docs|\?/);

      await page.evaluate(() => {
        const legacy = document.createElement('p');
        legacy.className = 'message-text';
        legacy.id = 'restored-chat-test';
        legacy.innerHTML = 'Saved quote https://www.google.com/finance/quote/2076:HKG <code>https://code.example/literal</code> !<a href="https://example.org/legacy-image?secret=private">legacy image</a>';
        document.querySelector('#chat-test-content').append(legacy);
      });
      await page.waitForFunction(() => document.querySelectorAll('#restored-chat-test a.chat-link-icon-ready').length === 1, null, { timeout: 5000 });
      const restored = await page.evaluate(() => ({
        requests: window.chatIconRequests.length,
        links: [...document.querySelectorAll('#restored-chat-test a')].map(anchor => ({ href: anchor.href, target: anchor.target, icon: !!anchor.querySelector('.chat-link-icon') })),
        codeLinkCount: document.querySelectorAll('#restored-chat-test code a').length,
      }));
      assert.equal(restored.requests, 4, 'restored text reuses the cached icon and image syntax causes no request');
      assert.deepEqual(restored.links, [
        { href: 'https://www.google.com/finance/quote/2076:HKG', target: '_blank', icon: true },
        { href: 'https://example.org/legacy-image?secret=private', target: '_blank', icon: false },
      ]);
      assert.equal(restored.codeLinkCount, 0);

      if (process.env.WEBBRAIN_CHAT_LINKS_SCREENSHOTS) {
        await page.setViewportSize({ width: 480, height: 620 });
        await page.evaluate(() => {
          const user = document.createElement('div');
          user.className = 'message user';
          const content = document.createElement('div');
          content.className = 'message-content';
          const text = document.createElement('div');
          text.className = 'message-text';
          text.innerHTML = window.formatChatForTest('Open the [Google Finance quote](https://www.google.com/finance/quote/BZ:NASDAQ).');
          content.append(text); user.append(content);
          document.querySelector('#messages').prepend(user);
          document.querySelector('#chat-test-content').innerHTML = window.formatChatForTest([
            "Here's the Google Finance page for Kanzhun (BZ) on Nasdaq:",
            'https://www.google.com/finance/quote/BZ:NASDAQ',
            'The Hong Kong listing (2076):',
            'https://www.google.com/finance/quote/2076:HKG',
            'You can also open the [company quote](https://www.google.com/finance/quote/BZ:NASDAQ).',
            'If a site icon is unavailable, [the link still works](https://github.com/project).',
          ].join('\n\n'));
        });
        await page.waitForFunction(() => document.querySelectorAll('#chat-test-content a.chat-link-icon-ready').length === 3 && document.querySelector('.message.user a.chat-link-icon-ready'));
        await page.screenshot({ path: `${process.env.WEBBRAIN_CHAT_LINKS_SCREENSHOTS}/webbrain-chat-links-${build}.png`, fullPage: true, animations: 'disabled' });
      }

      const popupPromise = page.waitForEvent('popup');
      await page.locator('#chat-test-content a').first().click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      assert.equal(page.url(), 'http://chat-links.test/');
      assert.equal(popup.url(), 'https://www.google.com/finance/quote/BZ:NASDAQ');
      await page.evaluate(() => window.stopChatLinkIcons());
    } finally {
      await browser.close();
    }
  });
}
