// Vision mode inside the real Agent run loop, both builds. The provider is a
// scripted vision-capable model; the screen is a small fake scene rendered
// into RGBA buffers, so captures, diffs, patches, coordinate translation,
// pruning and the platform calls run for real without a browser. Browser
// behaviour is covered by test/vision-pipeline-browser.mjs and
// test/quality/vision-mode-mv3.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutFixedChoiceAnswers } from './semantic-decision-stub.mjs';

const PAGE = 'https://owned.example.test/form';
const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area, onChanged: { addListener() {} } },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}), getManifest: () => ({ version: '0.0.0' }) },
  tabs: {
    get: async id => ({ id, url: PAGE, title: 'Form', status: 'complete' }),
    query: async () => [],
    sendMessage: async () => ({ ready: true }),
    executeScript: async () => [null],
  },
  webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, documentId: 'document-1', url: PAGE }] },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome ??= api;
globalThis.browser ??= api;

const VISION = { name: 'anthropic', model: 'claude-sonnet-5', config: { category: 'cloud', type: 'anthropic', model: 'claude-sonnet-5' } };
let nextTab = 8800;
let nextCall = 1;
const call = (name, args) => ({ id: `v_${nextCall++}`, function: { name, arguments: JSON.stringify(args) } });
const names = tools => tools.map(tool => tool.function.name);

/** A fake screen: CSS-space rectangles rendered into any requested size. */
function createScene({ cssWidth = 1440, cssHeight = 900, devicePixelRatio = 2 } = {}) {
  return {
    cssWidth, cssHeight, devicePixelRatio, url: PAGE, scrollX: 0, scrollY: 0,
    rects: [{ x: 100, y: 100, w: 300, h: 60, color: [30, 90, 200] }],
    captures: 0,
    render(width, height) {
      const data = new Uint8ClampedArray(width * height * 4).fill(255);
      const sx = width / this.cssWidth;
      const sy = height / this.cssHeight;
      for (const rect of this.rects) {
        const x0 = Math.floor(rect.x * sx); const y0 = Math.floor(rect.y * sy);
        const x1 = Math.min(width, Math.ceil((rect.x + rect.w) * sx)); const y1 = Math.min(height, Math.ceil((rect.y + rect.h) * sy));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          data[i] = rect.color[0]; data[i + 1] = rect.color[1]; data[i + 2] = rect.color[2];
        }
      }
      return data;
    },
  };
}

