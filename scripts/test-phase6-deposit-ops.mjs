#!/usr/bin/env node
/**
 * Phase 6 acceptance tests — exception resolution, closeout, aging
 * Run: node scripts/test-phase6-deposit-ops.mjs
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log(`  ✅ ${msg}`); } else { fail++; console.error(`  ❌ ${msg}`); } }

async function rpc(fn, params) {
  const { data, error } = await sb.rpc(fn, params);
  return { data, error };
}

async function cleanup() {
  await sb.from("deposit_exceptions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("deposit_audit_log").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("deposit_provider_attempts").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("deposit_attachments").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("deposit_items").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("deposit_batches").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}

async function main() {
  console.log("\n🧪 Phase 6 Acceptance Tests\n");

  // Setup: get a staff user
  const { data: staffUsers } = await sb.from("user_roles").select("user_id").eq("role", "staff").limit(1);
  const staffId = staffUsers?.[0]?.user_id;
  if (!staffId) { console.error("No staff user found"); process.exit(1); }

  await cleanup();

  // Create a test deposit item directly
  const { data: item } = await sb.from("deposit_items").insert({
    check_id: null,
    amount: 5000,
    check_number: "TST-P6-001",
    carrier_name: "Test Carrier P6",
    status: "succeeded",
    provider: "manual_branch",
    cleared_at: new Date().toISOString(),
  }).select().single();
  const itemId = item.id;

  // === Test 1: resolve_deposit_exception ===
  console.log("--- Exception Resolution ---");

  // Insert an exception
  const { data: exc } = await sb.from("deposit_exceptions").insert({
    deposit_item_id: itemId,
    exception_type: "amount_mismatch",
    exception_code: "BANK_VARIANCE",
    description: "Test variance exception",
    severity: "warning",
    provider: "manual_branch",
  }).select().single();

  // Resolve without notes → should fail
  const { error: e1 } = await rpc("resolve_deposit_exception", {
    p_exception_id: exc.id, p_actor_id: staffId, p_resolution_notes: "", p_action: "resolve"
  });
  assert(!!e1, "resolve_exception rejects empty notes");

  // Resolve with notes → should succeed
  const { data: r2, error: e2 } = await rpc("resolve_deposit_exception", {
    p_exception_id: exc.id, p_actor_id: staffId, p_resolution_notes: "Verified with bank", p_action: "resolve"
  });
  assert(!e2 && r2?.success, "resolve_exception succeeds with notes");

  // Check resolved_at is set
  const { data: excCheck } = await sb.from("deposit_exceptions").select("resolved_at, resolution_notes").eq("id", exc.id).single();
  assert(!!excCheck?.resolved_at, "resolved_at is set");
  assert(excCheck?.resolution_notes === "Verified with bank", "resolution_notes stored");

  // Double resolve → should fail
  const { error: e3 } = await rpc("resolve_deposit_exception", {
    p_exception_id: exc.id, p_actor_id: staffId, p_resolution_notes: "Again", p_action: "resolve"
  });
  assert(!!e3, "double resolve rejected");

  // Reopen → should succeed
  const { data: r4, error: e4 } = await rpc("resolve_deposit_exception", {
    p_exception_id: exc.id, p_actor_id: staffId, p_resolution_notes: "Need to re-examine", p_action: "reopen"
  });
  assert(!e4 && r4?.success, "reopen_exception succeeds");

  const { data: excReopen } = await sb.from("deposit_exceptions").select("resolved_at, reopened_at, reopen_reason").eq("id", exc.id).single();
  assert(!excReopen?.resolved_at, "resolved_at cleared on reopen");
  assert(!!excReopen?.reopened_at, "reopened_at set");
  assert(excReopen?.reopen_reason === "Need to re-examine", "reopen_reason stored");

  // Reopen when already open → should fail
  const { error: e5 } = await rpc("resolve_deposit_exception", {
    p_exception_id: exc.id, p_actor_id: staffId, p_resolution_notes: "Again", p_action: "reopen"
  });
  assert(!!e5, "reopen on open exception rejected");

  // === Test 2: mark_deposit_closeout ===
  console.log("\n--- Closeout Validation ---");

  // Item is succeeded but NOT bank-confirmed, reconciled, or synced → closeout blocked
  const { error: e6 } = await rpc("mark_deposit_closeout", {
    p_deposit_item_id: itemId, p_actor_id: staffId
  });
  assert(!!e6, "closeout blocked when missing bank_confirm");
  assert(e6?.message?.includes("no_bank_confirmation"), "error mentions bank confirmation");

  // Bank confirm
  await sb.from("deposit_items").update({ bank_confirmed_at: new Date().toISOString() }).eq("id", itemId);

  // Still blocked - not reconciled
  const { error: e7 } = await rpc("mark_deposit_closeout", {
    p_deposit_item_id: itemId, p_actor_id: staffId
  });
  assert(!!e7 && e7.message?.includes("not_reconciled"), "closeout blocked when not reconciled");

  // Reconcile
  await sb.from("deposit_items").update({ status: "reconciled", reconciled_at: new Date().toISOString() }).eq("id", itemId);

  // Still blocked - not synced
  const { error: e8 } = await rpc("mark_deposit_closeout", {
    p_deposit_item_id: itemId, p_actor_id: staffId
  });
  assert(!!e8 && e8.message?.includes("not_accounting_synced"), "closeout blocked when not synced");

  // Sync accounting
  await sb.from("deposit_items").update({ accounting_synced_at: new Date().toISOString() }).eq("id", itemId);

  // Still blocked - open exception
  const { error: e9 } = await rpc("mark_deposit_closeout", {
    p_deposit_item_id: itemId, p_actor_id: staffId
  });
  assert(!!e9 && e9.message?.includes("open_exceptions"), "closeout blocked with open exception");

  // Resolve the exception
  await rpc("resolve_deposit_exception", {
    p_exception_id: exc.id, p_actor_id: staffId, p_resolution_notes: "Final resolution", p_action: "resolve"
  });

  // Now closeout should succeed
  const { data: r10, error: e10 } = await rpc("mark_deposit_closeout", {
    p_deposit_item_id: itemId, p_actor_id: staffId
  });
  assert(!e10 && r10?.success, "closeout succeeds when all requirements met");

  const { data: closedItem } = await sb.from("deposit_items").select("closeout_complete, closeout_at").eq("id", itemId).single();
  assert(closedItem?.closeout_complete === true, "closeout_complete flag set");
  assert(!!closedItem?.closeout_at, "closeout_at timestamp set");

  // Double closeout → rejected
  const { error: e11 } = await rpc("mark_deposit_closeout", {
    p_deposit_item_id: itemId, p_actor_id: staffId
  });
  assert(!!e11, "double closeout rejected");

  // === Test 3: Aging summary ===
  console.log("\n--- Aging Summary ---");
  const { data: aging, error: e12 } = await rpc("get_deposit_aging_summary", {});
  assert(!e12, "aging summary RPC succeeds");
  assert(typeof aging?.complete === "number", "aging summary has complete count");

  // === Test 4: Audit trail completeness ===
  console.log("\n--- Audit Trail ---");
  const { data: audits } = await sb.from("deposit_audit_log").select("action").eq("deposit_item_id", itemId);
  const auditActions = (audits ?? []).map(a => a.action);
  assert(auditActions.includes("resolve_exception"), "audit has resolve_exception");
  assert(auditActions.includes("reopen_exception"), "audit has reopen_exception");
  assert(auditActions.includes("mark_closeout_complete"), "audit has mark_closeout_complete");

  await cleanup();

  console.log(`\n📊 Results: ${pass} passed, ${fail} failed out of ${pass + fail}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
