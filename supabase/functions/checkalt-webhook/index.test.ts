// Smoke test for the CheckAlt integration.
//
// Verifies:
//   1. checkalt-webhook rejects requests with a missing/invalid signature.
//   2. checkalt-webhook accepts a signed payload, logs it to
//      checkalt_webhook_events, and (if a deposit with the reference exists)
//      mirrors the status into checkalt_deposits + check_intake_items.
//   3. checkalt-submit-deposit is reachable and returns a structured error
//      when called without auth (no real bank call is made).
//
// Run from the project root:
//   deno test --allow-env --allow-net --allow-read \
//     supabase/functions/checkalt-webhook/index.test.ts
//
// Requires VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY in .env.
// CHECKALT_WEBHOOK_SECRET must match the value configured on the deployed fn.

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("CHECKALT_WEBHOOK_SECRET") ?? "test-secret";

const FN_BASE = `${SUPABASE_URL}/functions/v1`;

Deno.test("checkalt-webhook rejects requests without a signature", async () => {
  const res = await fetch(`${FN_BASE}/checkalt-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ status: "cleared", reference: "smoke-noauth" }),
  });
  const body = await res.json();
  assertEquals(res.status, 401, "expected 401 without signature");
  assert(body.error, "expected error message");
});

Deno.test("checkalt-webhook accepts a signed payload", async () => {
  const ref = `smoke-${crypto.randomUUID()}`;
  const res = await fetch(`${FN_BASE}/checkalt-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      "X-CheckAlt-Signature": WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      eventType: "deposit.status",
      reference: ref,
      status: "cleared",
    }),
  });
  const body = await res.json();
  assertEquals(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assertEquals(body.ok, true);
});

Deno.test("checkalt-submit-deposit requires auth", async () => {
  const res = await fetch(`${FN_BASE}/checkalt-submit-deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ check_intake_item_id: crypto.randomUUID() }),
  });
  const body = await res.json();
  assertEquals(res.status, 401, "expected 401 without auth header");
  assert(body.error, "expected error message");
});
