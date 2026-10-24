import { runFalGeneration, FAL_AUTH_PROBE_URL } from './fal-media.js';
import { MAX_JOINED_VIDEO_BYTES, storeGeneratedMedia, storeGeneratedMediaBlob } from '../generated-media-store.js';
import { IMAGE_GEN_MODEL_KEY, MEDIA_PROVIDERS, mediaProvider, normalizeMediaModel, comfyBaseUrl, parseMediaJson, validateMediaConfig, bindMediaPrompt } from './media-config.js';
import { VideoJoinError, joinMp4Clips, mp4DurationSeconds } from './video-join.js';

const GENERATION_TIMEOUT_MS = 600000;
const MAX_INLINE_BYTES = 20 * 1024 * 1024;
// A video made of scenes: at most two minutes, one clip per scene or several
// when a scene is longer than the model's longest clip.
export const MAX_VIDEO_SECONDS = 120;
export const MAX_VIDEO_CLIPS = 24;
const VIDEO_CLIP_CONCURRENCY = 3;
const VIDEO_ARGUMENTS = ['duration', 'aspect_ratio', 'resolution', 'scenes', 'estimated_duration'];
const INLINE_MEDIA = /^data:(image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|wav|ogg)|video\/mp4);base64,[A-Za-z0-9+/=\s]+$/;

export function safeMediaUrl(value) {
  if (typeof value !== 'string') return '';
  if (value.length <= MAX_INLINE_BYTES * 1.4 && INLINE_MEDIA.test(value)) return value;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}

function base64Media(bytes, mime) {
  if (!bytes || bytes.length > MAX_INLINE_BYTES * 1.4 || !/^[A-Za-z0-9+/=\s]+$/.test(bytes)) return '';
  return safeMediaUrl(`data:${mime || 'image/png'};base64,${bytes}`);
}

// Known media fields only: never mistake an API/status URL for the generated asset.
export function extractMediaUrl(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 8) return '';
  if (Array.isArray(payload)) {
    for (const item of payload) { const url = safeMediaUrl(item) || extractMediaUrl(item, depth + 1); if (url) return url; }
    return '';
  }
  if (payload.b64_json) { const url = base64Media(payload.b64_json, payload.media_type); if (url) return url; }
  if (payload.inlineData || payload.inline_data) {
    const data = payload.inlineData || payload.inline_data;
    const url = base64Media(data.data, data.mimeType || data.mime_type); if (url) return url;
  }
  // Native Comfy Router outputs (e.g. Luma) include preview assets too.
  // Prefer the final video/audio over its image; progress_video is not a result.
  for (const key of ['video', 'audio', 'image']) {
    const asset = payload.assets?.[key];
    const url = safeMediaUrl(asset) || extractMediaUrl(asset, depth + 1); if (url) return url;
  }
  for (const key of ['url', 'sample', 'image_url', 'video_url', 'audio_url']) {
    const url = safeMediaUrl(payload[key]) || extractMediaUrl(payload[key], depth + 1); if (url) return url;
  }
  for (const key of ['data', 'result', 'output', 'images', 'image', 'videos', 'video', 'audio', 'candidates', 'content', 'parts']) {
    const url = safeMediaUrl(payload[key]) || extractMediaUrl(payload[key], depth + 1); if (url) return url;
  }
  return '';
}

function operationSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason || new DOMException('Generation cancelled.', 'AbortError'));
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Generative media timed out.', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, dispose() { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

