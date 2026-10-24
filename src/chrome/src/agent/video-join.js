// Joins generated MP4 clips into one MP4 without re-encoding.
//
// Clips from one video model share their codec setup, so their samples can be
// laid end to end: the joiner keeps the first clip's sample descriptions
// (stsd) and writes new sample tables for the combined timeline. Clips whose
// tracks or codec setup differ cannot be joined this way (`clips_incompatible`);
// the caller then shows them one after another instead. mp4box.js parses the
// input. The output is a plain (not fragmented) MP4 with moov before mdat.
//
// Shared byte for byte by the Chrome and Firefox builds.

import { createFile, MP4BoxBuffer } from '../../vendor/mp4box/mp4box.all.mjs';

export class VideoJoinError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VideoJoinError';
    this.code = code;
  }
}

const incompatible = reason => new VideoJoinError(`The clips cannot be joined into one file: ${reason}.`, 'clips_incompatible');
const MEDIA_HEADER_TYPES = new Set(['vmhd', 'smhd', 'nmhd', 'sthd', 'hmhd']);
const MAX_UINT32 = 2 ** 32 - 1;

function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) return input;
  if (ArrayBuffer.isView(input)) return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  throw new VideoJoinError('Expected MP4 bytes.', 'not_mp4');
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function rawBox(bytes, box) {
  return box && Number.isInteger(box.start) && Number.isInteger(box.size) && box.size > 0
    ? bytes.subarray(box.start, box.start + box.size) : null;
}

