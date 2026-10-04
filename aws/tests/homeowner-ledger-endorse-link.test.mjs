/**
 * Homeowner ledger endorse-link authorization.
 * Reuses existing /endorse + check_endorsements. Does not remint document signers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isHomeownerEndorsementParty,
  pendingEndorsementsForHomeowner,
  runHomeownerLedgerEndorseLink,
  safeHomeownerReturnTo,
  sanitizePendingEndorsementsForHomeowner,
} from '../functions/api/homeowner.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const CHECK_A = '33333333-3333-4333-8333-333333333331';
const ENDORSE_INSURED = '55555555-5555-4555-8555-555555555551';
const ENDORSE_MORTGAGE = '55555555-5555-4555-8555-555555555552';
const ENDORSE_CONTRACTOR = '55555555-5555-4555-8555-555555555553';
const ENDORSE_PA = '55555555-5555-4555-8555-555555555554';
const ENDORSE_OTHER_CLAIM = '55555555-5555-4555-8555-555555555559';
const LEDGER_TOKEN = 'ledger-token-homeowner-aaa';

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

const claimDoc = (overrides = {}) => {
  const { token, homeowner, ...rest } = overrides;
  return {
    ok: true,
    mode: 'claim',
    token: {
      id: 'tok-1',
      tenant_id: TENANT_A,
      claim_id: CLAIM_A,
      homeowner_email: 'ada@example.com',
      homeowner_name: 'Ada Lovelace',
      ...token,
    },
    homeowner: {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      ...homeowner,
    },
    claim: { id: CLAIM_A, claim_number: 'CL-100', org_id: TENANT_A },
    ...rest,
  };
};

const endorsementRow = (overrides = {}) => ({
  id: ENDORSE_INSURED,
  check_id: CHECK_A,
  payee_name: 'Ada Lovelace',
  payee_type: 'insured',
  status: 'sent',
  token: 'existing-endorse-token',
  contact_email: 'ada@example.com',
  signed_at: null,
  tenant_id: TENANT_A,
  revoked_at: null,
  check_tenant_id: TENANT_A,
  check_claim_id: CLAIM_A,
  ...overrides,
});

const mintClient = ({ doc = claimDoc(), row = endorsementRow(), updates = [] } = {}) => sqlClient([
  {
    match: (sql) => sql.includes('aws_public_homeowner_ledger_by_token'),
    result: () => ({ rows: [{ doc }] }),
  },
  {
    match: (sql) => sql.includes('FROM public.check_endorsements'),
    result: () => ({ rows: row ? [row] : [] }),
  },
  {
    match: (sql) => sql.includes('UPDATE public.check_endorsements'),
    result: (_params, compact) => {
      updates.push(compact);
      return { rows: [], rowCount: 1 };
    },
  },
]);

test('class A registry includes homeowner-ledger-endorse-link and not remint', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('homeowner-ledger-endorse-link'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('homeowner-ledger-sign-link'), true);
  const services = fs.readFileSync(path.join(ROOT, 'aws/functions/api/app-services.mjs'), 'utf8');
  assert.match(services, /handleHomeownerLedgerEndorseLink/);
  assert.doesNotMatch(services, /aws_public_homeowner_ledger_remint_signer/);
});

test('empty homeowner email is not a match-all for insured parties', () => {
  assert.equal(isHomeownerEndorsementParty({
    payee_type: 'insured',
    payee_name: 'Someone Else',
    contact_email: 'other@example.com',
  }, { name: 'Ada Lovelace', email: '' }), false);
  assert.equal(isHomeownerEndorsementParty({
    payee_type: 'insured',
    payee_name: 'Ada Lovelace',
    contact_email: 'other@example.com',
  }, { name: 'Ada Lovelace', email: '' }), true);
  assert.equal(isHomeownerEndorsementParty({
    payee_type: 'mortgage_company',
    payee_name: 'Ada Lovelace',
    contact_email: 'ada@example.com',
  }, { name: 'Ada Lovelace', email: 'ada@example.com' }), false);
});

test('SQL73 empty-email is_homeowner match-all is ignored and raw tokens are stripped', () => {
  const sanitized = sanitizePendingEndorsementsForHomeowner([{
    check_id: CHECK_A,
    check_number: '1001',
    check_amount: 10,
    parties: [
      {
        endorsement_id: 'e-other',
        payee_name: 'Other Person',
        payee_type: 'insured',
        status: 'sent',
        is_homeowner: true,
        sign_url: '/endorse?token=leak-other',
      },
      {
        endorsement_id: 'e-ada',
        payee_name: 'Ada Lovelace',
        payee_type: 'insured',
        status: 'sent',
        is_homeowner: true,
        sign_url: '/endorse?token=leak-ada',
      },
      {
        endorsement_id: 'e-mtg',
        payee_name: 'First National',
        payee_type: 'mortgage_company',
        status: 'sent',
        is_homeowner: false,
        sign_url: '/endorse?token=leak-mtg',
      },
    ],
  }], { name: 'Ada Lovelace', email: '' });
  assert.equal(sanitized[0].parties[0].is_homeowner, false);
  assert.equal(sanitized[0].parties[0].can_sign, false);
  assert.equal(sanitized[0].parties[0].sign_url, null);
  assert.equal(sanitized[0].parties[1].is_homeowner, true);
  assert.equal(sanitized[0].parties[1].can_sign, true);
  assert.equal(sanitized[0].parties[1].sign_url, null);
  assert.equal(sanitized[0].parties[2].can_sign, false);
  assert.equal(sanitized[0].parties[2].sign_url, null);
  assert.doesNotMatch(JSON.stringify(sanitized), /leak-other|leak-ada|leak-mtg/);
});

test('pending helper never embeds endorsement tokens', () => {
  const pending = pendingEndorsementsForHomeowner({
    checks: [{ id: CHECK_A, check_number: '9', amount: 10 }],
    homeowner: { name: 'Ada Lovelace', email: 'ada@example.com' },
    endorsements: [
      {
        id: ENDORSE_INSURED,
        check_id: CHECK_A,
        payee_type: 'insured',
        payee_name: 'Ada Lovelace',
        contact_email: 'ada@example.com',
        status: 'sent',
        request_sent_at: '2026-10-01T00:00:00Z',
        token: 'ins-token-secret',
      },
      {
        id: ENDORSE_MORTGAGE,
        check_id: CHECK_A,
        payee_type: 'mortgage_company',
        payee_name: 'Bank',
        status: 'sent',
        request_sent_at: '2026-10-01T00:00:00Z',
        token: 'mtg-token-secret',
      },
    ],
  });
  assert.equal(pending[0].parties[0].can_sign, true);
  assert.equal(pending[0].parties[0].sign_url, null);
  assert.doesNotMatch(JSON.stringify(pending), /ins-token-secret|mtg-token-secret/);
});

test('return_to allowlist is ledger-only and rejects open redirects', () => {
  assert.equal(safeHomeownerReturnTo('', LEDGER_TOKEN), `/h/ledger/${LEDGER_TOKEN}`);
  assert.equal(safeHomeownerReturnTo(`/h/ledger/${LEDGER_TOKEN}`, LEDGER_TOKEN), `/h/ledger/${LEDGER_TOKEN}`);
  assert.equal(safeHomeownerReturnTo(`/ledger/${LEDGER_TOKEN}`, LEDGER_TOKEN), `/ledger/${LEDGER_TOKEN}`);
  assert.equal(safeHomeownerReturnTo('https://evil.example/phish', LEDGER_TOKEN), null);
  assert.equal(safeHomeownerReturnTo('//evil.example', LEDGER_TOKEN), null);
  assert.equal(safeHomeownerReturnTo(`/h/ledger/${LEDGER_TOKEN}/../evil`, LEDGER_TOKEN), null);
  assert.equal(safeHomeownerReturnTo('/h/ledger/other-token-value', LEDGER_TOKEN), null);
  assert.equal(safeHomeownerReturnTo('/checks', LEDGER_TOKEN), null);
});

test('mint returns existing endorsement token for the authorized insured row', async () => {
  const result = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(
    result.sign_url,
    `/endorse?token=existing-endorse-token&return_to=${encodeURIComponent(`/h/ledger/${LEDGER_TOKEN}`)}`,
  );
  assert.equal(result.return_to, `/h/ledger/${LEDGER_TOKEN}`);
  assert.equal(result.endorsement_id, ENDORSE_INSURED);
  assert.doesNotMatch(JSON.stringify(result), /remint|\/sign\?token=/);
});

test('mint creates a token only when the endorsement row has none', async () => {
  const updates = [];
  const result = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient({
      row: endorsementRow({ token: null }),
      updates,
    }),
  });
  assert.equal(result.ok, true);
  assert.match(result.sign_url, /^\/endorse\?token=[0-9a-f-]{36}&return_to=/i);
  assert.equal(updates.length, 1);
});

test('cross-tenant endorsement id fails closed', async () => {
  const result = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient({
      row: endorsementRow({
        check_tenant_id: TENANT_B,
        tenant_id: TENANT_B,
      }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.error, 'not_found');
  assert.equal(result.sign_url, undefined);
});

test('cross-claim endorsement id fails closed', async () => {
  const result = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_OTHER_CLAIM,
    spoof: {},
    client: mintClient({
      row: endorsementRow({
        id: ENDORSE_OTHER_CLAIM,
        check_claim_id: CLAIM_B,
      }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.error, 'not_found');
});

test('URL id swap onto another tenant row fails closed', async () => {
  const result = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient({
      row: endorsementRow({
        tenant_id: TENANT_B,
        check_tenant_id: TENANT_A,
        check_claim_id: CLAIM_A,
      }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.error, 'not_found');
});

test('mortgage, contractor, and public adjuster cannot mint a homeowner signing link', async () => {
  for (const row of [
    endorsementRow({ id: ENDORSE_MORTGAGE, payee_type: 'mortgage_company', payee_name: 'Bank' }),
    endorsementRow({ id: ENDORSE_CONTRACTOR, payee_type: 'contractor', payee_name: 'Roofer' }),
    endorsementRow({ id: ENDORSE_PA, payee_type: 'public_adjuster', payee_name: 'PA' }),
  ]) {
    const result = await runHomeownerLedgerEndorseLink({
      token: LEDGER_TOKEN,
      endorsementId: row.id,
      spoof: {},
      client: mintClient({ row }),
    });
    assert.equal(result.ok, false, row.payee_type);
    assert.equal(result.statusCode, 403, row.payee_type);
    assert.equal(result.error, 'not_your_signature', row.payee_type);
  }
});

test('completed and cancelled requirements cannot mint a usable signing link', async () => {
  const signed = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient({ row: endorsementRow({ status: 'signed', signed_at: '2026-10-01T00:00:00Z' }) }),
  });
  assert.equal(signed.ok, false);
  assert.equal(signed.statusCode, 409);
  assert.equal(signed.error, 'already_signed');

  const cancelled = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient({ row: endorsementRow({ status: 'cancelled' }) }),
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.statusCode, 403);
  assert.equal(cancelled.error, 'invalid_state');

  const revoked = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient({ row: endorsementRow({ status: 'sent', revoked_at: '2026-10-01T00:00:00Z' }) }),
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.statusCode, 403);
  assert.equal(revoked.error, 'invalid_state');
});

test('revoked or claimless ledger tokens cannot mint', async () => {
  const revoked = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient({ doc: { error: 'revoked' } }),
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.statusCode, 410);
  assert.equal(revoked.error, 'revoked');

  const noClaim = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient({
      doc: claimDoc({ token: { id: 'tok-1', tenant_id: TENANT_A, claim_id: null } }),
    }),
  });
  assert.equal(noClaim.ok, false);
  assert.equal(noClaim.statusCode, 404);
  assert.equal(noClaim.error, 'no_claim');
});

test('empty-email homeowner cannot mint another insured party', async () => {
  const result = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient({
      doc: claimDoc({
        token: { homeowner_email: null, homeowner_name: 'Ada Lovelace' },
        homeowner: { name: 'Ada Lovelace', email: '' },
      }),
      row: endorsementRow({
        payee_name: 'Other Insured',
        contact_email: 'other@example.com',
      }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'not_your_signature');
});

test('source still does not call remint or rewrite SQL73', () => {
  const handler = fs.readFileSync(path.join(ROOT, 'aws/functions/api/homeowner.mjs'), 'utf8');
  const sql73 = fs.readFileSync(
    path.join(ROOT, 'aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql'),
    'utf8',
  );
  const page = fs.readFileSync(path.join(ROOT, 'src/pages/HomeownerLedger.tsx'), 'utf8');
  const endorse = fs.readFileSync(path.join(ROOT, 'src/pages/Endorse.tsx'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
  assert.match(handler, /runHomeownerLedgerEndorseLink/);
  assert.match(handler, /pending_signatures: \[\]/);
  assert.match(handler, /aws_public_homeowner_ledger_remint_signer/);
  assert.doesNotMatch(handler, /CHANGED_BY_SQL73_LAST_VIEWED/);
  assert.match(sql73, /Does NOT rewrite historical aws\/workflows\/sql\/72_homeowner_ledger_view_claim_ok\.sql/);
  assert.match(page, /Review & Sign Check/);
  assert.match(page, /Your signature completed/);
  assert.match(page, /homeowner-ledger-endorse-link/);
  assert.doesNotMatch(page, /window\.open\(p\.sign_url/);
  assert.match(endorse, /Return to Homeowner Ops/);
  assert.match(endorse, /safeHomeownerReturnTo/);
  assert.match(app, /path="\/h\/ledger\/:token"/);
  assert.match(app, /path="\/ledger\/:token"/);
});
