import { encode, temperature, imageInputs, positionMatrix, pyJSON } from './d1-preprocess.js';

export const D1_PROVIDER = 'webgpu_d1';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const checkAbort = signal => { if (signal?.aborted) throw signal.reason || new Error('D1 request cancelled.'); };
const dispose = values => { for (const value of Object.values(values || {})) value.dispose?.(); };

// Media blocks are data, never fetched from a page-chosen network URL.
export function splitD1State(state, images = []) {
  const media = [...images];
  let text = state == null ? '' : state;
  if (Array.isArray(state)) {
    text = state.filter(part => {
      if (part?.type !== 'image_url') return true;
      media.push(part.image_url?.url); return false;
    });
    if (!text.length) text = '';
  }
  if (media.length > 4 || media.some(url => typeof url !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url))) {
    throw new Error('D1 accepts at most four inline PNG/JPEG/WebP screenshots; remote image URLs are not allowed.');
  }
  if (new TextEncoder().encode(JSON.stringify([text, media])).length > 8 * 1024 * 1024) throw new Error('D1 input exceeds 8 MiB.');
  return { state: text, images: media };
}

export function d1Answers(questions, probabilities, width) {
  const answers = Object.create(null);
  const entries = Array.isArray(questions) ? questions : Object.entries(questions);
  entries.forEach(([id, question], row) => {
    const names = question.type === 'noul' ? ['no', 'yes'] : question.type === 'score' ? question.criteria.map((_, i) => String(i)) : Object.keys(question.criteria);
    const values = Array.from(probabilities.slice(row * width, row * width + names.length), Number);
    if (values.length !== names.length || values.some(value => !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(values.reduce((a, b) => a + b, 0) - 1) > .001) throw new Error('Invalid D1 probability output.');
    const selected = values.indexOf(Math.max(...values));
    if (question.type === 'noul') answers[id] = { type: 'noul', noul: values[1] };
    else {
      const common = { type: question.type, confidence: values[selected], probabilities: Object.fromEntries(names.map((name, i) => [name, values[i]])) };
      answers[id] = question.type === 'choice' ? { ...common, choice: names[selected] } : { ...common, score: values.reduce((sum, p, i) => sum + p * i, 0), legend: Object.fromEntries(names.map((name, i) => [name, typeof question.criteria[i] === 'string' ? question.criteria[i] : pyJSON(question.criteria[i])])) };
    }
  });
  return answers;
}

export function d1RowBatches(rows, mediaLength, maxTokens = 65536) {
  const order = rows.map((_, i) => i).sort((a, b) => rows[b].input_ids.length - rows[a].input_ids.length), batches = [];
  while (order.length) {
    const longest = rows[order[0]].input_ids.length + mediaLength;
    let size = 1; while (size < order.length && (size + 1) * longest <= maxTokens) size++;
    batches.push(order.splice(0, size));
  }
  return batches;
}

export function createD1Runtime({ ort, tokenizer, config, ratios, sessions, device, model }) {
  if (!sessions?.decision || !sessions?.vision || !sessions?.projector) throw new Error('D1 requires all three FP32 sessions.');
  const tensor = (type, data, shape) => new ort.Tensor(type, data, shape);
  async function mediaPrefix(images, signal) {
    const chunks = [], layouts = [];
    for (const url of images) {
      checkAbort(signal);
      const image = await imageInputs(url, ratios), crops = image.shapes.length;
      const positions = new Float32Array(crops * 1024 * 256);
      image.shapes.forEach(([h, w], i) => positions.set(positionMatrix(h, w), i * 1024 * 256));
      const feeds = { pixel_values: tensor('float32', image.pixels, [crops, 1024, 768]), pixel_mask: tensor('bool', Uint8Array.from(image.mask), [crops, 1024]), position_matrix: tensor('float32', positions, [crops, 1024, 256]) };
      let output;
      try {
        output = await sessions.vision.run(feeds); checkAbort(signal);
        const hidden = await output.hidden.getData();
        for (let crop = 0; crop < crops; crop++) {
          const [h, w] = image.shapes[crop];
          const input = tensor('float32', hidden.slice(crop * 1024 * 768, crop * 1024 * 768 + h * w * 768), [1, h, w, 768]);
          let projected;
          try { projected = await sessions.projector.run({ hidden: input }); chunks.push(new Float32Array(await projected.prefix.getData())); checkAbort(signal); }
          finally { input.dispose?.(); dispose(projected); }
        }
      } finally { dispose(feeds); dispose(output); }
      layouts.push({ ...image.plan, shapes: image.shapes });
    }
    const prefix = new Float32Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0; for (const chunk of chunks) { prefix.set(chunk, offset); offset += chunk.length; }
    return { prefix, layouts };
  }
  return {
    async evaluate({ state = '', images = [], questions, signal } = {}) {
      checkAbort(signal);
      if (!record(questions) || !Object.keys(questions).length || Object.keys(questions).length > 32) throw new Error('D1 requires 1 to 32 named questions.');
      const input = splitD1State(state, images);
      const { prefix, layouts } = await mediaPrefix(input.images, signal), mediaLength = prefix.length / 1024;
      const limit = Math.min(input.images.length ? config.image_text_length : config.max_length, config.max_length - mediaLength);
      if (!Number.isInteger(mediaLength) || limit < 64) throw new Error('D1 media exceed the source context budget.');
      const entries = Object.entries(questions), rows = entries.map(([, q]) => encode(tokenizer, input.state, q, limit, input.images.length > 0));
      const answers = Object.create(null), batches = [];
      for (const indices of d1RowBatches(rows, mediaLength)) {
      const selectedRows = indices.map(i => rows[i]), selectedEntries = indices.map(i => entries[i]);
      const batch = selectedRows.length, length = Math.max(...selectedRows.map(row => row.input_ids.length)), width = Math.max(...selectedRows.map(row => row.markers.length));
      const ids = new BigInt64Array(batch * length), mask = new Uint8Array(batch * length), markers = new BigInt64Array(batch * width), markerMask = new Uint8Array(batch * width), media = new Float32Array(batch * prefix.length);
      ids.fill(BigInt(tokenizer.pad_token_id ?? 0));
      selectedRows.forEach((row, i) => {
        ids.set(row.input_ids.map(BigInt), i * length); mask.fill(1, i * length, i * length + row.input_ids.length);
        markers.set(row.markers.map(BigInt), i * width); markerMask.fill(1, i * width, i * width + row.markers.length); media.set(prefix, i * prefix.length);
      });
      const feeds = { input_ids: tensor('int64', ids, [batch, length]), text_mask: tensor('bool', mask, [batch, length]), marker_pos: tensor('int64', markers, [batch, width]), marker_mask: tensor('bool', markerMask, [batch, width]), qtype: tensor('int64', BigInt64Array.from(selectedEntries, ([, q]) => BigInt({ choice: 0, score: 1, noul: 2 }[q.type])), [batch]), temperature: tensor('float32', Float32Array.from(selectedEntries, ([, q]) => temperature(q, config, input.images.length > 0)), [batch]), media_prefix: tensor('float32', media, [batch, mediaLength, 1024]) };
      let output;
      try {
        checkAbort(signal); output = await sessions.decision.run(feeds);
        const probabilities = await output.probabilities.getData(); await device?.queue.onSubmittedWorkDone(); checkAbort(signal);
        Object.assign(answers, d1Answers(selectedEntries, probabilities, width));
        batches.push({ question_ids: selectedEntries.map(([id]) => id), batch, text_length: length, options: width });
      } finally { dispose(feeds); dispose(output); }
      }
      return { model, provider: D1_PROVIDER, answers: Object.fromEntries(entries.map(([id]) => [id, answers[id]])), usage: { input_tokens: rows.reduce((sum, row) => sum + row.input_ids.length + mediaLength, 0), output_tokens: 0 }, diagnostics: { dtype: 'float32', generated_tokens: 0, batch: rows.length, text_length: Math.max(...rows.map(row => row.input_ids.length)), media_length: mediaLength, layouts, batches, source_batch_token_budget: 65536, cpu_fallback_policy: 'CPU/WASM control/shape operators allowed; actual placement requires a separate profile.' } };
    },
    async dispose() { for (const session of Object.values(sessions)) await session.release(); device?.destroy(); },
  };
}
