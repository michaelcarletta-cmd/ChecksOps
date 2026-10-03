import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  claimAuthorizedForToken,
  enrichThinHomeownerLedgerDoc,
  handleHomeownerLedgerView,
  homeownerLedgerTotalsFromRecords,
  isThinHomeownerLedgerDoc,
  normalizeHomeownerLedgerView,
  pendingEndorsementsForHomeowner,
  runHomeownerLedgerView,
} from '../functions/api/homeowner.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CHECK_A = '33333333-3333-4333-8333-333333333331';
const CHECK_OTHER = '33333333-3333-4333-8333-333333333339';
const TOKEN_ID = '44444444-4444-4444-8444-444444444441';

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i.test(compact.trim())) {
      return { rows: [], rowCount: 0 };
    }
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
  end: async () => {},
});

const claimToken = {
  id: TOKEN_ID,
  tenant_id: TENANT_A,
  claim_id: CLAIM_A,
  homeowner_email: 'ada@example.com',
  homeowner_name: 'Ada Lovelace',
};

const claimRow = {
  id: CLAIM_A,
  claim_number: 'CL-100',
  property_address: '1 Main St',
  loss_type: 'wind',
  status: 'open',
  created_at: '2026-01-01T00:00:00.000Z',
  org_id: TENANT_A,
};

const authorizedChecks = [
  {
    id: CHECK_A,
    amount: 1000,
    check_stage: 'deposited',
    check_number: '1001',
    tenant_id: TENANT_A,
    claim_id: CLAIM_A,
  },
  {
    id: '33333333-3333-4333-8333-333333333332',
    amount: 250,
    check_stage: 'review',
    check_number: '1002',
    tenant_id: TENANT_A,
    claim_id: CLAIM_A,
  },
];

const richClaimDoc = {
  ok: true,
  mode: 'claim',
  token: claimToken,
  homeowner: { name: 'Ada Lovelace', email: 'ada@example.com' },
  claim: {
    id: CLAIM_A,
    claim_number: 'CL-100',
    property_address: '1 Main St',
    loss_type: 'wind',
    status: 'open',
    created_at: '2026-01-01T00:00:00.000Z',
  },
  events: [{
    id: 'evt-1',
    check_id: CHECK_A,
    event_type: 'check_received',
    occurred_at: '2026-01-02T00:00:00.000Z',
    amount: 1000,
    actor_label: 'Intake',
    payload_json: {},
  }],
  totals: { received: 1250, deposited: 1000, released: 400, remaining: 850 },
  pending_upload_count: 0,
  pending_signatures: [{ request_id: 'should-not-leak' }],
  pending_endorsements: [{
    check_id: CHECK_A,
    check_number: '1001',
    check_amount: 1000,
    parties: [{
      endorsement_id: 'e-ins',
      payee_name: 'Ada Lovelace',
      payee_type: 'insured',
      status: 'pending',
      sent_at: null,
      is_homeowner: true,
      sign_url: '/endorse?token=endorse-ada',
    }, {
      endorsement_id: 'e-mtg',
      payee_name: 'First National',
      payee_type: 'mortgage_company',
      status: 'sent',
      sent_at: '2026-01-03T00:00:00.000Z',
      is_homeowner: false,
      sign_url: null,
    }],
  }],
  shared_documents: [{ id: 'doc-1' }],
  project_plan: { schedule_status: 'set' },
  can_upload: true,
  money: { contract_total: 9999, allow_deductible_payment: true },
  allow_deductible_payment: true,
  deductible_payments: [{ id: 'pay-1', bank_name: 'Secret Bank', bank_last_four: '9999' }],
};

test('totals come from checks and disbursements, not ledger events', () => {
  const totals = homeownerLedgerTotalsFromRecords({
    checks: [
      { amount: 1000, check_stage: 'deposited' },
      { amount: 250, check_stage: 'review' },
      { amount: 50, check_stage: 'funds_released' },
    ],
    splits: [
      { amount: 400, status: 'sent' },
      { amount: 99, status: 'failed' },
    ],
    legacyDisbursements: [
      { amount: 25, status: 'paid' },
      { amount: 10, status: 'voided' },
    ],
  });
  assert.deepEqual(totals, {
    received: 1300,
    deposited: 1050,
    released: 425,
    remaining: 875,
  });
});

