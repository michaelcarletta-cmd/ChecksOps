/** PINNED LIVE PRODUCTION MEMBER write-claim-settlement.mjs sha256 ce53b3683504081fb6ab3f52559a4c6fcad8856cadd078bbf635359f2cc8779d from CodeSha256 kqXCfyf3PVmKxV4ncmLgWKH/A6iwbi/IgsOgFTbIedQ=. Test fixture only. */
/**
 * Dedicated Claim Ledger settlement-breakdown writer.
 *
 * This is a NEW AWS capability. It is not a generic claim_settlements table
 * write and must not be added to AWS_WRITE_TABLES / WRITE_ALLOWLIST.
 *
 * Writes only the ClaimSettlementEditor category amounts. Never writes check,
 * payment, disbursement, Moov/provider, endorsement, or Signature state.
 *
 * Schema note: public.claim_settlements has INDEX(claim_id) only — no UNIQUE.
 * This writer serializes on claims.id FOR UPDATE and never inserts a second
 * row for the same claim. Residual duplicate risk remains for writers outside
 * this path; do not add a unique constraint from this workstream.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value || ''));

export const SAVE_CLAIM_SETTLEMENT_BREAKDOWN = 'save_claim_settlement_breakdown';

export const SETTLEMENT_BREAKDOWN_COLUMNS = Object.freeze([
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

export const SETTLEMENT_BREAKDOWN_COLUMN_SET = new Set(SETTLEMENT_BREAKDOWN_COLUMNS);

/** Client may send these; they are never persisted from the browser. */
export const SETTLEMENT_CLIENT_IGNORED = new Set(['created_by', 'updated_at', 'created_at']);

export const SETTLEMENT_PROHIBITED_FIELDS = Object.freeze([
  'amount',
  'check_stage',
  'deposited_at',
  'check_id',
  'check_intake_item_id',
  'payment_provider',
  'moov_account_id',
  'moov_allowlisted',
  'org_id',
  'tenant_id',
  'acv',
  'actual_cash_value',
  'total_settlement',
  'notes',
  'estimate_amount',
  'pa_estimate_amount',
  'prior_offer',
  'pwi_deductible',
  'endorsement_id',
  'signature_request_id',
  'payment_id',
  'disbursement_id',
  'bank_account_id',
]);

const CATEGORY_ACV = Object.freeze([
  {
    key: 'dwelling',
    rcv: 'replacement_cost_value',
    rec: 'recoverable_depreciation',
    non: 'non_recoverable_depreciation',
    ded: 'deductible',
  },
  {
    key: 'other_structures',
    rcv: 'other_structures_rcv',
    rec: 'other_structures_recoverable_depreciation',
    non: 'other_structures_non_recoverable_depreciation',
    ded: 'other_structures_deductible',
  },
  {
    key: 'pwi',
    rcv: 'pwi_rcv',
    rec: 'pwi_recoverable_depreciation',
    non: 'pwi_non_recoverable_depreciation',
    ded: null,
  },
  {
    key: 'personal_property',
    rcv: 'personal_property_rcv',
    rec: 'personal_property_recoverable_depreciation',
    non: 'personal_property_non_recoverable_depreciation',
    ded: null,
  },
  {
    key: 'ale',
    rcv: 'ale_rcv',
    rec: 'ale_recoverable_depreciation',
    non: 'ale_non_recoverable_depreciation',
    ded: null,
  },
]);

const num = (value) => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
};

export const computeCategoryAcv = (amounts = {}, category) => {
  const spec = typeof category === 'string'
    ? CATEGORY_ACV.find((row) => row.key === category)
    : category;
  if (!spec) return 0;
  return Math.max(
    0,
    num(amounts[spec.rcv]) - num(amounts[spec.rec]) - num(amounts[spec.non]) - (spec.ded ? num(amounts[spec.ded]) : 0),
  );
};

export const computeSettlementAcv = (amounts = {}) => {
  const categories = {};
  let total = 0;
  for (const spec of CATEGORY_ACV) {
    const value = computeCategoryAcv(amounts, spec);
    categories[spec.key] = value;
    total += value;
  }
  return { ...categories, total };
};

const parseMoney = (field, value) => {
  if (value === undefined || value === null || value === '') {
    return { field, value: 0 };
  }
  if (typeof value === 'boolean') {
    return { error: 'invalid_field', field, message: 'Settlement amounts must be numeric' };
  }
  if (typeof value === 'string' && !/^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    return { error: 'invalid_field', field, message: 'Settlement amounts must be numeric' };
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return { error: 'invalid_field', field, message: 'Settlement amounts must be finite numbers' };
  }
  if (n < 0) {
    return { error: 'invalid_field', field, message: 'Settlement amounts must be >= 0' };
  }
  return { field, value: Math.round(n * 100) / 100 };
};

