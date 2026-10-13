import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';
import { createNativeActionMarker } from '../firefox-companion/session.mjs';

const token = 'approved-retry-private-grant-token';
const runToken = 'approved-retry-run';
const sources = new Map(await Promise.all(['chrome', 'firefox'].map(async build => [build,
  await Promise.all(['rich-text-toolbar-heuristic.js', 'accessibility-tree.js', 'page-monitor.js', 'content.js']
    .map(file => readFile(new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')))])));

function html(shape = 'generic') {
  const editor = shape === 'generic' ? '<input id="editor" aria-label="Draft" value="Original draft">'
    : `<div id="editor" contenteditable="true" role="textbox" aria-label="Draft" ${shape === 'x' ? 'data-testid="tweetTextarea_0"' : 'class="ProseMirror"'}><p>Original draft</p></div>`;
  const button = shape === 'bluesky' ? '<div id="send" role="button" tabindex="0" data-testid="composerPublishBtn" aria-label="Publish">Post</div>'
    : `<button id="send" type="button" ${shape === 'x' ? 'data-testid="tweetButtonInline"' : ''}>Send</button>`;
  return `<!doctype html><style>body{margin:0;font:16px sans-serif;height:1500px}
    #composer{margin:25px;width:450px;padding:10px}#editor{width:320px;min-height:55px;border:1px solid}
    #send{display:block;width:100px;height:35px;margin-top:12px}#counter{height:24px}#outside{position:absolute;left:650px;top:20px}
    #human{position:absolute;left:650px;top:120px}</style><div id="composer" ${shape === 'bluesky' ? 'role="dialog" aria-modal="true"' : ''}>
    <form id="form" action="/original-destination" method="post">${editor}${button}<span id="counter">0</span></form></div>
    <aside id="outside">0</aside><button id="human">Human control</button>`;
}

async function fixture(browser, build, { shape = 'generic', granted = true, grantDocument = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await context.route('https://relaxed-monitor.invalid/**', route => route.fulfill({ contentType: 'text/html', body: html(shape) }));
  await context.addInitScript(({ granted, grantDocument, token, runToken }) => {
    window.qaGranted = false; window.qaRunToken = runToken; window.qaFeedback = []; window.qaClicks = 0;
    const listeners = [];
    window.chrome = window.browser = { runtime: { getURL: value => value,
      onMessage: { addListener: fn => listeners.push(fn), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: qaRunToken,
          documentToken: message.documentToken, ...(qaGranted ? { relaxedMonitorGrant: {
            grantToken: token, runToken: qaRunToken, documentToken: grantDocument ? message.documentToken : 'another-document',
          } } : {}) };
        if (message.action === 'page_feedback') qaFeedback.push(message.feedback);
        return { accepted: true };
      },
    } };
    window.qaMessage = (action, params = {}) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No response for ${action}`)), 5000);
      let answered = false;
      const respond = value => { answered = true; clearTimeout(timeout); resolve(value); };
      for (const listener of listeners) {
        const result = listener(action === 'page_monitor_state'
          ? { target: 'content', action, runToken: qaRunToken, ...params }
          : { target: 'content', action, params: { runToken: qaRunToken, ...params } }, {}, respond);
        if (answered || result === true) return;
      }
      clearTimeout(timeout); resolve(undefined);
    });
  }, { granted, grantDocument, token, runToken });
  for (const content of sources.get(build)) await context.addInitScript({ content });
  const page = await context.newPage();
  await page.goto('https://relaxed-monitor.invalid/start');
  await page.waitForFunction(() => __wbPageMonitor?.active);
  await page.waitForTimeout(180);
  await page.evaluate(async granted => { qaGranted = granted; await qaMessage('page_monitor_state', { active: true }); }, granted);
  await page.evaluate(() => document.getElementById('send').addEventListener('click', () => qaClicks++));
  return { page, context };
}

async function capture(page, selector = '#send', extra = {}) {
  return page.evaluate(({ selector, extra, token }) => qaMessage('page_monitor_capture_model', {
    includeTree: true, relaxedMonitorGrantToken: token, actionTarget: { tool: 'click_ax', selector }, ...extra,
  }), { selector, extra, token });
}
async function validate(page, snapshot, selector = '#send', tool = 'click_ax', extra = {}) {
  return page.evaluate(({ snapshot, selector, tool, extra, token }) => qaMessage('page_monitor_validate_model', {
    snapshotToken: snapshot.snapshotToken, selector, tool, relaxedMonitorGrantToken: token, ...extra,
  }), { snapshot, selector, tool, extra, token });
}
async function prepare(page, snapshot, selector = '#send', tool = 'click_ax') {
  return page.evaluate(({ snapshot, selector, tool, token }) => qaMessage('page_monitor_prepare', {
    expectedModelSnapshot: snapshot.snapshotToken, selector, tool, relaxedMonitorGrantToken: token,
    allowPassiveRebase: true, operationId: 'owned-retry-action',
  }), { snapshot, selector, tool, token });
}
async function fence(page, kind = 'click') {
  return page.evaluate(kind => qaMessage('page_monitor_dispatch', {
    operationId: 'owned-retry-action', kind, fenceOnly: true,
  }), kind);
}

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: approved retry binds an observed original target through continual passive churn`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const shape of ['generic', 'x', 'bluesky']) await t.test(shape, async () => {
        const f = await fixture(browser, build, { shape });
        try {
          const snapshot = await capture(f.page);
          assert.equal(snapshot.ready, true, JSON.stringify(snapshot));
          assert.equal(JSON.stringify(snapshot).includes(token), false);
          await f.page.evaluate(() => {
            window.qaChurn = setInterval(() => {
              counter.textContent = String(Number(counter.textContent) + 1);
              outside.textContent = String(Number(outside.textContent) + 1);
            }, 8);
          });
          await f.page.waitForTimeout(80);
          const binding = await validate(f.page, snapshot);
          assert.equal(binding.ready, true, JSON.stringify(binding));
          assert.equal(binding.relaxed, true); assert.equal(binding.bindingKind, 'relaxed_target');
          assert.equal(JSON.stringify(binding).includes('Original draft'), false);
          assert.equal(JSON.stringify(binding).includes(token), false);
          assert.equal((await prepare(f.page, snapshot)).modelBindingValid, true);
          await f.page.waitForTimeout(30);
          assert.equal((await fence(f.page)).ready, true);
          const result = await f.page.evaluate(() => qaMessage('click_ax', { ref_id: __wb_ax_ref(send) }));
          assert.equal(result.success, true, JSON.stringify(result));
          assert.equal(await f.page.evaluate(() => qaClicks), 1);
        } finally { await f.context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: relaxed native clicks validate the supplied point after passive target movement`, { timeout: 60000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const scenario of [
        { name: 'an unchanged off-center point passes', moved: false, freshPoint: false, explicitRef: false, accepted: true },
        { name: 'a stale native marker cannot approve a point over another button', moved: true, freshPoint: false, explicitRef: false, accepted: false },
        { name: 'an explicit original ref cannot conceal stale coordinates', moved: true, freshPoint: false, explicitRef: true, accepted: false },
        { name: 'a freshly resolved point follows the unchanged moved target', moved: true, freshPoint: true, explicitRef: false, accepted: true },
      ]) await t.test(scenario.name, async () => {
        const f = await fixture(browser, build);
        try {
          await f.page.evaluate(() => {
            window.qaWrongClicks = 0;
            human.addEventListener('click', () => qaWrongClicks++);
          });
          const snapshot = await capture(f.page);
          assert.equal(snapshot.monitoringRelaxed, true);
          assert.equal((await prepare(f.page, snapshot)).modelBindingValid, true);
          const native = await f.page.evaluate(() => {
            const rect = send.getBoundingClientRect();
            // Match the transport race: the receiver marker and revision are
            // captured before page layout changes, separately from dispatch.
            send.setAttribute('data-webbrain-native-target', 'qa-native-point-target');
            const fence = document.documentElement.getAttribute('data-webbrain-page-revision');
            const split = fence.lastIndexOf(':');
            return { nativeTarget: 'qa-native-point-target', ref_id: __wb_ax_ref(send),
              documentToken: fence.slice(0, split), documentRevision: Number(fence.slice(split + 1)),
              x: rect.left + 5, y: rect.top + 5,
              rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
          });
          if (scenario.moved) await f.page.evaluate(rect => {
            send.style.transform = 'translateY(120px)';
            human.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0`;
          }, native.rect);
          const point = scenario.freshPoint ? await f.page.evaluate(() => {
            const rect = send.getBoundingClientRect();
            return { x: rect.left + 5, y: rect.top + 5 };
          }) : { x: native.x, y: native.y };
          assert.equal(await f.page.evaluate(point => document.elementFromPoint(point.x, point.y)?.id, point),
            scenario.accepted ? 'send' : 'human');
          const receipt = await f.page.evaluate(({ native, point, explicitRef }) => qaMessage('page_monitor_dispatch', {
            operationId: 'owned-retry-action', kind: 'click', nativeTarget: native.nativeTarget,
            documentToken: native.documentToken, documentRevision: native.documentRevision, ...point,
            ...(explicitRef ? { ref_id: native.ref_id } : {}),
            eventTypes: ['pointerdown', 'mousedown', 'click'],
          }), { native, point, explicitRef: scenario.explicitRef });
          // Simulate the transport only executing input after its fence agrees.
          if (receipt.ready) await f.page.mouse.click(point.x, point.y);
          assert.equal(receipt.ready, scenario.accepted, JSON.stringify(receipt));
          if (!scenario.accepted) assert.equal(receipt.preparationVeto.predicate, 'target_hit_changed');
          assert.equal(await f.page.evaluate(() => qaWrongClicks), 0);
          assert.equal(await f.page.evaluate(() => qaClicks), scenario.accepted ? 1 : 0);
        } finally { await f.context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: no private state grant, mismatched grant or old observation preserves ordinary monitoring`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const options of [{ granted: false }, { grantDocument: false }]) await t.test(JSON.stringify(options), async () => {
        const f = await fixture(browser, build, options);
        try {
          const snapshot = await capture(f.page);
          const binding = await validate(f.page, snapshot);
          assert.equal(binding.ready, false); assert.equal(binding.relaxed, undefined);
          assert.equal(binding.certificationFailure, 'owner_unresolved');
          assert.equal((await prepare(f.page, snapshot)).modelBindingValid, false);
          assert.equal((await fence(f.page)).ready, false);
          await f.page.evaluate(({ token, runToken }) => qaMessage('page_monitor_state', { active: true,
            relaxedMonitorGrant: { grantToken: token, runToken, documentToken: 'forged' } }), { token, runToken });
          assert.equal((await validate(f.page, snapshot)).relaxed, undefined);
        } finally { await f.context.close(); }
      });
      await t.test('grant cannot bless a snapshot captured without authority or a real observed tree', async () => {
        const f = await fixture(browser, build, { granted: false });
        try {
          const original = await capture(f.page);
          await f.page.evaluate(async () => { qaGranted = true; await qaMessage('page_monitor_state', { active: true }); });
          assert.equal((await validate(f.page, original)).relaxed, undefined);
          const metadata = await capture(f.page, '#send', { includeTree: false });
          assert.equal((await validate(f.page, metadata)).relaxed, undefined);
          const fresh = await capture(f.page);
          assert.equal((await validate(f.page, fresh)).relaxed, true);
          assert.equal((await validate(f.page, fresh, '#send', 'click_ax', { relaxedMonitorGrantToken: 'arbitrary-model-token' })).ready, false);
        } finally { await f.context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: target changes, lost actionability, human input and navigation expire the retry`, { timeout: 180000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const [name, mutate] of [
        ['same-markup replacement', page => page.evaluate(() => send.replaceWith(send.cloneNode(true)))],
        ['same node moved', page => page.evaluate(() => composer.append(send))],
        ['move then restore', page => page.evaluate(() => { composer.append(send); form.append(send); })],
        ['ancestor moved', page => page.evaluate(() => { const wrapper = document.createElement('div'); document.body.append(wrapper); wrapper.append(composer); })],
        ['form changed', page => page.evaluate(() => form.action = '/different-destination')],
        ['form change then restore', page => page.evaluate(() => { form.action = '/different-destination'; form.setAttribute('action', '/original-destination'); })],
        ['target label changed', page => page.evaluate(() => send.textContent = 'Different action')],
        ['disabled target', page => page.evaluate(() => send.disabled = true)],
        ['hidden target', page => page.evaluate(() => send.style.display = 'none')],
        ['covering overlay', page => page.evaluate(() => { const overlay = document.createElement('div'); overlay.style.cssText = 'position:fixed;inset:0;background:white;z-index:1000'; document.body.append(overlay); })],
        ['human pointer', page => page.click('#human')],
        ['human key', page => page.keyboard.press('Escape')],
        ['unowned script focus', page => page.evaluate(() => human.focus())],
        ['same-document navigation', page => page.evaluate(() => history.pushState({}, '', '/another-page'))],
        ['Stop', page => page.evaluate(() => qaMessage('page_monitor_state', { active: false }))],
      ]) await t.test(name, async () => {
        const f = await fixture(browser, build);
        try {
          const snapshot = await capture(f.page);
          assert.equal((await prepare(f.page, snapshot)).modelBindingValid, true);
          await mutate(f.page);
          assert.equal((await fence(f.page)).ready, false, name);
          assert.equal((await validate(f.page, snapshot)).ready, false, name);
          assert.equal(await f.page.evaluate(() => qaClicks), 0);
        } finally { await f.context.close(); }
      });
      await t.test('navigation to a new document cannot reuse the old grant or snapshot', async () => {
        const f = await fixture(browser, build);
        try {
          const snapshot = await capture(f.page);
          await f.page.reload(); await f.page.waitForFunction(() => __wbPageMonitor?.active);
          assert.equal((await validate(f.page, snapshot)).ready, false);
        } finally { await f.context.close(); }
      });
      await t.test('a dispatch cannot exchange the approved selector for a different original node', async () => {
        const f = await fixture(browser, build);
        try {
          const snapshot = await capture(f.page);
          assert.equal((await prepare(f.page, snapshot)).modelBindingValid, true);
          const result = await f.page.evaluate(() => qaMessage('page_monitor_dispatch', {
            operationId: 'owned-retry-action', selector: '#human', kind: 'click', fenceOnly: true,
          }));
          assert.equal(result.ready, false); assert.equal(result.preparationVeto.predicate, 'target_changed');
        } finally { await f.context.close(); }
      });
      for (const [name, mutate] of [
        ['text changed and restored', () => { send.textContent = 'Delete everything'; send.textContent = 'Send'; }],
        ['form changed and restored', () => { form.action = '/different'; form.setAttribute('action', '/original-destination'); }],
        ['parent changed and restored', () => { composer.append(send); form.append(send); }],
      ]) await t.test(`inference tombstone before first validate: ${name}`, async () => {
        const f = await fixture(browser, build);
        try {
          const snapshot = await capture(f.page);
          await f.page.evaluate(mutate);
          const validation = await validate(f.page, snapshot);
          assert.equal(validation.ready, false); assert.equal(validation.reason, 'target_changed');
        } finally { await f.context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: owned focus, scroll and repeated native input keep the original relaxed target bound`, { timeout: 120000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const shape of ['generic', 'x', 'bluesky']) await t.test(shape, async () => {
        const f = await fixture(browser, build, { shape });
        try {
          await f.page.evaluate(() => composer.style.marginTop = '520px');
          const snapshot = await capture(f.page, '#editor');
          assert.equal((await validate(f.page, snapshot, '#editor', 'type_ax')).relaxed, true);
          assert.equal((await prepare(f.page, snapshot, '#editor', 'type_ax')).modelBindingValid, true);
          await f.page.evaluate(() => {
            const finish = __wbPageMonitor.beginContentAction('type_ax', { ref_id: __wb_ax_ref(editor), _bidiPrepare: true });
            __wbPageMonitor.withLocalPreparation('scroll', editor, () => editor.scrollIntoView({ block: 'center' }));
            __wbPageMonitor.withLocalPreparation('focus', editor, () => editor.focus());
            finish();
          });
          assert.ok(await f.page.evaluate(() => scrollY > 0), 'Owned preparation really scrolled the document');
          await f.page.waitForTimeout(70);
          let receipt = await fence(f.page, 'input'); assert.equal(receipt.ready, true, JSON.stringify(receipt));
          for (let sequence = 1; sequence <= 2; sequence++) {
            await f.page.evaluate(() => { counter.textContent += '1'; outside.textContent += '1'; });
            const validation = await f.page.evaluate(guard => qaMessage('page_monitor_validate', { ...guard, kind: 'input' }), receipt.guard);
            assert.equal(validation.ready, true, JSON.stringify(validation));
            receipt.guard.revision = validation.revision;
            const marker = createNativeActionMarker(receipt.guard, 'input', sequence, false);
            await f.page.evaluate(marker => editor.setAttribute('data-webbrain-native-action', marker), marker);
            await f.page.evaluate(() => { counter.textContent += '2'; outside.textContent += '2'; });
            await f.page.keyboard.insertText(String(sequence));
            assert.equal(await f.page.evaluate(() => editor.hasAttribute('data-webbrain-native-action')), false);
          }
          assert.match(await f.page.evaluate(() => editor.value ?? editor.textContent), /12/);
          assert.equal(await f.page.evaluate(() => qaFeedback.some(event => event.source === 'user')), false);
          await f.page.evaluate(() => qaMessage('page_monitor_finish', { operationId: 'owned-retry-action' }));
          await f.page.waitForTimeout(210);
          const afterInput = await capture(f.page);
          assert.equal(afterInput.monitoringRelaxed, true);
          assert.equal((await validate(f.page, afterInput)).relaxed, true);
          await f.page.evaluate(() => form.action = '/changed-after-input');
          assert.equal((await f.page.evaluate(guard => qaMessage('page_monitor_validate', { ...guard, kind: 'input' }), receipt.guard)).ready, false);
        } finally { await f.context.close(); }
      });
    } finally { await browser.close(); }
  });

  test(`${build}: a completed owned editor write preserves the retry for a fresh next-button observation`, { timeout: 60000 }, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const shape of ['generic', 'x']) await t.test(shape, async () => {
        const f = await fixture(browser, build, { shape });
        try {
          const snapshot = await capture(f.page, '#editor');
          assert.equal(snapshot.monitoringRelaxed, true);
          assert.equal((await prepare(f.page, snapshot, '#editor', 'set_field')).modelBindingValid, true);
          const input = await f.page.evaluate(() => qaMessage('set_field', { ref_id: __wb_ax_ref(editor), text: 'Exact completed owned draft' }));
          assert.equal(input.success, true, JSON.stringify(input));
          await f.page.waitForTimeout(220);
          const next = await capture(f.page);
          assert.equal(next.monitoringRelaxed, true, JSON.stringify(next));
          assert.equal((await validate(f.page, next)).relaxed, true);
          assert.equal((await prepare(f.page, next)).modelBindingValid, true);
          const click = await f.page.evaluate(() => qaMessage('click_ax', { ref_id: __wb_ax_ref(send) }));
          assert.equal(click.success, true, JSON.stringify(click));
          assert.equal(await f.page.evaluate(() => qaClicks), 1);
          assert.equal(await f.page.evaluate(() => editor.value ?? editor.textContent), 'Exact completed owned draft');
        } finally { await f.context.close(); }
      });
    } finally { await browser.close(); }
  });
  if (build === 'chrome') test(`${build}: an exact private trusted-typing probe keeps the original relaxed preparation certificate`, { timeout: 60000 }, async () => {
    const browser = await engine.launch({ headless: true });
    const f = await fixture(browser, build, { shape: 'bluesky' });
    try {
      const snapshot = await capture(f.page, '#editor');
      assert.equal((await prepare(f.page, snapshot, '#editor', 'set_field')).modelBindingValid, true);
      const response = await f.page.evaluate(() => qaMessage('set_field', { ref_id: __wb_ax_ref(editor), text: 'Owned managed input' }));
      assert.equal(response.trustedTypeRequired, true); assert.equal(response.noDispatch, true);
      const prepared = await f.page.evaluate(({ snapshot, token }) => qaMessage('ax_prepare_field_for_trusted_type', {
        ref_id: __wb_ax_ref(editor), expectedModelSnapshot: snapshot.snapshotToken, relaxedMonitorGrantToken: token, allowPassiveRebase: true,
      }), { snapshot, token });
      assert.equal(prepared.success, true, JSON.stringify(prepared));
      const current = await capture(f.page, '#editor');
      assert.equal(current.monitoringRelaxed, true);
      assert.equal((await validate(f.page, snapshot, '#editor', 'set_field')).relaxed, true);
    } finally { await f.context.close(); await browser.close(); }
  });
  test(`${build}: completed owned menu activation keeps the run while its old snapshot expires`, { timeout: 60000 }, async () => {
    const browser = await engine.launch({ headless: true });
    const f = await fixture(browser, build);
    try {
      const snapshot = await capture(f.page);
      assert.equal((await prepare(f.page, snapshot)).modelBindingValid, true);
      await f.page.evaluate(() => send.addEventListener('click', () => {
        send.setAttribute('aria-expanded', 'true'); send.textContent = 'Close options';
      }));
      assert.equal((await f.page.evaluate(() => qaMessage('click_ax', { ref_id: __wb_ax_ref(send) }))).success, true);
      await f.page.waitForTimeout(210);
      const fresh = await capture(f.page, '#human');
      assert.equal(fresh.monitoringRelaxed, true);
      assert.equal((await validate(f.page, fresh, '#human')).relaxed, true);
      assert.equal((await validate(f.page, snapshot)).ready, false, 'Completion never rewrites the old inference certificate');
    } finally { await f.context.close(); await browser.close(); }
  });
}
