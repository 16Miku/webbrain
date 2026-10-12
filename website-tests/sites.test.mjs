import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sites, canonicalResource, evidenceSchema } from './sites.mjs';
import { scenarios, getScenarios, planTask, verifyEvidence, monitoringVariants } from './scenarios.mjs';

// Tests intercept every request; no login, external send, upload, or delete is
// performed. The override supports existing dependencies in another worktree.
const { chromium } = await import(process.env.WBTEST_PLAYWRIGHT_MODULE || 'playwright');
const marker = 'WBQA-12345678-1234-1234-1234-123456789abc';
const body = `${marker} exact fixture 🧠`;
const file = { name: `${marker}-fixture.txt`, path: 'C:/private/test/fixture.txt', sha256: 'a'.repeat(64) };
const fixture = html => `<!doctype html><meta charset="utf-8"><style>body{font:16px sans-serif}nav,main,header,a,div,span,input,textarea{min-height:2px}img,video{width:20px;height:20px}</style>${html}`;
const contexts = {
  x: { url: 'https://x.com/alice/status/1234567890123456789', expectedIdentity: 'alice' },
  whatsapp: { url: 'https://web.whatsapp.com/', expectedIdentity: '+905550000001', recipient: 'Bob QA', recipientIdentity: '+905550000002' },
  telegram: { url: 'https://web.telegram.org/k/#123456', expectedIdentity: '+905550000001', recipient: 'Bob QA', recipientIdentity: '123456' },
  bluesky: { url: 'https://bsky.app/profile/alice.bsky.social/post/3mabc1234', expectedIdentity: 'alice.bsky.social' },
  mastodon: { url: 'https://qa.mastodon.test/@alice/123456789', expectedIdentity: 'alice@qa.mastodon.test' },
  gmail: { url: 'https://mail.google.com/mail/u/0/#sent/abcdef1234567890', expectedIdentity: 'alice@example.test', recipientIdentity: 'bob@example.test', recipient: 'bob@example.test' },
  protonmail: { url: 'https://mail.proton.me/u/0/sent/abcdef1234567890', expectedIdentity: 'alice@example.test', recipientIdentity: 'bob@example.test', recipient: 'bob@example.test' },
  drive: { url: 'https://drive.google.com/drive/u/0/folders/testfolder12345', folderUrl: 'https://drive.google.com/drive/u/0/folders/testfolder12345', expectedIdentity: 'alice@example.test', recipient: 'bob@example.test', recipientIdentity: 'bob@example.test' },
};
const identityHtml = {
  x: '<button data-testid="SideNav_AccountSwitcher_Button">Alice @alice</button>',
  whatsapp: '<div data-testid="profile-drawer"><span data-testid="phone-number">+90 555 000 00 01</span></div>',
  telegram: '<div class="settings-container"><span class="phone">+90 555 000 00 01</span></div>',
  bluesky: '<nav><a href="/profile/alice.bsky.social">Profile</a></nav>',
  mastodon: '<nav class="navigation-panel__profile"><span class="account__display-name">@alice@qa.mastodon.test</span></nav>',
  gmail: '<a aria-label="Google Account: Alice (alice@example.test)">Account</a>',
  protonmail: '<div data-testid="user-dropdown:email">alice@example.test</div>',
  drive: '<a aria-label="Google Account: Alice (alice@example.test)">Account</a>',
};
const rows = {
  x: text => `<main><article data-testid="tweet"><div data-testid="User-Name"><a href="/alice">Alice</a></div><div data-testid="tweetText">${text}</div><a href="/alice/status/1234567890123456789">time</a><div data-testid="tweetPhoto"><img alt="test attachment"></div></article></main>`,
  whatsapp: text => `<div data-testid="chat-info-drawer"><span data-testid="phone-number">+90 555 000 00 02</span></div><div id="main"><header><span data-testid="conversation-info-header-chat-title">Bob QA</span></header><div data-testid="conversation-panel-messages"><div data-id="true_905550000002@c.us_ABC123456"><span data-testid="selectable-text">${text}</span><div data-testid="msg-meta"><span aria-label="Sent">✓</span></div><span data-testid="document-title">${file.name}</span></div></div></div>`,
  telegram: text => `<div class="chat"><div class="topbar"><span class="peer-title" data-peer-id="123456">Bob QA</span></div><div class="bubbles-inner"><div class="bubble is-out is-sent" data-mid="42" data-peer-id="123456"><div class="message">${text}<span class="time">10:42</span></div><span class="document-name">${file.name}</span></div></div></div>`,
  bluesky: text => `<main><div data-testid="feedItem-by-alice"><a href="/profile/alice.bsky.social">Alice</a><div data-testid="postText">${text}</div><a href="/profile/alice.bsky.social/post/3mabc1234">time</a><div data-testid="postImage"><img alt="test attachment"></div></div></main>`,
  mastodon: text => `<main><div class="status" data-id="123456789"><a class="status__display-name" href="/@alice">Alice</a><div class="status__content">${text}</div><a class="status__relative-time" href="/@alice/123456789">time</a><div class="media-gallery"><img alt="test attachment"></div></div></main>`,
  gmail: text => `<div role="main"><div class="adn" data-legacy-message-id="fedcba9876543210"><span class="gD" email="alice@example.test">Alice</span><span class="g2" email="bob@example.test">Bob</span><div class="a3s aiL">${text}</div><span class="aV3">${file.name}</span></div></div>`,
  protonmail: text => `<div class="conversation"><div class="message-container" data-message-id="fedcba9876543210"><span data-testid="message-header:from">alice@example.test</span><span data-testid="message-header:to">bob@example.test</span><div class="message-content">${text}</div><span class="attachment-name">${file.name}</span></div></div>`,
  drive: text => `<main role="main"><div role="grid"><div role="row" data-id="testfile123456789"><div role="gridcell">${text}</div><a href="/file/d/testfile123456789/view">Open</a></div></div></main>`,
};

async function withPage(id, html, run, url = contexts[id].url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fixture(html) }));
    await page.goto(url);
    await run(page);
  } finally { await browser.close(); }
}
const contextFor = (id, additions = {}) => ({ marker, body, initialBody: `${marker} initial`, revisedBody: body, revisedFilename: `${marker}-renamed.txt`, file,
  siteBinding: contexts[id], expectedIdentity: contexts[id].expectedIdentity, recipientIdentity: contexts[id].recipientIdentity, ...additions });

