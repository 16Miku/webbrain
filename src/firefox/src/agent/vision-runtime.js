// Vision mode runtime: the agent-side half of vision-mode.js. Installed onto
// the Agent class of each build by installVisionRuntime(); the per-build
// agent.js supplies five small platform methods (probe, capture, wheel,
// hover, drag) and the click dispatch. Shared verbatim by both builds.
//
// Flow of a vision Act run:
//   1. The run starts with a fresh full frame (f<n>) after the user's message.
//   2. The model calls coordinate tools. click_at is rewritten into an
//      ordinary coordinate `click` before the batch pipeline, so every
//      permission gate and hard guard sees it; the other tools run here.
//   3. After the batch WebBrain waits for the screen to settle, diffs it
//      against what the model has seen and sends a patch, a new frame, or a
//      one-line "no visible change".
//   4. Only the current frame, its patches and zooms stay in the request;
//      older images become short placeholders (_visionPruneImages).

import { resolveVisionMode, normalizeVisionModeSetting } from './vision-mode.js';
import { VisionSession } from './vision-session.js';
import { diffFrames, planFrameUpdate, pointTouchesRegions } from './vision-diff.js';
import {
  VISION_PROFILES, planVisionImageSize, planZoomImageSize, estimateVisionTokens, visionEncodingFor,
  normalizeVisionQuality,
} from './vision-budget.js';
import { rasterizeFrame, encodeCanvasRegion, supportsWebpEncoding } from './vision-encoder.js';
import {
  VISION_NATIVE_TOOLS, VISION_TRANSLATED_TOOLS, VISION_NO_OBSERVE_TOOLS, VISION_TOOL_NAMES,
  VISION_SCROLL_STEP_CSS_PX, VISION_DEFAULT_SCROLL_STEPS, VISION_MAX_WAIT_SECONDS,
  translateVisionClick, visionKeyframeNote, visionPatchNote, visionNoChangeNote, visionZoomNote,
} from './vision-tools.js';
import {
  VISION_MIN_DRAG_CSS_PX, visionMultiClickRefusal, visionDragRefusal, visionWheelRefusal,
} from './vision-dom-probe.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Errors that steer the run (stop, deadlines, page feedback) pass through;
// anything else in a vision tool or screen update becomes a result or a note
// instead of ending the run.
function isControlFlowError(error) {
  return error?.name === 'AbortError'
    || error?.code === 'content_action_timeout'
    || error?.code === 'page_feedback_pending';
}

function errorText(error) {
  return String(error?.message || error || 'unknown error').slice(0, 200);
}
// A point within this many keyframe px of a change made earlier in the same
// batch is refused: the model chose it on the screen before that change.
const STABILITY_MARGIN_PX = 12;
const SETTLE_INITIAL_DELAY_MS = 120;
const SETTLE_POLL_MS = 220;
const SETTLE_MAX_EXTRA_CAPTURES = 3;
// A change this small between two captures (a blinking caret, a ticking
// clock, a spinner: a few 16 px cells) is not the page still reacting to an
// action, and right after the model looked it is not worth a new image.
const MICRO_CHANGE_CELL_RATIO = 0.004;
const MICRO_CHANGE_MIN_CELLS = 6;

export function isMicroScreenChange(diff) {
  return diff?.comparable === true && Number.isFinite(diff.changedCells)
    && diff.changedCells <= Math.max(MICRO_CHANGE_MIN_CELLS, Math.round((Number(diff.totalCells) || 0) * MICRO_CHANGE_CELL_RATIO));
}

function visionFrameTag(message) {
  return message && typeof message === 'object' ? message.webbrainVisionFrame : null;
}

function isImageBlock(block) {
  return block && (block.type === 'image_url' || block.type === 'image');
}

// Screen updates are app-owned user turns: never mistaken for a new user
// request (task anchors, plan guards), and their webbrain* keys never reach
// a provider.
function visionUserMessage(content, tag) {
  return { role: 'user', content, webbrainAppOwned: true, webbrainAppOwnedKind: 'vision_frame', webbrainVisionFrame: tag };
}

function regionLabel(region) {
  return { x: Math.round(region.x), y: Math.round(region.y), width: Math.round(region.width), height: Math.round(region.height) };
}

/** Highest epoch and image number a history already used (session seeds). */
export function visionHistoryCounters(messages) {
  let epoch = 0;
  let counter = 0;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const tag = visionFrameTag(message);
      if (!tag) continue;
      epoch = Math.max(epoch, Number(tag.epoch) || 0);
      for (const id of Array.isArray(tag.ids) ? tag.ids : []) {
        const number = Number(String(id).slice(1));
        if (Number.isFinite(number)) counter = Math.max(counter, number);
      }
    }
  }
  return { epoch, counter };
}

/**
 * Keep only the current screen's images: the LAST full frame in the history
 * and the patches and zooms after it. Position decides, not the epoch
 * number, which starts over in a new session (another model, a restarted
 * worker). Exported for the unit suite; agents call it via _pruneOldImages.
 * Returns { messages, latestEpoch } where `messages` is a shallow copy.
 */
