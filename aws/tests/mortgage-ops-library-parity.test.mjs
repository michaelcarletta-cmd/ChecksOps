import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';
import { executeAppMetadataWrite } from '../functions/api/write-app-metadata.mjs';
import { executeAllowlistedWrite, handleWrite } from '../functions/api/write.mjs';
import { authorizeObject, handleStorageSign } from '../functions/api/storage.mjs';
import {
  MORTGAGE_LIBRARY_DOC_PREFIX,
  MORTGAGE_LIBRARY_STORAGE_AUTH_SQL,
  isApprovedMortgageLibraryDocType,
  qualifyingMortgageLibraryDocsForTenant,
  executeMortgageRequestLibraryDocuments,
} from '../functions/api/mortgage-library-docs.mjs';

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

const readSql = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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
  const overlay = readSql('rls/sql/29_mortgage_ops_library_parity.sql');
  const lovable = readSql('../supabase/migrations/20260830190318_06a7b3a3-9dcf-4298-9db7-fda095678bc5.sql');
  assert.match(overlay, /td\.doc_type LIKE 'library:mortgage:%'/);
  assert.match(lovable, /td\.doc_type LIKE 'library:mortgage:%'/);
  assert.equal(WRITE_ALLOWLIST.mortgage_request_library_documents.ops.has('upsert'), true);
  assert.equal(WRITE_ALLOWLIST.mortgage_request_library_documents.ops.has('delete'), false);
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
  documents = { [DOC_ID]: mortgageDoc },
  requests = { [OPEN_REQ]: openRequest, [CLOSED_REQ]: closedRequest },
  existing = [],
  insertConflict = false,
} = {}) => {
  const queries = [];
  let inserts = 0;
  return {
    queries,
    inserts: () => inserts,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM public.tenant_documents/.test(sql)) {
        return { rows: documents[params[0]] ? [documents[params[0]]] : [] };
      }
      if (/FROM public.tenant_users/.test(sql)) {
        if (!member || params[1] !== TENANT) return { rows: [] };
        return { rows: [{ role: tenantRole }] };
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

const storageClient = ({ tenantDoc = false, attachment = null }) => ({
  query: async (sql, params) => {
    if (sql.includes('FROM tenant_documents') || sql.includes('FROM public.tenant_documents')) {
      return { rows: tenantDoc ? [{ '?column?': 1 }] : [] };
    }
    if (String(sql).includes('aws_mortgage_agent_can_read_library_path')) {
      if (!attachment) return { rows: [] };
      if (params[2] !== attachment.userId) return { rows: [] };
      const rel = params[1];
      if (rel !== attachment.path) return { rows: [] };
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

test('storage auth SQL requires an attachment and open or assigned request', () => {
  assert.match(MORTGAGE_LIBRARY_STORAGE_AUTH_SQL, /aws_mortgage_agent_can_read_library_path\(\$1::text\[\], \$2::text, \$3::uuid\)/);
  assert.doesNotMatch(MORTGAGE_LIBRARY_STORAGE_AUTH_SQL, /FROM public\.tenant_documents/);
  const overlay = readSql('rls/sql/29_mortgage_ops_library_parity.sql');
  assert.match(overlay, /CREATE OR REPLACE FUNCTION public\.aws_mortgage_agent_can_read_library_path/);
  assert.match(overlay, /SET row_security = off/);
  assert.match(overlay, /mortgage_request_library_documents d/);
  assert.match(overlay, /mortgage_handling_requests r/);
  assert.match(overlay, /has_role\(_user_id, 'mortgage_agent'/);
  assert.match(overlay, /auth\.uid\(\) = _user_id/);
  assert.match(overlay, /status IN \('requested', 'in_progress'\)/);
  const pathFn = overlay.slice(
    overlay.indexOf('aws_mortgage_agent_can_read_library_path('),
    overlay.indexOf('COMMENT ON FUNCTION public.aws_mortgage_agent_can_read_library_path'),
  );
  assert.doesNotMatch(pathFn, /tenant_documents/);
});
