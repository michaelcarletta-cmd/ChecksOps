/**
 * Tenant role gates for the SPA (UX only; the API and RLS enforce the same
 * rules). Only the signed-in user's own tenant_users role for the current
 * tenant counts: platform admin/staff roles give no shortcut into a tenant.
 *
 * Owner policy: owner, admin, manager and operator act; viewers and partners
 * do not. Team management (members, 2FA resets, tenant settings, sender
 * settings, tax) is owner and admin only.
 */
export const TENANT_ACTING_ROLES: readonly string[] = Object.freeze([
  "owner",
  "admin",
  "manager",
  "operator",
]);

export const TENANT_TEAM_MANAGER_ROLES: readonly string[] = Object.freeze(["owner", "admin"]);

const normalize = (role: string | null | undefined) => String(role || "").toLowerCase();

/** Check work: move, delete, deposit, payments, stakeholder limit requests. */
export function canActInTenant(role: string | null | undefined): boolean {
  return TENANT_ACTING_ROLES.includes(normalize(role));
}

/** Team management and tenant settings. */
export function canManageTenantTeam(role: string | null | undefined): boolean {
  return TENANT_TEAM_MANAGER_ROLES.includes(normalize(role));
}
