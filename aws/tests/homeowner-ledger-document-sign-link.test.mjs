/**
 * Homeowner document doorway authorization.
 * Surfaces claim-scoped Signature Requests and reuses an existing access_token
 * only. Does not remint, rotate token_hash, or call the unsafe remint RPC.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isHomeownerDocumentSigner,
  pendingSignaturesForHomeowner,
  runHomeownerLedgerDocumentSignLink,
} from '../functions/api/homeowner-signing-integration.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const REQUEST_A = '77777777-7777-4777-8777-777777777771';
const SIGNER_HOME = '88888888-8888-4888-8888-888888888881';
const SIGNER_CONTRACTOR = '88888888-8888-4888-8888-888888888882';
const SIGNER_OTHER = '88888888-8888-4888-8888-888888888883';
const LEDGER_TOKEN = 'ledger-token-homeowner-aaa';
const RAW_TOKEN = 'aa'.repeat(32);

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

const signerRow = (overrides = {}) => ({
  id: SIGNER_HOME,
  signer_name: 'Ada Lovelace',
  signer_email: 'ada@example.com',
  signer_type: 'policyholder',
  status: 'pending',
  signed_at: null,
  signing_order: 1,
  expires_at: null,
  access_token: RAW_TOKEN,
  revoked_at: null,
  request_id: REQUEST_A,
  request_status: 'pending',
  document_name: 'Proof of Loss',
  claim_id: CLAIM_A,
  check_intake_item_id: null,
  claim_tenant_id: TENANT_A,
  check_tenant_id: null,
  check_claim_id: null,
  ...overrides,
});

const mintClient = ({
  doc = claimDoc(),
  row = signerRow(),
  siblings = null,
} = {}) => sqlClient([
  {
    match: (sql) => sql.includes('aws_public_homeowner_ledger_by_token'),
    result: () => ({ rows: [{ doc }] }),
  },
  {
    match: (sql) => sql.includes('FROM public.signature_signers s'),
    result: () => ({ rows: row ? [row] : [] }),
  },
  {
    match: (sql) => sql.includes('FROM public.signature_signers') && sql.includes('signature_request_id'),
    result: () => ({
      rows: siblings || [{
        id: row.id,
        signer_type: row.signer_type,
        status: row.status,
        signed_at: row.signed_at,
        signing_order: row.signing_order,
        expires_at: row.expires_at,
        revoked_at: row.revoked_at,
      }],
    }),
  },
]);

test('class A registry includes document-sign-link and not remint', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('homeowner-ledger-document-sign-link'), true);
  const services = fs.readFileSync(path.join(ROOT, 'aws/functions/api/app-services.mjs'), 'utf8');
  assert.match(services, /handleHomeownerLedgerDocumentSignLink/);
  assert.doesNotMatch(services, /aws_public_homeowner_ledger_remint_signer/);
});

test('contractor staff other mortgage and PA are never homeowner document signers', () => {
  for (const signer_type of ['contractor', 'staff', 'other', 'mortgage_company', 'public_adjuster']) {
    assert.equal(isHomeownerDocumentSigner({
      signer_type,
      signer_name: 'Ada Lovelace',
      signer_email: 'ada@example.com',
    }, { name: 'Ada Lovelace', email: 'ada@example.com' }), false, signer_type);
  }
});

test('pending helper surfaces only this homeowner and strips tokens', () => {
  const pending = pendingSignaturesForHomeowner({
    homeowner: { name: 'Ada Lovelace', email: 'ada@example.com' },
    requests: [{
      request_id: REQUEST_A,
      document_name: 'Proof of Loss',
      status: 'pending',
      sent_at: '2026-10-01T00:00:00Z',
      token: 'must-not-leak',
      token_hash: 'hash-leak',
      access_token: RAW_TOKEN,
      signers: [
        {
          signer_id: SIGNER_HOME,
          signer_name: 'Ada Lovelace',
          signer_email: 'ada@example.com',
          signer_type: 'policyholder',
          status: 'pending',
          token: 'signer-token',
          token_hash: 'abc',
          access_token: RAW_TOKEN,
        },
        {
          signer_id: SIGNER_CONTRACTOR,
          signer_name: 'Roofer',
          signer_email: 'roof@example.com',
          signer_type: 'contractor',
          status: 'pending',
          access_token: 'contractor-token',
        },
      ],
    }, {
      request_id: 'contractor-only',
      document_name: 'Contractor packet',
      status: 'pending',
      signers: [{
        signer_id: SIGNER_CONTRACTOR,
        signer_name: 'Roofer',
        signer_email: 'roof@example.com',
        signer_type: 'contractor',
        status: 'pending',
      }],
    }],
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].document_name, 'Proof of Loss');
  assert.equal(pending[0].signers[0].can_sign, true);
  assert.equal(pending[0].signers[1].can_sign, false);
  const encoded = JSON.stringify(pending);
  assert.doesNotMatch(encoded, /must-not-leak|hash-leak|aa{16}|signer-token|contractor-token|token_hash|access_token/);
});

test('completed cancelled and revoked requests are not actionable', () => {
  for (const status of ['completed', 'cancelled', 'revoked', 'expired']) {
    const pending = pendingSignaturesForHomeowner({
      homeowner: { name: 'Ada Lovelace', email: 'ada@example.com' },
      requests: [{
        request_id: REQUEST_A,
        document_name: 'Done',
        status,
        signers: [{
          signer_id: SIGNER_HOME,
          signer_name: 'Ada Lovelace',
          signer_email: 'ada@example.com',
          signer_type: 'policyholder',
          status: 'pending',
        }],
      }],
    });
    assert.equal(pending.length, 0, status);
  }
});

test('reuses an existing access_token without rotating token_hash', async () => {
  const result = await runHomeownerLedgerDocumentSignLink({
    token: LEDGER_TOKEN,
    signerId: SIGNER_HOME,
    spoof: {},
    client: mintClient(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.sign_url, `/sign?token=${encodeURIComponent(RAW_TOKEN)}`);
  assert.equal(result.reused_existing_access_token, true);
  assert.doesNotMatch(JSON.stringify(result), /remint|token_hash|UPDATE public.signature_signers/);
});

test('missing access_token does not mint a replacement', async () => {
  const result = await runHomeownerLedgerDocumentSignLink({
    token: LEDGER_TOKEN,
    signerId: SIGNER_HOME,
    spoof: {},
    client: mintClient({ row: signerRow({ access_token: null }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'existing_email_link_required');
  assert.equal(result.sign_url, undefined);
});

test('cross-tenant and cross-claim document signers fail closed', async () => {
  const crossTenant = await runHomeownerLedgerDocumentSignLink({
    token: LEDGER_TOKEN,
    signerId: SIGNER_HOME,
    spoof: {},
    client: mintClient({
      row: signerRow({ claim_tenant_id: TENANT_B }),
    }),
  });
  assert.equal(crossTenant.ok, false);
  assert.equal(crossTenant.statusCode, 404);

  const crossClaim = await runHomeownerLedgerDocumentSignLink({
    token: LEDGER_TOKEN,
    signerId: SIGNER_OTHER,
    spoof: {},
    client: mintClient({
      row: signerRow({
        id: SIGNER_OTHER,
        claim_id: CLAIM_B,
        check_claim_id: CLAIM_B,
      }),
    }),
  });
  assert.equal(crossClaim.ok, false);
  assert.equal(crossClaim.statusCode, 404);
});

test('multiple unmatched homeowner-type signers fail closed unless specifically matched', () => {
  const pending = pendingSignaturesForHomeowner({
    homeowner: { name: 'Ada Lovelace', email: 'invite@example.com' },
    requests: [{
      request_id: REQUEST_A,
      document_name: 'Joint packet',
      status: 'pending',
      signers: [
        {
          signer_id: SIGNER_HOME,
          signer_name: 'JOHN SMITH',
          signer_email: 'john@example.com',
          signer_type: 'policyholder',
          status: 'pending',
        },
        {
          signer_id: SIGNER_OTHER,
          signer_name: 'JANE SMITH',
          signer_email: 'jane@example.com',
          signer_type: 'insured',
          status: 'pending',
        },
      ],
    }],
  });
  assert.equal(pending.length, 0);

  const sole = pendingSignaturesForHomeowner({
    homeowner: { name: 'Ada Lovelace', email: 'invite@example.com' },
    requests: [{
      request_id: REQUEST_A,
      document_name: 'Sole packet',
      status: 'pending',
      signers: [{
        signer_id: SIGNER_HOME,
        signer_name: 'JOHN SMITH AND JANE SMITH',
        signer_email: 'payee@example.com',
        signer_type: 'policyholder',
        status: 'pending',
      }],
    }],
  });
  assert.equal(sole.length, 1);
  assert.equal(sole[0].signers[0].can_sign, true);
});

test('wrong signer types cannot enter /sign from Homeowner Ops', async () => {
  for (const row of [
    signerRow({ id: SIGNER_CONTRACTOR, signer_type: 'contractor', signer_name: 'Roofer' }),
    signerRow({ id: SIGNER_OTHER, signer_type: 'staff', signer_name: 'Staff' }),
    signerRow({ signer_type: 'other', signer_name: 'Other' }),
    signerRow({ signer_type: 'mortgage_company', signer_name: 'Bank' }),
    signerRow({ signer_type: 'public_adjuster', signer_name: 'PA' }),
  ]) {
    const result = await runHomeownerLedgerDocumentSignLink({
      token: LEDGER_TOKEN,
      signerId: row.id,
      spoof: {},
      client: mintClient({ row }),
    });
    assert.equal(result.ok, false, row.signer_type);
    assert.equal(result.statusCode, 403, row.signer_type);
    assert.equal(result.error, 'not_your_signature', row.signer_type);
  }
});

test('completed cancelled and revoked signers cannot mint', async () => {
  const signed = await runHomeownerLedgerDocumentSignLink({
    token: LEDGER_TOKEN,
    signerId: SIGNER_HOME,
    spoof: {},
    client: mintClient({ row: signerRow({ status: 'signed', signed_at: '2026-10-01T00:00:00Z' }) }),
  });
  assert.equal(signed.ok, false);
  assert.equal(signed.statusCode, 409);

  const cancelled = await runHomeownerLedgerDocumentSignLink({
    token: LEDGER_TOKEN,
    signerId: SIGNER_HOME,
    spoof: {},
    client: mintClient({ row: signerRow({ request_status: 'cancelled' }) }),
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.statusCode, 403);
});

test('source does not call remint or rewrite SQL73 or Sign.tsx', () => {
  const handler = fs.readFileSync(path.join(ROOT, 'aws/functions/api/homeowner.mjs'), 'utf8');
  const integration = fs.readFileSync(path.join(ROOT, 'aws/functions/api/homeowner-signing-integration.mjs'), 'utf8');
  const sql73 = fs.readFileSync(
    path.join(ROOT, 'aws/workflows/sql/73_homeowner_ledger_view_last_viewed_best_effort.sql'),
    'utf8',
  );
  const page = fs.readFileSync(path.join(ROOT, 'src/pages/HomeownerLedger.tsx'), 'utf8');
  const sign = fs.readFileSync(path.join(ROOT, 'src/pages/Sign.tsx'), 'utf8');
  const esign = fs.readFileSync(path.join(ROOT, 'aws/functions/api/esign.mjs'), 'utf8');
  const submit = fs.readFileSync(path.join(ROOT, 'aws/functions/api/signature-submit.mjs'), 'utf8');
  assert.match(handler, /runHomeownerLedgerDocumentSignLink/);
  assert.match(handler, /pending_signatures: \[\]/);
  assert.doesNotMatch(integration, /SELECT public\.aws_public_homeowner_ledger_remint_signer/);
  assert.doesNotMatch(integration, /UPDATE public.signature_signers/);
  assert.match(sql73, /pending_signatures', '\[\]'::jsonb/);
  assert.match(page, /Review & Sign Document/);
  assert.match(page, /homeowner-ledger-document-sign-link/);
  assert.doesNotMatch(page, /homeowner-ledger-sign-link/);
  assert.doesNotMatch(sign, /CHANGED_BY_HOMEOWNER_DOCUMENT_DOORWAY/);
  assert.doesNotMatch(esign, /CHANGED_BY_HOMEOWNER_DOCUMENT_DOORWAY/);
  assert.doesNotMatch(submit, /CHANGED_BY_HOMEOWNER_DOCUMENT_DOORWAY/);
});
