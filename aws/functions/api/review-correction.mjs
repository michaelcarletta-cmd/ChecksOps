import { isTerminalFinancial } from './workflow-transitions.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const REVIEW_CORRECTION_TEXT_FIELDS = {
  carrier_name: 200,
  check_number: 80,
  payee_line: 2000,
  property_address: 2000,
  review_notes: 2000,
  payee_address: 2000,
  funds_type: 80,
};

export const REVIEW_CORRECTION_COLUMNS = new Set([
  ...Object.keys(REVIEW_CORRECTION_TEXT_FIELDS),
  'issue_date',
  'expiration_days',
  'is_multi_payee',
  'amount',
  'payees',
]);

export const REVIEW_CORRECTION_DENIED_COLUMNS = new Set([
  'status',
  'check_stage',
  'claim_id',
  'detected_claim_number',
  'routing_number',
  'account_number',
  'raw_ocr_front',
  'raw_ocr_back',
  'ocr_status',
  'deposited_at',
  'deposited_by_tenant_id',
  'tenant_id',
  'uploaded_by',
  'reviewed_by',
  'partner_status',
  'check_source',
  'cash_job_id',
  'mortgage_final_released_at',
  'endorsement_packet_path',
]);

export const REVIEW_AMOUNT_STATUSES = new Set([
  'uploaded',
  'needs_review',
  'ocr_complete',
  'manual_review_required',
]);

export const AMOUNT_LOCKED_STATUSES = new Set(['deposited', 'approved_for_deposit']);
export const AMOUNT_LOCKED_STAGES = new Set([
  'deposited',
  'ready_for_deposit',
  'funds_released',
  'disbursed_externally',
]);

export const REVIEW_PAYEE_TYPES = new Set([
  'insured',
  'mortgage_company',
  'contractor',
  'public_adjuster',
  'other',
  'unknown',
]);

const isUuid = (value) => UUID_RE.test(String(value || ''));

const clip = (value, max) => {
  if (value === undefined) return { skip: true };
  if (value === null) return { value: null };
  const text = String(value);
  if (text.length > max) return { error: 'invalid_field', field: 'length' };
  const trimmed = text.trim();
  return { value: trimmed.length ? trimmed : null };
};

export const isAmountFinanciallyLocked = (check = {}) => {
  if (isTerminalFinancial(check)) return true;
  const status = String(check.status || '');
  const stage = String(check.check_stage || '');
  return AMOUNT_LOCKED_STATUSES.has(status) || AMOUNT_LOCKED_STAGES.has(stage);
};

export const isAmountInReview = (check = {}) => {
  const status = String(check.status || '');
  const stage = String(check.check_stage || '');
  return REVIEW_AMOUNT_STATUSES.has(status) || stage === 'review';
};

export const canCorrectAmount = (check = {}) => isAmountInReview(check) && !isAmountFinanciallyLocked(check);

const WRAPPER_KEYS = new Set(['check_id', 'checkId', 'id', 'p_check_id', 'updates', 'action']);

