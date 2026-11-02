/**
 * Vendor Ops: a finance-only view of a ChecksOps organization, served by path at
 * checksops.com/vendor-ops (no separate host, no separate DNS).
 *
 * It is not a separate identity system. A vendor is a member of a ChecksOps
 * organization (a tenant_users row), signed in with the normal ChecksOps
 * session, so the same Cognito/AWS adapter (or Supabase client off AWS), the
 * same API authorization and the same tenant-scoped wallet and ledger
 * components apply. Nothing here adds a role, a table or a policy.
 */
import {
  classifyLoginMemberships,
  type LoginMembershipResult,
  type LoginMembershipRow,
} from "./loginMembership.ts";

export const VENDOR_OPS_BASE_PATH = "/vendor-ops";
export const VENDOR_OPS_LOGIN_PATH = `${VENDOR_OPS_BASE_PATH}/login`;
export const VENDOR_OPS_HOME_PATH = `${VENDOR_OPS_BASE_PATH}/wallet`;
export const VENDOR_OPS_TITLE = "ChecksOps Vendor Portal";

export const VENDOR_OPS_NAV = [
  { to: `${VENDOR_OPS_BASE_PATH}/wallet`, label: "Wallet" },
  { to: `${VENDOR_OPS_BASE_PATH}/payments`, label: "Payments & Financials" },
  { to: `${VENDOR_OPS_BASE_PATH}/settings`, label: "Settings" },
] as const;

/** The membership select the ChecksOps login uses (no `!inner`; see loginMembership.ts). */
export const VENDOR_OPS_MEMBERSHIP_SELECT = "tenant_id, tenants(slug, subscription_status)";

export function isVendorOpsPath(pathname: string | null | undefined): boolean {
  const p = String(pathname || "");
  return p === VENDOR_OPS_BASE_PATH || p.startsWith(`${VENDOR_OPS_BASE_PATH}/`);
}

/** Which organization the Vendor Portal opens: the member's active organization. */
export function resolveVendorWorkspace(rows: LoginMembershipRow[] | null | undefined): LoginMembershipResult {
  return classifyLoginMemberships(rows);
}
