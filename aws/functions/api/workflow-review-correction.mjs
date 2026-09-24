/**
 * Dedicated AWS Review intake/OCR correction path.
 *
 * Distinct from POST /workflow/transition (review decision / state machine)
 * and POST /workflow/admin-status-correction (admin status override).
 *
 * Recovers historical Review "Save Field Changes" + CheckAdminEditDialog
 * OCR-correction semantics: authorized reviewers may correct extracted
 * intake fields (including amount while still in Review) without moving
 * workflow status. Amount is never added to generic /data/write.
 *
 * MICR (routing_number / account_number) is intentionally rejected:
 * Review required-fields and submit_check_review_decision do not persist
 * MICR, and ChecksOps does not require manual MICR correction to complete
 * Review.
 */
import { ignoredSpoof, IS_PLATFORM_OWNER_SQL, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';
import { applicationWorkflowWritesEnabled } from './workflow-flags.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isUuid = (value) => UUID_RE.test(String(value || ''));

const MASTER_OWNER_SQL = 'SELECT public.is_master_owner() AS is_master';
const REVIEW_ROLES = new Set(['admin', 'owner', 'staff', 'manager', 'member']);

/** Amount may be corrected only while the check is still in a Review-like state. */
export const REVIEW_AMOUNT_STATUSES = new Set([
  'needs_review',
  'manual_review_required',
  'ocr_complete',
  'uploaded',
  'processing',
]);

export const REVIEW_CORRECTION_ALLOWED_FIELDS = new Set([
  'carrier_name',
  'check_number',
  'amount',
  'payee_line',
  'issue_date',
  'property_address',
  'funds_type',
  'detected_claim_number',
  'is_multi_payee',
  'expiration_days',
  'review_notes',
  'payee_address',
]);

const TEXT_LIMITS = {
  carrier_name: 200,
  check_number: 80,
  payee_line: 2000,
  property_address: 2000,
  funds_type: 80,
  detected_claim_number: 80,
  review_notes: 2000,
  payee_address: 2000,
};

export const REVIEW_CORRECTION_DENIED_FIELDS = new Set([
  'status',
  'check_stage',
  'claim_id',
  'tenant_id',
  'deposited_at',
  'deposited_by_tenant_id',
  'routing_number',
  'account_number',
  'raw_ocr_front',
  'raw_ocr_back',
  'ocr_status',
  'ocr_needs_verification',
  'ocr_heartbeat_at',
  'deposit_recommendation',
  'deposit_recommendation_reasons',
  'partner_status',
  'partner_status_label',
  'check_source',
  'uploaded_by',
  'reviewed_by',
  'reviewed_at',
  'id',
]);

const denied = (spoof, extra) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  spoofFieldsIgnored: spoof,
  applicationWorkflowWritesEnabled: applicationWorkflowWritesEnabled(),
  providerExecution: false,
  productionSupabaseChanged: false,
  ...extra,
});

const requireWorkflowEnabled = (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const enabled = deps.forceWorkflow === true || applicationWorkflowWritesEnabled();
  if (!enabled) {
    return {
      blocked: denied(spoof, {
        error: 'application_workflow_writes_disabled',
        message: 'Application-workflow writes are disabled by AWS_APPLICATION_WORKFLOW_WRITES_ENABLED',
      }),
    };
  }
  return { body, spoof };
};

const lookupCheck = async (client, checkId) => {
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'check_id' };
  const rows = (await client.query(
    `SELECT id, tenant_id, status, check_stage, claim_id, deposited_at,
            carrier_name, check_number, amount, payee_line, issue_date,
            property_address, funds_type, detected_claim_number,
            is_multi_payee, expiration_days, review_notes, payee_address,
            routing_number, account_number,
            raw_ocr_front, raw_ocr_back, ocr_status, ocr_needs_verification
     FROM public.check_intake_items
     WHERE id = $1::uuid`,
    [checkId],
  )).rows;
  if (!rows.length) return { error: 'not_found', message: 'Check not found' };
  return { check: rows[0] };
};

const isPlatformOwner = async (client) => {
  const [owner, master] = await Promise.all([
    client.query(IS_PLATFORM_OWNER_SQL),
    client.query(MASTER_OWNER_SQL),
  ]);
  return owner.rows[0]?.is_owner === true || master.rows[0]?.is_master === true;
};

const platformRolesOf = async (client, userId) => {
  const rows = (await client.query(USER_ROLES_SQL, [userId])).rows;
  return new Set(rows.map((row) => String(row.role || '').toLowerCase()));
};

const tenantRoleOf = async (client, userId, tenantId) => {
  const rows = (await client.query(
    'SELECT role FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid',
    [userId, tenantId],
  )).rows;
  return new Set(rows.map((row) => String(row.role || '').toLowerCase()));
};

