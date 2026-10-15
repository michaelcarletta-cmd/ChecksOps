/**
 * Homeowner Ledger view contract at the Lambda boundary (homeowner.mjs):
 * whatever aws_public_homeowner_ledger_by_token returns (thin SQL 68 or
 * SQL 82), the public JSON carries no endorsement/signer tokens, keeps money
 * CTAs off, and only exposes Lambda-sanitized pending signatures.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleHomeownerLedgerView } from '../functions/api/homeowner.mjs';
import { handleAppServiceRequest } from '../functions/api/app-services.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CHECK_A = '33333333-3333-4333-8333-333333333331';

const token = (overrides = {}) => ({
  id: 'tok-1',
  tenant_id: TENANT_A,
  claim_id: CLAIM_A,
  homeowner_email: 'ada@example.com',
  homeowner_name: 'Ada Lovelace',
  ...overrides,
});

test('a thin SQL 68 document still renders as a claim ledger with safe defaults', () => {
  const view = assembleHomeownerLedgerView({
    ok: true,
    token: token(),
    claim: { id: CLAIM_A, claim_number: 'CL-100' },
    events: [],
    allow_deductible_payment: true,
    money: { wallet_balance: 5 },
    deductible_payments: [{ id: 'p' }],
  }, { tenantIdIgnored: true });
  assert.equal(view.ok, true);
  assert.equal(view.statusCode, 200);
  assert.equal(view.mode, 'claim');
  assert.deepEqual(view.homeowner, { name: 'Ada Lovelace', email: 'ada@example.com' });
  assert.deepEqual(view.totals, { received: 0, deposited: 0, released: 0, remaining: 0 });
  assert.deepEqual(view.pending_endorsements, []);
  assert.deepEqual(view.pending_signatures, []);
  assert.equal(view.allow_deductible_payment, false);
  assert.equal(view.money, null);
  assert.deepEqual(view.deductible_payments, []);
  assert.deepEqual(view.spoofFieldsIgnored, { tenantIdIgnored: true });
});

test('a pre-claim token stays pre_claim', () => {
  const view = assembleHomeownerLedgerView({ ok: true, token: token({ claim_id: null }), claim: null }, {});
  assert.equal(view.mode, 'pre_claim');
  assert.deepEqual(view.pending_endorsements, []);
});

test('a staging SQL 73 document (raw sign_url per insured) is sanitized', () => {
  const view = assembleHomeownerLedgerView({
    ok: true,
    mode: 'claim',
    token: token({ homeowner_email: '' }),
    homeowner: { name: 'Ada Lovelace', email: '' },
    claim: { id: CLAIM_A },
    pending_endorsements: [{
      check_id: CHECK_A,
      check_number: '271682',
      check_amount: 10,
      parties: [
        { endorsement_id: 'e-1', payee_type: 'insured', payee_name: 'JOHN SMITH', is_homeowner: true, sign_url: '/endorse?token=tok-john' },
        { endorsement_id: 'e-2', payee_type: 'insured', payee_name: 'JANE SMITH', is_homeowner: true, sign_url: '/endorse?token=tok-jane' },
        { endorsement_id: 'e-3', payee_type: 'mortgage_company', payee_name: 'Bank', sign_url: '/endorse?token=tok-bank' },
      ],
    }],
  }, {});
  const parties = view.pending_endorsements[0].parties;
  assert.deepEqual(parties.map((p) => p.can_sign), [false, false, false]);
  assert.deepEqual(parties.map((p) => p.sign_url), [null, null, null]);
  assert.doesNotMatch(JSON.stringify(view), /tok-john|tok-jane|tok-bank/);
});

test('a sole open insured on the check is actionable even when email and name miss', () => {
  const view = assembleHomeownerLedgerView({
    ok: true,
    mode: 'claim',
    token: token({ homeowner_email: 'invite@example.com' }),
    homeowner: { name: 'Freedom Invite', email: 'invite@example.com' },
    claim: { id: CLAIM_A },
    pending_endorsements: [{
      check_id: CHECK_A,
      parties: [
        { endorsement_id: 'e-1', payee_type: 'insured', payee_name: 'JOHN SMITH AND JANE SMITH', is_homeowner: false },
        { endorsement_id: 'e-2', payee_type: 'mortgage_company', payee_name: 'Bank' },
      ],
    }],
  }, {});
  const [insured, mortgage] = view.pending_endorsements[0].parties;
  assert.equal(insured.can_sign, true);
  assert.equal(mortgage.can_sign, false);
});

test('app-services routes the two new doorways and they fail closed before the database', async () => {
  for (const name of ['homeowner-ledger-endorse-link', 'homeowner-ledger-document-sign-link']) {
    const result = await handleAppServiceRequest({ body: '{}' }, `/functions/v1/${name}`, 'POST');
    assert.equal(result.ok, false, name);
    assert.equal(result.statusCode, 400, name);
    assert.equal(result.error, 'missing_fields', name);
  }
  const retired = await handleAppServiceRequest(
    { body: JSON.stringify({ token: 'ledger-token-value', signer_id: CHECK_A }) },
    '/functions/v1/homeowner-ledger-sign-link',
    'POST',
  );
  assert.equal(retired.statusCode, 410);
  assert.equal(retired.error, 'sign_link_retired');
});
