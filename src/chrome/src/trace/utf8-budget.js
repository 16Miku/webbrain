const UTF8_ENCODER = new TextEncoder();

export function utf8ByteLength(value) {
  return UTF8_ENCODER.encode(String(value ?? '')).length;
}

function safePrefixEnd(text, end) {
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xD800 && previous <= 0xDBFF
    && next >= 0xDC00 && next <= 0xDFFF
    ? end - 1
    : end;
}

// Return the longest code-point-safe prefix whose serialized representation
// fits maxBytes. The serializer lets callers include truncation-marker
// overhead and JSON escaping in the same UTF-8 byte boundary.
export function fitUtf8Prefix(value, maxBytes, serializePrefix = prefix => prefix) {
  const text = String(value ?? '');
  const limit = Math.max(0, Number(maxBytes) || 0);
  let low = 0;
  let high = text.length;
  let bestEnd = 0;

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const end = safePrefixEnd(text, midpoint);
    const serialized = serializePrefix(text.slice(0, end));
    if (utf8ByteLength(serialized) <= limit) {
      bestEnd = Math.max(bestEnd, end);
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return text.slice(0, bestEnd);
}
