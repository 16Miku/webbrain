import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { chromium, firefox } from 'playwright';

const before = process.env.WEBBRAIN_UPLOAD_OWNER_BEFORE_SOURCE;
const sources = new Map(['chrome', 'firefox'].map(build => [build, new Map(
  ['accessibility-tree.js', 'page-monitor.js'].map(file => [file, fs.readFileSync(before
    ? path.join(before, `${build}-${file}`)
    : new URL(`../src/${build}/src/content/${file}`, import.meta.url), 'utf8')]))]));
const selector = 'section:nth-of-type(2) input[type=file]';
const html = `<!doctype html><style>body{font:16px sans-serif;margin:16px}section{padding:12px;border:1px solid #aaa;margin:8px;width:450px}input[type=file]{display:none}button{padding:8px}</style>
<body data-account-id="owned-account"><h1>Owned account settings</h1>
${['Cover image', 'Account picture', 'Other picture'].map((purpose, index) => `<section><div class="caption"><span>${purpose}</span></div><div><button type="button">Upload</button><div><input id="file-selector" type="file" accept="image/*" data-slot="${index}"></div></div><p>No file attached</p></section>`).join('')}
<aside id="counter">1</aside><script>
window.nativeChanges=[0,0,0];document.querySelectorAll('input[type=file]').forEach((el,index)=>el.addEventListener('change',()=>nativeChanges[index]++));
</script>`;

async function fixture(browser, build) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  await context.route('https://upload-owner.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.addInitScript(() => {
    window.listeners = []; window.feedback = [];
    window.chrome = window.browser = { runtime: {
      onMessage: { addListener: fn => listeners.push(fn), removeListener() {} },
      async sendMessage(message) {
        if (message.action === 'get_page_monitor_state') return { active: true, runToken: 'owned-upload', documentToken: message.documentToken };
        if (message.action === 'page_feedback') { feedback.push(message.feedback); return { accepted: true }; }
        return {};
      },
    } };
    window.deliver = (action, params = {}) => new Promise(resolve => {
      let answered = false;
      const respond = value => { answered = true; resolve(value); };
      for (const listener of listeners) {
        const message = action === 'page_monitor_state'
          ? { target: 'content', action, runToken: 'owned-upload', ...params }
          : { target: 'content', action, params: { runToken: 'owned-upload', ...params } };
        const value = listener(message, {}, respond);
        if (answered || value === true) break;
      }
    });
  });
  for (const [file, content] of sources.get(build)) await context.addInitScript({ content });
  const page = await context.newPage();
  await page.goto('https://upload-owner.test/current');
  await page.waitForFunction(() => window.__wbPageMonitor?.active);
  await page.waitForTimeout(100);
  return { context, page };
}
async function capture(page) {
  return page.evaluate(() => deliver('page_monitor_capture_model', { includeTree: true }));
}
async function validate(page, snapshot, target = selector) {
  return page.evaluate(({ snapshot, target }) => deliver('page_monitor_validate_model', {
    snapshotToken: snapshot.snapshotToken, tool: 'upload_file', selector: target,
  }), { snapshot, target });
}
async function upload(page, snapshot, target = selector) {
  return page.evaluate(async ({ snapshot, target }) => {
    const operationId = 'owned-upload-operation';
    const prepared = await deliver('page_monitor_prepare', { operationId, tool: 'upload_file', selector: target,
      expectedModelSnapshot: snapshot.snapshotToken, allowPassiveRebase: true });
    const fence = await deliver('page_monitor_dispatch', { operationId, kind: 'input', fenceOnly: true });
    let error = null;
    if (fence.ready) {
      try {
        __wbPageMonitor.withPreparedDispatch(operationId, () => __wbPageMonitor.withLocalDispatch(() => {
          const input = document.querySelector(target), transfer = new DataTransfer();
          transfer.items.add(new File(['owned exact bytes'], 'owned.png', { type: 'image/png' }));
          input.files = transfer.files; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
        }));
      } catch (caught) { error = caught.code || caught.message; }
    }
    return { prepared, fence, error, changes: nativeChanges,
      files: [...document.querySelectorAll('input[type=file]')].map(input => [...input.files].map(file => ({ name: file.name, size: file.size }))) };
  }, { snapshot, target });
}

