import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleDataRpc } from '../functions/api/data.mjs';
import { handleWrite } from '../functions/api/write.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { resolveTrustedIdentityScope } from '../functions/api/identity-env.mjs';
import {
  CLAIM_SETTLEMENT_VALUE_COLUMNS,
  SAVE_CLAIM_SETTLEMENT_SQL,
} from '../functions/api/claim-settlement-rpc.mjs';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLIENT_PATH = path.join(ROOT, 'src/integrations/aws/client.ts');
const SQL_PATH = path.join(ROOT, 'aws/workflows/sql/53_claim_settlement_breakdown.sql');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CLAIM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SETTLEMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const VALUES = Object.fromEntries(CLAIM_SETTLEMENT_VALUE_COLUMNS.map((column, index) => [column, index + 1]));

const jwtEvent = (pathName, body) => ({
  rawPath: pathName,
  headers: { authorization: '******' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: pathName },
    authorizer: {
      jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mockClient = ({ mapping = true, result = { ok: true, code: 'saved', settlement: { id: SETTLEMENT_ID } } } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'COMMIT', 'SET TRANSACTION READ WRITE'].includes(sql)) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: mapping ? [{
            application_user_id: APP_ID,
            cognito_sub: COGNITO_SUB,
            email: 'checksops-tester@freedomadj.com',
            status: 'active',
          }] : [],
        };
      }
      if (sql === SAVE_CLAIM_SETTLEMENT_SQL) return { rows: [{ result }] };
      return { rows: [] };
    },
  };
};

const depsFor = (client) => ({
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
  identityScope: resolveTrustedIdentityScope({
    checksopsEnv: 'staging',
    userPoolId: 'us-east-1_vPmQ7cL1F',
  }),
  forceEnabled: true,
});

test('dedicated save RPC is dispatched before generic RPC and persists insert/update values', async () => {
  const previous = process.env.AWS_WRITES_ENABLED;
  process.env.AWS_WRITES_ENABLED = 'true';
  try {
    for (const settlementId of [null, SETTLEMENT_ID]) {
      const client = mockClient();
      const result = await handleDataRpc(jwtEvent('/data/rpc', {
        name: 'save_claim_settlement_breakdown',
        args: { p_claim_id: CLAIM_ID, p_settlement_id: settlementId, p_values: VALUES },
      }), depsFor(client));
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.data.id, SETTLEMENT_ID);
      assert.equal(client.queries.some((query) => query.sql === SAVE_CLAIM_SETTLEMENT_SQL), true);
      const save = client.queries.find((query) => query.sql === SAVE_CLAIM_SETTLEMENT_SQL);
      assert.deepEqual(save.params, [CLAIM_ID, settlementId, JSON.stringify(VALUES)]);
      assert.equal(client.queries.some((query) => /UPDATE public\.claims|FOR UPDATE.*claims/i.test(query.sql)), false);
      assert.equal(client.queries.some((query) => query.sql === 'COMMIT'), true);
    }
  } finally {
    if (previous === undefined) delete process.env.AWS_WRITES_ENABLED;
    else process.env.AWS_WRITES_ENABLED = previous;
  }
});

test('dedicated settlement RPC rejects unauthorized and cross-tenant claim results', async () => {
  const previousWrites = process.env.AWS_WRITES_ENABLED;
  const previousWorkflowWrites = process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
  process.env.AWS_WRITES_ENABLED = 'false';
  process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'true';
  try {
    const client = mockClient({ result: { ok: false, code: 'not_authorized' } });
    const result = await handleDataRpc(jwtEvent('/data/rpc', {
      name: 'save_claim_settlement_breakdown',
      args: { p_claim_id: CLAIM_ID, p_settlement_id: null, p_values: VALUES, tenant_id: OTHER_TENANT },
    }), { ...depsFor(client), forceEnabled: false });
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'not_authorized');
    assert.equal(client.queries.find((query) => query.sql === SAVE_CLAIM_SETTLEMENT_SQL).params[0], CLAIM_ID);
    assert.equal(client.queries.some((query) => query.sql === 'COMMIT'), false);
  } finally {
    if (previousWrites === undefined) delete process.env.AWS_WRITES_ENABLED;
    else process.env.AWS_WRITES_ENABLED = previousWrites;
    if (previousWorkflowWrites === undefined) delete process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
    else process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = previousWorkflowWrites;
  }
});

test('unmapped Cognito identity cannot invoke the settlement writer', async () => {
  const previousWrites = process.env.AWS_WRITES_ENABLED;
  const previousWorkflowWrites = process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
  process.env.AWS_WRITES_ENABLED = 'false';
  process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'true';
  try {
    const client = mockClient({ mapping: false });
    const result = await handleDataRpc(jwtEvent('/data/rpc', {
      name: 'save_claim_settlement_breakdown',
      args: { p_claim_id: CLAIM_ID, p_settlement_id: null, p_values: VALUES },
    }), { ...depsFor(client), forceEnabled: false });
    assert.equal(result.statusCode, 401);
    assert.equal(result.error, 'identity_not_linked');
    assert.equal(client.queries.some((query) => query.sql === SAVE_CLAIM_SETTLEMENT_SQL), false);
  } finally {
    if (previousWrites === undefined) delete process.env.AWS_WRITES_ENABLED;
    else process.env.AWS_WRITES_ENABLED = previousWrites;
    if (previousWorkflowWrites === undefined) delete process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
    else process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = previousWorkflowWrites;
  }
});

