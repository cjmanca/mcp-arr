/**
 * In-process registry for long-running, non-importing manual-import operations:
 * candidate discovery (GET /manualimport) and preview (native reprocess).
 *
 * The HTTP transport is intentionally stateless: every request builds a fresh
 * MCP `Server` + transport and closes them when the response ends. Operations
 * therefore live here, at module scope, shared across every request-scoped
 * server — a discovery/preview started by one HTTP request stays pollable from
 * a later, unrelated request. Stdio uses the same registry.
 *
 * This is a bounded, transport-neutral registry, not a job framework. It is
 * protocol-neutral on purpose: the same operation state can later be mapped
 * onto the MCP Tasks extension (`tasks/get` / `tasks/cancel`) without changing
 * this module.
 *
 * Discovery and preview are both non-destructive, so losing handles on process
 * restart is acceptable — the agent simply runs the tool again. Execute is
 * deliberately NOT registered here: it is destructive and revalidates from
 * native state on every call.
 */

import { randomUUID } from "node:crypto";
import {
  previewMaxRuntimeMs,
  operationPollIntervalMs,
  operationResultTtlMs,
} from "./config.js";

export type OperationStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled";

export type OperationKind =
  | "sonarr-manual-import-discovery"
  | "radarr-manual-import-discovery"
  | "lidarr-manual-import-discovery"
  | "sonarr-manual-import-preview"
  | "radarr-manual-import-preview"
  | "lidarr-manual-import-preview";

/**
 * Execution context handed to an operation executor. `signal` is the
 * operation's abort signal (aborted on hard timeout or cancellation) and must
 * be threaded into every native request. `setStage` reports coarse, truthful
 * progress.
 */
export interface OperationExecutionContext {
  signal: AbortSignal;
  setStage(stage: string, message?: string): void;
}

export interface ManagedOperation {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  startedAt: number;
  updatedAt: number;
  deadlineAt: number;
  completedAt?: number;
  stage?: string;
  message?: string;
  result?: unknown;
  error?: string;
  controller: AbortController;
  fingerprint?: string;
  abortReason?: "deadline" | "cancelled" | null;
  /** Resolves (never rejects) with the operation once it reaches a terminal state. */
  settled: Promise<ManagedOperation>;
}

const KIND_LABEL: Record<OperationKind, string> = {
  "sonarr-manual-import-discovery": "Sonarr manual-import candidate discovery",
  "radarr-manual-import-discovery": "Radarr manual-import candidate discovery",
  "lidarr-manual-import-discovery": "Lidarr manual-import candidate discovery",
  "sonarr-manual-import-preview": "Sonarr manual-import preview",
  "radarr-manual-import-preview": "Radarr manual-import preview",
  "lidarr-manual-import-preview": "Lidarr manual-import preview",
};

/** The caller-facing action word for a kind, used in guidance text. */
const KIND_ACTION: Record<OperationKind, "discovery" | "preview"> = {
  "sonarr-manual-import-discovery": "discovery",
  "radarr-manual-import-discovery": "discovery",
  "lidarr-manual-import-discovery": "discovery",
  "sonarr-manual-import-preview": "preview",
  "radarr-manual-import-preview": "preview",
  "lidarr-manual-import-preview": "preview",
};

export function kindLabel(kind: OperationKind): string {
  return KIND_LABEL[kind];
}

export function kindAction(kind: OperationKind): "discovery" | "preview" {
  return KIND_ACTION[kind];
}

export type OperationExecutor = (ctx: OperationExecutionContext) => Promise<unknown>;

class OperationManager {
  private operations = new Map<string, ManagedOperation>();
  private activeFingerprints = new Map<string, string>();

