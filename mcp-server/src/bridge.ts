/**
 * Bridge server — the local endpoint the WebBrain extension connects OUT to.
 *
 * Direction matters: a Manifest V3 extension cannot listen on a socket, so
 * `src/chrome/src/offscreen/cloud-bridge.js` dials out from an offscreen
 * document and we host the listener. That also means every command below is
 * initiated by us and answered by the extension.
 *
 * Wire protocol (already shipping in the extension, unchanged here):
 *   extension -> us   {type:'hello', client, protocolVersion, capabilities, status}
 *   us -> extension   {id, action, payload}
 *   extension -> us   {id, ok:true,  result}
 *                     {id, ok:false, error, status?}
 *
 * The extension spreads `payload` over the message it forwards to its own
 * background worker, so payload keys become top-level fields there. Send the
 * exact field names `cloud-runs.js` reads.
 */

import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { BOT_MEMORY_CAPABILITY, validateTaskMemory, taskMemoryPrivateValues, redactTaskMemory, redactMemoryRunResponse } from "./task-memory.js";

/** Actions already present in the extension's ALLOWED_BRIDGE_ACTIONS set. */
export type BridgeAction =
  | "cloud_run"
  | "cloud_status"
  | "cloud_respond"
  | "cloud_abort";

export interface CloudSnapshot {
  runId: string;
  status: "running" | "needs_user_input" | "aborting" | "completed" | "failed" | "aborted";
  mode?: "ask" | "act";
  tabId?: number;
  task?: string;
  structured?: boolean;
  pendingInput?: {
    promptKind?: string;
    clarifyId?: string;
    clarify_id?: string;
    question?: string;
    [key: string]: unknown;
  } | null;
  result?: unknown;
  summary?: string;
  content?: string;
  finalUrl?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  updates?: unknown[];
  [key: string]: unknown;
}

export const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

/**
 * Memory-run redaction scopes held at once. One bridge can live as long as the
 * app hosting it, so this bounds concurrent scopes, not lifetime runs: an
 * unfinished run keeps its scope until the extension reports it terminal, and
 * finished scopes are recycled oldest-first when room is needed.
 */
export const MAX_MEMORY_RUN_SCOPES = 256;

interface MemoryRunState {
  credentials: readonly string[];
  /** The start was answered (or never sent): the run is in the extension's list or never will be. */
  startSettled: boolean;
  /** The extension reported a terminal status, so nothing new can reach this run. */
  finished: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  protectedRequest?: boolean;
  runId?: string;
  memoryValues?: ReadonlySet<string>;
  memoryStart?: boolean;
}

export class BridgeError extends Error {
  readonly status?: number;
  readonly code?: "COMMAND_TIMEOUT" | "COMMAND_INTERRUPTED";
  constructor(
    message: string,
    status?: number,
    code?: "COMMAND_TIMEOUT" | "COMMAND_INTERRUPTED",
  ) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
  }
}

/** Log to stderr only — stdout is the MCP stdio transport and must stay clean. */
function log(...args: unknown[]): void {
  console.error("[webbrain-mcp]", ...args);
}

function isAllowedBridgeOrigin(origin: string | string[] | undefined): boolean {
  if (origin == null) return true;
  if (Array.isArray(origin)) return false;
  try {
    const protocol = new URL(origin).protocol;
    return protocol === "chrome-extension:" || protocol === "moz-extension:";
  } catch {
    return false;
  }
}

export class WebBrainBridge {
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private extensionCapabilities: string[] = [];
  private extensionProtocol: number | null = null;
  private handshakenSocket: WebSocket | null = null;
  private waiters: Array<() => void> = [];
  private memoryPrivateValues = new Set<string>();
  private memoryProtectedRunIds = new Set<string>();
  private memoryRunValues = new Map<string, ReadonlySet<string>>();
  /** Lifecycle of each scope above, in eviction order (oldest finished first). */
  private memoryRuns = new Map<string, MemoryRunState>();

