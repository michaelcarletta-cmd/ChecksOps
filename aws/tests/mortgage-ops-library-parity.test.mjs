import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import { executeAppMetadataWrite } from '../functions/api/write-app-metadata.mjs';
import { executeAllowlistedWrite, handleWrite } from '../functions/api/write.mjs';
import { authorizeObject, handleStorageSign } from '../functions/api/storage.mjs';
import { normalizePath, pathCandidates } from '../functions/api/storage-paths.mjs';
import {
  MORTGAGE_LIBRARY_DOC_PREFIX,
  MORTGAGE_LIBRARY_STORAGE_AUTH_SQL,
  isApprovedMortgageLibraryDocType,
  qualifyingMortgageLibraryDocsForTenant,
  executeMortgageRequestLibraryDocuments,
} from '../functions/api/mortgage-library-docs.mjs';
import {
  MORTGAGE_OPS_LIBRARY_PARITY_SQL,
  MORTGAGE_OPS_LIBRARY_PARITY_REQUIRED_BEFORE,
} from '../rls/oneshot/mortgage-ops-library-parity-order.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const MEMBER_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const DOC_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_DOC_ID = '44444444-4444-4444-8444-444444444444';
const TEMPLATE_DOC_ID = '55555555-5555-4555-8555-555555555555';
const OPEN_REQ = '66666666-6666-4666-8666-666666666666';
const CLOSED_REQ = '77777777-7777-4777-8777-777777777777';
const CANCELLED_REQ = '88888888-8888-4888-8888-888888888888';
const MISSING_REQ = '99999999-9999-4999-8999-999999999999';
const ATTACH_PATH = `${TENANT}/library/mortgage/w9.pdf`;
const TEMPLATE_PATH = `${TENANT}/library/template/tpa.pdf`;
const FORGED_KEY = `${TENANT}/verification/kyc-passport.pdf`;
const OTHER_PATH = `${OTHER_TENANT}/library/mortgage/w9.pdf`;

const mortgageDoc = {
  id: DOC_ID,
  tenant_id: TENANT,
  doc_type: 'library:mortgage:w-9',
  file_name: 'W-9',
  file_path: ATTACH_PATH,
  mime_type: 'application/pdf',
  file_size: 1200,
  auto_share_mortgage_ops: true,
};
const templateDoc = {
  ...mortgageDoc,
  id: TEMPLATE_DOC_ID,
  doc_type: 'library:template:tpa',
  file_path: TEMPLATE_PATH,
  file_name: 'TPA',
};
const otherTenantDoc = {
  ...mortgageDoc,
  id: OTHER_DOC_ID,
  tenant_id: OTHER_TENANT,
  file_path: OTHER_PATH,
};

const openRequest = { id: OPEN_REQ, tenant_id: TENANT, status: 'requested', assigned_employee_id: null };
const closedRequest = { id: CLOSED_REQ, tenant_id: TENANT, status: 'completed', assigned_employee_id: null };
const cancelledRequest = { id: CANCELLED_REQ, tenant_id: TENANT, status: 'cancelled', assigned_employee_id: null };

const readSql = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const overlaySql = () => readSql('rls/sql/29_mortgage_ops_library_parity.sql');
const migrationSql = () => readSql('../supabase/migrations/20260911210000_aws_mortgage_ops_library_parity.sql');

const functionBody = (sql, name) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  assert.ok(start >= 0, name);
  const revoke = sql.indexOf(`REVOKE ALL ON FUNCTION public.${name}`, start);
  assert.ok(revoke > start, `immediate revoke missing for ${name}`);
  return sql.slice(start, revoke);
};

