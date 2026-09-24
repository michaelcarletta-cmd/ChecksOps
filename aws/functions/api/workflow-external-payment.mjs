/**
 * Dedicated AWS path for recording an already-completed external payment.
 *
 * Distinct from Moov/ACH provider disbursement and from generic
 * disbursement_batches / disbursement_splits /data/write.
 * Never calls Moov, never initiates ACH, never writes moov_* columns.
 *
 * Historical FundsTab.recordExternal side effects that survive here:
 * - disbursement_batches row (status=completed, created_by=server actor)
 * - disbursement_splits row (status=settled, method=external_check)
 * - remaining-funds math from settled splits
 * - DB trigger trg_advance_stage_on_disbursement may set check_stage=funds_released
 * - check_audit_log
 */
import { ignoredSpoof, IS_PLATFORM_OWNER_SQL, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';
import { applicationWorkflowWritesEnabled } from './workflow-flags.mjs';
import { loadCheckFunds, toCents as fundsToCents } from './workflow-funds-summary.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isUuid = (value) => UUID_RE.test(String(value || ''));

const MASTER_OWNER_SQL = 'SELECT public.is_master_owner() AS is_master';
const RECIPIENT_TYPES = new Set([
  'subcontractor',
  'contractor',
  'sales_rep',
  'appraisal',
  'supplier',
  'adjuster',
  'vendor',
  'insured',
  'homeowner',
  'other',
]);
const ALLOWED_BODY = new Set([
  'check_id',
  'checkId',
  'p_check_id',
  'id',
  'recipient_name',
  'recipientName',
  'p_recipient_name',
  'recipient_type',
  'recipientType',
  'p_recipient_type',
  'amount',
  'p_amount',
  'external_check_number',
  'externalCheckNumber',
  'p_external_check_number',
  'reference',
  'p_reference',
  'notes',
  'p_notes',
  'external_notes',
  'payment_date',
  'paymentDate',
  'p_payment_date',
  'idempotency_key',
  'idempotencyKey',
]);
const IGNORED_BODY = new Set([
  'p_actor_id',
  'actor_id',
  'user_id',
  'tenant_id',
  'created_by',
  'p_user_id',
  'p_tenant_id',
]);

const denied = (spoof, extra) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  spoofFieldsIgnored: spoof,
  applicationWorkflowWritesEnabled: applicationWorkflowWritesEnabled(),
  providerExecution: false,
  checkAltInvoked: false,
  moovInvoked: false,
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

const isPlatformOwner = async (client) => {
  const [owner, master] = await Promise.all([
    client.query(IS_PLATFORM_OWNER_SQL),
    client.query(MASTER_OWNER_SQL),
  ]);
  return owner.rows[0]?.is_owner === true || master.rows[0]?.is_master === true;
};

const authorizeRecorder = async ({ client, userId, tenantId }) => {
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
    return { error: 'cross_tenant', message: 'Cross-tenant external payment recording is rejected' };
  }
  const allowed = ['admin', 'owner', 'staff', 'manager'];
  if (!allowed.some((role) => platformRoles.has(role) || tenantRoles.has(role))) {
    return { error: 'not_authorized', message: 'Staff, manager, or admin required to record an external payment' };
  }
  return { ok: true, platformOwner: false };
};

const clip = (value, max) => {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
};