for (const id of Object.keys(sites)) {
  test(`${id}: independently captures exact marked body, own account, and immutable item`, async () => {
    await withPage(id, identityHtml[id] + rows[id](id === 'drive' ? file.name : body), async page => {
      const context = contextFor(id, { ...(id === 'drive' ? { body: file.name } : {}),
        stage: { id: 'runtime-stage', task() { return 'real model task'; } }, scenario: { verifier() {} }, resources: { callback() {} } });
      const evidence = await sites[id].observe(page, context);
      assert.equal(evidence.identity.matched, true, JSON.stringify(evidence.identity));
      assert.equal(evidence.count, 1);
      assert.equal(evidence.exactCount, 1);
      assert.equal(evidence.matches[0].resource.immutable, true);
      assert.equal(evidence.matches[0].markerCount, 1);
      assert.equal(evidence.scope.recipientMatched, true);
      assert.equal(JSON.stringify(evidence).includes('exact fixture'), false, 'raw body must not leave observer');
      assert.equal(evidence.selectorStatus, 'unverified-on-live-accounts');
    });
  });
  test(`${id}: refuses missing login/account identity even when matching content exists`, async () => {
    await withPage(id, rows[id](body), async page => {
      const evidence = await sites[id].observe(page, contextFor(id));
      assert.equal(evidence.blocked, true);
      assert.equal(evidence.count, null);
      assert.deepEqual(evidence.matches, []);
    });
  });
}

test('all eight workflows are concrete, scoped, and have independent evidence requirements', () => {
  assert.deepEqual(getScenarios().map(s => s.site).sort(), Object.keys(sites).sort());
  for (const scenario of scenarios) {
    assert.ok(scenario.steps.length >= 5);
    assert.ok(scenario.unsupportedFeatures.length);
    for (const stage of scenario.steps) {
      assert.equal(typeof stage.task, 'function');
      assert.ok(sites[scenario.site].actions.includes(stage.action));
      assert.equal(stage.phase, stage.expectation);
      assert.equal(stage.observeOn, stage.actor);
      if (stage.actor === 'B') assert.ok(['navigation', 'download'].includes(stage.action), 'observer B cannot send/reply/share');
      if (stage.action === 'delete') assert.ok(stage.resourceKey && stage.requiresResource);
    }
  }
  assert.ok(monitoringVariants.every(variant => variant.checkpoint && variant.localOnly));
});

test('planTask emits full natural-language tasks and selects a ledger resource by key', () => {
  const original = { id: '1234567890123456789', url: contexts.x.url, kind: 'post', immutable: true, owned: true, ledgerId: 'ledger:1', ownerIdentity: 'alice', marker };
  const context = contextFor('x', { resources: { post: original } });
  const compose = planTask({ scenario: 'x', stage: 'compose', context });
  assert.match(compose.task, /Type the complete initial body/);
  assert.equal(compose.observation.body, context.initialBody);
  const cleanup = planTask({ scenario: 'x', stage: 'cleanup', context });
  assert.match(cleanup.task, /immutable ID/);
  assert.equal(cleanup.observation.resource.id, original.id);
  assert.throws(() => planTask({ scenario: 'x', stage: 'cleanup', context: contextFor('x') }), /immutable resource/);
  assert.throws(() => planTask({ scenario: 'x', stage: 'compose', context: contextFor('x', { initialBody: 'unmarked' }) }), /exact run marker/);
});

test('reply, forward, and file transfer bodies differ while each receipt uses its matching body', () => {
  const original = { id: 'fedcba9876543210', threadId: 'abcdef1234567890', url: contexts.gmail.url, immutable: true, owned: true, ledgerId: 'ledger:1', ownerIdentity: contexts.gmail.expectedIdentity, marker };
  const context = contextFor('gmail', { resource: original });
  const reply = planTask({ scenario: 'gmail', stage: 'reply', context });
  const forward = planTask({ scenario: 'gmail', stage: 'forward', context });
  assert.notEqual(reply.observation.body, forward.observation.body);
  assert.equal(planTask({ scenario: 'gmail', stage: 'reply-receipt', context }).observation.body, reply.observation.body);
  assert.equal(planTask({ scenario: 'gmail', stage: 'forward-receipt', context }).observation.body, forward.observation.body);
});

test('wrong visible account and ambiguous account menus never pass preflight', async () => {
  await withPage('x', '<button data-testid="SideNav_AccountSwitcher_Button">@mallory</button>' + rows.x(body), async page => {
    assert.equal((await sites.x.identity(page, contexts.x)).reason, 'wrong-account');
    await page.setContent(fixture(identityHtml.x + '<a data-testid="AppTabBar_Profile_Link" href="/mallory">Other profile</a>' + rows.x(body)));
    assert.equal((await sites.x.identity(page, contexts.x)).reason, 'identity-missing-or-ambiguous');
  });
});

test('timeline author or arbitrary @mention does not establish logged-in identity', async () => {
  await withPage('x', rows.x(body) + '<div>@alice is mentioned here</div>', async page => {
    assert.equal((await sites.x.identity(page, contexts.x)).matched, false);
  });
});

test('operator selector binding still requires exactly one correct identity value', async () => {
  await withPage('gmail', '<span class="my-own-account">alice@example.test</span>' + rows.gmail(body), async page => {
    const binding = { ...contexts.gmail, identitySelector: '.my-own-account' };
    assert.equal((await sites.gmail.identity(page, binding)).matched, true);
    await page.locator('.my-own-account').evaluate(node => node.textContent = 'mallory@example.test');
    assert.equal((await sites.gmail.identity(page, binding)).matched, false);
  });
});

test('quote-only marker, prefixed marker, hidden content, and success notices cannot prove a post', async () => {
  for (const text of [`<blockquote>${body}</blockquote>unrelated`, `prefix${body}`, `<span style="display:none">${body}</span>unrelated`]) {
    await withPage('x', identityHtml.x + rows.x(text) + `<div role="status">Post sent ${body}</div>`, async page => {
      const evidence = await sites.x.observe(page, contextFor('x'));
      assert.equal(evidence.exactCount, 0);
      assert.equal(verifyEvidence({ scenario: 'x', stage: 'publish', evidence, context: contextFor('x') }).ok, false);
    });
  }
});