export const parseReviewCorrectionBody = (body = {}) => {
  const wrapperDenied = Object.keys(body || {}).filter((key) => REVIEW_CORRECTION_DENIED_COLUMNS.has(key));
  const incoming = body.updates && typeof body.updates === 'object' && !Array.isArray(body.updates)
    ? body.updates
    : body;
  const denied = [...wrapperDenied];
  const unknown = [];
  for (const key of Object.keys(incoming || {})) {
    if (WRAPPER_KEYS.has(key)) continue;
    if (REVIEW_CORRECTION_DENIED_COLUMNS.has(key)) {
      if (!denied.includes(key)) denied.push(key);
      continue;
    }
    if (!REVIEW_CORRECTION_COLUMNS.has(key)) unknown.push(key);
  }
  if (denied.length || unknown.length) {
    return {
      error: 'column_not_allowlisted',
      columns: [...denied, ...unknown],
      message: 'Review correction accepts only an explicit field allowlist',
    };
  }

  const values = {};
  for (const [column, max] of Object.entries(REVIEW_CORRECTION_TEXT_FIELDS)) {
    if (!(column in incoming)) continue;
    const text = clip(incoming[column], max);
    if (text.error) return { error: 'invalid_field', field: column };
    values[column] = text.value;
  }

  if ('issue_date' in incoming) {
    if (incoming.issue_date === null || incoming.issue_date === '') values.issue_date = null;
    else if (!DATE_RE.test(String(incoming.issue_date))) return { error: 'invalid_field', field: 'issue_date' };
    else values.issue_date = String(incoming.issue_date);
  }

  if ('expiration_days' in incoming) {
    if (incoming.expiration_days === null || incoming.expiration_days === '') values.expiration_days = null;
    else {
      const n = Number(incoming.expiration_days);
      if (!Number.isInteger(n) || n < 1 || n > 3650) return { error: 'invalid_field', field: 'expiration_days' };
      values.expiration_days = n;
    }
  }

  if ('is_multi_payee' in incoming) {
    if (incoming.is_multi_payee === true || incoming.is_multi_payee === 'true') values.is_multi_payee = true;
    else if (incoming.is_multi_payee === false || incoming.is_multi_payee === 'false') values.is_multi_payee = false;
    else if (incoming.is_multi_payee != null) return { error: 'invalid_field', field: 'is_multi_payee' };
  }

  if ('amount' in incoming) {
    if (incoming.amount === null || incoming.amount === '') values.amount = null;
    else {
      const n = Number(String(incoming.amount).replace(/[$,]/g, ''));
      if (!Number.isFinite(n) || n < 0 || n > 50_000_000) return { error: 'invalid_field', field: 'amount' };
      values.amount = n;
    }
  }

  if ('payees' in incoming) {
    if (!Array.isArray(incoming.payees)) return { error: 'invalid_field', field: 'payees' };
    const payees = [];
    for (const row of incoming.payees) {
      if (!row || typeof row !== 'object') return { error: 'invalid_field', field: 'payees' };
      if (!isUuid(row.id)) return { error: 'invalid_uuid', field: 'payees.id' };
      const name = clip(row.payee_name, 200);
      if (name.error) return { error: 'invalid_field', field: 'payee_name' };
      const type = row.payee_type == null ? undefined : String(row.payee_type).trim();
      if (type && !REVIEW_PAYEE_TYPES.has(type)) return { error: 'invalid_field', field: 'payee_type' };
      payees.push({
        id: String(row.id),
        ...(name.skip ? {} : { payee_name: name.value }),
        ...(type ? { payee_type: type } : {}),
      });
    }
    values.payees = payees;
  }

  const { payees, amount, ...intake } = values;
  if (!Object.keys(intake).length && amount === undefined && !(payees && payees.length)) {
    return { error: 'missing_required_field', field: 'updates', message: 'No review-correction fields supplied' };
  }
  return { values: { ...intake, ...(amount !== undefined ? { amount } : {}), ...(payees ? { payees } : {}) } };
};

const amountEqual = (a, b) => {
  const left = a == null ? null : Number(a);
  const right = b == null ? null : Number(b);
  if (left == null && right == null) return true;
  return left === right;
};

export const diffReviewCorrection = (check = {}, values = {}) => {
  const fieldChanges = [];
  const intake = {};
  for (const [key, next] of Object.entries(values)) {
    if (key === 'payees' || key === 'amount') continue;
    const current = check[key] ?? null;
    if (String(current ?? '') !== String(next ?? '')) {
      intake[key] = next;
      fieldChanges.push({ field: key, old_value: current, new_value: next });
    }
  }
  let amount;
  if ('amount' in values && !amountEqual(check.amount, values.amount)) {
    amount = values.amount;
    fieldChanges.push({
      field: 'amount',
      old_value: check.amount == null ? null : String(check.amount),
      new_value: values.amount == null ? null : String(values.amount),
    });
  }
  return { intake, amount, payees: values.payees || [], fieldChanges };
};

