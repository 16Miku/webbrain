import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

// These isolated documents reproduce the official clients' published markup;
// every request is intercepted. They neither authenticate nor contact Telegram.
// Source revisions and selector evidence are documented in native-chat-observation.md.
for (const build of ['chrome', 'firefox']) {
  const { isCommunicationThreadContext } = await import(`../src/${build}/src/agent/read-completeness.js`);
  const { getActiveAdapter } = await import(`../src/${build}/src/agent/adapters.js`);
  const { buildRecommendedActions } = await import(`../src/${build}/src/ui/recommended-actions.js`);
  test(`${build}: official Telegram conversation hashes normalize without treating login as a thread`, () => {
    for (const url of [
      'https://web.telegram.org/a/#123456',
      'https://web.telegram.org/a/#123456_thread',
      'https://web.telegram.org/a/#-100123_456',
      'https://web.telegram.org/k/#123456',
      'https://web.telegram.org/k/#@Owned_QA',
      'https://web.telegram.org/k/#/im?p=%40Owned_QA',
      'https://web.telegram.org/k/#-100123?thread=456',
      'https://web.telegram.org/k/#/im?p=123456&thread=456',
      ...['webk', 'weba', 'webz', 'k'].map(host => `https://${host}.telegram.org/#123456`),
    ]) {
      assert.equal(getActiveAdapter(url)?.name, 'telegram', url);
      assert.equal(isCommunicationThreadContext(url, 'telegram'), true, url);
      assert.ok(buildRecommendedActions({ url }, { max: 20 }).some(action => action.id === 'summarize-thread'), `Conversation suggestions: ${url}`);
    }
    for (const url of [
      'https://web.telegram.org/a/', 'https://web.telegram.org/k/#column-center',
      'https://web.telegram.org/a/#123456_scheduled', 'https://web.telegram.org/a/#123456_pinned',
      'https://web.telegram.org/k/#/im?tgaddr=tg%3A%2F%2Flogin',
      'https://web.telegram.org/k/#@Owned_QA?tgaddr=tg%3A%2F%2Flogin',
      'https://web.telegram.org/k/#@Owned_QA?story=1',
      'https://web.telegram.org/k/#@Owned_QA?community=1',
      'https://web.telegram.org/k/#@@Owned_QA',
      'https://web.telegram.org/k/#@Owned_QA%0A',
      'https://web.telegram.org/k/#@Owned_QA/scheduled',
      'https://web.telegram.org/k/#@' + 'a'.repeat(33),
      'https://web.telegram.org.evil.test/a/#123456', 'https://telegram.org/#123456',
      'https://web.whatsapp.com/',
    ]) {
      assert.equal(isCommunicationThreadContext(url, 'telegram'), false, url);
      if (/telegram\.org\//.test(url)) assert.equal(buildRecommendedActions({ url, title: 'Telegram Chats' }, { max: 20 }).some(action => action.id === 'summarize-thread'), false, `No false conversation suggestions: ${url}`);
    }
  });
}

const fixture = kind => `<!doctype html><style>
body{font:16px sans-serif;margin:0}.chat,#MiddleColumn{width:700px;padding:16px}.bubble,.Message{padding:4px;border:1px solid #ccc}.input-message-input,#editable-message-text{min-height:24px;border:1px solid #999}.time,.MessageMeta{font-size:10px}.Avatar{width:32px;height:32px}.icon{display:inline-block;width:16px;height:16px}.bubbles-scrollable,.MessageList{height:400px;overflow-y:auto}
</style>${kind === 'k' ? `<div class="chat"><div class="topbar"><div class="chat-info"><div class="user-title"><span class="peer-title" data-peer-id="123456">Saved Messages</span></div></div></div><div class="bubbles scrolled-down"><div class="bubbles-scrollable"><div class="bubbles-inner"></div></div></div><div class="input-message-input" data-peer-id="123456" contenteditable="true"></div></div>` : `<div id="MiddleColumn"><div class="MiddleHeader"><div class="ChatInfo"><div class="Avatar" data-peer-id="123456"></div><h3 class="fullName">Saved Messages</h3></div></div><div class="MessageList with-bottom-snap" data-list-key="123456_-1_thread"><div class="messages-container"><div class="list-bottom-marker"></div></div></div><div id="editable-message-text" role="textbox" contenteditable="true"></div></div>`}
<aside><article data-message-id="sidebar">Unrelated preview</article><input aria-label="Search chats"></aside>`;

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: Telegram WebK excludes only its native retired message subtree from live transcript and delivery`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const source = await readFile(new URL(`../src/${build}/src/content/chat-observation.js`, import.meta.url), 'utf8');
      const kernel = await readFile(new URL(`../src/${build}/src/agent/chat-workflow.js`, import.meta.url), 'utf8');
      await page.route('**/*', route => route.fulfill({ contentType: route.request().url().includes('/__qa/kernel.js') ? 'text/javascript' : 'text/html',
        body: route.request().url().includes('/__qa/kernel.js') ? kernel : fixture('k') }));
      await page.goto('https://web.telegram.org/k/#123456');
      await page.addScriptTag({ content: source });
      const result = await page.evaluate(async () => {
        const { createChatSession, advanceChatSession, decideChatSend, markChatSendPending } = await import('/__qa/kernel.js');
        const chat = document.querySelector('.chat');
        const composer = document.querySelector('.input-message-input');
        const live = document.querySelector('.bubbles-inner');
        live.classList.add('has-rights', 'is-chat');
        live.parentElement.classList.add('scrollable');
        const retiredContainer = document.createElement('div'); retiredContainer.className = 'bubbles-remover-container';
        const retired = document.createElement('div'); retired.className = 'bubbles-remover bubbles-inner';
        retired.style.cssText = 'width:600px;min-height:40px';
        retiredContainer.append(retired); chat.insertBefore(retiredContainer, live.parentElement.parentElement);
        const row = (id, text, own = false, status = 'sent') => {
          const node = document.createElement('div');
          node.className = `bubble ${own ? `is-out is-${status}` : 'is-in'}`;
          node.dataset.mid = String(id); node.dataset.peerId = '123456';
          const textNode = document.createElement('div'); textNode.className = 'message'; textNode.textContent = text;
          node.append(textNode); return node;
        };
        live.append(row(10, 'Current question'));
        retired.append(row(9, 'Deleted earlier question'));
        window.__wb_ax_lookup = ref => ref === 'composer' ? composer : null;
        const observe = probe => window.__wb_observe_chat_dom({ probe: probe || { success: true, composerAvailable: true, composerRef: 'composer' } });
        const results = { retiredVisible: retired.getBoundingClientRect().height > 0, liveAndRetired: observe(),
          unresolvedComposer: observe({ success: false, composerAvailable: false, composerRef: 'fake-unresolved-composer' }) };
        const competing = live.cloneNode(true); live.parentElement.append(competing);
        results.twoLive = observe(); competing.remove();
        const nearMatch = retiredContainer.cloneNode(true); nearMatch.className = 'unrelated-container'; chat.append(nearMatch);
        results.wrongRetiredParent = observe(); nearMatch.remove();
        const missingMarker = retiredContainer.cloneNode(true); missingMarker.firstElementChild.classList.remove('bubbles-remover'); chat.append(missingMarker);
        results.missingRetiredMarker = observe(); missingMarker.remove();
        const liveParent = live.parentElement; live.remove();
        results.retiredOnly = observe(); liveParent.append(live);
        const initial = observe();
        let session = advanceChatSession(createChatSession(), initial).session;
        const decision = decideChatSend(session, initial, 'Delayed authored reply');
        results.decisionAllowed = decision.ok;
        if (!decision.ok) return results;
        session = markChatSendPending(session, decision);
        const deletedOutgoing = row(11, 'Delayed authored reply', true, 'sending'); live.append(deletedOutgoing);
        results.optimisticPending = advanceChatSession(session, observe()).session.pendingOutbound !== null;
        // The official client moves removed bubbles into this still-rendered
        // native subtree. A later sent status must not become delivery proof.
        retired.append(deletedOutgoing); deletedOutgoing.className = 'bubble is-out is-sent';
        results.deletedOutgoingMessages = observe().messages;
        session = advanceChatSession(session, observe()).session;
        results.deletedOutgoingKeepsPending = session.pendingOutbound !== null;
        retired.firstElementChild.dataset.peerId = '987654';
        results.retiredForeignPeer = observe();
        live.append(row(12, 'Delayed authored reply', true));
        const delivered = observe();
        results.actualOutgoingIds = delivered.messages.filter(message => message.direction === 'outgoing').map(message => message.id);
        results.actualDeliveryClearsPending = advanceChatSession(session, delivered).session.pendingOutbound === null;
        return results;
      });
      assert.equal(result.retiredVisible, true, 'The native deletion subtree remains geometry-visible.');
      assert.equal(result.liveAndRetired.success, true);
      assert.deepEqual(result.liveAndRetired.messages.map(message => message.text), ['Current question']);
      assert.equal(result.unresolvedComposer.success, true, 'An unresolved probe ref still uses the unique verified native composer.');
      assert.equal(result.twoLive.success, false, 'Two actual live panes remain ambiguous.');
      assert.equal(result.wrongRetiredParent.success, false, 'A remover class outside its native parent is not excluded.');
      assert.equal(result.missingRetiredMarker.success, false, 'The exact native subtree markers are required.');
      assert.equal(result.retiredOnly.success, false, 'A deletion tombstone cannot replace the live pane.');
      assert.equal(result.decisionAllowed, true);
      assert.equal(result.optimisticPending, true);
      assert.deepEqual(result.deletedOutgoingMessages.map(message => message.text), ['Current question']);
      assert.equal(result.deletedOutgoingKeepsPending, true, 'A delayed deleted outgoing bubble cannot clear the send obligation.');
      assert.equal(result.retiredForeignPeer.success, true, 'Retired foreign rows cannot relabel the verified live transcript.');
      assert.deepEqual(result.actualOutgoingIds, ['telegram:k:123456:0:12']);
      assert.equal(result.actualDeliveryClearsPending, true, 'A new confirmed outgoing in the actual live pane still verifies delivery.');
    } finally { await browser.close(); }
  });
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  for (const kind of ['k', 'a']) {
    test(`${build}: Telegram Web${kind.toUpperCase()} observes delivery, edits, recipient isolation and a simulated twelve-hour virtual chat`, async () => {
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const source = await readFile(new URL(`../src/${build}/src/content/chat-observation.js`, import.meta.url), 'utf8');
        const kernel = await readFile(new URL(`../src/${build}/src/agent/chat-workflow.js`, import.meta.url), 'utf8');
        await page.route('**/*', route => route.fulfill({
          contentType: route.request().url().includes('/__qa/kernel.js') ? 'text/javascript' : 'text/html',
          body: route.request().url().includes('/__qa/kernel.js') ? kernel : fixture(kind),
        }));
        await page.goto(`https://web.telegram.org/${kind}/#123456`);
        await page.addScriptTag({ content: source });
        const result = await page.evaluate(async kind => {
          const { createChatSession, advanceChatSession, serializeChatSession, decideChatSend, markChatSendPending } = await import('/__qa/kernel.js');
          let composer = document.querySelector(kind === 'k' ? '.input-message-input' : '#editable-message-text');
          const transcript = document.querySelector(kind === 'k' ? '.bubbles-inner' : '.messages-container');
          const transcriptRoot = kind === 'k' ? transcript : transcript.parentElement;
          const latestMarker = document.querySelector('.list-bottom-marker');
          window.__wb_ax_lookup = ref => ref === 'composer' ? composer : null;
          const row = (id, text, { own = false, status = 'sent', peer = '123456' } = {}) => {
            const node = document.createElement('div');
            node.className = kind === 'k' ? `bubble ${own ? 'is-out' : 'is-in'}${own ? ` is-${status}` : ''}` : `Message${own ? ' own' : ''}`;
            node.setAttribute(kind === 'k' ? 'data-mid' : 'data-message-id', String(id));
            if (kind === 'k') { node.dataset.peerId = peer; node.dataset.timestamp = String(1791331200 + id); }
            const content = document.createElement('div'); content.className = kind === 'k' ? 'message' : 'text-content';
            content.append(document.createTextNode(text));
            const meta = document.createElement('span'); meta.className = kind === 'k' ? 'time' : 'MessageMeta'; meta.textContent = 'edited 10:42'; content.append(meta);
            if (own && kind === 'a') {
              const state = document.createElement('div'); state.className = 'MessageOutgoingStatus';
              state.innerHTML = `<i class="icon icon-${status === 'sent' ? 'check' : status === 'read' ? 'message-read' : status === 'error' ? 'message-failed' : 'message-pending'}"></i>`;
              content.append(state);
            }
            node.append(content); return node;
          };
          const observe = () => {
            if (latestMarker && !transcript.contains(latestMarker)) transcript.append(latestMarker);
            const scrollPane = document.querySelector('.bubbles-scrollable,.MessageList'); scrollPane.scrollTop = scrollPane.scrollHeight;
            return window.__wb_observe_chat_dom({ probe: { success: true, composerAvailable: true, composerRef: 'composer' } });
          };
          const results = {};
          transcript.replaceChildren(row(1, 'My own note', { own: true }), row(2, 'Same text'), row(3, 'Same text'));
          const initial = observe();
          results.initial = initial;
          results.nativeWithoutFocusedEditor = window.__wb_observe_chat_dom({ probe: { success: false, composerAvailable: false } });
          transcriptRoot.classList.add('is-animating'); results.transcriptAnimation = observe(); transcriptRoot.classList.remove('is-animating');
          const duplicateTranscript = transcriptRoot.cloneNode(true); transcriptRoot.parentElement.append(duplicateTranscript);
          results.competingTranscripts = observe(); duplicateTranscript.remove();
          const originalRows = [...transcript.children].filter(node => !node.matches('.list-bottom-marker'));
          if (kind === 'a') {
            const staleSlide = document.createElement('div'); staleSlide.className = 'Transition_slide-inactive';
            staleSlide.append(row(500, 'Inactive transcript from another conversation')); transcriptRoot.append(staleSlide);
            results.inactiveSlideMessages = observe().messages;
            staleSlide.className = 'Transition_slide-from'; results.transitioningSlide = observe(); staleSlide.remove();
          }
          transcript.replaceChildren(...Array.from({ length: 250 }, (_, index) => row(index + 10, `Bounded question ${index}`)));
          results.cappedNative = observe().messages;
          transcript.replaceChildren(...originalRows);
          let step = advanceChatSession(createChatSession(), initial); let session = step.session;
          results.initialReplyCount = step.newMessages.filter(message => message.direction === 'incoming').length;
          const decision = decideChatSend(session, initial, 'Pending note');
          if (!decision.ok) throw new Error('Fixture send decision must be allowed');
          session = markChatSendPending(session, decision);
          transcript.append(row(4, 'Pending note', { own: true, status: 'sending' }), row(5, 'Failed note', { own: true, status: 'error' }));
          results.pendingMessages = observe().messages;
          results.pendingDeliveryPreserved = advanceChatSession(session, observe()).session.pendingOutbound !== null;
          const pending = transcript.querySelectorAll('.bubble,.Message')[3];
          if (kind === 'k') pending.className = 'bubble is-out is-sent';
          else pending.querySelector('.icon').className = 'icon icon-check';
          // The native app removes the unrelated failed draft before another
          // delivery can establish a complete mounted send floor.
          transcript.querySelectorAll('.bubble,.Message')[4].remove();
          results.sentMessages = observe().messages;
          session = advanceChatSession(session, observe()).session;
          results.sentDeliveryCleared = session.pendingOutbound === null;
          results.sameReplyRejected = decideChatSend(session, observe(), 'Pending note').reason;
          const latest = transcript.querySelectorAll('.bubble,.Message')[2];
          latest.querySelector(kind === 'k' ? '.message' : '.text-content').firstChild.nodeValue = 'Same text revised';
          const edited = observe();
          step = advanceChatSession(session, edited); session = step.session;
          results.editedIncoming = step.newMessages.filter(message => message.direction === 'incoming');
          results.repeatedEditDeltas = advanceChatSession(session, observe()).newMessages.length;
          location.hash = kind === 'k' ? '123456?thread=456' : '123456_456';
          results.topicTransition = observe();

          // Native transcript identity and composer/header must agree during SPA transitions.
          location.hash = '987654'; results.routeOnlySwitch = observe();
          if (kind === 'k') composer.dataset.peerId = '987654';
          else document.querySelector('.MiddleHeader .Avatar').dataset.peerId = '987654';
          results.staleRowsAfterSwitch = observe();
          if (kind === 'a') transcriptRoot.dataset.listKey = '987654_-1_thread';
          transcript.replaceChildren(row(6, 'Other recipient', { peer: '987654' }));
          if (kind === 'k') {
            results.staleHeaderAfterSwitch = observe();
            document.querySelector('.user-title .peer-title').dataset.peerId = '987654';
          }
          const switched = observe(); results.switched = switched;
          results.recipientSwitchAction = advanceChatSession(session, switched).nextAction;
          location.hash = '123456';
          if (kind === 'k') composer.dataset.peerId = '123456';
          if (kind === 'k') document.querySelector('.user-title .peer-title').dataset.peerId = '123456';
          else document.querySelector('.MiddleHeader .Avatar').dataset.peerId = '123456';
          if (kind === 'a') transcriptRoot.dataset.listKey = '123456_-1_thread';
          transcript.replaceChildren(); session = createChatSession();
          const started = Date.parse('2026-10-07T00:00:00Z');
          for (let minute = 1; minute <= 720; minute++) {
            transcript.replaceChildren(row(minute + 1000, 'Recurring question'));
            const snapshot = observe(); snapshot.observedAt = new Date(started + minute * 60000).toISOString();
            step = advanceChatSession(session, snapshot, started + minute * 60000);
            if (step.newMessages.length !== 1 || step.nextAction !== 'reply') throw new Error(`Lost new native message at minute ${minute}`);
            session = step.session;
            if (minute === 250 || minute === 500) session = JSON.parse(JSON.stringify(serializeChatSession(session)));
          }
          results.seenMessagesBound = session.seenMessageIds.length;
          results.sessionBytes = JSON.stringify(session).length;
          transcript.replaceChildren(row(1720, 'Latest question edited after restart'));
          const latestEdit = advanceChatSession(session, observe());
          results.latestEditAtWatermark = latestEdit.newMessages.length;
          session = latestEdit.session;
          transcript.replaceChildren(row(1001, 'Recurring question'));
          results.oldVirtualRowAction = advanceChatSession(session, observe()).nextAction;
          // Multiple old virtual windows can evict every recent cached ID.
          for (let window = 0; window < 4; window++) {
            transcript.replaceChildren(...Array.from({ length: 100 }, (_, index) => row(1001 + window * 100 + index, 'Recurring question')));
            session = advanceChatSession(session, observe()).session;
          }
          session = JSON.parse(JSON.stringify(serializeChatSession(session)));
          transcript.replaceChildren(row(1720, 'Latest question edited after restart'));
          results.returnToLatestUnchanged = advanceChatSession(session, observe()).newMessages.length;
          transcript.replaceChildren(row(1721, 'Deferred verification question'));
          const paused = observe(); paused.userInput = { required: true, reason: 'otp' };
          step = advanceChatSession(session, paused); session = JSON.parse(JSON.stringify(serializeChatSession(step.session)));
          results.pauseAction = step.nextAction;
          results.resumeIncoming = advanceChatSession(session, observe()).newMessages.filter(message => message.direction === 'incoming').length;
          document.querySelector('input').focus(); window.__wb_ax_lookup = () => null;
          results.searchComposer = observe();
          return results;
        }, kind);
        assert.equal(result.initial.success, true);
        assert.equal(result.nativeWithoutFocusedEditor.success, true);
        assert.equal(result.nativeWithoutFocusedEditor.composer.available, true);
        assert.equal(result.transcriptAnimation.success, false);
        assert.equal(result.competingTranscripts.success, false);
        if (kind === 'a') {
          assert.equal(result.inactiveSlideMessages.length, 3);
          assert.equal(result.transitioningSlide.success, false);
        }
        assert.equal(result.cappedNative.length, 200);
        assert.equal(result.cappedNative[0].text, 'Bounded question 50');
        assert.equal(result.cappedNative.at(-1).text, 'Bounded question 249');
        assert.equal(result.initial.conversationIdentity, 'Saved Messages');
        assert.equal(result.initial.messages.length, 3);
        assert.deepEqual(result.initial.messages.map(message => message.direction), ['outgoing', 'incoming', 'incoming']);
        assert.deepEqual(result.initial.messages.map(message => message.text), ['My own note', 'Same text', 'Same text']);
        assert.notEqual(result.initial.messages[1].id, result.initial.messages[2].id);
        assert.equal(result.initialReplyCount, 2);
        assert.equal(result.pendingMessages.some(message => /Pending note|Failed note/.test(message.text)), false);
        assert.equal(result.sentMessages.some(message => message.text === 'Pending note' && message.direction === 'outgoing'), true);
        assert.equal(result.pendingDeliveryPreserved, true);
        assert.equal(result.sentDeliveryCleared, true);
        assert.equal(result.sameReplyRejected, 'already_sent');
        assert.equal(result.editedIncoming.length, 1);
        assert.equal(result.editedIncoming[0].text, 'Same text revised');
        assert.equal(result.repeatedEditDeltas, 0);
        assert.equal(result.topicTransition.success, false, 'A same-peer topic switch needs topic-specific evidence');
        assert.equal(result.routeOnlySwitch.success, false);
        assert.equal(result.staleRowsAfterSwitch.success, false);
        if (kind === 'k') assert.equal(result.staleHeaderAfterSwitch.success, false);
        assert.equal(result.switched.success, true);
        assert.notEqual(result.switched.threadKey, result.initial.threadKey);
        assert.equal(result.recipientSwitchAction, 'pause_for_user');
        assert.equal(result.seenMessagesBound, 200);
        assert.ok(result.sessionBytes < 16000, 'Twelve hours must retain bounded state');
        assert.equal(result.latestEditAtWatermark, 1, 'Latest incoming edit must survive the native watermark');
        assert.notEqual(result.oldVirtualRowAction, 'reply', 'Historical virtual rows cannot trigger a second reply');
        assert.equal(result.returnToLatestUnchanged, 0, 'Returning to the unchanged latest row after history/cache eviction cannot trigger a second reply');
        assert.equal(result.pauseAction, 'pause_for_user');
        assert.equal(result.resumeIncoming, 1, 'OTP pause must not consume the deferred incoming message');
        assert.equal(result.searchComposer.success, false);
      } finally { await browser.close(); }
    });
  }
}
