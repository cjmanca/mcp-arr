/**
 * In-process registry for long-running manual-import preview operations.
 *
 * The HTTP transport is intentionally stateless: every request builds a fresh
 * MCP `Server` + transport and closes them when the response ends. Preview
 * operations therefore live here, at module scope, shared across every
 * request-scoped server — a preview started by one HTTP request stays pollable
 * from a later, unrelated request. Stdio uses the same registry.
 *
 * This is a bounded, transport-neutral registry, not a job framework. It is
 * protocol-neutral on purpose: the same operation state can later be mapped
 * onto the MCP Tasks extension (`tasks/get` / `tasks/cancel`) without changing
 * this module.
 *
 * Preview is non-destructive, so losing handles on process restart is
 * acceptable — the agent simply runs the preview again.
 */

import { randomUUID } from "node:crypto";
import {
  previewMaxRuntimeMs,
  operationPollIntervalMs,
  operationResultTtlMs,
} from "./config.js";

export type OperationStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled";

export type PreviewOperationKind =
  | "sonarr-manual-import-preview"
  | "radarr-manual-import-preview"
  | "lidarr-manual-import-preview";

/**
 * Execution context handed to a preview executor. `signal` is the operation's
 * abort signal (aborted on hard timeout or cancellation) and must be threaded
 * into every native request. `setStage` reports coarse, truthful progress.
 */
export interface PreviewExecutionContext {
  signal: AbortSignal;
  setStage(stage: string, message?: string): void;
}

export interface PreviewOperation {
  id: string;
  kind: PreviewOperationKind;
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
  settled: Promise<PreviewOperation>;
}

const KIND_LABEL: Record<PreviewOperationKind, string> = {
  "sonarr-manual-import-preview": "Sonarr manual-import preview",
  "radarr-manual-import-preview": "Radarr manual-import preview",
  "lidarr-manual-import-preview": "Lidarr manual-import preview",
};

export function kindLabel(kind: PreviewOperationKind): string {
  return KIND_LABEL[kind];
}

export type PreviewExecutor = (ctx: PreviewExecutionContext) => Promise<unknown>;

class PreviewOperationManager {
  private operations = new Map<string, PreviewOperation>();
  private activeFingerprints = new Map<string, string>();

  /**
   * Start a preview operation. The executor runs in the background, owned by
   * this manager — it is NOT tied to the MCP request that started it, so it
   * survives the per-request server/transport teardown.
   */
  start(kind: PreviewOperationKind, fingerprint: string | undefined, executor: PreviewExecutor): PreviewOperation {
    this.sweep();

    const id = randomUUID();
    const now = Date.now();
    const maxRuntime = previewMaxRuntimeMs();

    const op: PreviewOperation = {
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
      settled: Promise.resolve(undefined as unknown as PreviewOperation),
    };

    this.operations.set(id, op);
    if (fingerprint) this.activeFingerprints.set(fingerprint, id);

    const deadlineTimer = setTimeout(() => {
      if (op.status !== "running") return;
      op.abortReason = "deadline";
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
          op.status = "completed";
          op.result = result;
          op.completedAt = Date.now();
        }
      } catch (error) {
        if (op.abortReason === "deadline") {
          op.status = "timed_out";
          op.error = `${KIND_LABEL[kind]} preview exceeded the configured operation timeout.`;
        } else if (op.abortReason === "cancelled") {
          op.status = "cancelled";
        } else {
          op.status = "failed";
          op.error = error instanceof Error ? error.message : String(error);
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

  get(id: string): PreviewOperation | undefined {
    this.sweep();
    return this.operations.get(id);
  }

  /** The running operation with this fingerprint, if any (for deduplication). */
  findRunning(fingerprint: string | undefined): PreviewOperation | undefined {
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
  cancel(id: string): PreviewOperation | undefined {
    this.sweep();
    const op = this.operations.get(id);
    if (!op) return undefined;
    if (op.status === "running") {
      op.abortReason = "cancelled";
      // Mark cancelled immediately so the caller sees the terminal status; the
      // executor's abort path converges on the same value and a late native
      // success can no longer overwrite it.
      op.status = "cancelled";
      op.completedAt = Date.now();
      op.updatedAt = op.completedAt;
      op.controller.abort(new Error("cancelled"));
    }
    return op;
  }

  /**
   * Await the operation up to a soft synchronous budget. Returns the operation
   * either way: terminal (fast path) or still running (handle path). The budget
   * expiring does NOT cancel the operation — it keeps running in the manager.
   */
  async awaitWithBudget(op: PreviewOperation, budgetMs: number): Promise<PreviewOperation> {
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

export const previewOperations = new PreviewOperationManager();
export { operationPollIntervalMs };