test('pending endorsements keep insured vs mortgage distinction and exclude internal parties', () => {
  const pending = pendingEndorsementsForHomeowner({
    checks: authorizedChecks,
    homeowner: { name: 'Ada Lovelace', email: 'ada@example.com' },
    endorsements: [
      {
        id: 'e-ins',
        check_id: CHECK_A,
        payee_name: 'Ada Lovelace',
        payee_type: 'insured',
        status: 'pending',
        token: 'endorse-ada',
        contact_email: 'ada@example.com',
        signed_at: null,
        request_sent_at: null,
      },
      {
        id: 'e-mtg',
        check_id: CHECK_A,
        payee_name: 'First National',
        payee_type: 'mortgage_company',
        status: 'sent',
        token: 'endorse-mtg-secret',
        contact_email: 'bank@example.com',
        signed_at: null,
        request_sent_at: '2026-01-03T00:00:00.000Z',
      },
      {
        id: 'e-pa',
        check_id: CHECK_A,
        payee_name: 'Internal PA',
        payee_type: 'public_adjuster',
        status: 'sent',
        token: 'endorse-pa',
        signed_at: null,
        request_sent_at: '2026-01-03T00:00:00.000Z',
      },
      {
        id: 'e-other-check',
        check_id: CHECK_OTHER,
        payee_name: 'Other Claim Insured',
        payee_type: 'insured',
        status: 'pending',
        token: 'endorse-other',
        contact_email: 'other@example.com',
        signed_at: null,
      },
    ],
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].check_id, CHECK_A);
  assert.deepEqual(pending[0].parties.map((row) => row.payee_type), ['insured', 'mortgage_company']);
  const insured = pending[0].parties.find((row) => row.payee_type === 'insured');
  const mortgage = pending[0].parties.find((row) => row.payee_type === 'mortgage_company');
  assert.equal(insured.is_homeowner, true);
  assert.equal(insured.sign_url, '/endorse?token=endorse-ada');
  assert.equal(mortgage.is_homeowner, false);
  assert.equal(mortgage.sign_url, null);
  assert.ok(!JSON.stringify(pending).includes('Internal PA'));
  assert.ok(!JSON.stringify(pending).includes('endorse-mtg-secret'));
  assert.ok(!JSON.stringify(pending).includes(CHECK_OTHER));
});

test('claim authorization fails closed on tenant or claim mismatch', () => {
  assert.equal(claimAuthorizedForToken({
    claim: claimRow,
    token: claimToken,
    checks: authorizedChecks,
  }), true);
  assert.equal(claimAuthorizedForToken({
    claim: { ...claimRow, org_id: TENANT_B },
    token: claimToken,
    checks: authorizedChecks,
  }), false);
  assert.equal(claimAuthorizedForToken({
    claim: { ...claimRow, id: CLAIM_B },
    token: claimToken,
    checks: authorizedChecks,
  }), false);
  assert.equal(claimAuthorizedForToken({
    claim: { ...claimRow, org_id: null },
    token: claimToken,
    checks: [{ ...authorizedChecks[0], tenant_id: TENANT_B }],
    events: [],
  }), false);
  assert.equal(claimAuthorizedForToken({
    claim: { ...claimRow, org_id: null },
    token: claimToken,
    checks: [],
    events: [{ tenant_id: TENANT_A, claim_id: CLAIM_A }],
  }), true);
});

test('thin RPC without mode is treated as incomplete', () => {
  assert.equal(isThinHomeownerLedgerDoc({
    ok: true,
    token: claimToken,
    claim: claimRow,
    events: [],
  }), true);
  assert.equal(isThinHomeownerLedgerDoc(richClaimDoc), false);
});

