/**
 * Durable S5 Audited Claim Association safeguard.
 * Runs in the existing AWS API regression suite (`npm run test:aws-api`).
 * Failure messages always identify S5 Audited Claim Association.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { handleWrite } from '../functions/api/write.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import * as rpc from '../functions/api/workflow-rpc.mjs';
import * as allowlist from '../functions/api/write-allowlist.mjs';
import {
  ADMIN,
  CHECK_ID,
  CLAIM_A,
  S5_ALLOWLIST,
  S5_LABEL,
  S5_RPC,
  S5_SQL,
  assertAcceptedInvariants,
  expectS5Failure,
  importMutatedModule,
  mutateAllowGenericClaimId,
  mutateRemoveAuditInsert,
  mutateRemoveDepositedProtection,
  mutateRemoveRpcBridge,
  mutateRemoveTenantProtection,
  readRepo,
  s5Assert,
} from './lib/s5-audited-claim-association-safeguard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';

const jwtEvent = (body) => ({
  rawPath: '/data/write',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/write' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } } },
  },
});

const depsFor = (client) => ({
  forceEnabled: true,
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

const writeClient = () => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (String(sql).startsWith('SELECT set_config')) return { rows: [{ set_config: params?.[1] || '1' }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: [{
            application_user_id: ADMIN,
            cognito_sub: COGNITO_SUB,
            email: 'checksops-tester@freedomadj.com',
            status: 'active',
          }],
        };
      }
      return { rows: [] };
    },
  };
};

test(`${S5_LABEL}: accepted RPC, SQL, and generic-write invariants hold`, async () => {
  await assertAcceptedInvariants(rpc, readRepo(ROOT, S5_SQL), allowlist);
});

test(`${S5_LABEL}: generic /data/write claim_id remains prohibited`, async () => {
  const client = writeClient();
  const result = await handleWrite(jwtEvent({
    table: 'check_intake_items',
    op: 'update',
    values: { claim_id: CLAIM_A },
    filters: [{ column: 'id', op: 'eq', value: CHECK_ID }],
  }), depsFor(client));
  s5Assert(result.statusCode === 403 && result.error === 'column_not_allowlisted', 'generic /data/write claim_id was accepted');
  s5Assert(Array.isArray(result.columns) && result.columns.includes('claim_id'), 'generic write denial did not name claim_id');
  s5Assert(!client.queries.some((row) => /UPDATE public.check_intake_items/.test(row.sql)), 'generic claim_id write mutated intake');
});

test(`${S5_LABEL}: mutation removing the RPC dispatcher/bridge is rejected`, async () => {
  const mutated = await importMutatedModule(ROOT, S5_RPC, mutateRemoveRpcBridge);
  await expectS5Failure('RPC dispatcher/bridge is removed', () => (
    assertAcceptedInvariants(mutated, readRepo(ROOT, S5_SQL), allowlist)
  ));
});

test(`${S5_LABEL}: mutation removing deposited protection is rejected`, async () => {
  const mutated = await importMutatedModule(ROOT, S5_RPC, mutateRemoveDepositedProtection);
  await expectS5Failure('deposited protection is removed', () => (
    assertAcceptedInvariants(mutated, readRepo(ROOT, S5_SQL), allowlist)
  ));
});

test(`${S5_LABEL}: mutation removing tenant protection is rejected`, async () => {
  const mutated = await importMutatedModule(ROOT, S5_RPC, mutateRemoveTenantProtection);
  await expectS5Failure('tenant protection is removed', () => (
    assertAcceptedInvariants(mutated, readRepo(ROOT, S5_SQL), allowlist)
  ));
});

test(`${S5_LABEL}: mutation removing audit insertion is rejected`, async () => {
  await expectS5Failure('audit insertion is removed', () => (
    assertAcceptedInvariants(rpc, mutateRemoveAuditInsert(readRepo(ROOT, S5_SQL)), allowlist)
  ));
});

test(`${S5_LABEL}: mutation removing generic claim_id prohibition is rejected`, async () => {
  const mutated = await importMutatedModule(ROOT, S5_ALLOWLIST, mutateAllowGenericClaimId);
  await expectS5Failure('generic claim_id prohibition is removed', () => (
    assertAcceptedInvariants(rpc, readRepo(ROOT, S5_SQL), mutated)
  ));
});
