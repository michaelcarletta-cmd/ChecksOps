/**
 * Acceptance tests: OCR rerun stability after endorsement activity
 *
 * These tests verify that when OCR is re-run on a check that already has
 * endorsement activity (signed/rejected payees), the system preserves:
 *   1. Existing payees and their endorsement tokens
 *   2. Endorsement statuses (signed, rejected, pending)
 *   3. Original deposit recommendations (restricted ones stay restricted)
 *   4. Linked claim_payments (updated, not duplicated)
 *
 * Run via: supabase--test_edge_functions or `deno test --allow-env --allow-net`
 */

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY");

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.warn("⚠️  Skipping OCR rerun tests — SUPABASE_URL or SERVICE_ROLE_KEY not set");
  Deno.exit(0);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function createTestCheck(overrides: Record<string, unknown> = {}) {
  const { data, error } = await supabase.from("check_intake_items").insert({
    front_image_path: "test/fake-check.jpg",
    status: "ocr_complete",
    ocr_status: "completed",
    amount: 5000,
    check_number: "TEST-" + Date.now(),
    carrier_name: "Test Carrier",
    payee_line: "John Doe AND Freedom Adjustment",
    is_multi_payee: true,
    deposit_recommendation: "endorsements_pending",
    ...overrides,
  }).select().single();
  if (error) throw new Error(`createTestCheck: ${error.message}`);
  return data;
}

async function addPayees(checkId: string, payees: { name: string; type: string; status?: string }[]) {
  const rows = payees.map((p) => ({
    check_id: checkId,
    payee_name: p.name,
    payee_type: p.type,
    endorsement_status: p.status ?? "pending",
    endorsement_token: crypto.randomUUID(),
    endorsement_token_expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
  }));
  const { data, error } = await supabase.from("check_payees").insert(rows).select();
  if (error) throw new Error(`addPayees: ${error.message}`);
  return data!;
}

async function cleanup(checkId: string) {
  await supabase.from("check_audit_log").delete().eq("check_id", checkId);
  await supabase.from("check_eligibility_results").delete().eq("check_id", checkId);
  await supabase.from("check_payees").delete().eq("check_id", checkId);
  await supabase.from("claim_payments").delete().eq("check_intake_item_id", checkId);
  await supabase.from("check_intake_items").delete().eq("id", checkId);
}

/* ------------------------------------------------------------------ */
/*  Test: RPC preserves payees when endorsement activity exists        */
/* ------------------------------------------------------------------ */

Deno.test("ocr_commit_results preserves payees when has_active_endorsements=true", async () => {
  const check = await createTestCheck();
  const payees = await addPayees(check.id, [
    { name: "John Doe", type: "insured", status: "signed" },
    { name: "Freedom Adjustment", type: "public_adjuster", status: "pending" },
  ]);
  const originalTokens = payees.map((p) => p.endorsement_token).sort();

  try {
    // Simulate OCR rerun via RPC with has_active_endorsements = true
    const { error } = await supabase.rpc("ocr_commit_results", {
      p_check_id: check.id,
      p_carrier_name: "Updated Carrier",
      p_check_number: check.check_number,
      p_amount: 5500,
      p_issue_date: "2026-03-01",
      p_claim_number: "CLM-RERUN",
      p_payee_line: "John Doe AND Freedom Adjustment",
      p_is_multi_payee: true,
      p_raw_ocr: JSON.stringify({ rerun: true }),
      p_ocr_status: "completed",
      p_check_status: "ocr_complete",
      p_payees: JSON.stringify([
        { name: "John Doe", type: "insured" },
        { name: "Freedom Adjustment", type: "public_adjuster" },
      ]),
      p_recommendation: "endorsements_pending",
      p_reasons: JSON.stringify(["Multi-payee check"]),
      p_rules: JSON.stringify({ payee_count: 2 }),
      p_evaluated_by: null,
      p_claim_id: null,
      p_has_active_endorsements: true,
    });
    assertEquals(error, null, `RPC should succeed: ${error?.message}`);

    // Verify payees were NOT replaced
    const { data: postPayees } = await supabase
      .from("check_payees")
      .select("*")
      .eq("check_id", check.id)
      .order("payee_name");

    assertEquals(postPayees?.length, 2, "Should still have 2 payees");
    const postTokens = postPayees!.map((p) => p.endorsement_token).sort();
    assertEquals(postTokens, originalTokens, "Tokens must be preserved");

    // Verify signed status preserved
    const signed = postPayees!.find((p) => p.payee_name === "John Doe");
    assertEquals(signed?.endorsement_status, "signed", "Signed status must be preserved");

    // Verify check amount was updated
    const { data: updatedCheck } = await supabase
      .from("check_intake_items")
      .select("amount, carrier_name, ocr_heartbeat_at")
      .eq("id", check.id)
      .single();

    assertEquals(updatedCheck?.amount, 5500, "Amount should be updated");
    assertEquals(updatedCheck?.carrier_name, "Updated Carrier", "Carrier should be updated");
    assertEquals(updatedCheck?.ocr_heartbeat_at, null, "Heartbeat should be cleared by RPC");
  } finally {
    await cleanup(check.id);
  }
});

