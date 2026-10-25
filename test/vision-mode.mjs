// Vision mode: browser-free pieces (sizing, diffing, coordinate mapping,
// tool surface, prompt, settings). Real-browser behaviour (captures at
// device pixel ratios 1/2/3, browser zoom, trusted clicks) is covered by
// test/vision-pipeline-browser.mjs and test/quality/vision-mode-mv3.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const SHARED = ['vision-budget.js', 'vision-diff.js', 'vision-session.js', 'vision-tools.js', 'vision-mode.js', 'vision-encoder.js', 'vision-runtime.js'];

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
const api = {
  storage: { local: area, session: area, onChanged: { addListener() {} } },
  runtime: { getURL: value => `extension://test/${value}`, sendMessage: async () => ({}), getManifest: () => ({ version: '0.0.0' }) },
  tabs: { get: async id => ({ id, url: 'https://example.test/', title: 'Example', status: 'complete' }), sendMessage: async () => ({}) },
  scripting: { executeScript: async () => [{ result: null }] },
};
globalThis.chrome ??= api;
globalThis.browser ??= api;

test('vision modules are shared verbatim by both builds', () => {
  for (const file of SHARED) {
    assert.equal(read(`src/chrome/src/agent/${file}`), read(`src/firefox/src/agent/${file}`), `${file} differs between builds`);
  }
});

const budget = await import('../src/chrome/src/agent/vision-budget.js');
const diff = await import('../src/chrome/src/agent/vision-diff.js');
const sessionModule = await import('../src/chrome/src/agent/vision-session.js');
const visionTools = await import('../src/chrome/src/agent/vision-tools.js');
const visionMode = await import('../src/chrome/src/agent/vision-mode.js');
const { VisionSession } = sessionModule;

test('profiles: model ids pick the provider family before router names', () => {
  const pick = (name, model, extra = {}) => budget.detectVisionProfile({ name, config: { model, ...extra } }).id;
  assert.equal(pick('anthropic', 'claude-sonnet-5'), 'anthropic');
  assert.equal(pick('openrouter', 'anthropic/claude-opus-4.5'), 'anthropic');
  assert.equal(pick('openrouter', 'openai/gpt-5'), 'openai');
  assert.equal(pick('openai', 'gpt-4.1-mini'), 'openai');
  assert.equal(pick('openrouter', 'google/gemini-2.5-pro'), 'gemini');
  assert.equal(pick('llamacpp', 'Qwen2.5-VL-7B-Instruct'), 'qwen');
  assert.equal(pick('openrouter', 'bytedance/ui-tars-1.5-7b'), 'qwen');
  assert.equal(pick('llamacpp', 'Qwen3-VL-8B-Instruct'), 'qwen3');
  assert.equal(pick('vllm', 'Intel/Qwen3.6-27B-int4-AutoRound'), 'qwen3');
  assert.equal(pick('llamacpp', 'gemma-3-12b-it'), 'local');
  assert.equal(pick('ollama', 'llava:13b'), 'local');
  assert.equal(pick('custom', 'pixtral-large', { category: 'cloud' }), 'default');
  assert.equal(budget.VISION_PROFILES.gemini.coordinates, 'normalized');
  assert.equal(budget.VISION_PROFILES.qwen3.coordinates, 'normalized');
  assert.equal(budget.VISION_PROFILES.anthropic.coordinates, 'pixel');
});

