/**
 * Acceptance tests for submit_check_review_decision RPC
 * 
 * These tests verify:
 * 1. Status-transition validation rejects invalid transitions
 * 2. merge_only mode performs merges without status changes
 * 3. Approved path creates decision + audit atomically
 * 4. Reissue path creates reissue request + audit
 * 5. Field edits produce audit rows
 * 6. Payee merge preserves active endorsement targets
 */

import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, serviceKey);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function createTestCheck(status: string, recommendation: string | null = null) {
  const { data, error } = await supabase
    .from("check_intake_items")
    .insert({
      front_image_path: `test/acceptance/${crypto.randomUUID()}.jpg`,
      status,
      deposit_recommendation: recommendation,
      carrier_name: "Test Carrier",
      check_number: `TST-${Date.now()}`,
      amount: 1500.00,
      ocr_status: "completed",
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function createTestPayee(checkId: string, name: string, status = "pending") {
  const { data, error } = await supabase
    .from("check_payees")
    .insert({
      check_id: checkId,
      payee_name: name,
      payee_type: "insured",
      endorsement_status: status,
      endorsement_token: crypto.randomUUID(),
      endorsement_token_expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getTestStaffId(): Promise<string> {
  const { data } = await supabase
    .from("user_roles")
    .select("user_id")
    .in("role", ["staff", "admin"])
    .limit(1)
    .single();
  if (!data) throw new Error("No staff/admin user found for testing");
  return data.user_id;
}

async function cleanup(checkId: string) {
  await supabase.from("check_audit_log").delete().eq("check_id", checkId);
  await supabase.from("check_review_decisions").delete().eq("check_id", checkId);
  await supabase.from("check_reissue_requests").delete().eq("check_id", checkId);
  await supabase.from("check_payees").delete().eq("check_id", checkId);
  await supabase.from("check_eligibility_results").delete().eq("check_id", checkId);
  await supabase.from("check_intake_items").delete().eq("id", checkId);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

Deno.test("rejects invalid status transition: deposited → approved_for_deposit", async () => {
  const staffId = await getTestStaffId();
  const check = await createTestCheck("deposited");
  try {
    const { error } = await supabase.rpc("submit_check_review_decision", {
      p_check_id: check.id,
      p_reviewer_id: staffId,
      p_deposit_path: "approved_for_deposit",
    });
    assertEquals(error !== null, true, "Should reject invalid transition");
    assertEquals(error!.message.includes("Invalid status transition"), true);
  } finally {
    await cleanup(check.id);
  }
});

Deno.test("allows valid transition: needs_review → approved_for_deposit", async () => {
  const staffId = await getTestStaffId();
  const check = await createTestCheck("needs_review");
  try {
    const { data, error } = await supabase.rpc("submit_check_review_decision", {
      p_check_id: check.id,
      p_reviewer_id: staffId,
      p_deposit_path: "approved_for_deposit",
      p_reviewer_notes: "Acceptance test",
    });
    assertEquals(error, null, `RPC should succeed: ${error?.message}`);
    assertEquals(data.success, true);

    // Verify check was updated
    const { data: updated } = await supabase
      .from("check_intake_items")
      .select("status, deposit_recommendation, reviewed_by")
      .eq("id", check.id)
      .single();
    assertEquals(updated!.status, "approved_for_deposit");
    assertEquals(updated!.deposit_recommendation, "ready_for_deposit");
    assertEquals(updated!.reviewed_by, staffId);

    // Verify decision record
    const { data: decisions } = await supabase
      .from("check_review_decisions")
      .select("*")
      .eq("check_id", check.id);
    assertEquals(decisions!.length, 1);
    assertEquals(decisions![0].deposit_path, "approved_for_deposit");

    // Verify audit log
    const { data: audit } = await supabase
      .from("check_audit_log")
      .select("event_type")
      .eq("check_id", check.id)
      .eq("event_type", "review_decision");
    assertEquals(audit!.length >= 1, true);
  } finally {
    await cleanup(check.id);
  }
});

Deno.test("reissue creates request + audit", async () => {
  const staffId = await getTestStaffId();
  const check = await createTestCheck("needs_review");
  try {
    const { data, error } = await supabase.rpc("submit_check_review_decision", {
      p_check_id: check.id,
      p_reviewer_id: staffId,
      p_deposit_path: "reissue_requested",
      p_reissue_reason: "Wrong payee structure",
      p_reissue_reason_category: "payee_error",
    });
    assertEquals(error, null);
    assertEquals(data.success, true);

    const { data: reissues } = await supabase
      .from("check_reissue_requests")
      .select("*")
      .eq("check_id", check.id);
    assertEquals(reissues!.length, 1);
    assertEquals(reissues![0].reason_category, "payee_error");

    const { data: updated } = await supabase
      .from("check_intake_items")
      .select("status")
      .eq("id", check.id)
      .single();
    assertEquals(updated!.status, "reissue_requested");
  } finally {
    await cleanup(check.id);
  }
});

Deno.test("merge_only mode does not change status or create decision", async () => {
  const staffId = await getTestStaffId();
  const check = await createTestCheck("endorsements_complete");
  const payeeA = await createTestPayee(check.id, "John Doe", "signed");
  const payeeB = await createTestPayee(check.id, "John D.", "pending");
  try {
    const { data, error } = await supabase.rpc("submit_check_review_decision", {
      p_check_id: check.id,
      p_reviewer_id: staffId,
      p_deposit_path: "merge_only",
      p_merge_payees: [
        { source_payee_id: payeeB.id, target_payee_id: payeeA.id, merged_name: "John Doe" },
      ],
    });
    assertEquals(error, null);
    assertEquals(data.success, true);
    assertEquals(data.merge_only, true);

    // Status should not change
    const { data: updated } = await supabase
      .from("check_intake_items")
      .select("status")
      .eq("id", check.id)
      .single();
    assertEquals(updated!.status, "endorsements_complete");

    // Decision should NOT be created
    const { data: decisions } = await supabase
      .from("check_review_decisions")
      .select("*")
      .eq("check_id", check.id);
    assertEquals(decisions!.length, 0);

    // Source payee (pending) should be deleted, target preserved
    const { data: remainingPayees } = await supabase
      .from("check_payees")
      .select("*")
      .eq("check_id", check.id);
    assertEquals(remainingPayees!.length, 1);
    assertEquals(remainingPayees![0].id, payeeA.id);

    // Audit log should have merge event
    const { data: audit } = await supabase
      .from("check_audit_log")
      .select("event_type")
      .eq("check_id", check.id)
      .eq("event_type", "payee_merged");
    assertEquals(audit!.length, 1);
  } finally {
    await cleanup(check.id);
  }
});

Deno.test("merge preserves payees with active endorsement activity", async () => {
  const staffId = await getTestStaffId();
  const check = await createTestCheck("endorsements_complete");
  const payeeA = await createTestPayee(check.id, "Alice", "signed");
  const payeeB = await createTestPayee(check.id, "Bob", "signed");
  try {
    const { data, error } = await supabase.rpc("submit_check_review_decision", {
      p_check_id: check.id,
      p_reviewer_id: staffId,
      p_deposit_path: "merge_only",
      p_merge_payees: [
        { source_payee_id: payeeB.id, target_payee_id: payeeA.id, merged_name: "Alice & Bob" },
      ],
    });
    assertEquals(error, null);

    // Both payees should still exist (source has signed status, not pending)
    const { data: remaining } = await supabase
      .from("check_payees")
      .select("*")
      .eq("check_id", check.id);
    assertEquals(remaining!.length, 2, "Signed payee should not be deleted by merge");
  } finally {
    await cleanup(check.id);
  }
});

Deno.test("field edits create individual audit rows", async () => {
  const staffId = await getTestStaffId();
  const check = await createTestCheck("needs_review");
  try {
    const { error } = await supabase.rpc("submit_check_review_decision", {
      p_check_id: check.id,
      p_reviewer_id: staffId,
      p_deposit_path: "approved_for_deposit",
      p_confirmed_carrier_name: "Corrected Carrier",
      p_confirmed_amount: 2000.00,
      p_field_changes: [
        { field: "carrier_name", old_value: "Test Carrier", new_value: "Corrected Carrier" },
        { field: "amount", old_value: "1500.00", new_value: "2000.00" },
      ],
    });
    assertEquals(error, null);

    const { data: fieldAudit } = await supabase
      .from("check_audit_log")
      .select("*")
      .eq("check_id", check.id)
      .eq("event_type", "manual_field_edit");
    assertEquals(fieldAudit!.length, 2);

    // Verify the check was actually updated
    const { data: updated } = await supabase
      .from("check_intake_items")
      .select("carrier_name, amount")
      .eq("id", check.id)
      .single();
    assertEquals(updated!.carrier_name, "Corrected Carrier");
    assertEquals(updated!.amount, 2000.00);
  } finally {
    await cleanup(check.id);
  }
});

Deno.test("dashboard counts RPC returns expected shape", async () => {
  const { data, error } = await supabase.rpc("get_check_dashboard_counts");
  // Service role bypasses has_role check so this should work
  assertEquals(error, null);
  assertEquals(typeof data.manual_review, "number");
  assertEquals(typeof data.branch_deposit, "number");
  assertEquals(typeof data.reissue_requested, "number");
  assertEquals(typeof data.approved_for_deposit, "number");
  assertEquals(typeof data.total_deposited, "number");
  assertEquals(typeof data.total_checks, "number");
});