const toCents = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const handleExternalPayment = async (event, deps = {}) => {
  const gate = requireWorkflowEnabled(event, deps);
  if (gate.blocked) {
    return withIdentity(event, async () => gate.blocked, deps);
  }
  return withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (body.sql || body.query || body.rawSql) {
      return denied(spoof, { error: 'generic_sql_denied' });
    }
    const unknown = Object.keys(body || {}).filter((key) => !ALLOWED_BODY.has(key) && !IGNORED_BODY.has(key));
    if (unknown.length) {
      return denied(spoof, {
        statusCode: 400,
        error: 'field_not_allowlisted',
        message: 'External payment accepts only an explicit field allowlist',
        deniedFields: unknown,
      });
    }
    if (body.moov_transfer_id || body.stakeholder_account_id || body.rail === 'moov') {
      return denied(spoof, { error: 'provider_execution_denied', message: 'External payment recording cannot initiate Moov or ACH' });
    }

    const checkId = body.check_id || body.checkId || body.p_check_id || body.id;
    if (!isUuid(checkId)) return denied(spoof, { statusCode: 400, error: 'invalid_uuid', field: 'check_id' });

    const recipientName = clip(body.recipient_name || body.recipientName || body.p_recipient_name, 200);
    const recipientType = String(body.recipient_type || body.recipientType || body.p_recipient_type || 'vendor').trim();
    const reference = clip(
      body.external_check_number || body.externalCheckNumber || body.p_external_check_number || body.reference || body.p_reference,
      80,
    );
    const notes = clip(body.notes || body.p_notes || body.external_notes, 2000);
    const amount = toCents(body.amount || body.p_amount);
    if (!recipientName) return denied(spoof, { statusCode: 400, error: 'missing_required_field', field: 'recipient_name' });
    if (!reference) return denied(spoof, { statusCode: 400, error: 'missing_required_field', field: 'external_check_number' });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 50_000_000) {
      return denied(spoof, { statusCode: 400, error: 'invalid_field', field: 'amount' });
    }
    if (!RECIPIENT_TYPES.has(recipientType)) {
      return denied(spoof, { statusCode: 400, error: 'invalid_field', field: 'recipient_type' });
    }

    let settledAt = new Date();
    const paymentDateRaw = body.payment_date || body.paymentDate || body.p_payment_date;
    if (paymentDateRaw != null && paymentDateRaw !== '') {
      const text = String(paymentDateRaw);
      if (DATE_RE.test(text)) settledAt = new Date(`${text}T12:00:00.000Z`);
      else {
        const parsed = new Date(text);
        if (Number.isNaN(parsed.getTime())) {
          return denied(spoof, { statusCode: 400, error: 'invalid_field', field: 'payment_date' });
        }
        settledAt = parsed;
      }
    }

    const check = (await client.query(
      `SELECT id, tenant_id, status, check_stage, amount, deposited_at
       FROM public.check_intake_items
       WHERE id = $1::uuid
       FOR UPDATE`,
      [checkId],
    )).rows[0];
    if (!check) return denied(spoof, { statusCode: 404, error: 'not_found', message: 'Check not found' });
    if (check.status === 'voided') {
      return denied(spoof, { statusCode: 400, error: 'invalid_status', message: 'Voided checks cannot record an external payment' });
    }

    const authz = await authorizeRecorder({
      client,
      userId: mapping.application_user_id,
      tenantId: check.tenant_id,
    });
    if (authz.error) return denied(spoof, { statusCode: 403, ...authz });

    const actorId = mapping.application_user_id;
    const idempotencyKey = clip(body.idempotency_key || body.idempotencyKey, 200)
      || `extpay:${check.id}:${reference}:${amount.toFixed(2)}:${recipientName.toLowerCase()}`;

    const existing = (await client.query(
      `SELECT s.id, s.batch_id, s.amount, s.status, s.external_check_number, s.recipient_name
       FROM public.disbursement_splits s
       JOIN public.disbursement_batches b ON b.id = s.batch_id
       WHERE b.check_intake_item_id = $1::uuid
         AND s.tenant_id = $2::uuid
         AND s.method = 'external_check'
         AND s.status = 'settled'
         AND s.external_check_number = $3::text
         AND s.amount = $4::numeric
         AND lower(s.recipient_name) = lower($5::text)
       LIMIT 1`,
      [check.id, check.tenant_id, reference, amount, recipientName],
    )).rows[0];
    if (existing) {
      return {
        ok: true,
        statusCode: 200,
        data: {
          ok: true,
          check_id: check.id,
          batch_id: existing.batch_id,
          split_id: existing.id,
          amount,
          unchanged: true,
          provider_execution: false,
        },
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        spoofFieldsIgnored: spoof,
        authorizationSource: 'external_payment_recording',
        applicationWorkflowWritesEnabled: true,
        providerExecution: false,
        checkAltInvoked: false,
        moovInvoked: false,
        productionSupabaseChanged: false,
      };
    }

    const funds = await loadCheckFunds(client, { checkId: check.id });
    if (funds.error || !funds.totals) {
      return denied(spoof, {
        statusCode: funds.error === 'not_found' ? 404 : 500,
        error: funds.error || 'funds_summary_failed',
        message: funds.message || 'Could not load remaining funds for this check',
      });
    }
    const available = fundsToCents(funds.totals.available);
    if (amount > available + 0.005) {
      return denied(spoof, {
        statusCode: 400,
        error: 'amount_exceeds_available',
        message: 'Amount exceeds remaining funds on this check',
        available,
      });
    }

    const batch = (await client.query(
      `INSERT INTO public.disbursement_batches (
         tenant_id, check_intake_item_id, created_by, check_amount, available_amount,
         status, notes, completed_at, rail
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5::numeric,
         'completed', $6::text, $7::timestamptz, 'external'
       )
       RETURNING id`,
      [
        check.tenant_id,
        check.id,
        actorId,
        amount,
        amount,
        `External check #${reference} to ${recipientName}`,
        settledAt.toISOString(),
      ],
    )).rows[0];
    if (!batch) return denied(spoof, { error: 'rls_denied', message: 'disbursement batch not writable' });

    const split = (await client.query(
      `INSERT INTO public.disbursement_splits (
         batch_id, tenant_id, amount, status, method, rail,
         external_check_number, recipient_name, recipient_type,
         external_notes, settled_at, idempotence_key
       ) VALUES (
         $1::uuid, $2::uuid, $3::numeric, 'settled', 'external_check', 'external',
         $4::text, $5::text, $6::text,
         $7::text, $8::timestamptz, $9::text
       )
       RETURNING id, amount, status, method, recipient_name, external_check_number`,
      [
        batch.id,
        check.tenant_id,
        amount,
        reference,
        recipientName,
        recipientType,
        notes,
        settledAt.toISOString(),
        idempotencyKey,
      ],
    )).rows[0];
    if (!split) return denied(spoof, { error: 'rls_denied', message: 'disbursement split not writable' });

    const after = (await client.query(
      `SELECT status, check_stage FROM public.check_intake_items WHERE id = $1::uuid`,
      [check.id],
    )).rows[0];

    await client.query(
      `INSERT INTO public.check_audit_log (
         check_id, tenant_id, actor_id, event_type, event_description, event_data
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'external_payment_recorded',
         'External payment recorded (no Moov/ACH execution)',
         $4::jsonb
       )`,
      [
        check.id,
        check.tenant_id,
        actorId,
        JSON.stringify({
          batch_id: batch.id,
          split_id: split.id,
          amount,
          recipient_name: recipientName,
          recipient_type: recipientType,
          external_check_number: reference,
          remaining: toCents(available - amount),
          provider_execution: false,
          moov_invoked: false,
        }),
      ],
    );

    return {
      ok: true,
      statusCode: 200,
      data: {
        ok: true,
        check_id: check.id,
        batch_id: batch.id,
        split_id: split.id,
        amount,
        recipient_name: recipientName,
        recipient_type: recipientType,
        external_check_number: reference,
        remaining: toCents(Math.max(0, available - amount)),
        new_status: after?.status || check.status,
        new_stage: after?.check_stage || check.check_stage,
        actor_id: actorId,
        provider_execution: false,
      },
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: spoof,
      authorizationSource: 'external_payment_recording',
      applicationWorkflowWritesEnabled: true,
      providerExecution: false,
      checkAltInvoked: false,
      moovInvoked: false,
      productionSupabaseChanged: false,
    };
  }, deps);
};
