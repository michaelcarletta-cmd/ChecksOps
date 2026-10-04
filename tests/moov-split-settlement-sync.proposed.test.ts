/**
 * Proposed contract for provider → disbursement_splits settlement sync.
 * These functions are local to the spec. They are NOT imported by
 * moov-webhook, moov-disburse, or any write path.
 *
 * STOP: do not wire this into production in this workstream.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

type Split = {
  id: string;
  status: string;
  amount: number;
  moov_transfer_id?: string | null;
  settled_at?: string | null;
  returned_at?: string | null;
  return_code?: string | null;
};

type ProviderEvent = {
  provider_transfer_id: string;
  provider_status: string;
  completed_at?: string | null;
  return_code?: string | null;
};

type ProposalResult =
  | { action: "noop"; reason: string }
  | { action: "update"; splitId: string; patch: Partial<Split> };

const COMPLETED = new Set(["completed", "succeeded", "success", "settled"]);
const FAILED = new Set(["failed", "canceled", "cancelled", "declined"]);
const RETURNED = new Set(["returned", "return", "reversed", "refunded"]);

function proposeSplitSettlement(split: Split | null, event: ProviderEvent): ProposalResult {
  if (!split) return { action: "noop", reason: "unmatched_provider_transfer" };
  if (split.moov_transfer_id !== event.provider_transfer_id) {
    return { action: "noop", reason: "provider_id_mismatch" };
  }
  const status = String(event.provider_status || "").toLowerCase();
  if (COMPLETED.has(status)) {
    if (split.status === "settled" && split.settled_at) {
      return { action: "noop", reason: "already_settled" };
    }
    return {
      action: "update",
      splitId: split.id,
      patch: { status: "settled", settled_at: event.completed_at ?? "event-time" },
    };
  }
  if (FAILED.has(status)) {
    if (split.status === "failed") return { action: "noop", reason: "already_failed" };
    return { action: "update", splitId: split.id, patch: { status: "failed" } };
  }
  if (RETURNED.has(status)) {
    if (split.status === "returned" && split.returned_at) {
      return { action: "noop", reason: "already_returned" };
    }
    return {
      action: "update",
      splitId: split.id,
      patch: { status: "returned", returned_at: event.completed_at ?? "event-time", return_code: event.return_code ?? null },
    };
  }
  return { action: "noop", reason: "non_terminal_provider_status" };
}

const split = {
  id: "split-ab-9000",
  status: "submitted",
  amount: 9000,
  moov_transfer_id: "moov-transfer-ab-9000",
};

test("proposed: completed provider transfer settles the existing split once", () => {
  const first = proposeSplitSettlement(split, {
    provider_transfer_id: "moov-transfer-ab-9000",
    provider_status: "completed",
    completed_at: "2026-01-15T18:00:00.000Z",
  });
  assert.equal(first.action, "update");
  if (first.action === "update") {
    assert.equal(first.splitId, "split-ab-9000");
    assert.equal(first.patch.status, "settled");
    assert.equal(first.patch.settled_at, "2026-01-15T18:00:00.000Z");
    assert.equal(first.patch.amount, undefined);
  }
});

test("proposed: replay of the same completed event is idempotent", () => {
  const settled = { ...split, status: "settled", settled_at: "2026-01-15T18:00:00.000Z" };
  const replay = proposeSplitSettlement(settled, {
    provider_transfer_id: "moov-transfer-ab-9000",
    provider_status: "completed",
    completed_at: "2026-01-15T19:00:00.000Z",
  });
  assert.deepEqual(replay, { action: "noop", reason: "already_settled" });
});

test("proposed: failed and returned update the same row; unmatched id is a no-op", () => {
  const failed = proposeSplitSettlement(split, {
    provider_transfer_id: "moov-transfer-ab-9000",
    provider_status: "failed",
  });
  assert.equal(failed.action, "update");
  if (failed.action === "update") assert.equal(failed.patch.status, "failed");

  const returned = proposeSplitSettlement(split, {
    provider_transfer_id: "moov-transfer-ab-9000",
    provider_status: "returned",
    completed_at: "2026-01-16T00:00:00.000Z",
    return_code: "R01",
  });
  assert.equal(returned.action, "update");
  if (returned.action === "update") {
    assert.equal(returned.patch.status, "returned");
    assert.equal(returned.patch.return_code, "R01");
  }

  assert.deepEqual(
    proposeSplitSettlement(null, { provider_transfer_id: "unknown", provider_status: "completed" }),
    { action: "noop", reason: "unmatched_provider_transfer" },
  );
});

test("proposed: submitted/pending provider status does not settle and never inserts a row", () => {
  const pending = proposeSplitSettlement(split, {
    provider_transfer_id: "moov-transfer-ab-9000",
    provider_status: "pending",
  });
  assert.deepEqual(pending, { action: "noop", reason: "non_terminal_provider_status" });
  assert.equal(typeof proposeSplitSettlement, "function");
});
