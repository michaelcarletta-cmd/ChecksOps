import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSendSignatureRequest, signatureRequestFromHeader } from '../functions/api/esign.mjs';
import { runSendPaymentDirectionRequest } from '../functions/api/payment-direction-email.mjs';
import { runTenantInviteUser } from '../functions/api/tenant-admin.mjs';
import { runHomeownerLedgerSend } from '../functions/api/homeowner.mjs';
import { runHomeownerUploadOtpStart } from '../functions/api/homeowner-otp.mjs';
import { runAuthenticatedEndorsement } from '../functions/api/check-endorsement.mjs';
import { PLATFORM_ENDORSEMENT_FROM } from '../functions/api/endorsement-parity.mjs';
import { resolveEmailBranding } from '../functions/api/email-branding.mjs';

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const USER = '55555555-5555-4555-8555-555555555555';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REQUEST_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SIGNER_A = '11111111-1111-4111-8111-111111111111';
const SIGNER_B = '22222222-2222-4222-8222-222222222222';
const CHECK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDORSE = '88888888-8888-4888-8888-888888888888';
const COGNITO_SUB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const FREEDOM_LOGO = 'https://brand.example/freedom-logo.png';
const C1C_LOGO = 'https://brand.example/c1c-logo.png';
const FREEDOM_COLOR = '#1a4993';
const C1C_COLOR = '#3B82F6';

const tenants = {
  [FREEDOM]: {
    name: 'Freedom Adjustment',
    logo_url: FREEDOM_LOGO,
    primary_color: FREEDOM_COLOR,
    is_system_tenant: false,
    email_from_name: null,
    email_from_address: null,
    email_reply_to: 'claims@freedomadj.com',
  },
  [C1C]: {
    name: 'Condition One Commercial',
    logo_url: C1C_LOGO,
    primary_color: C1C_COLOR,
    is_system_tenant: false,
    email_from_name: null,
    email_from_address: null,
    email_reply_to: 'ops@c1c.example',
  },
};

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
});

const capturingMailer = (sent) => async (payload) => {
  sent.push(payload);
  return { deliveredCount: 0, sunkCount: 1, mode: 'sink', results: [{ delivery: 'sink', messageId: 'sink-1' }] };
};

const tenantHandlers = () => ([
  {
    match: (sql) => sql.includes('FROM public.tenants'),
    result: (params) => ({ rows: tenants[params[0]] ? [tenants[params[0]]] : [] }),
  },
  {
    match: (sql) => sql.includes('tenant_email_settings'),
    result: () => ({ rows: [] }),
  },
]);

const signatureHandlers = ({ requestId, claimId, tenantId, signerId, signerEmail, canWrite = true, documentName = 'Release' }) => ([
  {
    match: (sql) => sql.includes('FROM public.signature_requests'),
    result: () => ({ rows: [{ id: requestId, document_name: documentName, claim_id: claimId, field_data: [] }] }),
  },
  {
    match: (sql) => sql.includes('FROM public.signature_signers'),
    result: () => ({ rows: [{ id: signerId, signer_name: 'Ada', signer_email: signerEmail }] }),
  },
  {
    match: (sql) => sql.includes('FROM public.claims'),
    result: () => ({ rows: [{ id: claimId, claim_number: 'CL-1', policyholder_name: 'Ada', tenant_id: tenantId }] }),
  },
  {
    match: (sql) => sql.includes('aws_can_write_tenant'),
    result: (params) => ({ rows: [{ ok: canWrite && params[0] === tenantId }] }),
  },
  {
    match: (sql) => sql.includes('company_branding'),
    result: () => ({ rows: [{
      esign_email_subject: 'Action Required: Sign {document.name}',
      esign_email_body: 'Please review and sign.',
    }] }),
  },
  ...tenantHandlers(),
]);

test('signature From helper strips via ChecksOps and keeps support@checksops.com', () => {
  assert.equal(
    signatureRequestFromHeader({
      companySubtitle: 'Freedom Adjustment',
      companyName: 'Freedom Adjustment',
      fromName: 'Freedom Adjustment via ChecksOps',
      fromAddress: 'noreply@checksops.com',
      from: 'Freedom Adjustment via ChecksOps <noreply@checksops.com>',
    }),
    'Freedom Adjustment <support@checksops.com>',
  );
  assert.equal(
    signatureRequestFromHeader({
      companySubtitle: 'Condition One Commercial',
      fromName: 'Condition One Commercial via ChecksOps',
    }),
    'Condition One Commercial <support@checksops.com>',
  );
  assert.doesNotMatch(signatureRequestFromHeader({ fromName: 'Acme via ChecksOps' }), /via ChecksOps/);
});

