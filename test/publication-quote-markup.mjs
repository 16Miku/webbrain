import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';

// Reproduces the 40.4.1 X trace: the user pasted an answer copied from the
// chat, whose continuation lines kept Markdown quote markers. The exact body
// kept those markers, the preflight refused the correct clean draft, and the
// model then published literal '>' lines. Unit checks plus a real-DOM copy
// check of the chat renderer output; no site or account is contacted.
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async id => ({ id, url: 'https://x.com/home' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};

const pasted = 'The defining question right now: will users and enterprises keep paying for frontier subscriptions (OpenAI, Claude) while local models are good enough?\n>\n> How that plays out will reshape the entire market.\n>\n> (Setting aside geopolitics, of course.)';
const request = `${pasted}\n\n-- i like this one i did while because i think they're already good enough.\n\npls post this`;
const clean = 'The defining question right now: will users and enterprises keep paying for frontier subscriptions (OpenAI, Claude) while local models are good enough?\n\nHow that plays out will reshape the entire market.\n\n(Setting aside geopolitics, of course.)';
const contractFor = body => ({ version: 1, status: 'ready', actions: [{ id: 'p1', platform: 'twitter', account: null,
  posts: [{ body: { kind: 'exact', source: body }, media: { kind: 'count', type: 'any', format: null, min: 0, max: 0 },
    context: { kind: 'post', target: null } }] }], requirements: 'p1', prohibited: [], reason: 'Post authorized text.' });

for (const build of ['chrome', 'firefox']) {
  test(`${build}: copied Markdown quote markers are formatting, greentext keeps its characters`, async () => {
    const { publicationBodyText, normalizePublicationContract } = await import(`../src/${build}/src/agent/social-publish-contract.js`);
    assert.equal(publicationBodyText(pasted), clean);
    assert.equal(publicationBodyText(clean), clean);
    assert.equal(publicationBodyText(pasted.replace(/\n/g, '\r\n')), clean, 'CRLF pastes normalize the same way');
    // A whole copied assistant blockquote, including the first marker.
    assert.equal(publicationBodyText('> First line\n> \n> Second paragraph'), 'First line\n\nSecond paragraph');
    // Greentext: every line quoted, no empty quoted line. Keep it exact.
    assert.equal(publicationBodyText('>be me\n>wake up\n>see agent'), '>be me\n>wake up\n>see agent');
    assert.equal(publicationBodyText('> one line quote'), '> one line quote');
    assert.equal(publicationBodyText('Line one\nLine two > not a quote'), 'Line one\nLine two > not a quote');
    // The trace's actual compiler output: anchors over the pasted request.
    const contract = normalizePublicationContract(contractFor({ source: 'request',
      start: 'The defining question right now: will users and enterprises keep paying for frontier subscriptions (OpenAI, Claude) while local models are good enough?',
      end: '(Setting aside geopolitics, of course.)' }), { request });
    assert.equal(contract.actions[0].posts[0].body.value, clean);
    assert.equal(contract.actions[0].posts[0].body.value.length, 244);
  });

  test(`${build}: the preflight accepts the clean draft and refuses the quoted one`, async () => {
    const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
    const { normalizePublicationContract } = await import(`../src/${build}/src/agent/social-publish-contract.js`);
    const agent = new Agent({ getActive: () => ({ model: 'test' }), getVisionProvider: async () => null });
    const contract = normalizePublicationContract(contractFor({ source: 'request',
      start: 'The defining question right now:', end: '(Setting aside geopolitics, of course.)' }), { request });
    const snapshot = body => ({ complete: true, account: 'https://x.com/owned', posts: [{ bodyText: body, attachments: [],
      context: { kind: 'post', target: null } }] });
    agent._workflowSocialPublicationAccountIdentity = (_workflow, account) => account || '';
    const accepted = agent._socialSnapshotActionIssues(contract.actions[0], snapshot(clean));
    assert.deepEqual(accepted, [], 'the correct clean draft must be publishable');
    const quoted = agent._socialSnapshotActionIssues(contract.actions[0], snapshot(pasted));
    assert.deepEqual(quoted.map(issue => issue.reason), ['body_mismatch'], 'literal quote markers are not the requested post');
  });

  test(`${build}: the audit treats quote markers as formatting`, async () => {
    const { publicationAuditMessages } = await import(`../src/${build}/src/agent/social-publish-contract.js`);
    const [system] = publicationAuditMessages({ request }, {}, {}, {}, 'key');
    assert.match(system.content, /Markdown blockquote markers \('>' at line starts\) are formatting, not content/);
  });

  test(`${build}: chat blockquotes render without copyable markers`, async () => {
    const source = fs.readFileSync(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('function formatMarkdown('), source.indexOf('/** Adds a copy button to an entire assistant message'));
    assert.ok(body.indexOf('renderMarkdownBlockquotes(text)') > body.indexOf('renderMarkdownTables(text)')
      && body.indexOf('renderMarkdownBlockquotes(text)') < body.indexOf('renderMarkdownHeadings(text)'),
    'formatMarkdown must render quotes after tables and before headings/newlines');
    const { renderMarkdownBlockquotes } = await import(`../src/${build}/src/ui/markdown-render.js`);
    const answer = '### Option 2\n> The defining question right now: will users keep paying?\n> \n> How that plays out will reshape the entire market.\n\nAfter the quote.';
    const escaped = answer.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = renderMarkdownBlockquotes(escaped).replace(/\n/g, '<br>');
    assert.match(html, /<blockquote>The defining question right now: will users keep paying\?<br><br>How that plays out will reshape the entire market\.<\/blockquote><br>After the quote\./);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(`<div class="message-text">${html}</div>`);
      const copied = await page.locator('.message-text').evaluate(element => element.innerText);
      assert.doesNotMatch(copied, /^\s*>/m, 'copying the rendered answer must not produce quote markers');
      assert.match(copied, /The defining question right now/);
    } finally { await browser.close(); }
  });
}
