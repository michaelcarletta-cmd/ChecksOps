/**
 * Recording a payment made outside ChecksOps (owner report 2026-11-09): the route
 * record-external-disbursement (aws/functions/api/external-disbursement.mjs) and the two screens that use it.
 *
 * Root cause covered here: the Funds tab's "Disburse Outside ChecksOps" form and the Disbursement Console's
 * "External / Manual" speed inserted disbursement_batches / disbursement_splits through the generic /data/write
 * route, which refuses both tables (403 table_not_allowlisted, reason financial_or_provider). The record now goes
 * through one server call to SQL 147's DEFINER function (proven on PostgreSQL 16 in
 * sql147-external-disbursement-pg.test.mjs). This file covers the request validation, the error answers, the
 * sign-in the route runs as, that it never reaches the payment provider, and the UI wiring.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { handleAppServiceRequest } from '../functions/api/app-services.mjs';
import {
  RECORD_EXTERNAL_DISBURSEMENT_SQL,
  handleRecordExternalDisbursement,
  mapExternalDisbursementError,
  parseExternalDisbursementRequest,
  runRecordExternalDisbursement,
} from '../functions/api/external-disbursement.mjs';
import { handleWrite } from '../functions/api/write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const CHECK = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const BATCH = 'b1470000-0000-4000-8000-000000000001';

const validBody = (extra = {}) => ({
  tenant_id: TENANT,
  check_intake_item_id: CHECK,
  idempotency_key: '0d9c6b0e-6f8f-4b1c-9d55-2a1b8b6f0c11',
  payments: [{ amount_cents: 125000, recipient_name: ' ABC Roofing ', recipient_type: 'subcontractor', external_check_number: '10045', memo: 'Paid 11/9' }],
  ...extra,
});

const event = (body) => ({
  rawPath: '/functions/v1/record-external-disbursement',
  headers: { authorization: 'Bearer t', 'x-user-id': '00000000-0000-0000-0000-000000000099' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/functions/v1/record-external-disbursement' },
    authorizer: { jwt: { claims: { sub: SUB, email: 'tester@example.com', token_use: 'id' } } },
  },
});

/** A fake connection: the identity lookup answers, the SQL 147 call answers `answer` (or throws it). */
const fakeClient = (answer) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (params && params[0] === SUB) return { rows: [{ application_user_id: APP_ID, cognito_sub: SUB, email: 'tester@example.com', status: 'active' }] };
      if (String(sql) === RECORD_EXTERNAL_DISBURSEMENT_SQL) {
        if (answer instanceof Error) throw answer;
        return { rows: [{ result: answer }] };
      }
      return { rows: [] };
    },
  };
};
const deps = (client) => ({
  enforceLoginMfa: async () => null,
  loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only', host: 'db.example.internal', database: 'checksops' }),
  createClient: () => client,
});
const sqlError = (message, code) => Object.assign(new Error(message), { code });

test('request validation: tenant, check, key, 1-10 whole-cent payments with a payee', () => {
  const ok = parseExternalDisbursementRequest(validBody());
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.payments, [{
    amount_cents: 125000, recipient_name: 'ABC Roofing', recipient_type: 'subcontractor',
    external_check_number: '10045', memo: 'Paid 11/9', stakeholder_account_id: null,
  }]);
  const bad = [
    { tenant_id: 'nope' },
    { check_intake_item_id: null },
    { idempotency_key: 'short' },
    { payments: [] },
    { payments: Array.from({ length: 11 }, () => ({ amount_cents: 1, recipient_name: 'x' })) },
    { payments: [{ amount_cents: 0, recipient_name: 'x' }] },
    { payments: [{ amount_cents: 12.5, recipient_name: 'x' }] },
    { payments: [{ amount_cents: '100', recipient_name: 'x' }] },
    { payments: [{ amount_cents: 100 }] },
    { payments: [{ amount_cents: 100, recipient_name: 'x', recipient_type: 'boss' }] },
    { payments: [{ amount_cents: 100, stakeholder_account_id: 'not-a-uuid' }] },
    { payments: [{ amount_cents: 100, recipient_name: 'x', memo: 'm'.repeat(501) }] },
  ];
  for (const extra of bad) assert.ok(parseExternalDisbursementRequest(validBody(extra)).error, JSON.stringify(extra));
});