test('sizing: never upscales, respects provider limits, aligns to the patch grid', () => {
  const { planVisionImageSize, VISION_PROFILES } = budget;
  // A 1280x800 viewport fits Anthropic's balanced budget at 1:1.
  const anthropic = planVisionImageSize({ cssWidth: 1280, cssHeight: 800, profile: VISION_PROFILES.anthropic });
  assert.deepEqual([anthropic.width, anthropic.height], [1280, 800]);
  assert.equal(anthropic.scaleX, 1);
  // A small viewport is never upscaled (retina pixels are never sent).
  const small = planVisionImageSize({ cssWidth: 800, cssHeight: 600, profile: VISION_PROFILES.anthropic, quality: 'sharp' });
  assert.deepEqual([small.width, small.height], [800, 600]);
  // A large viewport is reduced below every server-side resize threshold.
  const big = planVisionImageSize({ cssWidth: 2560, cssHeight: 1440, profile: VISION_PROFILES.anthropic, quality: 'sharp' });
  assert.ok(big.width <= 1568 && big.height <= 1568, JSON.stringify(big));
  assert.ok(big.width * big.height <= 1_150_000, JSON.stringify(big));
  assert.ok(Math.abs(big.width / big.height - 16 / 9) < 0.01, 'aspect ratio is preserved');
  // OpenAI keeps the short side at 768 so the server does not rescale.
  const openai = planVisionImageSize({ cssWidth: 1920, cssHeight: 1080, profile: VISION_PROFILES.openai, quality: 'sharp' });
  assert.ok(Math.min(openai.width, openai.height) <= 768, JSON.stringify(openai));
  // Qwen sizes are multiples of 28 so smart_resize is the identity.
  const qwen = planVisionImageSize({ cssWidth: 1366, cssHeight: 768, profile: VISION_PROFILES.qwen });
  assert.equal(qwen.width % 28, 0);
  assert.equal(qwen.height % 28, 0);
  assert.ok(qwen.width * qwen.height <= 1_003_520);
  const qwen3 = planVisionImageSize({ cssWidth: 1366, cssHeight: 768, profile: VISION_PROFILES.qwen3 });
  assert.equal(qwen3.width % 32, 0);
  // Economy is cheaper than balanced, which is no more than sharp.
  const tokens = q => planVisionImageSize({ cssWidth: 1920, cssHeight: 1080, profile: VISION_PROFILES.anthropic, quality: q }).estimatedTokens;
  assert.ok(tokens('economy') < tokens('balanced'));
  assert.ok(tokens('balanced') <= tokens('sharp'));
});

test('token estimates follow each provider formula', () => {
  const { estimateVisionTokens, VISION_PROFILES } = budget;
  assert.equal(estimateVisionTokens(1000, 750, VISION_PROFILES.anthropic), 1000);
  // 1024x640 high detail: short side already <= 768 → 2x2 tiles.
  assert.equal(estimateVisionTokens(1024, 640, VISION_PROFILES.openai), 85 + 170 * 4);
  assert.equal(estimateVisionTokens(300, 300, VISION_PROFILES.gemini), 258);
  assert.equal(estimateVisionTokens(280, 280, VISION_PROFILES.qwen), 100 + 2);
  assert.equal(estimateVisionTokens(320, 320, VISION_PROFILES.qwen3), 100 + 2);
});

test('zoom sizing renders up to 2x CSS pixels within a bounded budget', () => {
  const { planZoomImageSize, VISION_PROFILES } = budget;
  const zoom = planZoomImageSize({ regionWidth: 200, regionHeight: 100, devicePixelRatio: 2, profile: VISION_PROFILES.anthropic });
  assert.deepEqual([zoom.width, zoom.height], [400, 200]);
  const capped = planZoomImageSize({ regionWidth: 1200, regionHeight: 800, devicePixelRatio: 2, profile: VISION_PROFILES.anthropic });
  assert.ok(capped.width <= 1280 && capped.width * capped.height <= 900_000, JSON.stringify(capped));
});

test('encoding: WebP for cloud profiles, JPEG for local servers and when WebP is unavailable', () => {
  const { visionEncodingFor, VISION_PROFILES } = budget;
  assert.equal(visionEncodingFor(VISION_PROFILES.anthropic).mimeType, 'image/webp');
  assert.equal(visionEncodingFor(VISION_PROFILES.local).mimeType, 'image/jpeg');
  assert.equal(visionEncodingFor(VISION_PROFILES.anthropic, { webpSupported: false }).mimeType, 'image/jpeg');
});

