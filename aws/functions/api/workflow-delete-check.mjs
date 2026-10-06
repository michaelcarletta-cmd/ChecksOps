/**
 * Accepted Delete Check workflow for AWS staging.
 *
 * Invoked by AdminDeleteCheckButton → admin_delete_check RPC bridge →
 * DELETE /workflow/checks/:id. This is the same authority the working
 * Admin tools path already uses. It does not invent a second deletion backend.
 *
 * Invariants (delete-check-contract):
 * - platform admin only
 * - reason min 3 trimmed characters
 * - claim linkage alone does not block
 * - partner/shared and terminal financial states block
 * - deposit/provider/disbursement rows block
 * - non-financial dependents are cleaned
 * - check_deletion_log audit
 * - check-scoped S3 cleanup after successful DB delete (skipped when storage writes are off)
 */
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { ignoredSpoof, parseBody, withIdentity, withIdentityWrite } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';
import { applicationWorkflowWritesEnabled } from './workflow-flags.mjs';
import { storageWritesEnabled } from './write-allowlist.mjs';
import { isPartnerLinked, isTerminalFinancial } from './workflow-transitions.mjs';
import { isCheckScopedPathFor, normalizePath, s3KeyFor } from './storage-paths.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CHECK_DELETE_KEYS = 2000;

const isUuid = (value) => UUID_RE.test(String(value || ''));

const clip = (value, max) => {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text.length > max) return { error: 'invalid_field', field: 'length' };
  const trimmed = text.trim();
  return trimmed.length ? trimmed : null;
};

const denied = (spoof, extra) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  spoofFieldsIgnored: spoof,
  applicationWorkflowWritesEnabled: applicationWorkflowWritesEnabled(),
  ...extra,
});

const okResult = ({ mapping, claims, spoof, data, extra = {} }) => ({
  ok: true,
  statusCode: 200,
  data,
  applicationUserId: mapping.application_user_id,
  authUid: mapping.application_user_id,
  cognitoSub: claims.sub,
  spoofFieldsIgnored: spoof,
  authorizationSource: 'rls',
  applicationWorkflowWritesEnabled: true,
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

const filesBucket = () => process.env.FILES_BUCKET || '';
const s3Region = () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const defaultS3 = (deps) => deps.s3 || new S3Client({ region: s3Region() });

const platformRolesOf = async (client, userId) => {
  const rows = (await client.query(USER_ROLES_SQL, [userId])).rows;
  return new Set(rows.map((row) => String(row.role || '').toLowerCase()));
};

const lookupWorkflowCheck = async (client, checkId) => {
  if (!isUuid(checkId)) return { error: 'invalid_uuid', field: 'check_id' };
  const rows = (await client.query(
    `SELECT id, tenant_id, uploaded_by, status, check_stage, claim_id, deposited_at,
            external_origin, partner_status, carrier_name, review_notes, amount,
            check_number
     FROM public.check_intake_items
     WHERE id = $1::uuid`,
    [checkId],
  )).rows;
  if (!rows.length) return { error: 'rls_denied', message: 'check not found or not writable' };
  return { check: rows[0] };
};

export const FINANCIAL_DELETE_BLOCKERS = Object.freeze([
  { table: 'deposit_items', sql: 'SELECT 1 FROM public.deposit_items WHERE check_id = $1::uuid LIMIT 1' },
  { table: 'checkalt_deposits', sql: 'SELECT 1 FROM public.checkalt_deposits WHERE check_intake_item_id = $1::uuid LIMIT 1' },
  { table: 'disbursement_batches', sql: 'SELECT 1 FROM public.disbursement_batches WHERE check_intake_item_id = $1::uuid LIMIT 1' },
  { table: 'claim_check_payments', sql: 'SELECT 1 FROM public.claim_check_payments WHERE check_intake_item_id = $1::uuid LIMIT 1' },
  { table: 'check_billing_events', sql: 'SELECT 1 FROM public.check_billing_events WHERE check_intake_item_id = $1::uuid LIMIT 1' },
  { table: 'check_payment_directions', sql: 'SELECT 1 FROM public.check_payment_directions WHERE check_id = $1::uuid LIMIT 1' },
]);

const listKeysByPrefix = async (deps, prefix) => {
  const s3 = defaultS3(deps);
  const bucket = filesBucket();
  if (!bucket) {
    const error = new Error('s3_not_configured');
    error.name = 'S3NotConfigured';
    throw error;
  }
  const keys = [];
  let token = undefined;
  while (true) {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const obj of out.Contents || []) {
      if (obj?.Key) keys.push(obj.Key);
      if (keys.length > MAX_CHECK_DELETE_KEYS) {
        const error = new Error('too_many_objects');
        error.name = 'TooManyObjects';
        error.prefix = prefix;
        error.count = keys.length;
        throw error;
      }
    }
    if (!out.IsTruncated) break;
    token = out.NextContinuationToken;
    if (!token) break;
  }
  return keys;
};

const deleteKeys = async (deps, keys) => {
  const s3 = defaultS3(deps);
  const bucket = filesBucket();
  if (!bucket) return { ok: false, error: 's3_not_configured' };
  const errors = [];
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const out = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Quiet: true,
        Objects: batch.map((Key) => ({ Key })),
      },
    }));
    deleted += (out.Deleted || []).length;
    for (const err of out.Errors || []) {
      errors.push({
        key: err.Key || null,
        code: err.Code || null,
        message: err.Message || null,
      });
    }
    if (errors.length) break;
  }
  if (errors.length) return { ok: false, error: 'storage_delete_failed', deleted, errors };
  return { ok: true, deleted, errors: [] };
};

