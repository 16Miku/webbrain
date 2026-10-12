// These are read-only observers, separate from the extension's model/tool path.
// Live selectors are provisional until checked against the operator's test accounts.
export const evidenceSchema = 'webbrain-authenticated-evidence/1';

const definitions = {
  x: {
    kind: 'social', defaultUrl: 'https://x.com/home', hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
    actions: ['navigation', 'compose', 'edit', 'upload', 'post', 'delete'],
    identity: ['[data-testid="SideNav_AccountSwitcher_Button"]', '[data-testid="AppTabBar_Profile_Link"]'],
    identityMode: 'x', roots: ['main'], containers: ['article[data-testid="tweet"]'],
    bodies: ['[data-testid="tweetText"]'], authors: ['[data-testid="User-Name"] a[href]'],
    links: ['a[href*="/status/"]'], editors: ['[data-testid^="tweetTextarea_"][contenteditable="true"]'],
    attachments: ['[data-testid="tweetPhoto"] img', '[data-testid="videoPlayer"]'], composerAttachments: ['[data-testid="attachments"] img', '[data-testid="attachments"] video'],
    draftSaved: ['[data-testid="draftSaved"]', '[role="dialog"] [aria-label="Saved draft"]'],
    missing: ['[data-testid="error-detail"]'], missingText: 'this post was deleted|this tweet was deleted',
  },
  whatsapp: {
    kind: 'chat', defaultUrl: 'https://web.whatsapp.com/', hosts: ['web.whatsapp.com'],
    actions: ['navigation', 'compose', 'edit', 'send', 'upload', 'delete'],
    identity: ['[data-testid="profile-drawer"] [data-testid="phone-number"]', '[data-testid="profile-phone"]'], identityMode: 'phone',
    roots: ['#main [data-testid="conversation-panel-messages"]'], containers: ['[data-id]'],
    bodies: ['[data-testid="selectable-text"]', '.selectable-text'],
    recipients: ['#main header [data-testid="conversation-info-header-chat-title"]', '#main header [data-testid="conversation-info-header-chat-title-name"]'],
    recipientIdentity: ['[data-testid="chat-info-drawer"] [data-testid="phone-number"]', '[data-testid="chat-info-drawer"] [data-testid="selectable-text"]'],
    editors: ['#main footer [contenteditable="true"][role="textbox"]'],
    attachments: ['[data-testid="document-title"]', '[data-testid="document-filename"]'],
    status: ['[data-testid="msg-meta"] [aria-label]', '[data-icon="msg-check"]', '[data-icon="msg-dblcheck"]'],
  },
  telegram: {
    kind: 'chat', defaultUrl: 'https://web.telegram.org/k/', hosts: ['web.telegram.org'],
    actions: ['navigation', 'compose', 'edit', 'send', 'upload', 'delete'],
    identity: ['.settings-container .phone', '.settings-content .phone-number', '#LeftColumn .Settings .phone-number'], identityMode: 'phone',
    roots: ['.chat .bubbles-inner', '#MiddleColumn .messages-container'], containers: ['.bubble[data-mid]', '.Message[data-message-id]'],
    bodies: ['.message', '.text-content'], recipients: ['.chat .topbar .peer-title', '#MiddleColumn .ChatInfo .fullName'],
    recipientIdentity: ['.chat .topbar [data-peer-id]', '#MiddleColumn .ChatInfo [data-peer-id]'],
    editors: ['.chat .input-message-input[contenteditable="true"]', '#editable-message-text[contenteditable="true"]'],
    attachments: ['.document-name', '.File .file-name', '.Document .title'], status: ['.time', '.MessageOutgoingStatus'],
  },
  bluesky: {
    kind: 'social', defaultUrl: 'https://bsky.app/', hosts: ['bsky.app'],
    actions: ['navigation', 'compose', 'edit', 'upload', 'post', 'delete'],
    identity: ['nav a[href^="/profile/"]', '[data-testid="BottomBarProfileBtn"]', 'a[data-testid="viewProfileButton"]'], identityMode: 'bluesky',
    roots: ['main', '[data-testid="postThreadScreen"]'], containers: ['[data-testid^="feedItem-by-"]', '[data-testid="postThreadItem"]'],
    bodies: ['[data-testid="postText"]', '[data-testid="postTextContainer"]'], authors: ['a[href^="/profile/"]'],
    links: ['a[href*="/post/"]'], editors: ['[data-testid="composePostView"] .ProseMirror[contenteditable="true"]', '[role="dialog"] .ProseMirror[contenteditable="true"]'],
    attachments: ['[data-testid="contentHider-image"] img', '[data-testid="postImage"] img'], composerAttachments: ['[data-testid="composePostView"] img[alt]', '[role="dialog"] [data-testid="selectedPhoto"] img'],
    missing: ['[data-testid="notFoundScreen"]'], missingText: 'post not found|post has been deleted',
  },
  mastodon: {
    kind: 'social', defaultUrl: null, hosts: [], actions: ['navigation', 'compose', 'edit', 'upload', 'post', 'delete'],
    identity: ['.navigation-panel__profile .account__display-name', '.navigation-bar .account__display-name'], identityMode: 'mastodon',
    roots: ['.columns-area', 'main', '.column'], containers: ['.status[data-id]', '.status'],
    bodies: ['.status__content'], authors: ['a.status__display-name', '.account__display-name'], links: ['a.status__relative-time', 'a[href*="/statuses/"]'],
    editors: ['.compose-form textarea', '.compose-form [contenteditable="true"]'], attachments: ['.media-gallery img', '.video-player video'], composerAttachments: ['.compose-form .attachment-thumb'],
    missing: ['.error-column', '.error-container'], missingText: 'post has been deleted|status has been deleted|record not found',
  },
  gmail: {
    kind: 'mail', defaultUrl: 'https://mail.google.com/mail/u/0/', hosts: ['mail.google.com'],
    actions: ['navigation', 'compose', 'edit', 'send', 'reply', 'forward', 'upload', 'delete'],
    identity: ['a[aria-label^="Google Account:"]', '[data-email][data-account-index]'], identityMode: 'email',
    roots: ['[role="main"] .nH', '[role="main"]'], containers: ['.adn'], bodies: ['.a3s.aiL', '.a3s'],
    authors: ['.gD[email]'], recipients: ['.g2[email]', '.g2 [email]'], links: [],
    inboxRoots: ['[role="main"] .ae4', '[role="main"] [role="grid"]'], inboxRows: ['tr.zA', '[role="row"].zA'], inboxSubjects: ['.bog'],
    threadSubjects: ['[role="main"] h2.hP', '[role="main"] [data-testid="thread-subject"]'],
    headerDetails: ['.ajy[role="button"]', '[aria-label="Show details"]', '[aria-label="Message details"]'],
    editors: ['[role="dialog"] [contenteditable="true"][role="textbox"]', '[aria-label="Message Body"][contenteditable="true"]'],
    composerParents: ['[role="dialog"]'], composerSubjects: ['input[name="subjectbox"]', 'input[name="subject"]'],
    composerRecipients: ['[role="dialog"] [email]', '[role="dialog"] [data-hovercard-id]'],
    attachments: ['.aV3', '.aZo'], composerAttachments: ['[role="dialog"] .aZo', '[role="dialog"] .aV3'], draftSaved: ['.aYF', '[aria-label="Saved to Drafts"]'],
  },
  protonmail: {
    kind: 'mail', defaultUrl: 'https://mail.proton.me/u/0/inbox', hosts: ['mail.proton.me', 'mail.protonmail.com'],
    actions: ['navigation', 'compose', 'edit', 'send', 'reply', 'forward', 'upload', 'delete'],
    identity: ['[data-testid="user-dropdown:email"]', '.user-dropdown-email', '.user-dropdown .email'], identityMode: 'email',
    roots: ['.conversation', '[data-testid="conversation-view"]'], containers: ['[data-message-id]', '.message-container'],
    bodies: ['.message-content', '.message-body'], authors: ['[data-testid="message-header:from"]', '.message-recipient-from'],
    recipients: ['[data-testid="message-header:to"]', '.message-recipient-to', '[data-testid="message-header:cc"]', '.message-recipient-cc', '[data-testid="message-header:bcc"]', '.message-recipient-bcc'], links: [],
    inboxRoots: ['[data-testid="message-list"]', '.conversation-list', '.item-container'],
    inboxRows: ['[data-testid="message-list:item"]', '.item-conversation', '.item-message'],
    inboxSubjects: ['[data-testid="message-list:subject"]', '.item-subject'],
    threadSubjects: ['.conversation h1', '[data-testid="conversation:subject"]', '[data-testid="conversation-header:subject"]'],
    headerDetails: ['[data-testid="message-header:show-details"]', '[data-testid="message-header:expand-details"]', 'button[aria-label="Show details"]'],
    editors: ['[data-testid="composer:body"] [contenteditable="true"]', '.composer [contenteditable="true"]'],
    composerParents: ['.composer'], composerSubjects: ['input[name="subject"]', '[data-testid="composer:subject"]'],
    // No current bundled adapter documents frame selectors. These shapes are
    // provisional; operator bindings identify a reviewed live layout.
    editorFrames: ['.tox-edit-area iframe', 'iframe[title="Rich Text Area"]'],
    messageBodyFrames: ['.message-content iframe', '.message-body iframe', 'iframe.message-iframe'],
    composerRecipients: ['.composer [data-address]', '.composer .recipient-item'],
    attachments: ['.attachment-name', '[data-testid="attachment:filename"]'], composerAttachments: ['.composer .attachment-name', '.composer [data-testid="attachment:filename"]'],
    draftSaved: ['[data-testid="composer:saved"]', '.composer-save-status'],
  },
  drive: {
    kind: 'files', defaultUrl: 'https://drive.google.com/drive/u/0/my-drive', hosts: ['drive.google.com'],
    actions: ['navigation', 'create', 'upload', 'rename', 'share', 'download', 'delete'],
    identity: ['a[aria-label^="Google Account:"]', '[data-email][data-account-index]'], identityMode: 'email',
    roots: ['[role="main"] [role="grid"]', '[role="main"] [role="list"]'], containers: ['[role="row"][data-id]', '[role="row"][data-target]'],
    bodies: ['[data-tooltip]', '[role="gridcell"] [aria-label]', '[role="gridcell"]'], authors: [], links: ['a[href*="/file/d/"]'],
    editors: [], attachments: [], missing: ['[role="main"] [role="alert"]'], missingText: 'file is in the trash|file has been deleted',
  },
};