const mutations = [
  ['purpose changed', () => { document.querySelectorAll('.caption span')[1].textContent = 'Other account picture'; }],
  ['input replaced', () => { const input = document.querySelectorAll('input')[1]; input.replaceWith(input.cloneNode()); }],
  ['owner replaced', () => { const section = document.querySelectorAll('section')[1]; section.replaceWith(section.cloneNode(true)); }],
  ['account changed', () => document.body.setAttribute('data-account-id', 'different-account')],
  ['file accept changed', () => document.querySelectorAll('input')[1].setAttribute('accept', 'application/pdf')],
  ['file disabled', () => { document.querySelectorAll('input')[1].disabled = true; }],
  ['file multiple changed', () => { document.querySelectorAll('input')[1].multiple = true; }],
  ['file field name changed', () => document.querySelectorAll('input')[1].setAttribute('name', 'other-field')],
  ['file form association changed', () => document.querySelectorAll('input')[1].setAttribute('form', 'other-form')],
  ['action changed', () => document.querySelectorAll('button')[1].setAttribute('data-action', 'different-action')],
  ['new local interactive control', () => { const button = document.createElement('button'); button.textContent = 'Other action'; document.querySelectorAll('section')[1].append(button); }],
  ['owner hidden', () => { document.querySelectorAll('section')[1].style.display = 'none'; }],
  ['owner inert', () => { document.querySelectorAll('section')[1].inert = true; }],
  ['owner aria hidden', () => document.querySelectorAll('section')[1].setAttribute('aria-hidden', 'true')],
  ['URL changed', () => history.replaceState({}, '', '/another-account')],
];