function frame(width, height, fill = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = 255;
  }
  return data;
}

function paint(data, width, { x, y, w, h }, color) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * width + xx) * 4;
      data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2];
    }
  }
  return data;
}

test('diff: identical frames and encoder-level noise produce no change', () => {
  const a = frame(320, 200);
  const b = frame(320, 200);
  assert.equal(diff.diffFrames(a, b, 320, 200).regions.length, 0);
  // +-10 per channel on scattered pixels (JPEG/WebP noise) stays below the threshold.
  for (let i = 0; i < b.length; i += 4 * 7) { b[i] = 245; b[i + 1] = 247; }
  const noisy = diff.diffFrames(a, b, 320, 200);
  assert.equal(noisy.regions.length, 0, JSON.stringify(noisy));
  // A blinking caret (1x14 px) flips a handful of pixels in one cell: ignored.
  const caret = paint(frame(320, 200), 320, { x: 100, y: 50, w: 1, h
: 5 }, [0, 0, 0]);
  assert.equal(diff.diffFrames(a, caret, 320, 200).regions.length, 0);
});

test('diff: a local change yields one padded region; distant changes stay separate', () => {
  const a = frame(640, 400);
  const b = paint(frame(640, 400), 640, { x: 100, y: 120, w: 80, h: 30 }, [20, 40, 200]);
  const one = diff.diffFrames(a, b, 640, 400);
  assert.equal(one.regions.length, 1, JSON.stringify(one.regions));
  const [r] = one.regions;
  assert.ok(r.x <= 100 && r.y <= 120 && r.x + r.width >= 180 && r.y + r.height >= 150, JSON.stringify(r));
  assert.ok(r.width < 160 && r.height < 90, `region stays tight: ${JSON.stringify(r)}`);
  paint(b, 640, { x: 520, y: 320, w: 60, h: 40 }, [200, 0, 0]);
  const two = diff.diffFrames(a, b, 640, 400);
  assert.equal(two.regions.length, 2, JSON.stringify(two.regions));
  assert.ok(two.regionAreaRatio < 0.1);
});

test('diff: nearby changes merge and scattered changes are reduced to maxRegions', () => {
  const a = frame(640, 400);
  const b = frame(640, 400);
  paint(b, 640, { x: 100, y: 100, w: 20, h: 20 }, [0, 0, 0]);
  paint(b, 640, { x: 130, y: 100, w: 20, h: 20 }, [0, 0, 0]);
  assert.equal(diff.diffFrames(a, b, 640, 400).regions.length, 1, 'changes 10px apart share a region');
  const c = frame(640, 400);
  for (let i = 0; i < 8; i++) paint(c, 640, { x: 20 + i * 76, y: 20 + (i % 2) * 300, w: 12, h: 12 }, [0, 0, 0]);
  const reduced = diff.diffFrames(a, c, 640, 400, { maxRegions: 3 });
  assert.ok(reduced.regions.length <= 3, JSON.stringify(reduced.regions));
  for (let i = 0; i < 8; i++) {
    const x = 20 + i * 76 + 6;
    const y = 20 + (i % 2) * 300 + 6;
    assert.ok(diff.pointTouchesRegions({ x, y }, reduced.regions), `change ${i} is still covered`);
  }
});

