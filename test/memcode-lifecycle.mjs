import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const emptyStorage = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = { storage: { local: emptyStorage, session: emptyStorage }, runtime: { getURL: value => `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/${value}` } };
globalThis.browser = globalThis.chrome;

for (const browser of ['chrome', 'firefox']) {
  const { createMemcodeRecall, MEMCODE_CONNECTION_KEY: key, MEMCODE_RECALL_ENABLED_KEY: enabledKey }
    = await import(`../src/${browser}/src/agent/memcode-recall.js`);
  const { Agent } = await import(`../src/${browser}/src/agent/agent.js`);
  function fixture({ holdRefresh = false, holdAccount = false, holdSearch = false, holdWrite = false, holdDigest = false } = {}) {
    const values = new Map([[key, { clientId: 'old-client', accountId: 'old-account',
      redirectUri: 'https://owned.chromiumapp.org/memcode', accessToken: 'owned-old-access',
      refreshToken: 'owned-old-refresh', expiresAt: 0 }], [enabledKey, true]]);
    const refresh = deferred(), account = deferred(), search = deferred();
    const refreshStarted = deferred(), accountStarted = deferred(), searchStarted = deferred();
    const write = deferred(), writeStarted = deferred();
    const digest = deferred(), digestStarted = deferred();
    const requests = [];
    const storage = {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, values.get(k)])); },
      async set(data) {
        if (holdWrite && data[key]) { writeStarted.resolve(); await write.promise; }
        for (const [k, value] of Object.entries(data)) values.set(k, value);
      },
      async remove(k) { values.delete(k); },
    };
    const token = { access_token: 'owned-new-access', refresh_token: 'owned-new-refresh',
      token_type: 'Bearer', expires_in: 3600, resource: 'https://memory.memcode.in', scope: 'memory:read' };
    let searches = 0;
    const fetcher = async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/register')) return Response.json({ client_id: 'new-client' });
      if (url.endsWith('/token')) {
        if (new URLSearchParams(options.body).get('grant_type') === 'refresh_token') {
          refreshStarted.resolve(); if (holdRefresh) return refresh.promise;
        }
        return Response.json(token);
      }
      if (url.endsWith('/userinfo')) {
        accountStarted.resolve(); if (holdAccount) return account.promise;
        return Response.json({ sub: 'new-account', resource: token.resource, scope: token.scope });
      }
      if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
      if (url.endsWith('/v2/memory/search')) {
        searchStarted.resolve(); if (holdSearch && ++searches === 1) return search.promise;
        return Response.json({ data: { results: [{ domain: 'profile', content: 'Owned memory.' }] } });
      }
      throw new Error('Unexpected owned fixture request.');
    };
    let authLaunches = 0;
    const identity = { getRedirectURL: () => 'https://owned.chromiumapp.org/memcode',
      async launchWebAuthFlow({ url }) {
        authLaunches++;
        const state = new URL(url).searchParams.get('state');
        return `https://owned.chromiumapp.org/memcode?code=owned-code&state=${state}&iss=https%3A%2F%2Fmemory.memcode.in%2F`;
      } };
    const cryptoApi = { getRandomValues: values => webcrypto.getRandomValues(values), subtle: {
      async digest(...args) { digestStarted.resolve(); if (holdDigest) return digest.promise; return webcrypto.subtle.digest(...args); },
    } };
    return { client: createMemcodeRecall({ storage, identity, fetcher, cryptoApi, now: () => 1000 }),
      values, storage, identity, fetcher, requests, refresh, account, search, refreshStarted, accountStarted, searchStarted,
      write, writeStarted, token, digest, digestStarted, authLaunches: () => authLaunches };
  }

  test(`${browser}: obsolete refresh failure cannot disconnect a newly connected account`, async () => {
    const f = fixture({ holdRefresh: true });
    const recall = f.client.recall('owned preferences'); await f.refreshStarted.promise;
    await f.client.connect();
    f.refresh.resolve(new Response(null, { status: 400 }));
    assert.equal((await recall).success, false);
    assert.deepEqual(await f.client.status(), { connected: true, accountId: 'new-account', recallEnabled: false });
    assert.equal(f.values.get(key)?.refreshToken, 'owned-new-refresh');
  });

  test(`${browser}: disconnect supersedes an unfinished connection`, async () => {
    const f = fixture({ holdAccount: true });
    const connecting = f.client.connect();
    const observed = connecting.then(value => ({ value }), error => ({ error }));
    await f.accountStarted.promise; await f.client.disconnect();
    f.account.resolve(Response.json({ sub: 'new-account', resource: f.token.resource, scope: f.token.scope }));
    assert.ok((await observed).error, 'A stale connect must reject rather than restore the disconnected account.');
    assert.deepEqual(await f.client.status(), { connected: false, accountId: null, recallEnabled: false });
  });

  test(`${browser}: disconnect during refresh sends no subsequent memory search`, async () => {
    const f = fixture({ holdRefresh: true });
    const recall = f.client.recall('owned preferences'); await f.refreshStarted.promise;
    await f.client.disconnect(); f.refresh.resolve(Response.json(f.token));
    assert.equal((await recall).success, false);
    assert.equal(f.requests.filter(request => request.url.endsWith('/v2/memory/search')).length, 0);
    assert.equal((await f.client.status()).connected, false);
  });

  test(`${browser}: disconnect finishes after an already-started credential write and leaves no connection`, async () => {
    const f = fixture({ holdWrite: true });
    const connecting = f.client.connect().then(value => ({ value }), error => ({ error }));
    await f.writeStarted.promise;
    const disconnecting = f.client.disconnect();
    await new Promise(resolve => setImmediate(resolve));
    f.write.resolve();
    assert.ok((await connecting).error); await disconnecting;
    assert.deepEqual(await f.client.status(), { connected: false, accountId: null, recallEnabled: false });
  });

  test(`${browser}: current permanent refresh errors disconnect, temporary errors preserve the credential`, async () => {
    for (const status of [400, 401, 503]) {
      const f = fixture({ holdRefresh: true });
      const recall = f.client.recall('owned preferences'); await f.refreshStarted.promise;
      f.refresh.resolve(new Response(null, { status }));
      assert.equal((await recall).success, false);
      assert.equal((await f.client.status()).connected, status === 503);
      assert.equal(f.requests.filter(request => request.url.endsWith('/v2/memory/search')).length, 0);
    }
  });

  test(`${browser}: late search cannot return memories after disconnect or disabling recall`, async () => {
    for (const disconnect of [false, true]) {
      const f = fixture({ holdSearch: true });
      const recall = f.client.recall('owned preferences'); await f.searchStarted.promise;
      if (disconnect) await f.client.disconnect(); else f.values.set(enabledKey, false);
      f.search.resolve(Response.json({ data: { results: [{ content: 'Old account private memory.' }] } }));
      const result = await recall;
      assert.equal(result.success, false); assert.equal(result.results, undefined);
    }
  });

  test(`${browser}: concurrent recalls share one refresh and retain exact account ownership`, async () => {
    const f = fixture({ holdRefresh: true });
    const first = f.client.recall('first owned query'), second = f.client.recall('second owned query');
    await f.refreshStarted.promise; await new Promise(resolve => setImmediate(resolve));
    f.refresh.resolve(Response.json(f.token));
    assert.equal((await first).success, true); assert.equal((await second).success, true);
    assert.equal(f.requests.filter(request => request.url.endsWith('/token')).length, 1);
    assert.equal(f.values.get(key)?.accountId, 'old-account');
  });

  test(`${browser}: the actual Agent recall route uses the Settings controller and serialized credential ownership`, async () => {
    const f = fixture({ holdWrite: true });
    const agent = new Agent({});
    const background = await fs.readFile(new URL(`../src/${browser}/src/background.js`, import.meta.url), 'utf8');
    const assignment = background.match(/^agent\.memcodeRecall = memcodeRecall;$/m)?.[0];
    assert.ok(assignment, 'The real background and Agent must share one MemCode owner, not two independent queues.');
    Function('agent', 'memcodeRecall', assignment)(agent, f.client);
    assert.equal(agent.memcodeRecall, f.client);
    const recall = agent.executeTool(1, 'recall_memcode', { query: 'owned preferences' });
    await f.writeStarted.promise;
    const connecting = f.client.connect();
    await new Promise(resolve => setImmediate(resolve));
    f.write.resolve();
    assert.equal((await recall).success, false);
    await connecting;
    assert.equal((await f.client.status()).accountId, 'new-account');
    assert.equal((await f.client.status()).recallEnabled, false);
  });

  test(`${browser}: disconnect during PKCE digest cannot launch a stale interactive OAuth window`, async () => {
    const f = fixture({ holdDigest: true });
    const connecting = f.client.connect().then(value => ({ value }), error => ({ error }));
    await f.digestStarted.promise; await f.client.disconnect();
    f.digest.resolve(new Uint8Array(32).buffer);
    assert.ok((await connecting).error);
    assert.equal(f.authLaunches(), 0);
    assert.equal((await f.client.status()).connected, false);
  });

  test(`${browser}: default-off replacement connection rejects a toggle prepared for an old account`, async () => {
    const f = fixture();
    const get = f.storage.get.bind(f.storage), pending = deferred(), started = deferred(); let hold = true;
    f.storage.get = async keys => {
      const result = await get(keys);
      if (hold && keys === key) { hold = false; started.resolve(); await pending.promise; }
      return result;
    };
    const enabling = f.client.setRecallEnabled(true).then(value => ({ value }), error => ({ error }));
    await started.promise; await f.client.connect(); pending.resolve();
    assert.ok((await enabling).error);
    assert.deepEqual(await f.client.status(), { connected: true, accountId: 'new-account', recallEnabled: false });
  });

  test(`${browser}: disable then re-enable cancels an old search without invalidating current account recall`, async () => {
    const f = fixture({ holdSearch: true });
    const old = f.client.recall('old owned request'); await f.searchStarted.promise;
    await f.client.setRecallEnabled(false); await f.client.setRecallEnabled(true);
    f.search.resolve(Response.json({ data: { results: [{ content: 'Old private memory must not return.' }] } }));
    const previous = await old;
    assert.equal(previous.success, false); assert.equal(previous.results, undefined);
    const current = await f.client.recall('current explicitly authorized query');
    assert.equal(current.success, true); assert.equal(f.requests.filter(request => request.url.endsWith('/token')).length, 1);
  });

  test(`${browser}: ordinary enable-disable requires a connected account and stays in its controller`, async () => {
    const f = fixture();
    await f.client.setRecallEnabled(false); assert.equal((await f.client.status()).recallEnabled, false);
    await f.client.setRecallEnabled(true); assert.equal((await f.client.status()).recallEnabled, true);
    await f.client.disconnect(); await assert.rejects(f.client.setRecallEnabled(true), /Connect MemCode/);
    assert.equal((await f.client.setRecallEnabled(false)).recallEnabled, false);
    const background = await fs.readFile(new URL(`../src/${browser}/src/background.js`, import.meta.url), 'utf8');
    const route = background.slice(background.indexOf("case 'memcode_recall_enable'"), background.indexOf("case 'add_user_memory'"));
    assert.match(route, /memcodeRecall\.setRecallEnabled/); assert.doesNotMatch(route, /storage\.local\.set/);
  });

  test(`${browser}: a superseded disconnect cannot revoke a replacement returned by a delayed storage read`, async () => {
    const f = fixture();
    const get = f.storage.get.bind(f.storage), pending = deferred(), started = deferred(); let hold = true;
    f.storage.get = async keys => {
      if (hold && keys === key) { hold = false; started.resolve(); await pending.promise; }
      return get(keys);
    };
    const disconnecting = f.client.disconnect();
    await started.promise; await f.client.connect(); pending.resolve();
    const result = await disconnecting;
    assert.equal(result.connected, true); assert.equal(result.revocationFailed, false);
    assert.equal((await f.client.status()).accountId, 'new-account');
    assert.equal(f.requests.filter(request => request.url.endsWith('/revoke')).length, 0,
      'An obsolete disconnect must not revoke the replacement account credential.');
  });

  test(`${browser}: a new recall during disconnect performs no token or memory request`, async () => {
    const f = fixture();
    f.values.get(key).expiresAt = 3_600_000;
    const get = f.storage.get.bind(f.storage), pending = deferred(), started = deferred(); let hold = true;
    f.storage.get = async keys => {
      if (hold && keys === key) { hold = false; started.resolve(); await pending.promise; }
      return get(keys);
    };
    const disconnecting = f.client.disconnect(); await started.promise;
    const recall = await f.client.recall('new request after Disconnect');
    assert.equal(recall.success, false); assert.equal(recall.results, undefined);
    assert.equal(f.requests.filter(request => /\/(?:token|search)$/.test(request.url)).length, 0);
    pending.resolve(); await disconnecting;
    assert.equal((await f.client.status()).connected, false);
    await f.client.connect(); await f.client.setRecallEnabled(true);
    assert.equal((await f.client.recall('new explicitly enabled connection')).success, true);
  });

  test(`${browser}: replacing a connection blocks new old-account recall and releases the new default-off account`, async () => {
    const f = fixture({ holdAccount: true });
    f.values.get(key).expiresAt = 3_600_000;
    const connecting = f.client.connect(); await f.accountStarted.promise;
    const recall = await f.client.recall('query during replacement OAuth');
    assert.equal(recall.success, false); assert.equal(recall.results, undefined);
    assert.equal(f.requests.filter(request => request.url.endsWith('/v2/memory/search')).length, 0);
    f.account.resolve(Response.json({ sub: 'new-account', resource: f.token.resource, scope: f.token.scope }));
    await connecting;
    assert.equal((await f.client.status()).recallEnabled, false);
    await f.client.setRecallEnabled(true);
    assert.equal((await f.client.recall('query for newly enabled account')).success, true);
  });

  test(`${browser}: failed replacement releases its transition without changing the original connected account`, async () => {
    const f = fixture({ holdAccount: true });
    f.values.get(key).expiresAt = 3_600_000;
    const connecting = f.client.connect().then(value => ({ value }), error => ({ error }));
    await f.accountStarted.promise;
    assert.equal((await f.client.recall('query during pending replacement')).success, false);
    f.account.resolve(new Response(null, { status: 503 }));
    assert.ok((await connecting).error);
    assert.deepEqual(await f.client.status(), { connected: true, accountId: 'old-account', recallEnabled: true });
    assert.equal((await f.client.recall('query after unsuccessful replacement')).success, true);
  });

  test(`${browser}: completion of an obsolete disconnect cannot release a newer connection transition`, async () => {
    const f = fixture({ holdAccount: true });
    f.values.get(key).expiresAt = 3_600_000;
    const get = f.storage.get.bind(f.storage), pending = deferred(), started = deferred(); let hold = true;
    f.storage.get = async keys => {
      if (hold && keys === key) { hold = false; started.resolve(); await pending.promise; }
      return get(keys);
    };
    const disconnecting = f.client.disconnect(); await started.promise;
    const connecting = f.client.connect(); await f.accountStarted.promise;
    pending.resolve(); await disconnecting;
    assert.equal((await f.client.recall('new query while replacement still pending')).success, false);
    assert.equal(f.requests.filter(request => request.url.endsWith('/v2/memory/search')).length, 0);
    assert.equal(f.requests.filter(request => request.url.endsWith('/revoke')).length, 0);
    f.account.resolve(Response.json({ sub: 'new-account', resource: f.token.resource, scope: f.token.scope }));
    await connecting; await f.client.setRecallEnabled(true);
    assert.equal((await f.client.recall('new query after current owner completes')).success, true);
  });

  test(`${browser}: failed remote revocation still disconnects locally and releases lifecycle ownership`, async () => {
    for (const networkFailure of [false, true]) {
      const f = fixture();
      const fetcher = async (url, options) => {
        if (url.endsWith('/revoke')) {
          if (networkFailure) throw new Error('Owned synthetic revocation failure.');
          return new Response(null, { status: 503 });
        }
        return f.fetcher(url, options);
      };
      const client = createMemcodeRecall({ storage: f.storage, identity: f.identity, fetcher, cryptoApi: webcrypto, now: () => 1000 });
      assert.deepEqual(await client.disconnect(), { connected: false, recallEnabled: false, revocationFailed: true });
      assert.equal(f.values.has(key), false); assert.equal(f.values.get(enabledKey), false);
      await client.connect(); await client.setRecallEnabled(true);
      assert.equal((await client.recall('query after explicit reconnection')).success, true);
    }
  });

  test(`${browser}: a new recall after Disable waits for the current opt-in change instead of using old enabled storage`, async () => {
    const f = fixture();
    f.values.get(key).expiresAt = 3_600_000;
    const get = f.storage.get.bind(f.storage), pending = deferred(), started = deferred(); let hold = true;
    f.storage.get = async keys => {
      if (hold && keys === key) { hold = false; started.resolve(); await pending.promise; }
      return get(keys);
    };
    const disabling = f.client.setRecallEnabled(false); await started.promise;
    const result = await f.client.recall('new query after Disable');
    assert.equal(result.success, false); assert.equal(result.results, undefined);
    assert.equal(f.requests.filter(request => /\/(?:token|search)$/.test(request.url)).length, 0);
    pending.resolve(); await disabling;
    await f.client.setRecallEnabled(true);
    assert.equal((await f.client.recall('new query after completed explicit Enable')).success, true);
  });

  test(`${browser}: an obsolete toggle finally cannot release the latest pending opt-in change`, async () => {
    const f = fixture();
    f.values.get(key).expiresAt = 3_600_000;
    const get = f.storage.get.bind(f.storage), pending = [deferred(), deferred()], started = [deferred(), deferred()]; let held = 0;
    f.storage.get = async keys => {
      if (keys === key && held < 2) { const index = held++; started[index].resolve(); await pending[index].promise; }
      return get(keys);
    };
    const old = f.client.setRecallEnabled(true).then(value => ({ value }), error => ({ error })); await started[0].promise;
    const latest = f.client.setRecallEnabled(false); await started[1].promise;
    pending[0].resolve(); assert.ok((await old).error);
    assert.equal((await f.client.recall('query after stale toggle completed')).success, false);
    assert.equal(f.requests.filter(request => request.url.endsWith('/v2/memory/search')).length, 0);
    pending[1].resolve(); await latest;
    await f.client.setRecallEnabled(true);
    assert.equal((await f.client.recall('query after current toggle completed')).success, true);
  });

  test(`${browser}: failed opt-in storage mutation releases the transition and reports its unchanged persisted setting`, async () => {
    const f = fixture();
    f.values.get(key).expiresAt = 3_600_000;
    const set = f.storage.set.bind(f.storage); let fail = true;
    f.storage.set = async values => {
      if (fail && enabledKey in values) { fail = false; throw new Error('Owned synthetic storage failure.'); }
      return set(values);
    };
    await assert.rejects(f.client.setRecallEnabled(false), /synthetic storage failure/);
    assert.equal((await f.client.status()).recallEnabled, true);
    assert.equal((await f.client.recall('query after setting failure was reported')).success, true);
    await f.client.setRecallEnabled(false);
    assert.equal((await f.client.recall('query after Disable succeeded')).success, false);
  });
}