function bindingOf(context) { return context.siteBinding || (typeof context.site === 'object' ? context.site : context.binding) || {}; }
function observerBinding(binding = {}) {
  const keys = ['url', 'expectedIdentity', 'recipient', 'recipientIdentity', 'folderUrl', 'identitySelector', 'identityAttribute',
    'observationRootSelector', 'containerSelector', 'bodySelector', 'editorSelector', 'recipientSelector', 'recipientIdentitySelector', 'recipientIdentityAttribute',
    'authorSelector', 'messageRecipientSelector', 'attachmentSelector', 'composerAttachmentSelector', 'shareRecipientSelector', 'previewRootSelector', 'previewNameSelector', 'draftSavedSelector',
    'editorFrameSelector', 'messageBodyFrameSelector', 'editorFrameBodySelector', 'messageBodyFrameBodySelector', 'composerParentSelector', 'composerSubjectSelector', 'composerRecipientSelector', 'composerSenderSelector', 'threadSubjectSelector'];
  return Object.fromEntries(keys.filter(key => typeof binding[key] === 'string').map(key => [key, binding[key]]));
}
function observerInput(context, binding) {
  const input = Object.fromEntries(['marker', 'body', 'phase', 'recipient', 'recipientIdentity', 'expectedSender', 'expectedIdentity']
    .filter(key => typeof context[key] === 'string').map(key => [key, context[key]]));
  input.recipientIdentity ||= binding.recipientIdentity;
  if (context.file) input.file = Object.fromEntries(['name', 'sha256'].filter(key => typeof context.file[key] === 'string').map(key => [key, context.file[key]]));
  if (context.resource) input.resource = Object.fromEntries(['id', 'url', 'kind', 'immutable', 'ownerIdentity', 'conversationId', 'threadId', 'messageId', 'marker', 'owned', 'ledgerId']
    .filter(key => ['string', 'boolean', 'number'].includes(typeof context.resource[key])).map(key => [key, context.resource[key]]));
  return input;
}
export function normalizeIdentity(value, mode = 'text') {
  const text = String(value || '').trim().toLowerCase();
  if (mode === 'phone') return text.replace(/[^0-9]/g, '');
  return text.replace(/^@/, '');
}

function originAllowed(id, url, binding = {}) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || [...parsed.searchParams.keys()].some(key => /^(?:token|api_key|access_token|password|secret)$/i.test(key))) return false;
    if (id === 'mastodon') return Boolean(binding.url && parsed.origin === new URL(binding.url).origin);
    return definitions[id].hosts.includes(parsed.hostname);
  } catch { return false; }
}

