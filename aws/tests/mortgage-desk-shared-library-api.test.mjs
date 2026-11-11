/**
 * Mortgage Desk shared-check library documents through the API (SQL 156; owner 2026-11-11: "It should be everybody
 * shared on that check"):
 *
 *   - POST /functions/v1/mortgage-desk-esign { action: 'shared_library_documents', request_id } runs as the signed-in
 *     user and calls only public.aws_mortgage_desk_shared_library_documents($1); it never takes the client's tenant;
 *     SQL 156's 42501 not_authorized is a 403; a bad request id never reaches the database; nothing is committed;
 *   - storage.mjs authorizeObject: for tenant-documents, after the request-attachment check, an agent may open a file
 *     public.aws_mortgage_agent_can_read_shared_library_path($1, $2, $3) allows; other buckets never ask it.
 * The functions' own rule is proven on PostgreSQL 16 by aws/tests/sql156-mortgage-desk-shared-check-library-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DESK_SHARED_LIBRARY_DOCUMENTS_SQL,
  MORTGAGE_DESK_ESIGN_ACTIONS,
  handleMortgageDeskEsign,
} from '../functions/api/mortgage-desk-esign.mjs';
import {
  MORTGAGE_LIBRARY_STORAGE_AUTH_SQL,
  MORTGAGE_SHARED_LIBRARY_STORAGE_AUTH_SQL,
  authorizeObject,
} from '../functions/api/storage.mjs';
import { LOOKUP_MAPPING_SQL, USER_ROLES_SQL } from '../functions/api/identity.mjs';

const AGENT = 'a1560000-0000-4000-8000-000000000001';
const COGNITO_SUB = 'c1560000-0000-4000-8000-000000000001';
const REQUEST_ID = 'd1560000-0000-4000-8000-000000000001';
const ROWS = [
  { tenant_id: '11111111-1111-4111-8111-111111111111', tenant_name: 'Owner Co', requesting_tenant: true, doc_type: 'library:mortgage:w9', file_path: 'o/w9.pdf' },
  { tenant_id: '22222222-2222-4222-8222-222222222222', tenant_name: 'Partner Co', requesting_tenant: false, doc_type: 'library:mortgage:contractor_license', file_path: 'p/license.pdf' },
];

const fakeClient = ({ raise = null } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql)) return { rows: [], command: sql };
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: AGENT, cognito_sub: COGNITO_SUB, email: 'agent@checksops.test', status: 'active' }] };
      }
      if (sql === USER_ROLES_SQL) return { rows: [{ role: 'mortgage_agent' }] };
      if (sql === DESK_SHARED_LIBRARY_DOCUMENTS_SQL) {
        if (raise) throw raise;
        return { rows: ROWS };
      }
      return { rows: [] };
    },
  };
};

const event = (body) => ({
  rawPath: '/functions/v1/mortgage-desk-esign',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/functions/v1/mortgage-desk-esign' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'agent@checksops.test', token_use: 'id' } } },
  },
});

const depsFor = (opts) => {
  const clients = [];
  return {
    clients,
    deps: {
      loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => {
        const client = fakeClient(opts);
        clients.push(client);
        return client;
      },
    },
  };
};

test('shared_library_documents: one SQL 156 call with the request id as signed in; rows returned; nothing committed; the client tenant is ignored', async () => {
  assert.ok(MORTGAGE_DESK_ESIGN_ACTIONS.includes('shared_library_documents'));
  assert.equal(DESK_SHARED_LIBRARY_DOCUMENTS_SQL, 'SELECT * FROM public.aws_mortgage_desk_shared_library_documents($1::uuid)');
  const { deps, clients } = depsFor();
  const out = await handleMortgageDeskEsign(event({ action: 'shared_library_documents', request_id: REQUEST_ID, tenant_id: 'spoof' }), deps);
  assert.equal(out.statusCode, 200, JSON.stringify(out));
  const body = typeof out.body === 'string' ? JSON.parse(out.body) : out;
  assert.deepEqual(body.data, ROWS);
  const queries = clients.flatMap((c) => c.queries);
  const calls = queries.filter((q) => q.sql === DESK_SHARED_LIBRARY_DOCUMENTS_SQL);
  assert.deepEqual(calls.map((q) => q.params), [[REQUEST_ID]]);
  assert.ok(!queries.some((q) => q.sql === 'COMMIT'));
  assert.ok(queries.some((q) => q.sql.startsWith('SELECT set_config')), 'runs as the signed-in user');
  assert.doesNotMatch(JSON.stringify(calls), /spoof/);
});

test('shared_library_documents: SQL 156 not_authorized is a 403; a bad request id never reaches the database', async () => {
  const refused = depsFor({ raise: Object.assign(new Error('not_authorized'), { code: '42501' }) });
  const out = await handleMortgageDeskEsign(event({ action: 'shared_library_documents', request_id: REQUEST_ID }), refused.deps);
  assert.equal(out.statusCode, 403);
  assert.match(typeof out.body === 'string' ? out.body : JSON.stringify(out), /not_authorized/);
  const bad = depsFor();
  const badOut = await handleMortgageDeskEsign(event({ action: 'shared_library_documents', request_id: 'nope' }), bad.deps);
  assert.equal(badOut.statusCode, 403);
  assert.equal(bad.clients.flatMap((c) => c.queries).filter((q) => q.sql === DESK_SHARED_LIBRARY_DOCUMENTS_SQL).length, 0);
});

test('storage: tenant-documents asks the SQL 156 path check after the attachment check; other buckets never ask it', async () => {
  assert.match(MORTGAGE_SHARED_LIBRARY_STORAGE_AUTH_SQL, /public\.aws_mortgage_agent_can_read_shared_library_path\(\$1::text\[\], \$2::text, \$3::uuid\)/);
  const asked = [];
  const client = (allow) => ({
    query: async (sql, params) => {
      asked.push(sql);
      if (sql === MORTGAGE_SHARED_LIBRARY_STORAGE_AUTH_SQL) {
        assert.equal(params[2], AGENT);
        return { rows: allow ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
  });
  const ok = await authorizeObject(client(true), 'tenant-documents', 'tenant-documents/p/license.pdf', { userId: AGENT });
  assert.equal(ok.authorized, true);
  assert.equal(ok.via, 'shared_check_library_documents');
  // The existing attachment check runs first.
  assert.ok(asked.indexOf(MORTGAGE_LIBRARY_STORAGE_AUTH_SQL) < asked.indexOf(MORTGAGE_SHARED_LIBRARY_STORAGE_AUTH_SQL));
  assert.equal((await authorizeObject(client(false), 'tenant-documents', 'tenant-documents/p/license.pdf', { userId: AGENT })).authorized, false);
  // No user: never asked.
  asked.length = 0;
  await authorizeObject(client(true), 'tenant-documents', 'tenant-documents/p/license.pdf', {});
  assert.ok(!asked.includes(MORTGAGE_SHARED_LIBRARY_STORAGE_AUTH_SQL));
  // Another bucket: never asked.
  asked.length = 0;
  await authorizeObject(client(true), 'claim-files', 'claim-files/x/y.pdf', { userId: AGENT });
  assert.ok(!asked.includes(MORTGAGE_SHARED_LIBRARY_STORAGE_AUTH_SQL));
});