export const authorizeReviewCorrection = async ({ client, userId, tenantId }) => {
  if (await isPlatformOwner(client)) {
    return { ok: true, platformOwner: true };
  }
  const [platformRoles, tenantRoles] = await Promise.all([
    platformRolesOf(client, userId),
    tenantRoleOf(client, userId, tenantId),
  ]);
  const member = tenantRoles.size > 0;
  if (!member) {
    return { error: 'cross_tenant', message: 'Cross-tenant review correction is rejected' };
  }
  const permitted = [...REVIEW_ROLES].some((role) => platformRoles.has(role) || tenantRoles.has(role));
  if (!permitted) {
    return { error: 'not_authorized', message: 'Review or admin permission required for review correction' };
  }
  return { ok: true, platformOwner: false };
};

export const isFinanciallyLocked = (check) => (
  Boolean(check?.deposited_at)
  || String(check?.status || '') === 'deposited'
  || String(check?.check_stage || '') === 'deposited'
);

export const canCorrectAmount = (check) => (
  !isFinanciallyLocked(check) && REVIEW_AMOUNT_STATUSES.has(String(check?.status || ''))
);

const trimOrNull = (value) => {
  if (value === undefined) return { skip: true };
  if (value === null) return { value: null };
  const text = String(value).trim();
  return { value: text.length ? text : null };
};

const normalizeDate = (value) => {
  if (value == null || value === '') return null;
  const raw = String(value);
  if (DATE_RE.test(raw)) return raw;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : raw;
};

const sameAmount = (left, right) => {
  if (left == null && right == null) return true;
  if (left == null || right == null) return false;
  return Number(left) === Number(right);
};

export const coerceReviewCorrectionFields = (rawFields = {}) => {
  const incoming = rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields)
    ? rawFields
    : null;
  if (!incoming) {
    return { error: 'invalid_fields', message: 'fields must be an object' };
  }

  const denied = [];
  const unknown = [];
  for (const key of Object.keys(incoming)) {
    if (key === 'updated_at') continue;
    if (REVIEW_CORRECTION_DENIED_FIELDS.has(key) || key === 'routing_number' || key === 'account_number') {
      denied.push(key);
      continue;
    }
    if (!REVIEW_CORRECTION_ALLOWED_FIELDS.has(key)) {
      unknown.push(key);
    }
  }
  if (denied.includes('routing_number') || denied.includes('account_number')) {
    return {
      error: 'micr_not_enabled',
      message: 'Routing and account numbers are not operator-correctable during Review',
      columns: denied.filter((key) => key === 'routing_number' || key === 'account_number'),
    };
  }
  if (denied.length) {
    return {
      error: 'column_not_allowed',
      message: 'Workflow, provider, or locked columns cannot be changed through review-correction',
      columns: denied,
    };
  }
  if (unknown.length) {
    return {
      error: 'column_not_allowed',
      message: 'Arbitrary columns cannot be supplied to review-correction',
      columns: unknown,
    };
  }

  const values = {};
  for (const [column, max] of Object.entries(TEXT_LIMITS)) {
    if (!(column in incoming)) continue;
    const next = trimOrNull(incoming[column]);
    if (next.skip) continue;
    if (next.value && next.value.length > max) {
      return { error: 'invalid_field', field: column, message: `${column} exceeds ${max} characters` };
    }
    values[column] = next.value;
  }

  if ('issue_date' in incoming) {
    if (incoming.issue_date === null || incoming.issue_date === '') {
      values.issue_date = null;
    } else {
      const date = normalizeDate(incoming.issue_date);
      if (!DATE_RE.test(String(date))) {
        return { error: 'invalid_field', field: 'issue_date', message: 'Issue date must be YYYY-MM-DD' };
      }
      values.issue_date = date;
    }
  }

  if ('expiration_days' in incoming) {
    if (incoming.expiration_days === null || incoming.expiration_days === '') {
      values.expiration_days = null;
    } else {
      const n = Number(incoming.expiration_days);
      if (!Number.isInteger(n) || n < 1 || n > 3650) {
        return { error: 'invalid_field', field: 'expiration_days' };
      }
      values.expiration_days = n;
    }
  }

  if ('is_multi_payee' in incoming) {
    if (incoming.is_multi_payee === true || incoming.is_multi_payee === 'true') values.is_multi_payee = true;
    else if (incoming.is_multi_payee === false || incoming.is_multi_payee === 'false') values.is_multi_payee = false;
    else if (incoming.is_multi_payee != null) return { error: 'invalid_field', field: 'is_multi_payee' };
  }

  if ('amount' in incoming) {
    if (incoming.amount === null || incoming.amount === '') {
      values.amount = null;
    } else {
      const n = Number(String(incoming.amount).replace(/[$,]/g, ''));
      if (!Number.isFinite(n) || n < 0 || n > 50_000_000) {
        return { error: 'invalid_field', field: 'amount', message: 'Amount must be a valid number' };
      }
      values.amount = n;
    }
  }

  return { values };
};