// No route is synthesized from model output. This accepts only a DOM-read URL
// from a site-specific shape and strips incidental query/fragment data.
export function canonicalResource(siteId, rawUrl, binding = {}) {
  try {
    const url = new URL(rawUrl, binding.url || definitions[siteId]?.defaultUrl);
    if (!originAllowed(siteId, url.href, binding)) return null;
    let match;
    if (siteId === 'x' && (match = /^\/([^/]+)\/status\/(\d+)\/?$/.exec(url.pathname))) {
      return { id: match[2], url: `${url.origin}/${match[1]}/status/${match[2]}`, kind: 'post', immutable: true, ownerIdentity: match[1].toLowerCase() };
    }
    if (siteId === 'bluesky' && (match = /^\/profile\/([^/]+)\/post\/([A-Za-z0-9]+)\/?$/.exec(url.pathname))) {
      return { id: `${match[1]}:${match[2]}`, url: `${url.origin}/profile/${match[1]}/post/${match[2]}`, kind: 'post', immutable: true, ownerIdentity: match[1].toLowerCase() };
    }
    if (siteId === 'mastodon' && (match = /^(?:\/@([^/]+)\/(\d+)|\/users\/([^/]+)\/statuses\/(\d+))\/?$/.exec(url.pathname))) {
      const owner = match[1] || match[3]; const id = match[2] || match[4];
      return { id, url: `${url.origin}/@${owner}/${id}`, kind: 'post', immutable: true, ownerIdentity: owner.includes('@') ? owner.toLowerCase() : `${owner}@${url.hostname}`.toLowerCase() };
    }
    if (siteId === 'drive' && (match = /^\/file\/d\/([A-Za-z0-9_-]+)(?:\/view)?\/?$/.exec(url.pathname))) {
      return { id: match[1], url: `${url.origin}/file/d/${match[1]}/view`, kind: 'file', immutable: true };
    }
    if (siteId === 'gmail' && (match = /^#(?:inbox|sent|all|trash|drafts|search\/[^/]+)\/([A-Za-z0-9_-]+)$/.exec(url.hash))) {
      return { id: match[1], url: `${url.origin}${url.pathname}#all/${match[1]}`, kind: 'thread', immutable: true };
    }
    if (siteId === 'protonmail' && (match = /^\/u\/(\d+)\/(?:inbox|sent|all-mail|trash|drafts)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname))) {
      return { id: match[2], url: `${url.origin}/u/${match[1]}/all-mail/${match[2]}`, kind: 'thread', immutable: true };
    }
    return null;
  } catch { return null; }
}

// evaluate() contains DOM reads only. It deliberately returns booleans and
// bounded, test-item metadata instead of inbox/timeline/transcript contents.
function readIdentity({ spec, binding }) {
  const visible = node => Boolean(node && node.getClientRects().length && node.ownerDocument.defaultView.getComputedStyle(node).visibility !== 'hidden' && node.ownerDocument.defaultView.getComputedStyle(node).display !== 'none');
  const selectors = binding.identitySelector ? [binding.identitySelector] : spec.identity;
  const values = new Set(); const modes = spec.identityMode;
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (!visible(node)) continue;
      const raw = binding.identityAttribute ? node.getAttribute(binding.identityAttribute) : [node.getAttribute('aria-label'), node.getAttribute('data-email'), node.getAttribute('href'), node.textContent].filter(Boolean).join(' ');
      if (binding.identitySelector) { values.add(String(raw || '').trim()); continue; }
      if (modes === 'email') for (const token of String(raw).match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []) values.add(token);
      else if (modes === 'x') {
        for (const token of String(raw).match(/@[A-Za-z0-9_]{1,15}\b/g) || []) values.add(token);
        const href = node.getAttribute('href'); if (href && /^\/[A-Za-z0-9_]{1,15}$/.test(href)) values.add(href.slice(1));
      } else if (modes === 'bluesky') {
        const href = node.getAttribute('href') || ''; const match = /\/profile\/([^/?#]+)/.exec(href); if (match) values.add(decodeURIComponent(match[1]));
      } else if (modes === 'mastodon') {
        const tokens = String(raw).match(/@[A-Za-z0-9_]+(?:@[A-Za-z0-9.-]+)?/g) || [];
        for (let token of tokens) { if (!token.slice(1).includes('@')) token += `@${location.hostname}`; values.add(token); }
      } else if (modes === 'phone') {
        for (const token of String(raw).match(/\+?[0-9][0-9 ()-]{6,}[0-9]/g) || []) values.add(token);
      }
    }
  }
  const normalize = value => String(value || '').trim().toLowerCase().replace(/^@/, '').replace(modes === 'phone' ? /[^0-9]/g : /$^/g, '');
  const candidates = [...new Set([...values].map(normalize).filter(Boolean))];
  const expected = normalize(binding.expectedIdentity);
  return { matched: Boolean(expected && candidates.length === 1 && candidates[0] === expected), actual: candidates.length === 1 ? candidates[0] : null,
    candidateCount: candidates.length, reason: !expected ? 'expected-identity-required' : candidates.length !== 1 ? 'identity-missing-or-ambiguous' : candidates[0] !== expected ? 'wrong-account' : null,
    selectorSource: binding.identitySelector ? 'operator-bound-selector' : 'provisional-site-selector' };
}