function delay(ms, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function jsonResponse(response, label) {
  if (!response.ok) {
    let message = '';
    try { message = (await response.text()).slice(0, 300); } catch { /* no body */ }
    throw new Error(`${label} failed (HTTP ${response.status})${message ? ': ' + message : '.'}`);
  }
  const body = await response.json();
  if (body?.error || body?.error_type) throw new Error(`${label}: ${body.error?.message || body.error_type || body.error}`);
  return body;
}

function pollDelay(response, fallback) {
  const seconds = Number(response.headers?.get?.('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 60000) : fallback;
}

async function cancelRequest(url, init, fetchImpl) {
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try { await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error', credentials: 'omit' }); } catch { /* best effort */ }
  finally { clearTimeout(timer); }
}

async function mediaResponse(response, label) {
  const mime = (response.headers?.get?.('Content-Type') || '').split(';')[0].trim();
  if (response.ok && /^(image\/(?:png|jpeg|webp|gif)|audio\/(?:mpeg|wav|ogg)|video\/mp4)$/.test(mime)) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_INLINE_BYTES) throw new Error('Generated media exceeds the 20 MB inline limit. Choose a model that returns hosted media.');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return `data:${mime};base64,${btoa(binary)}`;
  }
  const payload = await jsonResponse(response, label);
  const url = extractMediaUrl(payload);
  if (!url) throw new Error(`${label} returned no supported media URL or inline media.`);
  return url;
}

// The catalog entry lists what a video model accepts (supported_durations,
// supported_resolutions, supported_aspect_ratios).
async function openRouterMediaModel(model, headers, request) {
  for (const kind of ['images', 'videos']) {
    const catalog = await jsonResponse(await request(`https://openrouter.ai/api/v1/${kind}/models`, { headers }), `OpenRouter ${kind} models`);
    const entry = Array.isArray(catalog.data) ? catalog.data.find(item => item?.id === model) : null;
    if (entry) return { kind, entry };
  }
  throw new Error('The selected OpenRouter model is not in the image or video generation catalog.');
}

async function openRouterMediaType(model, headers, request) {
  return (await openRouterMediaModel(model, headers, request)).kind;
}

function formatSeconds(seconds) {
  const whole = Math.round(seconds);
  return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function videoArguments(args) {
  const video = {};
  for (const key of VIDEO_ARGUMENTS) if (args?.[key] !== undefined) video[key] = args[key];
  return Object.keys(video).length ? video : null;
}

function supportedValues(entry, key) {
  const values = entry?.[key];
  return Array.isArray(values) && values.length ? values : null;
}

function clipDurations(entry) {
  const values = supportedValues(entry, 'supported_durations');
  if (!values) return null;
  const durations = [...new Set(values.map(Number).filter(value => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  return durations.length ? durations : null;
}

// aspect_ratio and resolution, checked against the model's catalog entry so an
// unsupported value fails before a paid submission.
function videoShape(entry, video) {
  const shape = {};
  for (const [name, key] of [['aspect_ratio', 'supported_aspect_ratios'], ['resolution', 'supported_resolutions']]) {
    if (video?.[name] === undefined) continue;
    const supported = supportedValues(entry, key);
    if (supported && !supported.some(value => String(value) === String(video[name]))) {
      throw new Error(`This video model does not support ${name} "${video[name]}". Supported: ${supported.join(', ')}.`);
    }
    shape[name] = String(video[name]);
  }
  return shape;
}

/**
 * The clips for a video described as scenes. A scene longer than the model's
 * longest clip becomes several clips, and every clip length rounds up to one
 * the model offers. Refuses more than `maxSeconds` in total or `maxClips`.
 */
export function planVideoClips(scenes, durations, { maxSeconds = MAX_VIDEO_SECONDS, maxClips = MAX_VIDEO_CLIPS } = {}) {
  if (!durations?.length) {
    throw new Error('This video model does not list the clip lengths it supports, so WebBrain cannot make a video from scenes with it. Generate one clip instead.');
  }
  const longest = durations[durations.length - 1];
  const clips = [];
  scenes.forEach((scene, index) => {
    const prompt = String(scene?.prompt || '').trim();
    if (!prompt) throw new Error(`Scene ${index + 1} needs a prompt.`);
    const parts = Math.ceil(scene.duration / longest);
    const each = Math.ceil(scene.duration / parts);
    for (let part = 1; part <= parts; part++) {
      clips.push({
        prompt: parts > 1 ? `${prompt} (part ${part} of ${parts})` : prompt,
        duration: durations.find(value => value >= each) ?? longest,
      });
    }
  });
  const total = clips.reduce((sum, clip) => sum + clip.duration, 0);
  if (clips.length > maxClips) {
    throw new Error(`These scenes need ${clips.length} clips and WebBrain makes at most ${maxClips}. Use fewer, longer scenes.`);
  }
  if (total > maxSeconds) {
    throw new Error(`These scenes come to ${total} s with this model's clip lengths (${durations.join(', ')} s), and WebBrain makes videos up to ${maxSeconds} s. Shorten or merge scenes.`);
  }
  return { clips, total };
}

// What one generate_image call asks a video model for: one clip, or the
// clips of its scenes.
function planVideo(prompt, video, entry) {
  const durations = clipDurations(entry);
  const shape = videoShape(entry, video);
  const scenes = Array.isArray(video?.scenes) ? video.scenes : null;
  if (scenes?.length) {
    if (video.duration !== undefined) throw new Error('With scenes, give each scene its duration instead of duration.');
    if (video.estimated_duration === undefined) {
      throw new Error('With scenes, give estimated_duration: how many seconds the requested video needs before fitting it to the 120 s maximum.');
    }
    const { clips, total } = planVideoClips(scenes, durations);
    return {
      scenes: true,
      total,
      estimated: video.estimated_duration,
      shape,
      // Every clip carries the shared look so the scenes match.
      clips: clips.map((clip, index) => ({ ...clip, prompt: `${prompt}\n\nScene ${index + 1} of ${clips.length}: ${clip.prompt}` })),
    };
  }
  const longest = durations?.[durations.length - 1];
  const wanted = video?.duration ?? video?.estimated_duration;
  if (wanted !== undefined && longest && wanted > longest) {
    throw new Error(`A ${formatSeconds(wanted)} video needs more than one clip: this model makes clips of up to ${longest} s. Describe it as scenes of up to ${longest} s each, ${MAX_VIDEO_SECONDS} s in total, with estimated_duration.`);
  }
  let duration;
  if (video?.duration !== undefined) {
    if (durations && !durations.includes(video.duration)) {
      throw new Error(`This video model does not make ${video.duration} s clips. Supported: ${durations.join(', ')} s.`);
    }
    duration = video.duration;
  } else if (wanted !== undefined && durations) {
    duration = durations.find(value => value >= wanted) ?? longest;
  }
  return { scenes: false, shape, clips: [{ prompt, ...(duration !== undefined ? { duration } : {}) }] };
}

function videoRequestBody(model, clip, shape) {
  return { model, prompt: clip.prompt, ...(clip.duration !== undefined ? { duration: clip.duration } : {}), ...shape };
}

// Submits one OpenRouter video job, polls it and returns the content response.
async function openRouterVideoJob({ base, headers, request, signal, pollMs, body }) {
  const res = await request(base, { method: 'POST', headers, body: JSON.stringify(body) });
  const queued = await jsonResponse(res, 'OpenRouter video submit');
  if (!/^[A-Za-z0-9_-]+$/.test(queued.id || '')) throw new Error('OpenRouter returned an invalid video job ID.');
  // Construct authenticated paths ourselves; returned URLs cannot select a key recipient.
  const jobUrl = `${base}/${queued.id}`;
  let waitMs = pollDelay(res, pollMs);
  while (true) {
    await delay(waitMs, signal);
    const statusRes = await request(jobUrl, { headers });
    const status = await jsonResponse(statusRes, 'OpenRouter video status');
    waitMs = pollDelay(statusRes, pollMs);
    if (status.status === 'completed') return request(`${jobUrl}/content?index=0`, { headers });
    if (!['pending', 'in_progress'].includes(status.status)) throw new Error(`OpenRouter video generation ${status.status || 'returned an unknown status'}.`);
  }
}

function dataUrlBytes(url) {
  const match = /^data:([^;]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url || '');
  if (!match) return null;
  const binary = atob(match[2].replace(/\s+/g, ''));
  return { bytes: Uint8Array.from(binary, char => char.charCodeAt(0)), mime: match[1] };
}

// A clip that will be joined is kept as bytes, not as a data URL.
async function videoBytes(response, label) {
  const mime = (response.headers?.get?.('Content-Type') || '').split(';')[0].trim();
  if (response.ok && mime === 'video/mp4') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_INLINE_BYTES) throw new Error('A generated clip exceeds the 20 MB inline limit.');
    return bytes;
  }
  const decoded = dataUrlBytes(await mediaResponse(response, label));
  if (decoded?.mime !== 'video/mp4') throw new Error(`${label} did not return an MP4 video.`);
  return decoded.bytes;
}

// Runs `task` for each item, `limit` at a time. The first failure stops the
// others; Stop aborts them all with its own reason.
async function mapWithConcurrency(items, limit, signal, task) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !controller.signal.aborted) {
      const index = next++;
      try { results[index] = await task(items[index], index, controller.signal); }
      catch (error) {
        if (!controller.signal.aborted) controller.abort(error);
        throw signal?.aborted ? signal.reason : error;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    controller.signal.throwIfAborted();
    return results;
  } finally { signal?.removeEventListener('abort', onAbort); }
}

async function runOpenRouter({ text, model, config, video, fetchImpl, signal, timeoutMs, pollMs, onProgress, confirmVideoLength }) {
  const headers = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
  // One bounded operation: its own deadline, aborted by Stop as well.
  const bounded = async (parent, task) => {
    const operation = operationSignal(parent, timeoutMs);
    const request = (url, init = {}) => {
      operation.signal.throwIfAborted();
      return fetchImpl(url, { ...init, signal: operation.signal, redirect: 'error', credentials: 'omit' });
    };
    try { return await task(request, operation.signal); }
    catch (error) { throw operation.signal.aborted ? operation.signal.reason : error; }
    finally { operation.dispose(); }
  };
  const base = 'https://openrouter.ai/api/v1/videos';
  let plan = null;
  const single = await bounded(signal, async (request, jobSignal) => {
    const { kind, entry } = await openRouterMediaModel(model, headers, request);
    if (kind === 'images') {
      if (video) throw new Error('Video length, aspect ratio, resolution and scenes need a video model; the selected OpenRouter model makes images.');
      const res = await request('https://openrouter.ai/api/v1/images', { method: 'POST', headers, body: JSON.stringify({ model, prompt: text }) });
      return { url: await mediaResponse(res, 'OpenRouter generation'), model };
    }
    plan = planVideo(text, video, entry);
    if (plan.scenes) return null;
    const res = await openRouterVideoJob({ base, headers, request, signal: jobSignal, pollMs, body: videoRequestBody(model, plan.clips[0], plan.shape) });
    return { url: await mediaResponse(res, 'OpenRouter video download'), model };
  });
  if (single) return single;

  // A video longer than WebBrain makes: the user decides on its card whether a
  // shorter version is worth generating, before anything is submitted. The
  // card is outside the generation deadline.
  const lengthDetails = { estimatedSeconds: plan.estimated, totalSeconds: plan.total, clipCount: plan.clips.length, maxSeconds: MAX_VIDEO_SECONDS };
  if (plan.estimated > MAX_VIDEO_SECONDS) {
    const answer = typeof confirmVideoLength === 'function' ? await confirmVideoLength(lengthDetails) : 'unavailable';
    signal?.throwIfAborted?.();
    if (answer !== 'once') return { declined: true, answer: answer || 'cancelled', model, ...lengthDetails };
  }
  onProgress?.(`Generating ${plan.clips.length} video clips…`);
  let ready = 0;
  const clips = await mapWithConcurrency(plan.clips, VIDEO_CLIP_CONCURRENCY, signal, async (clip, index, groupSignal) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const bytes = await bounded(groupSignal, async (request, jobSignal) => videoBytes(
          await openRouterVideoJob({ base, headers, request, signal: jobSignal, pollMs, body: videoRequestBody(model, clip, plan.shape) }),
          'OpenRouter video download'));
        ready += 1;
        onProgress?.(`Video clips: ${ready} of ${plan.clips.length} ready`);
        return bytes;
      } catch (error) {
        // One retry per clip; a second failure, Stop or another clip's failure ends the video.
        if (groupSignal.aborted || attempt >= 2) {
          throw groupSignal.aborted ? (groupSignal.reason ?? error) : new Error(`Clip ${index + 1} of ${plan.clips.length} failed: ${error.message}`);
        }
      }
    }
  });
  return { clips, model, ...lengthDetails };
}

