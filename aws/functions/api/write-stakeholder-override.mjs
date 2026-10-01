/**
 * Narrow admin override for Settings stakeholder / operating bank cards.
 * Sets verification_status = admin_override only. No Moov call, no money movement.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const eqFilter = (filters, column) => {
  const match = (filters || []).find((filter) => filter?.column === column && (filter.op || 'eq') === 'eq');
  return match?.value ?? null;
};

const actorCanOverride = async (client, userId, tenantId) => {
  const rows = (await client.query(
    `SELECT 1
     FROM public.tenant_users
     WHERE user_id = $1::uuid AND tenant_id = $2::uuid AND role IN ('owner', 'admin')
     UNION ALL
     SELECT 1 FROM public.user_roles WHERE user_id = $1::uuid AND role IN ('admin', 'staff')
     LIMIT 1`,
    [userId, tenantId],
  )).rows;
  return rows.length > 0;
};

export async function executeStakeholderAdminOverride({ client, mapping, op, values, filters }) {
  if (op !== 'update') return { error: 'operation_not_allowlisted', table: 'stakeholder_accounts', op };
  const status = String(values?.verification_status ?? '').toLowerCase();
  if (status !== 'admin_override') {
    return {
      error: 'invalid_field',
      field: 'verification_status',
      message: 'This path only records admin_override. Moov verified status is written by moov-sync.',
    };
  }
  const id = eqFilter(filters, 'id');
  if (!UUID_RE.test(String(id || ''))) return { error: 'invalid_uuid', field: 'id' };

  const row = (await client.query(
    `SELECT id, tenant_id, verification_status
     FROM public.stakeholder_accounts
     WHERE id = $1::uuid AND is_active = true`,
    [id],
  )).rows[0];
  if (!row) return { error: 'rls_denied', message: 'Stakeholder account not found or not writable' };
  if (!(await actorCanOverride(client, mapping.application_user_id, row.tenant_id))) {
    return { error: 'not_authorized', message: 'Tenant owner or admin required to override verification' };
  }

  const updated = (await client.query(
    `UPDATE public.stakeholder_accounts
     SET verification_status = 'admin_override',
         verified_at = now()
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     RETURNING id, tenant_id, verification_status, verified_at`,
    [id, row.tenant_id],
  )).rows;
  if (!updated.length) return { error: 'rls_denied', message: 'Stakeholder account not writable' };
  return { rows: updated };
}
