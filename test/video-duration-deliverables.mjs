import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

// Real Agent dispatch, duration measurements and session serialization with
// fixture provider responses. No paid video generation is submitted.
const stored = new Map();
const area = {
  get: async key => ({ [key]: stored.get(key) }),
  set: async values => { for (const [key, value] of Object.entries(values)) stored.set(key, structuredClone(value)); },
  remove: async key => { stored.delete(key); },
};
globalThis.chrome = globalThis.browser = {
  storage: { local: area, session: area },
  runtime: { getURL: value => value, sendMessage: async () => ({}) },
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const oneSecond = new Uint8Array(await readFile(new URL('./fixtures/video/h264-aac-1.mp4', import.meta.url)));
const { joinMp4Clips } = await import('../src/chrome/src/agent/video-join.js');
const fiveSeconds = joinMp4Clips(Array(5).fill(oneSecond)).bytes;
const model = 'fixture/multiple-videos';
const config = { provider: 'fal', apiKey: 'fixture-key', videoModel: model };
const gate = { requestKind: 'execute', requiresStateChange: false };
const schema = { openapi: '3.0.4', paths: { '/model': { post: { requestBody: { content: {
  'application/json': { schema: { type: 'object', properties: {
    prompt: { type: 'string' }, duration: { type: 'integer', enum: [1, 5] },
  } } },
} } } } } };
const deliveries = contract => [contract, ...(contract?.otherDeliverables || [])].filter(Boolean);
const delivered = durationSeconds => ({ success: true, mimeType: 'video/mp4',
  url: 'https://v3b.fal.media/files/fixture.mp4', durationSeconds });
let nextTab = 18200;

function fal({ fail = () => false, beforeDownload = async () => {} } = {}) {
  const submits = [];
  return { submits, fetch: async (url, init = {}) => {
    if (url.startsWith('https://api.fal.ai/v1/models?')) {
      return json({ models: [{ endpoint_id: model, openapi: schema }] });
    }
    if (url.startsWith('https://v3b.fal.media/')) {
      const index = Number(/clip-(\d+)\.mp4$/.exec(url)[1]);
      assert.equal(init.headers?.Authorization, undefined);
      await beforeDownload(index);
      return new Response(submits[index].duration === 5 ? fiveSeconds : oneSecond,
        { headers: { 'Content-Type': 'video/mp4' } });
    }
    assert.equal(init.headers?.Authorization, 'Key fixture-key');
    if (init.method === 'POST') {
      assert.equal(url, `https://queue.fal.run/${model}`);
      const body = JSON.parse(init.body);
      const index = submits.push(body) - 1;
      if (fail(index)) return json({ detail: 'The requested clip was rejected.' }, 400);
      const job = `https://queue.fal.run/${model}/requests/req-${index}`;
      return json({ request_id: `req-${index}`, status_url: `${job}/status`, response_url: job });
    }
    const match = /\/requests\/req-(\d+)(\/status)?$/.exec(url);
    assert.ok(match, url);
    return match[2] ? json({ status: 'COMPLETED' })
      : json({ video: { url: `https://v3b.fal.media/files/clip-${match[1]}.mp4` } });
  } };
}

for (const build of ['chrome', 'firefox']) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const { normalizeVideoDurationContract: normalize, pinVideoDurationTarget: pin,
    recordVideoDurationResult: receipt, approveVideoDurationTarget: approve,
    videoDurationCompletionBlock: block } = await import(`../src/${build}/src/agent/video-duration-contract.js`);

  function fixture() {
    const agent = new Agent({ getActive: () => ({ config: {} }) });
    const tab = nextTab++;
    agent._persist = () => {};
    agent.conversations.set(tab, [{ role: 'system', content: 'Fixture system message.' },
      { role: 'user', content: 'Create a five-second intro and a one-second outro as separate videos.' }]);
    agent.conversationIds.set(tab, `video-deliverables-${tab}`);
    agent.conversationModes.set(tab, 'act');
    const guard = agent._startPlanExecutionGuard(tab, 'act', gate);
    const generate = args => agent._executeToolImpl(tab, 'generate_image', args, () => {}, { imageGenConfig: config });
    return { agent, tab, guard, generate };
  }

  for (const named of [false, true]) {
    test(`${build}: separate ${named ? 'named' : 'legacy'} videos keep their own durations and failed receipts`, async () => {
      const { agent, tab, guard, generate } = fixture();
      const api = fal({ fail: index => index === 1 });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = api.fetch;
      try {
        const intro = await generate({ media: 'video', ...(named ? { video_id: 'intro' } : {}),
          estimated_duration: 5, duration: 5, prompt: 'An intro' });
        assert.equal(intro.success, true);
        assert.equal(intro.durationSeconds, 5);
        assert.equal(guard.videoDurationContract.status, 'enough');
        const outro = await generate({ media: 'video', ...(named ? { video_id: 'outro' } : {}),
          estimated_duration: 1, duration: 1, prompt: 'An outro' });
        assert.equal(outro.success, false);
        assert.deepEqual(api.submits.map(body => body.duration), [5, 1], 'the outro reaches the provider with its own length');
        assert.equal(guard.videoDurationContract.requestedSeconds, 1);
        assert.equal(guard.videoDurationContract.status, 'failed', 'the intro receipt cannot mask the failed outro');
        assert.deepEqual(deliveries(guard.videoDurationContract).map(value => [value.requestedSeconds, value.status]), [[1, 'failed'], [5, 'enough']]);
        assert.equal(block(guard.videoDurationContract).requiredSeconds, 1);
        const retried = await generate({ media: 'video', ...(named ? { video_id: 'outro' } : {}), prompt: 'Retry the outro' });
        assert.equal(retried.success, true);
        assert.equal(retried.durationSeconds, 1);
        assert.deepEqual(api.submits.map(body => body.duration), [5, 1, 1]);
        assert.equal(agent._videoDurationDoneBlock(tab), null);
      } finally { globalThis.fetch = originalFetch; }
    });
  }

  test(`${build}: interleaved named retries retain every unfinished duration`, () => {
    let contract = pin({ media: 'video', video_id: 'lesson', estimated_duration: 60 }).contract;
    contract = receipt(contract, { success: false, error: 'Provider unavailable' });
    contract = pin({ media: 'video', video_id: 'intro', estimated_duration: 5 }, contract).contract;
    contract = receipt(contract, delivered(5));
    assert.equal(block(contract).requiredSeconds, 60, 'completing the intro does not complete the lesson');
    const retry = pin({ media: 'video', video_id: 'lesson', estimated_duration: 1 }, contract);
    assert.equal(retry.args.estimated_duration, 60);
    contract = receipt(retry.contract, delivered(5));
    assert.equal(block(contract).durationStatus, 'short');
    const intro = pin({ media: 'video', video_id: 'intro' }, contract);
    assert.equal(intro.args.estimated_duration, 5);
    assert.equal(intro.contract.status, 'enough');
    assert.equal(block(intro.contract).requiredSeconds, 60);
    const lesson = pin({ media: 'video', video_id: 'lesson' }, intro.contract);
    contract = receipt(lesson.contract, delivered(60));
    assert.equal(block(contract), null);
    assert.equal(deliveries(contract).length, 2);
  });

  test(`${build}: an unknown video id without a target cannot erase another deliverable`, () => {
    const pending = pin({ media: 'video', video_id: 'lesson', estimated_duration: 60 }).contract;
    const attempted = pin({ media: 'video', video_id: 'outro', prompt: 'A separate outro' }, pending);
    assert.ok(attempted.error);
    assert.deepEqual(attempted.contract, pending);
    assert.equal(block(attempted.contract).requiredSeconds, 60);
  });

  test(`${build}: an active unverified video cannot hide another video's measured shortfall`, () => {
    let contract = pin({ media: 'video', video_id: 'lesson', estimated_duration: 60 }).contract;
    contract = receipt(contract, delivered(5));
    contract = pin({ media: 'video', video_id: 'outro', estimated_duration: 1 }, contract).contract;
    contract = receipt(contract, { success: true, url: 'https://v3b.fal.media/files/outro.mp4', mimeType: 'video/mp4' });
    assert.equal(contract.status, 'unverified');
    assert.equal(block(contract).durationStatus, 'short');
    assert.equal(block(contract).requiredSeconds, 60);
    contract = receipt(contract, { success: false }, deliveries(contract).find(value => value.videoId === 'lesson').deliverableId);
    assert.equal(block(contract).durationStatus, 'failed');
  });

  test(`${build}: a new named target is separate while an unlabeled retry can acquire its name`, () => {
    const intro = pin({ media: 'video', estimated_duration: 5 }).contract;
    const outro = pin({ media: 'video', video_id: 'outro', estimated_duration: 1 }, intro);
    assert.equal(outro.args.estimated_duration, 1);
    assert.equal(outro.contract.requestedSeconds, 1);
    assert.equal(deliveries(outro.contract).length, 2);
    assert.equal(deliveries(outro.contract).find(value => value.deliverableId === intro.deliverableId).requestedSeconds, 5);
    for (const duration of [undefined, 5]) {
      const retry = pin({ media: 'video', video_id: 'intro', ...(duration === undefined ? {} : { estimated_duration: duration }) }, intro);
      assert.equal(retry.args.estimated_duration, 5);
      assert.equal(retry.contract.deliverableId, intro.deliverableId);
      assert.equal(retry.contract.videoId, 'intro');
      assert.equal(deliveries(retry.contract).length, 1);
    }
  });

  test(`${build}: receipts and explicit shorter approvals apply to their captured deliverable`, () => {
    const lesson = pin({ media: 'video', video_id: 'lesson', estimated_duration: 330 }).contract;
    const lessonId = lesson.deliverableId;
    let contract = pin({ media: 'video', video_id: 'intro', estimated_duration: 5 }, lesson).contract;
    const introId = contract.deliverableId;
    contract = approve(contract, 120, lessonId);
    contract = receipt(contract, delivered(5), introId);
    assert.equal(block(contract).requiredSeconds, 120);
    contract = receipt(contract, delivered(120), lessonId);
    assert.equal(block(contract), null);
    const savedLesson = deliveries(contract).find(value => value.deliverableId === lessonId);
    const savedIntro = deliveries(contract).find(value => value.deliverableId === introId);
    assert.deepEqual([savedLesson.requestedSeconds, savedLesson.approvedDurationSeconds, savedLesson.durationSeconds], [330, 120, 120]);
    assert.deepEqual([savedIntro.requestedSeconds, savedIntro.approvedDurationSeconds, savedIntro.durationSeconds], [5, undefined, 5]);
  });

  test(`${build}: concurrent same-task generations attach measured receipts to their own video`, async () => {
    const { agent, tab, guard, generate } = fixture();
    let releaseIntro, introReady;
    const waitForIntro = new Promise(resolve => { releaseIntro = resolve; });
    const downloadStarted = new Promise(resolve => { introReady = resolve; });
    const api = fal({ beforeDownload: async index => {
      if (index === 0) { introReady(); await waitForIntro; }
    } });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = api.fetch;
    let intro;
    try {
      intro = generate({ media: 'video', video_id: 'intro', estimated_duration: 5, duration: 5, prompt: 'Intro' });
      await downloadStarted;
      const outro = await generate({ media: 'video', video_id: 'outro', estimated_duration: 1, duration: 1, prompt: 'Outro' });
      assert.equal(outro.success, true);
      assert.equal(block(guard.videoDurationContract).requiredSeconds, 5);
      releaseIntro();
      assert.equal((await intro).success, true);
      assert.equal(agent._videoDurationDoneBlock(tab), null);
      assert.deepEqual(deliveries(guard.videoDurationContract).map(value => [value.requestedSeconds, value.durationSeconds]).sort((a, b) => a[0] - b[0]), [[1, 1], [5, 5]]);
    } finally {
      releaseIntro();
      if (intro) await intro;
      globalThis.fetch = originalFetch;
    }
  });

  test(`${build}: all deliverable obligations survive cold storage and trusted Continue`, async () => {
    for (const tornDown of [false, true]) {
      const { agent, tab, guard } = fixture();
      let contract = pin({ media: 'video', video_id: 'intro', estimated_duration: 5 }).contract;
      contract = receipt(contract, delivered(5));
      contract = pin({ media: 'video', video_id: 'lesson', estimated_duration: 60 }, contract).contract;
      contract = receipt(contract, { success: false });
      contract = pin({ media: 'video', video_id: 'outro', estimated_duration: 1 }, contract).contract;
      guard.videoDurationContract = contract;
      if (tornDown) {
        agent._storeContinuationExecutionEvidence(tab);
        agent._planExecutionGuards.delete(tab);
      }
      assert.equal((await agent._persistNow(tab)).ok, true);
      const entry = stored.get(agent._convKey(tab));
      assert.ok(entry.videoDurationObligation);
      assert.deepEqual(entry.videoDurationObligation.contract, normalize(contract));
      const cold = new Agent({ getActive: () => ({ config: {} }) });
      cold._persist = () => {};
      await cold._hydrateFromSession(tab);
      const resumed = cold._startPlanExecutionGuard(tab, 'act', gate, { trustedContinuation: true });
      assert.deepEqual(resumed.videoDurationContract, normalize(contract));
      assert.equal(deliveries(resumed.videoDurationContract).length, 3);
      const lesson = pin({ media: 'video', video_id: 'lesson' }, resumed.videoDurationContract);
      assert.equal(lesson.args.estimated_duration, 60);
      const lessonDone = receipt(lesson.contract, delivered(60));
      assert.equal(block(lessonDone).requiredSeconds, 1);
      const outro = pin({ media: 'video', video_id: 'outro' }, lessonDone);
      assert.equal(block(receipt(outro.contract, delivered(1))), null);
    }
  });
}
