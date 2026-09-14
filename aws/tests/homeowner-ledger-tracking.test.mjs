import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleHomeownerLedgerUpload, runHomeownerLedgerSend } from '../functions/api/homeowner.mjs';
import { applyRecipientPolicy, emailMode } from '../functions/api/email-policy.mjs';
import { sendViaSesOrSink } from '../functions/api/email.mjs';
import { deliverAuditedEmail } from '../functions/api/email-audited.mjs';
import {
  canMintHomeownerSignLink,
  computeHomeownerLedgerTotals,
  homeownerLedgerTrackingUrl,
  ledgerUploadInsertValues,
  presentHomeownerLedgerView,
  runHomeownerLedgerSignLink,
  runHomeownerLedgerView,
} from '../functions/api/homeowner-ledger-public.mjs';
import { sql71EmailAuditHandle } from './sql71-email-audit-mock.mjs';
import { isPublicTokenRoute } from '../../src/lib/publicTokenRoutes.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = '55555555-5555-4555-8555-555555555555';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHECK_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TOKEN_A = 'aa'.repeat(24);
const TOKEN_B = 'bb'.repeat(24);
const TOKEN_ID_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TOKEN_ID_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SIGNER_A = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SIGNER_B = '99999999-9999-4999-8999-999999999999';
const SIGNER_OTHER_EMAIL = '88888888-8888-4888-8888-888888888888';
const DOC_A = '77777777-7777-4777-8777-777777777777';
const REQ_A = '66666666-6666-4666-8666-666666666666';
const ENDO_A = '55555555-5555-4555-8555-555555555555';
const HOMEOWNER = 'ada@example.com';
const OTHER_EMAIL = 'other@example.com';

const mapping = { application_user_id: USER };
const spoof = { ignored: true };

const LOCK = 'mcarletta@freedomadj.com';
const C1C_FROM = 'noreply@ses-gate.staging.checksops.com';
const C1C_REPLY = 'payments@condition1commercial.com';
const C1C_NAME = 'Condition One Commercial';
const C1C_DOMAIN = 'ses-gate.staging.checksops.com';