for (const build of (process.env.VISION_BUILDS || 'chrome,firefox').split(',')) {
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);

  function runAgent(next, { visionMode = 'on', provider = VISION, scene = createScene(), maxSteps = 8, onDispatch = null } = {}) {
    const requests = [];
    const scripted = {
      contextWindow: 200000, supportsTools: true, supportsVision: true, promptTier: 'full', ...provider,
      chat: withoutFixedChoiceAnswers(async (messages, options) => {
        if (!options?.tools?.length) return { content: '{}' };
        requests.push({ system: String(messages[0]?.content || ''), tools: names(options?.tools || []), messages });
        return next(requests.length, messages, options);
      }),
      async *chatStream(messages, options) {
        const response = await this.chat(messages, options);
        if (response.content) yield { type: 'text', content: response.content };
        if (response.toolCalls) yield { type: 'tool_call', content: response.toolCalls.map((item, index) => ({ ...item, index })) };
        yield { type: 'done' };
      },
    };
    const agent = new Agent({ getActive: () => scripted, getProvider: () => scripted, getVisionProvider: async () => null });
    agent.visionMode = visionMode;
    agent.leanMode = 'on';
    Object.assign(agent, {
      _hydrate: async () => {}, _persist: () => {}, _persistNow: async () => ({ ok: true }), _persistSubmittedTurn: async () => {},
      _startTraceRun: async () => null, _endTraceRun: async () => {}, _beginReadCompleteness: async () => null,
      _manageContext: async () => {}, _checkCostAllowance: async () => null, _recordCostUsage: async () => null,
      _currentUrl: async () => scene.url, _getTabUrlTitle: async () => ({ tabUrl: scene.url, tabTitle: 'Form' }),
      _maybeEmitAskModeHandoff: async () => {}, _maybeReinjectAdapter: async () => {},
      _enrichUserMessageWithCurrentPage: async (_tab, _messages, content) => ({ role: 'user', content }),
      _plannerMode: () => 'off',
      _runPlannerIntentGate: async () => ({ proceed: true, requestKind: 'execute', requiresStateChange: false, requiresSubmission: false }),
      _skipPermissionGate: true, _ensureGateSetting: async () => true, _adoptLiveSocialPublishWorkflow: async () => false,
      _isFormValidationCandidate: () => false, _shouldAutoScreenshot: () => false, _pageFeedbackIdleMs: 0,
      // Platform layer: the fake scene instead of CDP / captureTab.
      _visionPlatformProbe: async () => ({ cssWidth: scene.cssWidth, cssHeight: scene.cssHeight, scrollX: scene.scrollX, scrollY: scene.scrollY, devicePixelRatio: scene.devicePixelRatio, url: scene.url }),
      _visionPlatformCapture: async (_tab, options) => { scene.captures++; return `fake:${JSON.stringify(options.cssRegion || null)}`; },
      _visionRasterize: async (_dataUrl, width, height) => ({ canvas: { width, height }, pixels: scene.render(width, height), width, height, sourceWidth: width * scene.devicePixelRatio, sourceHeight: height * scene.devicePixelRatio }),
      _visionEncodeRegion: async (canvas, region, options) => {
        const w = region ? region.width : canvas.width; const h = region ? region.height : canvas.height;
        return { dataUrl: `data:${options.mimeType};base64,${Buffer.from(`${w}x${h}`).toString('base64')}`, mimeType: options.mimeType, bytes: w * h, width: w, height: h };
      },
      _visionPlatformWheel: async (_tab, input) => { platform.push({ kind: 'wheel', ...input }); return { success: true, dispatched: true }; },
      _visionPlatformHover: async (_tab, input) => { platform.push({ kind: 'hover', ...input }); return { success: true, dispatched: true }; },
      _visionPlatformDrag: async (_tab, input) => { platform.push({ kind: 'drag', ...input }); return { success: true, dispatched: true }; },
    });
    for (const name of ['_chromeProtectedPageFailure', '_captchaMutationPreflight', '_workflowPreSubmitDispatchBlock',
      '_messageRecipientGuardBlock', '_detectLikelySubmitAction', '_socialPublicationPreSubmitBlock']) agent[name] = async () => null;
    agent.maxSteps = maxSteps;
    const dispatched = [];
    const platform = [];
    agent._executeToolWithLifecycle = async function (tab, name, args, onUpdate, context) {
      dispatched.push({ name, args, vision: context?._vision || null });
      if (name === 'done') return { done: true, success: true, summary: args.summary, outcome: args.outcome };
      if (['take_screenshot', 'zoom', 'scroll_at', 'hover_at', 'drag_at', 'wait'].includes(name)) {
        return this._executeVisionTool(tab, name, args, context || {});
      }
      onDispatch?.(name, args, scene);
      return { success: true, dispatched: true };
    };
    return { agent, requests, dispatched, platform, scene };
  }
  const runLoop = (agent, tab, streaming, text = 'Fill the form.') => streaming
    ? agent.processMessageStream(tab, text, () => {}, 'act', { detachedRequestId: `vision-${tab}` })
    : agent.processMessage(tab, text, () => {}, 'act', [], { detachedRequestId: `vision-${tab}` });
  const visionMessages = messages => messages.filter(message => message.webbrainVisionFrame);
  const imageCount = message => (Array.isArray(message.content) ? message.content.filter(block => block.type === 'image_url').length : 0);
  const textOf = message => (Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : String(message.content || ''));

  for (const streaming of [false, true]) {
    const label = `${build}${streaming ? ' (streaming)' : ''}`;

    test(`${label}: a vision run starts from a full frame, offers coordinate tools and the vision prompt`, async () => {
      const { agent, requests } = runAgent(step => (step === 1
        ? { toolCalls: [call('done', { summary: 'Looked.', outcome: 'success' })] }
        : { content: 'done' }));
      const tab = nextTab++;
      await runLoop(agent, tab, streaming);
      const first = requests[0];
      assert.ok(first, 'the model was called');
      for (const name of ['click_at', 'scroll_at', 'zoom', 'take_screenshot', 'type_text', 'done']) assert.ok(first.tools.includes(name), `${name} offered`);
      for (const name of ['get_accessibility_tree', 'click_ax', 'set_field', 'click', 'browser_batch']) assert.ok(!first.tools.includes(name), `${name} not offered`);
      assert.match(first.system, /VISION CONTROL/);
      // Only the universal PDF rule names tree tools (as tools not to use).
      assert.doesNotMatch(first.system, /click_ax|ref_id|set_field|browser_batch|inspect_viewport/);
      const frames = visionMessages(first.messages);
      assert.equal(frames.length, 1, 'one full frame before the first decision');
      assert.equal(frames[0].webbrainVisionFrame.kind, 'key');
      assert.equal(imageCount(frames[0]), 1);
      // 1440x900 CSS on a DPR 2 screen is sent at the balanced Anthropic size, not 2880x1800.
      assert.match(textOf(frames[0]), /UNTRUSTED SCREENSHOT f1 — full viewport \(start of turn\)\. 1296x810 image; 1 image px = 1\.11 CSS px/);
      assert.match(frames[0].content.find(block => block.type === 'image_url').image_url.url, /^data:image\/(webp|jpeg);base64,/);
    });

    test(`${label}: click_at runs as a canonical CSS click, then the model gets a patch`, async () => {
      const { agent, requests, dispatched } = runAgent(step => {
        if (step === 1) return { toolCalls: [call('click_at', { x: 648, y: 405, clicks: 2 })] };
        if (step === 2) return { toolCalls: [call('done', { summary: 'Clicked.', outcome: 'success' })] };
        return { content: 'done' };
      }, { onDispatch: (name, _args, scene) => { if (name === 'click') scene.rects.push({ x: 600, y: 420, w: 200, h: 40, color: [200, 40, 40] }); } });
      const tab = nextTab++;
      await runLoop(agent, tab, streaming);
      const click = dispatched.find(entry => entry.name === 'click');
      assert.ok(click, JSON.stringify(dispatched));
      assert.deepEqual(click.args, { x: 720, y: 450, coordinate_space: 'css' });
      assert.equal(click.vision.tool, 'click_at');
      assert.equal(click.vision.clickCount, 2);
      assert.equal(click.vision.imageId, 'f1');
      const second = requests[1];
      const patch = visionMessages(second.messages).at(-1);
      assert.equal(patch.webbrainVisionFrame.kind, 'patch', textOf(patch));
      assert.match(textOf(patch), /UNTRUSTED SCREEN UPDATE — only these areas changed/);
      assert.match(textOf(patch), /p2 = area x \d+–\d+, y \d+–\d+ of f1/);
      assert.ok(imageCount(patch) >= 1);
      // The model still sees the full frame and the patch together.
      const keptImages = second.messages.reduce((sum, message) => sum + imageCount(message), 0);
      assert.equal(keptImages, 1 + imageCount(patch));
      // The assistant turn in history keeps the model's own call name.
      const assistant = second.messages.find(message => message.role === 'assistant' && message.tool_calls?.length);
      assert.equal(assistant.tool_calls[0].function.name, 'click_at');
    });

    test(`${label}: no visible change is reported in one line, without an image`, async () => {
      const { agent, requests } = runAgent(step => {
        if (step === 1) return { toolCalls: [call('click_at', { x: 10, y: 10 })] };
        if (step === 2) return { toolCalls: [call('done', { summary: 'Nothing happened.', outcome: 'partial' })] };
        return { content: 'done' };
      });
      const tab = nextTab++;
      await runLoop(agent, tab, streaming);
      const update = visionMessages(requests[1].messages).at(-1);
      assert.equal(update.webbrainVisionFrame.kind, 'none');
      assert.match(textOf(update), /no visible change/);
      assert.equal(imageCount(update), 0);
    });

    test(`${label}: a navigation or large change sends a new frame and older frames leave the request`, async () => {
      const { agent, requests } = runAgent(step => {
        if (step === 1) return { toolCalls: [call('click_at', { x: 200, y: 150 })] };
        if (step === 2) return { toolCalls: [call('click_at', { x: 300, y: 300 })] };
        if (step === 3) return { toolCalls: [call('done', { summary: 'Navigated.', outcome: 'success' })] };
        return { content: 'done' };
      }, { onDispatch: (_name, _args, scene) => { scene.url = `${PAGE}?page=${scene.captures}`; scene.rects = [{ x: 0, y: 0, w: 1440, h: 900, color: [10, 10, 10] }]; } });
      const tab = nextTab++;
      await runLoop(agent, tab, streaming);
      const third = requests[2];
      const frames = visionMessages(third.messages);
      const keys = frames.filter(frame => frame.webbrainVisionFrame.kind === 'key');
      assert.equal(keys.length, 3, 'start frame plus one new frame per navigation');
      assert.equal(imageCount(keys.at(-1)), 1);
      for (const old of keys.slice(0, -1)) {
        assert.equal(imageCount(old), 0, 'superseded frames carry no image');
        assert.match(textOf(old), /older screenshot f\d+ omitted/);
      }
      assert.match(textOf(keys.at(-1)), /f\d+ — full viewport \(page changed\)/);
    });

    test(`${label}: points from a retired frame are refused before any dispatch`, async () => {
      const { agent, requests, dispatched } = runAgent(step => {
        if (step === 1) return { toolCalls: [call('take_screenshot', {})] };
        if (step === 2) return { toolCalls: [call('click_at', { x: 100, y: 100, image: 'f1' })] };
        if (step === 3) return { toolCalls: [call('done', { summary: 'Stopped.', outcome: 'partial' })] };
        return { content: 'done' };
      });
      const tab = nextTab++;
      await runLoop(agent, tab, streaming);
      assert.ok(!dispatched.some(entry => entry.name === 'click'), 'nothing was clicked');
      const result = requests[2].messages.findLast(message => message.role === 'tool');
      assert.match(String(result.content), /Image f1 is from an earlier screen/);
    });

    test(`${label}: a second click whose area changed after the first is refused`, async () => {
      const { agent, dispatched, requests } = runAgent(step => {
        if (step === 1) return { toolCalls: [call('click_at', { x: 200, y: 150 }), call('click_at', { x: 700, y: 450 })] };
        if (step === 2) return { toolCalls: [call('done', { summary: 'One click.', outcome: 'partial' })] };
        return { content: 'done' };
      }, { onDispatch: (_name, _args, scene) => { scene.rects.push({ x: 650, y: 420, w: 160, h: 80, color: [0, 160, 0] }); } });
      const tab = nextTab++;
      await runLoop(agent, tab, streaming);
      assert.equal(dispatched.filter(entry => entry.name === 'click').length, 1, JSON.stringify(dispatched));
      const results = requests[1].messages.filter(message => message.role === 'tool').map(message => String(message.content));
      assert.ok(results.some(text => /screen changed near this point/.test(text)), results.join('\n'));
    });

    test(`${label}: scroll_at, hover_at, drag_at and zoom map points through the session`, async () => {
      const { agent, requests, platform } = runAgent(step => {
        if (step === 1) return { toolCalls: [call('scroll_at', { direction: 'down', amount: 3, x: 648, y: 405 })] };
        if (step === 2) return { toolCalls: [call('hover_at', { x: 324, y: 81 })] };
        if (step === 3) return { toolCalls: [call('drag_at', { start_x: 0, start_y: 0, end_x: 1296, end_y: 810 })] };
        if (step === 4) return { toolCalls: [call('zoom', { x: 100, y: 100, width: 200, height: 100 })] };
        if (step === 5) return { toolCalls: [call('done', { summary: 'Moved around.', outcome: 'success' })] };
        return { content: 'done' };
      }, { maxSteps: 10 });
      const tab = nextTab++;
      await runLoop(agent, tab, streaming);
      const wheel = platform.find(entry => entry.kind === 'wheel');
      assert.deepEqual({ x: wheel.x, y: wheel.y, deltaX: wheel.deltaX, deltaY: wheel.deltaY }, { x: 720, y: 450, deltaX: 0, deltaY: 300 });
      const hover = platform.find(entry => entry.kind === 'hover');
      assert.deepEqual({ x: hover.x, y: hover.y }, { x: 360, y: 90 });
      const drag = platform.find(entry => entry.kind === 'drag');
      assert.deepEqual(drag.from, { x: 0, y: 0 });
      assert.ok(drag.to.x > 1438 && drag.to.y > 898, JSON.stringify(drag.to));
      const zoomMessage = visionMessages(requests[4].messages).find(message => /UNTRUSTED ZOOM z\d+/.test(textOf(message)));
      assert.ok(zoomMessage, 'the zoom image reached the model');
      assert.equal(imageCount(zoomMessage), 1);
      assert.match(textOf(zoomMessage), /ZOOM z\d+ of f1 area x 100–300, y 100–200/);
    });

    test(`${label}: vision mode off, or a model without images, keeps the accessibility-tree path`, async () => {
      for (const options of [{ visionMode: 'off' }, { provider: { ...VISION, supportsVision: false } }]) {
        const { agent, requests } = runAgent(step => (step === 1
          ? { toolCalls: [call('done', { summary: 'Legacy.', outcome: 'success' })] }
          : { content: 'done' }), options);
        const tab = nextTab++;
        await runLoop(agent, tab, streaming);
        assert.ok(requests[0].tools.includes('get_accessibility_tree'), JSON.stringify(options));
        assert.ok(!requests[0].tools.includes('click_at'));
        assert.doesNotMatch(requests[0].system, /VISION CONTROL/);
        assert.equal(visionMessages(requests[0].messages).length, 0);
      }
    });
  }

  test(`${build}: _pruneOldImages keeps the current frame with its patches and zooms only`, () => {
    const agent = new Agent({});
    const img = id => ({ type: 'image_url', image_url: { url: `data:image/webp;base64,${id}` } });
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'legacy' }, img('legacy')] },
      { role: 'user', content: [{ type: 'text', text: 'f1' }, img('f1')], webbrainVisionFrame: { epoch: 1, kind: 'key', ids: ['f1'] } },
      { role: 'user', content: [{ type: 'text', text: 'p2' }, img('p2')], webbrainVisionFrame: { epoch: 1, kind: 'patch', ids: ['p2'] } },
      { role: 'user', content: [{ type: 'text', text: '[UNTRUSTED USER ATTACHMENTS]' }, img('attachment')] },
      { role: 'user', content: [{ type: 'text', text: 'f3' }, img('f3')], webbrainVisionFrame: { epoch: 2, kind: 'key', ids: ['f3'] } },
      { role: 'user', content: [{ type: 'text', text: 'p4' }, img('p4'), img('p5')], webbrainVisionFrame: { epoch: 2, kind: 'patch', ids: ['p4', 'p5'] } },
      { role: 'user', content: [{ type: 'text', text: 'z6' }, img('z6')], webbrainVisionFrame: { epoch: 2, kind: 'zoom', ids: ['z6'] } },
    ];
    const pruned = agent._pruneOldImages(messages, { supportsVision: true, supportsDocuments: true });
    const urls = pruned.flatMap(message => (Array.isArray(message.content) ? message.content : []))
      .filter(block => block.type === 'image_url').map(block => block.image_url.url.split(',')[1]);
    assert.deepEqual(urls.sort(), ['attachment', 'f3', 'p4', 'p5', 'z6'].sort());
    assert.match(pruned[2].content[1].text, /older screenshot f1 omitted/);
    assert.equal(messages[2].content[1].type, 'image_url', 'the persisted history is untouched');
    // A text-only provider strips every image, vision frames included.
    const textOnly = agent._pruneOldImages(messages, { supportsVision: false, supportsDocuments: true });
    assert.equal(textOnly.flatMap(message => (Array.isArray(message.content) ? message.content : [])).filter(block => block.type === 'image_url').length, 0);
  });
}
