import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorizedForMortgageBilling,
  runBillMortgageHandling,
} from '../functions/api/bill-mortgage-handling.mjs';
import { canManageTenantDocumentLibrary } from '../functions/api/mortgage-library-docs.mjs';
import { authorizeStorageWritePath } from '../functions/api/storage-write-auth.mjs';
import { executeTenantDocuments } from '../functions/api/write-app-metadata.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OWNER_A = 'a1000000-0000-4000-8000-000000000001';
const MEMBER_A = 'a1000000-0000-4000-8000-000000000002';
const AGENT = 'a1000000-0000-4000-8000-000000000004';
const ADMIN_A = 'a1000000-0000-4000-8000-000000000009';
const DOC_A = 'b1000000-0000-4000-8000-000000000001';
const REQUEST_A = 'c1000000-0000-4000-8000-000000000001';
const PATH_A = `${TENANT_A}/library/mortgage/w9.pdf`;
const PATH_B = `${TENANT_B}/library/mortgage/w9.pdf`;

const sqlClient = ({ memberships = {}, roles = {}, documents = {} } = {}) => ({
  query: async (sql, params = []) => {
    if (/FROM public\.tenant_users/.test(sql) && /tenant_id = \$2/.test(sql)) {
      const userId = params[0];
      const tenantId = params[1];
      const role = memberships[`${userId}:${tenantId}`];
      return { rows: role ? [{ role }] : [] };
    }
    if (/FROM public\.user_roles/.test(sql)) {
      const list = roles[params[0]] || [];
      return { rows: list.map((role) => ({ role })) };
    }
    if (/is_master_owner|is_platform_owner/.test(sql)) {
      return { rows: [{ is_master: false, is_platform: false }] };
    }
    if (/FROM public\.tenant_documents WHERE id/.test(sql)) {
      const row = documents[params[0]];
      return { rows: row ? [row] : [] };
    }
    if (/INSERT INTO public\.tenant_documents/.test(sql)) {
      return { rows: [{ id: DOC_A, tenant_id: params[0], doc_type: params[1], file_path: params[2] }] };
    }
    if (/DELETE FROM public\.tenant_documents/.test(sql)) {
      return { rows: documents[params[0]] ? [documents[params[0]]] : [] };
    }
    if (/UPDATE public\.tenant_documents/.test(sql)) {
      return { rows: [{ id: params[params.length - 1] }] };
    }
    if (/FROM public\.mortgage_handling_requests/.test(sql)) {
      return { rows: params[0] === REQUEST_A ? [{ id: REQUEST_A, tenant_id: TENANT_A, billing_status: 'unbilled' }] : [] };
    }
    return { rows: [] };
  },
});

test('tenant admins are not Mortgage Desk billing staff', () => {
  assert.equal(authorizedForMortgageBilling(['admin']), false);
  assert.equal(authorizedForMortgageBilling(['staff']), false);
  assert.equal(authorizedForMortgageBilling(['mortgage_agent']), true);
  assert.equal(authorizedForMortgageBilling(['admin', 'mortgage_agent']), true);
  assert.equal(authorizedForMortgageBilling([], { is_master: true }), true);
  assert.equal(authorizedForMortgageBilling(['admin'], { is_platform: true }), true);
});

test('tenant admin cannot bill mortgage handling; agent and owner fail closed', async () => {
  const tenantAdmin = await runBillMortgageHandling({
    mapping: { application_user_id: ADMIN_A },
    body: { request_id: REQUEST_A },
    spoof: {},
    client: sqlClient({ roles: { [ADMIN_A]: ['admin'] } }),
  });
  assert.equal(tenantAdmin.statusCode, 403);
  assert.equal(tenantAdmin.error, 'not_authorized');
  assert.equal(tenantAdmin.billed, false);

  const agent = await runBillMortgageHandling({
    mapping: { application_user_id: AGENT },
    body: { request_id: REQUEST_A },
    spoof: {},
    client: sqlClient({ roles: { [AGENT]: ['mortgage_agent'] } }),
  });
  assert.equal(agent.statusCode, 403);
  assert.equal(agent.error, 'production_execution_blocked');
  assert.equal(agent.liveStripeCalled, false);
  assert.equal(agent.billed, false);

  const ownerClient = sqlClient({ roles: { [OWNER_A]: [] } });
  ownerClient.query = async (sql, params = []) => {
    if (/is_master_owner|is_platform_owner/.test(sql)) {
      return { rows: [{ is_master: true, is_platform: true }] };
    }
    return sqlClient({ roles: { [OWNER_A]: [] } }).query(sql, params);
  };
  const owner = await runBillMortgageHandling({
    mapping: { application_user_id: OWNER_A },
    body: { request_id: REQUEST_A },
    spoof: {},
    client: ownerClient,
  });
  assert.equal(owner.error, 'production_execution_blocked');
});

