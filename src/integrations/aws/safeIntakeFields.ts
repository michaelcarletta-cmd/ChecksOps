/** Descriptive check-intake columns allowed on the AWS Tranche 2 write path.
 *  Keep in sync with aws/functions/api/write-allowlist.mjs.
 *  Production (non-cognito) builds never import this for gating.
 */
export const AWS_SAFE_INTAKE_COLUMNS = new Set([
  "carrier_name",
  "check_number",
  "issue_date",
  "payee_line",
  "property_address",
  "funds_type",
  "review_notes",
  "payee_address",
  "expiration_days",
  "is_multi_payee",
  "front_image_path",
  "back_image_path",
  "back_image_original_path",
  "back_image_deposit_path",
  "endorsement_override",
  "endorsement_render_status",
  "endorsement_render_meta",
  "mortgage_monitoring_type",
  "mortgage_sent_at",
  "mortgage_tracking_number",
  "mortgage_received_at",
  "updated_at",
]);

export const AWS_PROHIBITED_INTAKE_COLUMNS = new Set([
  "amount",
  "pa_fee_amount",
  "pa_fee_pct",
  "routing_number",
  "account_number",
  "status",
  "check_stage",
  "claim_id",
  "detected_claim_number",
  "deposit_recommendation",
  "deposit_recommendation_reasons",
  "deposited_at",
  "deposited_by_tenant_id",
  "mortgage_monitoring_type",
  "mortgage_received_at",
  "mortgage_final_released_at",
  "endorsement_packet_path",
  "partner_status",
  "partner_status_label",
  "check_source",
  "cash_job_id",
  "cash_job_payment_class",
  "tenant_id",
  "uploaded_by",
  "reviewed_by",
]);

export function pickAwsSafeIntakeUpdates(
  updates: Record<string, unknown>,
): { safe: Record<string, unknown>; skipped: string[] } {
  const safe: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (AWS_SAFE_INTAKE_COLUMNS.has(key)) safe[key] = value;
    else skipped.push(key);
  }
  return { safe, skipped };
}
