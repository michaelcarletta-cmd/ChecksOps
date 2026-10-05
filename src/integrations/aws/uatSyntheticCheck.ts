/**
 * Staging-only synthetic UAT create payload.
 *
 * Uses the existing POST /workflow/checks amount INSERT path.
 * Does not open post-create writes to amount, routing_number, or account_number.
 * Production uploads never call this helper (CheckUploadForm AWS branch only).
 * Ordinary staging uploads must pass syntheticUat=false so amount stays omitted.
 */

export const STAGING_UAT_SYNTHETIC_AMOUNT = 1.0;

export const STAGING_UAT_CREATE_REVIEW_NOTE =
  "TEST / UAT VOID NOT NEGOTIABLE — create-time amount 1.00; routing/account omitted";

const ORDINARY_STAGING_REVIEW_NOTE = "AWS staging intake";
const ORDINARY_STAGING_MANUAL_REVIEW_NOTE =
  "AWS staging intake — manual entry (OCR skipped)";

export function buildAwsStagingCheckCreateValues(input: {
  isAwsStaging: boolean;
  syntheticUat: boolean;
  skipAi?: boolean;
}): Record<string, unknown> {
  if (!input.isAwsStaging) {
    return {};
  }

  if (input.syntheticUat === true) {
    return {
      amount: STAGING_UAT_SYNTHETIC_AMOUNT,
      review_notes: STAGING_UAT_CREATE_REVIEW_NOTE,
    };
  }

  return {
    review_notes: input.skipAi
      ? ORDINARY_STAGING_MANUAL_REVIEW_NOTE
      : ORDINARY_STAGING_REVIEW_NOTE,
  };
}