export async function runMediaGeneration({ prompt, config, video = null, fetchImpl = fetch, signal, timeoutMs = GENERATION_TIMEOUT_MS, pollIntervalMs, onProgress, confirmVideoLength }) {
  const provider = validateMediaConfig(config);
  const text = String(prompt || '').trim();
  if (!text) throw new Error('prompt is required.');
  if (video && provider !== 'openrouter') {
    throw new Error(`Video length, aspect ratio, resolution and scenes work with OpenRouter video models. Omit them to use the ${MEDIA_PROVIDERS[provider].label} default.`);
  }
  if (provider === 'fal') return runFalGeneration({ prompt: text, config, fetchImpl, signal, timeoutMs });
  const pollMs = pollIntervalMs ?? (provider === 'openrouter' ? 30000 : 2000);
  const model = provider === 'comfyui' ? 'ComfyUI workflow' : normalizeMediaModel(config.model);
  if (provider === 'openrouter') {
    return runOpenRouter({ text, model, config, video, fetchImpl, signal, timeoutMs, pollMs, onProgress, confirmVideoLength });
  }
  const operation = operationSignal(signal, timeoutMs);
  const request = (url, init = {}) => {
    operation.signal.throwIfAborted();
    return fetchImpl(url, { ...init, signal: operation.signal, redirect: 'error', credentials: 'omit' });
  };
  let cancelUrl = '', cancelInit;
  let completed = false;
  try {
    if (provider === 'comfyrouter') {
      const base = `https://api.comfy.org/v2/models/${model}/requests`;
      const headers = { 'X-API-Key': config.apiKey, 'Content-Type': 'application/json' };
      const parameters = parseMediaJson(config.parameters || '{}', 'Model input');
      const usesTemplate = JSON.stringify(parameters).includes('{{prompt}}');
      const body = usesTemplate ? bindMediaPrompt(parameters, text) : { ...parameters, prompt: text };
      const queued = await jsonResponse(await request(base, {
        method: 'POST', headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(body),
      }), 'Comfy Router submit');
      if (!/^[A-Za-z0-9_-]+$/.test(queued.request_id || '')) throw new Error('Comfy Router returned an invalid request ID.');
      // Build authenticated URLs ourselves; never send the key to returned URLs.
      const resultUrl = `${base}/${queued.request_id}`;
      cancelUrl = `${resultUrl}/cancel`; cancelInit = { method: 'PUT', headers };
      let waitMs = pollMs;
      while (true) {
        await delay(waitMs, operation.signal);
        const res = await request(`${resultUrl}/status`, { headers });
        const status = await jsonResponse(res, 'Comfy Router status');
        waitMs = pollDelay(res, pollMs);
        if (status.status === 'COMPLETED') {
          const result = await request(resultUrl, { headers });
          if (result.status === 202) { waitMs = pollDelay(result, pollMs); continue; }
          const url = await mediaResponse(result, 'Comfy Router generation');
          completed = true;
          return { url, model };
        }
        if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw new Error('Comfy Router returned an unknown queue status.');
      }
    }
    const base = comfyBaseUrl(config.baseUrl);
    const headers = { 'Content-Type': 'application/json' };
    const workflow = bindMediaPrompt(parseMediaJson(config.workflow, 'ComfyUI workflow'), text);
    const queued = await jsonResponse(await request(`${base}/prompt`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
    }), 'ComfyUI submit');
    if (!/^[A-Za-z0-9_-]+$/.test(queued.prompt_id || '')) throw new Error('ComfyUI returned an invalid prompt ID.');
    // Delete this queued prompt only. /interrupt could stop someone else's running workflow.
    cancelUrl = `${base}/queue`; cancelInit = { method: 'POST', headers, body: JSON.stringify({ delete: [queued.prompt_id] }) };
    while (true) {
      await delay(pollMs, operation.signal);
      const history = await jsonResponse(await request(`${base}/history/${queued.prompt_id}`), 'ComfyUI history');
      const item = history[queued.prompt_id];
      if (!item) continue;
      if (item.status?.status_str === 'error') throw new Error('ComfyUI workflow failed. Check the workflow, installed nodes, and local models.');
      for (const output of Object.values(item.outputs || {})) {
        for (const key of ['images', 'gifs', 'videos', 'audio']) for (const file of output[key] || []) {
          if (typeof file.filename !== 'string' || !file.filename || file.type === 'temp') continue;
          const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
          completed = true;
          return { url: `${base}/view?${params}`, model };
        }
      }
      if (item.status?.completed || item.status?.status_str === 'success') throw new Error('ComfyUI workflow completed without saved media. Add a Save Image or media output node.');
    }
  } catch (error) {
    if (!completed && cancelUrl) await cancelRequest(cancelUrl, cancelInit, fetchImpl);
    throw operation.signal.aborted ? operation.signal.reason : error;
  } finally { operation.dispose(); }
}

