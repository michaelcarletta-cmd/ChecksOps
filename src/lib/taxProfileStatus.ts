/**
 * Tax/1099 recipient-profile list status for the Payments Tax tab.
 *
 * A failed `tenant-tax-profiles` list must not be rendered as an empty
 * success list. Defaulting `data` to `[]` would otherwise show
 * "No TIN on file" and allow an edit dialog to save blank address fields
 * over stored profiles.
 */

export const TAX_PROFILES_UNAVAILABLE_HEADING =
  "Tax/1099 recipient profiles unavailable";

export const TAX_PROFILES_UNAVAILABLE_MESSAGE =
  "Do not assume no TIN is on file. Recipient tax details could not be loaded. Editing is disabled until the list succeeds.";

export const TAX_PROFILE_STATUS_UNAVAILABLE = "Status unavailable";
export const TAX_PROFILE_STATUS_LOADING = "Checking TIN status";
export const TAX_PROFILE_STATUS_MISSING = "No TIN on file";
export const TAX_PROFILE_STATUS_ON_FILE = "On file";

export type TaxProfileTinFields = {
  tin_on_file?: boolean | null;
  tin_last_4?: string | null;
};

export function taxProfileEditorEnabled(state: {
  tenantId?: string | null;
  isError?: boolean;
  isLoading?: boolean;
}): boolean {
  if (!state.tenantId) return false;
  if (state.isError) return false;
  if (state.isLoading) return false;
  return true;
}

export function taxProfileTinStatusLabel(
  profile: TaxProfileTinFields | undefined,
  state: { isError?: boolean; isLoading?: boolean } = {},
): string {
  if (state.isError) return TAX_PROFILE_STATUS_UNAVAILABLE;
  if (state.isLoading) return TAX_PROFILE_STATUS_LOADING;
  if (profile?.tin_on_file && profile.tin_last_4) {
    return `${TAX_PROFILE_STATUS_ON_FILE} ••••${profile.tin_last_4}`;
  }
  if (profile?.tin_on_file) return TAX_PROFILE_STATUS_ON_FILE;
  return TAX_PROFILE_STATUS_MISSING;
}

export function sanitizeBrowserTaxError(value: unknown): string {
  const text = String(value ?? "")
    .replace(/\d{3}-?\d{2}-?\d{4}|\d{2}-?\d{7}|\d{9}/g, "[redacted]")
    .replace(/\b(?:tin|ein|ssn)\b\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return text || "request_failed";
}
