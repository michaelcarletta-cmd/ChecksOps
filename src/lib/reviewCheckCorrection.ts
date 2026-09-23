import { supabase } from "@/integrations/supabase/client";

/** Single client entry for dedicated AWS Review intake/OCR correction. */
export const APPLY_CHECK_REVIEW_CORRECTION_RPC = "apply_check_review_correction";

export type ReviewCorrectionFields = {
  carrier_name?: string | null;
  check_number?: string | null;
  amount?: number | null;
  payee_line?: string | null;
  issue_date?: string | null;
  property_address?: string | null;
  funds_type?: string | null;
  detected_claim_number?: string | null;
  is_multi_payee?: boolean | null;
  expiration_days?: number | null;
  review_notes?: string | null;
  payee_address?: string | null;
};

export async function applyCheckReviewCorrection(args: {
  checkId: string;
  fields: ReviewCorrectionFields;
}) {
  const { data, error } = await supabase.rpc(APPLY_CHECK_REVIEW_CORRECTION_RPC as never, {
    p_check_id: args.checkId,
    p_fields: args.fields,
  } as never);
  if (error) throw error;
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string; message?: string }).message
      || (data as { error?: string }).error
      || "Review correction rejected");
  }
  return data;
}
