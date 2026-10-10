const SCRIPT_ID = 'webbrain-captcha-callback-bridge';
const SCRIPT_FILE = 'src/content/captcha-callback-bridge.js';
const MATCHES = ['<all_urls>'];

export function createCaptchaBridgeRegistration(api) {
  let firefoxRegistration = null;
  let queue = Promise.resolve();

  async function reconcile(enabled) {
    if (api.contentScripts?.register) {
      if (enabled && !firefoxRegistration) {
        firefoxRegistration = await api.contentScripts.register({
          matches: [...MATCHES],
          js: [{ file: SCRIPT_FILE }],
          runAt: 'document_start',
          world: 'MAIN',
          allFrames: true,
          matchAboutBlank: true,
        });
      } else if (!enabled && firefoxRegistration) {
        const registration = firefoxRegistration;
        await registration.unregister();
        if (firefoxRegistration === registration) firefoxRegistration = null;
      }
      return;
    }

    const scripting = api.scripting;
    if (typeof scripting?.getRegisteredContentScripts !== 'function'
      || typeof scripting.registerContentScripts !== 'function'
      || typeof scripting.unregisterContentScripts !== 'function') {
      throw new Error('Dynamic CAPTCHA bridge registration is not supported by this browser.');
    }

    const [registered] = await scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (enabled && !registered) {
      await scripting.registerContentScripts([{
        id: SCRIPT_ID,
        matches: [...MATCHES],
        js: [SCRIPT_FILE],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        matchOriginAsFallback: true,
        persistAcrossSessions: true,
      }]);
    } else if (!enabled && registered) {
      await scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    }
  }

  return {
    sync(enabled) {
      const operation = queue.then(
        () => reconcile(enabled === true),
        () => reconcile(enabled === true),
      );
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