test('frame update planning: none, patch, keyframe', () => {
  const opts = { width: 1280, height: 800, estimateTokens: (w, h) => Math.ceil((w * h) / 750) };
  assert.equal(diff.planFrameUpdate({ comparable: true, regions: [], regionAreaRatio: 0 }, opts).kind, 'none');
  const small = { comparable: true, regions: [{ x: 100, y: 100, width: 200, height: 60 }], regionAreaRatio: 0.012 };
  const patch = diff.planFrameUpdate(small, opts);
  assert.equal(patch.kind, 'patch');
  assert.ok(patch.patchTokens < patch.frameTokens / 5);
  assert.equal(diff.planFrameUpdate({ ...small, regionAreaRatio: 0.6 }, opts).kind, 'keyframe');
  assert.equal(diff.planFrameUpdate(small, { ...opts, patchChainLength: 6 }).kind, 'keyframe');
  assert.equal(diff.planFrameUpdate(small, { ...opts, forceKeyframe: true }).kind, 'keyframe');
  assert.equal(diff.planFrameUpdate({ comparable: false }, opts).kind, 'keyframe');
  // A 2px sliver grows to a readable minimum size.
  const sliver = diff.planFrameUpdate({ comparable: true, regions: [{ x: 600, y: 10, width: 2, height: 30 }], regionAreaRatio: 0.0001 }, opts);
  assert.ok(sliver.regions[0].width >= 48 && sliver.regions[0].height >= 48, JSON.stringify(sliver.regions));
});

test('copyRegions updates only the patched area of the seen buffer', () => {
  const seen = frame(64, 64, [0, 0, 0]);
  const next = frame(64, 64, [255, 255, 255]);
  diff.copyRegions(seen, next, 64, [{ x: 8, y: 8, width: 16, height: 16 }]);
  const at = (x, y) => seen[(y * 64 + x) * 4];
  assert.equal(at(10, 10), 255);
  assert.equal(at(30, 30), 0);
});

test('session: keyframe points map to CSS pixels on downscaled and retina captures', () => {
  // A 1440x900 CSS viewport on a DPR 2 display, sent as 1280x800.
  const s = new VisionSession();
  const f = s.registerKeyframe({ imageWidth: 1280, imageHeight: 800, cssWidth: 1440, cssHeight: 900, devicePixelRatio: 2, url: 'https://a.test/' });
  assert.equal(f.id, 'f1');
  const p = s.resolvePoint({ x: 640, y: 400 });
  assert.equal(p.ok, true);
  assert.deepEqual([p.cssX, p.cssY], [720, 450]);
  // Out of bounds and invalid points are refused with an actionable error.
  assert.equal(s.resolvePoint({ x: 1300, y: 10 }).code, 'out_of_bounds');
  assert.equal(s.resolvePoint({ x: 'a', y: 10 }).code, 'invalid_point');
  assert.equal(s.resolvePoint({ x: 10, y: 10, image: 'p9' }).code, 'unknown_image');
  // Without any frame the model is told to take one.
  assert.equal(new VisionSession().resolvePoint({ x: 1, y: 1 }).code, 'no_frame');
});

test('session: patch-local points, stale areas and retired frames', () => {
  const s = new VisionSession();
  s.registerKeyframe({ imageWidth: 1000, imageHeight: 500, cssWidth: 1000, cssHeight: 500 });
  const [patch] = s.registerPatches([{ x: 200, y: 100, width: 300, height: 100 }]);
  assert.equal(patch.id, 'p2');
  // (10, 20) inside p2 is (210, 120) on the screen.
  const local = s.resolvePoint({ x: 10, y: 20, image: 'p2' });
  assert.deepEqual([local.cssX, local.cssY], [210, 120]);
  // The same point read from f1 is stale: that area changed in p2.
  const stale = s.resolvePoint({ x: 210, y: 120, image: 'f1' });
  assert.equal(stale.code, 'stale_area');
  assert.match(stale.error, /p2/);
  // An unchanged area of f1 is still valid, and the current screen always is.
  assert.equal(s.resolvePoint({ x: 800, y: 400, image: 'f1' }).ok, true);
  assert.equal(s.resolvePoint({ x: 210, y: 120 }).ok, true);
  // A new keyframe retires every earlier image.
  s.registerKeyframe({ imageWidth: 1000, imageHeight: 500, cssWidth: 1000, cssHeight: 500 });
  const retired = s.resolvePoint({ x: 1, y: 1, image: 'p2' });
  assert.equal(retired.code, 'stale_image');
  assert.match(retired.error, /f3/);
});

