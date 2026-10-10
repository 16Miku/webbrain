import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const build of ['chrome', 'firefox']) {
  const { createCaptchaBridgeRegistration } = await import(`../src/${build}/src/agent/captcha-bridge-registration.js`);

  test(`${build} registers the page bridge only while a CAPTCHA provider is enabled`, async () => {
    if (build === 'chrome') {
      let registered = [];
      const api = { scripting: {
        getRegisteredContentScripts: async ({ ids }) => registered.filter(script => ids.includes(script.id)),
        registerContentScripts: async scripts => { registered.push(...scripts); },
        unregisterContentScripts: async ({ ids }) => { registered = registered.filter(script => !ids.includes(script.id)); },
      } };
      const registration = createCaptchaBridgeRegistration(api);

      await registration.sync(false);
      assert.equal(registered.length, 0);
      await registration.sync(true);
      assert.equal(registered.length, 1);
      assert.deepEqual(registered[0], {
        id: 'webbrain-captcha-callback-bridge',
        matches: ['<all_urls>'],
        js: ['src/content/captcha-callback-bridge.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        matchOriginAsFallback: true,
        persistAcrossSessions: true,
      });
      await createCaptchaBridgeRegistration(api).sync(true);
      assert.equal(registered.length, 1, 'a persisted registration should be reused after a background restart');
      await registration.sync(true);
      assert.equal(registered.length, 1);
      await registration.sync(false);
      assert.equal(registered.length, 0);
      return;
    }

    let script = null;
    let unregisterCount = 0;
    const api = { contentScripts: {
      register: async options => {
        script = options;
        return { unregister: async () => { script = null; unregisterCount += 1; } };
      },
    } };
    const registration = createCaptchaBridgeRegistration(api);

    await registration.sync(false);
    assert.equal(script, null);
    await registration.sync(true);
    assert.deepEqual(script, {
      matches: ['<all_urls>'],
      js: [{ file: 'src/content/captcha-callback-bridge.js' }],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
      matchAboutBlank: true,
    });
    await registration.sync(true);
    assert.equal(unregisterCount, 0);
    await registration.sync(false);
    assert.equal(script, null);
    assert.equal(unregisterCount, 1);
  });

  test(`${build} reconciles overlapping provider changes in order`, async () => {
    if (build === 'chrome') {
      let registered = [];
      const api = { scripting: {
        getRegisteredContentScripts: async ({ ids }) => registered.filter(script => ids.includes(script.id)),
        registerContentScripts: async scripts => {
          await new Promise(resolve => setImmediate(resolve));
          registered.push(...scripts);
        },
        unregisterContentScripts: async ({ ids }) => { registered = registered.filter(script => !ids.includes(script.id)); },
      } };
      const registration = createCaptchaBridgeRegistration(api);
      await Promise.all([registration.sync(true), registration.sync(false)]);
      assert.equal(registered.length, 0);
      return;
    }

    let script = null;
    const api = { contentScripts: {
      register: async () => {
        await new Promise(resolve => setImmediate(resolve));
        script = true;
        return { unregister: async () => { script = null; } };
      },
    } };
    const registration = createCaptchaBridgeRegistration(api);
    await Promise.all([registration.sync(true), registration.sync(false)]);
    assert.equal(script, null);
  });
}

test('Chrome and Firefox use the same registration state machine', async () => {
  assert.equal(
    await readFile(new URL('../src/chrome/src/agent/captcha-bridge-registration.js', import.meta.url), 'utf8'),
    await readFile(new URL('../src/firefox/src/agent/captcha-bridge-registration.js', import.meta.url), 'utf8'),
  );
});
