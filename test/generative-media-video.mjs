import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { makeSchedulerHarness } from './lib/scheduler-harness.mjs';

// Videos longer than one clip: generate_image fits scenes to the model's clip
// lengths, generates the clips, and joins them into one MP4 without
// re-encoding. Over two minutes it asks the user first (video-length-cap).

const area = { get: async () => ({}), set: async () => {}, remove: async () => {} };
globalThis.chrome = globalThis.browser = { storage: { local: area, session: area }, runtime: { getURL: x => x, sendMessage: async () => ({}) } };

// The generated media store's IndexedDB calls, kept in memory: Node has no
// IndexedDB. Other databases never open.
const assets = new Map();
globalThis.indexedDB = {
  open(name) {
    const request = {};
    if (name !== 'webbrain_generated_media') return request;
    request.result = {
      close() {},
      transaction() {
        const transaction = {
          objectStore: () => ({
            put(record) { assets.set(record.id, record); setTimeout(() => transaction.oncomplete?.()); },
            get(id) { const read = {}; setTimeout(() => { read.result = assets.get(id); read.onsuccess?.(); }); return read; },
          }),
        };
        return transaction;
      },
    };
    setTimeout(() => request.onsuccess?.());
    return request;
  },
};
const storedBytes = async mediaId => new Uint8Array(await assets.get(mediaId).blob.arrayBuffer());

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
// The mock jobs ask to be polled again at once.
const soon = { 'Retry-After': '0.001' };
const fixtures = Object.fromEntries(await Promise.all([
  'h264-aac-1', 'h264-aac-2', 'h264-aac-48px', 'h264-aac-fragmented-1', 'h264-aac-fragmented-2', 'vp9-opus-1', 'vp9-opus-2',
].map(async name => [name, new Uint8Array(await fs.readFile(new URL(`./fixtures/video/${name}.mp4`, import.meta.url)))])));
const { createFile, MP4BoxBuffer } = await import('../src/chrome/vendor/mp4box/mp4box.all.mjs');

function parse(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const file = createFile();
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buffer, 0));
  file.flush();
  return file;
}

const sampleBytes = (bytes, trak) => trak.samples.map(sample => bytes.subarray(sample.offset, sample.offset + sample.size));
const boxBytes = (bytes, box) => bytes.subarray(box.start, box.start + box.size);

const videoOf = file => file.moov.traks[0];

// A fixture with some of its bytes rewritten: `edit(view, file)` gets a view of
// the copy and the parsed original.
function patched(name, edit) {
  const copy = fixtures[name].slice();
  edit(new DataView(copy.buffer), parse(fixtures[name]));
  return copy;
}

// A fragmented clip whose fragments start later: each track's decode times
// moved by `seconds` ({ vide, soun }).
function laterFragments(bytes, seconds) {
  const file = parse(bytes);
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  const traks = new Map(file.moov.traks.map(trak => [trak.tkhd.track_id, trak]));
  for (const traf of file.moofs.flatMap(moof => moof.trafs)) {
    const trak = traks.get(traf.tfhd.track_id);
    const add = Math.round((seconds[trak.mdia.hdlr.handler] || 0) * trak.mdia.mdhd.timescale);
    if (traf.tfdt.version === 1) view.setBigUint64(traf.tfdt.start + 12, BigInt(traf.tfdt.baseMediaDecodeTime + add));
    else view.setUint32(traf.tfdt.start + 12, traf.tfdt.baseMediaDecodeTime + add);
  }
  return copy;
}

// Where a track's samples are shown on the movie's timeline, in seconds: its
// edit names the first media time shown.
function shown(file, trak) {
  const timescale = trak.mdia.mdhd.timescale;
  const start = trak.edts?.elst?.entries?.[0]?.media_time ?? 0;
  return {
    from: (Math.min(...trak.samples.map(sample => sample.cts)) - start) / timescale,
    to: (Math.max(...trak.samples.map(sample => sample.cts + sample.duration)) - start) / timescale,
    movie: file.moov.mvhd.duration / file.moov.mvhd.timescale,
  };
}

// OpenRouter's video API: a catalog entry, jobs that complete on the first
// poll, and clip bytes chosen per job.
function videoApi({ entry, clip = () => fixtures['h264-aac-1'], fail = () => false }) {
  const calls = { submits: [], inFlight: 0, maxInFlight: 0 };
  const jobs = new Map();
  const fetchImpl = async (url, init = {}) => {
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/images/models')) return json({ data: [] });
    if (url.endsWith('/videos/models')) return json({ data: [entry] });
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      const index = calls.submits.push(body) - 1;
      if (fail(index, body)) return json({ error: { message: 'Provider overloaded' } }, 503);
      const id = `job-${index}`;
      jobs.set(id, { body, index });
      calls.inFlight += 1;
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      return json({ id }, 202, soon);
    }
    const match = /\/videos\/(job-\d+)(\/content)?/.exec(url);
    assert.ok(match, url);
    if (!match[2]) return json({ status: 'completed' }, 200, soon);
    await new Promise(done => setTimeout(done, 5));
    calls.inFlight -= 1;
    return new Response(clip(jobs.get(match[1])), { headers: { 'Content-Type': 'video/mp4' } });
  };
  return { fetchImpl, calls };
}

const grok = { id: 'x-ai/grok-imagine-video-1.5-lite', supported_durations: Array.from({ length: 15 }, (_, i) => i + 1),
  supported_resolutions: ['480p', '720p', '1080p'], supported_aspect_ratios: ['16:9', '9:16', '1:1'] };