test('session: normalized coordinates and zoom crops', () => {
  const s = new VisionSession({ coordinates: 'normalized' });
  s.registerKeyframe({ imageWidth: 1024, imageHeight: 640, cssWidth: 1280, cssHeight: 800 });
  const centre = s.resolvePoint({ x: 500, y: 500 });
  assert.deepEqual([centre.cssX, centre.cssY], [640, 400]);
  assert.equal(s.resolvePoint({ x: 1200, y: 10 }).code, 'out_of_bounds');

  const px = new VisionSession();
  px.registerKeyframe({ imageWidth: 1024, imageHeight: 640, cssWidth: 1280, cssHeight: 800 });
  const region = px.resolveRegion({ x: 100, y: 100, width: 200, height: 100 });
  assert.equal(region.ok, true);
  assert.deepEqual(region.keyframeRegion, { x: 100, y: 100, width: 200, height: 100 });
  assert.deepEqual(region.cssRegion, { x: 125, y: 125, width: 250, height: 125 });
  const zoom = px.registerZoom(region.keyframeRegion, 500, 250);
  // The centre of the zoom image is the centre of the region.
  const z = px.resolvePoint({ x: 250, y: 125, image: zoom.id });
  assert.deepEqual([z.cssX, z.cssY], [250, 187.5]);
});

test('session: a layout, URL or DPR change requires a new keyframe', () => {
  const s = new VisionSession();
  assert.equal(s.needsKeyframe({}), true);
  s.registerKeyframe({ imageWidth: 100, imageHeight: 50, cssWidth: 100, cssHeight: 50, devicePixelRatio: 1, url: 'https://a.test/' }, frame(100, 50));
  assert.equal(s.needsKeyframe({ cssWidth: 100, cssHeight: 50, devicePixelRatio: 1, url: 'https://a.test/' }), false);
  assert.equal(s.needsKeyframe({ cssWidth: 120, cssHeight: 50, devicePixelRatio: 1, url: 'https://a.test/' }), true);
  assert.equal(s.needsKeyframe({ cssWidth: 100, cssHeight: 50, devicePixelRatio: 2, url: 'https://a.test/' }), true);
  assert.equal(s.needsKeyframe({ cssWidth: 100, cssHeight: 50, devicePixelRatio: 1, url: 'https://a.test/b' }), true);
  s.forceKeyframe = true;
  assert.equal(s.needsKeyframe({ cssWidth: 100, cssHeight: 50, devicePixelRatio: 1, url: 'https://a.test/' }), true);
});

test('click_at translates into a canonical CSS coordinate click', () => {
  const s = new VisionSession();
  s.registerKeyframe({ imageWidth: 1024, imageHeight: 640, cssWidth: 1280, cssHeight: 800 });
  const t = visionTools.translateVisionClick({ x: 512, y: 320, clicks: 2, button: 'left' }, s);
  assert.equal(t.ok, true);
  assert.equal(t.name, 'click');
  assert.deepEqual(t.args, { x: 640, y: 400, coordinate_space: 'css' });
  assert.equal(t.vision.clickCount, 2);
  assert.equal(t.vision.tool, 'click_at');
  const bad = visionTools.translateVisionClick({ x: 5000, y: 1 }, s);
  assert.equal(bad.ok, false);
  assert.equal(bad.result.noDispatch, true);
  assert.equal(bad.result.visionCoordinateError, 'out_of_bounds');
});