test('Freedom signature request uses tenant name and support@checksops.com', async () => {
  const sent = [];
  const result = await runSendSignatureRequest({
    mapping: { application_user_id: USER },
    spoof: { ignored: true },
    body: { requestId: REQUEST_A, tenantId: C1C, sender_override: 'ignored' },
    send: capturingMailer(sent),
    client: sqlClient(signatureHandlers({
      requestId: REQUEST_A,
      claimId: CLAIM_A,
      tenantId: FREEDOM,
      signerId: SIGNER_A,
      signerEmail: 'ada@freedomadj.com',
    })),
  });
  assert.equal(result.ok, true);
  assert.equal(result.from, 'Freedom Adjustment <support@checksops.com>');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, 'Freedom Adjustment <support@checksops.com>');
  assert.doesNotMatch(sent[0].from, /via ChecksOps/);
  assert.match(sent[0].from, /<support@checksops\.com>$/);
  assert.equal(sent[0].replyTo, 'claims@freedomadj.com');
  assert.equal(sent[0].subject, 'Action Required: Sign Release');
  assert.match(sent[0].html, /Please review and sign/);
  assert.equal(sent[0].html.includes(FREEDOM_LOGO), true);
  assert.equal(sent[0].html.includes(FREEDOM_COLOR), true);
  assert.equal(sent[0].html.includes(C1C_LOGO), false);
});

test('another tenant resolves its own signature From name independently', async () => {
  const sent = [];
  const result = await runSendSignatureRequest({
    mapping: { application_user_id: USER },
    spoof: { ignored: true },
    body: { requestId: REQUEST_B },
    send: capturingMailer(sent),
    client: sqlClient(signatureHandlers({
      requestId: REQUEST_B,
      claimId: CLAIM_B,
      tenantId: C1C,
      signerId: SIGNER_B,
      signerEmail: 'pat@c1c.example',
      documentName: 'Authorization',
    })),
  });
  assert.equal(result.ok, true);
  assert.equal(sent[0].from, 'Condition One Commercial <support@checksops.com>');
  assert.doesNotMatch(sent[0].from, /via ChecksOps|Freedom Adjustment/);
  assert.equal(sent[0].replyTo, 'ops@c1c.example');
  assert.equal(sent[0].subject, 'Action Required: Sign Authorization');
  assert.equal(sent[0].html.includes(C1C_LOGO), true);
  assert.equal(sent[0].html.includes(C1C_COLOR), true);
  assert.equal(sent[0].html.includes(FREEDOM_LOGO), false);
});

test('tenant A cannot send a signature request that uses tenant B branding', async () => {
  const sent = [];
  const denied = await runSendSignatureRequest({
    mapping: { application_user_id: USER },
    spoof: { ignored: true },
    body: { requestId: REQUEST_B, tenantId: FREEDOM },
    send: capturingMailer(sent),
    client: sqlClient(signatureHandlers({
      requestId: REQUEST_B,
      claimId: CLAIM_B,
      tenantId: C1C,
      signerId: SIGNER_B,
      signerEmail: 'pat@c1c.example',
      canWrite: false,
    })),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.statusCode, 403);
  assert.equal(sent.length, 0);

  const spoofed = [];
  const ok = await runSendSignatureRequest({
    mapping: { application_user_id: USER },
    spoof: { ignored: true },
    body: { requestId: REQUEST_A, tenantId: C1C, tenant_id: C1C },
    send: capturingMailer(spoofed),
    client: sqlClient(signatureHandlers({
      requestId: REQUEST_A,
      claimId: CLAIM_A,
      tenantId: FREEDOM,
      signerId: SIGNER_A,
      signerEmail: 'ada@freedomadj.com',
    })),
  });
  assert.equal(ok.ok, true);
  assert.equal(spoofed[0].from, 'Freedom Adjustment <support@checksops.com>');
  assert.doesNotMatch(spoofed[0].from, /Condition One Commercial/);
  assert.equal(spoofed[0].html.includes(C1C_LOGO), false);
});

test('shared resolveEmailBranding still appends via ChecksOps', async () => {
  const branding = await resolveEmailBranding(sqlClient(tenantHandlers()), { tenantId: FREEDOM });
  assert.match(branding.from, /Freedom Adjustment via ChecksOps/);
  assert.match(branding.from, /noreply@checksops\.com|support@checksops\.com/);
});

test('tenant invite From is unchanged by the signature override', async () => {
  const sent = [];
  const invite = await runTenantInviteUser({
    mapping: { application_user_id: USER },
    spoof: { ignored: true },
    send: capturingMailer(sent),
    body: { tenant_id: FREEDOM, email: 'member@example.com', role: 'member', full_name: 'New Member' },
    cognitoJson: async (target, payload) => {
      if (target === 'AdminCreateUser') {
        assert.equal(payload.MessageAction, 'SUPPRESS');
        return { User: { Username: 'cog2', Attributes: [{ Name: 'sub', Value: COGNITO_SUB }] } };
      }
      throw new Error(`unexpected ${target}`);
    },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.tenant_users') && sql.includes('SELECT role'),
        result: () => ({ rows: [{ role: 'admin' }] }),
      },
      ...tenantHandlers(),
      {
        match: (sql) => sql.includes('FROM public.profiles'),
        result: () => ({ rows: [] }),
      },
    ]),
  });
  assert.equal(invite.ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].from, /via ChecksOps/);
  assert.notEqual(sent[0].from, 'Freedom Adjustment <support@checksops.com>');
});

