/**
 * Mortgage Desk usage billing bridge.
 *
 * Records completed Mortgage Desk work as an unbilled platform fee line item.
 * It never calls Stripe/Moov and never moves money; the existing periodic Moov
 * fee rollup is responsible for collecting accrued platform fees.
 */
import { withIdentityWrite } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';

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

const denied = (spoof, extra) => ({
  ok: false,
  liveStripeCalled: false,
  liveMoovCalled: false,
  providerExecution: false,
  ...extra,
  spoofFieldsIgnored: spoof,
});

export const runBillMortgageHandling = async ({ client, mapping, body, spoof }) => {
  const requestId = typeof body.request_id === 'string' ? body.request_id : null;
  if (!requestId) return denied(spoof, { statusCode: 400, error: 'request_id required', billed: false });

  const roles = (await safeQuery(client, USER_ROLES_SQL, [mapping.application_user_id])).rows
    .map((row) => row.role);
  const owner = (await safeQuery(client, PLATFORM_OWNER_SQL)).rows[0] || {};
  if (!authorizedForMortgageBilling(roles, owner)) {
    return denied(spoof, { statusCode: 403, error: 'not_authorized', billed: false, platformFeeLineItemsWritten: false });
  }

  const request = (await safeQuery(
    client,
    `SELECT id, tenant_id, claim_id, status, assigned_employee_id, billing_status, billed_at,
            flat_fee_cents, mortgage_company, mortgage_servicer
       FROM public.mortgage_handling_requests
      WHERE id = $1::uuid
      FOR UPDATE`,
    [requestId],
  )).rows[0];

  if (!request) {
    return denied(spoof, { statusCode: 404, error: 'request_not_found', billed: false, platformFeeLineItemsWritten: false });
  }
  if (request.status !== 'completed') {
    return denied(spoof, { statusCode: 409, error: 'request_not_completed', billed: false, platformFeeLineItemsWritten: false });
  }

  const isOwner = owner?.is_master === true || owner?.is_platform === true;
  if (!isOwner && request.assigned_employee_id !== mapping.application_user_id) {
    return denied(spoof, { statusCode: 403, error: 'not_assigned_to_you', billed: false, platformFeeLineItemsWritten: false });
  }

  if (request.billing_status === 'billed' && request.billed_at) {
    return {
      ok: true,
      statusCode: 200,
      request_id: requestId,
      already_billed: true,
      billed: true,
      flat_fee_cents: Number(request.flat_fee_cents || 0),
      platformFeeLineItemsWritten: false,
      liveStripeCalled: false,
      liveMoovCalled: false,
      providerExecution: false,
      spoofFieldsIgnored: spoof,
    };
  }

  let feeCents = Number(request.flat_fee_cents || 0);
  if (!(feeCents > 0)) {
    let additional = false;
    if (request.claim_id) {
      const sibling = (await safeQuery(
        client,
        `SELECT 1
           FROM public.mortgage_handling_requests
          WHERE claim_id = $1::uuid
            AND id <> $2::uuid
            AND billing_status = 'billed'
          LIMIT 1`,
        [request.claim_id, requestId],
      )).rows[0];
      additional = !!sibling;
    }
    feeCents = additional ? 500 : 1000;
  }

  const company = request.mortgage_company || request.mortgage_servicer || 'mortgage company';
  const sourceReference = `mortgage_handling:${requestId}`;
  const inserted = await client.query(
    `INSERT INTO public.platform_fee_line_items (
       tenant_id, fee_code, description, quantity, unit_cents, amount_cents,
       claim_id, status, source_reference, metadata
     ) VALUES (
       $1::uuid, 'mortgage_handling', $2::text, 1, $3::int, $3::int,
       $4::uuid, 'unbilled', $5::text, $6::jsonb
     )
     ON CONFLICT (tenant_id, source_reference) WHERE source_reference IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      request.tenant_id,
      `Mortgage handling — ${company}`,
      feeCents,
      request.claim_id || null,
      sourceReference,
      JSON.stringify({ request_id: requestId, mortgage_company: request.mortgage_company || null }),
    ],
  );

  const lineItemExists = inserted.rowCount > 0 || !!(await client.query(
    `SELECT id FROM public.platform_fee_line_items
      WHERE tenant_id = $1::uuid AND source_reference = $2::text
      LIMIT 1`,
    [request.tenant_id, sourceReference],
  )).rows[0];

  if (!lineItemExists) {
    return denied(spoof, { statusCode: 500, error: 'usage_record_failed', billed: false, platformFeeLineItemsWritten: false });
  }

  await client.query(
    `UPDATE public.mortgage_handling_requests
        SET billing_status = 'billed',
            billed_at = COALESCE(billed_at, now()),
            flat_fee_cents = $2::int,
            billing_error = NULL,
            updated_at = now()
      WHERE id = $1::uuid`,
    [requestId, feeCents],
  );

  return {
    ok: true,
    statusCode: 200,
    request_id: requestId,
    already_billed: inserted.rowCount === 0,
    billed: true,
    flat_fee_cents: feeCents,
    platformFeeLineItemsWritten: inserted.rowCount > 0,
    source_reference: sourceReference,
    liveStripeCalled: false,
    liveMoovCalled: false,
    providerExecution: false,
    spoofFieldsIgnored: spoof,
  };
};

export const handleBillMortgageHandling = (event, deps = {}) => (
  withIdentityWrite(event, (ctx) => runBillMortgageHandling(ctx), deps)
);
