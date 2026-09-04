/**
 * Run orchestration.
 *
 * `cloud_run` returns as soon as the run is registered — the actual work happens
 * in a detached async IIFE inside the extension (`cloud-runs.js`). So starting a
 * task gives us a snapshot with status 'running', and we poll `cloud_status`
 * until it reaches a terminal state or stops to ask the user something.
 *
 * Important: every tool call still travels the full agent loop inside the
 * extension (`agent.processMessage` -> `_executeToolBatch`), which means the
 * capability x origin permission gate is enforced exactly as it is for a human
 * driving the side panel. This server deliberately does NOT expose the
 * individual browser primitives — `executeTool()` has no gate of its own, and
 * calling it directly would move the trust boundary out of the browser.
 */

import { BridgeError, TERMINAL_STATUSES, WebBrainBridge, type CloudSnapshot } from "./bridge.js";
import { config } from "./config.js";

export interface StartRunOptions {
  runId?: string;
  task: string;
  mode: "ask" | "act";
  tabId?: number;
  apiMutationsAllowed?: boolean;
  outputSchema?: unknown;
}

export interface AwaitOptions {
  timeoutMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startRun(
  bridge: WebBrainBridge,
  options: StartRunOptions,
  timeoutMs?: number,
): Promise<CloudSnapshot> {
  if (options.apiMutationsAllowed && options.mode !== "act") {
    throw new BridgeError("API mutation permission requires mode 'act'.", 400);
  }

  const payload: Record<string, unknown> = {
    task: options.task,
    mode: options.mode,
  };
  if (options.runId) payload.runId = options.runId;
  if (options.tabId != null) payload.tabId = options.tabId;
  if (options.apiMutationsAllowed) payload.apiMutationsAllowed = true;
  if (options.outputSchema != null) payload.outputSchema = options.outputSchema;

  return await bridge.request<CloudSnapshot>("cloud_run", payload, timeoutMs);
}

export async function getStatus(
  bridge: WebBrainBridge,
  runId?: string,
  timeoutMs?: number,
): Promise<CloudSnapshot | { runs: CloudSnapshot[] }> {
  const payload = runId ? { runId } : {};
  return await bridge.request<CloudSnapshot | { runs: CloudSnapshot[] }>(
    "cloud_status",
    payload,
    timeoutMs,
  );
}

export async function respond(
  bridge: WebBrainBridge,
  runId: string,
  clarifyId: string,
  answer: string,
  timeoutMs?: number,
): Promise<CloudSnapshot> {
  return await bridge.request<CloudSnapshot>(
    "cloud_respond",
    { runId, clarifyId, answer },
    timeoutMs,
  );
}

export async function abort(bridge: WebBrainBridge, runId: string): Promise<CloudSnapshot> {
  return await bridge.request<CloudSnapshot>("cloud_abort", { runId });
}

/**
 * Poll until the run finishes, needs the user, or we run out of patience.
 *
 * A timeout here does NOT abort the run — the browser keeps working and the
 * caller can resume with `webbrain_status`. Silently killing a half-finished
 * task that may have already submitted a form would be worse than reporting
 * that it is still going.
 */
export async function awaitSettled(
  bridge: WebBrainBridge,
  runId: string,
  { timeoutMs }: AwaitOptions,
): Promise<{ snapshot: CloudSnapshot; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: CloudSnapshot = { runId, status: "running" };

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    let result: CloudSnapshot | { runs: CloudSnapshot[] };
    try {
      result = await getStatus(bridge, runId, remainingMs);
    } catch (error) {
      if (
        Date.now() >= deadline ||
        (error instanceof BridgeError &&
          (error.code === "COMMAND_TIMEOUT" || error.code === "COMMAND_INTERRUPTED"))
      ) {
        return { snapshot: last, timedOut: true };
      }
      throw error;
    }
    const snapshot = (result as { runs?: CloudSnapshot[] }).runs
      ? null
      : (result as CloudSnapshot);

    if (!snapshot) continue;
    last = snapshot;

    if (TERMINAL_STATUSES.has(snapshot.status) || snapshot.status === "needs_user_input") {
      return { snapshot, timedOut: false };
    }

    await sleep(Math.min(config.pollIntervalMs, Math.max(0, deadline - Date.now())));
  }

  return { snapshot: last, timedOut: true };
}

/** Render a snapshot as the text an calling agent actually needs to read. */
export function describeSnapshot(snapshot: CloudSnapshot, timedOut = false): string {
  const lines: string[] = [];
  lines.push(`run_id: ${snapshot.runId}`);
  lines.push(`status: ${snapshot.status}${timedOut ? " (still running — poll webbrain_status)" : ""}`);
  if (snapshot.mode) lines.push(`mode: ${snapshot.mode}`);
  if (snapshot.finalUrl) lines.push(`final_url: ${snapshot.finalUrl}`);

  if (snapshot.status === "needs_user_input" && snapshot.pendingInput) {
    const pending = snapshot.pendingInput;
    const promptKind = pending.promptKind;
    const clarifyId = pending.clarifyId || pending.clarify_id || "";
    const question = pending.question || "(no question text supplied)";
    lines.push("");
    lines.push("WebBrain is waiting on a human decision before it continues.");
    lines.push(`prompt_kind: ${promptKind || "unknown"}`);
    switch (promptKind) {
      case "permission":
      case "submitConfirmation":
      case "workflowHealing": {
        const options = Array.isArray(pending.options)
          ? pending.options.map(String).filter(Boolean)
          : [];
        if (options.length) lines.push(`allowed_answers: ${options.join(", ")}`);
        const details = pending[promptKind];
        if (details && typeof details === "object") {
          lines.push(`structured_prompt: ${JSON.stringify(details)}`);
        }
        break;
      }
      case "clarify":
        break;
      default:
        lines.push(
          "This prompt kind is unsupported by this client. Do not send a free-form answer; " +
            "update the client before calling webbrain_respond.",
        );
    }
    lines.push(`question: ${question}`);
    lines.push(`clarify_id: ${clarifyId}`);
    if (promptKind === "clarify" || promptKind === "permission"
        || promptKind === "submitConfirmation" || promptKind === "workflowHealing") {
      lines.push(
        "Relay this to the user and send their answer with webbrain_respond. " +
          "Do not invent an answer on their behalf.",
      );
    }
  }

  if (snapshot.error) {
    lines.push("");
    lines.push(`error: ${snapshot.error}`);
  }

  const body =
    snapshot.result !== undefined && snapshot.result !== null
      ? typeof snapshot.result === "string"
        ? snapshot.result
        : JSON.stringify(snapshot.result, null, 2)
      : snapshot.content || snapshot.summary || "";

  if (body) {
    lines.push("");
    lines.push("--- result ---");
    lines.push(body);
  }

  return lines.join("\n");
}
