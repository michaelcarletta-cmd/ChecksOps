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

export const LOGIN_MFA_LOOKUP_MESSAGE = {
  title: "Two-factor sign-in needed",
  description:
    "Finish signing in with the code from your authenticator app. If you weren't asked for a code, update the ChecksOps app or reload the page, then sign in again.",
} as const;

export const LOGIN_SESSION_LOOKUP_MESSAGE = {
  title: "Sign in again",
  description: "ChecksOps couldn't confirm this sign-in. Sign in again.",
} as const;

/** The query error (or thrown error) of the membership lookup; its code is the API's error. */
export type LoginLookupError = { code?: string | null; message?: string | null } | null | undefined;

/**
 * Why the membership lookup failed, or null when it did not. A refused or failed lookup returns no
 * rows, so without this it read as "not a member of any organization": with login MFA on, the API
 * refuses every data request (login_mfa_required) until the authenticator code is entered.
 */
export function membershipLookupFailureMessage(error: LoginLookupError): { title: string; description: string } | null {
  if (!error) return null;
  const code = String(error.code ?? "");
  if (code === "login_mfa_required") return LOGIN_MFA_LOOKUP_MESSAGE;
  if (code === "login_session_unbound") return LOGIN_SESSION_LOOKUP_MESSAGE;
  const detail = String(error.message ?? "").trim();
  return {
    title: "Couldn't check your access",
    description: `ChecksOps couldn't load your organization${detail ? ` (${detail})` : ""}. Check your connection and sign in again.`,
  };
}