test('payment-direction From is unchanged by the signature override', async () => {
  const sent = [];
  const pd = await runSendPaymentDirectionRequest({
    spoof: { ignored: true },
    send: capturingMailer(sent),
    body: { claimId: CLAIM_A, checkId: CHECK, requestUrl: 'https://staging.checksops.com/payment-direction/x' },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.claims'),
        result: () => ({ rows: [{
          id: CLAIM_A,
          tenant_id: FREEDOM,
          policyholder_email: 'ada@example.com',
          policyholder_name: 'Ada',
          claim_number: 'CL-1',
        }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: true }] }),
      },
      ...tenantHandlers(),
    ]),
  });
  assert.equal(pd.ok, true);
  assert.match(sent[0].from, /via ChecksOps/);
  assert.notEqual(sent[0].from, 'Freedom Adjustment <support@checksops.com>');
});

test('endorsement From stays on the ChecksOps notify identity', async () => {
  const sent = [];
  const endorse = await runAuthenticatedEndorsement({
    mapping: { application_user_id: USER },
    spoof: { ignored: true },
    event: { headers: {} },
    send: capturingMailer(sent),
    body: { action: 'send_endorsement_request', endorsementId: ENDORSE },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'),
        result: () => ({ rows: [{
          id: ENDORSE,
          check_id: CHECK,
          tenant_id: FREEDOM,
          payee_type: 'insured',
          payee_name: 'Jane',
          contact_email: 'jane@example.com',
          token: 'abc',
          request_sent_at: null,
        }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ id: CHECK, tenant_id: FREEDOM, check_number: '1001', carrier_name: 'Acme' }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: true }] }),
      },
      {
        match: (sql) => sql.includes("SET status = 'sent'"),
        result: () => ({
          rows: [{ id: ENDORSE, status: 'sent', request_sent_at: new Date().toISOString() }],
          rowCount: 1,
        }),
      },
      ...tenantHandlers(),
    ]),
  });
  assert.equal(endorse.ok, true);
  assert.equal(sent[0].from, PLATFORM_ENDORSEMENT_FROM);
  assert.match(sent[0].from, /notify@checksops\.com/);
  assert.notEqual(sent[0].from, 'Freedom Adjustment <support@checksops.com>');
});

test('ledger and OTP keep platform ChecksOps sender override', async () => {
  const sent = [];
  const ledger = await runHomeownerLedgerSend({
    mapping: { application_user_id: USER },
    spoof: { ignored: true },
    send: capturingMailer(sent),
    body: { homeowner_email: 'home@example.com', homeowner_name: 'Ada', tenant_id: FREEDOM, rotate: true },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.tenant_users'),
        result: () => ({ rows: [{ tenant_id: FREEDOM, '?column?': 1 }] }),
      },
      {
        match: (sql) => sql.includes('INSERT INTO public.homeowner_ledger_tokens'),
        result: () => ({ rows: [{ id: 't1', token: 'ledgertok' }] }),
      },
      ...tenantHandlers(),
    ]),
  });
  assert.equal(ledger.ok, true);
  assert.match(sent[0].from, /ChecksOps/);
  assert.doesNotMatch(sent[0].from, /Freedom Adjustment/);

  const otp = await runHomeownerUploadOtpStart({
    spoof: { ignored: true },
    send: capturingMailer(sent),
    body: { email: 'home@example.com' },
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_homeowner_upload_otp_insert'),
      result: () => ({ rows: [{ doc: { ok: true } }] }),
    }]),
  });
  assert.equal(otp.ok, true);
  assert.match(sent[1].from, /ChecksOps/);
  assert.doesNotMatch(sent[1].from, /Freedom Adjustment <support@checksops\.com>/);
});

test('generic transactional email still uses shared branding From', async () => {
  const branding = await resolveEmailBranding(sqlClient(tenantHandlers()), { tenantId: FREEDOM });
  assert.match(branding.from, /via ChecksOps/);
  assert.notEqual(branding.from, 'Freedom Adjustment <support@checksops.com>');
  const sent = [];
  await capturingMailer(sent)({
    to: 'ops@checksops.com',
    subject: 'Hello',
    html: '<p>Ping</p>',
    from: branding.from,
    replyTo: branding.replyTo,
  });
  assert.equal(sent[0].from, branding.from);
});