test('duplicate exact posts block even with separate valid canonical IDs', async () => {
  await withPage('x', identityHtml.x + rows.x(body) + rows.x(body).replaceAll('1234567890123456789', '1234567890123456790'), async page => {
    const evidence = await sites.x.observe(page, contextFor('x'));
    assert.equal(evidence.exactCount, 2);
    const verdict = verifyEvidence({ scenario: 'x', stage: 'publish', evidence, context: contextFor('x') });
    assert.equal(verdict.reason, 'duplicate-marked-items'); assert.equal(verdict.resources.length, 2);
  });
});

test('exact post passes but wrong author, unsafe quoted resource and different body do not', async () => {
  await withPage('x', identityHtml.x + rows.x(body), async page => {
    const context = contextFor('x');
    assert.equal(verifyEvidence({ scenario: 'x', stage: 'publish', evidence: await sites.x.observe(page, context), context }).ok, true);
    await page.locator('[data-testid="User-Name"] a').evaluate(node => node.setAttribute('href', '/mallory'));
    assert.equal(verifyEvidence({ scenario: 'x', stage: 'publish', evidence: await sites.x.observe(page, context), context }).reason, 'wrong-or-missing-item-author');
    await page.setContent(fixture(identityHtml.x + rows.x(body).replace('</article>', '<a href="/mallory/status/999999999">quoted post link</a></article>')));
    assert.equal((await sites.x.observe(page, context)).matches[0].resource, null);
    await page.setContent(fixture(identityHtml.x + rows.x(`${body} appended`)));
    assert.equal((await sites.x.observe(page, context)).exactCount, 0);
  });
});

test('wrong conversation phone/name or Telegram peer ID blocks receipt and send evidence', async () => {
  await withPage('whatsapp', identityHtml.whatsapp + rows.whatsapp(body).replace('+90 555 000 00 02', '+90 555 000 00 03'), async page => {
    const context = contextFor('whatsapp');
    const evidence = await sites.whatsapp.observe(page, context);
    assert.equal(evidence.scope.recipientMatched, false);
    assert.equal(verifyEvidence({ scenario: 'whatsapp', stage: 'send', evidence, context }).reason, 'wrong-or-unverified-conversation');
  });
  await withPage('telegram', identityHtml.telegram + rows.telegram(body).replace('data-mid="42" data-peer-id="123456"', 'data-mid="42" data-peer-id="999999"'), async page => {
    const context = contextFor('telegram');
    const evidence = await sites.telegram.observe(page, context);
    assert.equal(verifyEvidence({ scenario: 'telegram', stage: 'send', evidence, context }).reason, 'message-conversation-id-mismatch');
  });
});

test('actor sent receipt cannot prove observer B received; B requires incoming exact item', async () => {
  await withPage('telegram', identityHtml.telegram + rows.telegram(body), async page => {
    const context = contextFor('telegram');
    const evidence = await sites.telegram.observe(page, context);
    assert.equal(verifyEvidence({ scenario: 'telegram', stage: 'receipt', evidence, context }).reason, 'observer-incoming-message-required');
    await page.locator('.bubble').evaluate(node => node.className = 'bubble is-in');
    assert.equal(verifyEvidence({ scenario: 'telegram', stage: 'receipt', evidence: await sites.telegram.observe(page, context), context }).ok, true);
  });
});

test('mail full receiver and sender must match, and quoted earlier marker is excluded', async () => {
  await withPage('gmail', identityHtml.gmail + rows.gmail(body), async page => {
    const context = contextFor('gmail');
    const grade = evidence => verifyEvidence({ scenario: 'gmail', stage: 'send-attachment', evidence, context });
    assert.equal(grade(await sites.gmail.observe(page, context)).ok, true);
    await page.locator('.g2').evaluate(node => node.setAttribute('email', 'mallory@example.test'));
    assert.equal(grade(await sites.gmail.observe(page, context)).reason, 'exact-mail-receiver-required');
    await page.setContent(fixture(identityHtml.gmail + rows.gmail(`<div class="gmail_quote">${body}</div>unrelated`)));
    assert.equal((await sites.gmail.observe(page, context)).count, 0);
  });
});

test('mail multiple test thread messages preserve all counts while grading exactly one stage body', async () => {
  await withPage('gmail', identityHtml.gmail + rows.gmail(body) + rows.gmail(`${body}\nreply-message`).replaceAll('fedcba9876543210', 'fedcba9876543211'), async page => {
    const context = contextFor('gmail');
    const evidence = await sites.gmail.observe(page, context);
    assert.equal(evidence.count, 2);
    assert.equal(evidence.exactCount, 1);
    assert.equal(verifyEvidence({ scenario: 'gmail', stage: 'send-attachment', evidence, context }).ok, true);
  });
});

test('missing immutable chat/mail IDs blocks capture rather than granting unsafe cleanup', async () => {
  await withPage('whatsapp', identityHtml.whatsapp + rows.whatsapp(body).replace('true_905550000002@c.us_ABC123456', 'opaque-id'), async page => {
    const context = contextFor('whatsapp'); const evidence = await sites.whatsapp.observe(page, context);
    assert.equal(evidence.matches[0].resource, null);
    evidence.matches[0].direction = 'outgoing';
    assert.equal(verifyEvidence({ scenario: 'whatsapp', stage: 'send', evidence, context }).reason, 'immutable-canonical-resource-capture-required');
  });
  await withPage('gmail', identityHtml.gmail + rows.gmail(body).replace('data-legacy-message-id="fedcba9876543210"', ''), async page => {
    assert.equal((await sites.gmail.observe(page, contextFor('gmail'))).matches[0].resource, null);
  });
});

test('canonical URLs reject foreign hosts, invalid routes and configurable Mastodon instances', () => {
  assert.equal(canonicalResource('x', 'https://evil.test/alice/status/123456789'), null);
  assert.equal(canonicalResource('x', 'https://x.com/search?q=WBQA'), null);
  assert.equal(canonicalResource('mastodon', 'https://evil.test/@alice/12345', contexts.mastodon), null);
  assert.equal(canonicalResource('mastodon', contexts.mastodon.url, contexts.mastodon).ownerIdentity, contexts.mastodon.expectedIdentity);
  assert.equal(canonicalResource('drive', 'https://drive.google.com/file/d/test12345/view?usp=sharing').url, 'https://drive.google.com/file/d/test12345/view');
  assert.equal(canonicalResource('gmail', 'https://mail.google.com/mail/u/0/#inbox'), null);
});