for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: bounded native file owners have complete observed purpose and exact upload fences`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      await t.test('native section purposes distinguish identical Upload controls and certify the exact hidden file', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          assert.equal(snapshot.ready, true);
          assert.match(snapshot.page.pageContent, /region "Cover image/);
          assert.match(snapshot.page.pageContent, /region "Account picture/);
          assert.match(snapshot.page.pageContent, /region "Other picture/);
          assert.equal((await validate(page, snapshot)).ready, true);
          const result = await upload(page, snapshot);
          assert.equal(result.prepared.modelBindingValid, true); assert.equal(result.fence.ready, true); assert.equal(result.error, null);
          assert.deepEqual(result.changes, [0, 1, 0]);
          assert.deepEqual(result.files, [[], [{ name: 'owned.png', size: 17 }], []]);
        } finally { await context.close(); }
      });
      await t.test('unrelated outside and other section text updates retain the original intended input', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          await page.evaluate(() => { document.getElementById('counter').textContent = '2'; document.querySelectorAll('.caption span')[0].textContent = 'Updated cover help'; });
          assert.equal((await validate(page, snapshot)).ready, true);
          const result = await upload(page, snapshot); assert.equal(result.fence.ready, true); assert.deepEqual(result.changes, [0, 1, 0]);
        } finally { await context.close(); }
      });
      // The preserved-source run isolates the four genuine missing-owner
      // positives. Current-source runs exercise every strict negative below.
      if (before) return;
      await t.test('direct native section caption stays observed without borrowing editable contents', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => {
            const section = document.querySelectorAll('section')[1];
            section.querySelector('.caption').replaceWith(document.createTextNode('Account picture'));
          });
          const snapshot = await capture(page);
          assert.match(snapshot.page.pageContent, /region "Account picture/);
          assert.equal((await validate(page, snapshot)).ready, true);
          const result = await upload(page, snapshot);
          assert.equal(result.fence.ready, true); assert.deepEqual(result.changes, [0, 1, 0]);
        } finally { await context.close(); }
      });
      for (const [name, mutation] of mutations) await t.test(`original certificate rejects ${name} before file assignment`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, true);
          await page.evaluate(mutation);
          assert.equal((await validate(page, snapshot)).ready, false);
          const result = await upload(page, snapshot); assert.equal(result.fence.ready, false); assert.deepEqual(result.changes, [0, 0, 0]);
          assert.equal(result.files.flat().length, 0);
        } finally { await context.close(); }
      });
      for (const [name, mutation, target = selector] of [
        ['no rendered purpose', () => { document.querySelectorAll('.caption')[1].remove(); document.querySelectorAll('section')[1].querySelector('p').remove(); }],
        ['hidden purpose', () => { document.querySelectorAll('.caption')[1].style.display = 'none'; document.querySelectorAll('section')[1].querySelector('p').remove(); }],
        ['purpose borrowed from nested section', () => { const section = document.querySelectorAll('section')[1]; section.querySelector('.caption').remove(); section.querySelector('p').remove(); const nested = document.createElement('section'); nested.textContent = 'Foreign nested picture'; section.prepend(nested); }],
        ['oversized local owner', () => { const owner = document.querySelectorAll('section')[1]; for (let i = 0; i < 260; i++) owner.append(document.createElement('span')); }],
        ['duplicate visible purposes', () => { document.querySelectorAll('.caption span')[0].textContent = 'Account picture'; }],
        ['disabled file target', () => { document.querySelectorAll('input')[1].disabled = true; }],
        ['a hidden input without a native section', () => { const section = document.querySelectorAll('section')[1], replacement = document.createElement('div'); replacement.dataset.unownedUpload = 'true'; replacement.innerHTML = section.innerHTML; section.replaceWith(replacement); }, '[data-unowned-upload] input[type=file]'],
      ]) await t.test(`fresh observation does not certify ${name}`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(mutation); const snapshot = await capture(page);
          assert.equal((await validate(page, snapshot, target)).ready, false);
          const result = await upload(page, snapshot, target); assert.equal(result.fence.ready, false); assert.deepEqual(result.changes, [0, 0, 0]);
        } finally { await context.close(); }
      });
      await t.test('duplicate-ID or nonunique selectors never certify a hidden target', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page);
          for (const target of ['#file-selector', 'input[type=file]']) {
            assert.equal((await validate(page, snapshot, target)).ready, false);
            const result = await upload(page, snapshot, target); assert.equal(result.fence.ready, false); assert.deepEqual(result.changes, [0, 0, 0]);
          }
        } finally { await context.close(); }
      });
      await t.test('a genuine human intervention revokes the original model snapshot', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page); await page.locator('#counter').click();
          assert.equal((await validate(page, snapshot)).ready, false);
          const result = await upload(page, snapshot); assert.equal(result.fence.ready, false); assert.deepEqual(result.changes, [0, 0, 0]);
        } finally { await context.close(); }
      });
      await t.test('Stop revokes the original certificate without any file dispatch', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page); await page.evaluate(() => deliver('page_monitor_state', { active: false }));
          assert.equal((await validate(page, snapshot)).ready, false);
          assert.deepEqual(await page.evaluate(() => nativeChanges), [0, 0, 0]);
        } finally { await context.close(); }
      });
      await t.test('same-URL new document cannot reuse the original upload certificate', async () => {
        const { context, page } = await fixture(browser, build);
        try {
          const snapshot = await capture(page); await page.reload(); await page.waitForFunction(() => window.__wbPageMonitor?.active);
          assert.equal((await validate(page, snapshot)).ready, false);
          const result = await upload(page, snapshot); assert.equal(result.fence.ready, false); assert.deepEqual(result.changes, [0, 0, 0]);
        } finally { await context.close(); }
      });
    } finally { await browser.close(); }
  });
}

// A descriptor is redundant only for a separately authored native button name.
// Exercise actual model certificates and the native file assignment fence, not a
// standalone semantic helper or a fabricated successful upload result.
for (const [build, engine] of [['chrome', chromium], ['firefox', firefox]]) {
  test(`${build}: redundant plain descriptions preserve only the exact native upload owner`, async t => {
    const browser = await engine.launch({ headless: true });
    try {
      for (const placement of ['outside', 'nested']) await t.test(`redundant plain descriptions permit appearance, removal and remount (${placement})`, async () => {
        const { context, page } = await fixture(browser, build);
        try {
          await page.evaluate(() => document.querySelectorAll('button')[1].setAttribute('aria-label', 'Upload'));
          const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, true);
          await page.evaluate(placement => {
            const button = document.querySelectorAll('button')[1];
            const host = document.createElement('x-tooltip-placeholder');host.id = 'owned-duplicate-description';
            host.innerHTML = ' \n   <div><span>Upload</span></div>';
            (placement === 'nested' ? button : button.closest('section')).append(host);
            button.setAttribute('aria-describedby', host.id);
          }, placement);
          assert.equal((await validate(page, snapshot)).ready, true, 'A complete duplicate description adds no new identity.');
          await page.evaluate(() => document.getElementById('owned-duplicate-description').remove());
          assert.equal((await validate(page, snapshot)).ready, true, 'A dangling single ID has no current description.');
          await page.evaluate(placement => {
            const button = document.querySelectorAll('button')[1], host = document.createElement('x-tooltip-placeholder');
            host.id = 'owned-remounted-description';host.innerHTML = '<span>Upload</span>';
            (placement === 'nested' ? button : button.closest('section')).append(host);
            button.setAttribute('aria-describedby', host.id);
          }, placement);
          assert.equal((await validate(page, snapshot)).ready, true, 'A new uniquely resolved duplicate stays semantically equivalent.');
          const result = await upload(page, snapshot);
          assert.equal(result.prepared.modelBindingValid, true); assert.equal(result.fence.ready, true);
          assert.deepEqual(result.changes, [0, 1, 0]); assert.equal(result.files[1][0].name, 'owned.png');
        } finally { await context.close(); }
      });
      await t.test('typed plain custom and native text descriptors retain exact upload ownership', async () => {
        for (const tag of ['x-tooltip-placeholder', 'div', 'span']) {
          const { context, page } = await fixture(browser, build);
          try {
            await page.evaluate(() => document.querySelectorAll('button')[1].setAttribute('aria-label', 'Upload'));
            const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, true, tag);
            await page.evaluate(tag => {
              const button = document.querySelectorAll('button')[1], host = document.createElement(tag);
              host.id = 'owned-typed-description';host.setAttribute('type',tag === 'x-tooltip-placeholder' ? 'truncation' : 'decoration-layout');host.setAttribute('unified','');
              host.innerHTML = ' \n   <div hidden><span>Upload</span></div>';
              document.body.append(host);button.setAttribute('aria-describedby',host.id);
            }, tag);
            assert.equal((await validate(page, snapshot)).ready, true, tag);
            await page.evaluate(() => document.getElementById('owned-typed-description').remove());
            assert.equal((await validate(page, snapshot)).ready, true, 'Removed typed descriptor remains absent.');
            await page.evaluate(tag => {
              const button = document.querySelectorAll('button')[1], host = document.createElement(tag);
              host.id = 'owned-typed-remount';host.setAttribute('type',tag === 'x-tooltip-placeholder' ? 'truncation' : 'decoration-layout');host.textContent = 'Upload';
              button.append(host);button.setAttribute('aria-describedby',host.id);
            }, tag);
            assert.equal((await validate(page, snapshot)).ready, true, tag);
            const result = await upload(page, snapshot);
            assert.equal(result.prepared.modelBindingValid, true); assert.equal(result.fence.ready, true);
            assert.deepEqual(result.changes, [0, 1, 0]); assert.equal(result.files[1][0].name, 'owned.png');
          } finally { await context.close(); }
        }
      });

      await t.test('one native-button wrapper shares only a complete duplicate description with its exact upload owner', async () => {
        for (const placement of ['outside', 'nested wrapper']) {
          const { context, page } = await fixture(browser, build);
          try {
            await page.evaluate(() => {
              const button=document.querySelectorAll('button')[1];button.setAttribute('aria-label','Upload');
              const wrapper=document.createElement('x-owned-button-wrapper');wrapper.id='owned-wrapper';wrapper.setAttribute('tabindex','-1');
              wrapper.setAttribute('type','neutral-action');wrapper.setAttribute('aria-disabled','false');button.before(wrapper);
              const shape=document.createElement('x-owned-button-shape');wrapper.append(shape);shape.append(button);
            });
            const snapshot=await capture(page);assert.equal((await validate(page,snapshot)).ready,true);
            await page.evaluate(placement => {
              const button=document.querySelectorAll('button')[1],wrapper=document.getElementById('owned-wrapper');
              const descriptor=document.createElement('x-owned-tooltip');descriptor.id='owned-wrapper-description';descriptor.setAttribute('type','decoration-layout');
              descriptor.innerHTML=' \n   <div hidden><span>Upload</span></div>';
              (placement==='outside'?document.body:wrapper).append(descriptor);
              button.setAttribute('aria-describedby',descriptor.id);wrapper.setAttribute('aria-describedby',descriptor.id);
            },placement);
            assert.equal((await validate(page,snapshot)).ready,true,placement);
            const fresh=await capture(page);assert.equal(fresh.targetCount,snapshot.targetCount,'A complete observed owner stays covered.');
            await page.evaluate(() => document.getElementById('owned-wrapper-description').remove());
            assert.equal((await validate(page,snapshot)).ready,true,'The exact shared dangling ref names no current description.');
            await page.evaluate(() => {
              const descriptor=document.createElement('x-owned-tooltip');descriptor.id='owned-wrapper-description';
              descriptor.textContent='Upload to another account';document.body.append(descriptor);
            });
            assert.equal((await validate(page,snapshot)).ready,false,'A meaningful late description is fully rechecked.');
            await page.evaluate(() => document.getElementById('owned-wrapper-description').textContent='Upload');
            assert.equal((await validate(page,snapshot)).ready,true,'A canonical remount restores only the original meaning.');
            await page.evaluate(() => document.body.append(document.getElementById('owned-wrapper-description').cloneNode(true)));
            assert.equal((await validate(page,snapshot)).ready,false,'Duplicate late IDs never establish a unique description.');
            await page.evaluate(() => {
              document.querySelectorAll('#owned-wrapper-description').forEach(node=>node.remove());
              const descriptor=document.createElement('x-owned-tooltip');descriptor.id='owned-wrapper-remount';descriptor.textContent='Upload';
              document.body.append(descriptor);const wrapper=document.getElementById('owned-wrapper'),button=wrapper.querySelector('button');
              button.setAttribute('aria-describedby',descriptor.id);wrapper.setAttribute('aria-describedby',descriptor.id);
            });
            assert.equal((await validate(page,snapshot)).ready,true,'A new shared unique ref still proves the same exact duplicate.');
            const result=await upload(page,snapshot);assert.equal(result.prepared.modelBindingValid,true);assert.equal(result.fence.ready,true);
            assert.deepEqual(result.changes,[0,1,0]);assert.equal(result.files[1][0].name,'owned.png');
          } finally { await context.close(); }
        }
      });
      await t.test('wrapper duplication cannot hide independent meaning, another control, focus or state changes', async () => {
        const variants=['different ref','different name','duplicate id','second control','foreign owner','focusable wrapper','wrapper identity',
          'wrapper handler','prototype handler','wrapper label','wrapper labelledby','wrapper type changed','wrapper tabindex changed',
          'wrapper disabled changed','wrapper id changed','wrapper role changed','wrapper text','shadow wrapper','customized wrapper','landmark wrapper'];
        for (const variant of variants) {
          const { context, page } = await fixture(browser,build);
          try {
            await page.evaluate(() => {
              const button=document.querySelectorAll('button')[1];button.setAttribute('aria-label','Upload');
              const wrapper=document.createElement('x-owned-button-wrapper');wrapper.id='owned-wrapper';wrapper.setAttribute('tabindex','-1');
              wrapper.setAttribute('type','neutral-action');wrapper.setAttribute('aria-disabled','false');button.before(wrapper);wrapper.append(button);
            });
            const snapshot=await capture(page);assert.equal((await validate(page,snapshot)).ready,true,variant);
            await page.evaluate(variant => {
              const button=document.querySelectorAll('button')[1],wrapper=document.getElementById('owned-wrapper');
              const descriptor=document.createElement('x-owned-tooltip');descriptor.id='owned-wrapper-description';descriptor.textContent='Upload';document.body.append(descriptor);
              button.setAttribute('aria-describedby',descriptor.id);wrapper.setAttribute('aria-describedby',descriptor.id);
              switch(variant) {
                case 'different ref': { const other=descriptor.cloneNode(true);other.id='other-description';document.body.append(other);wrapper.setAttribute('aria-describedby',other.id);break; }
                case 'different name': descriptor.textContent='Upload to another account';break;
                case 'duplicate id': document.body.append(descriptor.cloneNode(true));break;
                case 'second control': { const other=document.createElement('button');other.hidden=true;wrapper.append(other);break; }
                case 'foreign owner': document.querySelectorAll('section')[0].append(descriptor);break;
                case 'focusable wrapper': wrapper.setAttribute('tabindex','0');break;
                case 'wrapper identity': wrapper.setAttribute('data-entity-type','another-record');break;
                case 'wrapper handler': wrapper.onclick=()=>{};break;
                case 'prototype handler': Object.setPrototypeOf(wrapper,Object.create(Object.getPrototypeOf(wrapper),{onOwnedWrapper:{value:()=>{}}}));break;
                case 'wrapper label': wrapper.setAttribute('aria-label','Other record');break;
                case 'wrapper labelledby': wrapper.setAttribute('aria-labelledby',descriptor.id);break;
                case 'wrapper type changed': wrapper.setAttribute('type','different-action');break;
                case 'wrapper tabindex changed': wrapper.setAttribute('tabindex','-2');break;
                case 'wrapper disabled changed': wrapper.setAttribute('aria-disabled','true');break;
                case 'wrapper id changed': wrapper.id='different-wrapper';break;
                case 'wrapper role changed': wrapper.setAttribute('role','alert');break;
                case 'wrapper text': wrapper.append(document.createTextNode('Another record'));break;
                case 'shadow wrapper': wrapper.attachShadow({mode:'open'}).innerHTML='<slot></slot>';break;
                case 'customized wrapper': wrapper.setAttribute('is','owned-control');break;
                case 'landmark wrapper': wrapper.setAttribute('role','region');break;
              }
            },variant);
            assert.equal((await validate(page,snapshot)).ready,false,variant);
            const result=await upload(page,snapshot);assert.equal(result.fence.ready,false,variant);
            assert.deepEqual(result.changes,[0,0,0],variant);assert.equal(result.files.flat().length,0,variant);
          } finally { await context.close(); }
        }
      });

      await t.test('meaningful, ambiguous and unsafe descriptions keep original no-dispatch fences', async () => {
        const variants = ['description', 'label', 'duplicate', 'control', 'identity', 'handler', 'href', 'value',
          'oversized text', 'oversized nodes', 'role', 'foreign owner', 'shadow', 'slot', 'focusable',
          'labelledby', 'invalid id', 'multiple ids', 'other button text', 'hidden control',
          'prototype handler', 'foreign main', 'semantic state', 'data state', 'target role', 'entity type',
          'native type', 'list type', 'other native type', 'custom built-in type', 'oversized type', 'invalid type', 'target type'];
        for (const variant of variants) {
          const { context, page } = await fixture(browser, build);
          try {
            await page.evaluate(() => document.querySelectorAll('button')[1].setAttribute('aria-label', 'Upload'));
            const snapshot = await capture(page); assert.equal((await validate(page, snapshot)).ready, true, variant);
            await page.evaluate(variant => {
              const button = document.querySelectorAll('button')[1], host = document.createElement('x-tooltip-placeholder');
              host.id = 'owned-duplicate-description';host.innerHTML = '<span>Upload</span>';
              button.append(host);button.setAttribute('aria-describedby', host.id);
              switch (variant) {
                case 'native type': { const input=document.createElement('input');input.setAttribute('type','hidden');host.append(input);break; }
                case 'list type': { const list=document.createElement('ol');list.setAttribute('type','A');host.append(list);break; }
                case 'other native type': { const paragraph=document.createElement('p');paragraph.setAttribute('type','tooltip');host.append(paragraph);break; }
                case 'custom built-in type': host.setAttribute('type','tooltip');host.setAttribute('is','owned-description');break;
                case 'oversized type': host.setAttribute('type','x'.repeat(65));break;
                case 'invalid type': host.setAttribute('type','tooltip\nother');break;
                case 'target type': button.setAttribute('type','submit');break;
                case 'description': host.firstChild.textContent = 'Upload to another account'; break;
                case 'label': button.setAttribute('aria-label', 'Other action'); break;
                case 'duplicate': button.closest('section').append(host.cloneNode(true)); break;
                case 'control': host.append(document.createElement('input')); break;
                case 'hidden control': { const input = document.createElement('input');input.hidden = true;host.append(input);break; }
                case 'identity': host.setAttribute('data-account-id', 'another-account'); break;
                case 'entity type': host.setAttribute('data-account-type', 'another-account-class'); break;
                case 'handler': host.onclick = () => {}; break;
                case 'prototype handler': Object.setPrototypeOf(host, Object.create(Object.getPrototypeOf(host), { onOwnedDescriptor: { value: () => {} } })); break;
                case 'foreign main': { const main = document.createElement('main');main.append(host);document.body.append(main);break; }
                case 'semantic state': host.setAttribute('aria-current', 'page'); break;
                case 'data state': host.setAttribute('data-state', 'other-record'); break;
                case 'target role': button.setAttribute('role', 'link'); break;
                case 'href': host.setAttribute('href', '/another-record'); break;
                case 'value': host.setAttribute('value', 'other'); break;
                case 'oversized text': host.textContent = ' '.repeat(513) + 'Upload'; break;
                case 'oversized nodes': for (let i=0;i<130;i++) host.append(document.createElement('span')); break;
                case 'role': host.setAttribute('role', 'alert'); break;
                case 'foreign owner': document.querySelectorAll('section')[0].append(host); break;
                case 'shadow': host.attachShadow({mode:'open'}).innerHTML = '<span>Upload</span>'; break;
                case 'slot': host.append(document.createElement('slot')); break;
                case 'focusable': host.setAttribute('tabindex', '0'); break;
                case 'labelledby': button.setAttribute('aria-labelledby', host.id); break;
                case 'invalid id': button.setAttribute('aria-describedby', '\u0001'); break;
                case 'multiple ids': button.setAttribute('aria-describedby', host.id + ' missing-description'); break;
                case 'other button text': button.prepend(document.createTextNode('Other record')); break;
              }
            }, variant);
            assert.equal((await validate(page, snapshot)).ready, false, variant);
            const result = await upload(page, snapshot); assert.equal(result.fence.ready, false, variant);
            assert.deepEqual(result.changes, [0, 0, 0], variant); assert.equal(result.files.flat().length, 0, variant);
          } finally { await context.close(); }
        }
      });
    } finally { await browser.close(); }
  });
}
