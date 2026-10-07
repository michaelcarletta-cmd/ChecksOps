import { parseBody, withIdentityWrite } from './data.mjs';
import { applicationWorkflowWritesEnabled } from './write-allowlist.mjs';

export const CLAIM_SETTLEMENT_VALUE_COLUMNS = Object.freeze([
  'replacement_cost_value',
  'recoverable_depreciation',
  'non_recoverable_depreciation',
  'deductible',
  'other_structures_rcv',
  'other_structures_recoverable_depreciation',
  'other_structures_non_recoverable_depreciation',
  'other_structures_deductible',
  'pwi_rcv',
  'pwi_recoverable_depreciation',
  'pwi_non_recoverable_depreciation',
  'personal_property_rcv',
  'personal_property_recoverable_depreciation',
  'personal_property_non_recoverable_depreciation',
  'ale_rcv',
  'ale_recoverable_depreciation',
  'ale_non_recoverable_depreciation',
]);

export const SAVE_CLAIM_SETTLEMENT_SQL =
  'SELECT public.save_claim_settlement_breakdown($1::uuid, $2::uuid, $3::jsonb) AS result';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALUE_COLUMNS = new Set(CLAIM_SETTLEMENT_VALUE_COLUMNS);
const MAX_AMOUNT = 9_999_999_999.99;

const denied = (spoof, error, statusCode = 400) => ({
  ok: false,
  statusCode,
  error,
  spoofFieldsIgnored: spoof,
});

export const handleClaimSettlementRpc = (event, deps = {}) => {
  const body = parseBody(event);
  const enabled = deps.forceEnabled === true || applicationWorkflowWritesEnabled();
  if (!enabled) {
    return Promise.resolve(denied({}, 'application_workflow_writes_disabled', 403));
  }
  return withIdentityWrite(event, async ({ client, mapping, claims, spoof }) => {
    const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
      ? body.args
      : {};
    const claimId = args.p_claim_id;
    const settlementId = args.p_settlement_id ?? null;
    const values = args.p_values;
    if (typeof claimId !== 'string' || !UUID_RE.test(claimId)) {
      return denied(spoof, 'invalid_uuid');
    }
    if (settlementId !== null && (typeof settlementId !== 'string' || !UUID_RE.test(settlementId))) {
      return denied(spoof, 'invalid_uuid');
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return denied(spoof, 'invalid_settlement_values');
    }
    const entries = Object.entries(values);
    if (!entries.length || entries.some(([key, value]) => (
      !VALUE_COLUMNS.has(key)
      || typeof value !== 'number'
      || !Number.isFinite(value)
      || value < 0
      || value > MAX_AMOUNT
    ))) {
      return denied(spoof, 'invalid_settlement_values');
    }
    const result = (await client.query(
      SAVE_CLAIM_SETTLEMENT_SQL,
      [claimId, settlementId, JSON.stringify(Object.fromEntries(entries))],
    )).rows?.[0]?.result;
    if (!result?.ok) {
      const error = result?.code || 'settlement_save_failed';
      const statusCode = error === 'not_authorized' ? 403 : error === 'not_found' ? 404 : 400;
      return denied(spoof, error, statusCode);
    }
    return {
      ok: true,
      statusCode: 200,
      data: result.settlement ?? null,
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: spoof,
      authorizationSource: 'aws_can_write_claim',
    };
  }, deps);
};