// esds: ES_Descriptor (tag 3), then DecoderConfigDescriptor (tag 4) whose
// bufferSizeDB, maxBitrate and avgBitrate follow objectTypeIndication and
// streamType.
function blankEsdsBitrates(bytes, box, blank) {
  const end = box.start + box.size;
  let p = box.start + 12;
  const skipLength = () => {
    for (let i = 0; i < 4 && p < end; i++) if (!(bytes[p++] & 0x80)) break;
  };
  if (bytes[p++] !== 0x03) return;
  skipLength();
  p += 2;
  const flags = bytes[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + bytes[p];
  if (flags & 0x20) p += 2;
  if (bytes[p++] !== 0x04) return;
  skipLength();
  if (p + 13 <= end) blank(p + 2, p + 13);
}

// The sample description with this encode's bitrate figures blanked: every
// clip reports its own, and they do not change how the samples decode.
function sampleDescriptionKey(bytes, stsd) {
  const key = bytes.slice(stsd.start, stsd.start + stsd.size);
  const blank = (from, to) => key.fill(0, from - stsd.start, to - stsd.start);
  for (const entry of stsd.entries || []) {
    for (const child of entry.boxes || []) {
      if (!Number.isInteger(child.start) || !(child.size > 8)
          || child.start < stsd.start || child.start + child.size > stsd.start + stsd.size) continue;
      if (child.type === 'btrt') blank(child.start + 8, child.start + child.size);
      if (child.type === 'esds') blankEsdsBitrates(bytes, child, blank);
    }
  }
  return key;
}

function readTrack(trak, movieTimescale, bytes) {
  const mdia = trak?.mdia, minf = mdia?.minf, stbl = minf?.stbl;
  const handler = mdia?.hdlr?.handler;
  const timescale = mdia?.mdhd?.timescale;
  const samples = Array.isArray(trak?.samples) ? trak.samples : [];
  if (!stbl?.stsd || !(timescale > 0) || !samples.length) throw incompatible('a track has no samples');
  if ((stbl.stsd.entries?.length || 0) !== 1 || samples.some(sample => sample.description_index !== 0)) {
    throw incompatible('a track switches codec settings');
  }
  // Reordered frames (B-frames) are shown after they are decoded, so the
  // track's picture ends at its last composition time, not its last decode time.
  const compositionEnd = samples.reduce((end, sample) => Math.max(end, sample.cts + sample.duration), 0);
  // One edit that skips the codec's start-up delay is normal. Empty edits or
  // several edits describe a timeline these tables cannot carry over.
  const edits = trak.edts?.elst?.entries || [];
  if (edits.length > 1 || edits.some(edit => edit.media_time < 0 || edit.media_rate_integer !== 1)) {
    throw incompatible('a track has a complex edit list');
  }
  return {
    handler,
    timescale,
    samples,
    hasEdit: edits.length > 0,
    editStart: edits.length ? edits[0].media_time : 0,
    editDuration: edits.length && edits[0].segment_duration > 0
      ? Math.round(edits[0].segment_duration * timescale / movieTimescale) : Infinity,
    firstComposition: samples.reduce((min, sample) => Math.min(min, sample.cts), Infinity),
    compositionEnd,
    tkhd: trak.tkhd,
    language: mdia.mdhd.language,
    stsd: rawBox(bytes, stbl.stsd),
    stsdKey: sampleDescriptionKey(bytes, stbl.stsd),
    hdlr: rawBox(bytes, mdia.hdlr),
    mediaHeader: rawBox(bytes, (minf.boxes || []).find(box => MEDIA_HEADER_TYPES.has(box.type))),
    dinf: rawBox(bytes, (minf.boxes || []).find(box => box.type === 'dinf')),
  };
}

function parseClip(input) {
  const arrayBuffer = toArrayBuffer(input);
  const bytes = new Uint8Array(arrayBuffer);
  const file = createFile();
  let failed = false;
  file.onError = () => { failed = true; };
  try {
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(arrayBuffer, 0));
    file.flush();
  } catch { failed = true; }
  const moov = file.moov;
  const movieTimescale = moov?.mvhd?.timescale;
  if (failed || !(movieTimescale > 0) || !Array.isArray(moov.traks) || !moov.traks.length) {
    throw new VideoJoinError('The clip is not a readable MP4 file.', 'not_mp4');
  }
  // Video first, then audio; other tracks (timed metadata) are not carried over.
  const order = { vide: 0, soun: 1 };
  const tracks = moov.traks
    .filter(trak => Object.hasOwn(order, trak.mdia?.hdlr?.handler))
    .map(trak => readTrack(trak, movieTimescale, bytes))
    .sort((a, b) => order[a.handler] - order[b.handler]);
  if (!tracks.length) throw incompatible('a clip has no video or audio track');
  const timing = tracks[0];
  // Where each track's picture or sound starts (mediaTime, in its own units).
  // Without edit lists a clip shows nothing before its first picture (some
  // encoders' fragmented files start video after a B-frame delay), so every
  // track starts that much later, in step with the picture.
  const lead = timing.hasEdit ? 0 : timing.firstComposition / timing.timescale;
  for (const track of tracks) track.mediaTime = track.editStart + Math.round(lead * track.timescale);
  const presented = Math.max(0, Math.min(timing.editDuration, timing.compositionEnd - timing.mediaTime));
  // An edit list that hides whole frames before or after the picture keeps
  // them in the file; joined, they would play over the neighbouring clip.
  const pictureEnd = timing.mediaTime + presented;
  const hidesFrames = timing.samples.some(sample => sample.duration > 0
    && (sample.cts + sample.duration <= timing.mediaTime || sample.cts >= pictureEnd));
  // A track whose first sample comes after the clip's start (more than a
  // millisecond) would have to begin with a gap, which one edit cannot show.
  const startsLate = tracks.some(track => track.samples[0].dts - track.mediaTime > track.timescale / 1000);
  return {
    bytes,
    movieTimescale,
    matrix: moov.mvhd.matrix,
    ftyp: rawBox(bytes, (file.boxes || []).find(box => box.type === 'ftyp')),
    tracks,
    duration: presented / timing.timescale,
    hidesFrames,
    startsLate,
  };
}

