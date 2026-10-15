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
  assembleHomeownerLedgerView,
  handleHomeownerLedgerEndorseLink,
  homeownerNameMatches,
  handleHomeownerLedgerSignLink,
  isHomeownerEndorsementParty,
  openInsuredCountFromPendingEndorsements,
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

const capabilityFrom = ({
  doc = claimDoc(),
  row = endorsementRow(),
  openInsuredCount = 1,
  mintedToken = 'minted-endorse-token',
} = {}) => {
  if (doc?.error) return { ok: false, error: doc.error };
  if (!doc?.token?.claim_id) return { ok: false, error: 'no_claim' };
  if (!row) return { ok: false, error: 'not_found' };
  if (String(row.check_tenant_id) !== String(doc.token.tenant_id)
    || String(row.check_claim_id) !== String(doc.token.claim_id)) {
    return { ok: false, error: 'not_found' };
  }
  if (row.tenant_id != null && String(row.tenant_id) !== String(doc.token.tenant_id)) {
    return { ok: false, error: 'not_found' };
  }
  if (String(row.payee_type || '') !== 'insured') {
    return { ok: false, error: 'not_your_signature' };
  }
  const homeowner = {
    name: doc.homeowner?.name ?? doc.token?.homeowner_name ?? '',
    email: doc.homeowner?.email ?? doc.token?.homeowner_email ?? '',
  };
  if (!isHomeownerEndorsementParty(row, homeowner, { openInsuredCount })) {
    return { ok: false, error: 'not_your_signature' };
  }
  const status = String(row.status || '').toLowerCase();
  if (row.signed_at || ['signed', 'waived', 'endorsed', 'completed', 'complete'].includes(status)) {
    return { ok: false, error: 'already_signed' };
  }
  if (row.revoked_at || ['cancelled', 'canceled', 'rejected', 'revoked', 'expired', 'voided'].includes(status)) {
    return { ok: false, error: 'invalid_state' };
  }
  return {
    ok: true,
    endorsement_id: row.id,
    check_id: row.check_id,
    endorse_token: row.token || mintedToken,
  };
};

const mintClient = ({
  doc = claimDoc(),
  row = endorsementRow(),
  openInsuredCount = 1,
  mintedToken = 'minted-endorse-token',
} = {}) => sqlClient([
  {
    match: (sql) => sql.includes('aws_public_homeowner_ledger_endorse_capability'),
    result: () => ({ rows: [{ doc: capabilityFrom({ doc, row, openInsuredCount, mintedToken }) }] }),
  },
]);

test('class A registry includes homeowner-ledger-endorse-link and not remint', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('homeowner-ledger-endorse-link'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('homeowner-ledger-document-sign-link'), true);
  assert.equal(CLASS_A_FUNCTIONS.has('homeowner-ledger-sign-link'), true);
  const services = fs.readFileSync(path.join(ROOT, 'aws/functions/api/app-services.mjs'), 'utf8');
  assert.match(services, /handleHomeownerLedgerEndorseLink/);
  assert.match(services, /handleHomeownerLedgerDocumentSignLink/);
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
  // Sole-insured fallback only when nothing contradicts it.
  assert.equal(isHomeownerEndorsementParty({
    payee_type: 'insured',
    payee_name: '',
    contact_email: '',
  }, { name: 'Ada Lovelace', email: '' }, { openInsuredCount: 1 }), true);
  assert.equal(isHomeownerEndorsementParty({
    payee_type: 'insured',
    payee_name: '',
    contact_email: '',
  }, { name: 'Ada Lovelace', email: '' }, { openInsuredCount: 2 }), false);
  assert.equal(isHomeownerEndorsementParty({
    payee_type: 'insured',
    payee_name: 'Joint Payee Line',
    contact_email: '',
  }, { name: 'Ada Lovelace', email: '' }, { openInsuredCount: 1 }), false, 'payee name contradicts');
  assert.equal(isHomeownerEndorsementParty({
    payee_type: 'insured',
    payee_name: '',
    contact_email: 'bob@example.com',
  }, { name: 'Ada Lovelace', email: 'ada@example.com' }, { openInsuredCount: 1 }), false, 'email contradicts');
  assert.equal(isHomeownerEndorsementParty({
    payee_type: 'insured',
    payee_name: '',
    contact_email: ' ADA@example.com ',
  }, { name: '', email: 'ada@example.com' }, { openInsuredCount: 2 }), true, 'trimmed, case-folded email');
});

