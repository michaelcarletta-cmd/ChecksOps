import { isEndorsementSatisfied } from "./endorsementCompletion.ts";
import { authorizeForceComplete, planForceCompleteRowUpdate } from "./forceCompleteAuth.ts";

export type ForceCompleteDeps = {
  getUser: () => Promise<{ id: string } | null>;
  loadCheck: (checkId: string) => Promise<{ id: string; tenant_id?: string | null } | null>;
  loadUserRoles: (userId: string) => Promise<string[]>;
  loadTenantMemberships: (userId: string) => Promise<Array<{ tenant_id?: string | null; role?: string | null }>>;
  loadEndorsements: (checkId: string) => Promise<Array<Record<string, any>>>;
  updateEndorsement: (id: string, values: Record<string, unknown>) => Promise<void>;
  audit?: (row: Record<string, unknown>) => Promise<void>;
  reEvaluate?: (checkId: string) => Promise<Record<string, unknown>>;
  now?: () => string;
};

export async function runForceCompleteEndorsements(
  deps: ForceCompleteDeps,
  checkId?: string | null,
) {
  const user = await deps.getUser();
  if (!user?.id) return { ok: false, status: 401, error: "Unauthorized" };
  if (!checkId) return { ok: false, status: 400, error: "checkId required" };

  const check = await deps.loadCheck(checkId);
  const roles = await deps.loadUserRoles(user.id);
  const memberships = await deps.loadTenantMemberships(user.id);
  const auth = authorizeForceComplete({
    userId: user.id,
    check,
    userRoles: roles,
    tenantMemberships: memberships,
  });
  if (!auth.ok) return auth;

  const rows = await deps.loadEndorsements(checkId);
  const nowIso = (deps.now || (() => new Date().toISOString()))();
  const incomplete = rows.filter((row) => !isEndorsementSatisfied(row));
  const updates = [];
  for (const row of incomplete) {
    const planned = planForceCompleteRowUpdate(row as any, nowIso);
    await deps.updateEndorsement(planned.id, {
      status: planned.status,
      signed_at: planned.signed_at,
      notes: planned.notes,
      signature_method: planned.signature_method,
      updated_at: nowIso,
    });
    updates.push(planned);
  }

  await deps.audit?.({
    check_id: checkId,
    event_type: "endorsements_force_completed",
    actor_id: user.id,
    overridden_ids: incomplete.map((row) => row.id),
  });
  const completion = await deps.reEvaluate?.(checkId);
  return { ok: true, status: 200, updates, completion };
}
