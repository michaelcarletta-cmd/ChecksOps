import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MORTGAGE_DESK_RETURN_MESSAGE,
  buildReturnAckMessage,
  buildReturnMessage,
  compareLossDraftReturnPriority,
  deriveMortgageDeskReturnState,
  displayCheckMessageBody,
  isReturnAckMessage,
  isReturnMessage,
  parseReturnAckRequestId,
  parseReturnRequestId,
  returnAckLookupPattern,
  returnMessageLookupPattern,
} from "../src/lib/mortgageDeskReturn.ts";

const REQUEST_ID = "bad88242-7972-4d67-9b21-263af907fc50";
const OTHER_ID = "11111111-1111-4111-8111-111111111111";

test("builds a stable prefixed return message without changing completion semantics", () => {
  const body = buildReturnMessage(REQUEST_ID);
  assert.equal(body.startsWith(`MORTGAGE_DESK_RETURN:${REQUEST_ID}`), true);
  assert.match(body, new RegExp(MORTGAGE_DESK_RETURN_MESSAGE));
  assert.equal(parseReturnRequestId(body), REQUEST_ID);
  assert.equal(isReturnMessage(body), true);
  assert.equal(isReturnAckMessage(body), false);
});

test("ack prefix does not collide with the return prefix", () => {
  const ack = buildReturnAckMessage(REQUEST_ID);
  assert.equal(ack, `MORTGAGE_DESK_RETURN_ACK:${REQUEST_ID}`);
  assert.equal(isReturnAckMessage(ack), true);
  assert.equal(isReturnMessage(ack), false);
  assert.equal(parseReturnRequestId(ack), null);
  assert.equal(parseReturnAckRequestId(ack), REQUEST_ID);
  assert.equal(returnMessageLookupPattern(REQUEST_ID).includes(REQUEST_ID), true);
  assert.equal(returnAckLookupPattern(REQUEST_ID).includes("RETURN_ACK"), true);
});

test("completed request without a return message is not action required", () => {
  const state = deriveMortgageDeskReturnState(
    [{ id: REQUEST_ID, status: "completed", completed_at: "2026-09-27T12:00:00Z" }],
    [],
  );
  assert.equal(state.actionRequired, false);
  assert.deepEqual(state.unackedRequestIds, []);
});

test("return message without acknowledgement is action required", () => {
  const state = deriveMortgageDeskReturnState(
    [{ id: REQUEST_ID, status: "completed", completed_at: "2026-09-27T12:00:00Z" }],
    [{ body: buildReturnMessage(REQUEST_ID), created_at: "2026-09-27T12:01:00Z" }],
  );
  assert.equal(state.actionRequired, true);
  assert.equal(state.requestId, REQUEST_ID);
  assert.deepEqual(state.unackedRequestIds, [REQUEST_ID]);
  assert.equal(state.returnedAt, "2026-09-27T12:01:00Z");
});

test("acknowledgement clears only the return-specific action required flag", () => {
  const state = deriveMortgageDeskReturnState(
    [{ id: REQUEST_ID, status: "completed", completed_at: "2026-09-27T12:00:00Z" }],
    [
      { body: buildReturnMessage(REQUEST_ID), created_at: "2026-09-27T12:01:00Z" },
      { body: buildReturnAckMessage(REQUEST_ID), created_at: "2026-09-27T12:05:00Z" },
    ],
  );
  assert.equal(state.actionRequired, false);
  assert.deepEqual(state.unackedRequestIds, []);
  assert.equal(state.requestId, REQUEST_ID);
});

test("completion replay with a second return message does not create a second action-required state", () => {
  const first = buildReturnMessage(REQUEST_ID);
  const replay = buildReturnMessage(REQUEST_ID);
  assert.equal(first, replay);
  const state = deriveMortgageDeskReturnState(
    [{ id: REQUEST_ID, status: "completed", completed_at: "2026-09-27T12:00:00Z" }],
    [
      { body: first, created_at: "2026-09-27T12:01:00Z" },
      { body: replay, created_at: "2026-09-27T12:02:00Z" },
    ],
  );
  assert.equal(state.actionRequired, true);
  assert.deepEqual(state.unackedRequestIds, [REQUEST_ID]);
});

test("in_progress and cancelled requests never become return alerts", () => {
  const state = deriveMortgageDeskReturnState(
    [
      { id: REQUEST_ID, status: "in_progress" },
      { id: OTHER_ID, status: "cancelled", completed_at: "2026-09-27T12:00:00Z" },
    ],
    [
      { body: buildReturnMessage(REQUEST_ID) },
      { body: buildReturnMessage(OTHER_ID) },
    ],
  );
  assert.equal(state.actionRequired, false);
});

test("deleted return messages are ignored", () => {
  const state = deriveMortgageDeskReturnState(
    [{ id: REQUEST_ID, status: "completed", completed_at: "2026-09-27T12:00:00Z" }],
    [{ body: buildReturnMessage(REQUEST_ID), is_deleted: true }],
  );
  assert.equal(state.actionRequired, false);
});

test("strips machine prefixes from tenant-visible message text", () => {
  assert.equal(displayCheckMessageBody(buildReturnMessage(REQUEST_ID)), MORTGAGE_DESK_RETURN_MESSAGE);
  assert.equal(displayCheckMessageBody(buildReturnAckMessage(REQUEST_ID)), "Acknowledged Mortgage Desk return.");
  assert.equal(displayCheckMessageBody("✅ existing tenant note"), "✅ existing tenant note");
});

test("returned files sort ahead of ordinary loss draft rows", () => {
  assert.equal(compareLossDraftReturnPriority(true, false), -1);
  assert.equal(compareLossDraftReturnPriority(false, true), 1);
  assert.equal(compareLossDraftReturnPriority(true, true), 0);
});