export async function readMediaConfig() {
  const api = typeof browser !== 'undefined' && browser?.storage ? browser : globalThis.chrome;
  const stored = await api.storage.local.get([IMAGE_GEN_MODEL_KEY]);
  return stored?.[IMAGE_GEN_MODEL_KEY];
}

const roundSeconds = seconds => (Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) / 10 : undefined);

function declinedVideoMessage({ answer, estimatedSeconds, totalSeconds }) {
  const length = `The video needs about ${formatSeconds(estimatedSeconds)}, and WebBrain makes videos up to ${formatSeconds(MAX_VIDEO_SECONDS)}`;
  if (answer === 'deny') return `${length}. The user chose not to generate the ${formatSeconds(totalSeconds)} version, so nothing was generated. Ask what they would like instead.`;
  if (answer === 'unavailable') return `${length}. This run could not ask the user whether a ${formatSeconds(totalSeconds)} version is wanted, so nothing was generated. Tell the user.`;
  return `${length}. The question about a ${formatSeconds(totalSeconds)} version was withdrawn before an answer, so nothing was generated.`;
}

// Joins a video's clips into one stored asset. Clips that cannot be joined
// losslessly are stored one by one and shown in order, and the result says why
// (joinError) so a trace shows it.
async function storeVideoClips(clips, onProgress) {
  let joinError;
  if (clips.length > 1) {
    try {
      onProgress?.(`Joining ${clips.length} clips…`);
      const joined = joinMp4Clips(clips, { maxBytes: MAX_JOINED_VIDEO_BYTES });
      const asset = await storeGeneratedMediaBlob(new Blob([joined.bytes], { type: 'video/mp4' }), { maxBytes: MAX_JOINED_VIDEO_BYTES });
      return { ...asset, durationSeconds: roundSeconds(joined.durationSeconds), clipCount: clips.length };
    } catch (error) {
      if (!(error instanceof VideoJoinError)) throw error;
      joinError = error.message;
    }
  }
  const stored = [];
  for (const bytes of clips) {
    const asset = await storeGeneratedMediaBlob(new Blob([bytes], { type: 'video/mp4' }));
    stored.push({ mediaId: asset.mediaId, mimeType: asset.mimeType, durationSeconds: roundSeconds(mp4DurationSeconds(bytes)) });
  }
  const durationSeconds = roundSeconds(stored.reduce((sum, clip) => sum + (clip.durationSeconds || 0), 0));
  if (stored.length === 1) return { ...stored[0], inlineMedia: true, durationSeconds, clipCount: 1 };
  return { inlineMedia: true, mimeType: 'video/mp4', clips: stored, clipCount: stored.length, durationSeconds, joined: false, joinError };
}

