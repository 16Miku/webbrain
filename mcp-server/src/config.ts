/**
 * Runtime configuration, all environment-driven.
 *
 * The bridge port intentionally defaults to 17374, NOT 17373. WebBrain Cloud's
 * sidecar owns 17373, and `cloud-bridge.js` holds exactly one outbound socket —
 * so the extension can be pointed at Cloud or at this server, never both. Using
 * a distinct port keeps the failure mode obvious ("nothing connected") instead
 * of two processes fighting over one listener.
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${name} must be a valid TCP port, got: ${raw}`);
  }
  return parsed;
}

export const config = {
  /** Port this process listens on for the extension's outbound bridge socket. */
  bridgePort: intFromEnv("WEBBRAIN_BRIDGE_PORT", 17374),

  /** Path segment the extension connects to. Must match the URL set in WebBrain settings. */
  bridgePath: process.env.WEBBRAIN_BRIDGE_PATH || "/extension",

  /**
   * How long to wait for the extension to answer a single bridge command.
   * Starting a run returns immediately; this is not the task timeout.
   */
  commandTimeoutMs: intFromEnv("WEBBRAIN_COMMAND_TIMEOUT_MS", 30_000),

  /** Default ceiling for how long `webbrain_run` will poll before giving up. */
  defaultRunTimeoutMs: intFromEnv("WEBBRAIN_RUN_TIMEOUT_MS", 300_000),

  /** Interval between `cloud_status` polls while a run is in flight. */
  pollIntervalMs: intFromEnv("WEBBRAIN_POLL_INTERVAL_MS", 1_000),
} as const;

/** The URL the user must paste into WebBrain → Settings → Cloud bridge. */
export function bridgeUrl(): string {
  return `ws://127.0.0.1:${config.bridgePort}${config.bridgePath}`;
}