test('settings: on by default, off disables, only Act with an image-capable model qualifies', () => {
  const { normalizeVisionModeSetting, resolveVisionMode } = visionMode;
  assert.equal(normalizeVisionModeSetting(undefined), 'on');
  assert.equal(normalizeVisionModeSetting('OFF'), 'off');
  assert.equal(normalizeVisionModeSetting(false), 'off');
  assert.equal(normalizeVisionModeSetting('maybe'), 'on');
  const seeing = { name: 'anthropic', supportsVision: true, config: { model: 'claude-sonnet-5' } };
  assert.deepEqual(
    { ...resolveVisionMode('on', { mode: 'act', provider: seeing }) },
    { active: true, setting: 'on', reason: 'vision_capable_model', profileId: 'anthropic', coordinates: 'pixel', quality: 'balanced' },
  );
  assert.equal(resolveVisionMode('off', { mode: 'act', provider: seeing }).reason, 'setting_off');
  assert.equal(resolveVisionMode('on', { mode: 'ask', provider: seeing }).reason, 'not_act_mode');
  assert.equal(resolveVisionMode('on', { mode: 'dev', provider: seeing }).reason, 'not_act_mode');
  assert.equal(resolveVisionMode('on', { mode: 'act', provider: { ...seeing, supportsVision: false } }).reason, 'model_without_images');
  // A describe-only vision sub-model cannot aim clicks.
  assert.equal(resolveVisionMode('on', { mode: 'act', provider: seeing, rawImage: false }).reason, 'model_without_images');
  assert.equal(resolveVisionMode('on', { mode: 'act', provider: seeing, standalone: true }).reason, 'standalone_chat');
  assert.equal(resolveVisionMode('on', { mode: 'act', provider: { name: 'openrouter', supportsVision: true, config: { model: 'google/gemini-2.5-flash' } } }).coordinates, 'normalized');
});

