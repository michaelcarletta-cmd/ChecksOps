import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  MORTGAGE_DESK_RETURN_ID_CHUNK,
  MORTGAGE_DESK_RETURN_MESSAGE,
  MORTGAGE_DESK_RETURN_PAGE_SIZE,
  buildMortgageDeskCompletedMessage,
  chunkMortgageDeskReturnIds,
  fetchAllMortgageDeskReturnPages,
  loadMortgageDeskReturnStates,
  mortgageDeskCompletionPostedByClient,
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

test("completion keeps the existing completed-work message with notes alongside the return marker", () => {
  const completed = buildMortgageDeskCompletedMessage("Rocket Mortgage", "Endorsed and mailed back");
  assert.equal(
    completed,
    "✅ ChecksOps Mortgage Desk completed work with Rocket Mortgage. Notes: Endorsed and mailed back",
  );
  assert.equal(
    buildMortgageDeskCompletedMessage(null, null),
    "✅ ChecksOps Mortgage Desk completed work with the mortgage company.",
  );
  // The existing message is not a machine marker and is shown verbatim.
  assert.equal(isReturnMessage(completed), false);
  assert.equal(isReturnAckMessage(completed), false);
  assert.equal(displayCheckMessageBody(completed), completed);
  // Both messages coexist on the thread; the marker alone drives the alert.
  const state = deriveMortgageDeskReturnState(
    [{ id: REQUEST_ID, status: "completed", completed_at: "2026-09-27T12:00:00Z" }],
    [
      { body: completed, created_at: "2026-09-27T12:01:00Z" },
      { body: buildReturnMessage(REQUEST_ID), created_at: "2026-09-27T12:01:01Z" },
    ],
  );
  assert.equal(state.actionRequired, true);
  assert.deepEqual(state.unackedRequestIds, [REQUEST_ID]);
  const withoutMarker = deriveMortgageDeskReturnState(
    [{ id: REQUEST_ID, status: "completed", completed_at: "2026-09-27T12:00:00Z" }],
    [{ body: completed, created_at: "2026-09-27T12:01:00Z" }],
  );
  assert.equal(withoutMarker.actionRequired, false);
});

