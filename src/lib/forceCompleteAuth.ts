/** Tenant-scoped authorization for force-complete.
 *  Owner policy: every member of the tenant is a user with the same rights;
 *  partners and other tenants do not act. The caller needs a membership of
 *  THAT check's tenant (any role value; aws_can_write_tenant after SQL 90).
 *  Global user_roles admin/staff and platform owners get no shortcut, and UUID
 *  possession is not authorization.
 */

export type ForceCompleteAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 404; error: string };

export function authorizeForceComplete(opts: {
  userId?: string | null;
  check?: { id?: string | null; tenant_id?: string | null } | null;
  userRoles?: string[] | null;
  tenantMemberships?: Array<{ tenant_id?: string | null; role?: string | null }> | null;
}): ForceCompleteAuthResult {
  if (!opts.userId) return { ok: false, status: 401, error: "Unauthorized" };
  if (!opts.check?.id) return { ok: false, status: 404, error: "Check not found" };
  if (!opts.check.tenant_id) return { ok: false, status: 403, error: "forbidden" };

  const member = (opts.tenantMemberships || []).some(
    (row) => String(row.tenant_id || "") === String(opts.check?.tenant_id),
  );
  if (!member) return { ok: false, status: 403, error: "forbidden" };
  return { ok: true };
}

export function planForceCompleteRowUpdate(row: {
  id: string;
  status?: string | null;
  signed_at?: string | null;
  notes?: string | null;
  signature_method?: string | null;
  signature_image_url?: string | null;
  endorsement_image_path?: string | null;
  signed_by?: string | null;
}, nowIso: string) {
  return {
    id: row.id,
    status: "signed",
    signed_at: row.signed_at || nowIso,
    notes: row.notes || "Manually marked as received by staff override",
    signature_method: row.signature_method || "manual",
    unchanged: {
      signature_image_url: row.signature_image_url ?? null,
      endorsement_image_path: row.endorsement_image_path ?? null,
      signed_by: row.signed_by ?? null,
    },
  };
}
