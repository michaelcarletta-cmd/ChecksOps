/**
 * Permanent Claim Ledger figures-save contract.
 *
 * Live production already has write-claim-settlement.mjs and
 * save_claim_settlement_breakdown. The user-visible "writes disabled"
 * toast is the SPA AWS_WRITE_TABLES gate: ClaimSettlementEditor writes
 * generic claim_settlements insert/update, and that table is correctly
 * excluded from the allowlist. The required composition is a client
 * intercept onto the dedicated RPC. This file never deploys.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { handleWrite } from '../functions/api/write.mjs';
import { WRITE_ALLOWLIST, denyTableReason } from '../functions/api/write-allowlist.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { executeAppMetadataWrite } from '../functions/api/write-app-metadata.mjs';
import {
  SETTLEMENT_BREAKDOWN_COLUMNS,
  computeSettlementAcv,
  executeClaimSettlementBreakdownWrite,
  parseSettlementBreakdownInput,
} from './fixtures/live-prod-write-claim-settlement.mjs';
import { planClaimNumberSave, CLAIM_LEDGER_LINK_RPC } from '../../src/lib/checkClaimLinkGuard.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const CONTRACT_PIN = path.join(ROOT, 'ops/deployment-guard/claim-ledger-figures-save-contract.json');
const CLIENT_SRC = readFileSync(path.join(ROOT, 'src/integrations/aws/client.ts'), 'utf8');
const EDITOR_SRC = readFileSync(path.join(ROOT, 'src/components/payments/ClaimSettlementEditor.tsx'), 'utf8');
const LEDGER_SRC = readFileSync(path.join(ROOT, 'src/components/payments/ClaimLedgerCard.tsx'), 'utf8');
const FIXTURE_SRC = readFileSync(path.join(HERE, 'fixtures/live-prod-write-claim-settlement.mjs'), 'utf8');
const LIVE_WRITER_PIN = 'ce53b3683504081fb6ab3f52559a4c6fcad8856cadd078bbf635359f2cc8779d';
const LIVE_CODESHA = 'kqXCfyf3PVmKxV4ncmLgWKH/A6iwbi/IgsOgFTbIedQ=';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CLAIM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN_CLAIM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SETTLEMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const BASE_AMOUNTS = Object.fromEntries(SETTLEMENT_BREAKDOWN_COLUMNS.map((column) => [column, 0]));
const DWELLING = {
  ...BASE_AMOUNTS,
  replacement_cost_value: 10000,
  recoverable_depreciation: 1000,
  non_recoverable_depreciation: 500,
  deductible: 250,
};

const EDITOR_COLUMNS = [
  'replacement_cost_value',
  'recoverable_depreciation',
  'non_recoverable_depreciation',
  'deductible',
  'other_structures_rcv',
  'other_structures_recoverable_depreciation',
  'other_structures_non_recoverable_depreciation',
  'other_structures_deductible',
  'pwi_rcv',
  'pwi_recoverable_depreciation',
  'pwi_non_recoverable_depreciation',
  'personal_property_rcv',
  'personal_property_recoverable_depreciation',
  'personal_property_non_recoverable_depreciation',
  'ale_rcv',
  'ale_recoverable_depreciation',
  'ale_non_recoverable_depreciation',
];

const writeTableSet = () => {
  const match = CLIENT_SRC.match(/const AWS_WRITE_TABLES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, 'AWS_WRITE_TABLES must remain a source Set');
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((row) => row[1]));
};

const interceptIndex = () => CLIENT_SRC.indexOf('state.table === "claim_settlements"');
const writesDisabledGateIndex = () => CLIENT_SRC.indexOf('if (!AWS_WRITE_TABLES.has(state.table))');

const jwtEvent = (pathName, body) => ({
  rawPath: pathName,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: pathName },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'tester@freedomadj.com', token_use: 'id' } } },
  },
});

const mockWriteClient = () => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'tester@freedomadj.com', status: 'active' }] };
      }
      return { rows: [] };
    },
  };
};

const settlementClient = ({
  claim = { id: CLAIM_ID, org_id: TENANT },
  member = true,
  canWrite = true,
  existing = [],
  foreignById = null,
} = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM public.claims/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { rows: claim ? [claim] : [] };
      }
      if (/aws_can_write_claim/.test(sql)) return { rows: [{ allowed: canWrite }] };
      if (/FROM public.tenant_users/.test(sql)) return { rows: member ? [{ ok: 1 }] : [] };
      if (/FROM public.claim_settlements/.test(sql) && /ORDER BY/.test(sql)) {
        return { rows: existing };
      }
      if (/FROM public.claim_settlements/.test(sql) && /WHERE id =/.test(sql)) {
        return { rows: foreignById ? [foreignById] : [] };
      }
      if (/INSERT INTO public.claim_settlements/.test(sql)) {
        const row = { id: SETTLEMENT_ID, claim_id: params[0], created_by: params[1] };
        SETTLEMENT_BREAKDOWN_COLUMNS.forEach((column, index) => {
          row[column] = params[index + 2];
        });
        return { rows: [row] };
      }
      if (/UPDATE public.claim_settlements/.test(sql)) {
        const row = { id: params[0], claim_id: params[1] };
        SETTLEMENT_BREAKDOWN_COLUMNS.forEach((column, index) => {
          row[column] = params[index + 2];
        });
        return { rows: [row] };
      }
      if (/UPDATE public.check_intake_items|INSERT INTO public.claim_payments|INSERT INTO public.claim_disbursements|UPDATE public.tenants|INSERT INTO public.claims/.test(sql)) {
        throw new Error('forbidden side-effect SQL');
      }
      return { rows: [] };
    },
  };
};

test('permanent Claim Ledger figures-save contract pin remains registered', () => {
  const pin = JSON.parse(readFileSync(CONTRACT_PIN, 'utf8'));
  const registry = JSON.parse(readFileSync(path.join(ROOT, 'ops/deployment-guard/accepted-contracts.json'), 'utf8'));
  const registered = (registry.contracts || []).find((row) => row.id === 'claim-ledger-figures-save');
  assert.ok(registered, 'claim-ledger-figures-save must stay in accepted-contracts.json');
  assert.equal(registered.test, 'aws/tests/claim-ledger-figures-save-contract.test.mjs');
  assert.equal(pin.id, 'claim-ledger-figures-save');
  assert.equal(pin.accepted, true);
  assert.equal(pin.enabled, true);
  assert.equal(pin.test, 'aws/tests/claim-ledger-figures-save-contract.test.mjs');
  for (const invariant of [
    'legitimate Claim Ledger figures can be saved',
    'values persist after refresh',
    'calculated totals remain correct',
    'unauthorized/cross-tenant writes remain blocked',
    'arbitrary financial table writes remain blocked',
    'Claim Ledger cannot create duplicate claims',
    'existing claim-number Save still works',
    'settlement/other financial protections are not weakened',
  ]) {
    assert.ok(pin.invariants.includes(invariant), invariant);
  }
});

test('user-visible writes_disabled is the SPA allowlist gate, not a Lambda env flag', () => {
  const tables = writeTableSet();
  assert.equal(tables.has('claims'), true);
  assert.equal(tables.has('claim_settlements'), false);
  assert.equal(tables.size, 31);
  assert.match(CLIENT_SRC, /postgrestError\("writes_disabled", "42501", \{\s*hint: "This table is not in the AWS write allowlist"/);
  assert.ok(writesDisabledGateIndex() > 0);
  assert.doesNotMatch(CLIENT_SRC, /AWS_WRITE_TABLES.*claim_settlements|"claim_settlements",/);
});

test('SPA intercept routes claim_settlements insert/update to save_claim_settlement_breakdown before the gate', () => {
  const start = interceptIndex();
  const gate = writesDisabledGateIndex();
  assert.ok(start > 0, 'claim_settlements intercept must exist');
  assert.ok(gate > start, 'intercept must run before AWS_WRITE_TABLES writes_disabled');
  assert.match(CLIENT_SRC, /name: "save_claim_settlement_breakdown"/);
  assert.match(CLIENT_SRC, /apiFetch\("\/data\/rpc"/);
  assert.match(CLIENT_SRC, /settlement_id: idFilter\?\.value \?\? values\.id \?\? null/);
  assert.equal(CLIENT_SRC.includes('state.table === "claim_settlements" && (state.op === "insert" || state.op === "update")'), true);
});

test('every editable Claim Ledger figure maps through ClaimSettlementEditor claim_settlements write', () => {
  for (const column of EDITOR_COLUMNS) {
    assert.match(EDITOR_SRC, new RegExp(column));
    assert.equal(SETTLEMENT_BREAKDOWN_COLUMNS.includes(column), true, column);
  }
  assert.match(EDITOR_SRC, /\.from\("claim_settlements"\)[\s\S]*\.update\(payload\)/);
  assert.match(EDITOR_SRC, /\.from\("claim_settlements"\)[\s\S]*\.insert\(\{ \.\.\.payload, created_by: user\?\.id \}\)/);
  assert.match(EDITOR_SRC, /const acv = Math\.max\(0, rcv - recDep - nonRecDep - ded\)/);
  assert.doesNotMatch(EDITOR_SRC, /save_claim_settlement_breakdown/);
  assert.doesNotMatch(EDITOR_SRC, /actual_cash_value|derived_acv|\bacv:/);
  assert.doesNotMatch(EDITOR_SRC, /supplement_expected/);
});

test('ACV, prior checks, and remaining are computed or select-only', () => {
  assert.match(LEDGER_SRC, /\.from\("claim_settlements"\)[\s\S]*\.select\("\*"\)/);
  assert.match(LEDGER_SRC, /\.from\("check_intake_items"\)[\s\S]*\.select\("id, check_number, amount/);
  assert.match(LEDGER_SRC, /const remaining = Math\.max\(0, totalExpected - totalReceived\)/);
  assert.match(LEDGER_SRC, /const dwellingAcv = Math\.max\(0,/);
  assert.doesNotMatch(LEDGER_SRC, /\.from\("claim_settlements"\)[\s\S]{0,80}\.(insert|update|upsert|delete)\(/);
  assert.doesNotMatch(LEDGER_SRC, /save_claim_settlement_breakdown/);
});

test('live production writer fixture stays pinned to the accepted Lambda member', () => {
  assert.match(FIXTURE_SRC, new RegExp(`sha256 ${LIVE_WRITER_PIN}`));
  assert.match(FIXTURE_SRC, new RegExp(LIVE_CODESHA.replace(/[+=]/g, '\\$&')));
  const pinLine = FIXTURE_SRC.split('\n')[0];
  assert.match(pinLine, /PINNED LIVE\/STAGING MEMBER write-claim-settlement\.mjs/);
});

test('legitimate figures INSERT persists and server-owns created_by', async () => {
  const client = settlementClient({ existing: [] });
  const result = await executeClaimSettlementBreakdownWrite({
    client,
    mapping: { application_user_id: APP_ID },
    args: { claim_id: CLAIM_ID, created_by: '00000000-0000-4000-8000-000000000099', ...DWELLING },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.data.claim_id, CLAIM_ID);
  assert.equal(result.data.created_by, APP_ID);
  assert.equal(result.data.replacement_cost_value, 10000);
  assert.equal(result.data.recoverable_depreciation, 1000);
  assert.equal(result.data.non_recoverable_depreciation, 500);
  assert.equal(result.data.deductible, 250);
  assert.equal(result.data.derived_acv.dwelling, 8250);
  assert.equal(result.data.derived_acv.total, 8250);
  const insert = client.queries.find((row) => /INSERT INTO public.claim_settlements/.test(row.sql));
  assert.ok(insert);
  assert.equal(insert.params[1], APP_ID);
  assert.equal(client.queries.some((row) => /INSERT INTO public.claims/.test(row.sql)), false);
});

test('values persist on UPDATE and a second insert is never created', async () => {
  const client = settlementClient({
    existing: [{ id: SETTLEMENT_ID, claim_id: CLAIM_ID }],
  });
  const first = await executeClaimSettlementBreakdownWrite({
    client,
    mapping: { application_user_id: APP_ID },
    args: { claim_id: CLAIM_ID, id: SETTLEMENT_ID, ...DWELLING, other_structures_rcv: 400 },
  });
  assert.equal(first.error, undefined);
  assert.equal(first.data.id, SETTLEMENT_ID);
  assert.equal(first.data.other_structures_rcv, 400);
  assert.equal(first.data.replacement_cost_value, 10000);
  assert.equal(first.data.derived_acv.other_structures, 400);
  assert.equal(first.data.derived_acv.total, 8650);

  const refresh = await executeClaimSettlementBreakdownWrite({
    client,
    mapping: { application_user_id: APP_ID },
    args: { claim_id: CLAIM_ID, settlement_id: SETTLEMENT_ID, ...DWELLING, other_structures_rcv: 400 },
  });
  assert.equal(refresh.error, undefined);
  assert.equal(refresh.data.id, SETTLEMENT_ID);
  assert.equal(refresh.data.other_structures_rcv, 400);
  assert.equal(client.queries.filter((row) => /UPDATE public.claim_settlements/.test(row.sql)).length, 2);
  assert.equal(client.queries.some((row) => /INSERT INTO public.claim_settlements/.test(row.sql)), false);
});

test('calculated ACV totals stay derived and are not a writable field', () => {
  const acv = computeSettlementAcv({
    ...BASE_AMOUNTS,
    replacement_cost_value: 10000,
    recoverable_depreciation: 1000,
    non_recoverable_depreciation: 500,
    deductible: 250,
    other_structures_rcv: 2000,
    other_structures_recoverable_depreciation: 200,
    other_structures_non_recoverable_depreciation: 0,
    other_structures_deductible: 100,
    pwi_rcv: 300,
    personal_property_rcv: 50,
    ale_rcv: 25,
  });
  assert.equal(acv.dwelling, 8250);
  assert.equal(acv.other_structures, 1700);
  assert.equal(acv.pwi, 300);
  assert.equal(acv.personal_property, 50);
  assert.equal(acv.ale, 25);
  assert.equal(acv.total, 10325);
  assert.equal(parseSettlementBreakdownInput({
    claim_id: CLAIM_ID,
    replacement_cost_value: 1,
    acv: 999,
  }).error, 'column_not_allowlisted');
  assert.equal(parseSettlementBreakdownInput({
    claim_id: CLAIM_ID,
    actual_cash_value: 1,
  }).error, 'column_not_allowlisted');
});

test('unauthorized and cross-tenant settlement writes remain blocked', async () => {
  const foreign = settlementClient({
    claim: { id: CLAIM_ID, org_id: TENANT },
    member: false,
    canWrite: false,
  });
  const denied = await executeClaimSettlementBreakdownWrite({
    client: foreign,
    mapping: { application_user_id: APP_ID },
    args: { claim_id: CLAIM_ID, ...DWELLING },
  });
  assert.equal(denied.error, 'not_authorized');
  assert.equal(foreign.queries.some((row) => /INSERT INTO|UPDATE public.claim_settlements/.test(row.sql)), false);

  const missing = await executeClaimSettlementBreakdownWrite({
    client: settlementClient({ claim: null }),
    mapping: { application_user_id: APP_ID },
    args: { claim_id: FOREIGN_CLAIM, ...DWELLING },
  });
  assert.equal(missing.error, 'rls_denied');

  const reassigned = await executeClaimSettlementBreakdownWrite({
    client: settlementClient({
      existing: [],
      foreignById: { id: SETTLEMENT_ID, claim_id: FOREIGN_CLAIM },
    }),
    mapping: { application_user_id: APP_ID },
    args: { claim_id: CLAIM_ID, id: SETTLEMENT_ID, ...DWELLING },
  });
  assert.equal(reassigned.error, 'claim_reassignment_denied');
});

test('arbitrary financial and identity fields remain blocked', () => {
  for (const field of [
    'amount',
    'deposited_at',
    'check_stage',
    'check_id',
    'payment_id',
    'disbursement_id',
    'moov_account_id',
    'payment_provider',
    'org_id',
    'tenant_id',
    'endorsement_id',
    'signature_request_id',
  ]) {
    const parsed = parseSettlementBreakdownInput({
      claim_id: CLAIM_ID,
      replacement_cost_value: 1,
      [field]: field === 'amount' ? 99 : 'bad',
    });
    assert.equal(parsed.error, 'column_not_allowlisted', field);
    assert.ok(parsed.columns.includes(field), field);
  }
  assert.equal(parseSettlementBreakdownInput({
    claim_id: CLAIM_ID,
    mystery_column: 'nope',
  }).error, 'unknown_column');
});

test('generic claim_settlements and other financial table writes remain blocked', async () => {
  assert.equal(WRITE_ALLOWLIST.claim_settlements, undefined);
  assert.equal(WRITE_ALLOWLIST.claim_payments, undefined);
  assert.equal(WRITE_ALLOWLIST.claim_disbursements, undefined);
  assert.notEqual(denyTableReason('claim_settlements'), null);
  const client = mockWriteClient();
  const result = await handleWrite(jwtEvent('/data/write', {
    table: 'claim_settlements',
    op: 'insert',
    values: { claim_id: CLAIM_ID, replacement_cost_value: 1 },
  }), {
    loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
    forceEnabled: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'table_not_allowlisted');
  assert.equal(client.queries.some((row) => /INSERT INTO public.claim_settlements/.test(row.sql)), false);

  const payments = await handleWrite(jwtEvent('/data/write', {
    table: 'claim_payments',
    op: 'insert',
    values: { claim_id: CLAIM_ID, amount: 1 },
  }), {
    loadDatabaseCredentials: async () => ({ host: 'x', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => mockWriteClient(),
    forceEnabled: true,
  });
  assert.equal(payments.ok, false);
  assert.equal(payments.error, 'table_not_allowlisted');
});

test('Claim Ledger cannot create a duplicate claim from figure or claim-number save', async () => {
  const plan = planClaimNumberSave({ existingClaimId: CLAIM_ID, claimNumber: 'CLM-NEW' });
  assert.equal(plan.mode, 'update_existing');
  assert.equal(plan.claimId, CLAIM_ID);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.deepEqual([...WRITE_ALLOWLIST.claims.columns], ['claim_number']);
  assert.match(LEDGER_SRC, /\.from\("claims"\)[\s\S]*\.update\(\{ claim_number: plan\.claimNumber \}\)/);
  assert.doesNotMatch(LEDGER_SRC, /\.from\("claims"\)[\s\S]{0,120}\.insert\(/);
  assert.equal(CLAIM_LEDGER_LINK_RPC, 'claim_ledger_link_or_create');

  const client = settlementClient({ existing: [{ id: SETTLEMENT_ID, claim_id: CLAIM_ID }] });
  await executeClaimSettlementBreakdownWrite({
    client,
    mapping: { application_user_id: APP_ID },
    args: { claim_id: CLAIM_ID, ...DWELLING },
  });
  assert.equal(client.queries.some((row) => /INSERT INTO public.claims/.test(row.sql)), false);
  assert.equal(client.queries.some((row) => /INSERT INTO public.claim_settlements/.test(row.sql)), false);
});

test('existing claim-number Save still updates the same claim UUID only', async () => {
  const queries = [];
  const updated = await executeAppMetadataWrite({
    client: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (/FROM public.claims WHERE id/.test(sql)) {
          return { rows: [{ id: CLAIM_ID, org_id: TENANT, claim_number: 'CLM-OLD', status: 'tracking' }] };
        }
        if (/FROM public.tenant_users/.test(sql)) return { rows: [{ ok: 1 }] };
        if (/UPDATE public.claims/.test(sql)) {
          assert.match(sql, /SET claim_number = \$2::text/);
          assert.match(sql, /WHERE id = \$1::uuid AND org_id = \$3::uuid/);
          assert.equal(params[0], CLAIM_ID);
          return { rows: [{ id: CLAIM_ID, org_id: TENANT, claim_number: params[1] }] };
        }
        return { rows: [] };
      },
    },
    mapping: { application_user_id: APP_ID },
    table: 'claims',
    op: 'update',
    values: { claim_number: 'CLM-NEW' },
    filters: [{ column: 'id', op: 'eq', value: CLAIM_ID }],
  });
  assert.equal(updated.rows[0].id, CLAIM_ID);
  assert.equal(updated.rows[0].claim_number, 'CLM-NEW');
  assert.equal(queries.some((row) => /INSERT INTO public\.claims/.test(row.sql)), false);

  const insert = await executeAppMetadataWrite({
    client: { query: async () => ({ rows: [] }) },
    mapping: { application_user_id: APP_ID },
    table: 'claims',
    op: 'insert',
    values: { claim_number: 'CLM-NEW' },
    filters: [],
  });
  assert.equal(insert.error, 'operation_not_allowlisted');
});

test('settlement and other financial protections are not weakened', () => {
  assert.equal(WRITE_ALLOWLIST.claim_settlements, undefined);
  assert.equal(writeTableSet().has('claim_settlements'), false);
  assert.match(CLIENT_SRC, /name: "save_claim_settlement_breakdown"/);
  assert.doesNotMatch(CLIENT_SRC, /"claim_settlements",/);
  const writeSrc = readFileSync(path.join(ROOT, 'aws/functions/api/write.mjs'), 'utf8');
  const workflowSrc = readFileSync(path.join(ROOT, 'aws/functions/api/workflow-rpc.mjs'), 'utf8');
  const allowSrc = readFileSync(path.join(ROOT, 'aws/functions/api/write-allowlist.mjs'), 'utf8');
  assert.match(writeSrc, /const peelReviewClaimNumber/);
  assert.match(writeSrc, /review_save_detected_claim_number/);
  assert.match(workflowSrc, /claim_ledger_link_or_create/);
  assert.match(allowSrc, /claims:\s*\{[\s\S]*ops: new Set\(\['update'\]\)/);
  assert.doesNotMatch(allowSrc, /claim_settlements:/);
  assert.equal(createHash('sha256').update(FIXTURE_SRC).digest('hex').length, 64);
});