const collectCheckOwnedStorageKeys = async (client, checkId) => {
  const row = (await client.query(
    `SELECT id, tenant_id,
            front_image_path, back_image_path, back_image_original_path, back_image_deposit_path,
            endorsement_packet_path
       FROM public.check_intake_items
      WHERE id = $1::uuid
      LIMIT 1`,
    [checkId],
  )).rows[0];
  if (!row) return { error: 'rls_denied', message: 'check not found or not writable' };

  const tenantId = row.tenant_id;
  const keys = new Set();
  const addClaimFilesPath = (value) => {
    const rel = normalizePath(value, 'claim-files');
    if (!rel) return;
    if (!isCheckScopedPathFor(rel, checkId)) return;
    const key = s3KeyFor('claim-files', rel);
    if (key) keys.add(key);
  };

  addClaimFilesPath(row.front_image_path);
  addClaimFilesPath(row.back_image_path);
  addClaimFilesPath(row.back_image_original_path);
  addClaimFilesPath(row.back_image_deposit_path);

  const fileRows = (await client.query(
    'SELECT file_path FROM public.check_files WHERE check_intake_item_id = $1::uuid',
    [checkId],
  )).rows;
  for (const f of fileRows) addClaimFilesPath(f.file_path);

  const payeeRows = (await client.query(
    'SELECT endorsement_image_path FROM public.check_payees WHERE check_id = $1::uuid',
    [checkId],
  )).rows;
  for (const p of payeeRows) addClaimFilesPath(p.endorsement_image_path);

  const endorsementRows = (await client.query(
    'SELECT signature_image_url FROM public.check_endorsements WHERE check_id = $1::uuid',
    [checkId],
  )).rows;
  for (const e of endorsementRows) addClaimFilesPath(e.signature_image_url);

  const packetRaw = row.endorsement_packet_path;
  if (packetRaw && tenantId) {
    const tenantLower = String(tenantId).toLowerCase();
    const idLower = String(checkId).toLowerCase();
    const relClaim = normalizePath(packetRaw, 'claim-files');
    if (relClaim && String(relClaim).toLowerCase().startsWith(`endorsement-packets/${tenantLower}/${idLower}`)) {
      const key = s3KeyFor('claim-files', relClaim);
      if (key) keys.add(key);
    }
    const relPackets = normalizePath(packetRaw, 'endorsement-packets');
    if (relPackets && String(relPackets).toLowerCase().startsWith(`${tenantLower}/${idLower}`)) {
      const key = s3KeyFor('endorsement-packets', relPackets);
      if (key) keys.add(key);
    }
  }

  return { tenantId, keys: [...keys] };
};

const runWithSavepoint = async (client, name, fn) => {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* ignore */ }
    try { await client.query(`RELEASE SAVEPOINT ${name}`); } catch { /* ignore */ }
    throw error;
  }
};

const deleteNonFinancialChildren = async (client, checkId) => {
  await client.query('DELETE FROM public.check_endorsement_events WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_endorsements WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_payees WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_messages WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_files WHERE check_intake_item_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_message_reads WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_audit_log WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.mortgage_handling_requests WHERE check_intake_item_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_review_decisions WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_reissue_requests WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.check_eligibility_results WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.shared_checks WHERE check_id = $1::uuid', [checkId]);
  await client.query('DELETE FROM public.claim_checks WHERE check_intake_item_id = $1::uuid', [checkId]);
  await client.query(
    'UPDATE public.claim_payments SET check_intake_item_id = NULL WHERE check_intake_item_id = $1::uuid',
    [checkId],
  );
};

