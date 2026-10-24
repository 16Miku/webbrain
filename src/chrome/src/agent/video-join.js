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
// Silence fills gaps in the sound, as long as the clips run: clips that claim
// to run for hours are not joined.
const MAX_SECONDS = 3600;

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

// A silent frame for AAC-LC (mono or stereo, 1024 samples), to fill gaps in a
// clip's sound so it plays continuously: players such as Chrome time audio by
// the samples they play, so a gap in timestamps would shift the sound against
// the picture. The frame is one channel element with an empty spectrum
// (max_sfb 0). Other codecs have none (null), and their tracks are joined as
// video tracks are.
const SILENT_AAC_FRAMES = { 1: Uint8Array.of(0x00, 0x00, 0x00, 0x07), 2: Uint8Array.of(0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0e) };
const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function silentFrame(entry, timescale) {
  if (entry?.type !== 'mp4a') return null;
  const config = entry.esds?.esd?.descs?.find(desc => desc.tag === 4)?.descs?.find(desc => desc.tag === 5)?.data;
  if (!config || config.length < 2) return null;
  const objectType = config[0] >> 3;
  const rate = AAC_SAMPLE_RATES[((config[0] & 7) << 1) | (config[1] >> 7)];
  const channels = (config[1] >> 3) & 15;
  // AAC-LC with 1024-sample frames and no core coder; only an explicit
  // "no SBR" extension may follow.
  if (objectType !== 2 || !rate || !SILENT_AAC_FRAMES[channels] || (config[1] & 0x06)) return null;
  if (config.length > 2) {
    const syncExtension = (config[2] << 3) | (config[3] >> 5);
    const extensionType = config[3] & 0x1f;
    if (config.length < 5 || syncExtension !== 0x2b7 || extensionType !== 5 || (config[4] & 0x80)) return null;
  }
  const duration = 1024 * timescale / rate;
  return Number.isInteger(duration) ? { bytes: SILENT_AAC_FRAMES[channels], duration } : null;
}

