import { withIdentityWrite } from '../../data.mjs';
import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { roleAllowsFinancial } from '../../financial-authz.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { loadTenantRole, MOOV_DUAL_CONTROL_ACTION, MOOV_TOTP_ACTION } from './moov-authz.mjs';
import { loadTransferById } from './moov-idempotency.mjs';
import { rejectUntrustedAmountFields, validateProviderCents } from '../amounts.mjs';

const fail = (error, statusCode, extra = {}) => ({
  ok: false,
  statusCode,
  error,
  liveProviderCalled: false,
  productionExecution: false,
  ...extra,
});

export async function handleMoovDualControl(event, deps = {}) {
  return withIdentityWrite(event, async ({ client, mapping, body, spoof }) => {
    const amountSpoof = rejectUntrustedAmountFields(body);
    if (amountSpoof) return { ...amountSpoof, liveProviderCalled: false, productionExecution: false, spoofFieldsIgnored: spoof };
    const transferId = body.payment_transfer_id;
    if (!transferId) return fail('payment_transfer_id is required', 400);
    const transfer = await loadTransferById(client, transferId);
    if (!transfer || transfer.environment !== 'production') return fail('Transfer not found', 404);
    const memberships = (await client.query(TENANT_MEMBERSHIP_SQL, [mapping.application_user_id])).rows;
    const membership = membershipForTenant(memberships, transfer.tenant_id);
    if (!membership) {
      return fail('cross_tenant_denied', 403, {
        message: 'Dual-control approval is tenant-safe. Browser tenant_id is ignored.',
        spoofFieldsIgnored: spoof,
      });
    }
    const roles = await loadTenantRole(client, mapping.application_user_id, transfer.tenant_id);
    if (!roleAllowsFinancial(roles)) {
      return fail('financial_unauthorized', 403, {
        message: 'Dual-control requires tenant owner/admin/manager. Operator cannot approve production Moov.',
        spoofFieldsIgnored: spoof,
      });
    }
    const cents = validateProviderCents(Number(transfer.amount_cents));
    if (cents.error) {
      return fail('invalid_amount', 400, {
        message: 'Server-derived transfer amount is required. Browser amount is ignored.',
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
        transfer.tenant_id,
        MOOV_DUAL_CONTROL_ACTION,
        JSON.stringify({
          payment_transfer_id: transfer.id,
          resource_id: transfer.id,
          amount_cents: cents.cents,
          operation: MOOV_TOTP_ACTION,
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
      payment_transfer_id: transfer.id,
      tenant_id: transfer.tenant_id,
      amount_cents: cents.cents,
      action_key: MOOV_DUAL_CONTROL_ACTION,
      message: 'Dual-control approval recorded. This does not create a Moov transfer.',
      spoofFieldsIgnored: spoof,
      applicationUserId: mapping.application_user_id,
    };
  }, deps);
}