test('cleanup refuses unowned resource, wrong owner, missing ledger and timeline absence', async () => {
  const resource = { ...canonicalResource('x', contexts.x.url), owned: true, ledgerId: 'ledger:1', marker };
  await withPage('x', identityHtml.x, async page => {
    const context = contextFor('x', { resource }); const evidence = await sites.x.observe(page, context);
    assert.equal(verifyEvidence({ scenario: 'x', stage: 'cleanup', evidence, context }).reason, 'exact-resource-deletion-not-independently-confirmed');
    for (const bad of [{ ...resource, owned: false }, { ...resource, ledgerId: null }, { ...resource, ownerIdentity: 'mallory' }, { ...resource, marker: 'another-run-marker' }]) {
      assert.equal(verifyEvidence({ scenario: 'x', stage: 'cleanup', evidence, context: { ...context, resource: bad } }).reason, 'cleanup-requires-test-owned-immutable-ledger-resource');
    }
  });
});

test('cleanup verifies explicit deletion at exact owned permalink only', async () => {
  const resource = { ...canonicalResource('x', contexts.x.url), owned: true, ledgerId: 'ledger:1', marker };
  await withPage('x', identityHtml.x + '<main><div data-testid="error-detail">This post was deleted</div></main>', async page => {
    const context = contextFor('x', { resource });
    assert.equal(verifyEvidence({ scenario: 'x', stage: 'cleanup', evidence: await sites.x.observe(page, context), context }).ok, true);
    context.resource = { ...resource, id: '777777777', url: 'https://x.com/alice/status/777777777' };
    assert.equal((await sites.x.observe(page, context)).absenceConfirmed, false);
  });
});

test('cloud model self report and unsigned manual evidence cannot pass', async () => {
  const context = contextFor('x');
  const evidence = { schema: evidenceSchema, site: 'x', url: contexts.x.url, marker, identity: { matched: true, actual: 'alice' }, count: 1, exactCount: 1 };
  assert.equal(verifyEvidence({ scenario: 'x', stage: 'publish', evidence: { ...evidence, source: 'model' }, context }).blocked, true);
  assert.equal(verifyEvidence({ scenario: 'x', stage: 'publish', evidence: { ...evidence, source: 'manual-confirmed-private' }, context }).blocked, true);
  assert.equal((await sites.x.identity(null, contexts.x)).reason, 'independent-local-observer-required');
});

test('Drive refuses another folder and requires exact viewer/file share and downloaded bytes', async () => {
  await withPage('drive', identityHtml.drive + rows.drive(file.name), async page => {
    const context = contextFor('drive', { body: file.name, siteBinding: { ...contexts.drive, folderUrl: 'https://drive.google.com/drive/u/0/folders/different' } });
    assert.equal((await sites.drive.observe(page, context)).reason, 'wrong-test-folder');
  });
  const resource = { id: 'testfile123456789', url: 'https://drive.google.com/file/d/testfile123456789/view', kind: 'file', immutable: true, ownerIdentity: contexts.drive.expectedIdentity, owned: true, ledgerId: 'ledger:1', marker };
  await withPage('drive', identityHtml.drive + `<div role="dialog" data-file-id="${resource.id}"><div role="row"><span data-email="bob@example.test">Bob</span><span>Viewer</span></div></div>`, async page => {
    const context = contextFor('drive', { resource, phase: 'shared' });
    const evidence = await sites.drive.observe(page, context);
    assert.equal(verifyEvidence({ scenario: 'drive', stage: 'share', evidence, context }).ok, true);
    assert.equal(verifyEvidence({ scenario: 'drive', stage: 'share', evidence: { ...evidence, shareResourceId: 'otherfile' }, context }).ok, false);
    const downloadEvidence = { ...evidence, download: { independent: true, resourceId: resource.id, sha256: file.sha256, bytes: 20 } };
    assert.equal(verifyEvidence({ scenario: 'drive', stage: 'download', evidence: downloadEvidence, context }).ok, true);
    downloadEvidence.download.sha256 = 'b'.repeat(64);
    assert.equal(verifyEvidence({ scenario: 'drive', stage: 'download', evidence: downloadEvidence, context }).reason, 'independent-downloaded-byte-hash-required');
  });
});

test('marked composer replacement preserves multiline/Unicode, and saved draft is a separate requirement', async () => {
  const text = `${marker} first line\nsecond 🧠`;
  await withPage('gmail', identityHtml.gmail + `<div role="dialog"><span email="bob@example.test">Bob</span><div aria-label="Message Body" role="textbox" contenteditable="true" style="white-space:pre-wrap">${text}</div></div>`, async page => {
    const context = contextFor('gmail', { body: text, revisedBody: text });
    const evidence = await sites.gmail.observe(page, context);
    assert.equal(verifyEvidence({ scenario: 'gmail', stage: 'replace-body', evidence, context }).ok, true);
    assert.equal(verifyEvidence({ scenario: 'gmail', stage: 'draft-reopen', evidence, context }).reason, 'independent-saved-draft-state-required');
  });
});

test('social observer B can prove actor A author while own account remains B', async () => {
  await withPage('x', identityHtml.x.replace('@alice', '@bob') + rows.x(body), async page => {
    const context = contextFor('x', { expectedIdentity: 'bob', expectedSender: 'alice', siteBinding: { ...contexts.x, expectedIdentity: 'bob' } });
    const evidence = await sites.x.observe(page, context);
    assert.equal(evidence.identity.actual, 'bob');
    assert.equal(evidence.matches[0].resource.ownerIdentity, 'alice');
    assert.equal(verifyEvidence({ scenario: 'x', stage: 'publish', evidence, context }).ok, true);
    assert.equal(verifyEvidence({ scenario: 'x', stage: 'publish', evidence, context: { ...context, expectedIdentity: 'alice' } }).reason, 'wrong-observer-account');
  });
});

test('social media preview must belong to the exact marked composer', async () => {
  const composer = `<div role="dialog"><div data-testid="tweetTextarea_0" contenteditable="true" style="white-space:pre-wrap">${body}</div><div data-testid="attachments"><img alt="test preview"></div></div>`;
  await withPage('x', identityHtml.x + composer, async page => {
    const context = contextFor('x');
    const evidence = await sites.x.observe(page, context);
    assert.equal(verifyEvidence({ scenario: 'x', stage: 'attach-media', evidence, context }).ok, true);
    await page.locator('[data-testid="attachments"]').evaluate(node => document.body.append(node));
    assert.equal(verifyEvidence({ scenario: 'x', stage: 'attach-media', evidence: await sites.x.observe(page, context), context }).reason, 'marked-composer-test-media-preview-required');
  });
});