for (const build of ['chrome', 'firefox']) {
  const tools = await import(`../src/${build}/src/agent/tools.js`);
  const { validateToolArguments } = await import(`../src/${build}/src/agent/tool-arguments.js`);
  const gate = await import(`../src/${build}/src/agent/permission-gate.js`);
  const names = list => list.map(tool => tool.function.name);

  test(`${build}: vision tool surface replaces tree, ref and selector tools for every tier`, () => {
    for (const tier of ['compact', 'mid', 'full']) {
      const legacy = names(tools.getToolsForMode('act', { tier }));
      const vision = tools.getToolsForMode('act', { tier, vision: { coordinates: 'pixel' } });
      const visionNames = names(vision);
      for (const removed of visionTools.VISION_REMOVED_TOOLS) {
        assert.ok(!visionNames.includes(removed), `${build}/${tier}: ${removed} must not be offered in vision mode`);
      }
      for (const added of ['take_screenshot', 'click_at', 'scroll_at', 'hover_at', 'drag_at', 'zoom', 'wait', 'type_text', 'done']) {
        assert.ok(visionNames.includes(added), `${build}/${tier}: ${added} is offered`);
      }
      // Everything that does not target DOM nodes is kept.
      for (const name of legacy) {
        if (visionTools.VISION_REMOVED_TOOLS.has(name)) continue;
        assert.ok(visionNames.includes(name), `${build}/${tier}: ${name} is kept`);
      }
      assert.equal(new Set(visionNames).size, visionNames.length, 'no duplicate tool names');
      const typeText = vision.find(tool => tool.function.name === 'type_text');
      assert.deepEqual(Object.keys(typeText.function.parameters.properties).sort(), ['clear', 'text']);
      // Ask and Dev never get the vision surface.
      assert.ok(!names(tools.getToolsForMode('ask', { tier, vision: { coordinates: 'pixel' } })).includes('click_at'));
      assert.ok(!names(tools.getToolsForMode('dev', { tier, vision: { coordinates: 'pixel' } })).includes('click_at'));
    }
  });

  test(`${build}: vision schemas are closed and validate model calls`, () => {
    const vision = tools.getToolsForMode('act', { tier: 'full', vision: { coordinates: 'pixel' } });
    const schema = name => vision.find(tool => tool.function.name === name).function.parameters;
    assert.equal(validateToolArguments('click_at', { x: 10, y: 20 }, schema('click_at')).ok, true);
    assert.equal(validateToolArguments('click_at', { x: 10, y: 20, image: 'p3', clicks: 2, button: 'right' }, schema('click_at')).ok, true);
    assert.notEqual(validateToolArguments('click_at', { x: 10 }, schema('click_at')).ok, true);
    assert.notEqual(validateToolArguments('click_at', { x: 1, y: 2, ref_id: 'ref_1' }, schema('click_at')).ok, true);
    assert.notEqual(validateToolArguments('click_at', { x: 1, y: 2, clicks: 4 }, schema('click_at')).ok, true);
    assert.equal(validateToolArguments('scroll_at', { direction: 'down' }, schema('scroll_at')).ok, true);
    assert.equal(validateToolArguments('drag_at', { start_x: 1, start_y: 2, end_x: 3, end_y: 4 }, schema('drag_at')).ok, true);
    assert.equal(validateToolArguments('zoom', { x: 1, y: 2, width: 30, height: 40 }, schema('zoom')).ok, true);
    assert.equal(validateToolArguments('wait', { seconds: 1 }, schema('wait')).ok, true);
    assert.notEqual(validateToolArguments('wait', { seconds: 60 }, schema('wait')).ok, true);
    // Normalized profiles describe 0..1000 coordinates.
    const normalized = tools.getToolsForMode('act', { tier: 'full', vision: { coordinates: 'normalized' } });
    assert.match(normalized.find(tool => tool.function.name === 'click_at').function.description, /0\.\.1000/);
  });

  test(`${build}: every vision tool is classified for the permission gate and untrusted results`, () => {
    for (const name of visionTools.VISION_TOOL_NAMES) {
      const gated = gate.capabilityFor(name, {}) !== null;
      const untrusted = gate.UNTRUSTED_CONTENT_TOOLS.has(name);
      assert.ok(gated || untrusted || name === 'wait', `${build}: ${name} is unclassified`);
    }
    assert.equal(gate.capabilityFor('click_at', {}), gate.Capability.CLICK);
    assert.equal(gate.capabilityFor('drag_at', {}), gate.Capability.CLICK);
    assert.equal(gate.capabilityFor('scroll_at', {}), null);
    for (const name of visionTools.VISION_TOOL_NAMES) {
      assert.ok(tools.RESERVED_AGENT_TOOL_NAMES.has(name), `${build}: skills cannot shadow ${name}`);
    }
  });

  test(`${build}: the vision Act prompt teaches coordinates and never mentions tree tools`, () => {
    for (const tier of ['compact', 'mid', 'full']) {
      const prompt = tools.getVisionActPrompt({ coordinates: 'pixel', tier });
      assert.match(prompt, /VISION CONTROL/);
      assert.match(prompt, /click_at/);
      assert.match(prompt, /UNTRUSTED/);
      assert.match(prompt, /retina/);
      assert.doesNotMatch(prompt, /get_accessibility_tree|click_ax|set_field|ref_id/);
    }
    assert.match(tools.getVisionActPrompt({ coordinates: 'normalized' }), /0\.\.1000/);
    assert.match(tools.getVisionActPrompt({ tier: 'compact' }), /cannot schedule/);
  });
}