test('name match needs every homeowner name part as a whole word', () => {
  assert.equal(homeownerNameMatches('John Smith', 'JOHN SMITH'), true);
  assert.equal(homeownerNameMatches('John Smith', 'SMITH, JOHN'), true);
  assert.equal(homeownerNameMatches('John Smith', 'JOHN SMITH AND JANE SMITH'), true);
  assert.equal(homeownerNameMatches('John Smith', 'JANE SMITH'), false);
  assert.equal(homeownerNameMatches('Ada Lovelace', 'ADAM LOVELACE'), false);
  assert.equal(homeownerNameMatches('Ada', 'Adam'), false);
  assert.equal(homeownerNameMatches('Jo Li', 'JO LI'), true);
  assert.equal(homeownerNameMatches('Bo Smith', 'JOHN SMITH'), false);
  assert.equal(homeownerNameMatches('Smith', 'JOHN SMITH'), false);
  assert.equal(homeownerNameMatches('', 'Anyone'), false);
  assert.equal(isHomeownerEndorsementParty(
    { payee_type: 'insured', payee_name: 'JANE SMITH', contact_email: 'jane@example.com' },
    { name: 'John Smith', email: 'john@example.com' },
    { openInsuredCount: 2 },
  ), false);
});

test('SQL 82 empty-email is_homeowner match-all is ignored and raw tokens are stripped', () => {
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

test('ledger view never embeds endorsement tokens or contact emails', () => {
  const view = assembleHomeownerLedgerView(claimDoc({
    pending_endorsements: [{
      check_id: CHECK_A,
      check_number: '9',
      check_amount: 10,
      token: 'check-level-secret',
      parties: [
        {
          endorsement_id: ENDORSE_INSURED,
          payee_type: 'insured',
          payee_name: 'Ada Lovelace',
          contact_email: 'ada@example.com',
          status: 'sent',
          sent_at: '2026-10-01T00:00:00Z',
          is_homeowner: true,
          token: 'ins-token-secret',
          sign_url: '/endorse?token=ins-token-secret',
        },
        {
          endorsement_id: ENDORSE_MORTGAGE,
          payee_type: 'mortgage_company',
          payee_name: 'Bank',
          contact_email: 'loss-draft@bank.example',
          status: 'sent',
          token: 'mtg-token-secret',
          sign_url: '/endorse?token=mtg-token-secret',
        },
      ],
    }],
    pending_signatures: [{ request_id: 'rpc-row', signers: [{ access_token: 'rpc-access-secret' }] }],
  }), {});
  assert.equal(view.ok, true);
  assert.equal(view.pending_endorsements[0].parties[0].can_sign, true);
  assert.equal(view.pending_endorsements[0].parties[0].sign_url, null);
  assert.equal(view.pending_endorsements[0].parties[1].can_sign, false);
  assert.deepEqual(view.pending_signatures, []);
  assert.deepEqual(Object.keys(view.pending_endorsements[0]).sort(), ['check_amount', 'check_id', 'check_number', 'parties']);
  assert.doesNotMatch(
    JSON.stringify(view),
    /ins-token-secret|mtg-token-secret|check-level-secret|rpc-access-secret|loss-draft@bank|"token":"|contact_email/,
  );
});

test('ledger view attaches only the Lambda-loaded pending signatures', () => {
  const loaded = [{ request_id: 'r-1', document_name: 'Proof of Loss', signers: [] }];
  const view = assembleHomeownerLedgerView(claimDoc({
    pending_signatures: [{ request_id: 'rpc-row' }],
  }), {}, { pendingSignatures: loaded });
  assert.deepEqual(view.pending_signatures, loaded);
  assert.equal(view.allow_deductible_payment, false);
  assert.equal(view.money, null);
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
  const result = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient({
      row: endorsementRow({ token: null }),
      mintedToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9',
    }),
  });
  assert.equal(result.ok, true);
  assert.match(result.sign_url, /^\/endorse\?token=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9&return_to=/i);
});