/** Presented length of an MP4 in seconds, or null when it is not one. */
export function mp4DurationSeconds(input) {
  try { return parseClip(input).duration; } catch { return null; }
}

// Lays out one output track: each clip's samples in order, with the previous
// clip's last sample lengthened or shortened so that this clip starts where
// the timeline says. At each join the audio follows the picture: a later
// clip's codec start-up frames are dropped, and so are the previous clip's
// frames that would mostly play after this clip's audio begins (padding, or
// audio longer than the picture). Video frames are never dropped.
function joinTrack(clips, index, starts) {
  const first = clips[0].tracks[index];
  // The output's decode times start at 0, wherever the first clip's start
  // (fragmented files can start at any decode time): its start in the output.
  const mediaStart = Math.max(0, first.mediaTime - first.samples[0].dts);
  const samples = [];
  const chunks = [];
  clips.forEach((clip, clipIndex) => {
    const track = clip.tracks[index];
    const audio = track.handler === 'soun';
    const kept = audio && clipIndex > 0
      ? track.samples.filter(sample => sample.cts + sample.duration / 2 >= track.mediaTime)
      : track.samples;
    if (!kept.length) throw incompatible('a clip has an empty track');
    if (samples.length) {
      const target = Math.round(starts[clipIndex] * track.timescale) + (kept[0].dts - track.mediaTime) + mediaStart;
      const previous = chunks[chunks.length - 1];
      while (audio && previous.count > 1
          && samples[samples.length - 1].dts + samples[samples.length - 1].duration / 2 >= target) {
        previous.count -= 1;
        previous.size -= samples.pop().size;
      }
      const last = samples[samples.length - 1];
      last.duration = Math.max(1, target - last.dts);
    }
    let dts = samples.length ? samples[samples.length - 1].dts + samples[samples.length - 1].duration : 0;
    chunks.push({ clipIndex, first: samples.length, count: kept.length, size: 0, offset: 0 });
    const chunk = chunks[chunks.length - 1];
    for (const sample of kept) {
      samples.push({
        dts,
        duration: sample.duration,
        offset: sample.cts - sample.dts,
        size: sample.size,
        source: sample.offset,
        sync: sample.is_sync !== false,
        clipIndex,
      });
      chunk.size += sample.size;
      dts += sample.duration;
    }
  });
  const mediaDuration = samples.reduce((sum, sample) => sum + sample.duration, 0);
  return { first, samples, chunks, mediaDuration, mediaStart };
}

class Writer {
  constructor() {
    this.buffer = new Uint8Array(1 << 16);
    this.view = new DataView(this.buffer.buffer);
    this.position = 0;
  }
  ensure(length) {
    if (this.position + length <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.position + length) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.position));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }
  u8(value) { this.ensure(1); this.view.setUint8(this.position, value); this.position += 1; }
  u16(value) { this.ensure(2); this.view.setUint16(this.position, value); this.position += 2; }
  i16(value) { this.ensure(2); this.view.setInt16(this.position, value); this.position += 2; }
  u32(value) { this.ensure(4); this.view.setUint32(this.position, value); this.position += 4; }
  i32(value) { this.ensure(4); this.view.setInt32(this.position, value); this.position += 4; }
  bytes(value) { this.ensure(value.length); this.buffer.set(value, this.position); this.position += value.length; }
  type(value) { for (let i = 0; i < 4; i++) this.u8(value.charCodeAt(i)); }
  box(type, body) {
    const start = this.position;
    this.u32(0);
    this.type(type);
    body();
    this.view.setUint32(start, this.position - start);
  }
  full(type, version, flags, body) {
    this.box(type, () => { this.u32(((version & 255) << 24 | (flags & 0xffffff)) >>> 0); body(); });
  }
  result() { return this.buffer.slice(0, this.position); }
}

function runs(values) {
  const out = [];
  for (const value of values) {
    const last = out[out.length - 1];
    if (last && last.value === value) last.count += 1;
    else out.push({ value, count: 1 });
  }
  return out;
}