test('the route records through one SQL 147 call, as the verified sign-in, and commits', async () => {
  const client = fakeClient({
    batch_id: BATCH, split_ids: ['s1'], duplicate: false, total_cents: 125000, available_before_cents: 200000,
    remaining_cents: 75000, fully_disbursed: false,
  });
  const result = await handleRecordExternalDisbursement(event(validBody({ user_id: '00000000-0000-0000-0000-000000000099' })), deps(client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.batch_id, BATCH);
  assert.equal(result.remaining_cents, 75000);
  assert.equal(result.moneyMoved, false);
  const sqls = client.queries.map((q) => q.sql);
  // The actor is the mapped application user from the token, never a body or header id.
  const guc = client.queries.find((q) => /set_config/.test(q.sql) && q.params?.[0] === 'request.app_user_id');
  assert.equal(guc.params[1], APP_ID);
  const call = client.queries.find((q) => q.sql === RECORD_EXTERNAL_DISBURSEMENT_SQL);
  assert.deepEqual(call.params.slice(0, 2), [TENANT, CHECK]);
  assert.deepEqual(JSON.parse(call.params[2])[0].amount_cents, 125000);
  assert.equal(call.params[3], validBody().idempotency_key);
  assert.ok(sqls.indexOf("SET LOCAL lock_timeout = '10s'") < sqls.indexOf(RECORD_EXTERNAL_DISBURSEMENT_SQL));
  assert.equal(sqls.at(-1), 'COMMIT');
  // No direct write: the only statement that writes is the DEFINER call.
  assert.equal(sqls.some((s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s)), false);
});

test('refusals: amount over what is left, other tenant, unknown check, reused key, bad input; each rolls back', async () => {
  const cases = [
    [sqlError('external_disbursement_exceeds_available: available_cents=4321', 'P0001'), 409, 'amount_exceeds_available'],
    [sqlError('external_disbursement_forbidden', '42501'), 403, 'cross_tenant_denied'],
    [sqlError('external_disbursement_check_not_found', 'P0002'), 404, 'check_not_found'],
    [sqlError('external_disbursement_key_reused', '23505'), 409, 'idempotency_key_reused'],
    [sqlError('external_disbursement_invalid: stakeholder_account_id', '22023'), 400, 'invalid_external_disbursement'],
    [sqlError('function public.aws_record_external_disbursement(uuid, uuid, jsonb, text) does not exist', '42883'), 503, 'external_disbursement_unavailable'],
  ];
  for (const [error, status, code] of cases) {
    const client = fakeClient(error);
    const result = await handleRecordExternalDisbursement(event(validBody()), deps(client));
    assert.equal(result.statusCode, status, error.message);
    assert.equal(result.error, code);
    assert.equal(client.queries.at(-1).sql, 'ROLLBACK');
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
  }
  const over = mapExternalDisbursementError(sqlError('external_disbursement_exceeds_available: available_cents=4321'), {});
  assert.equal(over.available_cents, 4321);
  assert.match(over.message, /\$43\.21 available/);
  assert.throws(() => mapExternalDisbursementError(sqlError('connection reset'), {}), /connection reset/);
  // Invalid input never reaches the database function.
  const client = fakeClient({ batch_id: BATCH });
  const invalid = await runRecordExternalDisbursement({ client, body: validBody({ payments: [{ amount_cents: -5, recipient_name: 'x' }] }), spoof: {} });
  assert.equal(invalid.statusCode, 400);
  assert.equal(client.queries.length, 0);
});

test('the route is a Class A app service and never reaches the payment provider', async () => {
  const src = read('aws/functions/api/external-disbursement.mjs');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./data.mjs']);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''), /fetch\(|moov|payment_transfers|wallet/i);
  const appServices = read('aws/functions/api/app-services.mjs');
  assert.match(appServices, /^ {2}'record-external-disbursement',$/m);
  assert.match(appServices, /case 'record-external-disbursement':\n\s+return handleRecordExternalDisbursement\(event\);/);
  // Unauthenticated: answered by the route (not the provider stub), and nothing runs.
  const answer = await handleAppServiceRequest({ ...event(validBody()), requestContext: { http: { method: 'POST' } }, headers: {} },
    '/functions/v1/record-external-disbursement', 'POST');
  assert.ok(answer && answer.ok === false && answer.error !== 'provider_disabled', JSON.stringify(answer));
  // No generic RPC route can call the DEFINER function.
  assert.doesNotMatch(read('aws/functions/api/data.mjs'), /aws_record_external_disbursement/);
  assert.doesNotMatch(read('aws/functions/api/workflow-rpc.mjs'), /aws_record_external_disbursement/);
});

test('the generic /data/write route still refuses the disbursement tables (the original 403)', async () => {
  for (const table of ['disbursement_batches', 'disbursement_splits']) {
    const client = fakeClient(null);
    const result = await handleWrite(event({ table, op: 'insert', values: { tenant_id: TENANT, amount: 1 } }), { ...deps(client), forceEnabled: true });
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'table_not_allowlisted');
    assert.equal(result.reason, 'financial_or_provider');
  }
});

