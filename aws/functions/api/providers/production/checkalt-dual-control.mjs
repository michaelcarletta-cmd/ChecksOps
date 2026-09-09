import { withIdentityWrite } from '../../data.mjs';
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { roleAllowsFinancial } from '../../financial-authz.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { CHECKALT_DUAL_CONTROL_ACTION, loadTenantRole } from './checkalt-authz.mjs';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  liveProviderCalled: false,
  productionExecution: false,
  ...extra,
});

export async function handleCheckAltDualControl(event, deps = {}) {
  return withIdentityWrite(event, async ({ client, mapping, body, spoof }) => {
    const checkId = body.check_intake_item_id || body.check_id;
    if (!checkId) return fail('check_intake_item_id is required', 400);
    const check = (await client.query(
      `SELECT id, tenant_id, amount, status FROM public.check_intake_items WHERE id = $1::uuid`,
      [checkId],
    )).rows[0];
    if (!check) return fail('Check not found', 404);
    const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
    const membership = membershipForTenant(memberships, check.tenant_id);
    if (!membership) {
      return fail('cross_tenant_denied', 403, {
        message: 'Dual-control approval is tenant-safe. Browser tenant_id is ignored.',
        spoofFieldsIgnored: spoof,
      });
    }
    const roles = await loadTenantRole(client, mapping.application_user_id, check.tenant_id);
    if (!roleAllowsFinancial(roles)) {
      return fail('financial_unauthorized', 403, {
        message: 'Dual-control requires tenant owner/admin/manager. Operator cannot approve production CheckAlt.',
        spoofFieldsIgnored: spoof,
      });
    }
    const row = (await client.query(
      `INSERT INTO public.financial_stepup_log
        (user_id, tenant_id, action_key, factor_type, succeeded, metadata)
       VALUES ($1::uuid, $2::uuid, $3, 'dual_control', true, $4::jsonb)
       RETURNING id, user_id, tenant_id, action_key, factor_type, created_at`,
      [
        mapping.application_user_id,
        check.tenant_id,
        CHECKALT_DUAL_CONTROL_ACTION,
        JSON.stringify({
          check_id: check.id,
          amount_dollars: check.amount,
          approver_role: membership.role,
        }),
      ],
    )).rows[0];
    return {
      ok: true,
      statusCode: 200,
      success: true,
      liveProviderCalled: false,
      productionExecution: false,
      approval_id: row.id,
      check_id: check.id,
      tenant_id: check.tenant_id,
      action_key: CHECKALT_DUAL_CONTROL_ACTION,
      message: 'Dual-control approval recorded. This does not submit a CheckAlt deposit.',
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }, deps);
}
