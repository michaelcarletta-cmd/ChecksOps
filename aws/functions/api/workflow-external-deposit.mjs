/**
 * Dedicated AWS path for recording an already-completed external/manual deposit.
 *
 * Distinct from CheckAlt provider deposit and from generic deposit_action.
 * Does not enable mark_manual_deposit on /data/rpc. Never calls CheckAlt/Moov.
 *
 * Historical mark_manual_deposit side effects that survive here:
 * - deposit_items.status = succeeded, provider = manual_branch, cleared_at
 * - check_intake_items.status = deposited (trigger may set deposited_at)
 * - check_stage = deposited (AWS queue/lock completeness; historical SQL omitted stage)
 * - deposit_audit_log + check_audit_log
 *
 * Not performed: CheckAlt submit, provider HTTP, NSF, bank_confirm, reconcile.
 */
import { ignoredSpoof, IS_PLATFORM_OWNER_SQL, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';
import { applicationWorkflowWritesEnabled } from './workflow-flags.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isUuid = (value) => UUID_RE.test(String(value || ''));

const MASTER_OWNER_SQL = 'SELECT public.is_master_owner() AS is_master';
const RECORDABLE_STATUSES = new Set([
  'approved_for_deposit',
  'branch_deposit_required',
  'endorsements_complete',
]);
const RECORDABLE_ITEM_STATUSES = new Set([
  'pending_assignment',
  'provider_assigned',
]);
const ALLOWED_BODY = new Set([
  'check_id',
  'checkId',
  'p_check_id',
  'id',
  'deposit_item_id',
  'depositItemId',
  'p_deposit_item_id',
  'notes',
  'p_notes',
  'deposit_date',
  'depositDate',
  'p_deposit_date',
  'deposit_slip_number',
  'depositSlipNumber',
  'p_deposit_slip_number',
  'amount',
  'p_amount',
  'bank_reference',
  'bankReference',
  'p_bank_reference',
  'reason',
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

export const EXTERNAL_DEPOSIT_PROVIDER = 'manual_branch';

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
    return { error: 'cross_tenant', message: 'Cross-tenant external deposit recording is rejected' };
  }
  const allowed = ['admin', 'owner', 'staff', 'manager'];
  if (!allowed.some((role) => platformRoles.has(role) || tenantRoles.has(role))) {
    return { error: 'not_authorized', message: 'Staff, manager, or admin required to record an external deposit' };
  }
  return { ok: true, platformOwner: false };
};

const clip = (value, max) => {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
};

const toCents = (value) => Math.round((Number(value) || 0) * 100) / 100;

export const handleExternalDeposit = async (event, deps = {}) => {
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
        message: 'External deposit accepts only an explicit field allowlist',
        deniedFields: unknown,
      });
    }

    let checkId = body.check_id || body.checkId || body.p_check_id || body.id;
    const depositItemId = body.deposit_item_id || body.depositItemId || body.p_deposit_item_id;
    const notes = clip(body.notes || body.p_notes, 2000);
    const slip = clip(body.deposit_slip_number || body.depositSlipNumber || body.p_deposit_slip_number, 80);
    const bankReference = clip(body.bank_reference || body.bankReference || body.p_bank_reference, 80);
    const depositDateRaw = body.deposit_date || body.depositDate || body.p_deposit_date;
    let clearedAt = new Date();
    if (depositDateRaw != null && depositDateRaw !== '') {
      const text = String(depositDateRaw);
      if (DATE_RE.test(text)) clearedAt = new Date(`${text}T12:00:00.000Z`);
      else {
        const parsed = new Date(text);
        if (Number.isNaN(parsed.getTime())) {
          return denied(spoof, { statusCode: 400, error: 'invalid_field', field: 'deposit_date' });
        }
        clearedAt = parsed;
      }
    }

    let item = null;
    if (depositItemId) {
      if (!isUuid(depositItemId)) return denied(spoof, { statusCode: 400, error: 'invalid_uuid', field: 'deposit_item_id' });
      item = (await client.query(
        `SELECT di.id, di.status, di.amount, di.check_id, di.provider, di.batch_id, di.cleared_at,
                ci.id AS intake_id, ci.tenant_id, ci.status AS check_status, ci.check_stage,
                ci.amount AS check_amount, ci.check_number, ci.carrier_name, ci.claim_id, ci.deposited_at
         FROM public.deposit_items di
         JOIN public.check_intake_items ci ON ci.id = di.check_id
         WHERE di.id = $1::uuid
         FOR UPDATE OF di, ci`,
        [depositItemId],
      )).rows[0];
      if (!item) return denied(spoof, { statusCode: 404, error: 'not_found', message: 'Deposit item not found' });
      checkId = item.check_id;
    }

    if (!isUuid(checkId)) return denied(spoof, { statusCode: 400, error: 'invalid_uuid', field: 'check_id' });

    const check = item ? {
      id: item.intake_id,
      tenant_id: item.tenant_id,
      status: item.check_status,
      check_stage: item.check_stage,
      amount: item.check_amount,
      check_number: item.check_number,
      carrier_name: item.carrier_name,
      claim_id: item.claim_id,
      deposited_at: item.deposited_at,
    } : (await client.query(
      `SELECT id, tenant_id, status, check_stage, amount, check_number, carrier_name, claim_id, deposited_at
       FROM public.check_intake_items
       WHERE id = $1::uuid
       FOR UPDATE`,
      [checkId],
    )).rows[0];
    if (!check) return denied(spoof, { statusCode: 404, error: 'not_found', message: 'Check not found' });

    if (body.amount != null && body.amount !== '') {
      const provided = toCents(body.amount);
      if (!Number.isFinite(provided) || provided <= 0) {
        return denied(spoof, { statusCode: 400, error: 'invalid_field', field: 'amount' });
      }
      if (check.amount != null && Math.abs(provided - toCents(check.amount)) > 0.005) {
        return denied(spoof, {
          statusCode: 400,
          error: 'amount_mismatch',
          message: 'Recorded deposit amount must match the check amount',
        });
      }
    }

    const authz = await authorizeRecorder({
      client,
      userId: mapping.application_user_id,
      tenantId: check.tenant_id,
    });
    if (authz.error) return denied(spoof, { statusCode: 403, ...authz });

    if (!item) {
      item = (await client.query(
        `SELECT id, status, amount, check_id, provider, batch_id, cleared_at
         FROM public.deposit_items
         WHERE check_id = $1::uuid
         FOR UPDATE`,
        [check.id],
      )).rows[0] || null;
    }

    const alreadyRecorded = (check.status === 'deposited' || check.check_stage === 'deposited' || check.deposited_at)
      && item && (item.status === 'succeeded' || item.status === 'reconciled');
    if (alreadyRecorded) {
      return {
        ok: true,
        statusCode: 200,
        data: {
          ok: true,
          check_id: check.id,
          deposit_item_id: item.id,
          new_status: check.status,
          new_stage: check.check_stage,
          provider: item.provider || EXTERNAL_DEPOSIT_PROVIDER,
          unchanged: true,
          provider_execution: false,
        },
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        spoofFieldsIgnored: spoof,
        authorizationSource: 'external_deposit_recording',
        applicationWorkflowWritesEnabled: true,
        providerExecution: false,
        checkAltInvoked: false,
        moovInvoked: false,
        productionSupabaseChanged: false,
      };
    }

    if (check.status === 'voided') {
      return denied(spoof, { statusCode: 400, error: 'invalid_status', message: 'Voided checks cannot record an external deposit' });
    }
    const itemAllows = item && RECORDABLE_ITEM_STATUSES.has(item.status);
    if (!RECORDABLE_STATUSES.has(check.status) && !itemAllows) {
      return denied(spoof, {
        statusCode: 400,
        error: 'invalid_status',
        message: `Check must be approved for deposit (or have a prepared manual deposit item), got: ${check.status}`,
      });
    }

    const actorId = mapping.application_user_id;
    const amount = item?.amount ?? check.amount ?? 0;

    if (!item) {
      item = (await client.query(
        `INSERT INTO public.deposit_items (check_id, amount, check_number, carrier_name, claim_id, provider, status)
         VALUES ($1::uuid, $2::numeric, $3::text, $4::text, $5::uuid, $6::public.deposit_provider, 'pending_assignment')
         RETURNING id, status, amount, check_id, provider, batch_id, cleared_at`,
        [check.id, amount, check.check_number, check.carrier_name, check.claim_id, EXTERNAL_DEPOSIT_PROVIDER],
      )).rows[0];
    }

    let batchId = item.batch_id;
    if (!batchId) {
      await client.query('SAVEPOINT external_deposit_batch');
      try {
        batchId = (await client.query(
          `INSERT INTO public.deposit_batches (provider, total_items, total_amount, created_by)
           VALUES ($1::public.deposit_provider, 1, $2::numeric, $3::uuid)
           RETURNING id`,
          [EXTERNAL_DEPOSIT_PROVIDER, amount, actorId],
        )).rows[0]?.id;
        await client.query('RELEASE SAVEPOINT external_deposit_batch');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT external_deposit_batch');
        const code = String(error?.code || '');
        const message = String(error?.message || error);
        if (code !== '42501' && !/row-level security|permission denied/i.test(message)) {
          throw error;
        }
        batchId = null;
      }
    }

    const updatedItem = (await client.query(
      `UPDATE public.deposit_items
       SET status = 'succeeded',
           provider = $2::public.deposit_provider,
           batch_id = COALESCE($3::uuid, batch_id),
           cleared_at = $4::timestamptz,
           deposit_slip_number = COALESCE($5::text, deposit_slip_number),
           bank_reference = COALESCE($6::text, bank_reference),
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id, status, provider, batch_id, cleared_at, amount`,
      [item.id, EXTERNAL_DEPOSIT_PROVIDER, batchId, clearedAt.toISOString(), slip, bankReference],
    )).rows[0];
    if (!updatedItem) return denied(spoof, { error: 'rls_denied', message: 'deposit item not writable' });

    if (batchId) {
      await client.query(
        `UPDATE public.deposit_batches
         SET cleared_amount = cleared_amount + $2::numeric, updated_at = now()
         WHERE id = $1::uuid`,
        [batchId, updatedItem.amount],
      );
    }

    const updatedCheck = (await client.query(
      `UPDATE public.check_intake_items
       SET status = 'deposited',
           check_stage = 'deposited'::public.check_stage,
           updated_at = now()
       WHERE id = $1::uuid
       RETURNING id, tenant_id, status, check_stage, deposited_at, amount`,
      [check.id],
    )).rows[0];
    if (!updatedCheck) return denied(spoof, { error: 'rls_denied', message: 'check not writable' });

    let claimChecksMirrored = false;
    await client.query('SAVEPOINT external_deposit_claim_mirror');
    try {
      await client.query(
        `UPDATE public.claim_checks
         SET check_stage = 'deposited'::public.check_stage, updated_at = now()
         WHERE check_intake_item_id = $1::uuid`,
        [check.id],
      );
      await client.query('RELEASE SAVEPOINT external_deposit_claim_mirror');
      claimChecksMirrored = true;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT external_deposit_claim_mirror');
      const code = String(error?.code || '');
      const message = String(error?.message || error);
      if (code !== '42501' && !/permission denied for (table|relation) claim_checks/i.test(message)) {
        throw error;
      }
    }

    await client.query(
      `INSERT INTO public.deposit_audit_log (deposit_item_id, batch_id, action, actor_id, amount, notes, new_values)
       VALUES ($1::uuid, $2::uuid, 'external_deposit_recorded', $3::uuid, $4::numeric, $5::text, $6::jsonb)`,
      [
        updatedItem.id,
        batchId,
        actorId,
        updatedItem.amount,
        notes,
        JSON.stringify({
          provider: EXTERNAL_DEPOSIT_PROVIDER,
          deposit_slip_number: slip,
          bank_reference: bankReference,
          check_alt_invoked: false,
        }),
      ],
    );
    await client.query(
      `INSERT INTO public.check_audit_log (
         check_id, tenant_id, actor_id, event_type, event_description, event_data
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'external_deposit_recorded',
         'External/manual deposit recorded (no CheckAlt execution)',
         $4::jsonb
       )`,
      [
        check.id,
        check.tenant_id,
        actorId,
        JSON.stringify({
          deposit_item_id: updatedItem.id,
          previous_status: check.status,
          new_status: updatedCheck.status,
          new_stage: updatedCheck.check_stage,
          provider: EXTERNAL_DEPOSIT_PROVIDER,
          provider_execution: false,
        }),
      ],
    );

    return {
      ok: true,
      statusCode: 200,
      data: {
        ok: true,
        check_id: check.id,
        deposit_item_id: updatedItem.id,
        new_status: updatedCheck.status,
        new_stage: updatedCheck.check_stage,
        deposited_at: updatedCheck.deposited_at,
        provider: EXTERNAL_DEPOSIT_PROVIDER,
        amount: updatedItem.amount,
        actor_id: actorId,
        claim_checks_mirrored: claimChecksMirrored,
        provider_execution: false,
      },
      applicationUserId: mapping.application_user_id,
      authUid: mapping.application_user_id,
      cognitoSub: claims.sub,
      spoofFieldsIgnored: spoof,
      authorizationSource: 'external_deposit_recording',
      applicationWorkflowWritesEnabled: true,
      providerExecution: false,
      checkAltInvoked: false,
      moovInvoked: false,
      productionSupabaseChanged: false,
    };
  }, deps);
};
