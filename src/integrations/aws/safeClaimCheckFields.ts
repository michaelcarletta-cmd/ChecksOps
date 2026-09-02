/** Descriptive claim_checks columns allowed on the AWS Tranche 3 write path.
 *  Keep in sync with aws/functions/api/write-allowlist.mjs.
 */
export const AWS_SAFE_CLAIM_CHECK_COLUMNS = new Set([
  "carrier_name",
  "check_number",
  "payee_line",
  "notes",
  "check_date",
  "received_date",
  "ocr_needs_verification",
  "updated_at",
]);

export function pickAwsSafeClaimCheckUpdates(
  updates: Record<string, unknown>,
): { safe: Record<string, unknown>; skipped: string[] } {
  const safe: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (AWS_SAFE_CLAIM_CHECK_COLUMNS.has(key)) safe[key] = value;
    else skipped.push(key);
  }
  return { safe, skipped };
}
