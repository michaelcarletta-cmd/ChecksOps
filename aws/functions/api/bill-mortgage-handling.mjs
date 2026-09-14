/**
 * Named bill-mortgage-handling handler. Always fail-closed.
 * Does not write platform_fee_line_items, call Stripe, or enable money movement.
 *
 * Authorization: Mortgage Desk staff (`mortgage_agent`) or platform owner.
 * Tenant `user_roles.admin` is not a mortgage agent and cannot bill.
 * Do not use aws_can_write_tenant here — that is a tenant-writer check and
 * would either admit tenant admins or deny centralized agents.
 */
import { withIdentityWrite } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';
import { financialPermissionsActivated, financialFlagSnapshot } from './financial-flags.mjs';
import { denyProviderExecution, flagSnapshot, providerExecutionEnabled } from './provider-flags.mjs';

const safeQuery = async (client, sql, params = []) => {
  try {
    return await client.query(sql, params);
  } catch {
    return { rows: [], rowCount: 0 };
  }
};

const PLATFORM_OWNER_SQL = `SELECT public.is_master_owner() AS is_master, public.is_platform_owner() AS is_platform`;

export const authorizedForMortgageBilling = (roles = [], owner = {}) => {
  const set = new Set((roles || []).map((role) => String(role || '').toLowerCase()));
  if (set.has('mortgage_agent')) return true;
  return owner?.is_master === true || owner?.is_platform === true;
};

export const denyBillMortgageExecution = (spoof, requestId) => ({
  ...denyProviderExecution('stripe', 'bill-mortgage-handling', {
    error: 'production_execution_blocked',
    message: 'Mortgage handling charges stay disabled. Stripe/Moov execution is not enabled.',
  }),
  request_id: requestId || null,
  liveStripeCalled: false,
  liveMoovCalled: false,
  billed: false,
  platformFeeLineItemsWritten: false,
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: financialPermissionsActivated(),
  AWS_PROVIDER_EXECUTION_ENABLED: providerExecutionEnabled(),
  flags: {
    ...flagSnapshot(),
    ...financialFlagSnapshot(),
  },
  spoofFieldsIgnored: spoof,
});

export const runBillMortgageHandling = async ({ client, mapping, body, spoof }) => {
  const requestId = typeof body.request_id === 'string' ? body.request_id : null;
  if (!requestId) {
    return { ok: false, statusCode: 400, error: 'request_id required', spoofFieldsIgnored: spoof, liveStripeCalled: false, billed: false };
  }
  const roles = (await safeQuery(client, USER_ROLES_SQL, [mapping.application_user_id])).rows
    .map((row) => row.role);
  const owner = (await safeQuery(client, PLATFORM_OWNER_SQL)).rows[0] || {};
  if (!authorizedForMortgageBilling(roles, owner)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'not_authorized',
      liveStripeCalled: false,
      liveMoovCalled: false,
      billed: false,
      platformFeeLineItemsWritten: false,
      spoofFieldsIgnored: spoof,
    };
  }
  const request = (await safeQuery(
    client,
    `SELECT id, tenant_id, billing_status FROM public.mortgage_handling_requests
     WHERE id = $1::uuid LIMIT 1`,
    [requestId],
  )).rows[0];
  if (!request) {
    return {
      ok: false,
      statusCode: 404,
      error: 'request_not_found',
      spoofFieldsIgnored: spoof,
      liveStripeCalled: false,
      liveMoovCalled: false,
      billed: false,
      platformFeeLineItemsWritten: false,
    };
  }
  return denyBillMortgageExecution(spoof, requestId);
};

export const handleBillMortgageHandling = (event, deps = {}) => (
  withIdentityWrite(event, (ctx) => runBillMortgageHandling(ctx), deps)
);