test('dedicated settlement RPC allows application workflow writes when generic AWS writes are disabled', async () => {
  const previousWrites = process.env.AWS_WRITES_ENABLED;
  const previousWorkflowWrites = process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
  process.env.AWS_WRITES_ENABLED = 'false';
  process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'true';
  try {
    const client = mockClient();
    const result = await handleDataRpc(jwtEvent('/data/rpc', {
      name: 'save_claim_settlement_breakdown',
      args: { p_claim_id: CLAIM_ID, p_settlement_id: null, p_values: VALUES },
    }), { ...depsFor(client), forceEnabled: false });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.id, SETTLEMENT_ID);
    assert.equal(client.queries.some((query) => query.sql === SAVE_CLAIM_SETTLEMENT_SQL), true);
    assert.equal(client.queries.some((query) => query.sql === 'COMMIT'), true);
  } finally {
    if (previousWrites === undefined) delete process.env.AWS_WRITES_ENABLED;
    else process.env.AWS_WRITES_ENABLED = previousWrites;
    if (previousWorkflowWrites === undefined) delete process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
    else process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = previousWorkflowWrites;
  }
});

test('dedicated settlement RPC is refused when application workflow writes are disabled', async () => {
  const previousWrites = process.env.AWS_WRITES_ENABLED;
  const previousWorkflowWrites = process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
  process.env.AWS_WRITES_ENABLED = 'true';
  process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'false';
  try {
    const client = mockClient();
    const result = await handleDataRpc(jwtEvent('/data/rpc', {
      name: 'save_claim_settlement_breakdown',
      args: { p_claim_id: CLAIM_ID, p_settlement_id: null, p_values: VALUES },
    }), { ...depsFor(client), forceEnabled: false });
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'application_workflow_writes_disabled');
    assert.equal(client.queries.length, 0);
  } finally {
    if (previousWrites === undefined) delete process.env.AWS_WRITES_ENABLED;
    else process.env.AWS_WRITES_ENABLED = previousWrites;
    if (previousWorkflowWrites === undefined) delete process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
    else process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = previousWorkflowWrites;
  }
});

test('generic claim_settlements writes stay outside every table allowlist', async () => {
  const previousWrites = process.env.AWS_WRITES_ENABLED;
  const previousWorkflowWrites = process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
  process.env.AWS_WRITES_ENABLED = 'false';
  process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = 'true';
  try {
    assert.equal(WRITE_ALLOWLIST.claim_settlements, undefined);
    const client = mockClient();
    const disabled = await handleWrite(jwtEvent('/data/write', {
      table: 'claim_settlements',
      op: 'insert',
      values: { claim_id: CLAIM_ID, ...VALUES },
    }), { ...depsFor(client), forceEnabled: false });
    assert.equal(disabled.statusCode, 403);
    assert.equal(disabled.error, 'writes_disabled');
    assert.equal(client.queries.some((query) => /INSERT INTO public\.claim_settlements/.test(query.sql)), false);

    process.env.AWS_WRITES_ENABLED = 'true';
    const result = await handleWrite(jwtEvent('/data/write', {
      table: 'claim_settlements',
      op: 'insert',
      values: { claim_id: CLAIM_ID, ...VALUES },
    }), { ...depsFor(client), forceEnabled: false });
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'table_not_allowlisted');
    assert.equal(client.queries.some((query) => /INSERT INTO public\.claim_settlements/.test(query.sql)), false);

    const source = fs.readFileSync(CLIENT_PATH, 'utf8');
    const writeTables = source.match(/const AWS_WRITE_TABLES = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
    assert.doesNotMatch(writeTables, /claim_settlements/);
    assert.match(source, /name: "save_claim_settlement_breakdown"/);
    assert.ok(source.indexOf('name: "save_claim_settlement_breakdown"') < source.indexOf('if (!AWS_WRITE_TABLES.has(state.table))'));
  } finally {
    if (previousWrites === undefined) delete process.env.AWS_WRITES_ENABLED;
    else process.env.AWS_WRITES_ENABLED = previousWrites;
    if (previousWorkflowWrites === undefined) delete process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED;
    else process.env.AWS_APPLICATION_WORKFLOW_WRITES_ENABLED = previousWorkflowWrites;
  }
});

test('SQL writer is tenant-authorized, avoids claims UPDATE/row locks, and grants no generic table access', () => {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /public\.aws_can_write_claim\(p_claim_id\)/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /FOR UPDATE\s*;/);
  assert.doesNotMatch(sql, /UPDATE\s+public\.claims|FOR UPDATE OF\s+public\.claims/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.save_claim_settlement_breakdown[\s\S]*FROM PUBLIC/);
  assert.match(sql, /FROM PUBLIC, authenticated, anon/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.save_claim_settlement_breakdown[\s\S]*TO checksops/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|ALL).*claim_settlements/i);
  assert.doesNotMatch(sql, /'pwi_deductible'|'personal_property_deductible'/);
  assert.equal(CLAIM_SETTLEMENT_VALUE_COLUMNS.length, 17);
});
