/**
 * Vendor Ops: a finance-only view of a ChecksOps organization, served by path at
 * checksops.com/vendor-ops (no separate host, no separate DNS).
 *
 * It is not a separate identity system. A vendor is a member of a ChecksOps
 * organization (a tenant_users row), signed in with the normal ChecksOps
 * session, so the same Cognito/AWS adapter (or Supabase client off AWS), the
 * same API authorization and the same tenant-scoped wallet and ledger
 * components apply. Nothing here adds a role, a table or a policy.
 *
 * Access is limited to the organizations in VENDOR_OPS_ENABLED_TENANT_IDS (owner,
 * 2026-11-02: regular tenants use their ChecksOps login; Freedom Adjustment keeps
 * the portal while the owner tests it). This is a UX gate only: the same member
 * already reaches the same wallet and ledger through /{slug}, and the API and RLS
 * enforce tenant membership either way.
 */
import {
  classifyLoginMemberships,
  type LoginMembershipResult,
  type LoginMembershipRow,
} from "./loginMembership.ts";

/** Freedom Adjustment (same id as FREEDOM_TENANT_ID in aws/functions/api/authorization.mjs). */
export const FREEDOM_ADJUSTMENT_TENANT_ID = "2eff5f1a-929d-4ce3-9a8b-cd96b98df42a";

/** Organizations whose members may open the Vendor Portal. */
export const VENDOR_OPS_ENABLED_TENANT_IDS: readonly string[] = [FREEDOM_ADJUSTMENT_TENANT_ID];

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

export type VendorWorkspaceResult = LoginMembershipResult | { kind: "not_enabled" };

export const VENDOR_OPS_NOT_ENABLED_MESSAGE = {
  title: "Vendor Portal not available",
  description: "The Vendor Portal isn't enabled for your organization. Sign in to ChecksOps at /login instead.",
} as const;

/**
 * Which organization the Vendor Portal opens: the member's active organization among
 * the enabled ones. A member of only other organizations gets "not_enabled"; a member
 * of no organization gets "none", as on the ChecksOps login.
 */
export function resolveVendorWorkspace(
  rows: LoginMembershipRow[] | null | undefined,
  enabledTenantIds: readonly string[] = VENDOR_OPS_ENABLED_TENANT_IDS,
): VendorWorkspaceResult {
  const list = (rows ?? []).filter((m) => m && (m.tenant_id || m.tenants));
  if (list.length === 0) return { kind: "none" };
  const enabled = list.filter((m) => !!m.tenant_id && enabledTenantIds.includes(String(m.tenant_id)));
  if (enabled.length === 0) return { kind: "not_enabled" };
  return classifyLoginMemberships(enabled);
}