function readObservation({ spec, binding, input }) {
  const visible = node => Boolean(node && node.getClientRects().length && node.ownerDocument.defaultView.getComputedStyle(node).visibility !== 'hidden' && node.ownerDocument.defaultView.getComputedStyle(node).display !== 'none');
  const query = (root, selectors) => [...new Set(selectors.flatMap(selector => [...root.querySelectorAll(selector)]))].filter(visible);
  const normalized = value => String(value || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
  const identity = value => String(value || '').trim().toLowerCase().replace(/^@/, '');
  const marker = input.marker;
  const markerCount = text => {
    let count = 0; let start = 0;
    while ((start = text.indexOf(marker, start)) !== -1) {
      const before = text[start - 1] || ''; const after = text[start + marker.length] || '';
      if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) count++;
      start += marker.length;
    }
    return count;
  };
  const ownText = node => {
    const clone = node.cloneNode(true);
    const originals = [...node.querySelectorAll('*')]; const copies = [...clone.querySelectorAll('*')];
    originals.forEach((original, index) => { if (!visible(original) || original.getAttribute('aria-hidden') === 'true') copies[index].remove(); });
    for (const ignored of clone.querySelectorAll('blockquote,.gmail_quote,.quoted-message,.reply-preview,.reply,.time,.MessageMeta,[data-testid="quoted-message"],[data-testid="msg-meta"]')) ignored.remove();
    for (const br of clone.querySelectorAll('br')) br.replaceWith(document.createTextNode('\n'));
    for (const block of clone.querySelectorAll('div,p,li')) {
      if (block.nextSibling) block.append(document.createTextNode('\n'));
    }
    return normalized(clone.textContent);
  };
  const roots = binding.observationRootSelector ? query(document, [binding.observationRootSelector]) : query(document, spec.roots);
  const rootNodes = roots.filter(root => !roots.some(other => other !== root && other.contains(root)));
  const rowSelectors = binding.containerSelector ? [binding.containerSelector] : spec.containers;
  const nodes = [...new Set(rootNodes.flatMap(root => query(root, rowSelectors)))];
  const recipients = query(document, binding.recipientSelector ? [binding.recipientSelector] : spec.recipients || []).map(node => normalized(node.textContent));
  const recipientDetails = query(document, binding.recipientIdentitySelector ? [binding.recipientIdentitySelector] : spec.recipientIdentity || []);
  const peerIds = [...new Set(recipientDetails.map(node => node.getAttribute('data-peer-id')).filter(Boolean))];
  let recipientIdentities = [];
  for (const node of recipientDetails) {
    if (binding.recipientIdentityAttribute) recipientIdentities.push(node.getAttribute(binding.recipientIdentityAttribute));
    else if (spec.id === 'telegram') recipientIdentities.push(node.getAttribute('data-peer-id'));
    else recipientIdentities.push(...(String(node.textContent).match(/\+?[0-9][0-9 ()-]{6,}[0-9]/g) || []));
  }
  const recipientNormalize = value => spec.id === 'whatsapp' ? String(value || '').replace(/[^0-9]/g, '') : identity(value);
  recipientIdentities = [...new Set(recipientIdentities.map(recipientNormalize).filter(Boolean))];
  const expectedRecipient = input.recipientIdentity || binding.recipientIdentity;
  const expectedName = input.recipient || binding.recipient;
  const recipientMatched = spec.kind !== 'chat' || Boolean(expectedRecipient && recipientIdentities.length === 1 && recipientIdentities[0] === recipientNormalize(expectedRecipient)
    && (!expectedName || recipients.some(value => value === normalized(expectedName))));
  const conversationId = spec.id === 'telegram' && peerIds.length === 1 ? peerIds[0] : spec.id === 'whatsapp' && recipientMatched ? recipientIdentities[0] : null;
  const bodySelectors = binding.bodySelector ? [binding.bodySelector] : spec.bodies;
  const emailValues = node => (String(node.getAttribute('email') || node.getAttribute('data-address') || node.textContent || '')
    .match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(identity);
  const exactSubject = node => normalized(node.value ?? node.textContent).replace(/^(?:(?:re|fw|fwd):\s*)+/i, '') === marker;
  const threadSubjectMatched = spec.kind === 'mail' && query(document, binding.threadSubjectSelector ? [binding.threadSubjectSelector] : spec.threadSubjects || []).some(exactSubject);
  const threadRouteBound = spec.id === 'gmail' ? /^#(?:inbox|sent|all|trash|drafts|search\/[^/]+)\/[A-Za-z0-9_-]+$/.test(location.hash)
    : spec.id === 'protonmail' ? /^\/u\/\d+\/(?:inbox|sent|all-mail|trash|drafts)\/[A-Za-z0-9_-]+\/?$/.test(location.pathname) : false;
  const frames = { message: { candidates: 0, read: 0, unverified: 0 }, composer: { candidates: 0, read: 0, unverified: 0 } };
  const frameFailures = [];
  const frameBody = (frame, kind) => {
    try {
      const declaredSrc = frame.getAttribute('src');
      if ((declaredSrc && !/^about:(?:blank|srcdoc)$/.test(declaredSrc) && new URL(declaredSrc, location.href).origin !== location.origin)
        || (frame.hasAttribute('sandbox') && !frame.sandbox.contains('allow-same-origin'))) {
        frameFailures.push('iframe-cross-origin-or-inaccessible'); frames[kind].unverified++; return null;
      }
      const child = frame.contentDocument;
      if (!child?.body) { frameFailures.push('iframe-cross-origin-or-inaccessible'); frames[kind].unverified++; return null; }
      const childUrl = child.URL;
      const inherited = /^(?:about:blank|about:srcdoc)$/.test(childUrl);
      if (!inherited && new URL(childUrl).origin !== location.origin) { frameFailures.push('iframe-cross-origin-or-inaccessible'); frames[kind].unverified++; return null; }
      const selector = kind === 'composer' ? binding.editorFrameBodySelector : binding.messageBodyFrameBodySelector;
      let children = selector ? query(child, [selector]) : kind === 'composer' ? query(child, ['[contenteditable="true"]']) : [child.body].filter(visible);
      children = children.filter(node => !children.some(other => other !== node && other.contains(node)));
      if (children.length !== 1 || (kind === 'composer' && !children[0].isContentEditable)) {
        frameFailures.push(kind === 'composer' ? 'iframe-editor-missing-or-ambiguous' : 'iframe-message-body-missing-or-ambiguous'); frames[kind].unverified++; return null;
      }
      const text = ownText(children[0]); frames[kind].read++; return text;
    } catch { frameFailures.push('iframe-cross-origin-or-inaccessible'); frames[kind].unverified++; return null; }
  };
  const matches = [];
  for (const node of nodes) {
    let bodyNodes = query(node, bodySelectors);
    bodyNodes = bodyNodes.filter(part => !bodyNodes.some(other => other !== part && other.contains(part)));
    const texts = bodyNodes.map(ownText);
    const messageFrames = spec.kind === 'mail' ? query(node, binding.messageBodyFrameSelector ? [binding.messageBodyFrameSelector] : spec.messageBodyFrames || []) : [];
    if (messageFrames.length) {
      frames.message.candidates += messageFrames.length;
      const parentId = node.getAttribute('data-legacy-message-id') || node.getAttribute('data-message-id');
      const parentAuthors = query(node, binding.authorSelector ? [binding.authorSelector] : spec.authors || []).flatMap(emailValues);
      const parentRecipients = query(node, binding.messageRecipientSelector ? [binding.messageRecipientSelector] : spec.recipients || []).flatMap(emailValues);
      const sender = identity(input.expectedSender || input.expectedIdentity || binding.expectedIdentity);
      const receiver = identity(input.recipientIdentity || binding.recipientIdentity);
      const ownedParent = input.resource?.owned === true && input.resource.immutable === true && input.resource.ledgerId && input.resource.marker === marker && input.resource.id === parentId;
      if (!/^[A-Za-z0-9_-]{8,}$/.test(parentId || '') || !threadRouteBound || !(threadSubjectMatched || ownedParent)
        || !sender || new Set(parentAuthors).size !== 1 || !parentAuthors.includes(sender)
        || !receiver || new Set(parentRecipients).size !== 1 || !parentRecipients.includes(receiver)) {
        frameFailures.push('iframe-parent-scope-unverified'); frames.message.unverified += messageFrames.length;
      } else if (messageFrames.length !== 1) {
        frameFailures.push('ambiguous-message-body-frames'); frames.message.unverified += messageFrames.length;
      } else {
        const text = frameBody(messageFrames[0], 'message'); if (text !== null) texts.push(text);
      }
    }
    const matchingTexts = texts.filter(text => markerCount(text));
    if (!matchingTexts.length) continue;
    const linkNodes = query(node, spec.links || []);
    const hrefs = linkNodes.map(link => link.getAttribute('href')).filter(Boolean);
    const authorNodes = query(node, binding.authorSelector ? [binding.authorSelector] : spec.authors || []);
    const authors = [...new Set(authorNodes.map(author => author.getAttribute('email') || author.getAttribute('data-address') || author.getAttribute('href') || normalized(author.textContent)).filter(Boolean))];
    const recipientNodes = spec.kind === 'mail' ? query(node, binding.messageRecipientSelector ? [binding.messageRecipientSelector] : spec.recipients || []) : [];
    const mailRecipients = [...new Set(recipientNodes.flatMap(recipient => {
      const value = recipient.getAttribute('email') || recipient.getAttribute('data-address') || normalized(recipient.textContent);
      return String(value || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    }))];
    if (spec.id === 'gmail') for (const row of query(node, ['.ajC tr'])) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2 && /^(?:to|cc|bcc):?$/i.test(normalized(cells[0].textContent))) {
        const emails = String(cells[1].textContent || '').match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
        for (const email of emails) if (!mailRecipients.includes(email)) mailRecipients.push(email);
      }
    }
    const attachmentNodes = query(node, binding.attachmentSelector ? [binding.attachmentSelector] : spec.attachments || []);
    const wantedFile = input.file?.name;
    const attachments = attachmentNodes.filter(attachment => spec.kind === 'social' || !wantedFile || [attachment.textContent, attachment.getAttribute('aria-label'), attachment.getAttribute('title')].some(text => normalized(text).includes(wantedFile)))
      .map(attachment => ({ nameMatches: Boolean(wantedFile && [attachment.textContent, attachment.getAttribute('aria-label'), attachment.getAttribute('title')].some(text => normalized(text).includes(wantedFile))), media: /^(IMG|VIDEO)$/.test(attachment.tagName), present: true }));
    const statusNodes = query(node, spec.status || []);
    const sent = spec.id === 'telegram' ? node.classList.contains('is-sent') || node.classList.contains('is-read') || Boolean(node.querySelector('.icon-check,.icon-checks'))
      : spec.id === 'whatsapp' ? statusNodes.some(status => /^(sent|delivered|read)$/i.test(normalized(status.getAttribute('aria-label'))) || /msg-(?:dbl)?check/.test(status.getAttribute('data-icon') || '')) : null;
    const id = node.getAttribute('data-legacy-message-id') || node.getAttribute('data-message-id') || node.getAttribute('data-mid') || node.getAttribute('data-id') || null;
    const rowPeer = node.getAttribute('data-peer-id');
    const direction = spec.kind !== 'chat' ? null : node.classList.contains('is-out') || node.classList.contains('own') || node.classList.contains('message-out') || Boolean(node.closest('.message-out') || node.querySelector('.message-out')) || /^true_/.test(id || '') ? 'outgoing'
      : node.classList.contains('is-in') || node.classList.contains('message-in') || Boolean(node.closest('.message-in') || node.querySelector('.message-in')) || /^false_/.test(id || '') ? 'incoming' : 'unknown';
    matches.push({ bodyMatches: matchingTexts.length === 1 && matchingTexts[0] === normalized(input.body), markerCount: matchingTexts.reduce((sum, text) => sum + markerCount(text), 0), hrefs,
      domId: id, peerId: rowPeer || conversationId, authors, recipients: mailRecipients, attachments, sent, direction });
  }
  const editors = query(document, binding.editorSelector ? [binding.editorSelector] : spec.editors || []);
  const editorMatches = editors.map(node => normalized(node.value ?? node.innerText ?? node.textContent)).filter(text => markerCount(text));
  if (spec.kind === 'mail') for (const parent of query(document, binding.composerParentSelector ? [binding.composerParentSelector] : spec.composerParents || [])) {
    const editorFrames = query(parent, binding.editorFrameSelector ? [binding.editorFrameSelector] : spec.editorFrames || []);
    if (!editorFrames.length) continue;
    frames.composer.candidates += editorFrames.length;
    const markedSubject = query(parent, binding.composerSubjectSelector ? [binding.composerSubjectSelector] : spec.composerSubjects || []).some(exactSubject);
    const parentRecipients = query(parent, binding.composerRecipientSelector ? [binding.composerRecipientSelector] : spec.composerRecipients || []).flatMap(emailValues);
    const fromNodes = binding.composerSenderSelector ? query(parent, [binding.composerSenderSelector]) : [];
    const parentSenderMatched = !fromNodes.length || fromNodes.flatMap(emailValues).includes(identity(input.expectedSender || input.expectedIdentity || binding.expectedIdentity));
    if (!markedSubject || !parentSenderMatched || new Set(parentRecipients).size !== 1 || !parentRecipients.includes(identity(input.recipientIdentity || binding.recipientIdentity))) {
      frameFailures.push('iframe-composer-scope-unverified'); frames.composer.unverified += editorFrames.length;
    } else if (editorFrames.length !== 1) {
      frameFailures.push('ambiguous-composer-editor-frames'); frames.composer.unverified += editorFrames.length;
    } else {
      const text = frameBody(editorFrames[0], 'composer'); if (text !== null && markerCount(text)) editorMatches.push(text);
    }
  }
  const composerRecipients = query(document, binding.composerRecipientSelector ? [binding.composerRecipientSelector] : spec.composerRecipients || []).map(node => node.getAttribute('email') || node.getAttribute('data-hovercard-id') || node.getAttribute('data-address') || normalized(node.textContent));
  const draftSaved = query(document, binding.draftSavedSelector ? [binding.draftSavedSelector] : spec.draftSaved || []).some(node => /saved to drafts|draft saved|saved draft|saved/i.test(normalized(node.getAttribute('aria-label') || node.textContent)));
  const explicitMissing = input.resource && query(document, spec.missing || []).some(node => new RegExp(spec.missingText || '$^', 'i').test(normalized(node.textContent)));
  const shareRecipient = input.recipientIdentity || binding.recipientIdentity;
  const shareNodes = spec.id === 'drive' ? query(document, binding.shareRecipientSelector ? [binding.shareRecipientSelector] : ['[role="dialog"] [data-email]', '[role="dialog"] [data-hovercard-id]']) : [];
  const shareMatch = shareNodes.find(node => identity(node.getAttribute('data-email') || node.getAttribute('data-hovercard-id')) === identity(shareRecipient));
  const shareRow = shareMatch?.closest('[role="row"],li,.permission-row') || shareMatch?.parentElement;
  const shareRole = shareRow && query(shareRow, ['[role="combobox"]', '[role="button"]', 'span']).some(node => /^viewer$/i.test(normalized(node.textContent))) ? 'viewer' : null;
  const shareDialog = shareMatch?.closest('[role="dialog"]');
  const shareFileId = shareDialog?.getAttribute('data-file-id') || shareDialog?.querySelector('[data-id]')?.getAttribute('data-id') || null;
  const shared = Boolean(shareMatch);
  const composerAttachmentNodes = query(document, binding.composerAttachmentSelector ? [binding.composerAttachmentSelector] : spec.composerAttachments || []);
  const composerAttachmentPresent = composerAttachmentNodes.some(node => {
    const owner = node.closest('[role="dialog"],.compose-form,.composer,[data-testid="composePostView"]');
    if (!owner || !editors.some(editor => owner.contains(editor) && markerCount(normalized(editor.value ?? editor.textContent)))) return false;
    return spec.kind === 'social' ? true : Boolean(input.file?.name && normalized(node.textContent).includes(input.file.name));
  });
  const route = `${location.pathname}${location.hash}`;
  const inTrash = /(?:\/|#)trash(?:\/|$)/.test(route);
  const trashNotice = spec.id === 'drive' && query(document, ['[role="dialog"]', '[role="alert"]']).some(node => /file is in (?:the )?trash|moved to (?:the )?trash/i.test(normalized(node.textContent)));
  const exactDeletedRow = input.resource && spec.id === 'whatsapp' && nodes.some(node => node.getAttribute('data-id') === input.resource.id
    && /this message was deleted|you deleted this message/i.test(normalized(node.textContent)));
  const previewRoots = spec.id === 'drive' ? query(document, binding.previewRootSelector ? [binding.previewRootSelector] : ['[role="document"]', '[aria-label="File preview"]', '.ndfHFb-c4YZDc', '.drive-viewer']) : [];
  const previewNameNodes = spec.id === 'drive' ? query(document, binding.previewNameSelector ? [binding.previewNameSelector] : ['.ndfHFb-c4YZDc-Wrql6b-V1ur5d', '[data-testid="file-name"]', 'h1']) : [];
  const previewNameMatched = previewNameNodes.some(node => normalized(node.textContent) === normalized(input.body))
    || Boolean(normalized(document.title) === `${normalized(input.body)} - Google Drive`);
  const accessDenied = spec.id === 'drive' && query(document, ['[role="alert"]', '[role="main"] h1']).some(node => /you need access|access denied|request access|sign in/i.test(normalized(node.textContent)));
  const selectedFileIds = spec.id === 'drive' ? nodes.filter(node => node.getAttribute('aria-selected') === 'true').map(node => node.getAttribute('data-id')).filter(Boolean) : [];
  const shareNameMatched = shareDialog && normalized(shareDialog.textContent).includes(normalized(input.body));
  return { marker, count: matches.length, exactCount: matches.filter(match => match.bodyMatches && match.markerCount === 1).length, matches,
    scope: { kind: spec.kind, rootCount: rootNodes.length, complete: false, recipientMatched, recipientIdentity: recipientMatched ? recipientIdentities[0] || null : null, conversationId },
    composer: { count: editorMatches.length, exactCount: editorMatches.filter(text => text === normalized(input.body)).length, saved: draftSaved,
      recipientMatched: spec.kind !== 'mail' || (new Set(composerRecipients.map(identity)).size === 1 && composerRecipients.some(value => identity(value) === identity(input.recipientIdentity || binding.recipientIdentity))), attachmentPresent: composerAttachmentPresent },
    explicitMissing: Boolean(explicitMissing), exactDeletedRow: Boolean(exactDeletedRow), shared, shareRole,
    shareFileId: shareFileId || (shareNameMatched && selectedFileIds.length === 1 ? selectedFileIds[0] : null), inTrash, trashNotice,
    previewAccessible: previewRoots.length > 0 && previewNameMatched && !accessDenied, frames,
    frameReason: frameFailures.find(reason => /ambiguous|cross-origin/.test(reason))
      || (frameFailures.length && (input.phase === 'composer' ? !editorMatches.length : !matches.some(match => match.bodyMatches)) ? frameFailures[0] : null) };
}

function identityFromAuthor(id, authors, binding) {
  const values = new Set();
  for (const author of authors) {
    if (id === 'x') {
      try { const url = new URL(author, binding.url || definitions.x.defaultUrl); const match = /^\/([A-Za-z0-9_]+)$/.exec(url.pathname);
        if (match && originAllowed(id, url.href, binding)) values.add(normalizeIdentity(match[1]));
      } catch { /* An unknown author URL cannot prove the account. */ }
    }
    else if (id === 'bluesky') { const match = /\/profile\/([^/?#]+)\/?$/.exec(author); if (match) values.add(normalizeIdentity(match[1])); }
    else if (id === 'mastodon') {
      const match = /(?:\/|^)@([A-Za-z0-9_]+(?:@[A-Za-z0-9.-]+)?)/.exec(author);
      if (match) values.add(normalizeIdentity(match[1].includes('@') ? match[1] : `${match[1]}@${new URL(binding.url).hostname}`));
    } else {
      const emails = author.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
      emails.forEach(email => values.add(normalizeIdentity(email)));
    }
  }
  return [...values];
}

function resourceFromMatch(id, match, observedUrl, binding, input) {
  const candidates = match.hrefs.map(href => canonicalResource(id, new URL(href, observedUrl).href, binding)).filter(Boolean);
  const distinct = [...new Map(candidates.map(resource => [resource.id, resource])).values()];
  if (distinct.length === 1) return distinct[0];
  if (distinct.length > 1) return null; // quoted posts may carry somebody else's link
  const domId = match.domId;
  if (id === 'telegram' && /^-?\d+$/.test(match.peerId || '') && /^\d+$/.test(domId || '')) {
    return { id: `${match.peerId}:${domId}`, messageId: domId, conversationId: match.peerId, url: observedUrl, kind: 'message', immutable: true };
  }
  if (id === 'whatsapp' && /^(?:true|false)_[^_]+_[A-Za-z0-9]+$/.test(domId || '') && input.recipientIdentity) {
    const jid = domId.split('_')[1];
    if (jid.split('@')[0] !== normalizeIdentity(input.recipientIdentity, 'phone')) return null;
    return { id: domId, conversationId: normalizeIdentity(input.recipientIdentity, 'phone'), url: observedUrl, kind: 'message', immutable: true };
  }
  if (id === 'drive' && /^[A-Za-z0-9_-]{8,}$/.test(domId || '')) return { id: domId, url: `https://drive.google.com/file/d/${domId}/view`, kind: 'file', immutable: true };
  if (id === 'gmail' || id === 'protonmail') {
    const thread = canonicalResource(id, observedUrl, binding);
    if (thread && /^[A-Za-z0-9_-]{8,}$/.test(domId || '')) return { ...thread, id: domId, threadId: thread.id, kind: 'message', immutable: true };
  }
  return null;
}

// Preparation opens test-owned observation UI only. Its evidence is never a
// pass condition: observe() still independently reads the resulting message.
async function prepareMailObservation(site, page, context, spec, binding) {
  const marker = context.marker;
  const timeout = Math.max(250, Math.min(30000, Number(context.observationTimeoutMs || binding.observationTimeoutMs || 5000)));
  const subjectSelector = binding.subjectSelector || spec.inboxSubjects.join(',');
  const rowSelector = binding.inboxRowSelector || spec.inboxRows.join(',');
  const rootSelector = binding.inboxRootSelector || spec.inboxRoots.join(',');
  const threadSubjectSelector = binding.threadSubjectSelector || spec.threadSubjects.join(',');
  const exactSubject = (text, needle) => String(text || '').replace(/\u00a0/g, ' ').trim().replace(/^(?:(?:re|fw|fwd):\s*)+/i, '') === needle;
  const readOpened = async () => {
    const current = await site.observe(page, context);
    if (current.blocked && current.reason !== 'iframe-parent-scope-unverified') return { blocked: true, reason: current.reason };
    const markedSubject = await page.locator(threadSubjectSelector).evaluateAll((nodes, needle) => nodes.some(node => node.getClientRects().length
      && String(node.textContent || '').trim().replace(/^(?:(?:re|fw|fwd):\s*)+/i, '') === needle), marker);
    const ownMessage = current.matches?.some(match => match.bodyMatches && match.markerCount === 1);
    return { opened: Boolean(markedSubject || ownMessage), bodyReady: Boolean(ownMessage) };
  };
  let opened = await readOpened();
  if (opened.blocked) return { prepared: false, ...opened };
  let openedThread = false;
  if (!opened.opened) {
    const candidates = [];
    for (const row of await page.locator(rootSelector).locator(rowSelector).all()) {
        if (!await row.isVisible()) continue;
        const subjects = await row.locator(subjectSelector).all();
        for (const subject of subjects) {
          if (!await subject.isVisible()) continue;
          if (await subject.evaluate((node, needle) => String(node.textContent || '').replace(/\u00a0/g, ' ').trim().replace(/^(?:(?:re|fw|fwd):\s*)+/i, '') === needle, marker)) {
            // Multiple nested subject selectors can match the same DOM node;
            // CSS union locators deduplicate those before this enumeration.
            candidates.push({ row, subject });
          }
        }
    }
    if (candidates.length !== 1) return { prepared: false, blocked: true, reason: candidates.length ? 'ambiguous-marked-test-thread' : 'marked-test-thread-not-visible' };
    const account = await site.identity(page, { ...binding, expectedIdentity: context.expectedIdentity || binding.expectedIdentity });
    if (!account.matched) return { prepared: false, blocked: true, reason: account.reason, identity: account };
    const target = candidates[0].subject;
    const freshCount = await page.locator(rootSelector).locator(rowSelector).locator(subjectSelector).evaluateAll((nodes, needle) => nodes.filter(node => node.getClientRects().length
      && String(node.textContent || '').replace(/\u00a0/g, ' ').trim().replace(/^(?:(?:re|fw|fwd):\s*)+/i, '') === needle).length, marker);
    if (freshCount !== 1) return { prepared: false, blocked: true, reason: 'marked-thread-target-changed' };
    if (!exactSubject(await target.textContent({ timeout }), marker)) return { prepared: false, blocked: true, reason: 'marked-thread-target-changed' };
    // Clicking the subject, rather than the row's center, avoids nearby
    // archive/delete controls. Marking this exact test email read is allowed.
    await target.click({ timeout });
    try {
      await page.waitForFunction(({ selectors, bodySelectors, marker }) => {
        const exact = text => String(text || '').trim().replace(/^(?:(?:re|fw|fwd):\s*)+/i, '') === marker;
        return selectors.some(selector => [...document.querySelectorAll(selector)].some(node => node.getClientRects().length && exact(node.textContent)))
          || bodySelectors.some(selector => [...document.querySelectorAll(selector)].some(node => node.getClientRects().length && String(node.textContent || '').includes(marker)));
      }, { selectors: [threadSubjectSelector], bodySelectors: spec.bodies, marker }, { timeout });
    } catch { return { prepared: false, blocked: true, reason: 'marked-test-thread-did-not-open' }; }
    openedThread = true;
    opened = await readOpened();
    if (!opened.opened || opened.blocked) return { prepared: false, blocked: true, reason: opened.reason || 'marked-test-thread-did-not-open' };
  }
  const detailsSelector = binding.headerDetailsSelector || spec.headerDetails.join(',');
  const containerSelector = binding.containerSelector || spec.containers.join(',');
  const expectedSender = normalizeIdentity(context.expectedSender || context.expectedIdentity || binding.expectedIdentity);
  let expandedHeaders = 0;
  for (const message of await page.locator(containerSelector).all()) {
    if (!await message.isVisible()) continue;
    const allowedMessage = await message.evaluate((node, args) => {
      const visible = element => element.getClientRects().length && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden';
      const text = String(node.textContent || '');
      const authorValues = args.authorSelectors.flatMap(selector => [...node.querySelectorAll(selector)]).filter(visible)
        .map(author => author.getAttribute('email') || author.getAttribute('data-address') || author.textContent || '');
      const authorMatched = authorValues.some(author => (String(author).match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).some(email => email.toLowerCase() === args.sender));
      // A marked thread may contain several owned test messages. Headers are
      // read only for the expected sender, within this already marked thread.
      return Boolean(args.sender && authorMatched && (text.includes(args.marker) || args.threadSubjectMatched));
    }, { authorSelectors: binding.authorSelector ? [binding.authorSelector] : spec.authors, sender: expectedSender, marker, threadSubjectMatched: opened.opened });
    if (!allowedMessage) continue;
    for (const control of await message.locator(detailsSelector).all()) {
      if (!await control.isVisible()) continue;
      const safe = await control.evaluate(node => {
        const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent].filter(Boolean).join(' ').trim();
        const expanded = node.getAttribute('aria-expanded') === 'true';
        return !expanded && !/\b(?:send|reply|forward|delete|trash|archive|move|spam|unsubscribe|save|discard)\b/i.test(label);
      });
      if (!safe) continue;
      const account = await site.identity(page, { ...binding, expectedIdentity: context.expectedIdentity || binding.expectedIdentity });
      if (!account.matched) return { prepared: false, blocked: true, reason: account.reason, identity: account };
      const stillMarked = await readOpened();
      if (!stillMarked.opened || stillMarked.blocked) return { prepared: false, blocked: true, reason: 'marked-test-thread-scope-changed' };
      await control.click({ timeout });
      expandedHeaders++;
      // Only one details toggle per message is needed. Clicking alternatives
      // could close the popup that was just opened.
      break;
    }
  }
  return { prepared: true, blocked: false, openedThread, expandedHeaders };
}

function createSite(id, definition) {
  const spec = { ...definition, id };
  return Object.freeze({ id, ...definition, selectorStatus: 'unverified-on-live-accounts',
    originAllowed: (url, binding) => originAllowed(id, url, binding),
    canonicalResource: (url, binding) => canonicalResource(id, url, binding),
    async identity(page, binding = {}) {
      if (!page?.evaluate || !page?.url) return { matched: false, actual: null, reason: 'independent-local-observer-required' };
      if (!originAllowed(id, page.url(), binding)) return { matched: false, actual: null, reason: 'wrong-site-origin' };
      return page.evaluate(readIdentity, { spec, binding: observerBinding(binding) });
    },
    async prepareObservation(page, context = {}) {
      const binding = bindingOf(context);
      const account = await this.identity(page, { ...binding, expectedIdentity: context.expectedIdentity || binding.expectedIdentity });
      if (!account.matched) return { prepared: false, blocked: true, reason: account.reason, identity: account };
      if (!context.marker || typeof context.marker !== 'string' || context.marker.length < 8 || context.marker.length > 200) return { prepared: false, blocked: true, reason: 'bounded-test-marker-required' };
      if (definition.kind === 'mail' && context.phase !== 'composer') {
        // The runner may reuse an inbox handle that now displays a previous
        // test thread. Reset only to the operator's explicit observation URL.
        const observationUrl = binding.observerUrl && String(binding.observerUrl).replaceAll('{marker}', encodeURIComponent(context.marker));
        let navigated = false;
        if (observationUrl && page.url() !== observationUrl) {
          if (!originAllowed(id, observationUrl, binding)) return { prepared: false, blocked: true, reason: 'wrong-observer-mail-origin' };
          await page.goto(observationUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(250, Math.min(30000, Number(context.observationTimeoutMs || 5000))) });
          navigated = true;
        }
        return { ...await prepareMailObservation(this, page, context, spec, binding), navigated };
      }
      if (definition.kind === 'chat') {
        const conversationUrl = binding.observerConversationUrl;
        if (conversationUrl && page.url() !== conversationUrl) {
          if (!originAllowed(id, conversationUrl, binding)) return { prepared: false, blocked: true, reason: 'wrong-observer-conversation-origin' };
          await page.goto(conversationUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(250, Math.min(30000, Number(context.observationTimeoutMs || 5000))) });
        }
        const evidence = await this.observe(page, context);
        return evidence.blocked || !evidence.scope?.recipientMatched
          ? { prepared: false, blocked: true, reason: evidence.reason || 'wrong-or-unverified-conversation' }
          : { prepared: true, blocked: false, navigated: Boolean(conversationUrl) };
      }
      return { prepared: false, blocked: false, reason: 'no-observation-preparation-required' };
    },
    async observe(page, context = {}) {
      const binding = bindingOf(context);
      const input = observerInput(context, binding);
      if (!input.marker || typeof input.marker !== 'string' || input.marker.length < 8 || input.marker.length > 200) throw new Error('A bounded unique test marker is required');
      const account = await this.identity(page, { ...binding, expectedIdentity: context.expectedIdentity || binding.expectedIdentity });
      const url = page?.url?.() || null;
      if (!account.matched) return { schema: evidenceSchema, source: 'independent-dom', site: id, url, identity: account, marker: input.marker, blocked: true, reason: account.reason, count: null, matches: [] };
      const observation = await page.evaluate(readObservation, { spec, binding: observerBinding(binding), input });
      for (const match of observation.matches) {
        match.authorIdentities = identityFromAuthor(id, match.authors, binding);
        delete match.authors;
        match.recipientCount = new Set(match.recipients.map(value => normalizeIdentity(value))).size;
        match.recipientMatched = definition.kind !== 'mail' || match.recipientCount === 1 && match.recipients.some(value => normalizeIdentity(value) === normalizeIdentity(input.recipientIdentity));
        // Return only the requested receiver match, never other message addresses.
        match.recipients = match.recipientMatched && definition.kind === 'mail' ? [normalizeIdentity(input.recipientIdentity)] : [];
        match.resource = resourceFromMatch(id, match, url, binding, input);
        if (match.resource && definition.kind !== 'social') match.resource.ownerIdentity = account.actual;
        delete match.hrefs; delete match.domId;
      }
      const resourceHere = context.resource && canonicalResource(id, url, binding);
      const resourceExpected = context.resource && canonicalResource(id, context.resource.url, binding);
      const absenceConfirmed = Boolean(observation.explicitMissing && resourceHere && resourceExpected && resourceHere.id === resourceExpected.id)
        || Boolean(id === 'whatsapp' && observation.exactDeletedRow && observation.scope.recipientMatched && observation.scope.conversationId === context.resource?.conversationId);
      const folderScoped = id !== 'drive' || Boolean(binding.folderUrl && new URL(binding.folderUrl).pathname === new URL(url).pathname);
      const shareUrlResource = id === 'drive' ? canonicalResource(id, url, binding) : null;
      const shareResourceId = observation.shareFileId || shareUrlResource?.id || null;
      const trashMatch = context.resource ? observation.matches.find(match => match.resource?.id === context.resource.id && match.bodyMatches)?.resource : null;
      const trashedResourceId = observation.inTrash && trashMatch ? trashMatch.id : observation.trashNotice && shareUrlResource ? shareUrlResource.id : null;
      const result = { schema: evidenceSchema, source: 'independent-dom', site: id, url, observedAt: new Date().toISOString(), identity: account, ...observation,
        absenceConfirmed, shareResourceId, trashed: Boolean(trashedResourceId), trashedResourceId,
        accessConfirmed: Boolean(observation.previewAccessible && shareUrlResource?.id === context.resource?.id),
        accessResourceId: observation.previewAccessible && shareUrlResource ? shareUrlResource.id : null,
        scope: { ...observation.scope, folderScoped }, selectorStatus: this.selectorStatus };
      delete result.explicitMissing; delete result.exactDeletedRow; delete result.shareFileId; delete result.inTrash; delete result.trashNotice; delete result.previewAccessible;
      if (result.frameReason) { result.blocked = true; result.reason = result.frameReason; }
      delete result.frameReason;
      if (!folderScoped && !['download', 'shared', 'trashed', 'access'].includes(context.phase)) { result.blocked = true; result.reason = 'wrong-test-folder'; }
      return result;
    },
  });
}

export const sites = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([id, definition]) => [id, createSite(id, definition)])));
export default sites;