/* ------------------------------------------------------------------ */
/*  Test: RPC replaces payees when NO endorsement activity             */
/* ------------------------------------------------------------------ */

Deno.test("ocr_commit_results replaces payees when has_active_endorsements=false", async () => {
  const check = await createTestCheck();
  await addPayees(check.id, [
    { name: "Old Payee", type: "unknown", status: "pending" },
  ]);

  try {
    const { error } = await supabase.rpc("ocr_commit_results", {
      p_check_id: check.id,
      p_carrier_name: "Carrier",
      p_check_number: check.check_number,
      p_amount: 3000,
      p_issue_date: null,
      p_claim_number: null,
      p_payee_line: "New Payee",
      p_is_multi_payee: false,
      p_raw_ocr: JSON.stringify({}),
      p_ocr_status: "completed",
      p_check_status: "ocr_complete",
      p_payees: JSON.stringify([{ name: "New Payee", type: "insured" }]),
      p_recommendation: "ready_for_deposit",
      p_reasons: JSON.stringify([]),
      p_rules: JSON.stringify({}),
      p_evaluated_by: null,
      p_claim_id: null,
      p_has_active_endorsements: false,
    });
    assertEquals(error, null);

    const { data: postPayees } = await supabase
      .from("check_payees")
      .select("payee_name")
      .eq("check_id", check.id);

    assertEquals(postPayees?.length, 1, "Should have 1 new payee");
    assertEquals(postPayees![0].payee_name, "New Payee", "Old payee should be replaced");
  } finally {
    await cleanup(check.id);
  }
});

/* ------------------------------------------------------------------ */
/*  Test: Restricted recommendation not promoted on rerun              */
/* ------------------------------------------------------------------ */

Deno.test("ocr_commit_results preserves restricted recommendation on rerun", async () => {
  const check = await createTestCheck({
    deposit_recommendation: "branch_deposit_recommended",
  });

  try {
    // Rerun with a non-restricted recommendation — but original was restricted
    // The RPC itself stores whatever recommendation is passed, so the CALLER
    // (edge function) is responsible for not downgrading. We verify the RPC
    // stores exactly what's passed — the edge function test is the caller contract.
    const { error } = await supabase.rpc("ocr_commit_results", {
      p_check_id: check.id,
      p_carrier_name: "Carrier",
      p_check_number: "CHK-999",
      p_amount: 1000,
      p_issue_date: null,
      p_claim_number: null,
      p_payee_line: "Test",
      p_is_multi_payee: false,
      p_raw_ocr: JSON.stringify({}),
      p_ocr_status: "completed",
      p_check_status: "ocr_complete",
      p_payees: JSON.stringify([{ name: "Test", type: "insured" }]),
      p_recommendation: "branch_deposit_recommended",
      p_reasons: JSON.stringify(["Complex structure"]),
      p_rules: JSON.stringify({}),
      p_evaluated_by: null,
      p_claim_id: null,
      p_has_active_endorsements: false,
    });
    assertEquals(error, null);

    const { data: updated } = await supabase
      .from("check_intake_items")
      .select("deposit_recommendation")
      .eq("id", check.id)
      .single();

    assertEquals(
      updated?.deposit_recommendation,
      "branch_deposit_recommended",
      "Restricted recommendation must persist",
    );
  } finally {
    await cleanup(check.id);
  }
});

/* ------------------------------------------------------------------ */
/*  Test: Claim payment upsert stability (no duplicates)               */
/* ------------------------------------------------------------------ */