const sqlClient = (handlers) => {
  const logs = new Map();
  return {
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
      const audit = sql71EmailAuditHandle({ logs })(compact, params);
      if (audit) return audit;
      for (const handler of handlers) {
        if (handler.match(compact, params)) return handler.result(params, compact);
      }
      if (compact.includes('FROM public.tenants')) {
        return {
          rows: [{
            id: TENANT_A,
            name: C1C_NAME,
            logo_url: null,
            primary_color: '#1a56db',
            email_from_name: C1C_NAME,
            email_from_address: C1C_FROM,
            email_reply_to: C1C_REPLY,
            is_system_tenant: false,
          }],
        };
      }
      if (compact.includes('FROM public.tenant_email_settings')) {
        return {
          rows: [{
            from_name: C1C_NAME,
            reply_to: C1C_REPLY,
            sending_mode: 'custom',
            sending_domain: C1C_DOMAIN,
            from_address: C1C_FROM,
            domain_status: 'verified',
            ses_identity_name: C1C_DOMAIN,
            custom_sending_enabled: true,
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
};

const capturingMailer = (sent) => async (payload) => {
  sent.push(payload);
  return {
    deliveredCount: 0,
    sunkCount: 1,
    mode: process.env.AWS_EMAIL_MODE || 'sink',
    results: [{
      delivery: 'sink',
      status: 'sunk',
      policy: 'staging_sink',
      messageId: `sink-${sent.length}`,
      originalTo: payload.to,
    }],
  };
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const ledgerSendClient = ({
  logs = new Map(),
  failIdempotencySelect = false,
  failInsert = false,
  existingToken = null,
  updates = [],
  inserts = [],
} = {}) => {
  const calls = [];
  const client = {
    calls,
    logs,
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: compact, params });
      const audit = sql71EmailAuditHandle({
        logs,
        failPeek: failIdempotencySelect,
        failReserve: failInsert,
      })(compact, params);
      if (audit) return audit;
      if (
        compact.startsWith('SAVEPOINT ')
        || compact.startsWith('RELEASE SAVEPOINT ')
        || compact.startsWith('ROLLBACK TO SAVEPOINT ')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (compact.includes('FROM public.tenant_users')) {
        return { rows: [{ tenant_id: TENANT_A }] };
      }
      if (compact.includes('FROM public.tenants')) {
        return {
          rows: [{
            id: TENANT_A,
            name: C1C_NAME,
            logo_url: null,
            primary_color: '#1a56db',
            email_from_name: C1C_NAME,
            email_from_address: C1C_FROM,
            email_reply_to: C1C_REPLY,
            is_system_tenant: false,
          }],
        };
      }
      if (compact.includes('FROM public.tenant_email_settings')) {
        return {
          rows: [{
            from_name: C1C_NAME,
            reply_to: C1C_REPLY,
            sending_mode: 'custom',
            sending_domain: C1C_DOMAIN,
            from_address: C1C_FROM,
            domain_status: 'verified',
            ses_identity_name: C1C_DOMAIN,
            custom_sending_enabled: true,
          }],
        };
      }
      if (failIdempotencySelect && compact.includes('FROM public.email_send_log') && compact.includes('idempotency_key')) {
        throw new Error('email_send_log unavailable');
      }
      if (compact.includes('FROM public.email_send_log') && compact.includes('WHERE idempotency_key')) {
        const key = String(params[0] || '');
        const row = logs.get(key);
        return { rows: row ? [row] : [] };
      }
      if (compact.startsWith('INSERT INTO public.email_send_log')) {
        if (failInsert) throw new Error('email_send_log insert failed');
        const pending = compact.includes("'pending'");
        const key = String(params[pending ? 5 : 7] || '');
        if (key && logs.has(key)) {
          const error = new Error('duplicate key');
          error.code = '23505';
          throw error;
        }
        const id = String(params[0]);
        const metadataRaw = pending ? params[6] : params[9];
        let metadata = {};
        try {
          metadata = typeof metadataRaw === 'string' ? JSON.parse(metadataRaw) : (metadataRaw || {});
        } catch {
          metadata = {};
        }
        const row = {
          id,
          status: pending ? 'pending' : String(params[4] || 'sunk'),
          provider_message_id: pending ? null : (params[6] || null),
          recipient_email: params[2],
          tenant_id: params[3],
          template_name: params[1],
          provider: pending ? params[4] : params[5],
          metadata,
          error_message: pending ? null : (params[8] || null),
          idempotency_key: key,
        };
        if (key) logs.set(key, row);
        return { rows: [], rowCount: 1 };
      }
      if (compact.startsWith('UPDATE public.email_send_log')) {
        const id = String(params[0]);
        for (const row of logs.values()) {
          if (row.id === id) {
            row.status = params[1];
            row.provider_message_id = params[2];
            row.error_message = params[3];
            try {
              row.metadata = typeof params[4] === 'string' ? JSON.parse(params[4]) : (params[4] || row.metadata);
            } catch {
              row.metadata = row.metadata || {};
            }
          }
        }
        return { rows: [], rowCount: 1 };
      }
      if (compact.includes('FROM public.homeowner_ledger_tokens') && compact.includes('lower(trim(homeowner_email))')) {
        if (!existingToken) return { rows: [] };
        if (String(params[2]).toLowerCase() === String(existingToken.email).toLowerCase()
          && String(params[1]) === String(existingToken.claimId || CLAIM_A)) {
          return { rows: [{ id: existingToken.id, token: existingToken.token }] };
        }
        return { rows: [] };
      }
      if (compact.startsWith('UPDATE public.homeowner_ledger_tokens')) {
        updates.push({ sql: compact, params });
        return { rows: [], rowCount: 1 };
      }
      if (compact.includes('INSERT INTO public.homeowner_ledger_tokens')) {
        inserts.push({ sql: compact, params });
        const token = String(params[2]);
        return { rows: [{ id: TOKEN_ID_A, token }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
};

const claimBundle = ({
  token = TOKEN_A,
  tokenId = TOKEN_ID_A,
  tenantId = TENANT_A,
  claimId = CLAIM_A,
  email = HOMEOWNER,
  extraEvent = null,
} = {}) => ({
  ok: true,
  tenant_id: tenantId,
  token: {
    id: tokenId,
    claim_id: claimId,
    homeowner_email: email,
    homeowner_name: 'Ada Lovelace',
    tenant_id: tenantId,
  },
  claim: {
    id: claimId,
    claim_number: claimId === CLAIM_A ? 'CL-A' : 'CL-B',
    property_address: '1 Claim St',
    loss_type: 'wind',
    status: 'open',
    created_at: '2026-01-01T00:00:00.000Z',
    tenant_id: tenantId,
  },
  events: [
    {
      id: 'evt-1',
      check_id: CHECK_A,
      event_type: 'check_received',
      occurred_at: '2026-01-02T00:00:00.000Z',
      amount: 1000,
      actor_label: 'ChecksOps',
      payload_json: { check_number: '1001', tenant_id: tenantId, secret: 'nope' },
    },
    extraEvent,
  ].filter(Boolean),
  checks: [{ id: CHECK_A, amount: 1000, check_stage: 'deposited', check_number: '1001' }],
  splits: [{ amount: 400, status: 'sent' }],
  disbursements: [{ amount: 100, status: 'completed' }],
  signature_requests: [{
    id: REQ_A,
    document_name: 'Release',
    sent_at: '2026-01-03T00:00:00.000Z',
    signers: [
      {
        id: SIGNER_A,
        signer_name: 'Ada Lovelace',
        signer_email: email,
        status: 'pending',
        signed_at: null,
      },
      {
        id: SIGNER_OTHER_EMAIL,
        signer_name: 'First National',
        signer_email: 'bank@example.com',
        status: 'pending',
        signed_at: null,
      },
    ],
  }],
  endorsements: [{
    id: ENDO_A,
    check_id: CHECK_A,
    payee_name: 'Ada Lovelace',
    payee_type: 'insured',
    status: 'sent',
    token: 'endo-token',
    contact_email: email,
    signed_at: null,
    request_sent_at: '2026-01-03T00:00:00.000Z',
  }],
  documents: [{
    id: DOC_A,
    file_name: 'selections.pdf',
    file_path: `${tenantId}/catalogs/selections.pdf`,
    doc_type: 'catalog',
    mime_type: 'application/pdf',
    file_size: 12,
    notes: 'internal contractor note',
  }],
  plan: {
    start_window_start: '2026-02-01',
    start_window_end: '2026-02-15',
    schedule_status: 'projected',
    schedule_note: 'After materials arrive',
    share_with_homeowner: true,
    contract_total: 9999,
    deductible_amount: 2500,
    allow_deductible_payment: true,
    updated_at: '2026-01-04T00:00:00.000Z',
  },
  pending_upload_count: 0,
  _token: token,
});

const bundleClient = (byToken) => sqlClient([
  {
    match: (sql, params) => sql.includes('aws_public_homeowner_ledger_bundle') && byToken.has(params[0]),
    result: (params) => ({ rows: [{ doc: byToken.get(params[0]) }] }),
  },
  {
    match: (sql) => sql.includes('aws_public_homeowner_ledger_by_token'),
    result: () => ({ rows: [{ doc: null }] }),
  },
]);

test('public frontend routes for /ledger and /h/ledger never require login', () => {
  const app = sourceOf('src/App.tsx');
  const routes = sourceOf('src/lib/publicTokenRoutes.ts');
  const whiteLabel = sourceOf('src/pages/WhiteLabelApp.tsx');
  const ledgerPage = sourceOf('src/pages/HomeownerLedger.tsx');

  assert.equal(isPublicTokenRoute('/ledger/abc123token'), true);
  assert.equal(isPublicTokenRoute('/h/ledger/abc123token'), true);
  assert.equal(isPublicTokenRoute('/start-claim/abc123token'), true);
  assert.equal(isPublicTokenRoute('/acme/checks'), false);
  assert.equal(isPublicTokenRoute('/h/checks'), false);

  assert.match(app, /path="\/h\/ledger\/:token"[\s\S]{0,160}HomeownerLedger/);
  assert.match(app, /path="\/ledger\/:token"[\s\S]{0,160}HomeownerLedger/);
  const aliasIdx = app.indexOf('path="/h/ledger/:token"');
  const slugIdx = app.indexOf('path="/:slug/*"');
  assert.ok(aliasIdx > 0 && slugIdx > aliasIdx, 'alias route must be registered before the tenant slug catch-all');

  assert.match(app, /if \(isPublicTokenRoute\(pathname\)\)/);
  assert.match(app, /return <CheckOpsRoutes \/>/);

  assert.match(routes, /"\/ledger\/"/);
  assert.match(routes, /"\/h\/ledger\/"/);
  assert.match(routes, /PUBLIC_TOKEN_PATH_PREFIXES/);
  assert.match(whiteLabel, /Navigate to=\{user && isMember \? "checks" : "login"\}/);
  assert.doesNotMatch(ledgerPage, /useAuth|Cognito|navigate\("\/login"/);
  assert.match(ledgerPage, /homeowner-ledger-view/);
});

test('tracking email URL is /ledger or /start-claim, never /h/ledger as primary', async () => {
  assert.equal(
    homeownerLedgerTrackingUrl('https://staging.checksops.com/', TOKEN_A, CLAIM_A),
    `https://staging.checksops.com/ledger/${TOKEN_A}`,
  );
  assert.equal(
    homeownerLedgerTrackingUrl('https://staging.checksops.com', TOKEN_A, null),
    `https://staging.checksops.com/start-claim/${TOKEN_A}`,
  );

  const sent = [];
  const withClaim = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: {
      homeowner_email: HOMEOWNER,
      homeowner_name: 'Ada',
      tenant_id: TENANT_A,
      claim_id: CLAIM_A,
      rotate: true,
      origin: 'https://staging.checksops.com',
    },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.tenant_users'),
        result: () => ({ rows: [{ tenant_id: TENANT_A }] }),
      },
      {
        match: (sql) => sql.includes('INSERT INTO public.homeowner_ledger_tokens'),
        result: () => ({ rows: [{ id: TOKEN_ID_A, token: TOKEN_A }] }),
      },
    ]),
  });
  assert.equal(withClaim.ok, true);
  assert.equal(withClaim.url, `https://staging.checksops.com/ledger/${TOKEN_A}`);
  assert.doesNotMatch(withClaim.url, /\/h\/ledger\//);
  assert.match(sent[0].html, new RegExp(`/ledger/${TOKEN_A}`));
  assert.doesNotMatch(sent[0].html, /\/h\/ledger\//);

  const preClaim = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: capturingMailer([]),
    body: {
      homeowner_email: HOMEOWNER,
      tenant_id: TENANT_A,
      rotate: true,
      origin: 'https://staging.checksops.com',
    },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.tenant_users'),
        result: () => ({ rows: [{ tenant_id: TENANT_A }] }),
      },
      {
        match: (sql) => sql.includes('INSERT INTO public.homeowner_ledger_tokens'),
        result: () => ({ rows: [{ id: TOKEN_ID_A, token: TOKEN_A }] }),
      },
    ]),
  });
  assert.equal(preClaim.url, `https://staging.checksops.com/start-claim/${TOKEN_A}`);
});

test('same claim + same email reuses token; different email and rotate do not', async () => {
  const existing = { id: TOKEN_ID_A, token: TOKEN_A };
  let inserts = 0;
  let reuseSelects = 0;
  const reuseClient = () => sqlClient([
    {
      match: (sql) => sql.includes('FROM public.tenant_users'),
      result: () => ({ rows: [{ tenant_id: TENANT_A }] }),
    },
    {
      match: (sql) => sql.includes('FROM public.homeowner_ledger_tokens')
        && sql.includes('lower(trim(homeowner_email))')
        && sql.includes('claim_id'),
      result: (params) => {
        reuseSelects += 1;
        assert.equal(params[0], TENANT_A);
        assert.equal(params[1], CLAIM_A);
        if (String(params[2]).toLowerCase() === HOMEOWNER) return { rows: [existing] };
        return { rows: [] };
      },
    },
    {
      match: (sql) => sql.includes('UPDATE public.homeowner_ledger_tokens'),
      result: (_params, sql) => {
        assert.doesNotMatch(sql, /homeowner_email\s*=/);
        return { rows: [], rowCount: 1 };
      },
    },
    {
      match: (sql) => sql.includes('INSERT INTO public.homeowner_ledger_tokens'),
      result: (params) => {
        inserts += 1;
        const minted = String(params[2]);
        assert.equal(minted.length, 48);
        assert.match(minted, /^[a-f0-9]{48}$/);
        return { rows: [{ id: 'new-token-id', token: minted }] };
      },
    },
  ]);

  const reused = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: capturingMailer([]),
    body: {
      homeowner_email: HOMEOWNER,
      tenant_id: TENANT_A,
      claim_id: CLAIM_A,
      origin: 'https://staging.checksops.com',
    },
    client: reuseClient(),
  });
  assert.equal(reused.ok, true);
  assert.equal(reused.token, TOKEN_A);
  assert.equal(inserts, 0);
  assert.equal(reuseSelects, 1);

  const otherEmail = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: capturingMailer([]),
    body: {
      homeowner_email: OTHER_EMAIL,
      tenant_id: TENANT_A,
      claim_id: CLAIM_A,
      origin: 'https://staging.checksops.com',
    },
    client: reuseClient(),
  });
  assert.equal(otherEmail.ok, true);
  assert.notEqual(otherEmail.token, TOKEN_A);
  assert.equal(inserts, 1);

  const rotated = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: capturingMailer([]),
    body: {
      homeowner_email: HOMEOWNER,
      tenant_id: TENANT_A,
      claim_id: CLAIM_A,
      rotate: true,
      origin: 'https://staging.checksops.com',
    },
    client: reuseClient(),
  });
  assert.equal(rotated.ok, true);
  assert.notEqual(rotated.token, TOKEN_A);
  assert.equal(inserts, 2);
  assert.equal(reuseSelects, 2, 'rotate must skip reuse select');
});

