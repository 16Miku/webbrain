import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area },
  runtime: { getURL: x => x, sendMessage: async () => ({}) } };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const video = await fs.readFile(new URL('./fixtures/video/h264-aac-1.mp4', import.meta.url));
const config = { provider: 'comfyui', baseUrl: 'http://localhost:8188/comfy', videoWorkflow: {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
  '9': { class_type: 'SaveVideo', inputs: { images: ['6', 0], seconds: 1 } },
} };
let nextTab = 9300;

function localWorkflow({ failRead = false } = {}) {
  const calls = { submits: [], reads: [] };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'http://localhost:8188');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers?.Authorization, undefined);
    if (url.pathname === '/comfy/prompt') {
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      calls.submits.push(body);
      assert.deepEqual(Object.keys(body).sort(), ['client_id', 'prompt']);
      assert.deepEqual(body.prompt['9'], config.videoWorkflow['9'], 'verification never rewrites the local workflow');
      return json({ prompt_id: 'local-video' });
    }
    if (url.pathname === '/comfy/history/local-video') return json({ 'local-video': {
      status: { completed: true }, outputs: { '9': { videos: [{ filename: 'clip.mp4', type: 'output' }] } },
    } });
    assert.equal(url.pathname, '/comfy/view');
    assert.equal(url.searchParams.get('filename'), 'clip.mp4');
    calls.reads.push(input);
    if (failRead) throw new DOMException('Verification timed out.', 'TimeoutError');
    return new Response(video, { headers: { 'Content-Type': 'video/mp4' } });
  };
  return { calls, fetchImpl };
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { generateImage } = await import(`../src/${build}/src/agent/generative-media.js`);

  test(`${build}: local duration obligation verifies output without becoming a workflow argument`, async () => {
    const api = localWorkflow();
    const result = await generateImage({ media: 'video', prompt: 'Make a short clip.' }, {
      config, fetchImpl: api.fetchImpl, pollIntervalMs: 1, verifyVideoDuration: true, videoDurationTarget: 60,
    });
    assert.equal(result.success, true);
    assert.equal(result.durationStatus, 'short');
    assert.equal(result.estimatedSeconds, 60);
    assert.equal(result.durationSeconds, 1);
    assert.equal(result.plannedSeconds, undefined, 'a local workflow has no runtime duration plan');
    assert.match(result.url, /^http:\/\/localhost:8188\/comfy\/view\?/);
    assert.equal(api.calls.submits.length, 1);
    assert.equal(api.calls.reads.length, 1);
  });

  test(`${build}: local measured output can satisfy a separately stored target`, async () => {
    const api = localWorkflow();
    const result = await generateImage({ media: 'video', prompt: 'Make a one second clip.' }, {
      config, fetchImpl: api.fetchImpl, pollIntervalMs: 1, verifyVideoDuration: true, videoDurationTarget: 1,
    });
    assert.equal(result.success, true);
    assert.equal(result.durationStatus, 'enough');
    assert.equal(result.durationSeconds, 1);
  });

  test(`${build}: local verification failure preserves the output and unmet verification target`, async () => {
    const api = localWorkflow({ failRead: true });
    const result = await generateImage({ media: 'video', prompt: 'Make a video.' }, {
      config, fetchImpl: api.fetchImpl, pollIntervalMs: 1, verifyVideoDuration: true, videoDurationTarget: 60,
    });
    assert.equal(result.success, true);
    assert.match(result.url, /\/view\?/);
    assert.equal(result.estimatedSeconds, 60);
    assert.equal(result.durationStatus, 'unverified');
    assert.equal(result.plannedSeconds, undefined);
    assert.match(result.notice, /asset was kept/);
    assert.equal(api.calls.submits.length, 1);
  });

  test(`${build}: explicit unsupported local options remain rejected before submission`, async () => {
    const result = await generateImage({ media: 'video', prompt: 'Make a video.', estimated_duration: 60 }, {
      config, fetchImpl: async () => assert.fail('unsupported workflow arguments must not submit'),
      verifyVideoDuration: true, videoDurationTarget: 60,
    });
    assert.equal(result.success, false);
    assert.match(result.error, /do not work with a local ComfyUI workflow/);
  });

  for (const savedConfig of [false, true]) test(`${build}: a corrected local retry reaches ComfyUI with ${savedConfig ? 'saved' : 'dispatch'} settings`, async () => {
    const agent = new Agent({}), tab = nextTab++;
    agent.conversations.set(tab, [{ role: 'user', content: 'Make a one minute video.' }]);
    agent.conversationIds.set(tab, `comfy-duration-${tab}`);
    agent.conversationModes.set(tab, 'act');
    agent._persist = () => {};
    agent._persistNow = async () => ({ ok: true });
    agent._startPlanExecutionGuard(tab, 'act', { requestKind: 'execute', requiresStateChange: false });
    const api = localWorkflow(), originalFetch = globalThis.fetch, originalGet = area.get;
    globalThis.fetch = api.fetchImpl;
    if (savedConfig) area.get = async () => ({ imageGenModel: config });
    try {
      const context = savedConfig ? {} : { imageGenConfig: config };
      const refused = await agent._executeToolImpl(tab, 'generate_image', {
        media: 'video', prompt: 'Make a one minute video.', estimated_duration: 60,
      }, () => {}, context);
      assert.equal(refused.success, false);
      assert.match(refused.error, /do not work with a local ComfyUI workflow/);
      assert.equal(api.calls.submits.length, 0);
      const retried = await agent._executeToolImpl(tab, 'generate_image', {
        ...(savedConfig ? {} : { media: 'video' }), prompt: 'Run the configured workflow.',
      }, () => {}, context);
      assert.equal(retried.success, true, retried.error);
      assert.equal(retried.estimatedSeconds, 60);
      assert.equal(retried.durationStatus, 'short');
      assert.equal(retried.durationSeconds, 1);
      assert.equal(api.calls.submits.length, 1);
      assert.equal(api.calls.reads.length, 1);
    } finally { globalThis.fetch = originalFetch; area.get = originalGet; }
  });
}