export function pruneVisionImages(messages) {
  if (!Array.isArray(messages)) return { messages, latestEpoch: 0 };
  let latestKeyIndex = -1;
  let retireIndex = -1;
  for (let index = messages.length - 1; index >= 0 && latestKeyIndex < 0; index--) {
    const tag = visionFrameTag(messages[index]);
    if (tag?.kind === 'key') latestKeyIndex = index;
    else if (tag?.kind === 'retire' && retireIndex < 0) retireIndex = index;
  }
  if (latestKeyIndex < 0) return { messages, latestEpoch: 0 };
  const latestEpoch = Math.max(1, Number(visionFrameTag(messages[latestKeyIndex]).epoch) || 1);
  // A run whose first capture failed retires the last frame: it showed an
  // earlier run's screen, and no point may be read from it any more.
  const boundary = retireIndex > latestKeyIndex ? retireIndex : latestKeyIndex;
  const out = messages.map((message, index) => {
    const tag = visionFrameTag(message);
    if (!Array.isArray(message?.content)) return message;
    if (tag && index >= boundary) return message;
    // Untagged screenshots older than the current frame (an Ask-mode capture
    // before an automatic switch to Act) are superseded by it too. User
    // attachments are never touched.
    if (!tag && (index > boundary || message.role !== 'user')) return message;
    let inAttachments = false;
    let changed = false;
    const content = message.content.map(block => {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith('[UNTRUSTED USER ATTACHMENTS')) {
        inAttachments = true;
        return block;
      }
      if (!isImageBlock(block) || inAttachments) return block;
      changed = true;
      return { type: 'text', text: `[older screenshot${tag?.ids?.length ? ` ${tag.ids.join(', ')}` : ''} omitted — superseded by the current frame]` };
    });
    return changed ? { ...message, content } : message;
  });
  return { messages: out, latestEpoch };
}