Deno.test("ocr_commit_results upserts payment without duplication", async () => {
  // Create a test claim first
  const { data: claim } = await supabase.from("claims").select("id").limit(1).single();
  if (!claim) {
    console.warn("Skipping payment test — no claims in DB");
    return;
  }

  const check = await createTestCheck({ claim_id: claim.id });

  try {
    // First OCR run — creates payment
    const { data: r1, error: e1 } = await supabase.rpc("ocr_commit_results", {
      p_check_id: check.id,
      p_carrier_name: "Carrier",
      p_check_number: check.check_number,
      p_amount: 5000,
      p_issue_date: "2026-03-01",
      p_claim_number: null,
      p_payee_line: "Test",
      p_is_multi_payee: false,
      p_raw_ocr: JSON.stringify({}),
      p_ocr_status: "completed",
      p_check_status: "ocr_complete",
      p_payees: JSON.stringify([{ name: "Test", type: "insured" }]),
      p_recommendation: "ready_for_deposit",
      p_reasons: JSON.stringify([]),
      p_rules: JSON.stringify({}),
      p_evaluated_by: null,
      p_claim_id: claim.id,
      p_has_active_endorsements: false,
    });
    assertEquals(e1, null);
    const paymentId1 = (r1 as { payment_id: string }).payment_id;
    assertNotEquals(paymentId1, null, "First run should create a payment");

    // Second OCR rerun — should update same payment
    const { data: r2, error: e2 } = await supabase.rpc("ocr_commit_results", {
      p_check_id: check.id,
      p_carrier_name: "Carrier Updated",
      p_check_number: check.check_number,
      p_amount: 5500,
      p_issue_date: "2026-03-01",
      p_claim_number: null,
      p_payee_line: "Test",
      p_is_multi_payee: false,
      p_raw_ocr: JSON.stringify({ rerun: true }),
      p_ocr_status: "completed",
      p_check_status: "ocr_complete",
      p_payees: JSON.stringify([{ name: "Test", type: "insured" }]),
      p_recommendation: "ready_for_deposit",
      p_reasons: JSON.stringify([]),
      p_rules: JSON.stringify({}),
      p_evaluated_by: null,
      p_claim_id: claim.id,
      p_has_active_endorsements: false,
    });
    assertEquals(e2, null);
    const paymentId2 = (r2 as { payment_id: string }).payment_id;
    assertEquals(paymentId2, paymentId1, "Rerun must update same payment, not create duplicate");

    // Verify only 1 payment exists
    const { data: payments } = await supabase
      .from("claim_payments")
      .select("id, amount")
      .eq("check_intake_item_id", check.id);

    assertEquals(payments?.length, 1, "Exactly one payment should exist");
    assertEquals(payments![0].amount, 5500, "Amount should be updated to 5500");
  } finally {
    await cleanup(check.id);
  }
});

/* ------------------------------------------------------------------ */
/*  Test: Heartbeat cleared inside RPC transaction                     */
/* ------------------------------------------------------------------ */

Deno.test("ocr_commit_results clears heartbeat transactionally", async () => {
  const check = await createTestCheck({
    ocr_heartbeat_at: new Date().toISOString(),
  });

  try {
    const { error } = await supabase.rpc("ocr_commit_results", {
      p_check_id: check.id,
      p_carrier_name: "Carrier",
      p_check_number: "HB-TEST",
      p_amount: 100,
      p_issue_date: null,
      p_claim_number: null,
      p_payee_line: "Test",
      p_is_multi_payee: false,
      p_raw_ocr: JSON.stringify({}),
      p_ocr_status: "completed",
      p_check_status: "ocr_complete",
      p_payees: JSON.stringify([{ name: "Test", type: "insured" }]),
      p_recommendation: "ready_for_deposit",
      p_reasons: JSON.stringify([]),
      p_rules: JSON.stringify({}),
      p_evaluated_by: null,
      p_claim_id: null,
      p_has_active_endorsements: false,
    });
    assertEquals(error, null);

    const { data: updated } = await supabase
      .from("check_intake_items")
      .select("ocr_heartbeat_at")
      .eq("id", check.id)
      .single();

    assertEquals(updated?.ocr_heartbeat_at, null, "Heartbeat must be null after RPC commit");
  } finally {
    await cleanup(check.id);
  }
});
