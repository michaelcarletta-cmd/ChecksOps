/**
 * Named bill-mortgage-handling handler. Always fail-closed.
 * Does not write platform_fee_line_items, call Stripe, or enable money movement.
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

const authorizedForBilling = (roles = []) => {
  const set = new Set(roles.map((role) => String(role || '').toLowerCase()));
  return set.has('admin') || set.has('mortgage_agent');
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
    return { ok: false, statusCode: 400, error: 'request_id required', spoofFieldsIgnored: spoof };
  }
  const roles = (await safeQuery(client, USER_ROLES_SQL, [mapping.application_user_id])).rows
    .map((row) => row.role);
  if (!authorizedForBilling(roles)) {
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
    return { ok: false, statusCode: 404, error: 'request_not_found', spoofFieldsIgnored: spoof };
  }
  const canWrite = (await safeQuery(
    client,
    'SELECT public.aws_can_write_tenant($1::uuid) AS ok',
    [request.tenant_id],
  )).rows[0]?.ok;
  if (canWrite !== true) {
    return {
      ok: false,
      statusCode: 403,
      error: 'forbidden',
      liveStripeCalled: false,
      liveMoovCalled: false,
      billed: false,
      platformFeeLineItemsWritten: false,
      spoofFieldsIgnored: spoof,
    };
  }
  return denyBillMortgageExecution(spoof, requestId);
};

export const handleBillMortgageHandling = (event, deps = {}) => (
  withIdentityWrite(event, (ctx) => runBillMortgageHandling(ctx), deps)
);
