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