export const REVIEW_CORRECTION_LOOKUP_SQL = `
SELECT id, tenant_id, uploaded_by, status, check_stage, claim_id, deposited_at,
       external_origin, partner_status, carrier_name, check_number, payee_line,
       issue_date, amount, funds_type, property_address, payee_address,
       review_notes, expiration_days, is_multi_payee,
       raw_ocr_front IS NOT NULL AS has_raw_ocr_front,
       raw_ocr_back IS NOT NULL AS has_raw_ocr_back,
       ocr_status, routing_number, account_number
  FROM public.check_intake_items
 WHERE id = $1::uuid
`;

const buildIntakeUpdate = (intake) => {
  const columns = Object.keys(intake);
  if (!columns.length) return null;
  const sets = columns.map((column, idx) => {
    if (column === 'issue_date') return `${column} = $${idx + 2}::date`;
    if (column === 'expiration_days') return `${column} = $${idx + 2}::int`;
    if (column === 'is_multi_payee') return `${column} = $${idx + 2}::boolean`;
    return `${column} = $${idx + 2}`;
  });
  return {
    sql: `UPDATE public.check_intake_items
             SET ${sets.join(', ')}, updated_at = now()
           WHERE id = $1::uuid
           RETURNING id, tenant_id, status, check_stage, amount, carrier_name,
                     check_number, payee_line, issue_date, funds_type, property_address,
                     payee_address, review_notes, expiration_days, is_multi_payee,
                     raw_ocr_front IS NOT NULL AS has_raw_ocr_front,
                     raw_ocr_back IS NOT NULL AS has_raw_ocr_back`,
    params: [null, ...columns.map((column) => intake[column])],
  };
};