test('claim token view returns only that homeowner/claim contract and hides money CTAs', async () => {
  const raw = claimBundle();
  const view = await runHomeownerLedgerView({
    client: bundleClient(new Map([[TOKEN_A, raw]])),
    token: TOKEN_A,
    spoof,
    signDocumentUrl: async () => 'https://signed.example/doc',
    endorseOrigin: 'https://staging.checksops.com',
  });

  assert.equal(view.ok, true);
  assert.equal(view.mode, 'claim');
  assert.equal(view.homeowner.email, HOMEOWNER);
  assert.equal(view.homeowner.name, 'Ada Lovelace');
  assert.equal(view.claim.id, CLAIM_A);
  assert.equal(view.claim.claim_number, 'CL-A');
  assert.equal(view.totals.received, 1000);
  assert.equal(view.totals.deposited, 1000);
  assert.equal(view.totals.released, 500);
  assert.equal(view.totals.remaining, 500);
  assert.equal(view.events.length, 1);
  assert.equal(view.events[0].payload_json.check_number, '1001');
  assert.equal(view.events[0].payload_json.secret, undefined);
  assert.equal(view.pending_signatures.length, 1);
  assert.equal(view.pending_signatures[0].signers[0].is_homeowner, true);
  assert.equal(view.pending_endorsements.length, 1);
  assert.equal(view.pending_endorsements[0].parties[0].is_homeowner, true);
  assert.match(view.pending_endorsements[0].parties[0].sign_url, /\/endorse\?token=endo-token/);
  assert.equal(view.shared_documents[0].file_name, 'selections.pdf');
  assert.equal(view.shared_documents[0].url, 'https://signed.example/doc');
  assert.equal(view.shared_documents[0].file_path, undefined);
  assert.equal(view.shared_documents[0].notes, undefined);
  assert.equal(view.project_plan.schedule_status, 'projected');
  assert.equal(view.project_plan.contract_total, undefined);
  assert.equal(view.can_upload, true);
  assert.equal(view.money, null);
  assert.deepEqual(view.deductible_payments, []);
  assert.equal(view.allow_deductible_payment, false);

  const asJson = JSON.stringify(view);
  assert.doesNotMatch(asJson, new RegExp(TENANT_A));
  assert.doesNotMatch(asJson, /tenant_id/);
  assert.doesNotMatch(asJson, /CL-B/);
  assert.doesNotMatch(asJson, new RegExp(CLAIM_B));
  assert.doesNotMatch(asJson, /internal contractor note/);
});