test('normalize forces the HomeownerLedger contract and never drops a claim-linked token into pre_claim', () => {
  const thin = normalizeHomeownerLedgerView({
    ok: true,
    token: claimToken,
    claim: richClaimDoc.claim,
    events: richClaimDoc.events,
    money: { wallet_balance: 12, routing_number: '021000021' },
    allow_deductible_payment: true,
    bank_account: '999',
  });
  assert.equal(thin.mode, 'claim');
  assert.deepEqual(thin.homeowner, { name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.equal(thin.claim.id, CLAIM_A);
  assert.deepEqual(thin.totals, { received: 0, deposited: 0, released: 0, remaining: 0 });
  assert.deepEqual(thin.pending_signatures, []);
  assert.deepEqual(thin.shared_documents, []);
  assert.equal(thin.project_plan, null);
  assert.equal(thin.can_upload, true);
  assert.equal(thin.money, null);
  assert.equal(thin.allow_deductible_payment, false);
  assert.deepEqual(thin.deductible_payments, []);
  assert.equal(thin.pending_upload_count, 0);

  const rich = normalizeHomeownerLedgerView(richClaimDoc);
  assert.equal(rich.mode, 'claim');
  assert.deepEqual(rich.totals, richClaimDoc.totals);
  assert.deepEqual(rich.pending_signatures, []);
  assert.equal(rich.money, null);
  assert.equal(rich.allow_deductible_payment, false);
  assert.deepEqual(rich.deductible_payments, []);
  assert.equal(rich.pending_endorsements[0].parties.length, 2);
});

test('valid claim-linked token returns mode claim with homeowner, claim, totals, events, and endorsements', async () => {
  const result = await runHomeownerLedgerView({
    token: 'valid-claim-token-value',
    spoof: { ignored: true },
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_homeowner_ledger_by_token'),
      result: () => ({ rows: [{ doc: richClaimDoc }] }),
    }]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.mode, 'claim');
  assert.deepEqual(result.homeowner, { name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.equal(result.claim.claim_number, 'CL-100');
  assert.deepEqual(result.totals, { received: 1250, deposited: 1000, released: 400, remaining: 850 });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].event_type, 'check_received');
  assert.equal(result.pending_endorsements[0].parties[0].payee_type, 'insured');
  assert.equal(result.pending_endorsements[0].parties[1].payee_type, 'mortgage_company');
  assert.equal(result.money, null);
  assert.equal(result.allow_deductible_payment, false);
  assert.deepEqual(result.deductible_payments, []);
  assert.deepEqual(result.pending_signatures, []);
  const encoded = JSON.stringify(result);
  assert.doesNotMatch(encoded, /wallet|routing_number|bank_last_four|Secret Bank|provider/i);
});

test('thin claim-linked RPC is enriched from tenant+claim scoped records', async () => {
  const result = await runHomeownerLedgerView({
    token: 'thin-claim-token-value',
    spoof: {},
    client: sqlClient([
      {
        match: (sql) => sql.includes('aws_public_homeowner_ledger_by_token'),
        result: () => ({ rows: [{
          doc: {
            ok: true,
            token: claimToken,
            claim: { id: CLAIM_A, claim_number: 'CL-100' },
            events: [{ id: 'foreign', tenant_id: TENANT_B, claim_id: CLAIM_B }],
            money: { wallet_balance: 50 },
          },
        }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.claims'),
        result: () => ({ rows: [claimRow] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: authorizedChecks }),
      },
      {
        match: (sql) => sql.includes('FROM public.homeowner_ledger_events'),
        result: () => ({ rows: [{
          id: 'evt-1',
          check_id: CHECK_A,
          event_type: 'deposited',
          occurred_at: '2026-01-04T00:00:00.000Z',
          amount: 1000,
          actor_label: 'Bank',
          payload_json: {},
          tenant_id: TENANT_A,
          claim_id: CLAIM_A,
        }] }),
      },
      {
        match: (sql) => sql.includes('disbursement_splits'),
        result: () => ({ rows: [{ amount: 400, status: 'sent' }] }),
      },
      {
        match: (sql) => sql.includes('claim_disbursements'),
        result: () => ({ rows: [{ amount: 25, status: 'paid' }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_endorsements'),
        result: () => ({ rows: [
          {
            id: 'e-ins',
            check_id: CHECK_A,
            payee_name: 'Ada Lovelace',
            payee_type: 'insured',
            status: 'pending',
            token: 'endorse-ada',
            contact_email: 'ada@example.com',
            signed_at: null,
            request_sent_at: null,
          },
          {
            id: 'e-mtg',
            check_id: CHECK_A,
            payee_name: 'First National',
            payee_type: 'mortgage_company',
            status: 'sent',
            token: 'mtg-secret',
            signed_at: null,
            request_sent_at: '2026-01-03T00:00:00.000Z',
          },
          {
            id: 'e-pa',
            check_id: CHECK_A,
            payee_name: 'PA',
            payee_type: 'public_adjuster',
            status: 'sent',
            token: 'pa-secret',
            signed_at: null,
            request_sent_at: '2026-01-03T00:00:00.000Z',
          },
        ] }),
      },
    ]),
  });
  assert.equal(result.mode, 'claim');
  assert.deepEqual(result.homeowner, { name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.equal(result.claim.claim_number, 'CL-100');
  assert.ok(!('org_id' in result.claim));
  assert.deepEqual(result.totals, { received: 1250, deposited: 1000, released: 425, remaining: 825 });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].event_type, 'deposited');
  assert.ok(!('tenant_id' in result.events[0]));
  assert.equal(result.pending_endorsements[0].parties.length, 2);
  assert.equal(result.money, null);
  assert.doesNotMatch(JSON.stringify(result), /mtg-secret|pa-secret|wallet_balance/);
});

test('other tenant, other claim, invalid, expired, and revoked tokens fail closed', async () => {
  const mismatch = await enrichThinHomeownerLedgerDoc(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.claims'),
      result: () => ({ rows: [{ ...claimRow, org_id: TENANT_B }] }),
    },
  ]), {
    ok: true,
    token: claimToken,
    claim: { ...claimRow, org_id: TENANT_B },
  });
  assert.deepEqual(mismatch, { error: 'not_found' });

  const otherClaim = await enrichThinHomeownerLedgerDoc(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.claims'),
      result: () => ({ rows: [] }),
    },
  ]), {
    ok: true,
    token: { ...claimToken, claim_id: CLAIM_B },
    claim: { id: CLAIM_B, org_id: TENANT_A },
  });
  assert.equal(otherClaim.error, 'not_found');

  const invalid = await runHomeownerLedgerView({
    token: 'missing-token-value',
    spoof: {},
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_homeowner_ledger_by_token'),
      result: () => ({ rows: [{ doc: null }] }),
    }]),
  });
  assert.equal(invalid.statusCode, 404);
  assert.equal(invalid.error, 'not_found');
  assert.equal(invalid.claim, undefined);
  assert.equal(invalid.events, undefined);

  const expired = await runHomeownerLedgerView({
    token: 'expired-token-value',
    spoof: {},
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_homeowner_ledger_by_token'),
      result: () => ({ rows: [{ doc: { error: 'expired' } }] }),
    }]),
  });
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.error, 'expired');
  assert.equal(expired.claim, undefined);

  const revoked = await runHomeownerLedgerView({
    token: 'revoked-token-value',
    spoof: {},
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_homeowner_ledger_by_token'),
      result: () => ({ rows: [{ doc: { error: 'revoked' } }] }),
    }]),
  });
  assert.equal(revoked.statusCode, 410);
  assert.equal(revoked.error, 'revoked');
  assert.equal(revoked.homeowner, undefined);
});