test('a sole insured whose payee name contradicts the homeowner is not actionable', () => {
  const pending = [{
    check_id: CHECK_A,
    check_number: '271682',
    check_amount: 9634.82,
    parties: [{
      endorsement_id: ENDORSE_INSURED,
      payee_name: 'JOHN SMITH AND JANE SMITH',
      payee_type: 'insured',
      status: 'sent',
      is_homeowner: false,
    }],
  }];
  const counts = openInsuredCountFromPendingEndorsements(pending);
  assert.equal(counts[CHECK_A], 1);
  const sanitized = sanitizePendingEndorsementsForHomeowner(
    pending,
    { name: 'Ada Lovelace', email: 'invite@example.com' },
    counts,
  );
  assert.equal(sanitized[0].parties[0].can_sign, false);
  assert.equal(sanitized[0].parties[0].sign_url, null);
  // Without a contradicting payee name, the sole sent insured is actionable;
  // an unrequested ('pending') one never is.
  const blank = sanitizePendingEndorsementsForHomeowner(
    [{ ...pending[0], parties: [{ ...pending[0].parties[0], payee_name: '' }] }],
    { name: 'Ada Lovelace', email: 'invite@example.com' },
    counts,
  );
  assert.equal(blank[0].parties[0].can_sign, true);
  const unrequested = sanitizePendingEndorsementsForHomeowner(
    [{ ...pending[0], parties: [{ ...pending[0].parties[0], payee_name: 'Ada Lovelace', status: 'pending' }] }],
    { name: 'Ada Lovelace', email: 'invite@example.com' },
    counts,
  );
  assert.equal(unrequested[0].parties[0].can_sign, false);
});

test('multiple unmatched insureds from SQL 82 pending_endorsements fail closed', () => {
  const pending = [{
    check_id: CHECK_A,
    parties: [
      { endorsement_id: 'e-1', payee_name: 'JOHN SMITH', payee_type: 'insured', status: 'sent' },
      { endorsement_id: 'e-2', payee_name: 'JANE SMITH', payee_type: 'insured', status: 'sent' },
    ],
  }];
  const counts = openInsuredCountFromPendingEndorsements(pending);
  assert.equal(counts[CHECK_A], 2);
  const sanitized = sanitizePendingEndorsementsForHomeowner(
    pending,
    { name: 'Ada Lovelace', email: 'invite@example.com' },
    counts,
  );
  assert.equal(sanitized[0].parties[0].can_sign, false);
  assert.equal(sanitized[0].parties[1].can_sign, false);
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
      openInsuredCount: 2,
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'not_your_signature');
});