test('another claim token cannot read this claim data', async () => {
  const map = new Map([
    [TOKEN_A, claimBundle()],
    [TOKEN_B, claimBundle({
      token: TOKEN_B,
      tokenId: TOKEN_ID_B,
      tenantId: TENANT_B,
      claimId: CLAIM_B,
      email: OTHER_EMAIL,
    })],
  ]);
  const a = await runHomeownerLedgerView({
    client: bundleClient(map),
    token: TOKEN_A,
    spoof,
    signDocumentUrl: async () => null,
  });
  const b = await runHomeownerLedgerView({
    client: bundleClient(map),
    token: TOKEN_B,
    spoof,
    signDocumentUrl: async () => null,
  });
  assert.equal(a.claim.id, CLAIM_A);
  assert.equal(b.claim.id, CLAIM_B);
  assert.equal(a.homeowner.email, HOMEOWNER);
  assert.equal(b.homeowner.email, OTHER_EMAIL);
  assert.doesNotMatch(JSON.stringify(a), new RegExp(CLAIM_B));
  assert.doesNotMatch(JSON.stringify(a), /CL-B/);
  assert.doesNotMatch(JSON.stringify(b), new RegExp(CLAIM_A));
  assert.doesNotMatch(JSON.stringify(b), /CL-A/);
});