test('pre-claim token returns populated homeowner and safe empty defaults', async () => {
  const result = await runHomeownerLedgerView({
    token: 'preclaim-token-value',
    spoof: {},
    client: sqlClient([
      {
        match: (sql) => sql.includes('aws_public_homeowner_ledger_by_token'),
        result: () => ({ rows: [{
          doc: {
            ok: true,
            token: {
              id: TOKEN_ID,
              tenant_id: TENANT_A,
              claim_id: null,
              homeowner_email: 'ada@example.com',
              homeowner_name: 'Ada Lovelace',
            },
          },
        }] }),
      },
      {
        match: (sql) => sql.includes('homeowner_ledger_check_uploads'),
        result: () => ({ rows: [{ n: 2 }] }),
      },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'pre_claim');
  assert.deepEqual(result.homeowner, { name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.equal(result.claim, null);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.totals, { received: 0, deposited: 0, released: 0, remaining: 0 });
  assert.equal(result.pending_upload_count, 2);
  assert.deepEqual(result.pending_signatures, []);
  assert.deepEqual(result.pending_endorsements, []);
  assert.deepEqual(result.shared_documents, []);
  assert.equal(result.project_plan, null);
  assert.equal(result.can_upload, true);
  assert.equal(result.money, null);
  assert.equal(result.allow_deductible_payment, false);
  assert.deepEqual(result.deductible_payments, []);
  assert.doesNotMatch(JSON.stringify(result), /wallet|routing|bank_account|provider/i);
});

test('invalid token length is rejected before the RPC', async () => {
  const result = await handleHomeownerLedgerView({
    body: JSON.stringify({ token: 'short' }),
    headers: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'invalid_token');
});

test('source does not rewrite historical SQL 68 or public routes', () => {
  const sql68 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/68_staging_class_a_grants.sql'), 'utf8');
  const sql71 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/71_homeowner_ledger_view_contract.sql'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
  const handler = fs.readFileSync(path.join(ROOT, 'aws/functions/api/homeowner.mjs'), 'utf8');

  assert.match(sql68, /RETURNS jsonb/);
  assert.match(sql71, /Does NOT rewrite historical/);
  assert.match(sql71, /mode', 'claim'/);
  assert.match(sql71, /mode', 'pre_claim'/);
  assert.match(handler, /normalizeHomeownerLedgerView/);
  assert.match(handler, /pending_signatures: \[\]/);
  assert.match(handler, /handleHomeownerLedgerSignLink is not/);
  assert.match(handler, /aws_public_homeowner_ledger_remint_signer/);
  assert.match(handler, /sign_url: `\$\{origin\}\/sign\?token=\$\{raw\}`/);
  assert.doesNotMatch(handler, /allow_deductible_payment: true/);
  assert.match(app, /path="\/ledger\/:token"/);
  assert.doesNotMatch(app, /CHANGED_BY_VIEW_CONTRACT/);
});