test('WhatsApp cleanup requires the exact immutable tombstone in the bound conversation', async () => {
  const resource = { id: 'true_905550000002@c.us_ABC123456', conversationId: '905550000002', url: contexts.whatsapp.url, kind: 'message', immutable: true,
    owned: true, ownerIdentity: '905550000001', ledgerId: 'ledger:1', marker };
  await withPage('whatsapp', identityHtml.whatsapp + rows.whatsapp('You deleted this message').replace(`<span data-testid="document-title">${file.name}</span>`, ''), async page => {
    const context = contextFor('whatsapp', { resource });
    assert.equal(verifyEvidence({ scenario: 'whatsapp', stage: 'cleanup-text', evidence: await sites.whatsapp.observe(page, context), context }).ok, true);
    context.resource = { ...resource, id: 'true_905550000002@c.us_OTHER123456' };
    assert.equal((await sites.whatsapp.observe(page, context)).absenceConfirmed, false);
  });
});

test('Telegram row disappearance alone stays unproven instead of granting deletion success', async () => {
  const resource = { id: '123456:42', messageId: '42', conversationId: '123456', url: contexts.telegram.url, kind: 'message', immutable: true,
    owned: true, ownerIdentity: '905550000001', ledgerId: 'ledger:1', marker };
  await withPage('telegram', identityHtml.telegram + rows.telegram('a different message'), async page => {
    const context = contextFor('telegram', { resource });
    const evidence = await sites.telegram.observe(page, context);
    assert.equal(evidence.count, 0);
    assert.equal(verifyEvidence({ scenario: 'telegram', stage: 'cleanup-text', evidence, context }).ok, false);
  });
});

test('mail Trash verification identifies the recorded message, never another marked message', async () => {
  const resource = { id: 'fedcba9876543210', threadId: 'abcdef1234567890', url: contexts.gmail.url, kind: 'message', immutable: true,
    owned: true, ownerIdentity: contexts.gmail.expectedIdentity, ledgerId: 'ledger:1', marker };
  await withPage('gmail', identityHtml.gmail + rows.gmail(body), async page => {
    const context = contextFor('gmail', { resource, phase: 'trashed' });
    const evidence = await sites.gmail.observe(page, context);
    assert.equal(evidence.trashed, true);
    assert.equal(verifyEvidence({ scenario: 'gmail', stage: 'cleanup-original', evidence, context }).ok, true);
    assert.equal(verifyEvidence({ scenario: 'gmail', stage: 'cleanup-original', evidence: { ...evidence, trashedResourceId: 'another-message' }, context }).ok, false);
  }, 'https://mail.google.com/mail/u/0/#trash/abcdef1234567890');
});

test('Drive observer access requires visible exact file preview and canonical ID', async () => {
  const resource = { id: 'testfile123456789', url: 'https://drive.google.com/file/d/testfile123456789/view', kind: 'file', immutable: true,
    owned: true, ownerIdentity: contexts.drive.expectedIdentity, ledgerId: 'ledger:1', marker };
  await withPage('drive', identityHtml.drive.replace('alice@example.test', 'bob@example.test') + `<h1>${file.name}</h1><div role="document">fixture preview</div>`, async page => {
    const context = contextFor('drive', { resource, phase: 'access', body: file.name, actorIdentity: 'alice@example.test', expectedIdentity: 'bob@example.test', siteBinding: { ...contexts.drive, expectedIdentity: 'bob@example.test' } });
    const evidence = await sites.drive.observe(page, context);
    assert.equal(evidence.accessResourceId, resource.id);
    assert.equal(verifyEvidence({ scenario: 'drive', stage: 'observer-access', evidence, context }).ok, true);
    await page.locator('h1').evaluate(node => node.textContent = 'You need access');
    assert.equal((await sites.drive.observe(page, context)).accessConfirmed, false);
  }, resource.url);
});

test('planning rejects cross-account and cross-run ledger resources before a mutation task', () => {
  const resource = { ...canonicalResource('x', contexts.x.url), owned: true, ledgerId: 'ledger:1', marker };
  for (const bad of [{ ...resource, ownerIdentity: 'mallory' }, { ...resource, marker: 'old-run-marker' }]) {
    assert.throws(() => planTask({ scenario: 'x', stage: 'cleanup', context: contextFor('x', { resource: bad }) }), /exact account and run marker/);
  }
});

function inboxFixture(id, { duplicate = false, wrongSubject = false, wrongAccount = false, unsafeControl = false } = {}) {
  const account = identityHtml[id].replaceAll('alice@example.test', wrongAccount ? 'mallory@example.test' : 'bob@example.test');
  const subject = wrongSubject ? `${marker}-unrelated` : marker;
  const targetRows = id === 'gmail'
    ? `<tr class="zA"><td><span class="bog marked-subject">${subject}</span></td><td><button onclick="window.observationClicks.push('delete')">Delete</button></td></tr>`
    : `<div class="item-conversation" data-testid="message-list:item"><span class="item-subject marked-subject">${subject}</span><button onclick="window.observationClicks.push('delete')">Delete</button></div>`;
  const unrelated = id === 'gmail' ? '<tr class="zA"><td><span class="bog unrelated-subject">Private unrelated thread</span></td></tr>' : '<div class="item-conversation"><span class="item-subject unrelated-subject">Private unrelated thread</span></div>';
  const list = id === 'gmail' ? `<div role="main"><div class="ae4"><table role="grid">${unrelated}${targetRows}${duplicate ? targetRows : ''}</table></div></div>`
    : `<div data-testid="message-list">${unrelated}${targetRows}${duplicate ? targetRows : ''}</div>`;
  const details = unsafeControl ? '<button id="show-details" aria-label="Send">Send</button>' : id === 'gmail' ? '<span id="show-details" class="ajy" role="button" aria-label="Show details" aria-expanded="false">▼</span>'
    : '<button id="show-details" data-testid="message-header:show-details" aria-label="Show details" aria-expanded="false">Details</button>';
  const opened = id === 'gmail' ? `<h2 class="hP">${marker}</h2><div class="adn" data-legacy-message-id="fedcba9876543210"><span class="gD" email="alice@example.test">Alice</span>${details}<div class="a3s aiL">${body}</div><span class="aV3">${file.name}</span></div>`
    : `<div class="conversation"><h1>${marker}</h1><div class="message-container" data-message-id="fedcba9876543210"><span data-testid="message-header:from">alice@example.test</span>${details}<div class="message-content">${body}</div><span class="attachment-name">${file.name}</span></div></div>`;
  return `${account}${list}<script>
    window.observationClicks=[];
    document.querySelector('.unrelated-subject').onclick=()=>window.observationClicks.push('unrelated');
    for(const subject of document.querySelectorAll('.marked-subject'))subject.onclick=()=>{
      window.observationClicks.push('marked-subject');
      history.replaceState(null,'',${JSON.stringify(id === 'gmail' ? '#inbox/abcdef1234567890' : '/u/0/inbox/abcdef1234567890')});
      document.querySelector(${JSON.stringify(id === 'gmail' ? '[role="main"]' : '[data-testid="message-list"]')}).innerHTML=${JSON.stringify(opened)};
      document.querySelector('#show-details').onclick=function(){
        window.observationClicks.push(${JSON.stringify(unsafeControl ? 'send' : 'details')});
        this.setAttribute('aria-expanded','true');
        const recipient=document.createElement('span');
        ${id === 'gmail' ? "recipient.className='g2';recipient.setAttribute('email','bob@example.test');" : "recipient.setAttribute('data-testid','message-header:to');"}
        recipient.textContent='To Bob <bob@example.test>';this.parentElement.append(recipient);
      };
    };
  </script>`;
}