test("on the AWS backend the client no longer posts the completion messages; Supabase keeps them", () => {
  assert.equal(mortgageDeskCompletionPostedByClient(true), false);
  assert.equal(mortgageDeskCompletionPostedByClient(false), true);

  const queue = fs.readFileSync(new URL("../src/pages/mortgage-ops/MortgageOpsQueue.tsx", import.meta.url), "utf8");
  const guard = queue.indexOf("if (mortgageDeskCompletionPostedByClient(mortgageUsesAwsBackend)) {");
  assert.ok(guard > 0, "client posts are guarded by the backend check");
  const guardEnd = queue.indexOf("\n        }\n", guard);
  assert.ok(guardEnd > guard);
  const guarded = queue.slice(guard, guardEnd);
  // Both client-side posts live only inside the Supabase-backend branch.
  assert.match(guarded, /from\("check_messages"\)\.insert/);
  assert.match(guarded, /buildMortgageDeskCompletedMessage\(row\.mortgage_company \|\| row\.mortgage_servicer, notes\)/);
  assert.match(guarded, /ensureMortgageDeskReturnMessage\(/);
  const outside = queue.slice(0, guard) + queue.slice(guardEnd);
  assert.doesNotMatch(outside, /from\("check_messages"\)/);
  assert.doesNotMatch(outside, /ensureMortgageDeskReturnMessage\(\{/);
  // The "not notified" toast can only come from a client-side post failure.
  assert.match(queue, /let returnMarkerError: string \| null = null;\n\s+if \(mortgageDeskCompletionPostedByClient/);

  const client = fs.readFileSync(new URL("../src/integrations/supabase/mortgageClient.ts", import.meta.url), "utf8");
  assert.match(client, /export const mortgageUsesAwsBackend: boolean = shouldUseAws;/);
});

test("SQL 99 posts the same bodies the SPA builders produce", () => {
  const sql = fs.readFileSync(new URL("../aws/workflows/sql/99_mortgage_desk_completion_messages.sql", import.meta.url), "utf8");
  // Marker: 'MORTGAGE_DESK_RETURN:' || id || ' ' || MORTGAGE_DESK_RETURN_MESSAGE.
  assert.ok(sql.includes(`v_marker_prefix := 'MORTGAGE_DESK_RETURN:' || NEW.id::text;`));
  assert.ok(sql.includes(`v_marker_prefix || ' ${MORTGAGE_DESK_RETURN_MESSAGE}'`));
  assert.equal(buildReturnMessage(REQUEST_ID), `MORTGAGE_DESK_RETURN:${REQUEST_ID} ${MORTGAGE_DESK_RETURN_MESSAGE}`);
  // Completed-work note: the builder's fixed text around company and notes.
  const sample = buildMortgageDeskCompletedMessage("ACME", "N");
  assert.equal(sample, "✅ ChecksOps Mortgage Desk completed work with ACME. Notes: N");
  assert.ok(sql.includes(`'✅ ChecksOps Mortgage Desk completed work with ' || v_company || '.'`));
  assert.ok(sql.includes(`' Notes: ' || v_note`));
  assert.ok(sql.includes(`'the mortgage company'`));
});

/**
 * Fake data client with the AWS data API's paging rules: LIMIT 200 when no
 * limit is sent, clamp to 500, no implicit ORDER BY (rows come back in
 * insertion order here, which is what a missing ORDER BY can look like).
 */
function fakeDataClient(tables: Record<string, Array<Record<string, unknown>>>) {
  const calls: Array<{ table: string; inIds: string[]; order: string | null; limit: number | null; offset: number | null }> = [];
  const client = {
    calls,
    from(table: string) {
      return {
        select(_columns: string) {
          const state = {
            filters: [] as Array<(row: Record<string, unknown>) => boolean>,
            inIds: [] as string[],
            order: null as { column: string; ascending: boolean } | null,
            limit: null as number | null,
            offset: null as number | null,
          };
          const chain = {
            select: () => chain,
            in(column: string, values: string[]) {
              state.inIds = values;
              state.filters.push((row) => values.includes(String(row[column])));
              return chain;
            },
            eq(column: string, value: unknown) {
              state.filters.push((row) => row[column] === value);
              return chain;
            },
            like(column: string, pattern: string) {
              const prefix = pattern.replace(/%$/, "");
              state.filters.push((row) => String(row[column] ?? "").startsWith(prefix));
              return chain;
            },
            order(column: string, options?: { ascending?: boolean }) {
              state.order = { column, ascending: options?.ascending !== false };
              return chain;
            },
            range(from: number, to: number) {
              state.offset = from;
              state.limit = to - from + 1;
              return chain;
            },
            then(resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) {
              calls.push({
                table,
                inIds: state.inIds,
                order: state.order?.column ?? null,
                limit: state.limit,
                offset: state.offset,
              });
              let rows = (tables[table] || []).filter((row) => state.filters.every((f) => f(row)));
              if (state.order) {
                const { column, ascending } = state.order;
                rows = rows.slice().sort((a, b) => {
                  const x = String(a[column] ?? "");
                  const y = String(b[column] ?? "");
                  return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
                });
              }
              const limit = state.limit == null ? 200 : Math.min(Math.max(state.limit, 1), 500);
              const offset = state.offset ?? 0;
              return Promise.resolve({ data: rows.slice(offset, offset + limit), error: null }).then(resolve);
            },
          };
          return chain;
        },
      };
    },
  };
  return client;
}

const uuidFor = (n: number, prefix = "c") =>
  `${prefix === "c" ? "aaaaaaaa" : "bbbbbbbb"}-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("return state is not truncated by the data API default page cap", async () => {
  const checks = 150;
  const requests: Array<Record<string, unknown>> = [];
  const messages: Array<Record<string, unknown>> = [];
  const checkIds: string[] = [];
  for (let i = 0; i < checks; i += 1) {
    const checkId = uuidFor(i, "c");
    const requestId = uuidFor(i, "r");
    checkIds.push(checkId);
    requests.push({
      id: requestId,
      check_intake_item_id: checkId,
      status: "completed",
      completed_at: `2026-10-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
      created_at: `2026-10-01T00:00:00Z`,
    });
    messages.push({
      id: `m-ret-${i}`,
      check_id: checkId,
      body: buildReturnMessage(requestId),
      created_at: `2026-10-02T00:00:00.${String(i).padStart(3, "0")}Z`,
      is_deleted: false,
    });
  }
  // Acks for every check except the last, written after all the returns, so an
  // un-paged read (first 200 rows) would drop acks and resurrect stale banners.
  for (let i = 0; i < checks - 1; i += 1) {
    messages.push({
      id: `m-ack-${i}`,
      check_id: uuidFor(i, "c"),
      body: buildReturnAckMessage(uuidFor(i, "r")),
      created_at: `2026-10-03T00:00:00.${String(i).padStart(3, "0")}Z`,
      is_deleted: false,
    });
  }
  const client = fakeDataClient({ mortgage_handling_requests: requests, check_messages: messages });
  const states = await loadMortgageDeskReturnStates(client, checkIds);

  const required = Object.entries(states).filter(([, s]) => s.actionRequired).map(([id]) => id);
  assert.deepEqual(required, [uuidFor(checks - 1, "c")]);
  assert.deepEqual(states[uuidFor(checks - 1, "c")].unackedRequestIds, [uuidFor(checks - 1, "r")]);
  assert.equal(Object.keys(states).length, checks);

  for (const call of client.calls) {
    assert.ok(call.inIds.length <= MORTGAGE_DESK_RETURN_ID_CHUNK, "check ids are chunked");
    assert.equal(call.order, "created_at");
    assert.equal(call.limit, MORTGAGE_DESK_RETURN_PAGE_SIZE);
    assert.notEqual(call.offset, null);
  }
});

