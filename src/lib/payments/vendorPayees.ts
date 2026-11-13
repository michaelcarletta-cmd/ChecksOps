/**
 * Vendor payments (owner, 2026-11-13: "Start the vendor payments API and screens"): the website
 * side. A tenant adds a vendor by the vendor's Partner Code, then pays that vendor's ChecksOps
 * wallet from a check (Funds tab) or from the Payroll payment dialog. Nothing else.
 *
 * Owner decisions (2026-11-13): those two places only ("Do not add another location"); the normal
 * send fee; wallet only (no bank fallback: the API refuses with vendor_setup_required); the Vendor
 * Portal stays as it is; any member may add, remove and pay vendor payees; the same wallet.fund
 * two-factor as other sends; no email. Adding a vendor creates no partnership and shares nothing.
 *
 * Pure helpers only (no React, no network), so aws/tests can import this file directly. The server
 * is the authority for every rule here.
 */

/** /data/rpc names (the workflow-rpc bridge). */
export const VENDOR_PAYEE_ADD_RPC = "vendor_payee_add";
export const VENDOR_PAYEE_REMOVE_RPC = "vendor_payee_remove";
export const VENDOR_PAYEES_LIST_RPC = "vendor_payees_list";

/** tenant-billing-admin actions (platform owner only). */
export const TENANT_VENDOR_SET_ACTION = "vendor-set";
export const TENANT_VENDOR_STATUS_ACTION = "vendor-status";

/** The recipient kind moov-disburse takes for a vendor. */
export const VENDOR_RECIPIENT_KIND = "vendor";
/** The same two-factor step-up as every other send. */
export const VENDOR_SEND_TOTP_ACTION = "wallet.fund";

/** Vendor Partner Codes: 3 to 40 of A-Z, 0-9, "_" and "-" (partner codes for sharing are 8). */
export const VENDOR_CODE_MIN = 3;
export const VENDOR_CODE_MAX = 40;
export const VENDOR_CODE_PATTERN = /^[A-Z0-9_-]{3,40}$/;

/** Shown wherever a vendor is added: what adding one does and does not do. */
export const VENDOR_NO_PARTNERSHIP_NOTE =
  "Adding a vendor creates no partnership and shares nothing with them. It only lets you pay the vendor's ChecksOps wallet.";
export const VENDOR_WALLET_ONLY_NOTE = "Vendors are paid to their ChecksOps wallet only.";
export const VENDOR_INACTIVE_LABEL = "No longer a vendor";

/** Upper-case and keep only the characters a vendor code can hold (spaces and pasted formatting go). */
export function normalizeVendorCode(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, VENDOR_CODE_MAX);
}

export function isValidVendorCode(code: string | null | undefined): boolean {
  return VENDOR_CODE_PATTERN.test(String(code ?? ""));
}

/** Plain messages for the refusals of vendor_payee_add and vendor_payee_remove. */
export const VENDOR_PAYEE_ERROR_MESSAGES: Record<string, string> = {
  forbidden: "You are not a member of this organization.",
  invalid_code: `Vendor codes are ${VENDOR_CODE_MIN} to ${VENDOR_CODE_MAX} characters: letters, numbers, "-" and "_".`,
  vendor_not_found: "No vendor uses that Partner Code. Check the code with the vendor.",
  own_code: "That is your own organization's code.",
  vendor_inactive: "That organization is no longer a vendor on ChecksOps.",
  invalid_vendor: "That vendor could not be found.",
  not_found: "That vendor is not on your list.",
};

/** Plain messages for the vendor refusals of moov-disburse (the server's own message wins). */
export const VENDOR_SEND_ERROR_MESSAGES: Record<string, string> = {
  vendor_not_payee: "This vendor is not on your Vendors list. Add it in Settings → Bank Account/Stakeholders → Vendors.",
  vendor_setup_required: "This vendor has not set up its ChecksOps wallet yet, so it cannot be paid. Ask the vendor to finish its wallet setup.",
  vendor_wallet_choice_required: "This vendor has to choose which ChecksOps wallet receives payments before it can be paid. Ask the vendor to choose one.",
  recipient_is_sender: "You cannot pay your own organization.",
  totp_required: "Two-factor confirmation is required to send this payment.",
};

const plainMessage = (
  messages: Record<string, string>,
  code: string | null | undefined,
  serverMessage: string | null | undefined,
  fallback: string,
): string => {
  const message = typeof serverMessage === "string" ? serverMessage.trim() : "";
  const key = String(code ?? "");
  if (message && message !== key) return message;
  return (Object.prototype.hasOwnProperty.call(messages, key) ? messages[key] : null) ?? (key || fallback);
};

/** A send refusal: the server's message when it gave one; else the plain vendor message; else the code. */
export const sendErrorMessage = (code: string | null | undefined, serverMessage: string | null | undefined, fallback: string): string =>
  plainMessage(VENDOR_SEND_ERROR_MESSAGES, code, serverMessage, fallback);

/** A vendor_payee_add / vendor_payee_remove refusal, the same way. */
export const vendorPayeeErrorMessage = (code: string | null | undefined, serverMessage: string | null | undefined, fallback: string): string =>
  plainMessage(VENDOR_PAYEE_ERROR_MESSAGES, code, serverMessage, fallback);

/** One row of vendor_payees_list. */
export interface VendorPayee {
  link_id: string;
  vendor_tenant_id: string;
  vendor_name: string | null;
  partner_code_used: string | null;
  created_at: string | null;
  vendor_active: boolean;
}

/** vendor_payees_list may answer a bare list or an object holding one; anything else is no rows. */
export function vendorPayeeRows(data: unknown): VendorPayee[] {
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { payees?: unknown } | null)?.payees)
      ? (data as { payees: unknown[] }).payees
      : Array.isArray((data as { rows?: unknown } | null)?.rows)
        ? (data as { rows: unknown[] }).rows
        : [];
  const rows: VendorPayee[] = [];
  for (const raw of list) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const vendorTenantId = typeof row.vendor_tenant_id === "string" ? row.vendor_tenant_id : "";
    if (!vendorTenantId) continue;
    rows.push({
      link_id: String(row.link_id ?? vendorTenantId),
      vendor_tenant_id: vendorTenantId,
      vendor_name: typeof row.vendor_name === "string" && row.vendor_name ? row.vendor_name : null,
      partner_code_used: typeof row.partner_code_used === "string" ? row.partner_code_used : null,
      created_at: typeof row.created_at === "string" ? row.created_at : null,
      // SQL 165 may name it is_vendor (still marked a vendor); either false means "no longer a vendor".
      vendor_active: row.vendor_active !== false && row.is_vendor !== false,
    });
  }
  return rows;
}

/** Only vendors that are still vendors can be chosen as a recipient. */
export const payableVendorPayees = (rows: VendorPayee[]): VendorPayee[] => rows.filter((r) => r.vendor_active);

export const vendorPayeeName = (row: Pick<VendorPayee, "vendor_name">): string => row.vendor_name || "Vendor";

/** The key a vendor recipient has in a list of recipients (allocations, select values). */
export const vendorRecipientKey = (vendorTenantId: string): string => `vendor:${vendorTenantId}`;
export const vendorTenantIdFromKey = (key: string | null | undefined): string | null =>
  typeof key === "string" && key.startsWith("vendor:") ? key.slice("vendor:".length) || null : null;
