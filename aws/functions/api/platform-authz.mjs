/**
 * Platform-owner vs tenant-admin authorization.
 * Platform finance requires is_master_owner(). Tenant admins stay tenant-scoped.
 */
export const IS_MASTER_OWNER_SQL = 'SELECT public.is_master_owner() AS is_master_owner';

export async function isMasterOwner(client) {
  const row = (await client.query(IS_MASTER_OWNER_SQL)).rows[0];
  return row?.is_master_owner === true;
}

/** Platform-wide authority. Does not treat tenant user_roles.admin as platform admin. */
export async function isPlatformOwnerSession(client) {
  return isMasterOwner(client);
}

export async function canAccessPlatformFinance(client) {
  return isMasterOwner(client);
}

export async function tenantAdminRole(client, userId, tenantId) {
  if (!tenantId) return null;
  const row = (await client.query(
    `SELECT role FROM public.tenant_users
     WHERE tenant_id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
    [tenantId, userId],
  )).rows[0];
  return row?.role ? String(row.role).toLowerCase() : null;
}

export function isTenantAdminRole(role) {
  return ['owner', 'admin'].includes(String(role || '').toLowerCase());
}
