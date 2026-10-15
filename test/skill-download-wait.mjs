import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

for (const build of ['chrome', 'firefox']) {
  test(`${build}: long media waits beyond three minutes, reports once, and retains timed-out job`, async () => {
    const { executeHttpSkillTool } = await import(`../src/${build}/src/network/network-tools.js`);
    const { normalizeCustomSkills, buildSkillToolRegistry } = await import(`../src/${build}/src/agent/skills.js`);
    const skills = normalizeCustomSkills([{
      id: 'freeskillz-xyz', name: 'FreeSkillz.xyz', enabled: true,
      content: fs.readFileSync(new URL(`../src/${build}/skills/freeskillz-xyz.md`, import.meta.url), 'utf8'),
    }]);
    const tool = buildSkillToolRegistry(skills).get('download_public_media');
    assert.equal(tool.job.timeoutMs, 1200000);
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const originalTimeout = globalThis.setTimeout;
    try {
      for (const scenario of ['duration', 'size', 'unknown', 'short']) {
        let clock = 0;
        let polls = 0;
        const notices = [];
        const methods = [];
        Date.now = () => clock;
        globalThis.setTimeout = callback => { clock += 1000; callback(); return 0; };
        const metadata = scenario === 'duration' ? { duration: 204, title: '<untrusted>' }
          : scenario === 'size' ? { filesize_approx: 80 * 1024 * 1024 }
          : scenario === 'short' ? { duration: 10 } : {};
        globalThis.fetch = async (_url, opts) => {
          methods.push(opts.method);
          if (opts.method === 'GET') {
            polls++;
            clock += scenario === 'short' ? 1 : 60000;
          }
          const data = opts.method === 'POST' ? { job_id: 'slow', metadata }
            : { status: scenario === 'short' ? 'failed' : 'running', metadata };
          return { ok: true, status: 200, text: async () => JSON.stringify(data) };
        };
        const result = await executeHttpSkillTool(tool, { url: 'https://x.com/user/status/123', kind: 'video' }, {
          onProgress: message => notices.push(message),
        });
        if (scenario === 'short') {
          assert.deepEqual(notices, []);
          assert.ok(methods.includes('DELETE'));
        } else {
          assert.ok(polls > 3, 'must keep polling beyond original three-minute limit');
          assert.equal(notices.length, 1);
          assert.ok(!notices[0].includes('<untrusted>'));
          assert.match(notices[0], scenario === 'duration' ? /4 minutes/ : scenario === 'size' ? /80 MB/ : /still downloading/);
          assert.equal(result.jobId, 'slow');
          assert.equal(result.statusUrl, 'https://freeskillz.xyz/v1/media/jobs/slow');
          assert.equal(result.jobStatus, 'running');
          assert.equal(result.executionContext, 'remote_service');
          assert.equal(result.browserLoginAffectsRequest, false);
          assert.ok(!methods.includes('DELETE'), 'timeout must preserve a running job');
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      globalThis.setTimeout = originalTimeout;
    }
  });
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: long metadata does not notify when the job finishes fast`, async () => {
    const { executeHttpSkillTool } = await import(`../src/${build}/src/network/network-tools.js`);
    const { normalizeCustomSkills, buildSkillToolRegistry } = await import(`../src/${build}/src/agent/skills.js`);
    const skills = normalizeCustomSkills([{
      id: 'freeskillz-xyz', name: 'FreeSkillz.xyz', enabled: true,
      content: fs.readFileSync(new URL(`../src/${build}/skills/freeskillz-xyz.md`, import.meta.url), 'utf8'),
    }]);
    const tool = buildSkillToolRegistry(skills).get('download_public_media');
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    const originalTimeout = globalThis.setTimeout;
    try {
      let clock = 0;
      const notices = [];
      Date.now = () => clock;
      globalThis.setTimeout = callback => { clock += 1000; callback(); return 0; };
      // Long video metadata, but completes on first poll well before 30s elapsed.
      globalThis.fetch = async (_url, opts) => {
        if (opts.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ job_id: 'fast', metadata: { duration: 300 } }) };
        clock += 2000;
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'complete', metadata: { duration: 300 } }) };
      };
      // Stub the final file download to avoid browser APIs in this unit test.
      const originalChrome = globalThis.chrome;
      const originalBrowser = globalThis.browser;
      try {
        if (build === 'chrome') {
          delete globalThis.browser;
          globalThis.chrome = { runtime: { lastError: null }, downloads: { download(_o, cb) { cb(1); }, search(_q, cb) { cb([{ id: 1, state: 'complete', filename: 'f.mp4' }]); } } };
        } else {
          delete globalThis.chrome;
          globalThis.browser = { downloads: { async download() { return 1; }, async search() { return [{ id: 1, state: 'complete' }]; } } };
        }
        // fetchSkillDownloadData path uses data: URLs in this stubbed fetch; force it
        // to return a tiny file so downloadSkillFile can proceed without network.
        globalThis.fetch = async (_url, opts) => {
          if (opts.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ job_id: 'fast', metadata: { duration: 300 } }) };
          if (String(_url).endsWith('/file')) {
            return { ok: true, status: 200, url: _url, headers: { get: () => 'video/mp4' }, text: async () => '', arrayBuffer: async () => new ArrayBuffer(4), body: null };
          }
          clock += 2000;
          return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'complete', metadata: { duration: 300 } }) };
        };
        await executeHttpSkillTool(tool, { url: 'https://x.com/user/status/123', kind: 'video' }, {
          onProgress: message => notices.push(message),
        });
        assert.deepEqual(notices, []);
      } finally {
        if (originalChrome === undefined) delete globalThis.chrome;
        else globalThis.chrome = originalChrome;
        if (originalBrowser === undefined) delete globalThis.browser;
        else globalThis.browser = originalBrowser;
      }
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      globalThis.setTimeout = originalTimeout;
    }
  });
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: skill download wait aborts promptly on Stop`, async () => {
    const { executeHttpSkillTool } = await import(`../src/${build}/src/network/network-tools.js`);
    const { normalizeCustomSkills, buildSkillToolRegistry } = await import(`../src/${build}/src/agent/skills.js`);
    const skills = normalizeCustomSkills([{
      id: 'freeskillz-xyz', name: 'FreeSkillz.xyz', enabled: true,
      content: fs.readFileSync(new URL(`../src/${build}/skills/freeskillz-xyz.md`, import.meta.url), 'utf8'),
    }]);
    const tool = buildSkillToolRegistry(skills).get('download_public_media');
    const originalFetch = globalThis.fetch;
    try {
      const methods = [];
      globalThis.fetch = async (_url, opts = {}) => {
        methods.push(opts.method);
        if (opts.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
        if (opts.method === 'POST') return { ok: true, status: 200, text: async () => JSON.stringify({ job_id: 'slow' }) };
        // Never resolve until aborted: the abortable sleep/fetch must win.
        await new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
        });
        throw new Error('unreachable');
      };
      const controller = new AbortController();
      const pending = executeHttpSkillTool(tool, { url: 'https://x.com/user/status/123', kind: 'video' }, {
        signal: controller.signal,
        onProgress: () => {},
      });
      controller.abort();
      await assert.rejects(pending, err => err?.name === 'AbortError');
      assert.ok(!methods.includes('DELETE'), 'abort must not delete the running provider job');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: skill progress reaches the chat tool-progress channel`, async () => {
    const source = fs.readFileSync(new URL(`../src/${build}/src/agent/agent.js`, import.meta.url), 'utf8');
    const start = source.lastIndexOf('    const skillTool = this._activeSkillToolForName(tabId, name);');
    const end = source.indexOf('    const skillEndpointRedirect', start);
    assert.ok(start > 0 && end > start);
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const handler = new AsyncFunction('tabId', 'name', 'args', 'onUpdate', 'isTrustedChromeWebStoreSkillTool', 'executeHttpSkillTool', source.slice(start, end));
    const updates = [];
    const result = await handler.call({ _activeSkillToolForName: () => ({ skillId: 'freeskillz-xyz' }) },
      1, 'download_public_media', {}, (...update) => updates.push(update), () => false,
      async (_tool, _args, ctx) => { ctx.onProgress('Preparing a large file'); return { success: true }; });
    assert.equal(result.success, true);
    assert.deepEqual(updates, [['tool_progress', { name: 'download_public_media', message: 'Preparing a large file' }]]);
  });
}
