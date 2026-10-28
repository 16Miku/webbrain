import assert from 'node:assert/strict';
import { test } from 'node:test';

// The permission card's skip dialog can turn the gate off until the browser
// closes (storage.session) or for good (storage.local). The agent must honour
// either, follow both while a run is going, and keep working where
// storage.session is missing.
const stores = { local: {}, session: {} };
const listeners = [];
const area = (name) => ({
  async get(key) { return key in stores[name] ? { [key]: stores[name][key] } : {}; },
  async set(values) { Object.assign(stores[name], values); },
  async remove(key) { delete stores[name][key]; },
});
globalThis.chrome = globalThis.browser = {
  storage: {
    local: area('local'),
    session: area('session'),
    onChanged: { addListener(fn) { listeners.push(fn); } },
  },
  runtime: { getURL: (value) => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
  tabs: { get: async (id) => ({ id, url: 'https://example.com/', title: 'Example' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};

for (const build of ['chrome', 'firefox']) {
  const base = new URL(`../src/${build}/src/`, import.meta.url);
  const { Agent } = await import(new URL('agent/agent.js', base));
  const { PERMISSION_GATE_SESSION_OFF_KEY } = await import(new URL('agent/permission-gate.js', base));

  const fresh = () => {
    stores.local = {};
    stores.session = {};
    listeners.length = 0;
    const agent = new Agent({});
    const fire = (changes, areaName) => { for (const fn of listeners) fn(changes, areaName); };
    return { agent, fire };
  };

  test(`${build}: either the stored setting or this browser session's skip turns the gate off`, async () => {
    const { agent } = fresh();
    assert.equal(PERMISSION_GATE_SESSION_OFF_KEY, 'skipPermissionPromptsThisSession');
    assert.equal(await agent._ensureGateSetting({ force: true }), false, 'prompts are on by default');

    stores.session[PERMISSION_GATE_SESSION_OFF_KEY] = true;
    assert.equal(await agent._ensureGateSetting({ force: true }), true, '"This session only" skips the gate');

    delete stores.session[PERMISSION_GATE_SESSION_OFF_KEY];
    stores.local.askBeforeConsequentialActions = false;
    assert.equal(await agent._ensureGateSetting({ force: true }), true, '"Forever" skips the gate');

    stores.local.askBeforeConsequentialActions = true;
    assert.equal(await agent._ensureGateSetting({ force: true }), false);
  });

  test(`${build}: a run follows either switch as it changes`, async () => {
    const { agent, fire } = fresh();
    await agent._ensureGateSetting({ force: true });
    fire({ [PERMISSION_GATE_SESSION_OFF_KEY]: { newValue: true } }, 'session');
    assert.equal(agent._skipPermissionGate, true);
    // Turning prompts back on writes the stored setting and removes the session flag.
    fire({ askBeforeConsequentialActions: { newValue: true } }, 'local');
    assert.equal(agent._skipPermissionGate, true, 'the session skip still holds until it is removed');
    fire({ [PERMISSION_GATE_SESSION_OFF_KEY]: { oldValue: true } }, 'session');
    assert.equal(agent._skipPermissionGate, false);
    fire({ askBeforeConsequentialActions: { newValue: false } }, 'local');
    assert.equal(agent._skipPermissionGate, true);
    // A key of the same name in another area means nothing.
    fire({ askBeforeConsequentialActions: { newValue: true } }, 'session');
    assert.equal(agent._skipPermissionGate, true);
  });

  test(`${build}: without storage.session only the stored setting counts`, async () => {
    const { agent } = fresh();
    const session = globalThis.chrome.storage.session;
    delete globalThis.chrome.storage.session;
    try {
      assert.equal(await agent._ensureGateSetting({ force: true }), false);
      stores.local.askBeforeConsequentialActions = false;
      assert.equal(await agent._ensureGateSetting({ force: true }), true);
    } finally {
      globalThis.chrome.storage.session = session;
    }
  });
}