const config = { provider: 'openrouter', apiKey: 'or-key', model: grok.id };
// The agent's chat provider, one object so clarification authority matches.
const chatProvider = { name: 'owned', model: 'owned', config: {} };
const scenes = (count, duration) => Array.from({ length: count }, (_, i) => ({ prompt: `Scene idea ${i + 1}`, duration }));
// A card that is still waiting fails the assertion instead of hanging the suite.
const settled = promise => Promise.race([promise, new Promise(done => setTimeout(() => done('still waiting'), 1000))]);

const root = resolve('.');
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/__media.html') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><meta charset="utf-8"><div id="chat"></div>');
      return;
    }
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(root + sep)) throw new Error('outside root');
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.mp4': 'video/mp4' })[extname(file)] || 'text/plain');
    res.end(await fs.readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
let browser, origin;
before(async () => {
  browser = await chromium.launch({ headless: true });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await browser?.close();
  await new Promise(done => server.close(done));
});

for (const build of ['chrome', 'firefox']) {
  const join = await import(`../src/${build}/src/agent/video-join.js`);
  const media = await import(`../src/${build}/src/agent/generative-media.js`);
  const journal = await import(`../src/${build}/src/run-ui-journal.js`);
  const { Agent } = await import(`../src/${build}/src/agent/agent.js`);
  const Scheduler = await import(`../src/${build}/src/agent/scheduler.js`);
  // generate_image as the agent calls it, with the selected OpenRouter model.
  const generate = (args, options) => media.generateImage(args, { config, ...options });

  test(`${build}: clips with one codec setup join into one MP4 without re-encoding`, () => {
    const sources = [fixtures['h264-aac-1'], fixtures['h264-aac-2']];
    const { bytes, durationSeconds } = join.joinMp4Clips(sources);
    assert.equal(durationSeconds, 2);
    assert.equal(join.mp4DurationSeconds(bytes), 2);
    const output = parse(bytes);
    assert.deepEqual(output.boxes.map(box => box.type), ['ftyp', 'moov', 'mdat'], 'moov comes before mdat');
    const [video, audio] = output.moov.traks;
    assert.equal(video.mdia.hdlr.handler, 'vide');
    assert.equal(audio.mdia.hdlr.handler, 'soun');
    // Every video frame is the source's frame, byte for byte, in order.
    const sourceFrames = sources.flatMap(source => sampleBytes(source, parse(source).moov.traks[0]));
    const joinedFrames = sampleBytes(bytes, video);
    assert.equal(joinedFrames.length, 24);
    joinedFrames.forEach((frame, index) => assert.deepEqual(frame, sourceFrames[index], `frame ${index}`));
    // The second clip's frames are shown right after the first clip's, and the
    // movie runs from its first picture to its declared length.
    const times = video.samples.map(sample => sample.cts - video.edts.elst.entries[0].media_time).sort((a, b) => a - b);
    assert.deepEqual(times.map(value => value / 1024), Array.from({ length: 24 }, (_, i) => i));
    assert.deepEqual(shown(output, video), { from: 0, to: 2, movie: 2 });
    assert.equal(shown(output, audio).to, 2);
    // Audio: the first clip's frames are all kept; the second clip's start-up
    // frame is dropped, the rest is copied as is, and its first real frame
    // plays exactly one second in, with its picture.
    const [firstAudio, secondAudio] = sources.map(source => sampleBytes(source, parse(source).moov.traks[1]));
    assert.deepEqual(sampleBytes(bytes, audio).slice(0, 17), firstAudio);
    assert.deepEqual(sampleBytes(bytes, audio).slice(17), secondAudio.slice(1));
    assert.equal(audio.samples[17].cts - audio.edts.elst.entries[0].media_time, 16000);
    // AAC's pre-roll for seeking (a 'roll' sample group) covers every frame.
    const sourceRoll = parse(sources[0]).moov.traks[1].mdia.minf.stbl.sgpds[0];
    assert.deepEqual(boxBytes(bytes, audio.mdia.minf.stbl.sgpds[0]), boxBytes(sources[0], sourceRoll));
    assert.deepEqual(audio.mdia.minf.stbl.sbgps.map(sbgp => sbgp.entries), [[{ sample_count: 33, group_description_index: 1 }]]);
  });

  test(`${build}: fragmented and VP9/Opus clips join too`, () => {
    // [clips, codecs, audio frames kept from the first clip, start-up frames dropped
    //  from the second, how far into its first kept frame the second clip's sound
    //  starts, the audio's pre-roll groups as runs of [frames, group]]
    for (const [names, codecs, kept, dropped, lead, roll] of [
      // No edit lists: the picture starts after a B-frame delay (2048/12288 s),
      // so every track is shown from there and the movie starts at its first picture.
      [['h264-aac-fragmented-1', 'h264-aac-fragmented-2'], ['avc1', 'mp4a'], 17, 1, 0, []],
      // Opus: the first clip's short final frame would play over the second
      // clip's first frame, whose first 312 samples are the decoder's start-up,
      // so the short frame is dropped rather than squeezed. Each clip keeps its
      // own pre-roll groups (none for its first four frames).
      [['vp9-opus-1', 'vp9-opus-2'], ['vp09', 'Opus'], 50, 0, 312, [[4, 0], [46, 1], [4, 0], [47, 1]]],
    ]) {
      const label = names.join('+');
      const { bytes, durationSeconds } = join.joinMp4Clips(names.map(name => fixtures[name]));
      assert.equal(durationSeconds, 2, label);
      const output = parse(bytes);
      const [video, audio] = output.moov.traks;
      assert.deepEqual(output.moov.traks.map(trak => trak.mdia.minf.stbl.stsd.entries[0].type), codecs, label);
      assert.equal(video.samples.length, 24, label);
      assert.deepEqual(shown(output, video), { from: 0, to: 2, movie: 2 }, `${label}: the picture runs from 0 to the declared length`);
      assert.equal(shown(output, audio).to, 2, `${label}: and so does the sound`);
      const [firstAudio, secondAudio] = names.map(name => parse(fixtures[name]).moov.traks[1]);
      assert.deepEqual(sampleBytes(bytes, audio).slice(0, kept), sampleBytes(fixtures[names[0]], firstAudio).slice(0, kept), `${label}: the first clip's audio up to the join`);
      assert.deepEqual(sampleBytes(bytes, audio).slice(kept), sampleBytes(fixtures[names[1]], secondAudio).slice(dropped), `${label}: the second clip's audio`);
      assert.equal(audio.samples[kept].cts + lead - audio.edts.elst.entries[0].media_time, audio.mdia.mdhd.timescale,
        `${label}: the second clip's sound starts one second in`);
      const shortest = Math.min(...secondAudio.samples.map(sample => sample.duration));
      assert.ok(audio.samples.every(sample => sample.duration >= shortest), `${label}: no frame is squeezed`);
      assert.deepEqual((audio.mdia.minf.stbl.sbgps[0]?.entries || []).map(entry => [entry.sample_count, entry.group_description_index]), roll, `${label}: pre-roll groups`);
    }
    // Fragments can start at any decode time: five seconds later, the clips
    // join into the same file. A track that starts after the picture cannot join.
    const fragmented = [fixtures['h264-aac-fragmented-1'], fixtures['h264-aac-fragmented-2']];
    assert.equal(parse(laterFragments(fragmented[0], { vide: 5, soun: 5 })).moov.traks[0].samples[0].dts, 5 * 12288);
    assert.deepEqual(join.joinMp4Clips(fragmented.map(clip => laterFragments(clip, { vide: 5, soun: 5 }))).bytes, join.joinMp4Clips(fragmented).bytes);
    assert.throws(() => join.joinMp4Clips([laterFragments(fragmented[0], { soun: 5 }), fragmented[1]]), error => error.code === 'clips_incompatible');
  });

  test(`${build}: clips with different codec settings or tracks are not joined`, () => {
    for (const pair of [['h264-aac-1', 'h264-aac-48px'], ['h264-aac-1', 'vp9-opus-1']]) {
      assert.throws(() => join.joinMp4Clips(pair.map(name => fixtures[name])), error => error.code === 'clips_incompatible', pair.join('+'));
    }
    // The joined file shows every clip at the first clip's size and angle.
    for (const placed of [
      patched('h264-aac-2', (view, file) => view.setUint32(videoOf(file).tkhd.start + 84, 128 << 16)),
      patched('h264-aac-2', (view, file) => [0, 0x10000, 0, -0x10000, 0].forEach((value, i) => view.setInt32(videoOf(file).tkhd.start + 48 + i * 4, value))),
    ]) {
      assert.throws(() => join.joinMp4Clips([fixtures['h264-aac-1'], placed]), error => error.message.includes('different sizes or angles'));
    }
    // A clip cut short in the download is not read past its end.
    const cut = fixtures['h264-aac-2'].slice(0, -100);
    assert.throws(() => join.joinMp4Clips([fixtures['h264-aac-1'], cut]), error => error.code === 'not_mp4' && /incomplete/.test(error.message));
    assert.equal(join.mp4DurationSeconds(cut), null);
    assert.throws(() => join.joinMp4Clips([fixtures['h264-aac-1'], new Uint8Array([0, 0, 0, 8, 102, 114, 101, 101])]), error => error.code === 'not_mp4');
    assert.throws(() => join.joinMp4Clips([fixtures['h264-aac-1'], fixtures['h264-aac-2']], { maxBytes: 1000 }), error => error.code === 'too_large');
    assert.equal(join.mp4DurationSeconds(new Uint8Array([1, 2, 3])), null);
  });

  test(`${build}: clips whose timing cannot be laid end to end are kept apart`, () => {
    const refused = (clips, reason) => assert.throws(() => join.joinMp4Clips(clips),
      error => error.code === 'clips_incompatible' && error.message.includes(reason), reason);
    const edited = ({ milliseconds = 1000, mediaTime = 2048 }) => patched('h264-aac-1', (view, file) => {
      const elst = videoOf(file).edts.elst;
      assert.equal(elst.version, 0);
      view.setUint32(elst.start + 16, milliseconds);
      view.setInt32(elst.start + 20, mediaTime);
    });
    // An edit list that hides whole frames (the last half second, or the first
    // frame) leaves them in the file, where a join would play them.
    assert.equal(join.mp4DurationSeconds(edited({ milliseconds: 500 })), 0.5);
    refused([fixtures['h264-aac-1'], edited({ milliseconds: 500 })], 'hides some of its frames');
    refused([fixtures['h264-aac-1'], edited({ mediaTime: 3072 })], 'hides some of its frames');
    // Shortening the last frame alone is fine.
    assert.ok(Math.abs(join.joinMp4Clips([edited({ milliseconds: 960 }), fixtures['h264-aac-2']]).durationSeconds - 1.96) < 0.001);
    // A one-second-longer composition delay keeps the picture where it was but
    // starts decoding a second earlier: such a clip can open a video, not follow one.
    const delayed = patched('h264-aac-2', (view, file) => {
      const ctts = videoOf(file).mdia.minf.stbl.ctts;
      ctts.sample_offsets.forEach((offset, i) => view.setUint32(ctts.start + 16 + i * 8 + 4, offset + 12288));
      view.setInt32(videoOf(file).edts.elst.start + 20, videoOf(file).edts.elst.entries[0].media_time + 12288);
    });
    assert.equal(join.mp4DurationSeconds(delayed), 1);
    refused([fixtures['h264-aac-1'], delayed], 'start decoding before the previous one ends');
    const output = parse(join.joinMp4Clips([delayed, fixtures['h264-aac-1']]).bytes);
    const video = videoOf(output);
    const times = video.samples.map(sample => sample.cts - video.edts.elst.entries[0].media_time).sort((a, b) => a - b);
    assert.deepEqual(times.map(value => value / 1024), Array.from({ length: 24 }, (_, i) => i));
    assert.deepEqual(shown(output, video), { from: 0, to: 2, movie: 2 });
    // An edit that plays at another speed, and a clip that does not open on a keyframe.
    refused([fixtures['h264-aac-1'], patched('h264-aac-2', (view, file) => view.setInt16(videoOf(file).edts.elst.start + 26, 0x4000))],
      'complex edit list');
    refused([fixtures['h264-aac-1'], patched('h264-aac-2', (view, file) => view.setUint32(videoOf(file).mdia.minf.stbl.stss.start + 16, 2))],
      'does not start with a keyframe');
    // Encrypted samples, samples kept in another file, and a different pre-roll.
    const audioOf = file => file.moov.traks[1];
    refused([fixtures['h264-aac-1'], patched('h264-aac-2', (view, file) => 'enca'.split('').forEach((char, i) =>
      view.setUint8(audioOf(file).mdia.minf.stbl.stsd.entries[0].start + 4 + i, char.charCodeAt(0))))], 'encrypted');
    refused([fixtures['h264-aac-1'], patched('h264-aac-2', (view, file) => view.setUint8(videoOf(file).mdia.minf.dinf.dref.entries[0].start + 11, 0))],
      'in another file');
    refused([fixtures['h264-aac-1'], patched('h264-aac-2', (view, file) => view.setInt16(audioOf(file).mdia.minf.stbl.sgpds[0].start + 24, -2))],
      'different codec settings');
    // Sound whose own edit ends half a second before the picture would play
    // on in a joined file; ending within a frame of it is fine.
    const soundEdit = milliseconds => patched('h264-aac-2', (view, file) => view.setUint32(audioOf(file).edts.elst.start + 16, milliseconds));
    refused([fixtures['h264-aac-1'], soundEdit(500)], 'ends a track early');
    assert.equal(join.joinMp4Clips([fixtures['h264-aac-1'], soundEdit(960)]).durationSeconds, 2);
  });

  test(`${build}: scenes fit the model's clip lengths and stay within two minutes`, () => {
    const { clips, total } = media.planVideoClips([{ prompt: 'Opening', duration: 12 }, { prompt: 'Long walk', duration: 20 }], [5, 10, 15]);
    assert.deepEqual(clips, [
      { prompt: 'Opening', duration: 15 },
      { prompt: 'Long walk (part 1 of 2)', duration: 10 },
      { prompt: 'Long walk (part 2 of 2)', duration: 10 },
    ]);
    assert.equal(total, 35);
    assert.equal(media.planVideoClips(scenes(8, 15), grok.supported_durations).total, 120);
    assert.throws(() => media.planVideoClips(scenes(9, 15), grok.supported_durations), /up to 120 s/);
    assert.throws(() => media.planVideoClips(scenes(25, 4), grok.supported_durations), /at most 24/);
    assert.throws(() => media.planVideoClips(scenes(2, 5), null), /does not list the clip lengths/);
    assert.throws(() => media.planVideoClips([{ prompt: ' ', duration: 5 }], [5]), /Scene 1 needs a prompt/);
  });

  test(`${build}: one clip sends only the duration, aspect ratio and resolution the model supports`, async () => {
    const api = videoApi({ entry: grok });
    const result = await generate({ prompt: 'A red apple', duration: 8, aspect_ratio: '9:16', resolution: '720p' }, { fetchImpl: api.fetchImpl });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(api.calls.submits, [{ model: grok.id, prompt: 'A red apple', duration: 8, aspect_ratio: '9:16', resolution: '720p' }]);
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(result.durationSeconds, 1, "the clip's real length");
    assert.deepEqual(await storedBytes(result.mediaId), fixtures['h264-aac-1']);
    const estimated = videoApi({ entry: { ...grok, supported_durations: [4, 8, 12] } });
    await media.runMediaGeneration({ prompt: 'A red apple', video: { estimated_duration: 7 }, config, fetchImpl: estimated.fetchImpl });
    assert.equal(estimated.calls.submits[0].duration, 8, 'an estimate rounds up to a clip length the model makes');
    for (const [video, pattern] of [
      [{ duration: 16 }, /needs more than one clip/],
      [{ estimated_duration: 40 }, /Describe it as scenes/],
      [{ aspect_ratio: '4:5' }, /does not support aspect_ratio "4:5"\. Supported: 16:9, 9:16, 1:1/],
      [{ resolution: '4K' }, /does not support resolution/],
      [{ scenes: scenes(2, 5) }, /estimated_duration/],
      [{ scenes: scenes(2, 5), estimated_duration: 10, duration: 5 }, /each scene its duration/],
    ]) {
      const rejected = videoApi({ entry: grok });
      await assert.rejects(media.runMediaGeneration({ prompt: 'A red apple', video, config, fetchImpl: rejected.fetchImpl }), pattern, JSON.stringify(video));
      assert.equal(rejected.calls.submits.length, 0, 'nothing is submitted');
    }
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', video: { duration: 5 }, config,
      fetchImpl: async url => (url.endsWith('/images/models') ? json({ data: [{ id: grok.id }] }) : assert.fail(url)) }), /need a video model/);
    await assert.rejects(media.runMediaGeneration({ prompt: 'x', video: { duration: 5 }, config: { apiKey: 'k', model: 'fal-ai/flux/schnell' },
      fetchImpl: async url => assert.fail(url) }), /OpenRouter video models/);
  });

  test(`${build}: a video of two minutes or less generates without asking`, async () => {
    const api = videoApi({ entry: grok });
    const progress = [];
    let asked = 0;
    const result = await generate({ prompt: 'Flat motion graphics, navy background', scenes: scenes(4, 15), estimated_duration: 60 }, {
      fetchImpl: api.fetchImpl, onProgress: message => progress.push(message),
      confirmVideoLength: async () => { asked += 1; return 'once'; },
    });
    assert.equal(result.success, true, result.error);
    assert.equal(asked, 0, 'no card within the cap');
    assert.equal(api.calls.submits.length, 4);
    assert.ok(api.calls.maxInFlight <= 3, `at most three clips at a time (saw ${api.calls.maxInFlight})`);
    api.calls.submits.forEach((body, index) => {
      assert.equal(body.duration, 15);
      assert.equal(body.prompt, `Flat motion graphics, navy background\n\nScene ${index + 1} of 4: Scene idea ${index + 1}`);
    });
    assert.equal(result.clipCount, 4);
    assert.equal(result.durationSeconds, 4, 'the real length of the joined clips');
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(join.mp4DurationSeconds(await storedBytes(result.mediaId)), 4, 'one joined asset');
    assert.deepEqual(progress, ['Generating 4 video clips…', 'Video clips: 1 of 4 ready', 'Video clips: 2 of 4 ready',
      'Video clips: 3 of 4 ready', 'Video clips: 4 of 4 ready', 'Joining 4 clips…']);
  });

  test(`${build}: a longer estimate asks first and generates nothing unless the user agrees`, async () => {
    for (const [answer, pattern] of [['deny', /chose not to generate the 2:00 version/], ['unavailable', /could not ask the user/], [null, /withdrawn/]]) {
      const api = videoApi({ entry: grok });
      const asked = [];
      const result = await generate({ prompt: 'Explainer', scenes: scenes(8, 15), estimated_duration: 330 }, {
        fetchImpl: api.fetchImpl, confirmVideoLength: async details => { asked.push(details); return answer; },
      });
      assert.deepEqual(asked, [{ estimatedSeconds: 330, totalSeconds: 120, clipCount: 8, maxSeconds: 120 }]);
      assert.equal(result.success, false);
      assert.equal(result.declined, true);
      assert.match(result.error, /needs about 5:30/);
      assert.match(result.error, pattern);
      assert.equal(api.calls.submits.length, 0, `${answer}: nothing is submitted`);
    }
    const api = videoApi({ entry: grok });
    const approved = await generate({ prompt: 'Explainer', scenes: scenes(8, 15), estimated_duration: 330 }, {
      fetchImpl: api.fetchImpl, confirmVideoLength: async () => 'once',
    });
    assert.equal(approved.success, true, approved.error);
    assert.equal(api.calls.submits.length, 8);
    assert.equal(approved.clipCount, 8);
    const withoutCard = videoApi({ entry: grok });
    const unasked = await generate({ prompt: 'Explainer', scenes: scenes(8, 15), estimated_duration: 330 }, { fetchImpl: withoutCard.fetchImpl });
    assert.equal(unasked.declined, true, 'without a card nothing is generated');
    assert.equal(withoutCard.calls.submits.length, 0);
  });

  test(`${build}: a clip is retried once and a second failure ends the video`, async () => {
    const retried = videoApi({ entry: grok, fail: index => index === 1 });
    const recovered = await generate({ prompt: 'Story', scenes: scenes(3, 10), estimated_duration: 30 }, { fetchImpl: retried.fetchImpl });
    assert.equal(recovered.success, true, recovered.error);
    assert.equal(retried.calls.submits.length, 4, 'three clips and one retry');
    const failing = videoApi({ entry: grok, fail: (_index, body) => body.prompt.includes('Scene 2 of 3') });
    const stored = assets.size;
    const failed = await generate({ prompt: 'Story', scenes: scenes(3, 10), estimated_duration: 30 }, { fetchImpl: failing.fetchImpl });
    assert.equal(failed.success, false);
    assert.match(failed.error, /^Clip 2 of 3 failed: OpenRouter video submit failed \(HTTP 503\).*Provider overloaded/);
    assert.equal(assets.size, stored, 'no partial video is kept');
  });

  test(`${build}: Stop ends every clip of a video`, async () => {
    const controller = new AbortController();
    const api = videoApi({ entry: grok });
    const stored = assets.size;
    const result = await generate({ prompt: 'Story', scenes: scenes(5, 10), estimated_duration: 50 }, {
      signal: controller.signal,
      // The user presses Stop while the first clip downloads.
      fetchImpl: async (url, init) => {
        if (url.includes('/content')) {
          controller.abort(new Error('Stopped by user.'));
          init.signal.throwIfAborted();
        }
        return api.fetchImpl(url, init);
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'Stopped by user.');
    assert.equal(api.calls.submits.length, 3, 'clips 4 and 5 never start');
    assert.equal(assets.size, stored);
  });

  test(`${build}: clips that cannot be joined are kept and shown in order`, async () => {
    const api = videoApi({ entry: grok, clip: job => (job.index === 1 ? fixtures['h264-aac-48px'] : fixtures['h264-aac-1']) });
    const result = await generate({ prompt: 'Story', scenes: scenes(2, 10), estimated_duration: 20 }, { fetchImpl: api.fetchImpl });
    assert.equal(result.success, true, result.error);
    assert.equal(result.joined, false);
    assert.equal(result.clipCount, 2);
    assert.equal(result.durationSeconds, 2);
    assert.equal(result.mediaId, undefined);
    assert.deepEqual(result.clips.map(clip => clip.mimeType), ['video/mp4', 'video/mp4']);
    assert.deepEqual(await storedBytes(result.clips[1].mediaId), fixtures['h264-aac-48px']);
    const compacted = journal.compactRunUiData('tool_result', { name: 'generate_image', result });
    assert.deepEqual(compacted.result.clips, result.clips, 'the journal keeps the clips for replay');
    assert.equal(compacted.result.joined, false);
    assert.equal(compacted.result.clipCount, 2);
    const agent = new Agent({ getActive: () => chatProvider });
    const forModel = JSON.parse(agent._limitToolResult(result));
    assert.ok(forModel.clips.every(clip => !('mediaId' in clip)), 'asset handles stay out of model context');
    assert.match(forModel.note, /shows them one after another/);
    assert.match(forModel.note, /You have not seen it/);
    assert.match(forModel.note, /do not invent a hosted URL/);
  });

  test(`${build}: the chat shows a joined video as one video that plays to the end`, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${origin}/__media.html`);
      const shown = await page.evaluate(async ({ build, entry }) => {
        const { generateImage } = await import(`/src/${build}/src/agent/generative-media.js`);
        const { appendGeneratedMedia } = await import(`/src/${build}/src/ui/generated-media-view.js`);
        const { compactRunUiData } = await import(`/src/${build}/src/run-ui-journal.js`);
        const fixture = async name => (await fetch(`/test/fixtures/video/${name}.mp4`)).arrayBuffer();
        const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Retry-After': '0.001' } });
        const run = clips => {
          let submitted = 0;
          return generateImage({ prompt: 'Test pattern', scenes: clips.map((_, i) => ({ prompt: `Part ${i + 1}`, duration: 1 })), estimated_duration: clips.length }, {
            config: { provider: 'openrouter', apiKey: 'synthetic-key', model: entry.id },
            fetchImpl: async (url, init = {}) => {
              if (url.endsWith('/images/models')) return reply({ data: [] });
              if (url.endsWith('/videos/models')) return reply({ data: [entry] });
              if (init.method === 'POST') return reply({ id: `job-${submitted++}` }, 202);
              const [, index, content] = /job-(\d+)(\/content)?/.exec(url);
              return content ? new Response(await fixture(clips[index]), { headers: { 'Content-Type': 'video/mp4' } }) : reply({ status: 'completed' });
            },
          });
        };
        // What the side panel renders: the run journal's copy of the tool result.
        const show = async result => {
          if (!result.success) throw new Error(result.error);
          const container = document.createElement('div');
          document.querySelector('#chat').append(container);
          await appendGeneratedMedia(container, compactRunUiData('tool_result', { name: 'generate_image', result }).result, key => key);
          return container;
        };
        const joined = await run(['vp9-opus-1', 'vp9-opus-2']);
        const single = await show(joined);
        const video = single.querySelector('video');
        await new Promise((resolve, reject) => {
          if (video.readyState >= 1) resolve();
          video.onloadedmetadata = resolve;
          video.onerror = () => reject(new Error(`media error ${video.error?.code}`));
        });
        video.muted = true;
        video.playbackRate = 4;
        const ended = new Promise(resolve => { video.onended = () => resolve(true); setTimeout(() => resolve(false), 8000); });
        await video.play();
        const playedToEnd = await ended;
        const separate = await run(['vp9-opus-1', 'h264-aac-48px']);
        const several = await show(separate);
        return {
          joined: { clipCount: joined.clipCount, durationSeconds: joined.durationSeconds, videos: single.querySelectorAll('video').length,
            duration: video.duration, playedToEnd, frames: video.getVideoPlaybackQuality().totalVideoFrames,
            download: single.querySelector('a[download]')?.getAttribute('download') },
          separate: { joined: separate.joined, clips: separate.clips.map(clip => clip.mediaId),
            shown: [...several.querySelectorAll('.generated-media')].map(wrapper => wrapper.dataset.mediaId),
            playable: [...several.querySelectorAll('video')].map(element => element.src.startsWith('blob:')) },
        };
      }, { build, entry: grok });
      assert.deepEqual(shown.joined, { clipCount: 2, durationSeconds: 2, videos: 1, duration: 2, playedToEnd: true,
        frames: shown.joined.frames, download: 'webbrain-media.mp4' });
      assert.ok(shown.joined.frames >= 20, `rendered ${shown.joined.frames} frames`);
      assert.equal(shown.separate.joined, false);
      assert.deepEqual(shown.separate.shown, shown.separate.clips, 'unjoinable clips appear in order');
      assert.deepEqual(shown.separate.playable, [true, true]);
    } finally { await page.close(); }
  });

  test(`${build}: the agent asks on WebBrain's card, and an unattended run cannot`, async () => {
    const tab = 41, request = 'video-request', runId = 'video-run';
    const agent = new Agent({ getActive: () => chatProvider });
    agent._persist = () => {};
    agent._runningTabs.add(tab);
    agent.currentRunId.set(tab, runId);
    agent.conversations.set(tab, [{ role: 'system', content: 'Owned fixture.' }, { role: 'user', content: 'Turn this page into a video.' }]);
    agent._beginSteeringRun(tab, () => {}, { detachedRequestId: request });
    const details = { estimatedSeconds: 330, totalSeconds: 120, clipCount: 8, maxSeconds: 120 };
    const updates = [];
    const onUpdate = (type, data) => {
      updates.push({ type, data });
      if (type === 'clarify') agent._capturePendingClarificationForUi(tab, request, data, { seq: 1, runId });
    };
    const answer = agent._promptVideoLengthConfirmation(tab, details, onUpdate);
    const card = updates.find(update => update.type === 'clarify').data;
    assert.equal(card.promptKind, 'video_length');
    assert.deepEqual(card.videoLengthConfirmation, details);
    assert.deepEqual(card.options, ['once', 'deny']);
    assert.equal(card.timeoutSec, undefined, 'the card never times out');
    assert.match(card.question, /needs about 5:30.*up to 2:00.*2:00 version from 8 clips/);
    assert.deepEqual(agent.activeRunState(tab).pendingCurrentClarification.data.videoLengthConfirmation, details, 'a reopened panel can show the card');
    agent.submitClarifyResponse(tab, card.clarifyId, 'once', 'user');
    assert.equal(await settled(answer), 'once');
    const cancelled = agent._promptVideoLengthConfirmation(tab, details, onUpdate);
    agent._cancelClarifications(tab, 'Stopped');
    assert.equal(await settled(cancelled), null);
    updates.length = 0;
    agent.scheduledRunPolicies.set(tab, { requireConsequentialConfirmation: false });
    assert.equal(await settled(agent._promptVideoLengthConfirmation(tab, details, onUpdate)), 'unavailable');
    assert.equal(updates.length, 0, 'an unattended run shows no card');
    agent.scheduledRunPolicies.delete(tab);
    assert.equal(await settled(agent._promptVideoLengthConfirmation(tab, details, null)), 'unavailable');
    agent._cancelClarifications(tab, 'cleanup');
  });

  test(`${build}: a scheduled run keeps the video length card for a reopened panel`, async () => {
    let finish;
    const details = { estimatedSeconds: 330, totalSeconds: 120, clipCount: 8, maxSeconds: 120 };
    const h = makeSchedulerHarness(Scheduler, {
      processMessage: async (_tab, _message, onUpdate) => {
        onUpdate('clarify', { promptKind: 'video_length', clarifyId: 'video_length_1', options: ['once', 'deny'],
          question: 'This video needs about 5:30, but WebBrain makes videos up to 2:00. Generate a 2:00 version from 8 clips instead?',
          videoLengthConfirmation: details });
        await new Promise(resolve => { finish = resolve; });
        return 'done';
      },
    });
    const created = await h.manager.createResumeJob({ tabId: 77, conversationId: 'conv-1',
      args: { after_seconds: 60, reason: 'wait', resume_instruction: 'make the video' } });
    const running = h.manager.handleAlarm(h.alarmName(created.jobId));
    await new Promise(resolve => setTimeout(resolve, 0));
    const pending = h.jobs()[0].pendingClarify;
    assert.equal(h.jobs()[0].status, 'needs_user_input');
    assert.equal(pending.promptKind, 'video_length');
    assert.deepEqual(pending.options, ['once', 'deny']);
    assert.deepEqual(pending.videoLengthConfirmation, details);
    assert.equal(pending.timeoutSec, undefined, 'no countdown');
    finish();
    await running;
  });

  test(`${build}: generate_image in a run reports clip progress and asks before a long video`, async () => {
    const tab = 43;
    const agent = new Agent({ getActive: () => chatProvider });
    agent._persist = () => {};
    const updates = [];
    let answer = 'deny';
    const onUpdate = (type, data) => {
      updates.push({ type, data });
      if (type === 'clarify') agent.submitClarifyResponse(tab, data.clarifyId, answer, 'user');
    };
    const originalFetch = globalThis.fetch;
    try {
      const short = videoApi({ entry: grok });
      globalThis.fetch = short.fetchImpl;
      const result = await agent._executeToolImpl(tab, 'generate_image', { prompt: 'Explainer', scenes: scenes(2, 10), estimated_duration: 20 }, onUpdate, { imageGenConfig: config });
      assert.equal(result.success, true, result.error);
      assert.equal(result.clipCount, 2);
      assert.ok(assets.has(result.mediaId));
      assert.deepEqual(updates.map(({ type, data }) => [type, data.name, data.message]), [
        ['tool_progress', 'generate_image', 'Generating 2 video clips…'],
        ['tool_progress', 'generate_image', 'Video clips: 1 of 2 ready'],
        ['tool_progress', 'generate_image', 'Video clips: 2 of 2 ready'],
        ['tool_progress', 'generate_image', 'Joining 2 clips…'],
      ]);
      updates.length = 0;
      const long = videoApi({ entry: grok });
      globalThis.fetch = long.fetchImpl;
      const declined = await agent._executeToolImpl(tab, 'generate_image', { prompt: 'Explainer', scenes: scenes(8, 15), estimated_duration: 330 }, onUpdate, { imageGenConfig: config });
      assert.deepEqual(updates.map(update => [update.type, update.data.promptKind]), [['clarify', 'video_length']]);
      assert.equal(declined.success, false);
      assert.match(declined.error, /The user chose not to generate the 2:00 version/);
      assert.equal(long.calls.submits.length, 0);
      answer = 'once';
      const approved = await agent._executeToolImpl(tab, 'generate_image', { prompt: 'Explainer', scenes: scenes(8, 15), estimated_duration: 330 }, onUpdate, { imageGenConfig: config });
      assert.equal(approved.success, true, approved.error);
      assert.equal(approved.clipCount, 8);
      assert.equal(long.calls.submits.length, 8);
    } finally { globalThis.fetch = originalFetch; }
  });

  test(`${build}: the generate_image schema takes scenes and nothing else`, async () => {
    const originalChrome = globalThis.chrome, originalBrowser = globalThis.browser;
    const local = { get: async () => ({ imageGenModel: config }), set: async () => {}, remove: async () => {} };
    globalThis.chrome = globalThis.browser = {
      storage: { local, session: local }, runtime: { getURL: value => `chrome-extension://test/${value}`, sendMessage: async () => ({}) },
      tabs: { get: async id => ({ id, url: 'https://example.com', title: 'Example' }), sendMessage: async () => ({}) },
      scripting: { executeScript: async () => [{ result: null }] },
    };
    try {
      const provider = { supportsVision: false, promptTier: 'full' };
      const agent = new Agent({ getActive: () => provider, getVisionProvider: async () => null });
      agent._ensureGateSetting = async () => {};
      agent._persist = () => {};
      agent.permissions.check = () => ({ allowed: true });
      const dispatched = [], messages = [];
      agent.executeTool = async (_tab, _name, args) => { dispatched.push(args); return { success: false, error: 'Not generated in this test.' }; };
      const call = args => agent._executeToolBatch(12, [{ id: 'media-call', function: { name: 'generate_image', arguments: JSON.stringify(args) } }],
        messages, () => {}, provider, '', new Set(['generate_image']), 1);
      const valid = { prompt: 'Flat motion graphics', scenes: [{ prompt: 'Title card', duration: 6 }, { prompt: 'The idea', duration: 15 }],
        estimated_duration: 21, aspect_ratio: '16:9', resolution: '720p' };
      await call(valid);
      assert.deepEqual(dispatched, [valid]);
      for (const [invalid, path] of [
        [{ ...valid, scenes: [{ prompt: 'Title card', duration: 6, camera: 'drone' }] }, '$.scenes[0].camera'],
        [{ ...valid, scenes: [{ prompt: 'Title card' }] }, '$.scenes[0].duration'],
        [{ ...valid, estimated_duration: 0 }, '$.estimated_duration'],
        [{ ...valid, duration: '8s' }, '$.duration'],
      ]) {
        messages.length = 0;
        await call(invalid);
        assert.match(messages[0].content, /invalid_tool_arguments/, path);
        assert.ok(messages[0].content.includes(path), `${path}: ${messages[0].content}`);
      }
      assert.equal(dispatched.length, 1, 'invalid calls are not dispatched');
    } finally { globalThis.chrome = originalChrome; globalThis.browser = originalBrowser; }
  });

  test(`${build}: the side panel card states the length in the user's language`, async () => {
    const source = (await fs.readFile(new URL(`../src/${build}/src/ui/sidepanel.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const extract = name => {
      const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
      assert.ok(start >= 0, name);
      return source.slice(start, source.indexOf('\n}', start) + 2);
    };
    const dictionary = (await import(`../src/${build}/src/ui/locales/tr.js`)).default;
    const english = (await import(`../src/${build}/src/ui/locales/en.js`)).default;
    for (const key of ['question', 'offer', 'generate', 'dont', 'seconds']) {
      assert.equal(typeof english[`sp.video_length.${key}`], 'string', key);
      assert.notEqual(dictionary[`sp.video_length.${key}`], english[`sp.video_length.${key}`], `tr ${key} is translated`);
    }
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="messages"><div class="message assistant" data-run-request-id="video-request"><div class="message-content"><div class="message-text"></div></div></div></div>');
      await page.evaluate(({ functions, dictionary }) => {
        const noop = () => {};
        Object.assign(window, {
          messagesEl: document.querySelector('#messages'), currentAssistantEl: document.querySelector('.assistant'), currentTabId: 7,
          submittedClarificationIds: new Set(), answers: [],
          t: (key, params) => String(dictionary[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => (params?.[name] != null ? String(params[name]) : `{${name}}`)),
          submitClarify: (_card, _tab, clarifyId, value, source) => window.answers.push({ clarifyId, value, source }),
          hideRecommendedActions: noop, resetChatNavigation: noop, hideActivity: noop, scrollToBottom: noop, applyClarifyTimeoutExtension: noop,
          addMessage: () => { throw new Error('no new message'); },
        });
        (0, eval)(functions);
        window.renderClarifyCard({ clarifyId: 'video_length_1', promptKind: 'video_length', question: 'English fallback',
          videoLengthConfirmation: { estimatedSeconds: 330, totalSeconds: 120, clipCount: 8, maxSeconds: 120 }, options: ['once', 'deny'] });
      }, { functions: ['renderClarifyCard', 'clarificationSubmissionKey'].map(extract).join('\n'), dictionary });
      const card = page.locator('.clarify-card[data-video-length-confirmation="1"]');
      assert.equal(await card.locator('.clarify-question').innerText(), 'Bu video yaklaşık 5:30 gerektiriyor, ancak WebBrain en fazla 2:00 uzunluğunda video üretiyor.');
      assert.equal(await card.locator('.clarify-reason').innerText(), 'Bunun yerine 8 klipten 2:00 uzunluğunda bir sürüm üretilsin mi?');
      assert.deepEqual(await card.locator('.clarify-option').allInnerTexts(), ['2:00 sürümünü üret', 'Üretme']);
      assert.equal(await card.locator('.clarify-input').count(), 0, 'fixed choices, no free text');
      await card.locator('.clarify-option[data-value="deny"]').click();
      assert.deepEqual(await page.evaluate(() => window.answers), [{ clarifyId: 'video_length_1', value: 'deny', source: 'option' }]);
    } finally { await page.close(); }
  });

  test(`${build}: the model reports a joined video's length, never its contents`, () => {
    const agent = new Agent({ getActive: () => chatProvider });
    const forModel = JSON.parse(agent._limitToolResult({ success: true, provider: 'openrouter', model: grok.id,
      mediaId: 'private-asset-id', mimeType: 'video/mp4', inlineMedia: true, durationSeconds: 112.5, clipCount: 8 }));
    assert.equal(forModel.mediaId, undefined);
    assert.equal(forModel.durationSeconds, 112.5);
    assert.equal(forModel.clipCount, 8);
    assert.match(forModel.note, /describe it only by what you asked for and by its durationSeconds and clipCount/);
    assert.doesNotMatch(forModel.note, /one after another/);
    const compacted = journal.compactRunUiData('tool_result', { name: 'generate_image', result: { success: true, mediaId: 'a', mimeType: 'video/mp4', durationSeconds: 112.5, clipCount: 8 } });
    assert.equal(compacted.result.durationSeconds, 112.5);
    assert.equal(compacted.result.clipCount, 8);
  });
}