  async start(): Promise<void> {
    if (this.wss) return;

    await new Promise<void>((resolve, reject) => {
      // Bind to loopback explicitly. Never expose this listener to the network:
      // anything that can reach it can drive the user's logged-in browser.
      const wss = new WebSocketServer(
        { host: "127.0.0.1", port: config.bridgePort },
        () => resolve(),
      );
      wss.on("error", reject);
      this.wss = wss;
    });

    this.wss!.on("connection", (socket, request) => {
      const url = request.url || "";
      const origin = request.headers.origin;
      // Browser WebSocket clients always send Origin. Only extension pages may
      // reach this trusted-local command channel; native clients send none.
      if (!isAllowedBridgeOrigin(origin)) {
        log(`rejected WebSocket origin: ${String(origin)}`);
        socket.close(1008, "Untrusted Origin");
        return;
      }
      if (!url.startsWith(config.bridgePath)) {
        log(`rejected connection on unexpected path: ${url}`);
        socket.close(1008, "Unexpected path");
        return;
      }

      // Latest connection wins. The extension reconnects with backoff after a
      // browser restart or an offscreen-document teardown, and the stale socket
      // is never reused.
      if (this.socket) {
        this.failAllPending(
          new BridgeError(
            "WebBrain extension connection was superseded mid-command.",
            undefined,
            "COMMAND_INTERRUPTED",
          ),
        );
        try {
          this.socket.close(1000, "Superseded by a newer extension connection");
        } catch {
          /* already gone */
        }
      }

      this.socket = socket;
      this.handshakenSocket = null;
      this.extensionCapabilities = [];
      this.extensionProtocol = null;
      log(`extension connected on ${config.bridgePath}`);

      socket.on("message", (raw) => this.handleMessage(socket, raw.toString()));

      socket.on("close", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.handshakenSocket = null;
        this.extensionCapabilities = [];
        this.extensionProtocol = null;
        log("extension disconnected");
        this.failAllPending(
          new BridgeError(
            "WebBrain extension disconnected mid-command.",
            undefined,
            "COMMAND_INTERRUPTED",
          ),
        );
      });

      socket.on("error", (error) => {
        log("socket error:", redactTaskMemory(error instanceof Error ? error.message : String(error), this.memoryPrivateValues));
      });
    });