for (const id of ['gmail', 'protonmail']) {
  test(`${id}: preparation opens only the exact marked inbox subject and exposes its own receiver headers`, async () => {
    await withPage(id, inboxFixture(id), async page => {
      const context = contextFor(id, { expectedIdentity: 'bob@example.test', expectedSender: 'alice@example.test', phase: 'resource',
        siteBinding: { ...contexts[id], expectedIdentity: 'bob@example.test' }, observationTimeoutMs: 1000 });
      const prepared = await sites[id].prepareObservation(page, context);
      assert.equal(prepared.prepared, true, JSON.stringify(prepared));
      assert.equal(prepared.openedThread, true);
      assert.equal(prepared.expandedHeaders, 1);
      assert.deepEqual(await page.evaluate(() => window.observationClicks), ['marked-subject', 'details']);
      const evidence = await sites[id].observe(page, context);
      assert.equal(evidence.identity.actual, 'bob@example.test');
      assert.equal(evidence.matches[0].recipientMatched, true);
      assert.equal(verifyEvidence({ scenario: id, stage: 'receipt', evidence, context }).ok, true);
      const again = await sites[id].prepareObservation(page, context);
      assert.equal(again.expandedHeaders, 0, 'preparation must not toggle an already expanded details control');
      assert.deepEqual(await page.evaluate(() => window.observationClicks), ['marked-subject', 'details']);
    }, id === 'gmail' ? 'https://mail.google.com/mail/u/0/#inbox' : 'https://mail.proton.me/u/0/inbox');
  });
  test(`${id}: preparation refuses wrong account, duplicate subject, and prefix-subject matches before any click`, async () => {
    for (const options of [{ wrongAccount: true }, { duplicate: true }, { wrongSubject: true }]) {
      await withPage(id, inboxFixture(id, options), async page => {
        const context = contextFor(id, { expectedIdentity: 'bob@example.test', expectedSender: 'alice@example.test', phase: 'resource', siteBinding: { ...contexts[id], expectedIdentity: 'bob@example.test' } });
        const prepared = await sites[id].prepareObservation(page, context);
        assert.equal(prepared.blocked, true);
        assert.deepEqual(await page.evaluate(() => window.observationClicks), []);
      }, id === 'gmail' ? 'https://mail.google.com/mail/u/0/#inbox' : 'https://mail.proton.me/u/0/inbox');
    }
  });
}

test('private header selector aliases still cannot click a Send control', async () => {
  await withPage('gmail', inboxFixture('gmail', { unsafeControl: true }), async page => {
    const context = contextFor('gmail', { expectedIdentity: 'bob@example.test', expectedSender: 'alice@example.test', phase: 'resource',
      siteBinding: { ...contexts.gmail, expectedIdentity: 'bob@example.test', headerDetailsSelector: '#show-details' } });
    const prepared = await sites.gmail.prepareObservation(page, context);
    assert.equal(prepared.expandedHeaders, 0);
    assert.deepEqual(await page.evaluate(() => window.observationClicks), ['marked-subject']);
    assert.equal(verifyEvidence({ scenario: 'gmail', stage: 'receipt', evidence: await sites.gmail.observe(page, context), context }).ok, false);
  }, 'https://mail.google.com/mail/u/0/#inbox');
});

test('Gmail full header To table is distinct from From and read only inside the marked message', async () => {
  await withPage('gmail', identityHtml.gmail + rows.gmail(body).replace('<span class="g2" email="bob@example.test">Bob</span>', '<table class="ajC"><tr><td>from:</td><td>alice@example.test</td></tr><tr><td>to:</td><td>Bob &lt;bob@example.test&gt;</td></tr></table>'), async page => {
    const evidence = await sites.gmail.observe(page, contextFor('gmail'));
    assert.deepEqual(evidence.matches[0].recipients, ['bob@example.test']);
    assert.equal(evidence.matches[0].recipientMatched, true);
  });
});

test('chat preparation navigates only an explicitly configured same-site conversation and checks its exact identity', async () => {
  await withPage('telegram', identityHtml.telegram + rows.telegram(body), async page => {
    const context = contextFor('telegram', { siteBinding: { ...contexts.telegram, observerConversationUrl: 'https://web.telegram.org/k/#123456' } });
    assert.equal((await sites.telegram.prepareObservation(page, context)).prepared, true);
    context.siteBinding.observerConversationUrl = 'https://evil.test/private';
    assert.equal((await sites.telegram.prepareObservation(page, context)).reason, 'wrong-observer-conversation-origin');
    context.siteBinding.observerConversationUrl = contexts.telegram.url;
    context.recipientIdentity = '999999';
    assert.equal((await sites.telegram.prepareObservation(page, context)).reason, 'wrong-or-unverified-conversation');
  });
});

