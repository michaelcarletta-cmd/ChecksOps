import { supabase } from "@/integrations/supabase/client";

/**
 * Manually fixes the Kalyan check (b66e9a78-87ce-4911-8358-2a68243ff954)
 * by removing duplicate pending endorsements and advancing it to Ready for Deposit.
 */
export async function fixKalyanCheck() {
  const checkId = "b66e9a78-87ce-4911-8358-2a68243ff954";
  const reviewerId = (await supabase.auth.getUser()).data.user?.id;

  if (!reviewerId) {
    console.error("No user found for fix");
    return;
  }

  console.log("Starting Kalyan check fix...");

  // 1. Delete the duplicate pending endorsements discovered in DB
  const { error: delError } = await supabase
    .from("check_endorsements")
    .delete()
    .in("id", [
      "c214d48e-f013-4571-9fdc-35ecdedf4831", // Freedom Adjustment (pending)
      "693c6b11-ad15-47d0-a0d6-445217139a50", // Kalyan Ramanathan (pending)
      "e075e7a4-8e04-4df9-8613-e52133a8fcf1"  // Vandana Kalyan (pending)
    ]);

  if (delError) {
    console.error("Error deleting duplicates:", delError);
  } else {
    console.log("Deleted 3 duplicate pending endorsements.");
  }

  // 2. Advance the check to approved_for_deposit since 3/3 signatures are actually signed
  const { error: rpcError } = await supabase.rpc("submit_check_review_decision_safe", {
    p_check_id: checkId,
    p_reviewer_id: reviewerId,
    p_deposit_path: "approved_for_deposit",
    p_reviewer_notes: "System fix: Removed duplicate pending endorsements and advanced to Ready for Deposit (all 3 signatures signed)."
  });

  if (rpcError) {
    console.error("Error advancing check:", rpcError);
  } else {
    console.log("Check advanced to Ready for Deposit.");
  }
}
