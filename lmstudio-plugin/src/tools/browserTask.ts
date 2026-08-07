/**
 * browser_task — delegate a web task to the user's real browser session.
 *
 * This is the capability `fetch_url` and `research_url` structurally cannot
 * provide. They are pure HTTP: no cookies, no session, no JavaScript. Anything
 * behind a login, or any page that hydrates client-side, is invisible to them.
 * The WebBrain extension runs inside the browser the user is already signed
 * into, so it sees exactly what they see.
 *
 * Scope is task-level on purpose. WebBrain's permission gate lives in its agent
 * loop, not in its individual tool dispatch — exposing the low-level primitives
 * over a socket would move the trust boundary out of the browser and defeat the
 * approval prompts. Delegating a goal keeps every gate intact.
 */

import {
  BridgeError,
  TERMINAL_STATUSES,
  sharedBridge,
  type CloudSnapshot,
} from "../util/bridgeClient.js";

export interface BrowserTaskArgs {
  task: string;
  mode?: "ask" | "act";
  timeout?: number;
  allowApiMutations?: boolean;
}

export interface BrowserTaskResult {
  ok: boolean;
  runId?: string;
  status?: string;
  needsUserInput?: boolean;
  question?: string;
  clarifyId?: string;
  stillRunning?: boolean;
  finalUrl?: string;
  text?: string;
  error?: string;
  hint?: string;
}

const POLL_INTERVAL_MS = 1_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bodyOf(snapshot: CloudSnapshot): string {
  if (snapshot.result !== undefined && snapshot.result !== null) {
    return typeof snapshot.result === "string"
      ? snapshot.result
      : JSON.stringify(snapshot.result, null, 2);
  }
  return snapshot.content || snapshot.summary || "";
}

export async function browserTask(args: BrowserTaskArgs): Promise<BrowserTaskResult> {
  const bridge = sharedBridge();
  const mode = args.mode === "act" ? "act" : "ask";
  const timeoutMs = Math.min(Math.max(args.timeout ?? 180_000, 5_000), 3_600_000);

  try {
    await bridge.ensureStarted();

    if (!bridge.isConnected()) {
      // Give a reconnecting extension a beat before declaring failure.
      await bridge.waitForExtension(2_000);
    }
    if (!bridge.isConnected()) {
      return {
        ok: false,
        error: "WebBrain browser extension not connected.",
        hint: bridge.notConnectedMessage(),
      };
    }

    const payload: Record<string, unknown> = { task: args.task, mode };
    if (args.allowApiMutations) payload.apiMutationsAllowed = true;

    const started = await bridge.request<CloudSnapshot>("cloud_run", payload);
    const runId = started.runId;

    const deadline = Date.now() + timeoutMs;
    let snapshot: CloudSnapshot = started;

    while (Date.now() < deadline) {
      if (TERMINAL_STATUSES.has(snapshot.status) || snapshot.status === "needs_user_input") break;
      await sleep(POLL_INTERVAL_MS);
      const polled = await bridge.request<CloudSnapshot | { runs: CloudSnapshot[] }>(
        "cloud_status",
        { runId },
      );
      if ((polled as { runs?: CloudSnapshot[] }).runs) continue;
      snapshot = polled as CloudSnapshot;
    }

    if (snapshot.status === "needs_user_input") {
      const pending = snapshot.pendingInput ?? {};
      return {
        ok: false,
        runId,
        status: snapshot.status,
        needsUserInput: true,
        question: String(pending.question ?? "(no question text supplied)"),
        clarifyId: String(pending.clarifyId ?? pending.clarify_id ?? ""),
        hint:
          "WebBrain paused because a human decision is required. Ask the user this " +
          "question and answer it in the WebBrain side panel — do not guess on their behalf.",
      };
    }

    if (!TERMINAL_STATUSES.has(snapshot.status)) {
      return {
        ok: false,
        runId,
        status: snapshot.status,
        stillRunning: true,
        hint:
          `The task is still running in the browser after ${Math.round(timeoutMs / 1000)}s. ` +
          "It was NOT cancelled — watch the WebBrain side panel, or raise `timeout`.",
      };
    }

    if (snapshot.status !== "completed") {
      return {
        ok: false,
        runId,
        status: snapshot.status,
        error: snapshot.error || `Run ended with status '${snapshot.status}'.`,
        finalUrl: snapshot.finalUrl,
      };
    }

    return {
      ok: true,
      runId,
      status: snapshot.status,
      finalUrl: snapshot.finalUrl,
      text: bodyOf(snapshot),
    };
  } catch (error) {
    if (error instanceof BridgeError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Lightweight connectivity probe so the model can explain a failure precisely. */
export async function browserStatus(): Promise<{
  connected: boolean;
  listeningOn: string;
  hint?: string;
}> {
  const bridge = sharedBridge();
  try {
    await bridge.ensureStarted();
    if (!bridge.isConnected()) await bridge.waitForExtension(1_500);
  } catch (error) {
    return {
      connected: false,
      listeningOn: bridge.url,
      hint: `Could not open the bridge listener: ${
        error instanceof Error ? error.message : String(error)
      }. Another process may already hold that port.`,
    };
  }
  return bridge.isConnected()
    ? { connected: true, listeningOn: bridge.url }
    : { connected: false, listeningOn: bridge.url, hint: bridge.notConnectedMessage() };
}