test('Drive direct-file download accepts exact owned resource and byte hash without folder DOM', async () => {
  const resource = { id: 'testfile123456789', url: 'https://drive.google.com/file/d/testfile123456789/view', kind: 'file', immutable: true,
    owned: true, ownerIdentity: contexts.drive.expectedIdentity, ledgerId: 'ledger:1', marker };
  await withPage('drive', identityHtml.drive + `<h1>${file.name}</h1><div role="document">fixture preview</div>`, async page => {
    const context = contextFor('drive', { resource, phase: 'download' });
    const evidence = await sites.drive.observe(page, context);
    assert.equal(evidence.scope.folderScoped, false);
    evidence.download = { independent: true, resourceId: resource.id, sha256: file.sha256, bytes: 20 };
    assert.equal(verifyEvidence({ scenario: 'drive', stage: 'download', evidence, context }).ok, true);
  }, resource.url);
});

test('WhatsApp target tombstone proves cleanup while another owned stage body remains visible', async () => {
  const resource = { id: 'true_905550000002@c.us_ABC123456', conversationId: '905550000002', url: contexts.whatsapp.url, kind: 'message', immutable: true,
    owned: true, ownerIdentity: '905550000001', ledgerId: 'ledger:1', marker };
  const html = identityHtml.whatsapp + rows.whatsapp(body).replace('true_905550000002@c.us_ABC123456', 'true_905550000002@c.us_OTHER123456')
    .replace('</div></div>', '<div data-id="true_905550000002@c.us_ABC123456">You deleted this message</div></div></div>');
  await withPage('whatsapp', html, async page => {
    const context = contextFor('whatsapp', { resource });
    const evidence = await sites.whatsapp.observe(page, context);
    assert.equal(evidence.count, 1);
    assert.equal(evidence.absenceConfirmed, true);
    assert.equal(verifyEvidence({ scenario: 'whatsapp', stage: 'cleanup-text', evidence, context }).ok, true);
  });
});

const attributeEscape = text => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const frameDocument = (text, editable = false) => `<!doctype html><meta charset="utf-8"><body ${editable ? 'contenteditable="true"' : ''} style="white-space:pre-wrap">${text}</body>`;
function frameMessage(id, { text = body, sender = 'alice@example.test', recipient = 'bob@example.test', subject = marker, duplicate = false, missingId = false } = {}) {
  const child = `<iframe class="bound-message" srcdoc="${attributeEscape(frameDocument(text))}"></iframe>`;
  if (id === 'gmail') return `<main role="main"><h2 class="hP">${subject}</h2><div class="adn" ${missingId ? '' : 'data-legacy-message-id="fedcba9876543210"'}><span class="gD" email="${sender}">From</span><span class="g2" email="${recipient}">To</span><div class="a3s aiL">${child}${duplicate ? child : ''}</div><span class="aV3">${file.name}</span></div></main>`;
  return `<div class="conversation"><h1>${subject}</h1><div class="message-container" ${missingId ? '' : 'data-message-id="fedcba9876543210"'}><span data-testid="message-header:from">${sender}</span><span data-testid="message-header:to">${recipient}</span><div class="message-content">${child}${duplicate ? child : ''}</div><span class="attachment-name">${file.name}</span></div></div>`;
}

for (const id of ['protonmail', 'gmail']) {
  test(`${id}: a same-origin iframe editor preserves parent receiver, marked subject and Unicode body proof`, async () => {
    const text = `${marker} iframe first line\nsecond line 🧠`;
    const editor = `<iframe class="bound-editor" title="Rich Text Area" srcdoc="${attributeEscape(frameDocument(text, true))}"></iframe>`;
    const html = id === 'protonmail' ? `<div class="composer"><span data-address="bob@example.test">Bob</span><input name="subject" value="${marker}"><div class="tox-edit-area">${editor}</div></div>`
      : `<div role="dialog"><span email="bob@example.test">Bob</span><input name="subjectbox" value="${marker}">${editor}</div>`;
    await withPage(id, identityHtml[id] + html, async page => {
      const context = contextFor(id, { phase: 'composer', body: text, revisedBody: text, siteBinding: { ...contexts[id], ...(id === 'gmail' ? { editorFrameSelector: 'iframe.bound-editor' } : {}) } });
      const evidence = await sites[id].observe(page, context);
      assert.equal(evidence.blocked, undefined, evidence.reason);
      assert.equal(evidence.composer.exactCount, 1);
      assert.equal(evidence.frames.composer.read, 1);
      assert.equal(verifyEvidence({ scenario: id, stage: 'replace-body', evidence, context }).ok, true);
      assert.equal(JSON.stringify(evidence).includes('iframe first line'), false);
    });
  });
  test(`${id}: a single bound same-origin message iframe retains canonical parent ID and exact From/To`, async () => {
    await withPage(id, identityHtml[id] + frameMessage(id), async page => {
      const context = contextFor(id, { phase: 'resource', siteBinding: { ...contexts[id], ...(id === 'gmail' ? { messageBodyFrameSelector: 'iframe.bound-message' } : {}) } });
      const evidence = await sites[id].observe(page, context);
      assert.equal(evidence.blocked, undefined, evidence.reason);
      assert.equal(evidence.frames.message.read, 1);
      assert.equal(evidence.exactCount, 1);
      assert.equal(evidence.matches[0].resource.id, 'fedcba9876543210');
      assert.equal(verifyEvidence({ scenario: id, stage: 'send-attachment', evidence, context }).ok, true);
    });
  });
}

test('iframe message scope rejects wrong sender, wrong recipient, unrelated subject, and missing immutable parent before reading children', async () => {
  for (const options of [{ sender: 'mallory@example.test' }, { recipient: 'mallory@example.test' }, { sender: 'alice@example.test, mallory@example.test' }, { recipient: 'bob@example.test, mallory@example.test' }, { subject: 'Private unrelated thread' }, { missingId: true }]) {
    await withPage('protonmail', identityHtml.protonmail + frameMessage('protonmail', options), async page => {
      const evidence = await sites.protonmail.observe(page, contextFor('protonmail', { phase: 'resource' }));
      assert.equal(evidence.blocked, true);
      assert.equal(evidence.reason, 'iframe-parent-scope-unverified');
      assert.equal(evidence.frames.message.read, 0);
      assert.equal(evidence.count, 0);
    });
  }
});