const memberOfTenant = async (client, userId, tenantId) => {
  if (!isUuid(userId) || !isUuid(tenantId)) return false;
  const rows = (await client.query(
    `SELECT 1 FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [userId, tenantId],
  )).rows;
  return rows.length > 0;
};

const awsCanWriteClaim = async (client, claimId) => {
  const rows = (await client.query(
    'SELECT public.aws_can_write_claim($1::uuid) AS allowed',
    [claimId],
  )).rows;
  return rows[0]?.allowed === true;
};

const pickArgsObject = (args = {}) => {
  if (args && typeof args === 'object' && args.values && typeof args.values === 'object') {
    return { ...args.values, ...args };
  }
  return args && typeof args === 'object' ? args : {};
};

export const parseSettlementBreakdownInput = (args = {}) => {
  const raw = pickArgsObject(args);
  const unknown = [];
  const prohibited = [];
  for (const key of Object.keys(raw)) {
    if (key === 'claim_id' || key === 'id' || key === 'settlement_id' || key === 'values') continue;
    if (SETTLEMENT_CLIENT_IGNORED.has(key)) continue;
    if (SETTLEMENT_BREAKDOWN_COLUMN_SET.has(key)) continue;
    if (SETTLEMENT_PROHIBITED_FIELDS.includes(key)) {
      prohibited.push(key);
      continue;
    }
    unknown.push(key);
  }
  if (prohibited.length) {
    return { error: 'column_not_allowlisted', columns: prohibited, message: 'Prohibited financial or identity fields are not writable' };
  }
  if (unknown.length) {
    return { error: 'unknown_column', columns: unknown, message: 'Unknown settlement fields are rejected' };
  }

  const claimId = raw.claim_id;
  if (!isUuid(claimId)) return { error: 'invalid_uuid', field: 'claim_id' };
  const settlementId = raw.settlement_id || raw.id || null;
  if (settlementId != null && settlementId !== '' && !isUuid(settlementId)) {
    return { error: 'invalid_uuid', field: 'id' };
  }

  const amounts = {};
  for (const column of SETTLEMENT_BREAKDOWN_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(raw, column)) {
      amounts[column] = 0;
      continue;
    }
    const parsed = parseMoney(column, raw[column]);
    if (parsed.error) return parsed;
    amounts[column] = parsed.value;
  }

  return {
    claimId,
    settlementId: settlementId || null,
    amounts,
    derived_acv: computeSettlementAcv(amounts),
  };
};

export const executeClaimSettlementBreakdownWrite = async ({ client, mapping, args = {} }) => {
  if (!mapping?.application_user_id || !isUuid(mapping.application_user_id)) {
    return { error: 'not_authorized', message: 'Authenticated application user required' };
  }
  const parsed = parseSettlementBreakdownInput(args);
  if (parsed.error) return parsed;

  const claim = (await client.query(
    `SELECT id, org_id
     FROM public.claims
     WHERE id = $1::uuid
     FOR UPDATE`,
    [parsed.claimId],
  )).rows[0];
  if (!claim) return { error: 'rls_denied', message: 'claim not found or not writable' };
  if (!isUuid(claim.org_id)) {
    return { error: 'not_authorized', message: 'Unassigned claims cannot receive settlement amounts until they have a tenant' };
  }

  const helperAllowed = await awsCanWriteClaim(client, parsed.claimId);
  const member = await memberOfTenant(client, mapping.application_user_id, claim.org_id);
  if (!helperAllowed && !member) {
    return { error: 'not_authorized', message: 'Not authorized to write this claim settlement' };
  }

  const existing = (await client.query(
    `SELECT id, claim_id
     FROM public.claim_settlements
     WHERE claim_id = $1::uuid
     ORDER BY created_at ASC NULLS LAST, id ASC`,
    [parsed.claimId],
  )).rows;

  if (parsed.settlementId) {
    const owned = existing.find((row) => String(row.id) === String(parsed.settlementId));
    if (!owned) {
      const foreign = (await client.query(
        `SELECT id, claim_id FROM public.claim_settlements WHERE id = $1::uuid LIMIT 1`,
        [parsed.settlementId],
      )).rows[0];
      if (foreign) {
        return { error: 'claim_reassignment_denied', message: 'Settlement row does not belong to this claim' };
      }
      return { error: 'rls_denied', message: 'settlement not found or not writable' };
    }
  }

  const target = parsed.settlementId
    ? existing.find((row) => String(row.id) === String(parsed.settlementId))
    : existing[0] || null;

  const columns = SETTLEMENT_BREAKDOWN_COLUMNS;
  const values = columns.map((column) => parsed.amounts[column]);

  let rows;
  if (target) {
    const sets = columns.map((column, index) => `${column} = $${index + 3}::numeric`);
    rows = (await client.query(
      `UPDATE public.claim_settlements
       SET ${sets.join(', ')},
           updated_at = now()
       WHERE id = $1::uuid AND claim_id = $2::uuid
       RETURNING *`,
      [target.id, parsed.claimId, ...values],
    )).rows;
  } else {
    rows = (await client.query(
      `INSERT INTO public.claim_settlements (
         claim_id, created_by, ${columns.join(', ')}
       ) VALUES (
         $1::uuid, $2::uuid, ${columns.map((_, index) => `$${index + 3}::numeric`).join(', ')}
       ) RETURNING *`,
      [parsed.claimId, mapping.application_user_id, ...values],
    )).rows;
  }

  if (!rows.length) return { error: 'rls_denied', message: 'settlement not writable' };
  const row = rows[0];
  if (String(row.claim_id) !== String(parsed.claimId)) {
    return { error: 'claim_reassignment_denied', message: 'Settlement claim_id cannot be changed' };
  }

  return {
    data: {
      ...row,
      derived_acv: parsed.derived_acv,
      duplicate_existing_rows: existing.length > 1 ? existing.length : 0,
    },
  };
};