/**
 * The generate_image tool. `options.onProgress(message)` reports progress of
 * a video made of scenes, and `options.confirmVideoLength(details)` asks the
 * user when the requested video is longer than WebBrain makes ('once' to go
 * ahead; 'deny', 'unavailable' or null otherwise).
 */
export async function generateImage(args, options = {}) {
  const fetchImpl = typeof options === 'function' ? options : options.fetchImpl || fetch;
  try {
    const config = Object.hasOwn(options, 'config') ? options.config : await readMediaConfig();
    if (!config) throw new Error('Configure Generative Media in Providers → Generative.');
    const provider = mediaProvider(config);
    const result = await runMediaGeneration({
      prompt: args?.prompt, video: videoArguments(args), config, fetchImpl, signal: options.signal,
      onProgress: options.onProgress, confirmVideoLength: options.confirmVideoLength,
    });
    if (result.declined) {
      return { success: false, declined: true, provider, model: result.model, error: declinedVideoMessage(result) };
    }
    if (Array.isArray(result.clips)) {
      return { success: true, model: result.model, provider, ...(await storeVideoClips(result.clips, options.onProgress)) };
    }
    if (result.url.startsWith('data:')) {
      const asset = await storeGeneratedMedia(result.url);
      // A clip's real length, so the agent can say how long the video is.
      const video = asset.mimeType === 'video/mp4' ? dataUrlBytes(result.url) : null;
      const durationSeconds = video ? roundSeconds(mp4DurationSeconds(video.bytes)) : undefined;
      return { success: true, model: result.model, provider, ...asset, ...(durationSeconds ? { durationSeconds } : {}) };
    }
    return { success: true, ...result, provider };
  } catch (error) { return { success: false, error: error.message }; }
}