  /**
   * Start an operation. The executor runs in the background, owned by this
   * manager — it is NOT tied to the MCP request that started it, so it survives
   * the per-request server/transport teardown.
   */
  start(kind: OperationKind, fingerprint: string | undefined, executor: OperationExecutor): ManagedOperation {
    this.sweep();

    const id = randomUUID();
    const now = Date.now();
    const maxRuntime = previewMaxRuntimeMs();

    const op: ManagedOperation = {
      id,
      kind,
      status: "running",
      startedAt: now,
      updatedAt: now,
      deadlineAt: now + maxRuntime,
      stage: "starting",
      controller: new AbortController(),
      fingerprint,
      abortReason: null,
      settled: Promise.resolve(undefined as unknown as ManagedOperation),
    };

    this.operations.set(id, op);
    if (fingerprint) this.activeFingerprints.set(fingerprint, id);

    const deadlineTimer = setTimeout(() => {
      if (op.status !== "running") return;
      op.abortReason = "deadline";
      // Terminalize immediately: the deadline is authoritative even if an
      // operation helper swallows the abort as an ordinary lookup failure and
      // the executor later resolves. completedAt is fixed at the deadline so
      // polling reports a stable elapsed time, and the active fingerprint is
      // released so an identical operation can start fresh.
      this.markTerminal(op, "timed_out", {
        error: `${KIND_LABEL[kind]} exceeded the configured operation timeout.`,
      });
      op.controller.abort(new Error(`${KIND_LABEL[kind]} exceeded the configured operation timeout.`));
    }, maxRuntime);

    op.settled = (async () => {
      try {
        const result = await executor({
          signal: op.controller.signal,
          setStage: (stage, message) => {
            if (op.status === "running") {
              op.stage = stage;
              if (message !== undefined) op.message = message;
              op.updatedAt = Date.now();
            }
          },
        });
        // A hard timeout or cancellation that fired mid-run already moved the
        // status; do not overwrite it with a late success.
        if (op.status === "running") {
          this.markTerminal(op, "completed", { result });
        }
      } catch (error) {
        if (op.status !== "running") {
          // Already terminalized by the deadline/cancel path.
        } else if (op.abortReason === "deadline") {
          this.markTerminal(op, "timed_out", {
            error: `${KIND_LABEL[kind]} exceeded the configured operation timeout.`,
          });
        } else if (op.abortReason === "cancelled") {
          this.markTerminal(op, "cancelled");
        } else {
          this.markTerminal(op, "failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        clearTimeout(deadlineTimer);
        op.updatedAt = Date.now();
        if (fingerprint && this.activeFingerprints.get(fingerprint) === id) {
          this.activeFingerprints.delete(fingerprint);
        }
      }
      return op;
    })();

    return op;
  }

  /**
   * Move an operation to a terminal state exactly once: stamp completedAt,
   * release its active fingerprint (so a timed-out/cancelled operation is not
   * deduplicated against by a new identical operation), and record the result
   * or error. The operation itself stays in the map until TTL expiry.
   */
  private markTerminal(
    op: ManagedOperation,
    status: "completed" | "failed" | "timed_out" | "cancelled",
    opts: { result?: unknown; error?: string } = {},
  ): void {
    const now = Date.now();
    op.status = status;
    op.completedAt = now;
    op.updatedAt = now;
    if (opts.result !== undefined) op.result = opts.result;
    if (opts.error !== undefined) op.error = opts.error;
    if (op.fingerprint && this.activeFingerprints.get(op.fingerprint) === op.id) {
      this.activeFingerprints.delete(op.fingerprint);
    }
  }

  get(id: string): ManagedOperation | undefined {
    this.sweep();
    return this.operations.get(id);
  }

  /** The running operation with this fingerprint, if any (for deduplication). */
  findRunning(fingerprint: string | undefined): ManagedOperation | undefined {
    this.sweep();
    if (!fingerprint) return undefined;
    const id = this.activeFingerprints.get(fingerprint);
    if (!id) return undefined;
    const op = this.operations.get(id);
    return op && op.status === "running" ? op : undefined;
  }

  /**
   * Cancel a running operation. Terminal operations keep their status — cancel
   * never mutates a completed/failed/timed_out/cancelled result.
   */
  cancel(id: string): ManagedOperation | undefined {
    this.sweep();
    const op = this.operations.get(id);
    if (!op) return undefined;
    if (op.status === "running") {
      op.abortReason = "cancelled";
      // Mark cancelled immediately so the caller sees the terminal status; the
      // executor's abort path converges on the same value and a late native
      // success can no longer overwrite it.
      this.markTerminal(op, "cancelled");
      op.controller.abort(new Error("cancelled"));
    }
    return op;
  }

  /**
   * Await the operation up to a soft synchronous budget. Returns the operation
   * either way: terminal (fast path) or still running (handle path). The budget
   * expiring does NOT cancel the operation — it keeps running in the manager.
   */
  async awaitWithBudget(op: ManagedOperation, budgetMs: number): Promise<ManagedOperation> {
    if (budgetMs <= 0) return op;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"budget">((resolve) => {
      timer = setTimeout(() => resolve("budget"), budgetMs);
    });
    await Promise.race([op.settled, budget]);
    if (timer) clearTimeout(timer);
    return op;
  }

  /** Opportunistic cleanup of terminal operations past their retention TTL. */
  private sweep(): void {
    const ttl = operationResultTtlMs();
    const now = Date.now();
    for (const op of this.operations.values()) {
      if (op.status === "running") continue;
      const terminalAt = op.completedAt ?? op.updatedAt;
      if (now - terminalAt >= ttl) {
        this.operations.delete(op.id);
        if (op.fingerprint && this.activeFingerprints.get(op.fingerprint) === op.id) {
          this.activeFingerprints.delete(op.fingerprint);
        }
      }
    }
  }
}

export const previewOperations = new OperationManager();
export { operationPollIntervalMs };
