/**
 * Runtime configuration for long-running preview operations and upstream API
 * timeouts.
 *
 * Values are read from the environment on each call (not frozen at import) so
 * tests can set a small budget/timeout and have it take effect without a
 * rebuild. Each getter validates its variable: a missing, non-numeric,
 * non-integer, out-of-range, or nonsensical value falls back to the documented
 * default rather than throwing at startup.
 */

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

/** Per-request timeout for ordinary *arr API reads (GET /queue, /series, …). */
export function arrApiTimeoutMs(): number {
  return envInt("ARR_API_TIMEOUT_MS", 120000, 1, 3_600_000);
}

/**
 * Per-request timeout for the expensive manual-import endpoints
 * (GET/POST /manualimport, track resolution). Longer than ordinary reads
 * because the apps run their full import decision server-side.
 */
export function manualImportApiTimeoutMs(): number {
  return envInt("MANUAL_IMPORT_API_TIMEOUT_MS", 180000, 1, 3_600_000);
}

/**
 * Soft synchronous response budget. A preview that finishes within this window
 * returns its result directly (unchanged fast path); a preview still running
 * after it returns a pollable operation handle. 0 means "always return a
 * handle". This never cancels the operation.
 */
export function previewSyncBudgetMs(): number {
  return envInt("PREVIEW_SYNC_BUDGET_MS", 8000, 0, 600_000);
}

/** Absolute deadline for a whole preview operation (discovery → result). */
export function previewMaxRuntimeMs(): number {
  return envInt("PREVIEW_MAX_RUNTIME_MS", 300000, 1, 3_600_000);
}

/** Suggested poll interval returned to agents in a running handle. */
export function operationPollIntervalMs(): number {
  return envInt("OPERATION_POLL_INTERVAL_MS", 5000, 1, 120_000);
}

/** How long a terminal (completed/failed/timed_out/cancelled) result is retained. */
export function operationResultTtlMs(): number {
  return envInt("OPERATION_RESULT_TTL_MS", 900000, 1, 86_400_000);
}