test('revoked and expired tokens are denied', async () => {
  const revoked = await runHomeownerLedgerView({
    client: bundleClient(new Map([[TOKEN_A, { error: 'revoked' }]])),
    token: TOKEN_A,
    spoof,
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.statusCode, 410);
  assert.equal(revoked.error, 'revoked');

  const expired = await runHomeownerLedgerView({
    client: bundleClient(new Map([[TOKEN_A, { error: 'expired' }]])),
    token: TOKEN_A,
    spoof,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.error, 'expired');
});

test('sign-link rejects other-claim signers and wrong homeowner email', async () => {
  const tok = {
    claim_id: CLAIM_A,
    homeowner_email: HOMEOWNER,
  };
  assert.equal(canMintHomeownerSignLink(tok, {
    claim_id: CLAIM_B,
    signer_email: HOMEOWNER,
    status: 'pending',
  }).error, 'mismatch');
  assert.equal(canMintHomeownerSignLink(tok, {
    claim_id: CLAIM_A,
    signer_email: OTHER_EMAIL,
    status: 'pending',
  }).error, 'not_your_signature');
  assert.equal(canMintHomeownerSignLink(tok, {
    claim_id: CLAIM_A,
    signer_email: HOMEOWNER,
    status: 'pending',
  }).ok, true);

  const otherClaim = await runHomeownerLedgerSignLink({
    spoof,
    origin: 'https://evil.example',
    body: { token: TOKEN_A, signer_id: SIGNER_B },
    client: sqlClient([
      {
        match: (sql) => sql.includes('aws_public_homeowner_ledger_mint_sign_link'),
        result: () => { throw new Error('unapplied'); },
      },
      {
        match: (sql) => sql.includes('aws_public_homeowner_ledger_bundle'),
        result: () => ({ rows: [{ doc: claimBundle() }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.signature_signers'),
        result: () => ({ rows: [{
          id: SIGNER_B,
          signer_email: HOMEOWNER,
          status: 'pending',
          claim_id: CLAIM_B,
        }] }),
      },
    ]),
  });
  assert.equal(otherClaim.ok, false);
  assert.equal(otherClaim.statusCode, 403);
  assert.equal(otherClaim.error, 'mismatch');

  const wrongEmail = await runHomeownerLedgerSignLink({
    spoof,
    body: { token: TOKEN_A, signer_id: SIGNER_OTHER_EMAIL },
    client: sqlClient([
      {
        match: (sql) => sql.includes('aws_public_homeowner_ledger_mint_sign_link'),
        result: () => { throw new Error('unapplied'); },
      },
      {
        match: (sql) => sql.includes('aws_public_homeowner_ledger_bundle'),
        result: () => ({ rows: [{ doc: claimBundle() }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.signature_signers'),
        result: () => ({ rows: [{
          id: SIGNER_OTHER_EMAIL,
          signer_email: 'bank@example.com',
          status: 'pending',
          claim_id: CLAIM_A,
        }] }),
      },
    ]),
  });
  assert.equal(wrongEmail.ok, false);
  assert.equal(wrongEmail.statusCode, 403);
  assert.equal(wrongEmail.error, 'not_your_signature');

  let updated = 0;
  const ok = await runHomeownerLedgerSignLink({
    spoof,
    origin: 'https://evil.example',
    body: { token: TOKEN_A, signer_id: SIGNER_A },
    client: sqlClient([
      {
        match: (sql) => sql.includes('aws_public_homeowner_ledger_mint_sign_link'),
        result: () => { throw new Error('unapplied'); },
      },
      {
        match: (sql) => sql.includes('aws_public_homeowner_ledger_bundle'),
        result: () => ({ rows: [{ doc: claimBundle() }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.signature_signers'),
        result: () => ({ rows: [{
          id: SIGNER_A,
          signer_email: HOMEOWNER,
          status: 'pending',
          claim_id: CLAIM_A,
        }] }),
      },
      {
        match: (sql) => sql.includes('UPDATE public.signature_signers'),
        result: () => {
          updated += 1;
          return { rows: [], rowCount: 1 };
        },
      },
    ]),
  });
  assert.equal(ok.ok, true);
  assert.equal(updated, 1);
  assert.match(ok.sign_url, /^https:\/\/staging\.checksops\.com\/sign\?token=[a-f0-9]{64}$/);
  assert.doesNotMatch(ok.sign_url, /evil\.example/);
  assert.doesNotMatch(ok.sign_url, /\/sign\/[a-f0-9]+$/);
});

test('uploads bind tenant, token_id, and claim from the ledger token, not the request body', async () => {
  const tok = {
    id: TOKEN_ID_A,
    tenant_id: TENANT_A,
    claim_id: CLAIM_A,
  };
  const values = ledgerUploadInsertValues(tok, 'ledger/path.jpg', {
    token_id: TOKEN_ID_B,
    tenant_id: TENANT_B,
    claim_id: CLAIM_B,
    amount_estimate: 50,
    homeowner_note: 'front',
  });
  assert.deepEqual(values, [TENANT_A, TOKEN_ID_A, CLAIM_A, 'ledger/path.jpg', 50, 'front']);

  const inserts = [];
  const result = await handleHomeownerLedgerUpload({
    body: JSON.stringify({
      token: TOKEN_A,
      front_base64: 'A'.repeat(120),
      token_id: TOKEN_ID_B,
      tenant_id: TENANT_B,
      claim_id: CLAIM_B,
    }),
  }, {
    client: sqlClient([
      {
        match: (sql) => sql.includes('aws_public_homeowner_ledger_bundle'),
        result: () => ({ rows: [{ doc: claimBundle() }] }),
      },
      {
        match: (sql) => sql.includes('aws_public_homeowner_ledger_upload_insert'),
        result: (params) => {
          inserts.push(params);
          return {
            rows: [{
              doc: {
                ok: true,
                id: 'up-1',
                token_id: TOKEN_ID_A,
                claim_id: CLAIM_A,
                tenant_id: TENANT_A,
                front_path: params[1],
                status: 'pending_review',
              },
            }],
          };
        },
      },
      {
        match: (sql) => sql.includes('FROM public.homeowner_ledger_tokens'),
        result: () => ({ rows: [] }),
      },
    ]),
    putObject: async () => {},
    sendViaSesOrSink: capturingMailer([]),
  });
  assert.equal(result.ok, true);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][0], TOKEN_A);
  assert.match(String(inserts[0][1]), new RegExp(`ledger/${TENANT_A}/${TOKEN_ID_A}/`));
  assert.equal(result.upload.token_id, TOKEN_ID_A);
  assert.equal(result.upload.tenant_id, TENANT_A);
  assert.equal(result.upload.claim_id, CLAIM_A);
  assert.match(result.upload.front_path, new RegExp(`ledger/${TENANT_A}/${TOKEN_ID_A}/`));
});

test('public ledger handlers do not use Cognito identity', () => {
  const homeowner = sourceOf('aws/functions/api/homeowner.mjs');
  const view = homeowner.slice(
    homeowner.indexOf('export const handleHomeownerLedgerView'),
    homeowner.indexOf('export const handleHomeownerClaimPortal'),
  );
  const upload = homeowner.slice(
    homeowner.indexOf('export const handleHomeownerLedgerUpload'),
    homeowner.indexOf('export const handleHomeownerLedgerSignLink'),
  );
  const sign = homeowner.slice(
    homeowner.indexOf('export const handleHomeownerLedgerSignLink'),
    homeowner.indexOf('export const runHomeownerLedgerSend'),
  );
  for (const src of [view, upload, sign]) {
    assert.match(src, /publicDb/);
    assert.doesNotMatch(src, /withIdentity/);
    assert.doesNotMatch(src, /Cognito/);
  }

  const send = homeowner.slice(
    homeowner.indexOf('export const runSendPortalInvite'),
    homeowner.indexOf('export const handleSendPortalInvite'),
  );
  assert.match(send, /loginUrl/);
  assert.match(send, /\$\{origin\}\/login/);
});

test('SQL bundle is SECURITY DEFINER, checksops-only, and claim-scoped', () => {
  const sql = sourceOf('aws/workflows/sql/69_staging_homeowner_ledger_view.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.aws_public_homeowner_ledger_bundle/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.aws_public_homeowner_ledger_bundle\(text\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.aws_public_homeowner_ledger_bundle\(text\) TO checksops/);
  assert.match(sql, /WHERE claim_id = tok\.claim_id/);
  assert.match(sql, /shared_with_homeowners = true/);
  assert.match(sql, /tenant_id = tok\.tenant_id/);
  assert.match(sql, /lower\(trim\(tok\.homeowner_email\)\) <> lower\(trim\(coalesce\(signer_email/i);
  assert.match(sql, /request_claim IS DISTINCT FROM tok\.claim_id/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.aws_public_homeowner_ledger_upload_insert/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.aws_public_homeowner_ledger_upload_insert\(text, text, numeric, text\) FROM PUBLIC/);
  assert.doesNotMatch(sql, /DISABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /ALTER TABLE .* ENABLE ROW LEVEL SECURITY/);
});

test('192-bit ledger tokens and money CTA remain disabled in source', () => {
  const send = sourceOf('aws/functions/api/homeowner.mjs');
  const presenter = sourceOf('aws/functions/api/homeowner-ledger-public.mjs');
  const page = sourceOf('src/pages/HomeownerLedger.tsx');
  assert.match(send, /randomBytes\(24\)\.toString\('hex'\)/);
  assert.match(presenter, /money: null/);
  assert.match(presenter, /allow_deductible_payment: false/);
  assert.match(page, /if \(!money\) return null/);
  const totals = computeHomeownerLedgerTotals(
    [{ amount: 10, check_stage: 'funds_released' }],
    [{ amount: 3, status: 'voided' }],
    [{ amount: 4, status: 'sent' }],
  );
  assert.equal(totals.received, 10);
  assert.equal(totals.deposited, 10);
  assert.equal(totals.released, 4);
  assert.equal(totals.remaining, 6);
});

test('unshared project plan is omitted from the homeowner contract', async () => {
  const presented = await presentHomeownerLedgerView({
    ok: true,
    token: { claim_id: CLAIM_A, homeowner_email: HOMEOWNER, homeowner_name: 'Ada' },
    claim: { id: CLAIM_A, claim_number: 'CL-A' },
    events: [],
    checks: [],
    plan: {
      start_window_start: '2026-02-01',
      share_with_homeowner: false,
      schedule_status: 'internal',
    },
  });
  assert.equal(presented.project_plan, null);
  assert.equal(presented.money, null);
});

test('ledger send uses tenant branding, audited helper, and never /h/ledger as primary CTA', () => {
  const homeowner = sourceOf('aws/functions/api/homeowner.mjs');
  const sendFn = homeowner.slice(
    homeowner.indexOf('export const runHomeownerLedgerSend'),
    homeowner.indexOf('export const handleHomeownerLedgerSend'),
  );
  assert.match(homeowner, /from '\.\/email-audited\.mjs'/);
  assert.match(sendFn, /homeownerLedgerTrackingUrl\(origin, tokenRow\.token, claimId\)/);
  assert.doesNotMatch(sendFn, /\/h\/ledger\//);
  assert.doesNotMatch(sendFn, /senderOverride:\s*'checksops'/);
  assert.match(sendFn, /lower\(trim\(homeowner_email\)\)/);
  assert.match(sendFn, /templateName: 'homeowner-ledger-invite'/);
  assert.match(sendFn, /deliverAuditedEmail/);
});

test('C1C tenant branding is used for claim-bound tracking email', async () => {
  const sent = [];
  const client = ledgerSendClient();
  const result = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: {
      homeowner_email: LOCK,
      homeowner_name: 'Ada',
      tenant_id: TENANT_A,
      claim_id: CLAIM_A,
      rotate: true,
      origin: 'https://staging.checksops.com',
    },
    client,
  });
  assert.equal(result.ok, true);
  assert.match(result.url, new RegExp(`/ledger/`));
  assert.doesNotMatch(result.url, /\/h\/ledger\//);
  assert.equal(result.from, `${C1C_NAME} <${C1C_FROM}>`);
  assert.equal(result.replyTo, C1C_REPLY);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, `${C1C_NAME} <${C1C_FROM}>`);
  assert.equal(sent[0].replyTo, C1C_REPLY);
  assert.equal(sent[0].to, LOCK);
  assert.match(sent[0].html, /\/ledger\//);
  assert.doesNotMatch(sent[0].html, /\/h\/ledger\//);
  assert.ok(client.calls.some((c) => c.sql.includes('FROM public.tenant_email_settings')));
  assert.ok(client.calls.some((c) => c.sql.includes('aws_email_send_log_reserve')));
  assert.ok(!client.calls.some((c) => c.sql.includes('INSERT INTO public.email_send_log')));
});

test('pre-claim send uses /start-claim and still audits before the mailer', async () => {
  const sent = [];
  const logs = new Map();
  const client = ledgerSendClient({ logs });
  let reservedBeforeMailer = false;
  const result = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: async (payload) => {
      reservedBeforeMailer = [...logs.values()].some((row) => row.status === 'pending'
        && row.template_name === 'homeowner-ledger-invite');
      return capturingMailer(sent)(payload);
    },
    body: {
      homeowner_email: LOCK,
      tenant_id: TENANT_A,
      rotate: true,
      origin: 'https://staging.checksops.com',
    },
    client,
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, `https://staging.checksops.com/start-claim/${result.token}`);
  assert.equal(reservedBeforeMailer, true);
  assert.equal(sent.length, 1);
  assert.equal([...logs.values()][0].provider_message_id, 'sink-1');
  assert.equal([...logs.values()][0].status, 'sunk');
});

test('same-email reuse does not overwrite another homeowner email column', async () => {
  const updates = [];
  const inserts = [];
  const client = ledgerSendClient({
    existingToken: { id: TOKEN_ID_A, token: TOKEN_A, email: HOMEOWNER, claimId: CLAIM_A },
    updates,
    inserts,
  });
  const reused = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: capturingMailer([]),
    body: {
      homeowner_email: HOMEOWNER,
      tenant_id: TENANT_A,
      claim_id: CLAIM_A,
      origin: 'https://staging.checksops.com',
    },
    client,
  });
  assert.equal(reused.token, TOKEN_A);
  assert.equal(inserts.length, 0);
  assert.equal(updates.length, 1);
  assert.doesNotMatch(updates[0].sql, /homeowner_email\s*=/);

  const minted = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: capturingMailer([]),
    body: {
      homeowner_email: OTHER_EMAIL,
      tenant_id: TENANT_A,
      claim_id: CLAIM_A,
      origin: 'https://staging.checksops.com',
    },
    client: ledgerSendClient({
      existingToken: { id: TOKEN_ID_A, token: TOKEN_A, email: HOMEOWNER, claimId: CLAIM_A },
      updates,
      inserts,
    }),
  });
  assert.notEqual(minted.token, TOKEN_A);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params[3], OTHER_EMAIL);
});

test('staging lock mismatch and ses-identity never reach SES SendEmail', async () => {
  await withEnv({
    AWS_EMAIL_MODE: 'ses',
    CHECKSOPS_ENV: 'staging',
    AWS_EMAIL_SES_LOCK_RECIPIENT: LOCK,
  }, async () => {
    const mismatch = applyRecipientPolicy(['checksops-tester@freedomadj.com'])[0];
    assert.equal(mismatch.delivery, 'sink');
    assert.equal(mismatch.policy, 'staging_ses_lock_mismatch');
    const allowed = applyRecipientPolicy([LOCK])[0];
    assert.equal(allowed.delivery, 'ses');
    assert.equal(allowed.policy, 'staging_ses_lock');

    let sesCalls = 0;
    const result = await runHomeownerLedgerSend({
      mapping,
      spoof,
      send: (args) => sendViaSesOrSink({
        ...args,
        sesSend: async () => {
          sesCalls += 1;
          return { MessageId: 'should-not-send' };
        },
      }),
      body: {
        homeowner_email: 'checksops-tester@freedomadj.com',
        tenant_id: TENANT_A,
        claim_id: CLAIM_A,
        rotate: true,
        origin: 'https://staging.checksops.com',
      },
      client: ledgerSendClient(),
    });
    assert.equal(result.ok, true);
    assert.equal(sesCalls, 0);
    assert.equal(result.stagingPolicy, 'staging_ses_lock_mismatch');
    assert.equal(result.sent, undefined);
  });

  await withEnv({
    AWS_EMAIL_MODE: 'ses-identity',
    CHECKSOPS_ENV: 'staging',
    AWS_EMAIL_SES_LOCK_RECIPIENT: LOCK,
  }, async () => {
    assert.equal(emailMode(), 'ses-identity');
    const policy = applyRecipientPolicy([LOCK])[0];
    assert.equal(policy.delivery, 'sink');
    assert.equal(policy.policy, 'staging_ses_identity');
    let sesCalls = 0;
    const result = await runHomeownerLedgerSend({
      mapping,
      spoof,
      send: (args) => sendViaSesOrSink({
        ...args,
        sesSend: async () => {
          sesCalls += 1;
          return { MessageId: 'should-not-send' };
        },
      }),
      body: {
        homeowner_email: LOCK,
        tenant_id: TENANT_A,
        claim_id: CLAIM_A,
        rotate: true,
        origin: 'https://staging.checksops.com',
      },
      client: ledgerSendClient(),
    });
    assert.equal(result.ok, true);
    assert.equal(sesCalls, 0);
    assert.equal(result.stagingMode, 'ses-identity');
    assert.equal(result.stagingPolicy, 'staging_ses_identity');
  });
});

test('duplicate idempotency key replays without a second mailer call', async () => {
  const logs = new Map();
  const sent = [];
  const client = ledgerSendClient({ logs });
  const body = {
    homeowner_email: LOCK,
    tenant_id: TENANT_A,
    claim_id: CLAIM_A,
    rotate: true,
    origin: 'https://staging.checksops.com',
    idempotencyKey: 'homeowner-ledger-dup-1',
  };
  const first = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: capturingMailer(sent),
    body,
    client,
  });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(sent.length, 1);
  const second = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: capturingMailer(sent),
    body,
    client,
  });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.reason, 'idempotent_replay');
  assert.equal(sent.length, 1);
  assert.equal(second.providerMessageId, 'sink-1');
});

test('missing audit storage in SES mode prevents send', async () => {
  await withEnv({
    AWS_EMAIL_MODE: 'ses',
    CHECKSOPS_ENV: 'staging',
    AWS_EMAIL_SES_LOCK_RECIPIENT: LOCK,
  }, async () => {
    const sent = [];
    const lookupFail = await runHomeownerLedgerSend({
      mapping,
      spoof,
      send: capturingMailer(sent),
      body: {
        homeowner_email: LOCK,
        tenant_id: TENANT_A,
        claim_id: CLAIM_A,
        rotate: true,
        origin: 'https://staging.checksops.com',
      },
      client: ledgerSendClient({ failIdempotencySelect: true }),
    });
    assert.equal(lookupFail.ok, false);
    assert.equal(lookupFail.statusCode, 503);
    assert.equal(lookupFail.error, 'idempotency_unavailable');
    assert.equal(sent.length, 0);

    const insertFail = await runHomeownerLedgerSend({
      mapping,
      spoof,
      send: capturingMailer(sent),
      body: {
        homeowner_email: LOCK,
        tenant_id: TENANT_A,
        claim_id: CLAIM_A,
        rotate: true,
        origin: 'https://staging.checksops.com',
      },
      client: ledgerSendClient({ failInsert: true }),
    });
    assert.equal(insertFail.ok, false);
    assert.equal(insertFail.statusCode, 503);
    assert.equal(insertFail.error, 'idempotency_unavailable');
    assert.equal(sent.length, 0);
  });
});

test('audited helper finalizes provider MessageId on SES success', async () => {
  await withEnv({
    AWS_EMAIL_MODE: 'ses',
    CHECKSOPS_ENV: 'staging',
    AWS_EMAIL_SES_LOCK_RECIPIENT: LOCK,
  }, async () => {
    const logs = new Map();
    const client = ledgerSendClient({ logs });
    const delivery = await deliverAuditedEmail(client, {
      templateName: 'homeowner-ledger-invite',
      recipientEmail: LOCK,
      tenantId: TENANT_A,
      idempotencyKey: 'homeowner-ledger-ses-msgid',
      send: async () => ({
        mode: 'ses',
        deliveredCount: 1,
        sunkCount: 0,
        results: [{
          delivery: 'ses',
          status: 'sent',
          policy: 'staging_ses_lock',
          messageId: 'ses-message-abc',
          originalTo: LOCK,
        }],
      }),
    });
    assert.equal(delivery.ok, true);
    assert.equal(delivery.providerMessageId, 'ses-message-abc');
    assert.equal([...logs.values()][0].provider_message_id, 'ses-message-abc');
    assert.equal([...logs.values()][0].status, 'sent');
    assert.equal([...logs.values()][0].metadata.original_recipient, LOCK);
  });
});

