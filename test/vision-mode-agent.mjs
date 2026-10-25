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
    probes: [],
    // What the DOM probe reports under points (vision-dom-probe.js shape).
    probe(request) {
      return {
        points: (request.points || []).map(() => ({ found: true, tag: 'div', clickable: false, opaqueFrame: false })),
        ...(request.pair ? { pair: { known: true, clickEquivalent: false } } : {}),
      };
    },
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
      _visionPlatformDomProbe: async (_tab, request) => { scene.probes.push(request); return scene.probe(request); },
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
    return { agent, requests, dispatched, platform, scene, provider: scripted };
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
      // No tree tool is named anywhere, the universal cookie/PDF guidance included.
      assert.doesNotMatch(first.system, /click_ax|ref_id|set_field|browser_batch|inspect_viewport|get_accessibility_tree|click\(\{text/);
      assert.match(first.system, /click_at "Reject all"/);
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

    test(`${label}: a zoom after an earlier action of its batch stays usable beside that batch's patch, except where the screen changed after it`, async () => {
      // The click draws a block at CSS 600–800 x 420–500; the zoom (f1 px
      // 540,380 200x100 = CSS 600,422 222x111) is taken after it, and its
      // point (100,50) is CSS 650,447, inside the block.
      for (const changedAfterZoom of [false, true]) {
        const { agent, requests, dispatched, scene } = runAgent((step, messages) => {
          if (step === 1) return { toolCalls: [call('click_at', { x: 200, y: 150 }), call('zoom', { x: 540, y: 380, width: 200, height: 100 })] };
          if (step === 2) {
            const zoomId = /UNTRUSTED ZOOM (z\d+)/.exec(messages.map(textOf).findLast(text => /UNTRUSTED ZOOM z\d+/.test(text)) || '')?.[1];
            assert.ok(zoomId, 'the zoom reached the model with the update');
            return { toolCalls: [call('click_at', { x: 100, y: 50, image: zoomId })] };
          }
          if (step === 3) return { toolCalls: [call('done', { summary: 'Done.', outcome: 'partial' })] };
          return { content: 'done' };
        }, { onDispatch: (name, _args, scene) => {
          if (name === 'click' && scene.rects.length === 1) scene.rects.push({ x: 600, y: 420, w: 200, h: 80, color: [0, 160, 0] });
        } });
        if (changedAfterZoom) {
          // The page draws again inside the zoomed area right after the zoom's capture.
          const capture = agent._visionPlatformCapture;
          agent._visionPlatformCapture = async function (tab, options) {
            const result = await capture.call(this, tab, options);
            if (options?.cssRegion && scene.rects.length === 2) scene.rects.push({ x: 620, y: 430, w: 80, h: 40, color: [20, 20, 200] });
            return result;
          };
        }
        const tab = nextTab++;
        await runLoop(agent, tab, streaming);
        const clicks = dispatched.filter(entry => entry.name === 'click');
        const results = requests[2].messages.filter(message => message.role === 'tool').map(message => String(message.content));
        if (changedAfterZoom) {
          assert.equal(clicks.length, 1, JSON.stringify(dispatched.map(entry => entry.name)));
          assert.ok(results.some(text => /changed after z\d+ was taken/.test(text)), results.join('\n'));
        } else {
          assert.equal(clicks.length, 2, results.join('\n'));
          assert.ok(Math.abs(clicks[1].args.x - 650) <= 2 && Math.abs(clicks[1].args.y - 447) <= 2, JSON.stringify(clicks[1].args));
        }
      }
    });

    test(`${label}: a drag after an earlier action of the batch is re-checked at both ends`, async () => {
      // The click draws a block at CSS 650–810 x 420–500. The drag starts far
      // from it; only its end (model 650,420 = CSS 722,467) sits on the block.
      for (const [end, refused] of [[{ end_x: 650, end_y: 420 }, true], [{ end_x: 1100, end_y: 150 }, false]]) {
        const { agent, requests, platform } = runAgent(step => {
          if (step === 1) return { toolCalls: [call('click_at', { x: 200, y: 150 }), call('drag_at', { start_x: 100, start_y: 700, ...end })] };
          if (step === 2) return { toolCalls: [call('done', { summary: 'Done.', outcome: 'partial' })] };
          return { content: 'done' };
        }, { onDispatch: (_name, _args, scene) => { scene.rects.push({ x: 650, y: 420, w: 160, h: 80, color: [0, 160, 0] }); } });
        const tab = nextTab++;
        await runLoop(agent, tab, streaming);
        const drags = platform.filter(entry => entry.kind === 'drag');
        const results = requests[1].messages.filter(message => message.role === 'tool').map(message => String(message.content));
        if (refused) {
          assert.equal(drags.length, 0, JSON.stringify(platform));
          assert.ok(results.some(text => /screen changed near the drag's end point since you read it.*choose the points again/.test(text)), results.join('\n'));
        } else {
          assert.equal(drags.length, 1, results.join('\n'));
          assert.ok(!results.some(text => /Not dispatched/.test(text)), results.join('\n'));
        }
      }
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

    test(`${label}: a Qwen2.5-VL run gets patches on its 28 px grid, and points in them map 1:1`, async () => {
      const QWEN = { name: 'openrouter', model: 'qwen/qwen2.5-vl-72b-instruct', config: { category: 'cloud', type: 'openrouter', model: 'qwen/qwen2.5-vl-72b-instruct' } };
      let patch = null;
      const { agent, requests, dispatched } = runAgent((step, messages) => {
        if (step === 1) return { toolCalls: [call('click_at', { x: 300, y: 200 })] };
        if (step === 2) {
          const note = messages.map(textOf).findLast(text => /UNTRUSTED SCREEN UPDATE/.test(text)) || '';
          const match = /(p\d+) = area x (\d+)–(\d+), y (\d+)–(\d+) of f\d+ \((\d+)x(\d+) px/.exec(note);
          assert.ok(match, note);
          patch = { id: match[1], x: Number(match[2]), y: Number(match[4]), width: Number(match[6]), height: Number(match[7]) };
          return { toolCalls: [call('click_at', { x: Math.round(patch.width / 2), y: Math.round(patch.height / 2), image: patch.id })] };
        }
        if (step === 3) return { toolCalls: [call('done', { summary: 'Clicked twice.', outcome: 'success' })] };
        return { content: 'done' };
      }, { provider: QWEN, onDispatch: (name, _args, scene) => {
        if (name === 'click' && scene.rects.length === 1) scene.rects.push({ x: 600, y: 420, w: 50, h: 30, color: [200, 40, 40] });
      } });
      const tab = nextTab++;
      await runLoop(agent, tab, streaming);
      // 1440x900 CSS -> a 1260x784 frame (multiples of 28) for this profile.
      assert.match(textOf(visionMessages(requests[0].messages)[0]), /1260x784 image/);
      assert.ok(patch, 'a patch was sent');
      assert.equal(patch.width % 28, 0, JSON.stringify(patch));
      assert.equal(patch.height % 28, 0, JSON.stringify(patch));
      const clicks = dispatched.filter(entry => entry.name === 'click');
      assert.equal(clicks.length, 2, JSON.stringify(dispatched.map(entry => entry.name)));
      const expected = { x: (patch.x + Math.round(patch.width / 2)) * 1440 / 1260, y: (patch.y + Math.round(patch.height / 2)) * 900 / 784 };
      assert.ok(Math.abs(clicks[1].args.x - expected.x) <= 1 && Math.abs(clicks[1].args.y - expected.y) <= 1,
        `patch pixels map 1:1 to the frame: ${JSON.stringify({ got: clicks[1].args, expected })}`);
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

  const toolTexts = request => request.messages.filter(message => message.role === 'tool').map(message => String(message.content));
  const totalImages = request => request.messages.reduce((sum, message) => sum + imageCount(message), 0);

  test(`${build}: a refused click_at stops the rest of its batch`, async () => {
    const { agent, requests, dispatched } = runAgent(step => {
      if (step === 1) return { toolCalls: [call('click_at', { x: 5000, y: 5000 }), call('type_text', { text: 'hunter2' })] };
      if (step === 2) return { toolCalls: [call('done', { summary: 'Stopped.', outcome: 'partial' })] };
      return { content: 'done' };
    });
    await runLoop(agent, nextTab++, false);
    // type_text types into whatever has focus; it was planned on the refused point.
    assert.ok(!dispatched.some(entry => entry.name === 'type_text'), JSON.stringify(dispatched.map(entry => entry.name)));
    assert.ok(toolTexts(requests[1]).some(text => /outside f1/.test(text)), toolTexts(requests[1]).join('\n'));
  });

  test(`${build}: a vision tool that throws returns a tool error and the run goes on`, async () => {
    const ctx = runAgent(step => {
      if (step === 1) return { toolCalls: [call('scroll_at', { direction: 'down' })] };
      if (step === 2) return { toolCalls: [call('done', { summary: 'Could not scroll.', outcome: 'partial' })] };
      return { content: 'done' };
    });
    ctx.agent._visionPlatformWheel = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
    const result = await runLoop(ctx.agent, nextTab++, false);
    assert.equal(ctx.requests.length, 2, `the model decided again: ${JSON.stringify(result).slice(0, 300)}`);
    assert.ok(toolTexts(ctx.requests[1]).some(text => /scroll_at failed while sending input/.test(text)), toolTexts(ctx.requests[1]).join('\n'));
  });

  test(`${build}: a screen update that cannot be encoded leaves a note, then a full frame follows`, async () => {
    let failPatch = true;
    const ctx = runAgent(step => {
      if (step === 1) return { toolCalls: [call('click_at', { x: 648, y: 405 })] };
      if (step === 2) return { toolCalls: [call('click_at', { x: 200, y: 150 })] };
      if (step === 3) return { toolCalls: [call('done', { summary: 'Clicked twice.', outcome: 'success' })] };
      return { content: 'done' };
    }, { onDispatch: (name, _args, scene) => { if (name === 'click') scene.rects.push({ x: 600 + scene.rects.length * 20, y: 420, w: 60, h: 40, color: [200, 40, 40] }); } });
    const encode = ctx.agent._visionEncodeRegion;
    ctx.agent._visionEncodeRegion = async (canvas, region, options) => {
      if (region && failPatch) { failPatch = false; throw new Error('convertToBlob failed'); }
      return encode(canvas, region, options);
    };
    await runLoop(ctx.agent, nextTab++, false);
    assert.equal(ctx.requests.length, 3);
    assert.match(textOf(visionMessages(ctx.requests[1].messages).at(-1)), /could not be prepared after the action/);
    const latest = visionMessages(ctx.requests[2].messages).at(-1);
    assert.equal(latest.webbrainVisionFrame.kind, 'key', textOf(latest));
    assert.match(textOf(latest), /full viewport \(requested\)/);
  });

  test(`${build}: a new run never shows or uses the previous run's frame when its first capture fails`, async () => {
    const ctx = runAgent(step => {
      if (step === 1) return { toolCalls: [call('done', { summary: 'Looked.', outcome: 'success' })] };
      if (step === 2) return { toolCalls: [call('click_at', { x: 648, y: 405 })] };
      if (step === 3) return { toolCalls: [call('done', { summary: 'Could not see.', outcome: 'partial' })] };
      return { content: 'done' };
    });
    const tab = nextTab++;
    await runLoop(ctx.agent, tab, false, 'Look at the page.');
    ctx.agent._visionPlatformCapture = async () => { throw new Error('capture failed'); };
    await runLoop(ctx.agent, tab, false, 'Click the button.');
    assert.ok(!ctx.dispatched.some(entry => entry.name === 'click'), 'nothing was clicked');
    const firstOfRun2 = ctx.requests[1];
    assert.match(textOf(visionMessages(firstOfRun2.messages).at(-1)), /first screenshot could not be captured/);
    assert.equal(totalImages(firstOfRun2), 0, 'the previous run\'s frame is not shown');
    assert.ok(toolTexts(ctx.requests[2]).some(text => /No screenshot of this page has been taken yet/.test(text)), toolTexts(ctx.requests[2]).join('\n'));
  });

  test(`${build}: after a model switch between runs the new frame is kept and ids never repeat`, async () => {
    const ctx = runAgent(step => {
      if (step === 1) return { toolCalls: [call('click_at', { x: 648, y: 405 })] };
      if (step === 2) return { toolCalls: [call('done', { summary: 'Run one.', outcome: 'success' })] };
      if (step === 3) return { toolCalls: [call('done', { summary: 'Run two.', outcome: 'success' })] };
      return { content: 'done' };
    }, { onDispatch: (_name, _args, scene) => { scene.url = `${PAGE}?n=${scene.captures}`; scene.rects = [{ x: 0, y: 0, w: 1440, h: 900, color: [20, 20, 20] }]; } });
    const tab = nextTab++;
    await runLoop(ctx.agent, tab, false, 'Run one.');
    // Another family: a new vision session (other image sizes) for run two.
    Object.assign(ctx.provider, { name: 'openai', model: 'gpt-4.1', config: { category: 'cloud', type: 'openai', model: 'gpt-4.1' } });
    ctx.scene.rects = [{ x: 50, y: 50, w: 100, h: 100, color: [0, 120, 0] }];
    await runLoop(ctx.agent, tab, false, 'Run two.');
    const run2 = ctx.requests[2];
    const keys = visionMessages(run2.messages).filter(message => message.webbrainVisionFrame.kind === 'key');
    assert.ok(keys.length >= 3, `frames of both runs are in the history (${keys.length})`);
    assert.equal(imageCount(keys.at(-1)), 1, 'the new run\'s frame is sent');
    assert.equal(totalImages(run2), 1, 'and nothing older');
    const ids = keys.map(message => message.webbrainVisionFrame.ids[0]);
    assert.equal(new Set(ids).size, ids.length, `ids never repeat: ${ids}`);
  });

  test(`${build}: drag_at refuses click-length drags and drags that would click a control`, async () => {
    const ctx = runAgent(step => {
      if (step === 1) return { toolCalls: [call('drag_at', { start_x: 300, start_y: 300, end_x: 302, end_y: 301 })] };
      if (step === 2) return { toolCalls: [call('drag_at', { start_x: 300, start_y: 300, end_x: 360, end_y: 300 })] };
      if (step === 3) return { toolCalls: [call('done', { summary: 'No drag.', outcome: 'partial' })] };
      return { content: 'done' };
    });
    ctx.scene.probe = request => ({
      points: request.points.map(() => ({ found: true, tag: 'button', clickable: true, control: 'button', opaqueFrame: false })),
      ...(request.pair ? { pair: { known: true, clickEquivalent: true, control: 'button' } } : {}),
    });
    await runLoop(ctx.agent, nextTab++, false);
    assert.equal(ctx.platform.filter(entry => entry.kind === 'drag').length, 0, 'no drag was dispatched');
    assert.ok(toolTexts(ctx.requests[1]).some(text => /a drag this short is a click/.test(text)), toolTexts(ctx.requests[1]).join('\n'));
    assert.ok(toolTexts(ctx.requests[2]).some(text => /would click the button under both ends/.test(text)), toolTexts(ctx.requests[2]).join('\n'));
    // The probe was asked about the press and release points together.
    assert.ok(ctx.scene.probes.some(request => request.pair === true && request.points.length === 2));
  });

  test(`${build}: a drag that starts on a submit control is refused`, async () => {
    const ctx = runAgent(step => {
      if (step === 1) return { toolCalls: [call('drag_at', { start_x: 300, start_y: 300, end_x: 500, end_y: 300 })] };
      if (step === 2) return { toolCalls: [call('done', { summary: 'No drag.', outcome: 'partial' })] };
      return { content: 'done' };
    });
    const probed = [];
    ctx.agent._detectLikelySubmitAction = async (_tab, name, args) => { probed.push({ name, args }); return { isSubmit: true }; };
    await runLoop(ctx.agent, nextTab++, false);
    assert.equal(ctx.platform.filter(entry => entry.kind === 'drag').length, 0);
    assert.ok(toolTexts(ctx.requests[1]).some(text => /never gets the confirmation a click gets/.test(text)), toolTexts(ctx.requests[1]).join('\n'));
    assert.deepEqual(probed.at(-1), { name: 'click', args: { x: 333.3, y: 333.3, coordinate_space: 'css' } });
  });

  test(`${build}: scroll_at over a focused number field is refused`, async () => {
    const ctx = runAgent(step => {
      if (step === 1) return { toolCalls: [call('scroll_at', { direction: 'down', x: 648, y: 405 })] };
      if (step === 2) return { toolCalls: [call('done', { summary: 'No scroll.', outcome: 'partial' })] };
      return { content: 'done' };
    });
    ctx.scene.probe = request => ({ points: request.points.map(() => ({ found: true, tag: 'input', clickable: false, opaqueFrame: false, focusedNumberInput: true })) });
    await runLoop(ctx.agent, nextTab++, false);
    assert.equal(ctx.platform.filter(entry => entry.kind === 'wheel').length, 0);
    assert.ok(toolTexts(ctx.requests[1]).some(text => /focused number field/.test(text)), toolTexts(ctx.requests[1]).join('\n'));
  });

  test(`${build}: drag_at is blocked on a protected messaging page`, async () => {
    const agent = new Agent({});
    const block = await agent._messageRecipientGuardBlock(1, 'drag_at', { start_x: 1, start_y: 1, end_x: 50, end_y: 1 }, 'https://web.whatsapp.com/');
    assert.equal(block?.reasonCode, 'recipient_unverifiable_dispatch_path', JSON.stringify(block));
    assert.match(block.error, /drag_at cannot bind its effects/);
    assert.equal(await agent._messageRecipientGuardBlock(1, 'drag_at', {}, 'https://owned.example.test/form'), null);
  });

  test(`${build}: the click preflight refuses repeated clicks on controls and focuses native selects`, async () => {
    const agent = new Agent({});
    let answer = null;
    const requests = [];
    agent._visionPlatformDomProbe = async (_tab, request) => { requests.push(request); return answer; };
    const point = extra => ({ points: [{ found: true, tag: 'span', clickable: false, opaqueFrame: false, ...extra }] });
    answer = point({ clickable: true, control: 'button' });
    assert.equal((await agent._visionClickPreflight(1, { x: 5, y: 5, clickCount: 2 })).refusal?.visionInputRefused, 'repeated_click');
    assert.equal((await agent._visionClickPreflight(1, { x: 5, y: 5, clickCount: 1 })).refusal, undefined);
    answer = point({});
    assert.deepEqual((await agent._visionClickPreflight(1, { x: 5, y: 5, clickCount: 2 })).target, { tag: 'span' }, 'text may be double-clicked');
    assert.ok((await agent._visionClickPreflight(1, { x: 5, y: 5, clickCount: 3, recipientGuarded: true })).refusal);
    assert.ok((await agent._visionClickPreflight(1, { x: 5, y: 5, clickCount: 2, submitDetected: true })).refusal);
    answer = point({ opaqueFrame: true });
    assert.ok((await agent._visionClickPreflight(1, { x: 5, y: 5, clickCount: 2 })).refusal);
    answer = null;
    assert.ok((await agent._visionClickPreflight(1, { x: 5, y: 5, clickCount: 2 })).refusal, 'unknown target: no repeated click');
    assert.equal((await agent._visionClickPreflight(1, { x: 5, y: 5, clickCount: 1 })).refusal, undefined, 'a single click still goes');
    answer = point({ tag: 'select', select: { current: 'Red', options: ['Red', 'Blue'] } });
    const select = await agent._visionClickPreflight(1, { x: 5, y: 5, clickCount: 1, button: 'left' });
    assert.equal(select.refusal?.nativeSelect, true);
    assert.match(select.refusal.error, /native dropdown \(current: "Red"\).*Options: Red, Blue/);
    assert.equal(requests.at(-1).focusSelect, true);
    assert.equal((await agent._visionClickPreflight(1, { x: 5, y: 5, clickCount: 1, button: 'right' })).refusal, undefined);
    assert.equal(requests.at(-1).focusSelect, false, 'a right click does not focus the select');
  });

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

  test(`${build}: site notes reach a vision run with a line saying which of their tools it lacks`, async () => {
    const { agent } = runAgent(() => ({ content: 'done' }));
    const tab = nextTab++;
    agent.conversationModes.set(tab, 'act');
    const api = globalThis.chrome;
    const get = api.tabs.get;
    api.tabs.get = async id => ({ id, url: 'https://mastodon.social/home', title: 'Home', status: 'complete' });
    try {
      agent.lastSeenAdapter.set(tab, null);
      const messages = [];
      // The harness stubs this hook on the instance; the real one runs here.
      const reinject = (...args) => Agent.prototype._maybeReinjectAdapter.apply(agent, args);
      assert.equal(await reinject(tab, messages), true);
      assert.match(messages[0].content, /now on [^\n]*\n\(Written for WebBrain's element tools: click_ax, set_field, type_ax, ref ids, selectors and the accessibility tree are not available in this run\./);
      agent.visionMode = 'off';
      agent.lastSeenAdapter.set(tab, null);
      const legacy = [];
      assert.equal(await reinject(tab, legacy), true);
      assert.doesNotMatch(legacy[0].content, /Written for WebBrain's element tools/);
    } finally {
      api.tabs.get = get;
    }
    for (const file of [`../src/${build}/src/agent/agent.js`]) {
      const source = (await import('node:fs')).readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.match(source, /const visionNote = this\._visionRunState\(tabId\)\.active \? `\$\{VISION_SITE_NOTES_PREFACE\}\\n` : '';\s*contextLine \+= `\$\{heading\}\\n\$\{visionNote\}/);
    }
  });

  test(`${build}: a site workflow proved against the element inventory switches the run to the tree path`, async () => {
    let tab;
    const ctx = runAgent(step => {
      if (step === 1) {
        // The planner (or a live adoption) selects a ledger workflow mid-run.
        ctx.agent._planExecutionGuards.set(tab, { ...(ctx.agent._planExecutionGuards.get(tab) || {}),
          siteWorkflow: { adapterName: 'Forms', revision: 1, job: { id: 'fill-form', template: 'form', stages: ['fill'], successEvidence: ['saved'], partialEvidence: ['not saved'], requiresLedger: true } } });
        return { toolCalls: [call('take_screenshot', {})] };
      }
      if (step === 2) {
        reasonAtStep2 = ctx.agent._visionRunState(tab, 'act').reason;
        return { toolCalls: [call('done', { summary: 'Stopped.', outcome: 'partial' })] };
      }
      return { content: 'done' };
    });
    let reasonAtStep2 = null;
    tab = nextTab++;
    await runLoop(ctx.agent, tab, false);
    assert.ok(ctx.requests[0].tools.includes('click_at'), 'the run starts in vision mode');
    assert.ok(ctx.requests[1].tools.includes('get_accessibility_tree'), ctx.requests[1].tools.join(','));
    assert.ok(!ctx.requests[1].tools.includes('click_at'));
    assert.doesNotMatch(ctx.requests[1].system, /VISION CONTROL/);
    assert.equal(reasonAtStep2, 'workflow_needs_element_inventory');
  });

  if (build === 'firefox') {
    test('firefox: a vision click settles the file-chooser guard and reports a blocked chooser in vision terms', async () => {
      const agent = new Agent({});
      agent._visionClickPreflight = async () => ({ target: { tag: 'button' } });
      agent._visionContentInput = async () => ({ success: true, dispatched: true, method: 'synthetic-vision-pointer', clicks: 1, target: { tag: 'button' }, _filePickerGuardId: 'fpg_test' });
      const api = globalThis.browser;
      const sendMessage = api.tabs.sendMessage;
      const sent = [];
      api.tabs.sendMessage = async (_tab, message) => {
        sent.push(message);
        return message.action === 'consume_file_picker_guard'
          ? { success: false, dispatched: true, filePickerBlocked: true, selector: '#upload', error: 'Blocked a native file chooser. Call upload_file({selector: "#upload"}) directly.', settled: true }
          : { ready: true };
      };
      try {
        const blocked = await agent._visionDispatchClick(1, { x: 5, y: 5 }, { vision: { tool: 'click_at', imageId: 'f1' } });
        assert.equal(blocked.filePickerBlocked, true, JSON.stringify(blocked));
        assert.equal(blocked.success, false);
        assert.equal(blocked.selector, '#upload');
        assert.equal('_filePickerGuardId' in blocked, false);
        assert.match(blocked.error, /not available in vision mode/);
        assert.doesNotMatch(blocked.error, /upload_file/, 'never points to a tool a vision run does not have');
        assert.deepEqual(sent.filter(message => message.action === 'consume_file_picker_guard').map(message => message.params.guardId), ['fpg_test']);
        api.tabs.sendMessage = async (_tab, message) => (message.action === 'consume_file_picker_guard'
          ? { success: true, settled: true, filePickerBlocked: false } : { ready: true });
        const clean = await agent._visionDispatchClick(1, { x: 5, y: 5 }, { vision: { tool: 'click_at' } });
        assert.equal(clean.success, true, JSON.stringify(clean));
        assert.equal('_filePickerGuardId' in clean, false);
      } finally {
        api.tabs.sendMessage = sendMessage;
      }
    });
  }

  if (build === 'chrome') {
    test('chrome: a vision click that opened no tab is known at once; a tab opened now or later is rerouted', async () => {
      const agent = new Agent({});
      const api = globalThis.chrome;
      const saved = { query: api.tabs.query, remove: api.tabs.remove, update: api.tabs.update };
      const tabs = [{ id: 1, url: PAGE }];
      const removed = [], updated = [];
      Object.assign(api.tabs, {
        query: async () => tabs.map(tab => ({ ...tab })),
        remove: async id => { removed.push(id); },
        update: async (id, props) => { updated.push({ id, ...props }); },
      });
      try {
        const watch = { opened: [], listening: true, stop() { this.listening = false; } };
        let started = Date.now();
        assert.equal(await agent._redirectTargetBlankClick(1, new Set([1]), { watch, quietMs: 1 }), null);
        assert.ok(Date.now() - started < 300, `no new tab is known without the full poll (${Date.now() - started} ms)`);
        // A tab the click opened at once: rerouted into the source tab.
        tabs.push({ id: 7, openerTabId: 1, url: 'https://news.example.test/story' });
        watch.opened.push(7);
        const redirected = await agent._redirectTargetBlankClick(1, new Set([1]), { watch, quietMs: 1 });
        assert.deepEqual({ redirected: redirected?.redirected, url: redirected?.url }, { redirected: true, url: 'https://news.example.test/story' });
        assert.deepEqual(removed, [7]);
        assert.deepEqual(updated, [{ id: 1, url: 'https://news.example.test/story' }]);
        // A tab opened after the quiet window is rerouted before the next
        // screen update; a new click or run cancels the watch instead.
        tabs.length = 1; removed.length = 0; updated.length = 0;
        const late = { opened: [], listening: true, stop() { this.listening = false; } };
        agent._visionLateTabWatches = new Map([[1, { watch: late, beforeTabIds: new Set([1]), timer: null }]]);
        tabs.push({ id: 9, openerTabId: 1, url: 'https://news.example.test/late' });
        late.opened.push(9);
        started = Date.now();
        const rerouted = await agent._visionPlatformLateTab(1);
        assert.equal(rerouted?.url, 'https://news.example.test/late');
        assert.equal(late.listening, false, 'the watch is stopped');
        assert.equal(agent._visionLateTabWatches.has(1), false);
        tabs.length = 1;
        const cancelled = { opened: [11], listening: true, stop() { this.listening = false; } };
        agent._visionLateTabWatches.set(1, { watch: cancelled, beforeTabIds: new Set([1]), timer: null });
        assert.equal(await agent._visionPlatformLateTab(1, { cancel: true }), null);
        assert.equal(cancelled.listening, false);
        assert.deepEqual(updated, [{ id: 1, url: 'https://news.example.test/late' }], 'a cancelled watch reroutes nothing');
      } finally {
        Object.assign(api.tabs, saved);
      }
    });

    test('chrome: a late-tab watch that has seen nothing stays armed, and a tab opened while the screen settles is rerouted before the update', async () => {
      const { agent, scene } = runAgent(() => ({ content: 'done' }));
      agent._effectiveRunMode = () => 'act';
      const tab = nextTab++;
      const messages = [];
      await agent._visionEnsureKeyframe(tab, messages, () => {});
      assert.equal(visionMessages(messages).length, 1, 'a first frame');
      const redirects = [];
      agent._redirectTargetBlankClick = async (tabId, beforeTabIds) => {
        redirects.push({ tabId, before: [...beforeTabIds] });
        scene.url = 'https://news.example.test/late';
        scene.rects = [{ x: 0, y: 0, w: 1440, h: 900, color: [10, 10, 10] }];
        return { redirected: true, url: scene.url };
      };
      const watch = { opened: [], listening: true, stop() { this.listening = false; } };
      agent._visionLateTabWatches = new Map([[tab, { watch, beforeTabIds: new Set([tab]), timer: null }]]);
      // Nothing opened yet: the update goes ahead and the watch stays armed.
      assert.equal(await agent._visionPlatformLateTab(tab), null);
      assert.equal(agent._visionLateTabWatches.get(tab)?.watch, watch);
      assert.equal(watch.listening, true);
      // The page opens the tab while the update's screen settles.
      const settle = agent._visionCaptureSettled;
      let captures = 0;
      agent._visionCaptureSettled = async function (...args) {
        const frame = await settle.apply(this, args);
        if (++captures === 1) watch.opened.push(4242);
        return frame;
      };
      const update = await agent._visionObserveAfterBatch(tab, messages, () => {}, { toolCalls: [call('click_at', { x: 1, y: 1 })] });
      assert.deepEqual(redirects, [{ tabId: tab, before: [tab] }], 'rerouted before the update');
      assert.equal(captures, 2, 'and the screen read again');
      assert.equal(update?.kind, 'keyframe', JSON.stringify(update));
      assert.match(textOf(visionMessages(messages).at(-1)), /full viewport \(page changed\)/);
      assert.equal(agent._visionLateTabWatches.has(tab), false, 'a rerouted watch is done');
      assert.equal(watch.listening, false);
      // A watch past its deadline that saw nothing is dropped, rerouting nothing.
      const expired = { opened: [], listening: false, stop() {} };
      agent._visionLateTabWatches.set(tab, { watch: expired, beforeTabIds: new Set([tab]), timer: null });
      assert.equal(await agent._visionPlatformLateTab(tab), null);
      assert.equal(agent._visionLateTabWatches.has(tab), false);
      assert.equal(redirects.length, 1);
    });
  }

  // A scene with something that never stops moving: `tick` repaints a block
  // (image px) in another colour on every capture.
  function tickingScene(block) {
    const scene = createScene();
    const render = scene.render.bind(scene);
    let frames = 0;
    scene.render = (width, height) => {
      const data = render(width, height);
      if (frames++ % 2) {
        for (let y = block.y; y < block.y + block.h; y++) for (let x = block.x; x < block.x + block.w; x++) {
          const i = (y * width + x) * 4;
          data[i] = 10; data[i + 1] = 10; data[i + 2] = 10;
        }
      }
      return data;
    };
    return scene;
  }

  test(`${build}: the settle wait ends on a caret, clock or spinner, and waits out real motion`, async () => {
    for (const [block, captures] of [[{ x: 1100, y: 760, w: 40, h: 14 }, 2], [{ x: 300, y: 200, w: 400, h: 300 }, 4]]) {
      const scene = tickingScene(block);
      const { agent } = runAgent(() => ({ content: 'done' }), { scene });
      const tab = nextTab++;
      const state = agent._visionRunState(tab, 'act');
      assert.equal(state.active, true);
      const before = scene.captures;
      await agent._visionCaptureSettled(tab, state);
      assert.equal(scene.captures - before, captures, JSON.stringify(block));
    }
  });

  test(`${build}: page churn before a decision costs no tree read, and no message or image while the screen stays as seen`, async () => {
    const treeReads = [];
    let tab;
    const queue = item => ctx.agent._queuePageFeedback(tab, { frameId: 0, revision: 1, ...item });
    const scenario = { dispatch: null, afterObservation: null };
    const ctx = runAgent(step => {
      if (step <= 3) return { toolCalls: [call('click_at', { x: 200 + step * 100, y: 150 })] };
      if (step === 4) return { toolCalls: [call('done', { summary: 'Clicked.', outcome: 'success' })] };
      return { content: 'done' };
    }, { onDispatch: () => scenario.dispatch?.(), maxSteps: 8 });
    const execute = ctx.agent.executeTool;
    ctx.agent.executeTool = function (tabId, name, ...rest) {
      if (name === 'get_accessibility_tree') treeReads.push(name);
      return execute.call(this, tabId, name, ...rest);
    };
    const observe = ctx.agent._visionObserveAfterBatch;
    ctx.agent._visionObserveAfterBatch = async function (...args) {
      const result = await observe.apply(this, args);
      scenario.afterObservation?.();
      return result;
    };
    // Step 1: a ticker updates while the click runs (automatic churn, screen as seen).
    // Step 2: the page draws a dialog right after the update was taken.
    // Step 3: the person clicks the page (never skipped, even with no visible change).
    let step = 0;
    scenario.dispatch = () => { step++; queue(step === 3 ? { kind: 'click', source: 'user', target: 'body' } : { kind: 'dom', source: 'page', target: 'div#ticker' }); };
    scenario.afterObservation = () => {
      if (step === 2) ctx.scene.rects.push({ x: 400, y: 300, w: 600, h: 300, color: [20, 120, 20] });
    };
    tab = nextTab++;
    await runLoop(ctx.agent, tab, false);
    assert.deepEqual(treeReads, [], 'a vision run never reads the tree for page feedback');
    assert.equal(ctx.requests.length, 4, ctx.requests.map(request => request.messages.length).join(','));
    const browserUpdates = request => request.messages.filter(message => /\[BROWSER STATE UPDATE/.test(textOf(message))).length;
    const screenUpdates = (request, previous) => visionMessages(request.messages).length - visionMessages(previous.messages).length;
    // After step 1: one screen update (the click's own), no feedback message.
    assert.equal(browserUpdates(ctx.requests[1]), 0, 'automatic churn on an unchanged screen adds no message');
    assert.equal(screenUpdates(ctx.requests[1], ctx.requests[0]), 1, 'and no second image');
    // After step 2: the dialog drawn after the update is reported and shown.
    assert.equal(browserUpdates(ctx.requests[2]), 1);
    assert.equal(screenUpdates(ctx.requests[2], ctx.requests[1]), 2, 'the update after the click, then the dialog');
    assert.match(textOf(visionMessages(ctx.requests[2].messages).at(-1)), /UNTRUSTED SCREEN|full viewport/);
    // After step 3: the person's input is always reported with a fresh look.
    assert.equal(browserUpdates(ctx.requests[3]), 1);
    assert.equal(screenUpdates(ctx.requests[3], ctx.requests[2]), 2);
  });
}