const diffFields = (check, values) => {
  const changes = [];
  const next = {};
  for (const [field, value] of Object.entries(values)) {
    if (field === 'amount') {
      if (sameAmount(check.amount, value)) continue;
      next.amount = value;
      changes.push({
        field: 'amount',
        old_value: check.amount == null ? null : String(check.amount),
        new_value: value == null ? null : String(value),
      });
      continue;
    }
    if (field === 'issue_date') {
      const current = normalizeDate(check.issue_date);
      if (current === value) continue;
      next.issue_date = value;
      changes.push({ field: 'issue_date', old_value: current, new_value: value });
      continue;
    }
    if (field === 'is_multi_payee' || field === 'expiration_days') {
      if (check[field] === value) continue;
      next[field] = value;
      changes.push({
        field,
        old_value: check[field] == null ? null : String(check[field]),
        new_value: value == null ? null : String(value),
      });
      continue;
    }
    const current = check[field] ?? null;
    if (current === value) continue;
    next[field] = value;
    changes.push({ field, old_value: current, new_value: value });
  }
  return { next, changes };
};

const syncCanonicalPayee = async (client, { checkId, tenantId, previousLine, nextLine }) => {
  if (nextLine === undefined) return { action: null };
  const rows = (await client.query(
    `SELECT id, payee_name, payee_type
     FROM public.check_payees
     WHERE check_id = $1::uuid
     ORDER BY created_at ASC NULLS LAST, id ASC`,
    [checkId],
  )).rows;
  if (!nextLine) {
    return { action: rows.length ? 'intake_only' : null, payee_count: rows.length };
  }
  if (rows.length === 0) {
    const inserted = (await client.query(
      `INSERT INTO public.check_payees (
         check_id, tenant_id, payee_name, payee_type, endorsement_status,
         endorsement_token, endorsement_token_expires_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, 'insured', 'pending',
         gen_random_uuid()::text, now() + interval '30 days', now()
       ) RETURNING id, payee_name, payee_type`,
      [checkId, tenantId, nextLine],
    )).rows;
    return { action: 'insert', payee: inserted[0] || null };
  }
  if (rows.length === 1) {
    const current = rows[0];
    const previous = previousLine ?? null;
    if (current.payee_name === nextLine) {
      return { action: 'unchanged', payee_id: current.id };
    }
    if (previous && current.payee_name !== previous && current.payee_name !== nextLine) {
      return { action: 'skipped_divergent', payee_id: current.id };
    }
    await client.query(
      `UPDATE public.check_payees
       SET payee_name = $2::text, updated_at = now()
       WHERE id = $1::uuid`,
      [current.id, nextLine],
    );
    return { action: 'update', payee_id: current.id, old_name: current.payee_name, new_name: nextLine };
  }
  return { action: 'skipped_multi', payee_count: rows.length };
};