    log(`listening on ws://127.0.0.1:${config.bridgePort}${config.bridgePath}`);
  }

  private handleMessage(socket: WebSocket, data: string): void {
    if (this.socket !== socket) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      log("dropped non-JSON frame from extension");
      return;
    }

    // Handshake frame — no id, nothing to correlate.
    if (msg.type === "hello") {
      if (msg.client !== "webbrain-extension") {
        log(`rejecting unknown bridge client: ${String(msg.client)}`);
        socket.close(1008, "Unknown client");
        if (this.socket === socket) {
          this.socket = null;
          this.handshakenSocket = null;
        }
        return;
      }
      this.handshakenSocket = socket;
      this.extensionProtocol = typeof msg.protocolVersion === "number" ? msg.protocolVersion : null;
      this.extensionCapabilities = Array.isArray(msg.capabilities)
        ? (msg.capabilities as string[])
        : [];
      log(
        `handshake ok — protocol v${this.extensionProtocol}, capabilities: ` +
          (this.extensionCapabilities.join(", ") || "none"),
      );
      const waiters = this.waiters;
      this.waiters = [];
      for (const wake of waiters) wake();
      return;
    }

    const id = typeof msg.id === "number" ? msg.id : null;
    if (id == null) return;

    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);

    if (entry.memoryStart && entry.runId) {
      // Answered either way, so the extension now lists this run or never will.
      const state = this.memoryRuns.get(entry.runId);
      if (state) state.startSettled = true;
    }

    if (msg.ok === false) {
      const status = typeof msg.status === "number" ? msg.status : undefined;
      entry.reject(new BridgeError(String(redactMemoryRunResponse(msg.error || "Unknown bridge error", this.memoryPrivateValues,
        this.memoryProtectedRunIds, entry.protectedRequest, { runValues: this.memoryRunValues, requestRunId: entry.runId, requestValues: entry.memoryValues })), status));
      return;
    }
    if (entry.memoryStart && msg.result && typeof msg.result === "object") {
      const result = msg.result as Record<string, unknown>;
      const runId = result.runId || result.run_id;
      if (typeof runId === "string") {
        this.memoryProtectedRunIds.add(runId);
        if (entry.memoryValues) this.memoryRunValues.set(runId, new Set([...(this.memoryRunValues.get(runId) || []), ...entry.memoryValues]));
        if (!this.memoryRuns.has(runId)) {
          const credentials = (entry.runId && this.memoryRuns.get(entry.runId)?.credentials) || [];
          this.memoryRuns.set(runId, { credentials, startSettled: true, finished: false });
        }
      }
    }
    this.noteMemoryRunStatuses(msg.result, entry.runId);
    entry.resolve(redactMemoryRunResponse(msg.result, this.memoryPrivateValues, this.memoryProtectedRunIds,
      entry.protectedRequest, { runValues: this.memoryRunValues, requestRunId: entry.runId, requestValues: entry.memoryValues }));
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** Track which protected runs the extension reports as finished (or live again). */
  private noteMemoryRunStatuses(result: unknown, requestRunId?: string): void {
    if (!this.memoryRuns.size || !result || typeof result !== "object") return;
    const listed = (result as { runs?: unknown }).runs;
    for (const run of Array.isArray(listed) ? listed : [result]) {
      if (!run || typeof run !== "object") continue;
      const snapshot = run as Record<string, unknown>;
      const runId = String(snapshot.runId || snapshot.run_id || (Array.isArray(listed) ? "" : requestRunId || ""));
      const state = this.memoryRuns.get(runId);
      if (!state || typeof snapshot.status !== "string") continue;
      state.startSettled = true;
      const finished = TERMINAL_STATUSES.has(snapshot.status);
      if (finished && !state.finished) {
        // Re-append so the most recently finished runs keep their scope longest.
        this.memoryRuns.delete(runId);
        this.memoryRuns.set(runId, state);
      }
      state.finished = finished;
    }
  }

  /** Drop the oldest finished scopes until one more fits; false if every slot is unfinished. */
  private evictFinishedMemoryRuns(): boolean {
    let evicted = false;
    for (const [runId, state] of this.memoryRuns) {
      if (this.memoryRuns.size < MAX_MEMORY_RUN_SCOPES) break;
      if (!state.finished) continue;
      this.memoryRuns.delete(runId);
      this.memoryProtectedRunIds.delete(runId);
      this.memoryRunValues.delete(runId);
      evicted = true;
    }
    if (evicted) {
      // Runs can share a credential, so keep every one a retained run still uses.
      this.memoryPrivateValues = new Set([...this.memoryRuns.values()].flatMap((state) => state.credentials));
    }
    return this.memoryRuns.size < MAX_MEMORY_RUN_SCOPES;
  }

  /**
   * A caller that stopped polling leaves a finished run looking unfinished.
   * The extension's run list is authoritative (it hydrates first), so re-read
   * it: terminal runs are noted on the way in, and a settled start missing
   * from the list can never be returned again.
   */
  private async refreshMemoryRunStates(timeoutMs: number): Promise<void> {
    try {
      const listed = await this.request<{ runs?: CloudSnapshot[] }>("cloud_status", {}, timeoutMs);
      if (!Array.isArray(listed?.runs)) return;
      const present = new Set(listed.runs.map((run) => String(run.runId || run.run_id || "")));
      for (const [runId, state] of this.memoryRuns) {
        if (state.startSettled && !present.has(runId)) state.finished = true;
      }
    } catch {
      /* the caller reports capacity */
    }
  }

  isConnected(): boolean {
    return (
      this.socket !== null &&
      this.socket.readyState === 1 &&
      this.handshakenSocket === this.socket
    );
  }

  capabilities(): string[] {
    return [...this.extensionCapabilities];
  }

  /** Resolve once the extension has connected and completed its handshake. */
  waitForExtension(timeoutMs: number): Promise<boolean> {
    if (this.isConnected()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(false);
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(wake);
    });
  }

  /** Send one command and await the extension's reply. */
  async request<T = unknown>(
    action: BridgeAction,
    payload: Record<string, unknown> = {},
    timeoutMs = config.commandTimeoutMs,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || !this.isConnected()) {
      throw new BridgeError(
        "No WebBrain extension is connected. Open the browser, then set " +
          "WebBrain → Settings → Bridge to " +
          `ws://127.0.0.1:${config.bridgePort}${config.bridgePath} and enable the MCP bridge.`,
      );
    }

    let memoryValues: ReadonlySet<string> | undefined;
    if (payload.task_memory !== undefined || (action !== "cloud_run" && payload.taskMemory !== undefined)) {
      throw new BridgeError("task_memory is supported only through the private cloud_run transport.", 400);
    }
    if (action === "cloud_run" && payload.taskMemory !== undefined) {
      let memory;
      try { memory = validateTaskMemory(payload.taskMemory); }
      catch { throw new BridgeError("Invalid task_memory envelope.", 400); }
      if (!this.capabilities().includes(BOT_MEMORY_CAPABILITY)) {
        throw new BridgeError("Update the browser extension before starting a task with bot memory.", 409);
      }
      // Retain privacy through failed/late runs: a scope is never evicted
      // before the extension reports its run finished, and only then once
      // room is needed. A known run ID lets every start be tracked that way.
      const runId = typeof payload.runId === "string" ? payload.runId : `mcp_${randomUUID()}`;
      if (!this.memoryRuns.has(runId) && !this.evictFinishedMemoryRuns()) {
        await this.refreshMemoryRunStates(timeoutMs);
        if (this.socket !== socket || !this.isConnected()) {
          throw new BridgeError("WebBrain extension disconnected before the memory run could start.");
        }
        // Re-checked with no await before the scope is added below.
        if (!this.memoryRuns.has(runId) && !this.evictFinishedMemoryRuns()) {
          throw new BridgeError(
            `${MAX_MEMORY_RUN_SCOPES} bot-memory runs are still unfinished on this bridge. ` +
              "Wait for one to finish or abort it before starting another memory run.",
            409,
          );
        }
      }
      payload = { ...payload, runId, taskMemory: memory };
      memoryValues = new Set([...(this.memoryRunValues.get(runId) || []), ...taskMemoryPrivateValues(memory)]);
      const credentials = [memory.callbackToken, memory.callbackUrl];
      for (const credential of credentials) this.memoryPrivateValues.add(credential);
      this.memoryProtectedRunIds.add(runId);
      this.memoryRunValues.set(runId, memoryValues);
      const previous = this.memoryRuns.get(runId);
      this.memoryRuns.delete(runId);
      this.memoryRuns.set(runId, {
        credentials: [...new Set([...(previous?.credentials || []), ...credentials])],
        startSettled: false,
        finished: false,
      });
    }

    const id = this.nextId++;
    const frame = JSON.stringify({ id, action, payload });
    const responseTimeoutMs = Math.max(1, Math.min(config.commandTimeoutMs, timeoutMs));

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            `WebBrain did not answer '${action}' within ${responseTimeoutMs}ms.`,
            undefined,
            "COMMAND_TIMEOUT",
          ),
        );
      }, responseTimeoutMs);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer,
        runId: typeof payload.runId === "string" ? payload.runId : undefined,
        memoryValues: memoryValues || (typeof payload.runId === "string" ? this.memoryRunValues.get(payload.runId) : undefined),
        memoryStart: action === "cloud_run" && payload.taskMemory !== undefined,
        protectedRequest: payload.taskMemory !== undefined || (typeof payload.runId === "string" && this.memoryProtectedRunIds.has(payload.runId)) });

      try {
        socket.send(frame);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new BridgeError(
            `Failed to send '${action}': ${String(redactMemoryRunResponse(error instanceof Error ? error.message : String(error),
              this.memoryPrivateValues, this.memoryProtectedRunIds, payload.taskMemory !== undefined,
              { runValues: this.memoryRunValues, requestRunId: typeof payload.runId === "string" ? payload.runId : undefined, requestValues: memoryValues }))}`,
          ),
        );
      }
    });
  }

  async stop(): Promise<void> {
    this.failAllPending(new BridgeError("Bridge shutting down."));
    this.memoryPrivateValues.clear();
    this.memoryProtectedRunIds.clear();
    this.memoryRunValues.clear();
    this.memoryRuns.clear();
    if (this.socket) {
      try {
        this.socket.close(1001, "Server shutting down");
      } catch {
        /* ignore */
      }
      this.socket = null;
      this.handshakenSocket = null;
    }
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
  }
}