test('approved Mortgage Ops category is only library:mortgage:%', () => {
  assert.equal(MORTGAGE_LIBRARY_DOC_PREFIX, 'library:mortgage:');
  assert.equal(isApprovedMortgageLibraryDocType('library:mortgage:w-9'), true);
  assert.equal(isApprovedMortgageLibraryDocType('library:mortgage:contractor-license'), true);
  assert.equal(isApprovedMortgageLibraryDocType('library:template:tpa'), false);
  assert.equal(isApprovedMortgageLibraryDocType('library:shingle:oakridge'), false);
  assert.equal(isApprovedMortgageLibraryDocType('library:siding:vinyl'), false);
  assert.equal(isApprovedMortgageLibraryDocType('library:catalog:roofing'), false);
  assert.equal(isApprovedMortgageLibraryDocType('library:letterhead:logo'), false);
  assert.equal(isApprovedMortgageLibraryDocType('verification'), false);
  assert.equal(isApprovedMortgageLibraryDocType('library:mortgage:evil'), false);
  assert.equal(isApprovedMortgageLibraryDocType('library:mortgage:license'), false);
  assert.equal(isApprovedMortgageLibraryDocType('library:mortgage:closing'), false);
  const overlay = overlaySql();
  const lovable = readSql('../supabase/migrations/20260830190318_06a7b3a3-9dcf-4298-9db7-fda095678bc5.sql');
  assert.match(overlay, /td\.doc_type LIKE 'library:mortgage:%'/);
  assert.match(lovable, /td\.doc_type LIKE 'library:mortgage:%'/);
  assert.equal(WRITE_ALLOWLIST.mortgage_request_library_documents.ops.has('upsert'), true);
  assert.equal(WRITE_ALLOWLIST.mortgage_request_library_documents.ops.has('update'), false);
  assert.equal(WRITE_ALLOWLIST.mortgage_request_library_documents.ops.has('delete'), false);
});

