/**
 * Classifies a user's tenant_users rows after sign-in.
 *
 * The membership query embeds `tenants(slug, subscription_status)` WITHOUT
 * `!inner`: on AWS the embed reads `tenants_public`, which only lists active
 * tenants, so an inner join would drop the membership row entirely and an
 * invited user of an inactive organization would look like they have no
 * account at all. Keeping the row lets us say "organization inactive".
 */
export type LoginMembershipRow = {
  tenant_id?: string | null;
  tenants?: { slug?: string | null; subscription_status?: string | null } | null;
};

export type LoginMembershipResult =
  | { kind: "active"; slug: string }
  | { kind: "inactive" }
  | { kind: "none" };

export function classifyLoginMemberships(rows: LoginMembershipRow[] | null | undefined): LoginMembershipResult {
  const list = (rows ?? []).filter((m) => m && (m.tenant_id || m.tenants));
  const active = list.find((m) => m.tenants?.subscription_status === "active" && m.tenants?.slug);
  if (active) return { kind: "active", slug: String(active.tenants!.slug) };
  // Membership exists but the tenant is missing from the active-only view or not active.
  if (list.length > 0) return { kind: "inactive" };
  return { kind: "none" };
}

export const INACTIVE_ORG_LOGIN_MESSAGE = {
  title: "Organization not active",
  description: "Your organization isn't active yet. Ask your ChecksOps administrator to activate it, then sign in again.",
} as const;

export const NO_MEMBERSHIP_LOGIN_MESSAGE = {
  title: "No ChecksOps access",
  description: "This account isn't a member of any active organization. Contact your admin.",
} as const;