test('SQL 147: DEFINER, EXECUTE for checksops only, writes batch and settled external splits, no provider rows', () => {
  const sql = read('aws/workflows/sql/147_external_disbursement_record.sql');
  const code = sql.replace(/--[^\n]*/g, '');
  assert.match(code, /CREATE OR REPLACE FUNCTION public\.aws_record_external_disbursement\(\s*_tenant_id uuid,\s*_check_intake_item_id uuid,\s*_payments jsonb,\s*_idempotency_key text\s*\)\s*RETURNS jsonb\s*LANGUAGE plpgsql\s*VOLATILE\s*SECURITY DEFINER\s*SET search_path = public, pg_temp/);
  assert.match(code, /public\.aws_can_write_tenant\(_tenant_id\)/);
  assert.match(code, /FROM public\.check_intake_items ci\s+WHERE ci\.id = _check_intake_item_id\s+FOR UPDATE/);
  assert.match(code, /INSERT INTO public\.disbursement_batches/);
  assert.match(code, /'settled', 'external_check'/);
  assert.equal([...code.matchAll(/INSERT INTO public\.(\w+)/g)].map((m) => m[1]).sort().join(','), 'disbursement_batches,disbursement_splits');
  assert.doesNotMatch(code, /UPDATE public\.|DELETE FROM/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.aws_record_external_disbursement\(uuid, uuid, jsonb, text\) TO checksops;/);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.aws_record_external_disbursement\(uuid, uuid, jsonb, text\) FROM PUBLIC;/);
  assert.doesNotMatch(code, /^\s*(BEGIN|COMMIT);/m);
});

test('UI: both screens record through the server route; no browser insert into the disbursement tables', () => {
  const lib = read('src/lib/payments/externalDisbursement.ts');
  assert.match(lib, /export const EXTERNAL_DISBURSEMENT_FUNCTION = "record-external-disbursement";/);
  assert.match(lib, /supabase\.functions\.invoke\(EXTERNAL_DISBURSEMENT_FUNCTION,/);
  assert.doesNotMatch(lib, /moov|\.from\(/i);

  const funds = read('src/components/payments/FundsTab.tsx');
  assert.match(funds, /await recordExternalDisbursement\(\{\s*tenantId: tenant!\.id,\s*checkId: checkIntakeItemId,\s*payments: \[payment\],\s*idempotencyKey: pendingExternal\.current\.key,/);
  assert.match(funds, /external_check_number: extCheckNum\.trim\(\),/);
  assert.match(funds, /memo: extNotes\.trim\(\) \|\| null,/);
  assert.match(funds, /if \(readOnly \|\| extSaving\) return;/);
  const console_ = read('src/components/disbursement/DisbursementConsole.tsx');
  assert.match(console_, /await recordExternalDisbursement\(\{/);
  for (const [name, src] of [['FundsTab', funds], ['DisbursementConsole', console_]]) {
    assert.doesNotMatch(src, /\.from\("disbursement_(batches|splits)"\)\s*\.(insert|update|upsert)/, name);
    assert.doesNotMatch(src, /\.from\("(check_intake_items|claim_checks)"\)\s*\.update\(\{ check_stage/, name);
  }
});