const planCheckScopedStorageKeys = async (client, deps, check) => {
  if (deps.disableS3Cleanup === true) return { keys: [], skipped: true, reason: 'disabled' };
  const storageEnabled = deps.forceStorageWrites === true || storageWritesEnabled();
  if (!storageEnabled || !filesBucket()) {
    return { keys: [], skipped: true, reason: storageEnabled ? 's3_not_configured' : 'storage_writes_disabled' };
  }

  const collected = await collectCheckOwnedStorageKeys(client, check.id);
  if (collected.error) return collected;

  const keySet = new Set(collected.keys);
  const checkIdText = String(check.id);
  for (const relPrefix of [
    `checks/${checkIdText}/`,
    `checks/reupload/${checkIdText}/`,
    `check-intake/${checkIdText}/files/`,
  ]) {
    const found = await listKeysByPrefix(deps, `files/claim-files/${relPrefix}`);
    for (const k of found) {
      const rel = String(k).replace(/^files\/claim-files\//, '');
      if (isCheckScopedPathFor(rel, check.id)) keySet.add(k);
    }
  }
  if (collected.tenantId) {
    const tenantId = String(collected.tenantId);
    for (const prefixKey of [
      `files/claim-files/endorsement-packets/${tenantId}/${checkIdText}`,
      `files/endorsement-packets/${tenantId}/${checkIdText}`,
    ]) {
      const found = await listKeysByPrefix(deps, prefixKey);
      for (const k of found) keySet.add(k);
    }
  }
  return { keys: [...keySet], skipped: false };
};

export const handleDeleteCheck = async (event, deps = {}) => {
  const gate = requireWorkflowEnabled(event, deps);
  if (gate.blocked) {
    return withIdentity(event, async () => gate.blocked, deps);
  }

  let plannedStorageKeys = [];

  const result = await withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (body.sql || body.query || body.rawSql) {
      return denied(spoof, { error: 'generic_sql_denied' });
    }
    const roles = await platformRolesOf(client, mapping.application_user_id);
    if (!roles.has('admin')) {
      return denied(spoof, { error: 'not_authorized', message: 'Only admins can delete checks' });
    }
    const checkId = body.check_id || body.checkId || body.id
      || String(event?.rawPath || '').split('/').filter(Boolean).pop();
    const reason = clip(body.reason || body.p_reason || body.delete_reason, 2000);
    if (reason && reason.error) {
      return denied(spoof, { statusCode: 400, ...reason });
    }
    if (!reason || String(reason).length < 3) {
      return denied(spoof, {
        statusCode: 400,
        error: 'missing_required_field',
        field: 'reason',
        message: 'A deletion reason (min 3 characters) is required',
      });
    }
    const looked = await lookupWorkflowCheck(client, checkId);
    if (looked.error) {
      return denied(spoof, { statusCode: looked.error === 'invalid_uuid' ? 400 : 403, ...looked });
    }
    if (isPartnerLinked(looked.check) || isTerminalFinancial(looked.check)) {
      return denied(spoof, {
        error: 'cleanup_denied',
        message: 'Refusing to delete a partner-linked or deposited check',
      });
    }

    for (const [idx, blocker] of FINANCIAL_DELETE_BLOCKERS.entries()) {
      try {
        const blocked = await runWithSavepoint(client, `delete_blocker_${idx}`, async () => {
          const rows = (await client.query(blocker.sql, [looked.check.id])).rows;
          return rows.length > 0;
        });
        if (blocked) {
          return denied(spoof, {
            error: 'cleanup_denied',
            message: `Refusing to delete a check with dependent financial/provider records (${blocker.table})`,
            blocker: blocker.table,
          });
        }
      } catch (error) {
        if (error?.code === '42P01') continue;
        if (error?.code === '42501') {
          return denied(spoof, {
            error: 'cleanup_denied',
            message: `Refusing to delete: unable to verify financial/provider blockers (${blocker.table})`,
            blocker: blocker.table,
          });
        }
        throw error;
      }
    }

    const planned = await planCheckScopedStorageKeys(client, deps, looked.check);
    if (planned.error) {
      return denied(spoof, { statusCode: 403, ...planned });
    }
    plannedStorageKeys = planned.keys || [];

    await client.query('SAVEPOINT delete_audit_snapshot');
    try {
      const exists = (await client.query("SELECT to_regclass('public.check_deletion_log') AS t")).rows[0]?.t;
      if (exists) {
        const row = (await client.query(
          'SELECT * FROM public.check_intake_items WHERE id = $1::uuid',
          [looked.check.id],
        )).rows[0];
        if (row) {
          await client.query(
            `INSERT INTO public.check_deletion_log
              (check_id, claim_id, check_number, amount, status, reason, deleted_by, snapshot)
             VALUES ($1::uuid, $2::uuid, $3::text, $4::numeric, $5::text, $6::text, $7::uuid, $8::jsonb)`,
            [
              looked.check.id,
              row.claim_id ?? null,
              row.check_number ?? null,
              row.amount ?? null,
              row.status ?? null,
              String(reason),
              mapping.application_user_id,
              JSON.stringify(row),
            ],
          );
        }
      }
      if (looked.check.claim_id) {
        await client.query(
          `INSERT INTO public.claim_audit_log (claim_id, actor_id, event_type, event_description, event_data)
           VALUES (
             $1::uuid, $2::uuid, 'check_deleted_by_admin',
             $3::text, $4::jsonb
           )`,
          [
            looked.check.claim_id,
            mapping.application_user_id,
            `Admin deleted check #${looked.check.check_number || looked.check.id} — Reason: ${reason}`,
            JSON.stringify({
              check_id: looked.check.id,
              check_number: looked.check.check_number ?? null,
              reason: String(reason),
            }),
          ],
        );
      }
      await client.query('RELEASE SAVEPOINT delete_audit_snapshot');
    } catch {
      try { await client.query('ROLLBACK TO SAVEPOINT delete_audit_snapshot'); } catch { /* ignore */ }
      try { await client.query('RELEASE SAVEPOINT delete_audit_snapshot'); } catch { /* ignore */ }
    }

    await client.query('SAVEPOINT delete_unlink_loss_draft');
    try {
      await client.query(
        'UPDATE public.loss_draft_tracking SET check_intake_item_id = NULL WHERE check_intake_item_id = $1::uuid',
        [looked.check.id],
      );
      await client.query('RELEASE SAVEPOINT delete_unlink_loss_draft');
    } catch (error) {
      try { await client.query('ROLLBACK TO SAVEPOINT delete_unlink_loss_draft'); } catch { /* ignore */ }
      try { await client.query('RELEASE SAVEPOINT delete_unlink_loss_draft'); } catch { /* ignore */ }
      if (error?.code === '42P01') {
        // table absent
      } else if (error?.code === '42501') {
        const claimed = (await client.query(
          'SELECT 1 FROM public.loss_draft_tracking WHERE check_intake_item_id = $1::uuid AND claim_id IS NOT NULL LIMIT 1',
          [looked.check.id],
        )).rows;
        if (claimed.length) {
          return denied(spoof, {
            error: 'cleanup_denied',
            message: 'Refusing to delete a check with claim-owned loss draft tracking',
            blocker: 'loss_draft_tracking',
          });
        }
        await client.query(
          'DELETE FROM public.loss_draft_tracking WHERE check_intake_item_id = $1::uuid AND claim_id IS NULL',
          [looked.check.id],
        );
      } else {
        throw error;
      }
    }

    await deleteNonFinancialChildren(client, looked.check.id);
    const rows = (await client.query(
      'DELETE FROM public.check_intake_items WHERE id = $1::uuid RETURNING id',
      [looked.check.id],
    )).rows;
    if (!rows.length) return denied(spoof, { error: 'rls_denied', message: 'check not deletable' });
    return okResult({
      mapping,
      claims,
      spoof,
      data: { id: looked.check.id, deleted: true },
      extra: {
        cleanedUp: true,
        claimLinkageDidNotBlock: Boolean(looked.check.claim_id),
        storageCleanup: deps.disableS3Cleanup === true || planned.skipped
          ? { ok: true, deleted: 0, skipped: true, reason: planned.reason || 'disabled' }
          : { ok: true, deleted: 0, skipped: plannedStorageKeys.length === 0, planned: plannedStorageKeys.length },
      },
    });
  }, deps);

  if (!result?.ok || deps.disableS3Cleanup === true) return result;
  if (!plannedStorageKeys.length) {
    result.storageCleanup = result.storageCleanup || { ok: true, deleted: 0, skipped: true };
    return result;
  }

  try {
    const deleted = await deleteKeys(deps, plannedStorageKeys);
    if (!deleted.ok) {
      result.storageCleanup = {
        ok: false,
        error: deleted.error || 'storage_delete_failed',
        deleted: deleted.deleted || 0,
        errors: (deleted.errors || []).slice(0, 10),
        attempted: Math.min(plannedStorageKeys.length, 50),
      };
      return result;
    }
    result.storageCleanup = { ok: true, deleted: deleted.deleted, skipped: false };
    return result;
  } catch (error) {
    result.storageCleanup = {
      ok: false,
      error: error?.name === 'S3NotConfigured' ? 's3_not_configured' : 'storage_delete_failed',
      message: error?.message || 'storage cleanup failed',
    };
    return result;
  }
};
