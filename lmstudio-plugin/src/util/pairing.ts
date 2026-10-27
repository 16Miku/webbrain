/**
 * Pairing key — the shared secret that authenticates the extension's socket.
 *
 * Standalone copy of `mcp-server/src/pairing.ts` (the two packages ship to
 * different registries; see bridgeClient.ts). Change both, and the proof in
 * the extension's `cloud-bridge.js`, together.
 *
 * The Origin header and the `client: "webbrain-extension"` hello are both
 * forgeable by any local process. The bridge therefore sends every new socket
 * a random nonce and accepts it only after it answers with
 * HMAC-SHA256(key, label + nonce). The key never crosses the socket.
 *
 * Where the key comes from, first match wins: `WEBBRAIN_BRIDGE_KEY`, the file
 * named by `WEBBRAIN_BRIDGE_KEY_FILE`, then `~/.webbrain/bridge-key` (created
 * with owner-only permissions on first use). The MCP server reads the same
 * default file, so one pairing covers both bridges.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PAIRING_SCHEME = "hmac-sha256-v1";
const PROOF_LABEL = "webbrain-bridge-pairing-v1:";
export const MIN_PAIRING_KEY_LENGTH = 16;

/** WebSocket close code for a socket that failed or skipped pairing. The extension stops reconnecting on it. */
export const PAIRING_CLOSE_CODE = 4001;

export interface PairingKey {
  key: string;
  /** Where the key came from, for setup messages. Never the key itself. */
  source: string;
}

export function defaultPairingKeyFile(): string {
  return join(homedir(), ".webbrain", "bridge-key");
}

export function validatePairingKey(raw: string, source: string): string {
  const key = raw.trim();
  if (key.length < MIN_PAIRING_KEY_LENGTH) {
    throw new Error(`${source} must contain a pairing key of at least ${MIN_PAIRING_KEY_LENGTH} characters.`);
  }
  return key;
}

function readKeyFile(file: string): PairingKey {
  return { key: validatePairingKey(readFileSync(file, "utf8"), file), source: file };
}

/** Resolve the pairing key, creating the default key file on first use. */
export function loadPairingKey(env: NodeJS.ProcessEnv = process.env): PairingKey {
  if (env.WEBBRAIN_BRIDGE_KEY) {
    return { key: validatePairingKey(env.WEBBRAIN_BRIDGE_KEY, "WEBBRAIN_BRIDGE_KEY"), source: "WEBBRAIN_BRIDGE_KEY" };
  }
  const file = env.WEBBRAIN_BRIDGE_KEY_FILE || defaultPairingKeyFile();
  try {
    return readKeyFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString("base64url");
  try {
    // `wx` never replaces an existing file: when the MCP server created it
    // first, use that key instead of forking pairings.
    writeFileSync(file, `${key}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readKeyFile(file);
  }
  return { key, source: file };
}

export function newPairingNonce(): string {
  return randomBytes(32).toString("base64url");
}

/** Hex HMAC the extension must return for `nonce`. */
export function pairingProof(key: string, nonce: string): string {
  return createHmac("sha256", key).update(PROOF_LABEL + nonce).digest("hex");
}

export function verifyPairingProof(key: string, nonce: string, proof: unknown): boolean {
  if (typeof proof !== "string") return false;
  const expected = Buffer.from(pairingProof(key, nonce));
  const actual = Buffer.from(proof);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