test('multiple message frames and multiple composer frames remain ambiguous without reading either child', async () => {
  await withPage('protonmail', identityHtml.protonmail + frameMessage('protonmail', { duplicate: true }), async page => {
    const evidence = await sites.protonmail.observe(page, contextFor('protonmail', { phase: 'resource' }));
    assert.equal(evidence.reason, 'ambiguous-message-body-frames');
    assert.equal(evidence.frames.message.read, 0);
  });
  const child = `<iframe title="Rich Text Area" srcdoc="${attributeEscape(frameDocument(body, true))}"></iframe>`;
  await withPage('protonmail', identityHtml.protonmail + `<div class="composer"><span data-address="bob@example.test">Bob</span><input name="subject" value="${marker}">${child}${child}</div>`, async page => {
    const evidence = await sites.protonmail.observe(page, contextFor('protonmail', { phase: 'composer' }));
    assert.equal(evidence.reason, 'ambiguous-composer-editor-frames');
    assert.equal(evidence.frames.composer.read, 0);
  });
});

test('cross-origin and opaque sandbox mail frames explicitly block independent body verification', async () => {
  for (const opaque of [false, true]) {
    await withPage('protonmail', identityHtml.protonmail + frameMessage('protonmail'), async page => {
      if (!opaque) await page.route('https://foreign.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: frameDocument(body) }));
      await page.locator('.message-content').evaluate((node, args) => {
        const frame = document.createElement('iframe'); frame.className = 'bound-message';
        if (args.opaque) { frame.setAttribute('sandbox', ''); frame.srcdoc = args.document; }
        else frame.src = 'https://foreign.test/frame';
        node.replaceChildren(frame);
      }, { opaque, document: frameDocument(body) });
      await page.locator('iframe').waitFor({ state: 'visible' });
      const evidence = await sites.protonmail.observe(page, contextFor('protonmail', { phase: 'resource' }));
      assert.equal(evidence.blocked, true);
      assert.equal(evidence.reason, 'iframe-cross-origin-or-inaccessible');
      assert.equal(evidence.frames.message.read, 0);
    });
  }
});

test('iframe composer refuses a wrong marked parent or receiver, and unrelated frames are never scanned', async () => {
  const child = `<iframe title="Rich Text Area" srcdoc="${attributeEscape(frameDocument(body, true))}"></iframe>`;
  for (const options of [{ subject: 'unrelated', recipient: 'bob@example.test' }, { subject: marker, recipient: 'mallory@example.test' }]) {
    await withPage('protonmail', identityHtml.protonmail + `<div class="composer"><span data-address="${options.recipient}">Receiver</span><input name="subject" value="${options.subject}">${child}</div>`, async page => {
      const evidence = await sites.protonmail.observe(page, contextFor('protonmail', { phase: 'composer' }));
      assert.equal(evidence.reason, 'iframe-composer-scope-unverified');
      assert.equal(evidence.frames.composer.read, 0);
    });
  }
  await withPage('protonmail', identityHtml.protonmail + rows.protonmail(body) + `<aside>${child}</aside>`, async page => {
    const context = contextFor('protonmail', { phase: 'resource' }); const evidence = await sites.protonmail.observe(page, context);
    assert.equal(evidence.frames.message.candidates, 0);
    assert.equal(evidence.frames.composer.candidates, 0);
    assert.equal(verifyEvidence({ scenario: 'protonmail', stage: 'send-attachment', evidence, context }).ok, true);
  });
});


test('quality failures preserve an independently owned canonical resource for reconciliation', async () => {
  await withPage('x', identityHtml.x + rows.x(body).replace(/<img[^>]*>/g, ''), async page => {
    const context = contextFor('x'), evidence = await sites.x.observe(page, context);
    const verdict = verifyEvidence({ scenario: 'x', stage: 'publish', evidence, context });
    assert.equal(verdict.ok, false); assert.equal(verdict.reason, 'test-attachment-not-confirmed'); assert.equal(verdict.resource.immutable, true);
  });
});
test('steered variant bodies remain exact through the matching receipt without a second suffix', () => {
  const original = { id: 'fedcba9876543210', threadId: 'abcdef1234567890', url: contexts.gmail.url, kind: 'message', immutable: true, owned: true, ledgerId: 'test-ledger', ownerIdentity: 'alice@example.test', marker };
  const context = contextFor('gmail', { resource: original, resources: { 'original-message': original } }); context.bodyOverrides = { 'reply-message': marker + ' corrected reply' };
  const reply = planTask({ scenario: 'gmail', stage: 'reply', context }), receipt = planTask({ scenario: 'gmail', stage: 'reply-receipt', context });
  assert.equal(reply.observation.body, marker + ' corrected reply'); assert.equal(receipt.observation.body, reply.observation.body);
});


test('main-frame mail cannot treat an extra To/Cc/Bcc recipient as an allowlisted-only delivery', async () => {
  for (const id of ['gmail', 'protonmail']) await withPage(id, identityHtml[id] + rows[id](body).replace(id === 'gmail' ? '<span class="g2" email="bob@example.test">Bob</span>' : '<span data-testid="message-header:to">bob@example.test</span>', id === 'gmail' ? '<span class="g2" email="bob@example.test">Bob</span><span class="g2" email="outside@example.test">Outside</span>' : '<span data-testid="message-header:to">bob@example.test, outside@example.test</span>'), async page => {
    const context = contextFor(id), evidence = await sites[id].observe(page, context);
    assert.equal(verifyEvidence({ scenario: id, stage: 'send-attachment', evidence, context }).ok, false);
    assert.equal(evidence.matches[0].recipientCount, 2); assert.equal(JSON.stringify(evidence).includes('outside@example.test'), false);
  });
});
test('manual composer confirmation requires an actual fresh boolean-backed observation', async () => {
  const context = contextFor('x', { observedAfter: new Date().toISOString() });
  const evidence = { schema: evidenceSchema, source: 'manual-confirmed-private', site: 'x', marker, url: contexts.x.url, identity: { matched: true, actual: 'alice' }, count: 0,
    composer: { count: 1, exactCount: 1, recipientMatched: true }, confirmedByOperator: 'false', confirmedAt: new Date().toISOString() };
  assert.equal(verifyEvidence({ scenario: 'x', stage: 'compose', evidence, context }).ok, false);
  evidence.confirmedByOperator = true; evidence.confirmedAt = 'invalid'; assert.equal(verifyEvidence({ scenario: 'x', stage: 'compose', evidence, context }).ok, false);
  evidence.confirmedAt = '2020-01-01T00:00:00Z'; assert.equal(verifyEvidence({ scenario: 'x', stage: 'compose', evidence, context }).ok, false);
  evidence.confirmedAt = new Date().toISOString(); assert.equal(verifyEvidence({ scenario: 'x', stage: 'compose', evidence, context }).ok, true);
});
