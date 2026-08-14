/**
 * Cryptographically random base-36 tokens.
 *
 * Shared so the dispatch-binding markers, untrusted-content nonces, workflow
 * ids and conversation ids cannot drift apart — this used to be copied into
 * four modules per build.
 *
 * `byte % 36` over 0–255 favours the first four digits (8 chances in 256
 * against 7 for the rest), which quietly costs entropy in the nonce that
 * delimits untrusted page content. Discarding the bytes above the last whole
 * multiple of 36 removes the skew; the rejected slice is small enough that
 * the extra draws are noise.
 */
const BASE36_REJECTION_LIMIT = 252; // 36 * 7 — largest whole multiple in a byte

export function secureRandomBase36Token(length = 8) {
  const size = Math.max(1, Math.floor(Number(length) || 0));
  let out = '';
  while (out.length < size) {
    const bytes = new Uint8Array(size - out.length);
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= BASE36_REJECTION_LIMIT) continue;
      out += (byte % 36).toString(36);
    }
  }
  return out;
}