export const applyReviewCorrection = async ({
  client,
  mapping,
  check,
  values,
  canAccessTenant,
}) => {
  if (!(await canAccessTenant(check.tenant_id))) {
    return { error: 'not_authorized', message: 'Check is not in the actor tenant' };
  }
  const { intake, amount, payees, fieldChanges } = diffReviewCorrection(check, values);
  if (!fieldChanges.length && !payees.length) {
    return { error: 'no_changes', message: 'No field changes to save', statusCode: 200 };
  }
  if (amount !== undefined) {
    if (isAmountFinanciallyLocked(check)) {
      return { error: 'amount_financially_locked', message: 'Amount cannot be changed after financial/deposit lock' };
    }
    if (!isAmountInReview(check)) {
      return { error: 'amount_not_in_review', message: 'Amount can be corrected only while the check is in Review' };
    }
  }

  const ocrBefore = {
    has_raw_ocr_front: Boolean(check.has_raw_ocr_front),
    has_raw_ocr_back: Boolean(check.has_raw_ocr_back),
  };

  let after = { ...check };
  if (Object.keys(intake).length) {
    const update = buildIntakeUpdate(intake);
    update.params[0] = check.id;
    const rows = (await client.query(update.sql, update.params)).rows;
    if (!rows.length) return { error: 'rls_denied', message: 'check not writable' };
    after = { ...after, ...rows[0] };

    const ccSets = [];
    const ccParams = [check.id];
    if ('carrier_name' in intake) {
      ccParams.push(intake.carrier_name);
      ccSets.push(`carrier_name = $${ccParams.length}`);
    }
    if ('check_number' in intake) {
      ccParams.push(intake.check_number);
      ccSets.push(`check_number = $${ccParams.length}`);
    }
    if ('payee_line' in intake) {
      ccParams.push(intake.payee_line);
      ccSets.push(`payee_line = $${ccParams.length}`);
    }
    if ('issue_date' in intake) {
      ccParams.push(intake.issue_date);
      ccSets.push(`check_date = $${ccParams.length}::date`);
    }
    if (ccSets.length) {
      await client.query(
        `UPDATE public.claim_checks
            SET ${ccSets.join(', ')}, updated_at = now()
          WHERE check_intake_item_id = $1::uuid`,
        ccParams,
      );
    }
  }

  if (amount !== undefined) {
    try {
      const rpc = await client.query(
        'SELECT public.aws_review_correction_set_amount($1::uuid, $2::numeric) AS result',
        [check.id, amount],
      );
      const result = rpc.rows?.[0]?.result;
      if (!result || result.ok !== true) {
        return { error: 'amount_correction_failed', message: 'Amount correction RPC did not confirm the write' };
      }
      after.amount = result.amount;
    } catch (error) {
      const message = String(error?.message || '');
      if (/amount_financially_locked/i.test(message)) {
        return { error: 'amount_financially_locked', message: 'Amount cannot be changed after financial/deposit lock' };
      }
      if (/amount_not_in_review/i.test(message)) {
        return { error: 'amount_not_in_review', message: 'Amount can be corrected only while the check is in Review' };
      }
      if (/not_authorized|rls_denied|42501/i.test(message) || error?.code === '42501') {
        return { error: 'not_authorized', message: 'Not authorized to correct amount' };
      }
      if (/function .* does not exist/i.test(message)) {
        return {
          error: 'amount_rpc_unavailable',
          message: 'aws_review_correction_set_amount is not installed on this database',
        };
      }
      throw error;
    }
  }

  const payeeChanges = [];
  for (const payee of payees) {
    const current = (await client.query(
      `SELECT id, check_id, payee_name, payee_type
         FROM public.check_payees
        WHERE id = $1::uuid AND check_id = $2::uuid`,
      [payee.id, check.id],
    )).rows[0];
    if (!current) {
      return { error: 'rls_denied', message: 'Payee not found for this check' };
    }
    const nextName = 'payee_name' in payee ? payee.payee_name : current.payee_name;
    const nextType = 'payee_type' in payee ? payee.payee_type : current.payee_type;
    if (nextName === current.payee_name && nextType === current.payee_type) continue;
    await client.query(
      `UPDATE public.check_payees
          SET payee_name = $3::text,
              payee_type = $4::text,
              updated_at = now()
        WHERE id = $1::uuid AND check_id = $2::uuid`,
      [payee.id, check.id, nextName, nextType],
    );
    payeeChanges.push({
      payee_id: payee.id,
      old_name: current.payee_name,
      new_name: nextName,
      old_type: current.payee_type,
      new_type: nextType,
    });
  }

  const ocrAfter = (await client.query(
    `SELECT raw_ocr_front IS NOT NULL AS has_raw_ocr_front,
            raw_ocr_back IS NOT NULL AS has_raw_ocr_back,
            status, check_stage, amount
       FROM public.check_intake_items
      WHERE id = $1::uuid`,
    [check.id],
  )).rows[0] || {};

  if (ocrBefore.has_raw_ocr_front && ocrAfter.has_raw_ocr_front === false) {
    return { error: 'ocr_evidence_lost', message: 'Review correction must not overwrite OCR evidence' };
  }
  if (String(ocrAfter.status || check.status) !== String(check.status || '')) {
    return { error: 'status_mutated', message: 'Review correction must not change status' };
  }

  await client.query(
    `INSERT INTO public.check_audit_log (
       check_id, tenant_id, actor_id, event_type, event_description, event_data
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'review_correction',
       'Review intake correction without moving workflow status',
       $4::jsonb
     )`,
    [
      check.id,
      check.tenant_id,
      mapping.application_user_id,
      JSON.stringify({
        field_changes: fieldChanges,
        payee_changes: payeeChanges,
        actor_id: mapping.application_user_id,
        status_unchanged: check.status,
        stage_unchanged: check.check_stage,
        ocr_preserved: {
          raw_ocr_front: Boolean(ocrAfter.has_raw_ocr_front ?? ocrBefore.has_raw_ocr_front),
          raw_ocr_back: Boolean(ocrAfter.has_raw_ocr_back ?? ocrBefore.has_raw_ocr_back),
        },
        amount_via: amount !== undefined ? 'aws_review_correction_set_amount' : null,
        generic_data_write: false,
      }),
    ],
  );

  return {
    ok: true,
    after: {
      ...after,
      status: check.status,
      check_stage: check.check_stage,
      amount: ocrAfter.amount ?? after.amount,
    },
    fieldChanges,
    payeeChanges,
    ocrPreserved: true,
  };
};
