import { supabase } from "../integrations/supabase/client";

/**
 * Fix for Kalyan check b66e9a78-87ce-4911-8358-2a68243ff954
 * The check has all 3 signatures but is stuck in 'endorsing' stage.
 * This script manually triggers the review decision to advance it to 'ready_for_deposit'.
 */
async function fixKalyanCheck() {
  const checkId = "b66e9a78-87ce-4911-8358-2a68243ff954";
  const reviewerId = "7dbb3009-f059-4767-b5dc-1c5c72379330"; // Michael Carletta (admin)

  console.log(`Advancing Kalyan check ${checkId} to ready_for_deposit...`);

  // Call the safe RPC to update status, stage, and sync claim_checks
  const { data, error } = await supabase.rpc("submit_check_review_decision_safe", {
    p_check_id: checkId,
    p_reviewer_id: reviewerId,
    p_deposit_path: "approved_for_deposit", // This sets status='approved_for_deposit' and check_stage='ready_for_deposit'
    p_reviewer_notes: "System correction: advancing check after all signatures collected (manual fix for stalled auto-transition)",
    p_confirmed_carrier_name: null,
    p_confirmed_check_number: null,
    p_confirmed_amount: null,
    p_confirmed_payee_line: null,
    p_field_changes: [],
    p_reissue_reason: null,
    p_reissue_reason_category: null,
    p_merge_payees: []
  });

  if (error) {
    console.error("Failed to advance check:", error);
  } else {
    console.log("Check advanced successfully:", data);
  }
}

fixKalyanCheck();