test('library manage requires tenant owner/admin membership; agents and other tenants are denied', async () => {
  const client = sqlClient({
    memberships: {
      [`${OWNER_A}:${TENANT_A}`]: 'owner',
      [`${MEMBER_A}:${TENANT_A}`]: 'operator',
      [`${ADMIN_A}:${TENANT_A}`]: 'admin',
    },
    roles: {
      [AGENT]: ['mortgage_agent'],
      [MEMBER_A]: ['admin'],
      [OWNER_A]: ['staff'],
      [ADMIN_A]: ['admin'],
    },
  });
  assert.equal(await canManageTenantDocumentLibrary(client, OWNER_A, TENANT_A), true);
  assert.equal(await canManageTenantDocumentLibrary(client, ADMIN_A, TENANT_A), true);
  assert.equal(await canManageTenantDocumentLibrary(client, MEMBER_A, TENANT_A), false);
  assert.equal(await canManageTenantDocumentLibrary(client, AGENT, TENANT_A), false);
  assert.equal(await canManageTenantDocumentLibrary(client, OWNER_A, TENANT_B), false);
});

test('tenant-documents upload and metadata writes stay tenant-manage scoped', async () => {
  const ownerClient = sqlClient({
    memberships: { [`${OWNER_A}:${TENANT_A}`]: 'owner' },
    documents: { [DOC_A]: { id: DOC_A, tenant_id: TENANT_A } },
  });
  const memberClient = sqlClient({
    memberships: { [`${MEMBER_A}:${TENANT_A}`]: 'operator' },
    roles: { [MEMBER_A]: ['admin', 'staff'] },
    documents: { [DOC_A]: { id: DOC_A, tenant_id: TENANT_A } },
  });
  const agentClient = sqlClient({
    roles: { [AGENT]: ['mortgage_agent'] },
    documents: { [DOC_A]: { id: DOC_A, tenant_id: TENANT_A } },
  });

  const ownerUpload = await authorizeStorageWritePath(ownerClient, 'tenant-documents', PATH_A, OWNER_A);
  assert.equal(ownerUpload.ok, true);
  const memberUpload = await authorizeStorageWritePath(memberClient, 'tenant-documents', PATH_A, MEMBER_A);
  assert.equal(memberUpload.ok, false);
  const crossUpload = await authorizeStorageWritePath(ownerClient, 'tenant-documents', PATH_B, OWNER_A);
  assert.equal(crossUpload.ok, false);
  const agentUpload = await authorizeStorageWritePath(agentClient, 'tenant-documents', PATH_A, AGENT);
  assert.equal(agentUpload.ok, false);

  const ownerInsert = await executeTenantDocuments({
    client: ownerClient,
    mapping: { application_user_id: OWNER_A },
    op: 'insert',
    values: { tenant_id: TENANT_A, doc_type: 'library:mortgage:w-9', file_path: PATH_A, file_name: 'W-9' },
    filters: [],
  });
  assert.equal(ownerInsert.rows[0].tenant_id, TENANT_A);

  const memberInsert = await executeTenantDocuments({
    client: memberClient,
    mapping: { application_user_id: MEMBER_A },
    op: 'insert',
    values: { tenant_id: TENANT_A, doc_type: 'library:mortgage:w-9', file_path: PATH_A, file_name: 'W-9' },
    filters: [],
  });
  assert.equal(memberInsert.error, 'not_authorized');

  const crossInsert = await executeTenantDocuments({
    client: ownerClient,
    mapping: { application_user_id: OWNER_A },
    op: 'insert',
    values: { tenant_id: TENANT_B, doc_type: 'library:mortgage:w-9', file_path: PATH_B, file_name: 'W-9' },
    filters: [],
  });
  assert.equal(crossInsert.error, 'not_authorized');

  const memberDelete = await executeTenantDocuments({
    client: memberClient,
    mapping: { application_user_id: MEMBER_A },
    op: 'delete',
    values: {},
    filters: [{ column: 'id', op: 'eq', value: DOC_A }],
  });
  assert.equal(memberDelete.error, 'not_authorized');

  const agentDelete = await executeTenantDocuments({
    client: agentClient,
    mapping: { application_user_id: AGENT },
    op: 'delete',
    values: {},
    filters: [{ column: 'id', op: 'eq', value: DOC_A }],
  });
  assert.equal(agentDelete.error, 'not_authorized');
});
