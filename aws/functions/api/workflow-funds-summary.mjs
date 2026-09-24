/**
 * Canonical AWS funds accounting for one check.
 *
 * Disbursed = settled/completed/pending/submitted outgoing splits on this
 * check, regardless of rail (external vs Moov). Failed/cancelled/returned/
 * voided splits do not count. Provider execution is never invoked.
 */
import { IS_PLATFORM_OWNER_SQL, withIdentity } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));
const MASTER_OWNER_SQL = 'SELECT public.is_master_owner() AS is_master';

export const EXCLUDED_DISBURSED_STATUSES = Object.freeze([
  'failed',
  'cancelled',
  'returned',
  'voided',
]);

export const toCents = (value) => Math.round((Number(value) || 0) * 100) / 100;

const excludedSql = EXCLUDED_DISBURSED_STATUSES.map((status) => `'${status}'`).join(', ');

export const CHECK_FUNDS_SQL = `
SELECT
  ci.id AS check_id,
  ci.tenant_id,
  ci.status,
  ci.check_stage,
  ci.amount AS received_amount,
  ci.pa_fee_pct,
  ci.pa_fee_amount,
  COALESCE((
    SELECT SUM(s.amount)
    FROM public.disbursement_splits s
    JOIN public.disbursement_batches b ON b.id = s.batch_id
    WHERE b.check_intake_item_id = ci.id
      AND s.tenant_id = ci.tenant_id
      AND s.status NOT IN (${excludedSql})
  ), 0) AS disbursed_amount,
  COALESCE((
    SELECT SUM(s.amount)
    FROM public.disbursement_splits s
    JOIN public.disbursement_batches b ON b.id = s.batch_id
    WHERE b.check_intake_item_id = ci.id
      AND s.tenant_id = ci.tenant_id
      AND s.status IN ('pending', 'submitted')
  ), 0) AS in_transit_amount
FROM public.check_intake_items ci
WHERE ci.id = $1::uuid
`;

export const FUNDS_SPLITS_SQL = `
SELECT s.id, s.batch_id, s.amount, s.status, s.method, s.rail,
       s.external_check_number, s.recipient_name, s.recipient_type,
       s.settled_at, s.created_at, s.tenant_id
FROM public.disbursement_splits s
JOIN public.disbursement_batches b ON b.id = s.batch_id
WHERE b.check_intake_item_id = $1::uuid
  AND s.tenant_id = $2::uuid
ORDER BY s.created_at DESC
`;

export const computeFundsFromRow = (row, { readOnly = false, incomingReceived = 0 } = {}) => {
  const checkAmount = toCents(row?.received_amount ?? row?.amount);
  const incoming = toCents(incomingReceived);
  const received = incoming > 0 ? incoming : (readOnly ? 0 : checkAmount);
  const disbursed = toCents(row?.disbursed_amount);
  const inTransit = toCents(row?.in_transit_amount);
  let paFee = 0;
  if (row?.pa_fee_pct != null && Number(row.pa_fee_pct) > 0) {
    paFee = toCents((received * Number(row.pa_fee_pct)) / 100);
  } else if (row?.pa_fee_amount != null) {
    paFee = toCents(row.pa_fee_amount);
  }
  const available = Math.max(0, toCents(received - paFee - disbursed));
  return {
    check_id: row?.check_id,
    tenant_id: row?.tenant_id,
    status: row?.status || null,
    check_stage: row?.check_stage || null,
    received,
    disbursed,
    available,
    in_transit: inTransit,
    pa_fee: paFee,
    check_amount: checkAmount,
  };
};

export const loadCheckFunds = async (client, { checkId, incomingReceived = 0, readOnly = false } = {}) => {
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'check_id' };
  const row = (await client.query(CHECK_FUNDS_SQL, [checkId])).rows[0];
  if (!row) return { error: 'not_found', message: 'Check not found' };
  const totals = computeFundsFromRow(row, { incomingReceived, readOnly });
  const payments = (await client.query(FUNDS_SPLITS_SQL, [row.check_id, row.tenant_id])).rows;
  return { row, totals, payments };
};

const isPlatformOwner = async (client) => {
  const [owner, master] = await Promise.all([
    client.query(IS_PLATFORM_OWNER_SQL),
    client.query(MASTER_OWNER_SQL),
  ]);
  return owner.rows[0]?.is_owner === true || master.rows[0]?.is_master === true;
};

const authorizeReader = async ({ client, userId, tenantId }) => {
  if (await isPlatformOwner(client)) return { ok: true, platformOwner: true };
  const platformRoles = new Set(
    (await client.query(USER_ROLES_SQL, [userId])).rows.map((row) => String(row.role || '').toLowerCase()),
  );
  const tenantRoles = new Set(
    (await client.query(
      'SELECT role FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid',
      [userId, tenantId],
    )).rows.map((row) => String(row.role || '').toLowerCase()),
  );
  if (!tenantRoles.size && !platformRoles.has('admin') && !platformRoles.has('staff')) {
    return { error: 'cross_tenant', message: 'Cross-tenant funds summary is rejected' };
  }
  return { ok: true, platformOwner: false };
};

export const handleFundsSummary = async (event, deps = {}) => {
  return withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
    const checkId = body.check_id || body.checkId || body.p_check_id || body.id;
    const loaded = await loadCheckFunds(client, { checkId });
    if (loaded.error) {
      return {
        ok: false,
        statusCode: loaded.error === 'invalid_uuid' ? 400 : 404,
        error: loaded.error,
        message: loaded.message,
        field: loaded.field,
        spoofFieldsIgnored: spoof,
        providerExecution: false,
        moovInvoked: false,
        productionSupabaseChanged: false,
      };
    }
    const authz = await authorizeReader({
      client,
      userId: mapping.application_user_id,
      tenantId: loaded.row.tenant_id,
    });
    if (authz.error) {
      return {
        ok: false,
        statusCode: 403,
        error: authz.error,
        message: authz.message,
        spoofFieldsIgnored: spoof,
        providerExecution: false,
        moovInvoked: false,
        productionSupabaseChanged: false,
      };
    }
    return {
      ok: true,
      statusCode: 200,
      data: {
        ...loaded.totals,
        payments: loaded.payments.map((row) => ({
          id: row.id,
          batch_id: row.batch_id,
          amount: toCents(row.amount),
          status: row.status,
          method: row.method,
          rail: row.rail,
          external_check_number: row.external_check_number,
          recipient_name: row.recipient_name,
          recipient_type: row.recipient_type,
          settled_at: row.settled_at,
          created_at: row.created_at,
        })),
        provider_execution: false,
      },
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: spoof,
      authorizationSource: 'funds_summary',
      providerExecution: false,
      moovInvoked: false,
      checkAltInvoked: false,
      productionSupabaseChanged: false,
    };
  }, deps);
};
