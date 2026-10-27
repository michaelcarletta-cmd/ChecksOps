/**
 * Changes made by other users (owner item 9 follow-up, 2026-10-27).
 *
 * liveUpdates.ts refreshes the screen after a write made in this browser. This module notices
 * writes made anywhere else: while the tab is visible it reads a small "change cursor" for a few
 * key tables (the newest timestamp and the row count, through the same tenant-scoped read path
 * every list screen uses) and refreshes the screen only when the cursor moves. The count catches
 * deletes, which do not move the newest timestamp.
 *
 * Pure module (no app imports) so aws/tests can run it under node.
 */

/** The tables whose changes refresh the screen, each with the column that moves on a change. */
export const CURSOR_TABLES: ReadonlyArray<{ table: string; column: string }> = Object.freeze([
  { table: "check_intake_items", column: "updated_at" },
  { table: "check_messages", column: "updated_at" },
  { table: "check_stakeholders", column: "updated_at" },
  { table: "check_files", column: "created_at" },
  { table: "notifications", column: "created_at" },
]);

export type CursorReading = { count: number | null; latest: string | null };
export type CursorResults = Record<string, CursorReading | "error">;

/**
 * A stable string for one round of readings. A table whose read failed keeps its previous value,
 * so an error never looks like a change.
 */
export function cursorFingerprint(results: CursorResults, previous: Record<string, CursorReading> = {}) {
  const merged: Record<string, CursorReading> = { ...previous };
  for (const [table, reading] of Object.entries(results)) {
    if (reading !== "error") merged[table] = { count: reading.count ?? null, latest: reading.latest ?? null };
  }
  const key = Object.keys(merged)
    .sort()
    .map((table) => `${table}:${merged[table].count ?? "-"}:${merged[table].latest ?? "-"}`)
    .join("|");
  return { key, readings: merged };
}

export type CursorPollerOptions = {
  /** One round of readings; a table that failed is "error". Never throws for a single table. */
  read: () => Promise<CursorResults>;
  /** The cursor moved: someone changed data. */
  onChange: () => void;
  isVisible?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  random?: () => number;
  /** Poll every baseMs after a change; each unchanged round waits 1.5x longer, up to maxMs. */
  baseMs?: number;
  maxMs?: number;
  /** Each wait is scaled by a random factor in [1 - jitter, 1 + jitter]. */
  jitter?: number;
};

export function createCursorPoller(options: CursorPollerOptions) {
  const isVisible = options.isVisible ?? (() => true);
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const random = options.random ?? Math.random;
  const baseMs = options.baseMs ?? 10_000;
  const maxMs = options.maxMs ?? 30_000;
  const jitter = options.jitter ?? 0.2;

  let readings: Record<string, CursorReading> = {};
  let key: string | null = null;
  let interval = baseMs;
  let timer: unknown = null;
  let inFlight = false;
  let again: "check" | "rebase" | null = null;
  let stopped = true;

  const schedule = () => {
    if (stopped || timer !== null || !isVisible()) return;
    const factor = 1 - jitter + 2 * jitter * random();
    timer = setTimer(() => {
      timer = null;
      void round("check");
    }, Math.round(interval * factor));
  };

  // "check" calls onChange when the cursor moved; "rebase" only records it (this tab's own write,
  // which liveUpdates.ts has already refreshed).
  const round = async (mode: "check" | "rebase") => {
    if (stopped) return;
    if (inFlight) {
      again = again === "check" || mode === "check" ? "check" : "rebase";
      return;
    }
    inFlight = true;
    let results: CursorResults | null = null;
    try {
      results = await options.read();
    } catch {
      results = null;
    }
    inFlight = false;
    if (stopped) return;
    const allFailed = !results || Object.values(results).every((r) => r === "error");
    if (allFailed) {
      interval = maxMs;
    } else {
      const next = cursorFingerprint(results as CursorResults, readings);
      const moved = key !== null && next.key !== key;
      readings = next.readings;
      key = next.key;
      if (moved && mode === "check") {
        interval = baseMs;
        options.onChange();
      } else if (moved) {
        interval = baseMs;
      } else {
        interval = Math.min(maxMs, interval * 1.5);
      }
    }
    if (again) {
      const pending = again;
      again = null;
      void round(pending);
      return;
    }
    schedule();
  };

  return {
    /** Starts polling; the first round only records the baseline. */
    start() {
      if (!stopped) return;
      stopped = false;
      void round("check");
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    /** Read now (the tab became visible or gained focus). */
    poke() {
      if (stopped) return;
      if (timer !== null) clearTimer(timer);
      timer = null;
      void round("check");
    },
    /** This tab wrote: record the new cursor without a second refresh. */
    rebase() {
      if (stopped) return;
      if (timer !== null) clearTimer(timer);
      timer = null;
      void round("rebase");
    },
    /** For tests: the wait the next round is scheduled with, before jitter. */
    currentInterval: () => interval,
  };
}