test('oneshot applies 29 only after write helpers and complete write policies', () => {
  const complete = fs.readFileSync(path.join(ROOT, 'rls/oneshot/completeAuth.mjs'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'rls/oneshot/index.mjs'), 'utf8');
  const writePlan = fs.readFileSync(path.join(ROOT, 'rls/oneshot/writePlan.mjs'), 'utf8');
  const applied = [...complete.matchAll(/readSql\('([^']+\.sql)'\)/g)].map((match) => match[1]);
  const idx29 = applied.indexOf(MORTGAGE_OPS_LIBRARY_PARITY_SQL);
  assert.ok(idx29 > 0, 'completeAuth must apply 29');
  for (const dep of MORTGAGE_OPS_LIBRARY_PARITY_REQUIRED_BEFORE) {
    const idx = applied.indexOf(dep);
    assert.ok(idx >= 0 && idx < idx29, `${dep} must precede ${MORTGAGE_OPS_LIBRARY_PARITY_SQL}`);
  }
  assert.doesNotMatch(index, /applySql\('29_mortgage_ops_library_parity\.sql'\)/);
  assert.doesNotMatch(writePlan, /29_mortgage_ops_library_parity\.sql'\)/);
  assert.match(writePlan, /Do not apply 29_mortgage_ops_library_parity/);
  assert.match(index, /Do not apply 29 from ddl/);
  assert.equal(applied.includes('30_tenant_documents_mortgage_doc_type.sql'), false);
  assert.doesNotMatch(complete, /readSql\('30_tenant_documents_mortgage_doc_type\.sql'\)/);
  assert.match(index, /Do not apply 30_tenant_documents_mortgage_doc_type/);
  assert.match(complete, /Do not apply it from completeAuth/);
  assert.equal(applied.includes('31_mortgage_ops_agent_access.sql'), false);
  assert.doesNotMatch(complete, /readSql\('31_mortgage_ops_agent_access\.sql'\)/);
  assert.match(complete, /Do not apply 31_mortgage_ops_agent_access/);
  assert.match(index, /Do not apply 31_mortgage_ops_agent_access/);
  assert.match(writePlan, /Do not apply 31_mortgage_ops_agent_access/);
  for (const name of [
    '69_staging_homeowner_ledger_view.sql',
    '71_endorsement_email_audit.sql',
    '72_public_endorsement_token_lookup.sql',
    '73_public_endorsement_submit_payee.sql',
  ]) {
    assert.equal(applied.includes(name), false, `completeAuth must not apply ${name}`);
    assert.doesNotMatch(complete, new RegExp(`readSql\\('${name.replace('.', '\\.')}'\\)`));
    assert.doesNotMatch(index, new RegExp(`applySql\\('${name.replace('.', '\\.')}'\\)`));
    assert.doesNotMatch(writePlan, new RegExp(`readSql\\('${name.replace('.', '\\.')}'\\)`));
  }
  assert.match(complete, /Do not apply 69\/71\/72\/73/);
  assert.match(index, /Do not apply 69\/71\/72\/73/);
  assert.match(writePlan, /Do not apply 69\/71\/72\/73/);
});

test('SQL overlay revokes PUBLIC immediately, requires mortgage category, and uses exact paths', () => {
  const overlay = overlaySql();
  const migration = migrationSql();
  const sql24 = readSql('rls/sql/24_complete_write_policies.sql');
  const generator = readSql('rls/scripts/generate_complete_write_policies.py');
  for (const sql of [overlay, migration]) {
    const docFn = functionBody(sql, 'aws_mortgage_agent_can_read_library_document');
    const pathFn = functionBody(sql, 'aws_mortgage_agent_can_read_library_path');
    const manageFn = functionBody(sql, 'aws_can_manage_mortgage_library');
    const insertFn = functionBody(sql, 'aws_can_insert_mortgage_library_document');
    assert.match(docFn, /td\.doc_type LIKE 'library:mortgage:%'/);
    assert.match(pathFn, /td\.doc_type LIKE 'library:mortgage:%'/);
    assert.match(docFn, /JOIN public\.tenant_documents td/);
    assert.match(pathFn, /JOIN public\.tenant_documents td/);
    assert.doesNotMatch(pathFn, /LIKE '%' \|\|/);
    assert.doesNotMatch(pathFn, /LIKE '%'\s*\|\|/);
    assert.match(pathFn, /split_part\(d\.file_path, '\?', 1\) = _rel/);
    assert.match(pathFn, /d\.file_path = ANY/);
    assert.match(pathFn, /auth\.uid\(\) = _user_id/);
    assert.match(pathFn, /has_role\(_user_id, 'mortgage_agent'/);
    assert.match(pathFn, /status IN \('requested', 'in_progress'\)/);
    assert.doesNotMatch(pathFn, /CHR\s*\(\s*0\s*\)/i);
    assert.doesNotMatch(pathFn, /E'\\0/);
    assert.doesNotMatch(pathFn, /U&'\\0000'/);
    assert.doesNotMatch(sql, /position\s*\(\s*CHR\s*\(\s*0\s*\)/i);
    assert.match(sql, /FOR INSERT TO authenticated/);
    assert.match(
      sql,
      /WITH CHECK \(\s*public\.aws_can_insert_mortgage_library_document\(\s*tenant_id,\s*request_id,\s*tenant_document_id,\s*file_path\s*\)\s*\)/,
    );
    assert.doesNotMatch(sql, /WITH CHECK \(public\.aws_can_manage_mortgage_library\(tenant_id\)\)/);
    assert.doesNotMatch(sql, /CREATE POLICY aws_write_mortgage_request_library_documents[\s\S]{0,400}FOR ALL TO authenticated/);
    assert.match(manageFn, /aws_can_write_tenant/);
    assert.match(manageFn, /auth\.uid\(\)/);
    assert.match(insertFn, /SECURITY DEFINER/);
    assert.match(insertFn, /SET search_path = public/);
    assert.match(insertFn, /SET row_security = off/);
    assert.match(insertFn, /aws_can_manage_mortgage_library/);
    assert.match(insertFn, /FROM public\.mortgage_handling_requests mr/);
    assert.match(insertFn, /FROM public\.tenant_documents td/);
    assert.match(insertFn, /_request_status IS DISTINCT FROM 'requested'/);
    assert.match(insertFn, /_request_status IS DISTINCT FROM 'in_progress'/);
    assert.match(insertFn, /_doc_auto_share IS DISTINCT FROM true/);
    assert.match(insertFn, /_doc_type NOT LIKE 'library:mortgage:%'/);
    assert.match(insertFn, /_file_path IS DISTINCT FROM _doc_file_path/);
    assert.match(insertFn, /_tenant_document_id IS NULL/);
    assert.doesNotMatch(insertFn, /user_metadata/);
    assert.doesNotMatch(insertFn, /request\.jwt\.claim\.role/);
    assert.match(sql, /DROP POLICY IF EXISTS "manage shared library docs"/);
    assert.match(sql, /DROP POLICY IF EXISTS "delete shared library docs"/);
    assert.match(sql, /REVOKE UPDATE, DELETE ON TABLE public\.mortgage_request_library_documents FROM authenticated/);
    assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.mortgage_request_library_documents TO authenticated/);
  }
  assert.match(overlay, /GRANT EXECUTE[\s\S]*TO checksops, authenticated/);
  assert.match(overlay, /REVOKE UPDATE, DELETE ON TABLE public\.mortgage_request_library_documents FROM checksops/);
  assert.doesNotMatch(migration, /TO checksops, authenticated/);
  assert.match(migration, /Grant difference is intentional/);
  assert.match(sql24, /DROP POLICY IF EXISTS aws_write_mortgage_request_library_documents ON public.mortgage_request_library_documents;/);
  assert.doesNotMatch(sql24, /CREATE POLICY aws_write_mortgage_request_library_documents/);
  assert.match(sql24, /CREATE POLICY aws_write_mortgage_handling_requests ON public.mortgage_handling_requests\s+FOR ALL TO authenticated/);
  assert.match(generator, /FAIL_CLOSED_DROP_ONLY_TABLES = frozenset\(\{"mortgage_request_library_documents"\}\)/);
  const oneshot = readSql('rls/oneshot/index.mjs');
  assert.match(oneshot, /'aws_can_insert_mortgage_library_document'/);
});

test('new active request receives only qualifying auto-share documents', () => {
  const attached = qualifyingMortgageLibraryDocsForTenant([
    mortgageDoc,
    { ...mortgageDoc, id: 'd2', auto_share_mortgage_ops: false, doc_type: 'library:mortgage:license' },
    templateDoc,
    otherTenantDoc,
  ], TENANT);
  assert.deepEqual(attached.map((d) => d.id), [DOC_ID]);
});

const libraryClient = ({
  actorRole = 'admin',
  tenantRole = 'admin',
  member = true,
  memberships = null,
  documents = { [DOC_ID]: mortgageDoc },
  requests = {
    [OPEN_REQ]: openRequest,
    [CLOSED_REQ]: closedRequest,
    [CANCELLED_REQ]: cancelledRequest,
  },
  existing = [],
  insertConflict = false,
} = {}) => {
  const queries = [];
  let inserts = 0;
  const roleForTenant = (tenantId) => {
    if (memberships) return memberships[tenantId] || null;
    if (!member || tenantId !== TENANT) return null;
    return tenantRole;
  };
  return {
    queries,
    inserts: () => inserts,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM public.tenant_documents/.test(sql)) {
        return { rows: documents[params[0]] ? [documents[params[0]]] : [] };
      }
      if (/FROM public.tenant_users/.test(sql)) {
        const role = roleForTenant(params[1]);
        return role ? { rows: [{ role }] } : { rows: [] };
      }
      if (/FROM public.user_roles/.test(sql)) {
        return actorRole ? { rows: [{ role: actorRole }] } : { rows: [] };
      }
      if (/FROM public.mortgage_handling_requests/.test(sql)) {
        return { rows: requests[params[0]] ? [requests[params[0]]] : [] };
      }
      if (/INSERT INTO public.mortgage_request_library_documents/.test(sql)) {
        inserts += 1;
        if (insertConflict) return { rows: [] };
        return {
          rows: [{
            id: 'attach-1',
            request_id: params[0],
            tenant_id: params[1],
            tenant_document_id: params[2],
            doc_type: params[3],
            file_path: params[5],
          }],
        };
      }
      if (/FROM public.mortgage_request_library_documents/.test(sql) && /file_path/.test(sql)) {
        return { rows: existing };
      }
      return { rows: [] };
    },
  };
};

const allowlisted = (client, body) => executeAllowlistedWrite({
  client,
  mapping: { application_user_id: ADMIN_ID },
  body,
  checkWorkflowEnabled: true,
  applicationWorkflowEnabled: true,
});

test('existing active request receives authorized backfill', async () => {
  const client = libraryClient();
  const result = await executeMortgageRequestLibraryDocuments({
    client,
    mapping: { application_user_id: ADMIN_ID },
    op: 'upsert',
    values: { request_id: OPEN_REQ, tenant_document_id: DOC_ID, tenant_id: OTHER_TENANT, file_path: FORGED_KEY },
  });
  assert.equal(result.rows[0].tenant_id, TENANT);
  assert.equal(result.rows[0].file_path, ATTACH_PATH);
  assert.equal(result.rows[0].doc_type, 'library:mortgage:w-9');
  assert.equal(client.inserts(), 1);
});

test('duplicate backfill is idempotent', async () => {
  const client = libraryClient({
    insertConflict: true,
    existing: [{ id: 'attach-1', request_id: OPEN_REQ, file_path: ATTACH_PATH }],
  });
  const result = await executeMortgageRequestLibraryDocuments({
    client,
    mapping: { application_user_id: ADMIN_ID },
    op: 'insert',
    values: { request_id: OPEN_REQ, tenant_document_id: DOC_ID },
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.rows[0].id, 'attach-1');
  assert.match(client.queries.find((q) => /ON CONFLICT \(request_id, file_path\) DO NOTHING/.test(q.sql)).sql, /ON CONFLICT/);
});

test('ordinary tenant member cannot perform an admin backfill', async () => {
  const client = libraryClient({ actorRole: null, tenantRole: 'operator', member: true });
  const result = await executeMortgageRequestLibraryDocuments({
    client,
    mapping: { application_user_id: MEMBER_ID },
    op: 'upsert',
    values: { request_id: OPEN_REQ, tenant_document_id: DOC_ID },
  });
  assert.equal(result.error, 'not_authorized');
});

test('user_roles.admin plus ordinary membership cannot backfill tenant library docs', async () => {
  const client = libraryClient({ actorRole: 'admin', tenantRole: 'operator', member: true });
  const result = await executeMortgageRequestLibraryDocuments({
    client,
    mapping: { application_user_id: MEMBER_ID },
    op: 'upsert',
    values: { request_id: OPEN_REQ, tenant_document_id: DOC_ID },
  });
  assert.equal(result.error, 'not_authorized');
});

test('non-mortgage categories are rejected', async () => {
  const client = libraryClient({ documents: { [TEMPLATE_DOC_ID]: templateDoc } });
  const result = await executeMortgageRequestLibraryDocuments({
    client,
    mapping: { application_user_id: ADMIN_ID },
    op: 'upsert',
    values: { request_id: OPEN_REQ, tenant_document_id: TEMPLATE_DOC_ID },
  });
  assert.equal(result.error, 'category_not_allowlisted');
  assert.equal(result.allowed_prefix, 'library:mortgage:');
});

test('closed requests do not provide new document access', async () => {
  const client = libraryClient();
  const result = await executeMortgageRequestLibraryDocuments({
    client,
    mapping: { application_user_id: ADMIN_ID },
    op: 'upsert',
    values: { request_id: CLOSED_REQ, tenant_document_id: DOC_ID },
  });
  assert.equal(result.error, 'request_not_open');
  assert.equal(client.inserts(), 0);
});

test('forged document id from another tenant is rejected', async () => {
  const client = libraryClient({
    documents: { [OTHER_DOC_ID]: otherTenantDoc },
    requests: { [OPEN_REQ]: openRequest },
  });
  const result = await executeMortgageRequestLibraryDocuments({
    client,
    mapping: { application_user_id: ADMIN_ID },
    op: 'upsert',
    values: { request_id: OPEN_REQ, tenant_document_id: OTHER_DOC_ID, tenant_id: TENANT },
  });
  assert.equal(result.error, 'not_authorized');
});

test('missing or invalid authentication is denied', async () => {
  const write = await handleWrite({
    rawPath: '/data/write',
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/data/write' } },
    body: JSON.stringify({
      table: 'mortgage_request_library_documents',
      op: 'upsert',
      values: { request_id: OPEN_REQ, tenant_document_id: DOC_ID },
    }),
  });
  assert.equal(write.statusCode, 401);

  const sign = await handleStorageSign({
    rawPath: '/storage/sign',
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/storage/sign' } },
    body: JSON.stringify({ bucket: 'tenant-documents', path: ATTACH_PATH }),
  });
  assert.equal(sign.statusCode, 401);
});

test('write path is disabled without identity mapping via allowlist authz', async () => {
  const denied = await executeAppMetadataWrite({
    client: libraryClient({ member: false, actorRole: null }),
    mapping: { application_user_id: ADMIN_ID },
    table: 'mortgage_request_library_documents',
    op: 'upsert',
    values: { request_id: OPEN_REQ, tenant_document_id: DOC_ID },
    filters: [],
  });
  assert.equal(denied.error, 'not_authorized');
});

test('executeAllowlistedWrite denies update, delete, aliases, and batches', async () => {
  const client = libraryClient();
  const values = { request_id: OPEN_REQ, tenant_document_id: DOC_ID };
  const update = await allowlisted(client, { table: 'mortgage_request_library_documents', op: 'update', values });
  assert.equal(update.error, 'operation_not_allowlisted');
  const del = await allowlisted(client, { table: 'mortgage_request_library_documents', op: 'delete', values });
  assert.equal(del.error, 'operation_not_allowlisted');
  const viaOperation = await allowlisted(client, {
    table: 'mortgage_request_library_documents',
    operation: 'delete',
    values,
  });
  assert.equal(viaOperation.error, 'operation_not_allowlisted');
  const viaUpdateAlias = await allowlisted(client, {
    table: 'mortgage_request_library_documents',
    operation: 'update',
    values,
  });
  assert.equal(viaUpdateAlias.error, 'operation_not_allowlisted');
  const batch = await allowlisted(client, {
    table: 'mortgage_request_library_documents',
    op: 'upsert',
    values: [values, { request_id: CLOSED_REQ, tenant_document_id: DOC_ID }],
  });
  assert.equal(batch.error, 'batch_writes_disabled');
  assert.equal(client.inserts(), 0);
});

test('executeAllowlistedWrite ignores forged tenant_id and file_path', async () => {
  const client = libraryClient();
  const result = await allowlisted(client, {
    table: 'mortgage_request_library_documents',
    op: 'upsert',
    values: {
      request_id: OPEN_REQ,
      tenant_document_id: DOC_ID,
      tenant_id: OTHER_TENANT,
      file_path: FORGED_KEY,
      doc_type: 'library:template:tpa',
    },
  });
  assert.equal(result.rows[0].tenant_id, TENANT);
  assert.equal(result.rows[0].file_path, ATTACH_PATH);
  assert.equal(result.rows[0].doc_type, 'library:mortgage:w-9');
});

test('executeAllowlistedWrite denies forged request/document combinations', async () => {
  const missingReq = await allowlisted(libraryClient(), {
    table: 'mortgage_request_library_documents',
    op: 'insert',
    values: { request_id: MISSING_REQ, tenant_document_id: DOC_ID },
  });
  assert.equal(missingReq.error, 'rls_denied');

  const missingDoc = await allowlisted(libraryClient(), {
    table: 'mortgage_request_library_documents',
    op: 'insert',
    values: { request_id: OPEN_REQ, tenant_document_id: MISSING_REQ },
  });
  assert.equal(missingDoc.error, 'rls_denied');
});

test('dual-tenant administrator cannot attach across tenants', async () => {
  const client = libraryClient({
    memberships: { [TENANT]: 'admin', [OTHER_TENANT]: 'admin' },
    documents: { [OTHER_DOC_ID]: otherTenantDoc },
  });
  const result = await allowlisted(client, {
    table: 'mortgage_request_library_documents',
    op: 'upsert',
    values: { request_id: OPEN_REQ, tenant_document_id: OTHER_DOC_ID, tenant_id: TENANT },
  });
  assert.equal(result.error, 'tenant_mismatch');
  assert.equal(client.inserts(), 0);
});

test('cancelled and completed requests reject backfill through the allowlist', async () => {
  const cancelled = await allowlisted(libraryClient(), {
    table: 'mortgage_request_library_documents',
    op: 'upsert',
    values: { request_id: CANCELLED_REQ, tenant_document_id: DOC_ID },
  });
  assert.equal(cancelled.error, 'request_not_open');
  const completed = await allowlisted(libraryClient(), {
    table: 'mortgage_request_library_documents',
    op: 'insert',
    values: { request_id: CLOSED_REQ, tenant_document_id: DOC_ID },
  });
  assert.equal(completed.error, 'request_not_open');
});

test('non-mortgage legacy attachment category is rejected through the allowlist', async () => {
  const result = await allowlisted(libraryClient({ documents: { [TEMPLATE_DOC_ID]: templateDoc } }), {
    table: 'mortgage_request_library_documents',
    op: 'upsert',
    values: { request_id: OPEN_REQ, tenant_document_id: TEMPLATE_DOC_ID },
  });
  assert.equal(result.error, 'category_not_allowlisted');
});

const pathIsExactAttachment = (params, attachmentPath) => {
  const candidates = params[0] || [];
  const rel = params[1];
  if (rel === attachmentPath) return true;
  return Array.isArray(candidates) && candidates.includes(attachmentPath);
};

const storageClient = ({ tenantDoc = false, attachment = null }) => ({
  query: async (sql, params) => {
    if (sql.includes('FROM tenant_documents') || sql.includes('FROM public.tenant_documents')) {
      return { rows: tenantDoc ? [{ '?column?': 1 }] : [] };
    }
    if (String(sql).includes('aws_mortgage_agent_can_read_library_path')) {
      if (!attachment) return { rows: [] };
      if (params[2] !== attachment.userId) return { rows: [] };
      if (!pathIsExactAttachment(params, attachment.path)) return { rows: [] };
      return { rows: [{ '?column?': 1 }] };
    }
    return { rows: [] };
  },
});

test('mortgage agent can read an attached qualifying document', async () => {
  const result = await authorizeObject(
    storageClient({ attachment: { userId: AGENT_ID, path: ATTACH_PATH } }),
    'tenant-documents',
    ATTACH_PATH,
    { userId: AGENT_ID },
  );
  assert.equal(result.authorized, true);
  assert.equal(result.via, 'mortgage_request_library_documents');
});

test('mortgage agent cannot read an unattached document', async () => {
  const result = await authorizeObject(
    storageClient({ attachment: { userId: AGENT_ID, path: ATTACH_PATH } }),
    'tenant-documents',
    TEMPLATE_PATH,
    { userId: AGENT_ID },
  );
  assert.equal(result.authorized, false);
});

test('mortgage agent cannot read another tenant document through a forged object key', async () => {
  const attached = await authorizeObject(
    storageClient({ attachment: { userId: AGENT_ID, path: ATTACH_PATH } }),
    'tenant-documents',
    FORGED_KEY,
    { userId: AGENT_ID },
  );
  assert.equal(attached.authorized, false);
  const otherTenant = await authorizeObject(
    storageClient({ attachment: { userId: AGENT_ID, path: ATTACH_PATH } }),
    'tenant-documents',
    OTHER_PATH,
    { userId: AGENT_ID },
  );
  assert.equal(otherTenant.authorized, false);
});

test('wildcard, suffix, and traversal object paths are not authorized', async () => {
  const client = storageClient({ attachment: { userId: AGENT_ID, path: ATTACH_PATH } });
  const denied = async (objectPath) => {
    const result = await authorizeObject(client, 'tenant-documents', objectPath, { userId: AGENT_ID });
    assert.equal(result.authorized, false, objectPath);
  };
  await denied('%');
  await denied('_');
  await denied('w9.pdf');
  await denied(`library/mortgage/w9.pdf`);
  await denied(OTHER_PATH);
  await denied(`${TENANT}/library/mortgage/%`);
  await denied(`${TENANT}/library/mortgage/_9.pdf`);
  await denied(`${TENANT}/library/mortgage/w9.pdf/../kyc-passport.pdf`);
  const encodedUrl = 'https://example.invalid/storage/v1/object/sign/tenant-documents/%2e%2e/secret';
  assert.equal(normalizePath(encodedUrl, 'tenant-documents'), null);
  await denied(encodedUrl);
});

test('query-string variants of the exact attached key remain authorized', async () => {
  const result = await authorizeObject(
    storageClient({ attachment: { userId: AGENT_ID, path: ATTACH_PATH } }),
    'tenant-documents',
    `${ATTACH_PATH}?token=abc`,
    { userId: AGENT_ID },
  );
  assert.equal(result.authorized, true);
  assert.equal(result.rel, ATTACH_PATH);
  assert.ok(pathCandidates('tenant-documents', `${ATTACH_PATH}?token=abc`).includes(ATTACH_PATH));
});

test('same filename in a different tenant folder is denied', async () => {
  const result = await authorizeObject(
    storageClient({ attachment: { userId: AGENT_ID, path: ATTACH_PATH } }),
    'tenant-documents',
    OTHER_PATH,
    { userId: AGENT_ID },
  );
  assert.equal(result.authorized, false);
});

test('storage auth SQL requires an attachment, exact path, and open or assigned request', () => {
  assert.match(MORTGAGE_LIBRARY_STORAGE_AUTH_SQL, /aws_mortgage_agent_can_read_library_path\(\$1::text\[\], \$2::text, \$3::uuid\)/);
  assert.doesNotMatch(MORTGAGE_LIBRARY_STORAGE_AUTH_SQL, /LIKE/);
  const overlay = overlaySql();
  assert.match(overlay, /CREATE OR REPLACE FUNCTION public\.aws_mortgage_agent_can_read_library_path/);
  assert.match(overlay, /SET row_security = off/);
  assert.match(overlay, /mortgage_request_library_documents d/);
  assert.match(overlay, /mortgage_handling_requests r/);
  assert.match(overlay, /has_role\(_user_id, 'mortgage_agent'/);
  assert.match(overlay, /auth\.uid\(\) = _user_id/);
  assert.match(overlay, /status IN \('requested', 'in_progress'\)/);
  const pathFn = functionBody(overlay, 'aws_mortgage_agent_can_read_library_path');
  assert.doesNotMatch(pathFn, /LIKE '%' \|\|/);
  assert.doesNotMatch(pathFn, /CHR\s*\(\s*0\s*\)/i);
});
