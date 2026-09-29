/**
 * Named bill-mortgage-handling handler. Always fail-closed.
 *
 * Accept-time AWS billing (check_billing_events mortgage_ops_initial /
 * mortgage_ops_additional_check → monthly invoice → Collection V2) is
 * authoritative. This Complete-time endpoint stays reachable as Class A so
 * the Mortgage Desk UI can invoke it, but it must never create a second
 * collectible fee.
 *
 * Does not write platform_fee_line_items or check_billing_events, call
 * Stripe/Moov, or enable money movement.
 *
 * Authorization: Mortgage Desk staff (`mortgage_agent`) or platform owner.
 * Tenant `user_roles.admin` is not a mortgage agent and cannot bill.
 * Assigned-agent check is enforced for non-owners; an authorized Complete
 * still returns production_execution_blocked.
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

const closed = (spoof, extra = {}) => ({
  liveStripeCalled: false,
  liveMoovCalled: false,
  providerExecution: false,
  billed: false,
  platformFeeLineItemsWritten: false,
  checkBillingEventsWritten: false,
  spoofFieldsIgnored: spoof,
  ...extra,
});

export const denyBillMortgageExecution = (spoof, requestId) => ({
  ...denyProviderExecution('stripe', 'bill-mortgage-handling', {
    error: 'production_execution_blocked',
    message: 'Mortgage handling charges stay disabled. Stripe/Moov execution is not enabled. Accept-time check_billing_events remains the collectible ledger.',
  }),
  ...closed(spoof, { request_id: requestId || null }),
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: financialPermissionsActivated(),
  AWS_PROVIDER_EXECUTION_ENABLED: providerExecutionEnabled(),
  flags: {
    ...flagSnapshot(),
    ...financialFlagSnapshot(),
  },
});

export const runBillMortgageHandling = async ({ client, mapping, body, spoof }) => {
  const requestId = typeof body.request_id === 'string' ? body.request_id : null;
  if (!requestId) {
    return closed(spoof, { ok: false, statusCode: 400, error: 'request_id required' });
  }

  const roles = (await safeQuery(client, USER_ROLES_SQL, [mapping.application_user_id])).rows
    .map((row) => row.role);
  const owner = (await safeQuery(client, PLATFORM_OWNER_SQL)).rows[0] || {};
  if (!authorizedForMortgageBilling(roles, owner)) {
    return closed(spoof, { ok: false, statusCode: 403, error: 'not_authorized' });
  }

  const request = (await safeQuery(
    client,
    `SELECT id, tenant_id, assigned_employee_id, billing_status
       FROM public.mortgage_handling_requests
      WHERE id = $1::uuid
      LIMIT 1`,
    [requestId],
  )).rows[0];

  if (!request) {
    return closed(spoof, { ok: false, statusCode: 404, error: 'request_not_found' });
  }

  const isOwner = owner?.is_master === true || owner?.is_platform === true;
  if (!isOwner && request.assigned_employee_id !== mapping.application_user_id) {
    return closed(spoof, { ok: false, statusCode: 403, error: 'not_assigned_to_you' });
  }

  return denyBillMortgageExecution(spoof, requestId);
};

export const handleBillMortgageHandling = (event, deps = {}) => (
  withIdentityWrite(event, (ctx) => runBillMortgageHandling(ctx), deps)
);