for (const build of ['chrome', 'firefox']) {
  test(`${build}: settings, background, export, locales and traces carry the vision settings`, async () => {
    const html = read(`src/${build}/src/ui/settings.html`);
    const settings = read(`src/${build}/src/ui/settings.js`);
    const background = read(`src/${build}/src/background.js`);
    const runtime = build === 'chrome' ? 'chrome' : 'browser';
    assert.match(html, /<select id="select-vision-mode" data-i18n-aria-label="st\.display\.vision_mode\.label">\s*<option value="on" data-i18n="st\.display\.vision_mode\.on"><\/option>\s*<option value="off" data-i18n="st\.display\.vision_mode\.off"><\/option>/);
    assert.match(html, /<select id="select-vision-quality"[\s\S]*?value="economy"[\s\S]*?value="balanced"[\s\S]*?value="sharp"/);
    assert.ok(html.indexOf('select-vision-mode') > html.indexOf('select-lean-mode'), 'next to Lean mode in Advanced');
    assert.match(settings, /visionModeSelect\.value = normalizeVisionModeSetting\(stored\.visionMode\)/);
    assert.match(settings, new RegExp(`await ${runtime}\\.storage\\.local\\.set\\(\\{ visionMode: normalizeVisionModeSetting\\(visionModeSelect\\.value\\) \\}\\)`));
    assert.match(settings, new RegExp(`await ${runtime}\\.storage\\.local\\.set\\(\\{ visionQuality: normalizeVisionQuality\\(visionQualitySelect\\.value\\) \\}\\)`));
    // Background applies the stored setting (default on) before the first chat.
    assert.match(background, /agent\.visionMode = normalizeVisionModeSetting\(stored\?\.visionMode\);/);
    assert.match(background, /if \(changes\.visionMode\) \{\s*agent\.visionMode = normalizeVisionModeSetting\(changes\.visionMode\.newValue\);/);
    assert.equal((background.match(/await strictSecretModeReady;/g) || []).length, (background.match(/await visionModeReady;/g) || []).length,
      'every hydration wait also waits for the vision setting');
    const config = await import(`../src/${build}/src/config-transfer.js`);
    assert.equal(config.DEFAULT_CONFIG_SETTINGS.visionMode, 'on');
    assert.equal(config.DEFAULT_CONFIG_SETTINGS.visionQuality, 'balanced');
    assert.ok(config.CONFIG_STORAGE_KEYS.includes('visionMode'));
    assert.ok(config.CONFIG_STORAGE_KEYS.includes('visionQuality'));
    const exported = config.createConfigExport({});
    assert.equal(config.parseConfigImport(JSON.stringify({ ...exported, settings: { ...exported.settings, visionMode: 'off', visionQuality: 'sharp' } })).settings.visionMode, 'off');
    assert.throws(() => config.parseConfigImport(JSON.stringify({ ...exported, settings: { ...exported.settings, visionMode: 'maybe' } })), /visionMode/);
    assert.throws(() => config.parseConfigImport(JSON.stringify({ ...exported, settings: { ...exported.settings, visionQuality: 'huge' } })), /visionQuality/);
    // Every locale has real, translated copy.
    const dir = path.join(ROOT, `src/${build}/src/ui/locales`);
    const english = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    const locales = fs.readdirSync(dir).filter(name => /^[a-z]{2}\.js$/.test(name));
    assert.equal(locales.length, 23);
    const keys = ['vision_mode.label', 'vision_mode.desc', 'vision_mode.on', 'vision_mode.off', 'vision_quality.label', 'vision_quality.desc',
      'vision_quality.economy', 'vision_quality.balanced', 'vision_quality.sharp'];
    for (const file of locales) {
      const dict = (await import(`../src/${build}/src/ui/locales/${file}`)).default;
      for (const key of keys) assert.ok(String(dict[`st.display.${key}`] || '').trim(), `${file}: ${key}`);
      if (file !== 'en.js') assert.notEqual(dict['st.display.vision_mode.desc'], english['st.display.vision_mode.desc'], `${file}: translated description`);
    }
    // Traces record the setting and the run's resolved state, nothing else.
    const runtimeConfig = await import(`../src/${build}/src/trace/runtime-config.js`);
    assert.deepEqual(runtimeConfig.normalizeRuntimeTraceConfig({ vision_mode: true, vision_mode_setting: 'on', token: 'x' }),
      { schema_version: 1, vision_mode: true, vision_mode_setting: 'on' });
  });
}