function readTrack(trak, movieTimescale, bytes) {
  const mdia = trak?.mdia, minf = mdia?.minf, stbl = minf?.stbl;
  const handler = mdia?.hdlr?.handler;
  const timescale = mdia?.mdhd?.timescale;
  const samples = Array.isArray(trak?.samples) ? trak.samples : [];
  if (!stbl?.stsd || !(timescale > 0) || !samples.length) throw incompatible('a track has no samples');
  if (samples.some(sample => sample.offset + sample.size > bytes.length)) {
    throw new VideoJoinError('The clip is incomplete: its samples run past the end of the file.', 'not_mp4');
  }
  if ((stbl.stsd.entries?.length || 0) !== 1 || samples.some(sample => sample.description_index !== 0)) {
    throw incompatible('a track switches codec settings');
  }
  // Encrypted samples need their per-sample keys and IVs, which are not
  // carried over; samples kept in another file cannot be copied from this one.
  if (/^enc[a-z]$/.test(stbl.stsd.entries[0]?.type || '')) throw incompatible('a track is encrypted');
  if ((minf.dinf?.dref?.entries || []).some(entry => !(entry.flags & 1))) throw incompatible('a track keeps its samples in another file');
  // Sample groups, such as an audio codec's pre-roll for seeking: each
  // sample's group in this clip, and the groups' description box.
  const groups = (stbl.sbgps || []).flatMap(sbgp => {
    const description = rawBox(bytes, (stbl.sgpds || []).find(sgpd => sgpd.grouping_type === sbgp.grouping_type));
    if (!description) return [];
    const indices = new Array(samples.length).fill(0);
    let next = 0;
    for (const entry of sbgp.entries || []) {
      for (let n = 0; n < entry.sample_count && next < indices.length; n++) indices[next++] = entry.group_description_index;
    }
    return [{ type: sbgp.grouping_type, parameter: sbgp.grouping_type_parameter || 0, indices, description }];
  });
  // Reordered frames (B-frames) are shown after they are decoded, so the
  // track's picture ends at its last composition time, not its last decode time.
  const compositionEnd = samples.reduce((end, sample) => Math.max(end, sample.cts + sample.duration), 0);
  // One edit that skips the codec's start-up delay is normal, and so is an
  // empty edit before it (a track that starts late). Other edit lists describe
  // a timeline these tables cannot carry over.
  const edits = trak.edts?.elst?.entries || [];
  const empty = edits.length === 2 && edits[0].media_time === -1 ? edits[0] : null;
  const media = edits[empty ? 1 : 0];
  if (edits.length > (empty ? 2 : 1)
      || (media && (media.media_time < 0 || media.media_rate_integer !== 1 || media.media_rate_fraction))) {
    throw incompatible('a track has a complex edit list');
  }
  const ticks = movieTicks => Math.round(movieTicks * timescale / movieTimescale);
  const delay = empty ? ticks(empty.segment_duration) : 0;
  const editDuration = media && media.segment_duration > 0 ? ticks(media.segment_duration) : Infinity;
  return {
    handler,
    timescale,
    samples,
    hasEdit: !!media,
    // The media time the movie shows at its start, before any lead.
    editStart: (media ? media.media_time : 0) - delay,
    editDuration,
    editEnd: media ? media.media_time + editDuration : Infinity,
    silence: handler === 'soun' ? silentFrame(stbl.stsd.entries[0], timescale) : null,
    firstComposition: samples.reduce((min, sample) => Math.min(min, sample.cts), Infinity),
    compositionEnd,
    tkhd: trak.tkhd,
    language: mdia.mdhd.language,
    stsd: rawBox(bytes, stbl.stsd),
    stsdKey: sampleDescriptionKey(bytes, stbl.stsd),
    groups,
    groupsKey: JSON.stringify(groups.map(group => [group.type, group.parameter, Array.from(group.description)])),
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
  // What would keep this clip from being laid end to end with others:
  // - its first frame must decode without the previous clip's frames;
  // - an edit list that hides whole frames before or after the picture keeps
  //   them in the file, where a join would play them over the next clip;
  // - a track whose first sample comes after the clip's start needs a leading
  //   gap: silent frames fill it where the codec allows, as long as the sound
  //   starts before the clip ends; otherwise one edit cannot show more than a
  //   millisecond of it;
  // - a track whose own edit hides more than one of its frames at the end
  //   would play that sound on into the next clip in the joined file.
  const pictureEnd = timing.mediaTime + presented;
  const startsLate = track => {
    const late = track.samples[0].dts - track.mediaTime;
    return track.silence ? late >= presented / timing.timescale * track.timescale : late > track.timescale / 1000;
  };
  const endsEarly = track => track.compositionEnd - track.editEnd
    > track.samples.reduce((longest, sample) => Math.max(longest, sample.duration), 0);
  const problem = timing.samples[0].is_sync === false ? 'does not start with a keyframe'
    : timing.samples.some(sample => sample.duration > 0
      && (sample.cts + sample.duration <= timing.mediaTime || sample.cts >= pictureEnd)) ? 'hides some of its frames with an edit list'
      : tracks.some(startsLate) ? 'has a track that starts after the clip does'
        : tracks.some(endsEarly) ? 'ends a track early with an edit list'
          : null;
  return {
    bytes,
    movieTimescale,
    matrix: moov.mvhd.matrix,
    ftyp: rawBox(bytes, (file.boxes || []).find(box => box.type === 'ftyp')),
    tracks,
    duration: presented / timing.timescale,
    problem,
  };
}

/** Presented length of an MP4 in seconds, or null when it is not one. */
export function mp4DurationSeconds(input) {
  try { return parseClip(input).duration; } catch { return null; }
}

// Lays out one output track: each clip's samples in order, so that each clip
// starts where the timeline says. At each join the audio follows the picture:
// a later clip's codec start-up frames (those that would mostly play before
// the clip starts) are dropped, and so are the previous clip's frames that
// would mostly play after this clip's sound begins (padding, or sound longer
// than the picture). Video frames are never dropped.
//
// Where the codec has a silent frame (AAC-LC), the sound is laid out as the
// frames a player plays: each frame at its full length, one after another,
// with silent frames wherever a clip's timeline runs ahead (sound shorter than
// the picture, sound that starts late, gaps in a clip's own timing). Every
// frame then plays within half a frame of its time, and the sound stays with
// the picture in players that time audio by the samples they play. A clip's
// start-up frames stay right before its first frame where there is room for
// them, so that frame decodes as it was encoded. Otherwise the previous clip's
// last sample is lengthened or shortened to meet the next clip, as it is for
// video.
function joinTrack(clips, index, starts) {
  const first = clips[0].tracks[index];
  const silence = clips.every(clip => clip.tracks[index].silence) ? first.silence : null;
  const frame = silence?.duration;
  const samples = [];
  const chunks = [];
  // The media time the output's edit starts at: where the first clip's start
  // falls in the output (fragmented files can start at any decode time).
  let mediaStart = 0;
  let dts = 0;
  clips.forEach((clip, clipIndex) => {
    const track = clip.tracks[index];
    const audio = track.handler === 'soun';
    const laidOut = audio && !!silence;
    const startup = audio ? track.samples.findIndex(sample => sample.cts + sample.duration / 2 >= track.mediaTime) : 0;
    if (startup < 0) throw incompatible('a clip has an empty track');
    const kept = track.samples.slice(clipIndex > 0 || laidOut ? startup : 0);
    // Where the clip's first kept sample goes, and how many frames (silence,
    // then the clip's own start-up frames) come right before it.
    let base = 0;
    let gap = 0;
    if (clipIndex === 0) {
      if (laidOut) {
        // Whole frames before a sound that starts late, enough to reach its start.
        gap = Math.max(startup, Math.ceil((kept[0].cts - track.mediaTime) / frame));
        base = gap * frame;
        mediaStart = base - (kept[0].cts - track.mediaTime);
      } else {
        mediaStart = Math.max(0, track.mediaTime - track.samples[0].dts);
      }
    } else {
      base = Math.round(starts[clipIndex] * track.timescale) + (kept[0].dts - track.mediaTime) + mediaStart;
      const previous = chunks[chunks.length - 1];
      while (audio && previous.count > 1
          && samples[samples.length - 1].dts + samples[samples.length - 1].duration / 2 >= base) {
        previous.count -= 1;
        previous.size -= samples.pop().size;
      }
      const last = samples[samples.length - 1];
      if (laidOut) {
        dts = last.dts + last.duration;
        gap = Math.max(0, Math.round((base - dts) / frame));
      } else {
        // Decode times only move forward. A clip that must start decoding
        // before the previous clip's last frame (a longer composition delay)
        // cannot follow it without moving its picture.
        if (base <= last.dts) throw incompatible('a clip would start decoding before the previous one ends');
        last.duration = base - last.dts;
        dts = base;
      }
    }
    const chunk = { clipIndex, first: samples.length, count: 0, size: 0, offset: 0 };
    chunks.push(chunk);
    const push = sample => {
      samples.push(sample);
      chunk.count += 1;
      chunk.size += sample.size;
      dts += sample.duration;
    };
    const copy = (sample, duration) => push({
      dts,
      duration,
      offset: sample.cts - sample.dts,
      size: sample.size,
      source: sample.offset,
      sync: sample.is_sync !== false,
      groups: track.groups.map(group => group.indices[sample.number] ?? 0),
      clipIndex,
    });
    const quiet = () => push({ dts, duration: frame, offset: 0, size: silence.bytes.length, data: silence.bytes,
      sync: true, groups: first.groups.map(() => 0), clipIndex });
    for (let k = gap; k > 0; k--) {
      if (k <= startup) copy(track.samples[startup - k], frame);
      else quiet();
    }
    // Where the clip ends in the output: its frames that would start later
    // would play over the next clip, or after the video ends, so they are dropped.
    const end = Math.round((starts[clipIndex] + clip.duration) * track.timescale) + mediaStart;
    for (const [i, sample] of kept.entries()) {
      if (laidOut) {
        const target = base + sample.dts - kept[0].dts;
        if (i > 0 && target >= end) break;
        // Silence up to where this frame belongs.
        for (let k = Math.round((target - dts) / frame); k > 0; k--) quiet();
      }
      // An AAC-LC frame plays 1024 samples, even a clip's last one that its
      // sample table shortens to where the clip's sound ends; only the joined
      // video's very last frame keeps its own length.
      const final = clipIndex === clips.length - 1 && i === kept.length - 1;
      copy(sample, laidOut && !final ? frame : sample.duration);
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
    const described = new Set();
    first.groups.forEach((group, index) => {
      // One description box per grouping type, however many sbgp boxes use it.
      if (!described.has(group.type)) writer.bytes(group.description);
      described.add(group.type);
      const members = runs(samples.map(sample => sample.groups[index]));
      writer.full('sbgp', group.parameter ? 1 : 0, 0, () => {
        writer.type(group.type);
        if (group.parameter) writer.u32(group.parameter);
        writer.u32(members.length);
        for (const run of members) { writer.u32(run.count); writer.u32(run.value); }
      });
    });
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
  const problem = clips.find(clip => clip.problem)?.problem;
  if (problem) throw incompatible(`a clip ${problem}`);
  const reference = clips[0];
  // The joined file shows every clip at the first clip's size and angle.
  const placement = (matrix, tkhd) => JSON.stringify([Array.from(matrix || []), tkhd?.width, tkhd?.height, Array.from(tkhd?.matrix || [])]);
  for (const clip of clips.slice(1)) {
    if (clip.tracks.length !== reference.tracks.length) throw incompatible('the clips have different tracks');
    clip.tracks.forEach((track, index) => {
      const expected = reference.tracks[index];
      if (track.handler !== expected.handler || track.timescale !== expected.timescale
          || !sameBytes(track.stsdKey, expected.stsdKey) || track.groupsKey !== expected.groupsKey) {
        throw incompatible('the clips use different codec settings');
      }
      if (placement(clip.matrix, track.tkhd) !== placement(reference.matrix, expected.tkhd)) {
        throw incompatible('the clips are shown at different sizes or angles');
      }
    });
  }
  const starts = [];
  let totalSeconds = 0;
  for (const clip of clips) { starts.push(totalSeconds); totalSeconds += clip.duration; }
  if (totalSeconds > MAX_SECONDS) throw new VideoJoinError('The joined video would be longer than an hour.', 'too_large');
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
      out.set(sample.data || source.subarray(sample.source, sample.source + sample.size), position);
      position += sample.size;
    }
  }
  return { bytes: out, durationSeconds: totalSeconds };
}