export function installVisionRuntime(AgentClass, { trace = null } = {}) {
  const proto = AgentClass.prototype;

  /** Vision decision for this tab's run (or the live settings between runs). */
  proto._visionRunState = function _visionRunState(tabId, mode = null) {
    const runMode = mode || (typeof this._effectiveRunMode === 'function' ? this._effectiveRunMode(tabId) : 'ask');
    const snapshot = this._visionRunSnapshots?.get(tabId);
    let provider = null;
    try { provider = this._activeProvider(tabId); } catch { provider = null; }
    const standalone = !!(this._standaloneChatRunTabs?.has(tabId) || this._tinyAskRunTabs?.has(tabId)
      || this._standaloneWebgpuRunTabs?.has(tabId));
    return resolveVisionMode(snapshot ? snapshot.setting : this.visionMode, {
      mode: runMode,
      provider,
      standalone,
      quality: snapshot ? snapshot.quality : this.visionQuality,
      ledgerWorkflow: this._planExecutionGuards?.get?.(tabId)?.siteWorkflow?.job?.requiresLedger === true,
    });
  };

  proto._visionToolOptions = function _visionToolOptions(tabId, mode) {
    const state = this._visionRunState(tabId, mode);
    return state.active ? { coordinates: state.coordinates } : null;
  };

  /**
   * Freeze the setting for the length of one run (see vision-mode.js). The
   * previous run's screen is retired: a run acts only on frames it captured
   * itself, so a failed first capture can never leave the model aiming at
   * the last run's page.
   */
  proto._beginVisionRun = function _beginVisionRun(tabId) {
    if (!this._visionRunSnapshots) this._visionRunSnapshots = new Map();
    this._visionRunSnapshots.set(tabId, {
      setting: normalizeVisionModeSetting(this.visionMode, 'off'),
      quality: normalizeVisionQuality(this.visionQuality),
    });
    this._visionSessions?.get(tabId)?.retireKeyframe?.();
    void this._visionPlatformLateTab?.(tabId, { cancel: true })?.catch?.(() => {});
  };

  /** `previous` is the snapshot of an enclosing run on the same tab, if any. */
  proto._endVisionRun = function _endVisionRun(tabId, previous = null) {
    if (previous) this._visionRunSnapshots?.set(tabId, previous);
    else this._visionRunSnapshots?.delete(tabId);
    void this._visionPlatformLateTab?.(tabId, { cancel: true })?.catch?.(() => {});
  };

  /** A closed tab or cleared conversation drops its screen state. */
  proto._visionForgetTab = function _visionForgetTab(tabId) {
    this._visionSessions?.delete(tabId);
    this._visionProbeContexts?.delete(tabId);
  };

  proto._visionSessionFor = function _visionSessionFor(tabId, state) {
    if (!this._visionSessions) this._visionSessions = new Map();
    const previous = this._visionSessions.get(tabId);
    if (previous && previous.coordinates === state.coordinates && previous.profileId === state.profileId) return previous;
    // A new session (first use, another model, a restarted worker) continues
    // the history's numbering so its ids and epochs never repeat.
    const history = visionHistoryCounters(this.conversations?.get?.(tabId));
    const session = new VisionSession({
      coordinates: state.coordinates,
      startEpoch: Math.max(history.epoch, previous?.epoch || 0),
      startCounter: Math.max(history.counter, previous?.counter || 0),
    });
    session.profileId = state.profileId;
    if (previous) {
      for (const [id, retired] of previous.retired) session.retired.set(id, retired);
      for (const [id, image] of previous.images) session.retired.set(id, { epoch: image.epoch, replacedBy: null });
    }
    this._visionSessions.set(tabId, session);
    return session;
  };

  /** The click submit probe at a CSS point: its reading when it is a submit, else null. */
  proto._visionSubmitAt = async function _visionSubmitAt(tabId, point) {
    if (typeof this._detectLikelySubmitAction !== 'function') return null;
    try {
      const detected = await this._detectLikelySubmitAction(tabId, 'click', { x: point.x, y: point.y, coordinate_space: 'css' });
      return detected?.isSubmit === true ? detected : null;
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      return null;
    }
  };

  /** What is under CSS points (vision-dom-probe.js); null when it cannot be read. */
  proto._visionDomProbe = async function _visionDomProbe(tabId, request) {
    if (typeof this._visionPlatformDomProbe !== 'function') return null;
    try {
      return await this._visionPlatformDomProbe(tabId, request);
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      return null;
    }
  };

  /**
   * Checks right before a vision click is dispatched, in both builds: a
   * native <select> is focused for type_text (its popup never shows in a
   * screenshot), and a double/triple click that would repeat a control's
   * action is refused. Returns { refusal } or { target }.
   */
  proto._visionClickPreflight = async function _visionClickPreflight(tabId, {
    x, y, button = 'left', clickCount = 1, recipientGuarded = false, submitDetected = false,
  } = {}) {
    const probe = await this._visionDomProbe(tabId, { points: [{ x, y }], focusSelect: button === 'left' });
    const point = probe?.points?.[0] || null;
    if (point?.select && button === 'left') {
      return {
        refusal: {
          success: false, dispatched: false, noDispatch: true, nativeSelect: true, tag: 'SELECT',
          text: point.select.current, options: point.select.options,
          error: `That point is a native dropdown (current: "${point.select.current}"). It is focused now: choose an option with type_text({text: "<option label>"}). Options: ${point.select.options.join(', ')}`,
        },
      };
    }
    const refusal = visionMultiClickRefusal(probe, { clickCount, recipientGuarded, submitDetected });
    if (refusal) return { refusal };
    return { target: point?.found ? { tag: point.tag, ...(point.role ? { role: point.role } : {}) } : null };
  };

  proto._visionTraceNote = function _visionTraceNote(tabId, note, data) {
    const runId = this.currentRunId?.get?.(tabId);
    if (!runId || !trace?.recordNote) return;
    try { trace.recordNote(runId, null, note, data); } catch { /* traces are optional */ }
  };

  proto._visionEncoding = async function _visionEncoding(profile) {
    let webpSupported = false;
    try { webpSupported = await supportsWebpEncoding(); } catch { webpSupported = false; }
    return visionEncodingFor(profile, { webpSupported });
  };

  /**
   * Capture the viewport at the planned model size. The platform capture may
   * return any size (device pixels, emulated DPR, zoom); rasterizeFrame
   * resamples to the plan so the coordinate map is exact.
   */
  proto._visionCaptureFrame = async function _visionCaptureFrame(tabId, state) {
    const probe = await this._visionPlatformProbe(tabId);
    if (!probe || !(probe.cssWidth > 0) || !(probe.cssHeight > 0)) throw new Error('The page viewport could not be measured.');
    const profile = VISION_PROFILES[state.profileId] || VISION_PROFILES.default;
    const size = planVisionImageSize({ cssWidth: probe.cssWidth, cssHeight: probe.cssHeight, profile, quality: state.quality });
    let dataUrl = await this._visionPlatformCapture(tabId, { probe, outWidth: size.width, outHeight: size.height });
    if (!dataUrl) throw new Error('The browser returned no screenshot.');
    if (this.screenshotRedaction && typeof this._redactScreenshotDataUrl === 'function') {
      try {
        // The capture spans the visual viewport (no scrollbars), so the
        // redactor gets that box in page space rather than its own
        // innerWidth-based viewport.
        dataUrl = await this._redactScreenshotDataUrl(tabId, dataUrl, {
          coordinateSpace: 'page',
          capturedCssBounds: { x: probe.scrollX || 0, y: probe.scrollY || 0, width: probe.cssWidth, height: probe.cssHeight },
        });
      } catch { /* keep the capture */ }
    }
    const raster = await this._visionRasterize(dataUrl, size.width, size.height);
    return { raster, probe, size, profile };
  };

  // Indirections over vision-encoder.js so the Node suite can substitute
  // canvas-free fakes; browsers always use the real encoder.
  proto._visionRasterize = function _visionRasterize(dataUrl, width, height) {
    return rasterizeFrame(dataUrl, width, height);
  };

  proto._visionEncodeRegion = function _visionEncodeRegion(canvas, region, options) {
    return encodeCanvasRegion(canvas, region, options);
  };

  /**
   * Capture until two consecutive frames match (bounded). Micro changes (a
   * caret, a clock, a spinner) count as a match: they never stop, and waiting
   * for them only cost the full settle time on every step.
   */
  proto._visionCaptureSettled = async function _visionCaptureSettled(tabId, state) {
    await sleep(SETTLE_INITIAL_DELAY_MS);
    let frame = await this._visionCaptureFrame(tabId, state);
    for (let attempt = 0; attempt < SETTLE_MAX_EXTRA_CAPTURES; attempt++) {
      await sleep(SETTLE_POLL_MS);
      let next;
      try { next = await this._visionCaptureFrame(tabId, state); } catch { break; }
      const sameShape = next.size.width === frame.size.width && next.size.height === frame.size.height;
      const moving = !sameShape || !isMicroScreenChange(diffFrames(frame.raster.pixels, next.raster.pixels, next.size.width, next.size.height));
      frame = next;
      if (!moving) break;
    }
    return frame;
  };

  /**
   * Page feedback before a decision (page-feedback.js): is the screen still
   * what the model last saw, give or take a micro change? One capture, no
   * settling; anything else (another page, another size, a requested frame,
   * a capture failure) answers false and gets a full observation.
   */
  proto._visionScreenUnchanged = async function _visionScreenUnchanged(tabId) {
    const state = this._visionRunState(tabId);
    const session = this._visionSessions?.get(tabId);
    if (!state.active || !session?.keyframe || !session.seenPixels || session.forceKeyframe || session.pendingZooms?.length) return false;
    let frame;
    try { frame = await this._visionCaptureFrame(tabId, state); }
    catch (error) {
      if (isControlFlowError(error)) throw error;
      return false;
    }
    if (frame.size.width !== session.keyframe.width || frame.size.height !== session.keyframe.height
        || session.needsKeyframe({ cssWidth: frame.probe.cssWidth, cssHeight: frame.probe.cssHeight,
          devicePixelRatio: frame.probe.devicePixelRatio, url: frame.probe.url })) return false;
    return isMicroScreenChange(diffFrames(session.seenPixels, frame.raster.pixels, frame.size.width, frame.size.height));
  };

  // `detail: 'high'` regardless of the Image detail setting: OpenAI's low
  // detail would shrink the frame to 512 px on the server, and every point
  // the model returned would be off by that factor. Size is governed by the
  // vision screenshot size setting instead; other providers ignore detail.
  proto._visionImageMessage = function _visionImageMessage(textNote, images, tag) {
    return visionUserMessage([
      { type: 'text', text: textNote },
      ...images.map(image => ({ type: 'image_url', image_url: { url: image.dataUrl, detail: 'high' } })),
    ], tag);
  };

  proto._visionEmitUpdate = function _visionEmitUpdate(tabId, onUpdate, result, images = []) {
    try {
      onUpdate?.('tool_call', { name: 'auto_screenshot', args: {} });
      onUpdate?.('tool_result', { name: 'auto_screenshot', result });
    } catch { /* UI updates are best effort */ }
    const runId = this.currentRunId?.get?.(tabId);
    if (runId && trace?.recordScreenshot) {
      for (const image of images) {
        try { trace.recordScreenshot(runId, null, image.dataUrl, `vision ${image.id} (${image.kind})`); } catch {}
      }
    }
  };

  proto._visionRecordObservation = async function _visionRecordObservation(tabId, url) {
    try {
      this._recordCompletionToolResult?.(tabId, 'auto_screenshot', {}, {
        success: true, method: 'image_attach', _attachImage: true, pageUrl: url || '',
      });
    } catch { /* completion bookkeeping is best effort */ }
  };

  /** Push a full frame (keyframe) for the current screen. */
  proto._visionPushKeyframe = async function _visionPushKeyframe(tabId, messages, onUpdate, { state, frame = null, reason = '' } = {}) {
    const session = this._visionSessionFor(tabId, state);
    const captured = frame || await this._visionCaptureFrame(tabId, state);
    const encoding = await this._visionEncoding(captured.profile);
    const encoded = await this._visionEncodeRegion(captured.raster.canvas, null, { mimeType: encoding.mimeType, quality: encoding.quality });
    const keyframe = session.registerKeyframe({
      imageWidth: captured.size.width,
      imageHeight: captured.size.height,
      cssWidth: captured.probe.cssWidth,
      cssHeight: captured.probe.cssHeight,
      devicePixelRatio: captured.probe.devicePixelRatio,
      scrollX: captured.probe.scrollX,
      scrollY: captured.probe.scrollY,
      url: captured.probe.url,
    }, captured.raster.pixels);
    // Zooms taken earlier in this batch belong to the previous frame, whose
    // ids this keyframe retires; the fresh frame supersedes them.
    const droppedZooms = this._visionTakePendingZooms(tabId);
    const note = visionKeyframeNote(keyframe, { coordinates: session.coordinates, reason })
      + (droppedZooms.length ? ` (${droppedZooms.map(zoom => zoom.id).join(', ')} not shown: the screen was re-captured; zoom again if needed.)` : '');
    messages.push(this._visionImageMessage(note, [{ dataUrl: encoded.dataUrl }],
      { epoch: keyframe.epoch, kind: 'key', ids: [keyframe.id] }));
    const tokens = estimateVisionTokens(keyframe.width, keyframe.height, captured.profile);
    this._visionEmitUpdate(tabId, onUpdate, {
      success: true,
      method: 'image_attach',
      description: `Vision frame ${keyframe.id} attached (${keyframe.width}x${keyframe.height}, ${encoded.mimeType}).`,
      vision: { kind: 'keyframe', imageId: keyframe.id, reason, bytes: encoded.bytes, estimatedTokens: tokens, mimeType: encoded.mimeType },
      imageDimensions: { width: keyframe.width, height: keyframe.height },
      cssViewportDimensions: { width: keyframe.cssWidth, height: keyframe.cssHeight },
      devicePixelRatio: keyframe.devicePixelRatio,
    }, [{ id: keyframe.id, kind: 'keyframe', dataUrl: encoded.dataUrl }]);
    this._visionTraceNote(tabId, 'vision_frame', {
      kind: 'keyframe', id: keyframe.id, reason, width: keyframe.width, height: keyframe.height,
      cssWidth: keyframe.cssWidth, cssHeight: keyframe.cssHeight, devicePixelRatio: keyframe.devicePixelRatio,
      captureWidth: captured.raster.sourceWidth, captureHeight: captured.raster.sourceHeight,
      bytes: encoded.bytes, mimeType: encoded.mimeType, estimatedTokens: tokens, profile: captured.profile.id,
    });
    await this._visionRecordObservation(tabId, keyframe.url);
    return keyframe;
  };

  /**
   * Start of a vision turn: the model gets a fresh full frame before its
   * first decision. Failures leave the run usable (take_screenshot retries).
   */
  proto._visionEnsureKeyframe = async function _visionEnsureKeyframe(tabId, messages, onUpdate, { mode = 'act', reason = 'start of turn' } = {}) {
    const state = this._visionRunState(tabId, mode);
    if (!state.active) return null;
    try {
      return await this._visionPushKeyframe(tabId, messages, onUpdate, { state, reason });
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      // The run starts with no screen (_beginVisionRun retired the last one);
      // the tag retires the last frame in the history for the model too.
      const message = `[SCREEN: the first screenshot could not be captured (${errorText(error).slice(0, 160)}). Earlier screenshots show an older screen and cannot be used for coordinates. Call take_screenshot to try again.]`;
      messages.push(visionUserMessage(message, { epoch: 0, kind: 'retire' }));
      this._visionTraceNote(tabId, 'vision_frame_error', { stage: 'start', error: String(error?.message || error).slice(0, 200) });
      return null;
    }
  };

  proto._visionTakePendingZooms = function _visionTakePendingZooms(tabId) {
    const session = this._visionSessions?.get(tabId);
    if (!session?.pendingZooms?.length) return [];
    const zooms = session.pendingZooms;
    session.pendingZooms = [];
    return zooms;
  };

  /**
   * After a tool batch: show the model what changed. `toolCalls` are the
   * calls the batch ran (translated or not).
   */
  proto._visionObserveAfterBatch = async function _visionObserveAfterBatch(tabId, messages, onUpdate, { toolCalls = [], force = false } = {}) {
    const state = this._visionRunState(tabId);
    if (!state.active) return null;
    const session = this._visionSessionFor(tabId, state);
    const names = toolCalls.map(call => call?._vision?.tool || call?.function?.name).filter(Boolean);
    const observe = force || names.some(name => !VISION_NO_OBSERVE_TOOLS.has(name)) || session.forceKeyframe;
    const zoomsOnly = !observe && session.pendingZooms?.length;
    if (zoomsOnly) {
      const zooms = this._visionTakePendingZooms(tabId);
      messages.push(this._visionImageMessage(zooms.map(zoom => zoom.note).join('\n'), zooms,
        { epoch: session.epoch, kind: 'zoom', ids: zooms.map(zoom => zoom.id) }));
      this._visionEmitUpdate(tabId, onUpdate, { success: true, method: 'image_attach', vision: { kind: 'zoom', imageIds: zooms.map(zoom => zoom.id) } },
        zooms.map(zoom => ({ id: zoom.id, kind: 'zoom', dataUrl: zoom.dataUrl })));
      return { kind: 'zoom' };
    }
    if (!observe) return null;
    const failed = (stage, error) => {
      // The next update is a full frame; until then the model knows the
      // screen it last saw may be out of date.
      session.forceKeyframe = true;
      messages.push(visionUserMessage(`[SCREEN: the screen could not be ${stage === 'observe' ? 'captured' : 'prepared'} after the action (${errorText(error).slice(0, 160)}). Call take_screenshot to look again.]`,
        { epoch: session.epoch, kind: 'error' }));
      this._visionTraceNote(tabId, 'vision_frame_error', { stage, error: errorText(error) });
      return { kind: 'error' };
    };
    // A tab a click of this batch opened late is rerouted into this tab
    // first, so the update shows what the click opened (Chrome only).
    try { await this._visionPlatformLateTab?.(tabId); } catch (error) { if (isControlFlowError(error)) throw error; }
    let frame;
    try {
      frame = await this._visionCaptureSettled(tabId, state);
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      return failed('observe', error);
    }
    try {
      return await this._visionObserveFrame(tabId, messages, onUpdate, { state, session, frame });
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      return failed('encode', error);
    }
  };

  /** The part of _visionObserveAfterBatch after a settled capture. */
  proto._visionObserveFrame = async function _visionObserveFrame(tabId, messages, onUpdate, { state, session, frame }) {
    const meta = {
      cssWidth: frame.probe.cssWidth, cssHeight: frame.probe.cssHeight,
      devicePixelRatio: frame.probe.devicePixelRatio, url: frame.probe.url,
    };
    const sameSize = session.keyframe && session.keyframe.width === frame.size.width && session.keyframe.height === frame.size.height;
    if (session.needsKeyframe(meta) || !sameSize) {
      const urlChanged = session.keyframe && session.keyframe.url !== frame.probe.url;
      await this._visionPushKeyframe(tabId, messages, onUpdate, {
        state, frame, reason: session.forceKeyframe ? 'requested' : (urlChanged ? 'page changed' : (session.keyframe ? 'layout changed' : 'first frame')),
      });
      return { kind: 'keyframe' };
    }
    const d = diffFrames(session.seenPixels, frame.raster.pixels, frame.size.width, frame.size.height);
    const plan = planFrameUpdate(d, {
      width: frame.size.width,
      height: frame.size.height,
      patchChainLength: session.patchChainLength,
      estimateTokens: (w, h) => estimateVisionTokens(w, h, frame.profile),
      align: frame.profile.align,
    });
    if (plan.kind === 'keyframe') {
      await this._visionPushKeyframe(tabId, messages, onUpdate, { state, frame, reason: plan.reason === 'large_change' ? 'large change' : plan.reason.replace(/_/g, ' ') });
      return { kind: 'keyframe', reason: plan.reason };
    }
    const zooms = this._visionTakePendingZooms(tabId);
    if (plan.kind === 'none') {
      session.registerNoChange();
      const note = visionNoChangeNote(session.keyframe);
      if (zooms.length) {
        messages.push(this._visionImageMessage([note, ...zooms.map(zoom => zoom.note)].join('\n'), zooms,
          { epoch: session.epoch, kind: 'zoom', ids: zooms.map(zoom => zoom.id) }));
      } else {
        messages.push(visionUserMessage(note, { epoch: session.epoch, kind: 'none' }));
      }
      this._visionEmitUpdate(tabId, onUpdate, { success: true, method: 'vision_no_change', description: 'No visible change in the viewport.', vision: { kind: 'none', changedRatio: d.changedRatio } });
      this._visionTraceNote(tabId, 'vision_frame', { kind: 'none', keyframe: session.keyframe.id, changedRatio: d.changedRatio });
      await this._visionRecordObservation(tabId, frame.probe.url);
      return { kind: 'none' };
    }
    const encoding = await this._visionEncoding(frame.profile);
    const encodedPatches = [];
    for (const region of plan.regions) {
      const encoded = await this._visionEncodeRegion(frame.raster.canvas, region, { mimeType: encoding.mimeType, quality: encoding.quality });
      encodedPatches.push({ region, encoded });
    }
    const patches = session.registerPatches(plan.regions.map(regionLabel), frame.raster.pixels);
    const note = visionPatchNote(patches, session.keyframe, { coordinates: session.coordinates });
    const images = patches.map((patch, index) => ({ id: patch.id, kind: 'patch', dataUrl: encodedPatches[index].encoded.dataUrl }));
    messages.push(this._visionImageMessage([note, ...zooms.map(zoom => zoom.note)].join('\n'), [...images, ...zooms],
      { epoch: session.epoch, kind: 'patch', ids: [...patches.map(patch => patch.id), ...zooms.map(zoom => zoom.id)] }));
    const bytes = encodedPatches.reduce((sum, item) => sum + item.encoded.bytes, 0);
    this._visionEmitUpdate(tabId, onUpdate, {
      success: true,
      method: 'image_attach',
      description: `Vision patch ${patches.map(patch => patch.id).join(', ')} attached (${Math.round(d.regionAreaRatio * 100)}% of the screen).`,
      vision: { kind: 'patch', imageIds: patches.map(patch => patch.id), keyframe: session.keyframe.id, regions: plan.regions.map(regionLabel), bytes, estimatedTokens: plan.patchTokens, frameTokens: plan.frameTokens },
    }, images);
    this._visionTraceNote(tabId, 'vision_frame', {
      kind: 'patch', ids: patches.map(patch => patch.id), keyframe: session.keyframe.id, regions: plan.regions.map(regionLabel),
      bytes, estimatedTokens: plan.patchTokens, frameTokens: plan.frameTokens, changedRatio: d.changedRatio,
    });
    await this._visionRecordObservation(tabId, frame.probe.url);
    return { kind: 'patch', patches };
  };

  /**
   * Rewrite click_at into the canonical coordinate click and mark which
   * coordinate calls follow an earlier action in the same batch (those are
   * re-checked against the live screen right before dispatch).
   */
  proto._visionTranslateToolCalls = function _visionTranslateToolCalls(tabId, toolCalls) {
    const state = this._visionRunState(tabId);
    if (!state.active || !Array.isArray(toolCalls) || !toolCalls.some(call => VISION_TOOL_NAMES.has(call?.function?.name))) return toolCalls;
    const session = this._visionSessionFor(tabId, state);
    let actedBefore = false;
    // Where the last click_at of this batch landed: type_text / press_keys
    // after it type into the field that click focused.
    let clickedAt = null;
    return toolCalls.map(call => {
      const name = call?.function?.name || '';
      let translated = call;
      // A point is re-checked against the live screen when an earlier action
      // of the batch ran, or when the page changed while the model decided
      // (page feedback notes a response it kept despite that).
      const recheck = actedBefore || (!!call && typeof call === 'object' && this._visionRecheckCalls?.has(call) === true);
      if (VISION_TRANSLATED_TOOLS.has(name) || VISION_NATIVE_TOOLS.has(name)) {
        let args = {};
        try { args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call.function.arguments || {}); }
        catch { args = null; }
        if (args && VISION_TRANSLATED_TOOLS.has(name)) {
          const result = translateVisionClick(args, session);
          translated = result.ok
            ? { ...call, function: { ...call.function, name: result.name, arguments: JSON.stringify(result.args) },
              _vision: { ...result.vision, internalName: result.name, needsStabilityCheck: recheck } }
            : { ...call, _vision: { tool: name, error: result.result } };
          clickedAt = result.ok && result.vision.button === 'left' ? { ...result.vision.cssPoint } : null;
        } else if (args) {
          translated = { ...call, _vision: { tool: name, needsStabilityCheck: recheck } };
        }
      } else if ((name === 'type_text' || name === 'press_keys') && clickedAt) {
        translated = { ...call, _vision: { tool: name, focusFollowUp: { ...clickedAt } } };
      }
      if (!VISION_NO_OBSERVE_TOOLS.has(name) && name !== 'take_screenshot') {
        actedBefore = true;
        if (!['click_at', 'type_text', 'press_keys'].includes(name)) clickedAt = null;
      }
      return translated;
    });
  };

  /**
   * Keyboard input right after a vision click: does the focused element sit
   * at the clicked point and take text? Then the click's own page effects
   * (a composer expanding, a hint appearing) do not call for a fresh
   * observation before typing (page-feedback.js).
   */
  proto._visionFocusFollowsClick = async function _visionFocusFollowsClick(tabId, point) {
    if (!point || !this._visionRunState(tabId).active) return false;
    const probe = await this._visionDomProbe(tabId, { points: [point], focus: true });
    return probe?.focus?.editable === true && probe.focus.matchesPoint === true;
  };

  /** A screen update now (page feedback superseded a decision). */
  proto._visionObserveNow = async function _visionObserveNow(tabId, messages, onUpdate) {
    if (!this._visionRunState(tabId).active) return null;
    return this._visionObserveAfterBatch(tabId, messages, onUpdate, { force: true });
  };

  /**
   * Before a coordinate action that follows another action in the same
   * batch: refuse it when the screen changed near its point.
   */
  proto._visionStabilityBlock = async function _visionStabilityBlock(tabId, cssPoint) {
    const state = this._visionRunState(tabId);
    const session = this._visionSessions?.get(tabId);
    if (!state.active || !session?.keyframe || !session.seenPixels) return null;
    const refuse = reason => ({
      success: false, dispatched: false, noDispatch: true, visionScreenChanged: true,
      error: `Not dispatched: ${reason}. Look at the updated screen WebBrain shows next and choose the point again.`,
    });
    let frame;
    try { frame = await this._visionCaptureFrame(tabId, state); }
    catch (error) {
      if (isControlFlowError(error)) throw error;
      // The point was chosen before the earlier action; without a fresh
      // capture nothing shows it is still right.
      session.forceKeyframe = true;
      return refuse('WebBrain could not re-check the screen around this point');
    }
    if (frame.probe.url !== session.keyframe.url) return refuse('the page navigated since you read this point');
    if (frame.size.width !== session.keyframe.width || frame.size.height !== session.keyframe.height) return refuse('the viewport changed since you read this point');
    const d = diffFrames(session.seenPixels, frame.raster.pixels, frame.size.width, frame.size.height);
    const kfPoint = session.cssToKeyframe(cssPoint.x, cssPoint.y);
    if (d.regionAreaRatio > 0.6 || pointTouchesRegions(kfPoint, d.regions, STABILITY_MARGIN_PX)) {
      return refuse('the screen changed near this point since you read it');
    }
    return null;
  };

  /** Resolve a model point to CSS for a native tool, with batch stability. */
  proto._visionResolveForTool = async function _visionResolveForTool(tabId, point, vision) {
    const state = this._visionRunState(tabId);
    if (!state.active) return { error: { success: false, noDispatch: true, error: 'Vision mode is not active for this run.' } };
    const session = this._visionSessionFor(tabId, state);
    const resolved = session.resolvePoint(point);
    if (!resolved.ok) return { error: { success: false, dispatched: false, noDispatch: true, visionCoordinateError: resolved.code, error: resolved.error } };
    if (vision?.needsStabilityCheck) {
      const blocked = await this._visionStabilityBlock(tabId, { x: resolved.cssX, y: resolved.cssY });
      if (blocked) return { error: blocked };
    }
    return { resolved, session, state };
  };

  /**
   * Execute take_screenshot, zoom, scroll_at, hover_at, drag_at and wait. A
   * failure becomes a tool result (no dispatch, or an unknown outcome once
   * input may have been sent) instead of ending the run.
   */
  proto._executeVisionTool = async function _executeVisionTool(tabId, name, args = {}, context = {}) {
    const dispatch = { started: false };
    try {
      return await this._executeVisionToolInner(tabId, name, args, context, dispatch);
    } catch (error) {
      if (isControlFlowError(error)) throw error;
      this._visionTraceNote(tabId, 'vision_tool_error', { tool: name, error: errorText(error), dispatched: dispatch.started });
      if (dispatch.started) {
        const session = this._visionSessions?.get(tabId);
        if (session) session.forceKeyframe = true;
        return { success: false, outcomeUnknown: true, error: `${name} failed while sending input (${errorText(error)}). Look at the next screen before repeating it.` };
      }
      return { success: false, dispatched: false, noDispatch: true, error: `${name} failed before any input was sent (${errorText(error)}).` };
    }
  };

  proto._executeVisionToolInner = async function _executeVisionToolInner(tabId, name, args, context, dispatch) {
    const vision = context?._vision || null;
    const state = this._visionRunState(tabId);
    if (!state.active) {
      return { success: false, noDispatch: true, error: `${name} is only available in vision mode.` };
    }
    const session = this._visionSessionFor(tabId, state);
    if (name === 'take_screenshot') {
      session.forceKeyframe = true;
      return { success: true, note: 'A fresh full frame follows this result.' };
    }
    if (name === 'wait') {
      const seconds = Math.min(VISION_MAX_WAIT_SECONDS, Math.max(0.2, Number(args.seconds) || 1));
      await sleep(Math.round(seconds * 1000));
      return { success: true, waitedSeconds: seconds };
    }
    if (name === 'zoom') {
      if (!session.keyframe) return { success: false, noDispatch: true, error: 'Take a screenshot before zooming.' };
      const region = session.resolveRegion({ x: args.x, y: args.y, width: args.width, height: args.height, image: args.image });
      if (!region.ok) return { success: false, noDispatch: true, visionCoordinateError: region.code, error: region.error };
      const profile = VISION_PROFILES[state.profileId] || VISION_PROFILES.default;
      const probe = await this._visionPlatformProbe(tabId);
      const plan = planZoomImageSize({ regionWidth: region.cssRegion.width, regionHeight: region.cssRegion.height, devicePixelRatio: probe?.devicePixelRatio || 1, profile });
      let dataUrl = await this._visionPlatformCapture(tabId, { probe, cssRegion: region.cssRegion, outWidth: plan.width, outHeight: plan.height });
      if (!dataUrl) throw new Error('The browser returned no screenshot.');
      if (this.screenshotRedaction && typeof this._redactScreenshotDataUrl === 'function') {
        try {
          // A crop is a page-space box; the redactor maps element rects into it.
          dataUrl = await this._redactScreenshotDataUrl(tabId, dataUrl, {
            coordinateSpace: 'page',
            capturedCssBounds: {
              x: (probe?.scrollX || 0) + region.cssRegion.x,
              y: (probe?.scrollY || 0) + region.cssRegion.y,
              width: region.cssRegion.width,
              height: region.cssRegion.height,
            },
          });
        } catch { /* keep the capture */ }
      }
      const raster = await this._visionRasterize(dataUrl, plan.width, plan.height);
      const encoding = await this._visionEncoding(profile);
      const encoded = await this._visionEncodeRegion(raster.canvas, null, { mimeType: encoding.mimeType, quality: Math.min(0.9, encoding.quality + 0.05) });
      const zoom = session.registerZoom(region.keyframeRegion, plan.width, plan.height);
      session.pendingZooms.push({
        id: zoom.id, kind: 'zoom', dataUrl: encoded.dataUrl,
        note: visionZoomNote(zoom, session.keyframe, region.keyframeRegion, { coordinates: session.coordinates }),
      });
      this._visionTraceNote(tabId, 'vision_frame', { kind: 'zoom', id: zoom.id, region: region.keyframeRegion, width: plan.width, height: plan.height, bytes: encoded.bytes });
      return { success: true, image: zoom.id, width: plan.width, height: plan.height, note: `Zoom ${zoom.id} follows this result.` };
    }
    if (name === 'scroll_at') {
      const direction = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : 'down';
      const steps = Math.min(30, Math.max(1, Number(args.amount) || VISION_DEFAULT_SCROLL_STEPS));
      let point = null;
      if (args.x != null && args.y != null) {
        const resolved = await this._visionResolveForTool(tabId, { x: args.x, y: args.y, image: args.image }, vision);
        if (resolved.error) return resolved.error;
        point = { x: resolved.resolved.cssX, y: resolved.resolved.cssY };
      } else if (session.keyframe) {
        point = { x: session.keyframe.cssWidth / 2, y: session.keyframe.cssHeight / 2 };
      } else {
        const probe = await this._visionPlatformProbe(tabId);
        point = { x: (probe?.cssWidth || 800) / 2, y: (probe?.cssHeight || 600) / 2 };
      }
      // A focused number field under the pointer takes the wheel as +/-.
      const refused = visionWheelRefusal(await this._visionDomProbe(tabId, { points: [point] }));
      if (refused) return { ...refused, at: point };
      const distance = steps * VISION_SCROLL_STEP_CSS_PX;
      const deltaX = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
      const deltaY = direction === 'up' ? -distance : direction === 'down' ? distance : 0;
      dispatch.started = true;
      const result = await this._visionPlatformWheel(tabId, { x: point.x, y: point.y, deltaX, deltaY });
      return { success: result?.success !== false, dispatched: result?.dispatched !== false, direction, amount: steps, at: point, ...(result || {}) };
    }
    if (name === 'hover_at') {
      const resolved = await this._visionResolveForTool(tabId, { x: args.x, y: args.y, image: args.image }, vision);
      if (resolved.error) return resolved.error;
      const point = { x: resolved.resolved.cssX, y: resolved.resolved.cssY };
      dispatch.started = true;
      const result = await this._visionPlatformHover(tabId, point);
      return { success: result?.success !== false, at: point, ...(result || {}) };
    }
    if (name === 'drag_at') {
      const start = await this._visionResolveForTool(tabId, { x: args.start_x, y: args.start_y, image: args.image }, vision);
      if (start.error) return start.error;
      const end = session.resolvePoint({ x: args.end_x, y: args.end_y, image: args.image });
      if (!end.ok) return { success: false, dispatched: false, noDispatch: true, visionCoordinateError: end.code, error: end.error };
      const from = { x: start.resolved.cssX, y: start.resolved.cssY };
      const to = { x: end.cssX, y: end.cssY };
      // A press and release on the same control is a click that no click
      // guard has seen; a frame WebBrain cannot inspect could hide one.
      const longEnough = Math.hypot(to.x - from.x, to.y - from.y) >= VISION_MIN_DRAG_CSS_PX;
      const probe = longEnough ? await this._visionDomProbe(tabId, { points: [from, to], pair: true }) : null;
      const refused = visionDragRefusal(probe, from, to);
      if (refused) return { ...refused, from, to };
      if (await this._visionSubmitAt(tabId, from)) {
        return {
          success: false, dispatched: false, noDispatch: true, visionInputRefused: 'drag_on_submit', from, to,
          error: 'Not dispatched: the drag starts on a control WebBrain reads as a submit, send, delete or payment action, and a drag never gets the confirmation a click gets. Use click_at on it.',
        };
      }
      dispatch.started = true;
      const result = await this._visionPlatformDrag(tabId, { from, to, steps: 12 });
      return { success: result?.success !== false, from, to, ...(result || {}) };
    }
    return { success: false, noDispatch: true, error: `Unknown vision tool ${name}.` };
  };

  /** The vision half of _pruneOldImages. */
  proto._visionPruneImages = function _visionPruneImages(messages) {
    return pruneVisionImages(messages);
  };
}
