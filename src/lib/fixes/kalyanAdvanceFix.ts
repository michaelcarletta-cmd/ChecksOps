import { supabase } from "@/integrations/supabase/client";

async function runFix() {
  const checkId = "b66e9a78-87ce-4911-8358-2a68243ff954";
  const reviewerId = "7dbb3009-f059-4767-b5dc-1c5c72379330";

  console.log(`Running check advance for ${checkId}`);
  
  const { data, error } = await supabase.rpc("submit_check_review_decision_safe", {
    p_check_id: checkId,
    p_reviewer_id: reviewerId,
    p_deposit_path: "approved_for_deposit",
    p_reviewer_notes: "Auto-advancing Kalyan check (manual trigger)",
    p_confirmed_carrier_name: null,
    p_confirmed_check_number: null,
    p_confirmed_amount: null,
    p_confirmed_payee_line: null,
    p_field_changes: [],
    p_reissue_reason: null,
    p_reissue_reason_category: null,
    p_merge_payees: []
  });

  if (error) console.error(error);
  else console.log("Success:", data);
}

runFix();