// Free read-only probes. Model metadata confirms availability; no generation is submitted.
export async function testImageGenProvider(fetchImpl = fetch) {
  const operation = operationSignal(null, 15000);
  try {
    const config = await readMediaConfig();
    const provider = validateMediaConfig(config);
    const model = provider === 'comfyui' ? 'ComfyUI workflow' : normalizeMediaModel(config.model);
    let url, headers;
    if (provider === 'fal') { url = FAL_AUTH_PROBE_URL; headers = { Authorization: `Key ${config.apiKey}` }; }
    if (provider === 'openrouter') { url = 'https://openrouter.ai/api/v1/key'; headers = { Authorization: `Bearer ${config.apiKey}` }; }
    if (provider === 'comfyrouter') { url = `https://api.comfy.org/v2/models/${model}`; headers = { 'X-API-Key': config.apiKey }; }
    if (provider === 'comfyui') { url = `${comfyBaseUrl(config.baseUrl)}/system_stats`; headers = {}; }
    const res = await fetchImpl(url, { headers, signal: operation.signal, redirect: 'error', credentials: 'omit' });
    if (!res.ok) throw new Error(`${MEDIA_PROVIDERS[provider].label} connection failed (HTTP ${res.status}).`);
    if (provider === 'openrouter') {
      await jsonResponse(res, 'OpenRouter key');
      await openRouterMediaType(model, headers, (url, init) => fetchImpl(url, { ...init, signal: operation.signal, redirect: 'error', credentials: 'omit' }));
    } else if (provider === 'comfyui') {
      const stats = await jsonResponse(res, 'ComfyUI');
      if (!stats.system || !Array.isArray(stats.devices)) throw new Error('The endpoint did not return ComfyUI system information.');
    } else if (provider === 'comfyrouter') {
      const detail = await jsonResponse(res, 'Comfy Router model');
      if (detail.id !== model) throw new Error('Comfy Router did not confirm the selected model.');
    }
    return { ok: true, model, provider };
  } catch (error) { return { ok: false, error: error.message }; }
  finally { operation.dispose(); }
}