test("return state pages until a short page comes back", async () => {
  const checkId = uuidFor(1, "c");
  const requestId = uuidFor(1, "r");
  const messages: Array<Record<string, unknown>> = [];
  // Many unrelated return rows for other requests on the same check, then the
  // real return and its ack well past the first page.
  for (let i = 0; i < 7; i += 1) {
    messages.push({
      id: `noise-${i}`,
      check_id: checkId,
      body: buildReturnAckMessage(uuidFor(100 + i, "r")),
      created_at: `2026-10-01T00:00:0${i}Z`,
      is_deleted: false,
    });
  }
  messages.push({
    id: "ret",
    check_id: checkId,
    body: buildReturnMessage(requestId),
    created_at: "2026-10-02T00:00:00Z",
    is_deleted: false,
  });
  const client = fakeDataClient({
    mortgage_handling_requests: [
      { id: requestId, check_intake_item_id: checkId, status: "completed", completed_at: "2026-10-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z" },
    ],
    check_messages: messages,
  });
  const states = await loadMortgageDeskReturnStates(client, [checkId], { pageSize: 3 });
  assert.equal(states[checkId].actionRequired, true);
  assert.deepEqual(states[checkId].unackedRequestIds, [requestId]);
  const messageCalls = client.calls.filter((c) => c.table === "check_messages");
  // 8 rows at page size 3: pages of 3, 3, 2 (short page stops paging).
  assert.deepEqual(messageCalls.map((c) => c.offset), [0, 3, 6]);
});

test("return state chunks check ids and surfaces read errors", async () => {
  assert.deepEqual(
    chunkMortgageDeskReturnIds(["a", "b", "a", "", "c"], 2),
    [["a", "b"], ["c"]],
  );
  await assert.rejects(
    fetchAllMortgageDeskReturnPages(async () => ({ data: null, error: { message: "boom" } })),
    /boom/,
  );
});
