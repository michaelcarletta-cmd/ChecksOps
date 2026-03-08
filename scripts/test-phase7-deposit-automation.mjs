#!/usr/bin/env node
/**
 * Phase 7 acceptance tests — ownership, next-action, bulk ops, KPIs
 * Run: node scripts/test-phase7-deposit-automation.mjs
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
  console.log("\n🧪 Phase 7 Acceptance Tests\n");

  const { data: staffUsers } = await sb.from("user_roles").select("user_id").eq("role", "staff").limit(2);
  const staffId = staffUsers?.[0]?.user_id;
  const staffId2 = staffUsers?.[1]?.user_id ?? staffId;
  if (!staffId) { console.error("No staff user found"); process.exit(1); }

  await cleanup();

  // Create test items in various states
  const items = [];
  for (const [status, extra] of [
    ["pending_assignment", {}],
    ["provider_assigned", { provider: "manual_branch" }],
    ["succeeded", { provider: "manual_branch", cleared_at: new Date().toISOString() }],
    ["reconciled", { provider: "manual_branch", cleared_at: new Date().toISOString(), bank_confirmed_at: new Date().toISOString(), reconciled_at: new Date().toISOString() }],
  ]) {
    const { data } = await sb.from("deposit_items").insert({
      check_id: null, amount: 1000 + items.length * 500, check_number: `P7-${items.length + 1}`,
      carrier_name: "Test Carrier", status, ...extra,
    }).select().single();
    items.push(data);
  }

  // === Test 1: assign_deposit_owner ===
  console.log("--- Owner Assignment ---");
  const { data: r1, error: e1 } = await rpc("assign_deposit_owner", {
    p_deposit_item_ids: items.map(i => i.id), p_owner_id: staffId, p_actor_id: staffId
  });
  assert(!e1 && r1?.success, "assign_deposit_owner succeeds");
  assert(r1?.updated === 4, "all 4 items assigned");

  const { data: check1 } = await sb.from("deposit_items").select("owner_id, owner_assigned_at").eq("id", items[0].id).single();
  assert(check1?.owner_id === staffId, "owner_id set correctly");
  assert(!!check1?.owner_assigned_at, "owner_assigned_at timestamp set");

  // Reassign to different owner
  const { data: r1b } = await rpc("assign_deposit_owner", {
    p_deposit_item_ids: [items[0].id], p_owner_id: staffId2, p_actor_id: staffId
  });
  assert(r1b?.success, "reassignment succeeds");

  // === Test 2: generate_next_deposit_action ===
  console.log("\n--- Next Action Generation ---");

  const { data: a1 } = await rpc("generate_next_deposit_action", { p_deposit_item_id: items[0].id });
  assert(a1?.action === "assign_provider", "pending_assignment → assign_provider");

  const { data: a2 } = await rpc("generate_next_deposit_action", { p_deposit_item_id: items[1].id });
  assert(a2?.action === "mark_deposited", "provider_assigned → mark_deposited");

  const { data: a3 } = await rpc("generate_next_deposit_action", { p_deposit_item_id: items[2].id });
  // Succeeded but no bank_confirmed_at, no deposit slip
  assert(a3?.action === "upload_deposit_slip" || a3?.action === "bank_confirm", "succeeded → upload slip or bank confirm");

  // Item 3: reconciled + bank confirmed, no accounting sync
  const { data: a4 } = await rpc("generate_next_deposit_action", { p_deposit_item_id: items[3].id });
  assert(a4?.action === "sync_accounting", "reconciled without sync → sync_accounting");

  // After syncing, should recommend closeout
  await sb.from("deposit_items").update({ accounting_synced_at: new Date().toISOString() }).eq("id", items[3].id);
  const { data: a5 } = await rpc("generate_next_deposit_action", { p_deposit_item_id: items[3].id });
  assert(a5?.action === "closeout", "fully ready → closeout");

  // Add exception → should override to resolve_exceptions
  await sb.from("deposit_exceptions").insert({
    deposit_item_id: items[3].id, exception_type: "test", exception_code: "TEST", description: "test", severity: "warning", provider: "manual_branch",
  });
  const { data: a6 } = await rpc("generate_next_deposit_action", { p_deposit_item_id: items[3].id });
  assert(a6?.action === "resolve_exceptions", "open exception overrides to resolve_exceptions");

  // Verify next_action persisted on the item
  const { data: itemCheck } = await sb.from("deposit_items").select("next_action, next_action_reason, next_action_generated_at").eq("id", items[3].id).single();
  assert(itemCheck?.next_action === "resolve_exceptions", "next_action persisted on deposit_items");
  assert(!!itemCheck?.next_action_generated_at, "next_action_generated_at set");

  // === Test 3: bulk_resolve_deposit_exceptions ===
  console.log("\n--- Bulk Resolve Exceptions ---");
  const { data: excRows } = await sb.from("deposit_exceptions").select("id").eq("deposit_item_id", items[3].id).is("resolved_at", null);
  const excIds = excRows.map(e => e.id);

  // Without notes → fail
  const { error: be1 } = await rpc("bulk_resolve_deposit_exceptions", {
    p_exception_ids: excIds, p_actor_id: staffId, p_resolution_notes: ""
  });
  assert(!!be1, "bulk resolve without notes rejected");

  const { data: br2, error: be2 } = await rpc("bulk_resolve_deposit_exceptions", {
    p_exception_ids: excIds, p_actor_id: staffId, p_resolution_notes: "Batch resolved"
  });
  assert(!be2 && br2?.resolved > 0, "bulk resolve succeeds with notes");

  // === Test 4: bulk_sync_deposit_accounting ===
  console.log("\n--- Bulk Sync Accounting ---");
  // Item 2 is succeeded with no sync
  const { data: bs1 } = await rpc("bulk_sync_deposit_accounting", {
    p_deposit_item_ids: [items[2].id], p_actor_id: staffId
  });
  assert(bs1?.success && bs1?.synced === 1, "bulk sync accounting succeeds");

  const { data: syncCheck } = await sb.from("deposit_items").select("accounting_synced_at").eq("id", items[2].id).single();
  assert(!!syncCheck?.accounting_synced_at, "accounting_synced_at set after bulk sync");

  // === Test 5: bulk_deposit_closeout ===
  console.log("\n--- Bulk Closeout ---");

  // Item 3 should be closable (resolved exception, synced, reconciled, confirmed)
  const { data: bc1 } = await rpc("bulk_deposit_closeout", {
    p_deposit_item_ids: items.map(i => i.id), p_actor_id: staffId
  });
  assert(bc1?.success, "bulk closeout completes");
  assert(bc1?.closed >= 1, "at least 1 item closed");
  assert(bc1?.skipped >= 1, "at least 1 item skipped (missing requirements)");

  // === Test 6: KPI RPCs ===
  console.log("\n--- KPI RPCs ---");
  const { data: kpis, error: ke1 } = await rpc("get_deposit_ops_kpis", {});
  assert(!ke1, "deposit ops KPIs RPC succeeds");
  assert(typeof kpis?.total_items === "number", "KPIs include total_items");
  assert(typeof kpis?.nsf_rate_pct === "number" || kpis?.nsf_rate_pct === null, "KPIs include nsf_rate_pct");

  const { data: excKpis, error: ke2 } = await rpc("get_deposit_exception_kpis", {});
  assert(!ke2, "exception KPIs RPC succeeds");
  assert(typeof excKpis?.total_exceptions === "number", "exception KPIs include total_exceptions");

  // === Test 7: Audit trail completeness ===
  console.log("\n--- Audit Trail ---");
  const { data: audits } = await sb.from("deposit_audit_log").select("action").order("created_at");
  const actions = [...new Set((audits ?? []).map(a => a.action))];
  assert(actions.includes("assign_owner"), "audit has assign_owner");
  assert(actions.includes("bulk_resolve_exception"), "audit has bulk_resolve_exception");
  assert(actions.includes("bulk_sync_accounting"), "audit has bulk_sync_accounting");
  assert(actions.includes("bulk_closeout"), "audit has bulk_closeout");

  await cleanup();

  console.log(`\n📊 Results: ${pass} passed, ${fail} failed out of ${pass + fail}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
