import { withIdentityWrite } from '../../data.mjs';
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import {
  CHECKALT_DUAL_CONTROL_ACTION,
  CHECKALT_SECOND_APPROVE_ACTION,
  CHECKALT_TOTP_ACTION,
  loadCheckAltTenantRoles,
  loadLoginSessionStepUp,
  roleAllowsCheckAlt,
  serverAmountCentsFromCheck,
} from './checkalt-authz.mjs';
import { loginSessionBinding } from './moov-fund-authz.mjs';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  liveProviderCalled: false,
  productionExecution: false,
  ...extra,
});

export async function handleCheckAltDualControl(event, deps = {}) {
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
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
    // Same rule as submit/approve: only the caller's tenant_users role for the
    // check's tenant counts. Platform user_roles admin/staff are ignored.
    const roles = await loadCheckAltTenantRoles(client, mapping.application_user_id, check.tenant_id);
    if (!roleAllowsCheckAlt(roles)) {
      return fail('financial_unauthorized', 403, {
        message: 'Viewers cannot record a Check Alt second approval. Tenant owner/admin/manager/operator required.',
        spoofFieldsIgnored: spoof,
      });
    }
    const amountCents = serverAmountCentsFromCheck(check);
    if (!Number.isInteger(amountCents)) {
      return fail('invalid_amount', 400, {
        message: 'Server-derived check amount is required. Browser amount is ignored.',
        spoofFieldsIgnored: spoof,
      });
    }
    // The recorder enters their own two-factor code, once per login: a
    // deposit.second_approve step-up for this user, this tenant and this
    // login. Another user's proof (the submitter's included) never matches.
    const loginSession = loginSessionBinding(claims);
    if (!loginSession) {
      return fail('login_session_unbound', 401, {
        message: 'Sign out and sign back in, then try again.',
        spoofFieldsIgnored: spoof,
      });
    }
    const stepUp = await loadLoginSessionStepUp(client, {
      userId: mapping.application_user_id,
      tenantId: check.tenant_id,
      actionKey: CHECKALT_SECOND_APPROVE_ACTION,
      loginSession,
    });
    if (!stepUp) {
      return fail('step_up_required', 403, {
        message: 'Enter a current two-factor code to record a second approval.',
        action_key: CHECKALT_SECOND_APPROVE_ACTION,
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
          amount_cents: amountCents,
          amount_dollars: check.amount,
          operation: CHECKALT_TOTP_ACTION,
          approver_role: membership.role,
          recorder_stepup_id: stepUp.id,
          recorder_factor: 'totp',
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
      amount_cents: amountCents,
      action_key: CHECKALT_DUAL_CONTROL_ACTION,
      message: 'Dual-control approval recorded. This does not submit a CheckAlt deposit.',
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }, deps);
}