function writeMatrix(writer, matrix) {
  const values = matrix && matrix.length === 9 ? matrix : [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  for (const value of values) writer.i32(value);
}

function writeSampleTable(writer, track) {
  const { first, samples, chunks } = track;
  writer.box('stbl', () => {
    writer.bytes(first.stsd);
    const durations = runs(samples.map(sample => sample.duration));
    writer.full('stts', 0, 0, () => {
      writer.u32(durations.length);
      for (const run of durations) { writer.u32(run.count); writer.u32(run.value); }
    });
    if (samples.some(sample => sample.offset !== 0)) {
      const negative = samples.some(sample => sample.offset < 0);
      const offsets = runs(samples.map(sample => sample.offset));
      writer.full('ctts', negative ? 1 : 0, 0, () => {
        writer.u32(offsets.length);
        for (const run of offsets) { writer.u32(run.count); if (negative) writer.i32(run.value); else writer.u32(run.value); }
      });
    }
    if (samples.some(sample => !sample.sync)) {
      const sync = samples.flatMap((sample, i) => (sample.sync ? [i + 1] : []));
      writer.full('stss', 0, 0, () => { writer.u32(sync.length); for (const number of sync) writer.u32(number); });
    }
    const perChunk = runs(chunks.map(chunk => chunk.count));
    writer.full('stsc', 0, 0, () => {
      writer.u32(perChunk.length);
      let chunkNumber = 1;
      for (const run of perChunk) { writer.u32(chunkNumber); writer.u32(run.value); writer.u32(1); chunkNumber += run.count; }
    });
    writer.full('stsz', 0, 0, () => {
      writer.u32(0);
      writer.u32(samples.length);
      for (const sample of samples) writer.u32(sample.size);
    });
    writer.full('stco', 0, 0, () => { writer.u32(chunks.length); for (const chunk of chunks) writer.u32(chunk.offset); });
  });
}

function writeMovie(clips, tracks, totalSeconds) {
  const movieTimescale = clips[0].movieTimescale;
  const movieDuration = Math.round(totalSeconds * movieTimescale);
  const writer = new Writer();
  writer.box('moov', () => {
    writer.full('mvhd', 0, 0, () => {
      writer.u32(0); writer.u32(0);
      writer.u32(movieTimescale); writer.u32(movieDuration);
      writer.u32(0x00010000); writer.u16(0x0100); writer.u16(0); writer.u32(0); writer.u32(0);
      writeMatrix(writer, clips[0].matrix);
      for (let i = 0; i < 6; i++) writer.u32(0);
      writer.u32(tracks.length + 1);
    });
    tracks.forEach((track, index) => {
      const { first } = track;
      writer.box('trak', () => {
        writer.full('tkhd', 0, first.tkhd?.flags ?? 3, () => {
          writer.u32(0); writer.u32(0);
          writer.u32(index + 1); writer.u32(0);
          writer.u32(movieDuration);
          writer.u32(0); writer.u32(0);
          writer.i16(first.tkhd?.layer || 0); writer.i16(first.tkhd?.alternate_group || 0);
          writer.u16(((first.tkhd?.volume || 0) & 255) << 8); writer.u16(0);
          writeMatrix(writer, first.tkhd?.matrix);
          writer.u32(first.tkhd?.width >>> 0 || 0); writer.u32(first.tkhd?.height >>> 0 || 0);
        });
        // Every track is shown from its start, so the movie runs from 0 to
        // exactly its declared duration.
        writer.box('edts', () => writer.full('elst', 0, 0, () => {
          writer.u32(1); writer.u32(movieDuration); writer.i32(track.mediaStart); writer.i16(1); writer.i16(0);
        }));
        writer.box('mdia', () => {
          writer.full('mdhd', 0, 0, () => {
            writer.u32(0); writer.u32(0);
            writer.u32(first.timescale); writer.u32(track.mediaDuration);
            writer.u16(first.language & 0x7fff); writer.u16(0);
          });
          writer.bytes(first.hdlr);
          writer.box('minf', () => {
            if (first.mediaHeader) writer.bytes(first.mediaHeader);
            if (first.dinf) writer.bytes(first.dinf);
            writeSampleTable(writer, track);
          });
        });
      });
    });
  });
  return writer.result();
}

/**
 * Joins MP4 clips (ArrayBuffer or typed array each) in order. Returns
 * `{ bytes, durationSeconds }`; throws VideoJoinError with `clips_incompatible`
 * when their tracks or codec setup differ, `not_mp4` for unreadable input and
 * `too_large` above `maxBytes`.
 */
export function joinMp4Clips(inputs, { maxBytes = Infinity } = {}) {
  if (!Array.isArray(inputs) || !inputs.length) throw new VideoJoinError('No clips to join.', 'not_mp4');
  const clips = inputs.map(parseClip);
  if (clips.some(clip => clip.hidesFrames)) throw incompatible('a clip hides some of its frames with an edit list');
  if (clips.some(clip => clip.startsLate)) throw incompatible('a clip has a track that starts after the clip does');
  const reference = clips[0];
  for (const clip of clips.slice(1)) {
    if (clip.tracks.length !== reference.tracks.length) throw incompatible('the clips have different tracks');
    clip.tracks.forEach((track, index) => {
      const expected = reference.tracks[index];
      if (track.handler !== expected.handler || track.timescale !== expected.timescale || !sameBytes(track.stsdKey, expected.stsdKey)) {
        throw incompatible('the clips use different codec settings');
      }
    });
  }
  const starts = [];
  let totalSeconds = 0;
  for (const clip of clips) { starts.push(totalSeconds); totalSeconds += clip.duration; }
  const tracks = reference.tracks.map((_track, index) => joinTrack(clips, index, starts));
  const payload = tracks.reduce((sum, track) => sum + track.chunks.reduce((size, chunk) => size + chunk.size, 0), 0);
  const ftyp = reference.ftyp || (() => {
    const writer = new Writer();
    writer.box('ftyp', () => { writer.type('isom'); writer.u32(0x200); for (const brand of ['isom', 'iso2', 'mp41']) writer.type(brand); });
    return writer.result();
  })();
  // Chunk offsets do not change the size of the movie box, so lay out with a
  // provisional box, then write it again with the real offsets.
  let moov = writeMovie(clips, tracks, totalSeconds);
  const total = ftyp.length + moov.length + 8 + payload;
  if (total > maxBytes) throw new VideoJoinError('The joined video is larger than WebBrain can keep in the chat.', 'too_large');
  if (total > MAX_UINT32) throw new VideoJoinError('The joined video is too large.', 'too_large');
  let offset = ftyp.length + moov.length + 8;
  const ordered = [];
  clips.forEach((_clip, clipIndex) => tracks.forEach(track => {
    const chunk = track.chunks.find(candidate => candidate.clipIndex === clipIndex);
    if (!chunk) return;
    chunk.offset = offset;
    offset += chunk.size;
    ordered.push({ track, chunk });
  }));
  moov = writeMovie(clips, tracks, totalSeconds);
  const out = new Uint8Array(total);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  const view = new DataView(out.buffer);
  let position = ftyp.length + moov.length;
  view.setUint32(position, 8 + payload);
  out.set([0x6d, 0x64, 0x61, 0x74], position + 4);
  position += 8;
  for (const { track, chunk } of ordered) {
    const source = clips[chunk.clipIndex].bytes;
    for (let i = chunk.first; i < chunk.first + chunk.count; i++) {
      const sample = track.samples[i];
      out.set(source.subarray(sample.source, sample.source + sample.size), position);
      position += sample.size;
    }
  }
  return { bytes: out, durationSeconds: totalSeconds };
}