test('sole insured with a contradicting payee name or email cannot mint', async () => {
  for (const row of [
    endorsementRow({ payee_name: 'JOHN SMITH AND JANE SMITH', contact_email: '' }),
    endorsementRow({ payee_name: '', contact_email: 'payee@example.com' }),
  ]) {
    const result = await runHomeownerLedgerEndorseLink({
      token: LEDGER_TOKEN,
      endorsementId: ENDORSE_INSURED,
      spoof: {},
      client: mintClient({
        doc: claimDoc({
          token: { homeowner_email: 'invite@example.com', homeowner_name: 'Ada Lovelace' },
          homeowner: { name: 'Ada Lovelace', email: 'invite@example.com' },
        }),
        row,
        openInsuredCount: 1,
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_your_signature');
  }
});

test('sole insured with no contradicting name or email can mint', async () => {
  const result = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient({
      doc: claimDoc({
        token: { homeowner_email: 'invite@example.com', homeowner_name: 'Ada Lovelace' },
        homeowner: { name: 'Ada Lovelace', email: 'invite@example.com' },
      }),
      row: endorsementRow({
        payee_name: '',
        contact_email: '',
        check_number: '271682',
      }),
      openInsuredCount: 1,
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.match(result.sign_url, /^\/endorse\?token=existing-endorse-token/);
});

test('endorse-link handler rejects missing fields before opening the database', async () => {
  for (const body of [{}, { token: 'short', endorsement_id: ENDORSE_INSURED }, { token: LEDGER_TOKEN }]) {
    const result = await handleHomeownerLedgerEndorseLink({ body: JSON.stringify(body) });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.equal(result.error, 'missing_fields');
  }
});

test('non-UUID endorsement ids fail closed without calling the capability', async () => {
  let called = false;
  const client = sqlClient([{
    match: (sql) => sql.includes('aws_public_homeowner_ledger_endorse_capability'),
    result: () => { called = true; return { rows: [{ doc: { ok: true, endorse_token: 'x' } }] }; },
  }]);
  for (const endorsementId of ['1 OR 1=1', '../../etc', 'not-a-uuid']) {
    const result = await runHomeownerLedgerEndorseLink({
      token: LEDGER_TOKEN, endorsementId, spoof: {}, client,
    });
    assert.equal(result.statusCode, 404);
  }
  assert.equal(called, false);
});

test('a capability without ok:true or without a token never yields a link', async () => {
  for (const doc of [null, {}, { ok: false }, { endorse_token: 'tok' }, { ok: true, endorse_token: '' }]) {
    const result = await runHomeownerLedgerEndorseLink({
      token: LEDGER_TOKEN,
      endorsementId: ENDORSE_INSURED,
      spoof: {},
      client: sqlClient([{
        match: (sql) => sql.includes('aws_public_homeowner_ledger_endorse_capability'),
        result: () => ({ rows: [{ doc }] }),
      }]),
    });
    assert.equal(result.ok, false, JSON.stringify(doc));
    assert.equal(result.sign_url, undefined);
  }
});

test('endorse link is relative and return_to is never caller-controlled', async () => {
  const result = await runHomeownerLedgerEndorseLink({
    token: LEDGER_TOKEN,
    endorsementId: ENDORSE_INSURED,
    spoof: {},
    client: mintClient(),
    return_to: 'https://evil.example',
  });
  assert.equal(result.ok, true);
  assert.match(result.sign_url, /^\/endorse\?token=/);
  const returnTo = new URL(result.sign_url, 'https://app.example').searchParams.get('return_to');
  assert.equal(returnTo, `/h/ledger/${LEDGER_TOKEN}`);
});

test('legacy homeowner-ledger-sign-link is retired and never reaches the database', async () => {
  const result = await handleHomeownerLedgerSignLink({
    body: JSON.stringify({ token: LEDGER_TOKEN, signer_id: ENDORSE_INSURED, origin: 'https://evil.example' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 410);
  assert.equal(result.error, 'sign_link_retired');
  assert.doesNotMatch(JSON.stringify(result), /evil\.example|sign_url/);
});

test('source does not call remint and keeps the endorse token out of SQL 82', () => {
  const handler = fs.readFileSync(path.join(ROOT, 'aws/functions/api/homeowner.mjs'), 'utf8');
  const sql82 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/82_homeowner_ledger_view.sql'), 'utf8');
  const sql83 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/83_homeowner_signing_capabilities.sql'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'src/pages/HomeownerLedger.tsx'), 'utf8');
  const endorse = fs.readFileSync(path.join(ROOT, 'src/pages/Endorse.tsx'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8');
  assert.match(handler, /runHomeownerLedgerEndorseLink/);
  assert.match(handler, /aws_public_homeowner_ledger_endorse_capability/);
  assert.match(handler, /openInsuredCountFromPendingEndorsements/);
  assert.doesNotMatch(handler, /SELECT public\.aws_public_homeowner_ledger_remint_signer/);
  assert.doesNotMatch(handler, /UPDATE public\.signature_signers/);
  const sql82Body = sql82.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(sql82Body, /'\/endorse\?token='/);
  assert.doesNotMatch(sql82Body, /e\.token/);
  assert.match(sql82Body, /'sign_url', NULL::text/);
  assert.match(sql83, /Does NOT rewrite historical aws\/workflows\/sql\/82_homeowner_ledger_view\.sql/);
  assert.match(sql83, /aws_public_homeowner_ledger_endorse_capability/);
  assert.doesNotMatch(sql83, /e\.revoked_at/);
  assert.match(page, /Review & Sign Check/);
  assert.doesNotMatch(page, /Your signature completed/);
  assert.match(page, /homeowner-ledger-endorse-link/);
  assert.doesNotMatch(page, /window\.open\(p\.sign_url/);
  assert.doesNotMatch(page, /p\.sign_url/);
  assert.match(endorse, /Return to Homeowner Ops/);
  assert.match(endorse, /safeHomeownerReturnTo/);
  assert.match(app, /path="\/h\/ledger\/:token"/);
  assert.match(app, /path="\/ledger\/:token"/);
});
