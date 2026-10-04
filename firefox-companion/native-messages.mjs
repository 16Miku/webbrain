// Firefox caps each native-host message at 1 MiB. PNGs routinely exceed it.
// Chunk the serialized reply, keeping framing independent of screenshot content.
export function* nativeReplyMessages(value) {
  const serialized = JSON.stringify(value);
  if (serialized.length > 32 * 1024 * 1024) throw new Error('Screenshot exceeds the 32 MiB transfer limit');
  if (Buffer.byteLength(serialized) < 512 * 1024) {
    yield value;
    return;
  }
  const size = 128 * 1024;
  for (let offset = 0, index = 0; offset < serialized.length; offset += size, index++) {
    yield { id: value.id, chunk: serialized.slice(offset, offset + size), index, last: offset + size >= serialized.length };
  }
}
