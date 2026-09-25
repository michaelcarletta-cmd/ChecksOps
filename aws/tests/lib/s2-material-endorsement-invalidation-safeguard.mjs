/**
 * Shared S2 Material Endorsement Invalidation safeguard helpers.
 * Behavioral writer-coupling plus local-copy mutation probes.
 * Does not call AWS, mutate production, or pin a Lambda SHA.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  INVALIDATION_EVENT,
  INVALIDATION_REASON,
  MATERIAL_CHANGE_CATEGORY,
  isMaterialPayeeChange,
} from '../../functions/api/endorsement-material-invalidation.mjs';

export const S2_LABEL = 'S2 Material Endorsement Invalidation';
export const S2_WRITER = 'aws/functions/api/write-check-workflow.mjs';
export const S2_HELPER = 'aws/functions/api/endorsement-material-invalidation.mjs';

export const CHECK_ID = '11111111-1111-4111-8111-111111111111';
export const PAYEE_ID = '22222222-2222-4222-8222-222222222222';
export const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
export const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

export const s2Assert = (condition, message) => {
  if (!condition) {
    const error = new Error(`${S2_LABEL}: ${message}`);
    error.s2 = true;
    throw error;
  }
};

export const readRepo = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const rewriteRelativeImports = (source, fromDir) => source.replace(
  /from\s+['"](\.\/[^'"]+)['"]/g,
  (_all, rel) => `from ${JSON.stringify(pathToFileURL(path.join(fromDir, rel)).href)}`,
);

export const importMutatedWriter = async (root, mutate) => {
  const apiDir = path.join(root, 'aws/functions/api');
  const original = fs.readFileSync(path.join(apiDir, 'write-check-workflow.mjs'), 'utf8');
  const mutated = rewriteRelativeImports(mutate(original), apiDir);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2-writer-'));
  const dest = path.join(dir, 'write-check-workflow.mjs');
  fs.writeFileSync(dest, mutated);
  return import(`${pathToFileURL(dest).href}?t=${Date.now()}-${Math.random()}`);
};

export const importMutatedHelper = async (root, mutate) => {
  const apiDir = path.join(root, 'aws/functions/api');
  const original = fs.readFileSync(path.join(apiDir, 'endorsement-material-invalidation.mjs'), 'utf8');
  const mutated = rewriteRelativeImports(mutate(original), apiDir);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2-helper-'));
  const dest = path.join(dir, 'endorsement-material-invalidation.mjs');
  fs.writeFileSync(dest, mutated);
  return import(`${pathToFileURL(dest).href}?t=${Date.now()}-${Math.random()}`);
};

export const expectS2Failure = async (label, fn) => {
  let failed = false;
  let message = '';
  try {
    await fn();
  } catch (error) {
    failed = true;
    message = String(error?.message || error);
  }
  assert.equal(failed, true, `${S2_LABEL}: expected FAIL for ${label}`);
  assert.match(message, /S2 Material Endorsement Invalidation/, `${S2_LABEL}: failure for ${label} must name S2`);
};

export const payeeUpdateClient = ({
  payee_name = 'Original Payee',
  payee_type = 'insured',
} = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (/FROM public.check_payees p/.test(sql)) {
        return {
          rows: [{
            id: PAYEE_ID,
            check_id: CHECK_ID,
            payee_name,
            payee_type,
            payee_tenant_id: TENANT_ID,
            tenant_id: TENANT_ID,
          }],
        };
      }
      if (/UPDATE public.check_payees/.test(sql) && /SET /.test(sql) && !/endorsement_status/.test(sql)) {
        return {
          rows: [{
            id: PAYEE_ID,
            check_id: CHECK_ID,
            payee_name: params[0] ?? payee_name,
            payee_type: params[1] ?? payee_type,
          }],
        };
      }
      if (/SELECT id, payee_id, payee_name/.test(sql)) {
        return {
          rowCount: 2,
          rows: [
            {
              id: 'endo-signed',
              payee_id: PAYEE_ID,
              payee_name,
              payee_type,
              status: 'signed',
              signed_at: '2026-09-25T00:00:00.000Z',
              signature_image_url: 'checks/111/old-sign.png',
              signature_method: 'portal',
              notes: null,
              created_at: '2026-09-25T00:00:00.000Z',
              updated_at: '2026-09-25T00:01:00.000Z',
            },
            {
              id: 'endo-pending',
              payee_id: PAYEE_ID,
              payee_name: 'CHANGED PAYEE LLC',
              payee_type,
              status: 'pending',
              signed_at: null,
              signature_image_url: null,
              signature_method: 'portal',
              notes: null,
              created_at: '2026-09-25T00:02:00.000Z',
              updated_at: '2026-09-25T00:02:00.000Z',
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
};

export const updatePayee = (execute, client, values) => execute({
  client,
  mapping: { application_user_id: ACTOR_ID },
  table: 'check_payees',
  op: 'update',
  values,
  filters: [{ column: 'id', op: 'eq', value: PAYEE_ID }],
});

const invalidationQueries = (client) => client.queries.filter((row) => (
  /endorsement_invalidated_material_edit/.test(row.sql)
  || /DELETE FROM public.check_endorsements/.test(row.sql)
  || /checkalt_rear_fingerprint/.test(row.sql)
  || /status = 'pending'/.test(row.sql)
));

export const assertInvalidationEffects = (client, { materialField }) => {
  const audit = client.queries.find((row) => (
    new RegExp(INVALIDATION_EVENT).test(row.sql) && /check_audit_log/.test(row.sql)
  ));
  s2Assert(Boolean(audit), 'audit event endorsement_invalidated_material_edit is lost');
  const payload = JSON.parse(audit.params[2]);
  s2Assert(payload.reason === INVALIDATION_REASON, 'invalidation reason drifted');
  s2Assert(payload.material_change_category === MATERIAL_CHANGE_CATEGORY, 'material change category drifted');
  s2Assert(
    Array.isArray(payload.material_fields) && payload.material_fields.includes(materialField),
    `material ${materialField} change stopped invalidating`,
  );
  s2Assert(payload.prior_signature_state?.signed_or_waived_ids?.[0] === 'endo-signed', 'prior signed state was not snapshotted');
  s2Assert(
    client.queries.some((row) => /DELETE FROM public.check_endorsements/.test(row.sql)),
    'duplicate-collapse/signature invalidation behavior is lost',
  );
  s2Assert(
    client.queries.some((row) => /UPDATE public.check_endorsements/.test(row.sql) && /signed_at = NULL/.test(row.sql)),
    'signature invalidation behavior is lost',
  );
  s2Assert(
    client.queries.some((row) => /checkalt_rear_fingerprint/.test(row.sql) && /material_payee_change/.test(row.sql)),
    'official rear fingerprint clearing is lost',
  );
};

export const assertMaterialNameInvalidates = async (execute) => {
  const client = payeeUpdateClient();
  const result = await updatePayee(execute, client, { payee_name: 'CHANGED PAYEE LLC' });
  s2Assert(!result.error, `material payee_name update failed: ${JSON.stringify(result)}`);
  s2Assert(client.queries.some((row) => /UPDATE public.check_payees/.test(row.sql)), 'payee_name writer did not UPDATE');
  assertInvalidationEffects(client, { materialField: 'payee_name' });
};

export const assertMaterialTypeInvalidates = async (execute) => {
  const client = payeeUpdateClient();
  const result = await updatePayee(execute, client, { payee_type: 'mortgage_company' });
  s2Assert(!result.error, `material payee_type update failed: ${JSON.stringify(result)}`);
  assertInvalidationEffects(client, { materialField: 'payee_type' });
};

export const assertNonMaterialDoesNotInvalidate = async (execute) => {
  const client = payeeUpdateClient();
  const result = await updatePayee(execute, client, { contact_email: 'x@example.com' });
  s2Assert(!result.error, `non-material contact update failed: ${JSON.stringify(result)}`);
  s2Assert(
    invalidationQueries(client).length === 0,
    'non-material edits begin invalidating',
  );
};

export const assertWriterCoupling = async (execute) => {
  await assertMaterialNameInvalidates(execute);
  await assertMaterialTypeInvalidates(execute);
  await assertNonMaterialDoesNotInvalidate(execute);
};

export const assertExecutePayeesCallsHelper = (source) => {
  const start = source.indexOf('const executePayees =');
  const end = source.indexOf('const executeEndorsements =');
  s2Assert(start >= 0 && end > start, 'executePayees is missing');
  const body = source.slice(start, end);
  s2Assert(
    body.includes('invalidateEndorsementsForMaterialPayeeChange'),
    'the helper call is removed from executePayees',
  );
  s2Assert(
    body.includes('isMaterialPayeeChange(looked.payee, coerced.values)'),
    'material-change gate is missing from executePayees',
  );
};

export const assertMaterialClassifier = (helper = { isMaterialPayeeChange }) => {
  s2Assert(helper.isMaterialPayeeChange({ payee_name: 'Jane' }, { payee_name: 'Jane LLC' }) === true, 'material payee_name change stopped invalidating');
  s2Assert(helper.isMaterialPayeeChange({ payee_type: 'insured' }, { payee_type: 'mortgage_company' }) === true, 'material payee_type change stopped invalidating');
  s2Assert(helper.isMaterialPayeeChange({ payee_name: 'Jane' }, { payee_name: 'jane' }) === false, 'case-only name edit began invalidating');
  s2Assert(helper.isMaterialPayeeChange({ payee_name: 'Jane' }, { contact_email: 'x@example.com' }) === false, 'non-material edits begin invalidating');
};

const EXECUTE_PAYEES_INVALIDATION = `  if (isMaterialPayeeChange(looked.payee, coerced.values)) {
    await invalidateEndorsementsForMaterialPayeeChange(client, {
      checkId: looked.payee.check_id,
      payeeId: looked.payee.id,
      previousName: looked.payee.payee_name,
      newName: coerced.values.payee_name ?? looked.payee.payee_name,
      previousType: looked.payee.payee_type,
      newType: coerced.values.payee_type ?? looked.payee.payee_type,
      materialFields: materialPayeeFieldsChanged(looked.payee, coerced.values),
      actorId: mapping?.application_user_id || null,
    });
  }`;

export const mutateUnplugExecutePayees = (source) => {
  if (!source.includes(EXECUTE_PAYEES_INVALIDATION)) {
    throw new Error(`${S2_LABEL}: cannot apply executePayees unplug mutation`);
  }
  return source.replace(EXECUTE_PAYEES_INVALIDATION, '');
};

export const mutateNameNeverMaterial = (source) => source.replace(
  `  if (next.payee_name !== undefined && changedText(previous.payee_name, next.payee_name)) {
    return true;
  }`,
  '',
);

export const mutateTypeNeverMaterial = (source) => source.replace(
  `  if (next.payee_type !== undefined && changedText(previous.payee_type, next.payee_type)) {
    return true;
  }`,
  '',
);

export const mutateEverythingMaterial = (source) => source.replace(
  'export const isMaterialPayeeChange = (previous = {}, next = {}) => {',
  'export const isMaterialPayeeChange = (previous = {}, next = {}) => {\n  return true;',
);

const AUDIT_INSERT = `  await client.query(
    \`INSERT INTO public.check_audit_log (
       check_id, tenant_id, actor_id, event_type, event_description, event_data
     ) VALUES (
       $1::uuid,
       (SELECT tenant_id FROM public.check_intake_items WHERE id = $1::uuid),
       $2::uuid,
       'endorsement_invalidated_material_edit',
       'Material payee change invalidated prior endorsement/signature state',
       $3::jsonb
     )\`,`;

const FINGERPRINT_UPDATE = `  await client.query(
    \`UPDATE public.check_intake_items
        SET back_image_deposit_path = NULL,
            endorsement_render_status = 'idle',
            endorsement_render_meta = COALESCE(endorsement_render_meta, '{}'::jsonb)
              - 'checkalt_rear_fingerprint'
              || jsonb_build_object(
                   'invalidated_at', $2::text,
                   'reason', 'material_payee_change',
                   'material_change_category', 'payee_identity'
                 ),
            endorsement_render_version = COALESCE(endorsement_render_version, 0) + 1,
            updated_at = now()
      WHERE id = $1::uuid
        AND deposited_at IS NULL\`,`;

const DUPLICATE_DELETE = `    await client.query(
      \`DELETE FROM public.check_endorsements
        WHERE check_id = $1::uuid
          AND id <> $2::uuid
          AND (
            payee_id = $3::uuid
            OR (
              payee_id IS NULL
              AND (
                ($4::text IS NOT NULL AND lower(trim(payee_name)) = lower(trim($4::text)))
                OR ($5::text IS NOT NULL AND lower(trim(payee_name)) = lower(trim($5::text)))
              )
            )
          )\`,`;

export const mutateDropAuditEvent = (source) => {
  if (!source.includes(AUDIT_INSERT)) {
    throw new Error(`${S2_LABEL}: cannot apply audit-event mutation`);
  }
  return source.replace(AUDIT_INSERT, '  await client.query(`SELECT 1`,');
};

export const mutateDropFingerprintClear = (source) => {
  if (!source.includes(FINGERPRINT_UPDATE)) {
    throw new Error(`${S2_LABEL}: cannot apply fingerprint mutation`);
  }
  return source.replace(FINGERPRINT_UPDATE, '  await client.query(`SELECT 1`,');
};

export const mutateDropDuplicateCollapse = (source) => {
  if (!source.includes(DUPLICATE_DELETE)) {
    throw new Error(`${S2_LABEL}: cannot apply duplicate-collapse mutation`);
  }
  return source.replace(DUPLICATE_DELETE, '    await client.query(`SELECT 1`,');
};