export const handleReviewCorrection = async (event, deps = {}) => {
  const gate = requireWorkflowEnabled(event, deps);
  if (gate.blocked) {
    return withIdentity(event, async () => gate.blocked, deps);
  }
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (body.sql || body.query || body.rawSql) {
      return denied(spoof, { error: 'generic_sql_denied' });
    }
    const checkId = body.check_id || body.checkId || body.p_check_id || body.id;
    const rawFields = body.fields || body.p_fields || body.updates || {};
    const looked = await lookupCheck(client, checkId);
    if (looked.error === 'invalid_uuid') {
      return denied(spoof, { statusCode: 400, ...looked });
    }
    if (looked.error === 'not_found') {
      return denied(spoof, { statusCode: 404, ...looked });
    }

    if (isFinanciallyLocked(looked.check)) {
      return denied(spoof, {
        error: 'financial_lock',
        message: 'Deposited or financially locked checks cannot be corrected on the Review path',
      });
    }

    const coerced = coerceReviewCorrectionFields(rawFields);
    if (coerced.error) {
      return denied(spoof, { statusCode: 400, ...coerced });
    }

    if ('amount' in coerced.values && !canCorrectAmount(looked.check)) {
      return denied(spoof, {
        error: 'amount_locked',
        message: 'Amount can be corrected only while the check is still in Review and not financially locked',
        status: looked.check.status,
      });
    }

    const authz = await authorizeReviewCorrection({
      client,
      userId: mapping.application_user_id,
      tenantId: looked.check.tenant_id,
    });
    if (authz.error) {
      return denied(spoof, { statusCode: 403, ...authz });
    }

    const snapshot = { ...looked.check };
    const { next, changes } = diffFields(snapshot, coerced.values);
    const actorId = mapping.application_user_id;
    const correctedAt = new Date().toISOString();
    if (!changes.length) {
      return {
        ok: true,
        statusCode: 200,
        data: {
          ok: true,
          check_id: looked.check.id,
          unchanged: true,
          actor_id: actorId,
          status: looked.check.status,
          check_stage: looked.check.check_stage,
          field_changes: [],
          ocr_preserved: true,
        },
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        spoofFieldsIgnored: spoof,
        authorizationSource: 'review_correction',
        applicationWorkflowWritesEnabled: true,
        providerExecution: false,
        productionSupabaseChanged: false,
      };
    }

    const columns = Object.keys(next);
    const sets = columns.map((column, index) => `${column} = $${index + 2}`);
    const params = [looked.check.id, ...columns.map((column) => next[column])];
    const rows = (await client.query(
      `UPDATE public.check_intake_items
       SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $1::uuid
       RETURNING id, tenant_id, status, check_stage, deposited_at,
                 carrier_name, check_number, amount, payee_line, issue_date,
                 property_address, funds_type, detected_claim_number,
                 is_multi_payee, expiration_days, review_notes, payee_address,
                 raw_ocr_front, raw_ocr_back, ocr_status, ocr_needs_verification,
                 updated_at`,
      params,
    )).rows;
    if (!rows.length) {
      return denied(spoof, { error: 'rls_denied', message: 'check not writable' });
    }
    const updated = rows[0];

    const payeeSync = await syncCanonicalPayee(client, {
      checkId: looked.check.id,
      tenantId: looked.check.tenant_id,
      previousLine: snapshot.payee_line ?? null,
      nextLine: next.payee_line,
    });

    let claimChecksMirrored = false;
    await client.query('SAVEPOINT review_correction_claim_mirror');
    try {
      const cc = {};
      if (next.carrier_name !== undefined) cc.carrier_name = next.carrier_name;
      if (next.check_number !== undefined) cc.check_number = next.check_number;
      if (next.payee_line !== undefined) cc.payee_line = next.payee_line;
      if (next.issue_date !== undefined) cc.check_date = next.issue_date;
      if (next.amount !== undefined) cc.amount = next.amount;
      const ccKeys = Object.keys(cc);
      if (ccKeys.length) {
        const ccSets = ccKeys.map((column, index) => `${column} = $${index + 2}`);
        await client.query(
          `UPDATE public.claim_checks
           SET ${ccSets.join(', ')}, updated_at = now()
           WHERE check_intake_item_id = $1::uuid`,
          [looked.check.id, ...ccKeys.map((column) => cc[column])],
        );
      }
      await client.query('RELEASE SAVEPOINT review_correction_claim_mirror');
      claimChecksMirrored = true;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT review_correction_claim_mirror');
      const code = String(error?.code || '');
      const message = String(error?.message || error);
      if (code !== '42501' && !/permission denied for (table|relation) claim_checks/i.test(message)) {
        throw error;
      }
    }

    await client.query(
      `INSERT INTO public.check_audit_log (
         check_id, tenant_id, actor_id, event_type, event_description, event_data
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'review_correction',
         $4::text,
         $5::jsonb
       )`,
      [
        looked.check.id,
        updated.tenant_id,
        actorId,
        `Review correction: ${changes.map((row) => row.field).join(', ')}`,
        JSON.stringify({
          field_changes: changes,
          actor_id: actorId,
          previous_status: snapshot.status,
          status: updated.status,
          status_unchanged: updated.status === snapshot.status,
          check_stage: updated.check_stage,
          payee_sync: payeeSync,
          ocr_preserved: {
            raw_ocr_front: updated.raw_ocr_front === looked.check.raw_ocr_front,
            raw_ocr_back: updated.raw_ocr_back === looked.check.raw_ocr_back,
            ocr_status: updated.ocr_status,
            ocr_needs_verification: updated.ocr_needs_verification,
          },
          timestamp: updated.updated_at || correctedAt,
        }),
      ],
    );

    return {
      ok: true,
      statusCode: 200,
      data: {
        ok: true,
        check_id: looked.check.id,
        actor_id: actorId,
        status: updated.status,
        check_stage: updated.check_stage,
        field_changes: changes,
        payee_sync: payeeSync,
        claim_checks_mirrored: claimChecksMirrored,
        ocr_preserved: true,
        timestamp: updated.updated_at || correctedAt,
        intake: {
          carrier_name: updated.carrier_name,
          check_number: updated.check_number,
          amount: updated.amount,
          payee_line: updated.payee_line,
          issue_date: updated.issue_date,
          property_address: updated.property_address,
          funds_type: updated.funds_type,
          detected_claim_number: updated.detected_claim_number,
        },
      },
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: spoof,
      authorizationSource: 'review_correction',
      applicationWorkflowWritesEnabled: true,
      providerExecution: false,
      productionSupabaseChanged: false,
    };
  }, deps);
};
