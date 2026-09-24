import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSendSignatureRequest } from '../functions/api/esign.mjs';
import {
  notifyStaffOfHomeownerLedgerUpload,
  runHomeownerLedgerSend,
  runSendFileToHomeowner,
  runSendPortalInvite,
} from '../functions/api/homeowner.mjs';
import { runHomeownerUploadOtpStart } from '../functions/api/homeowner-otp.mjs';
import { runHireMortgageAgent, runTenantInviteUser } from '../functions/api/tenant-admin.mjs';
import { runAuthenticatedEndorsement } from '../functions/api/check-endorsement.mjs';
import { PLATFORM_ENDORSEMENT_FROM } from '../functions/api/endorsement-parity.mjs';
import { runSendPaymentDirectionRequest } from '../functions/api/payment-direction-email.mjs';
import {
  runNotifyHomeownerLead,
  runNotifyHomeownerLeadAccepted,
  runNotifyMortgageHandlingRequest,
} from '../functions/api/email.mjs';
import { stakeholderResendVerification } from '../functions/api/providers/parity/moov-onboard.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '55555555-5555-4555-8555-555555555555';
const CLAIM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FILE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REQUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SIGNER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const LEAD = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const STAKE = '99999999-9999-4999-8999-999999999999';
const ENDORSE = '88888888-8888-4888-8888-888888888888';
const COGNITO_SUB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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

const mapping = { application_user_id: USER };
const spoof = { ignored: true };

test('signature request uses shared layout and calls mailer once', async () => {
  const sent = [];
  const result = await runSendSignatureRequest({
    mapping,
    spoof,
    body: { requestId: REQUEST },
    send: capturingMailer(sent),
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.signature_requests'),
        result: () => ({ rows: [{ id: REQUEST, document_name: 'Release', claim_id: CLAIM, field_data: [] }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.signature_signers'),
        result: () => ({ rows: [{ id: SIGNER, signer_name: 'Ada', signer_email: 'ada@example.com' }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.claims'),
        result: () => ({ rows: [{ id: CLAIM, claim_number: 'CL-1', policyholder_name: 'Ada', tenant_id: TENANT }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: true }] }),
      },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].html, /checksops-logo\.png/);
  assert.match(sent[0].html, /Review &amp; Sign Document|Review & Sign Document/);
  assert.match(sent[0].text, /support@checksops\.com/);
});

test('send-file-to-homeowner emails after timeline and fails without a recipient', async () => {
  const sent = [];
  const events = [];
  const missing = await runSendFileToHomeowner({
    mapping,
    spoof,
    body: { check_file_id: FILE },
    send: capturingMailer(sent),
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_files'),
        result: () => ({ rows: [{ id: FILE, check_id: CHECK, tenant_id: TENANT, file_name: 'est.pdf' }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.tenant_users'),
        result: () => ({ rows: [{ '?column?': 1 }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ claim_id: CLAIM }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.homeowner_ledger_tokens'),
        result: () => ({ rows: [{ token: 'tok', homeowner_email: null, homeowner_name: 'Ada' }] }),
      },
    ]),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'missing_recipient');
  assert.equal(sent.length, 0);

  const ok = await runSendFileToHomeowner({
    mapping,
    spoof,
    body: { check_file_id: FILE, note: 'See attached' },
    send: capturingMailer(sent),
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_files'),
        result: () => ({ rows: [{ id: FILE, check_id: CHECK, tenant_id: TENANT, file_name: 'est.pdf' }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.tenant_users'),
        result: () => ({ rows: [{ '?column?': 1 }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ claim_id: CLAIM }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.homeowner_ledger_tokens'),
        result: () => ({ rows: [{ token: 'ledgertok', homeowner_email: 'home@example.com', homeowner_name: 'Ada' }] }),
      },
      {
        match: (sql) => sql.includes('INSERT INTO public.homeowner_ledger_events'),
        result: (_params, sql) => {
          events.push(sql);
          return { rows: [], rowCount: 1 };
        },
      },
    ]),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.emailed, true);
  assert.equal(sent.length, 1);
  assert.equal(events.length, 1);
  assert.equal(sent[0].to, 'home@example.com');
  assert.match(sent[0].html, /A document was shared|est\.pdf|See attached/);
});

test('homeowner ledger upload notifies sent_by staff, else created_by', async () => {
  const sent = [];
  const first = await notifyStaffOfHomeownerLedgerUpload({
    token: 'tok',
    uploadId: 'u1',
    send: capturingMailer(sent),
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.homeowner_ledger_tokens'),
        result: () => ({ rows: [{
          id: 't1',
          tenant_id: TENANT,
          claim_id: CLAIM,
          sent_by_user_id: USER,
          created_by: '00000000-0000-4000-8000-000000000000',
          homeowner_name: 'Ada',
          homeowner_email: 'home@example.com',
        }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.profiles'),
        result: (params) => {
          assert.equal(params[0], USER);
          return { rows: [{ email: 'staff@checksops.com', full_name: 'Pat' }] };
        },
      },
    ]),
  });
  assert.equal(first.notified, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'staff@checksops.com');

  const fallback = await notifyStaffOfHomeownerLedgerUpload({
    token: 'tok',
    send: capturingMailer(sent),
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.homeowner_ledger_tokens'),
        result: () => ({ rows: [{
          id: 't1',
          tenant_id: TENANT,
          created_by: USER,
          homeowner_name: 'Ada',
        }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.profiles'),
        result: () => ({ rows: [{ email: 'creator@checksops.com', full_name: 'Pat' }] }),
      },
    ]),
  });
  assert.equal(fallback.notified, true);
  assert.equal(sent[1].to, 'creator@checksops.com');

  const silent = await notifyStaffOfHomeownerLedgerUpload({
    token: 'tok',
    send: capturingMailer(sent),
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.homeowner_ledger_tokens'),
        result: () => ({ rows: [{ id: 't1', tenant_id: TENANT, created_by: USER }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.profiles'),
        result: () => ({ rows: [{ email: null }] }),
      },
    ]),
  });
  assert.equal(silent.notified, false);
  assert.equal(sent.length, 2);
});

test('ledger send, portal invite, OTP, leads, and mortgage notify call mailer once', async () => {
  const sent = [];
  const mail = capturingMailer(sent);

  const ledger = await runHomeownerLedgerSend({
    mapping,
    spoof,
    send: mail,
    body: { homeowner_email: 'home@example.com', homeowner_name: 'Ada', tenant_id: TENANT, rotate: true },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.tenant_users'),
        result: () => ({ rows: [{ tenant_id: TENANT, '?column?': 1 }] }),
      },
      {
        match: (sql) => sql.includes('INSERT INTO public.homeowner_ledger_tokens'),
        result: () => ({ rows: [{ id: 't1', token: 'ledgertok' }] }),
      },
    ]),
  });
  assert.equal(ledger.ok, true);

  const portal = await runSendPortalInvite({
    mapping,
    spoof,
    send: mail,
    body: { email: 'home@example.com', tenantName: 'Acme', userName: 'Ada', password: 'SecretPass1!' },
    client: sqlClient([]),
  });
  assert.equal(portal.ok, true);
  assert.doesNotMatch(sent.at(-1).html, /SecretPass1/);

  const otp = await runHomeownerUploadOtpStart({
    spoof,
    send: mail,
    body: { email: 'home@example.com' },
    client: sqlClient([{
      match: (sql) => sql.includes('aws_public_homeowner_upload_otp_insert'),
      result: () => ({ rows: [{ doc: { ok: true } }] }),
    }]),
  });
  assert.equal(otp.ok, true);
  assert.match(sent.at(-1).html, /\d{6}/);

  const mortgage = await runNotifyMortgageHandlingRequest({
    mapping,
    spoof,
    send: mail,
    body: { request_id: REQUEST },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.mortgage_handling_requests'),
        result: () => ({ rows: [{ id: REQUEST, tenant_id: TENANT, mortgage_company: 'Bank', status: 'open' }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.tenant_users'),
        result: () => ({ rows: [{ '?column?': 1 }] }),
      },
    ]),
  });
  assert.equal(mortgage.ok, true);

  const lead = await runNotifyHomeownerLead({
    mapping,
    spoof,
    send: mail,
    body: { lead_id: LEAD },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.homeowner_intro_requests'),
        result: () => ({ rows: [{ id: LEAD, homeowner_name: 'Ada', contractor_user_id: USER }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.profiles'),
        result: () => ({ rows: [{ email: 'contractor@example.com' }] }),
      },
    ]),
  });
  assert.equal(lead.ok, true);

  const accepted = await runNotifyHomeownerLeadAccepted({
    mapping,
    spoof,
    send: mail,
    body: { lead_id: LEAD },
    client: sqlClient([{
      match: (sql) => sql.includes('FROM public.homeowner_intro_requests'),
      result: () => ({ rows: [{
        id: LEAD,
        homeowner_name: 'Ada',
        homeowner_email: 'home@example.com',
        access_token: 'claimtok',
        contractor_user_id: USER,
      }] }),
    }]),
  });
  assert.equal(accepted.ok, true);
  assert.equal(sent.length, 6);
  for (const payload of sent) {
    assert.match(payload.html, /checksops-logo\.png/);
  }
});

test('missing required recipients fail honestly without sending', async () => {
  const sent = [];
  const lead = await runNotifyHomeownerLead({
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: { lead_id: LEAD },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.homeowner_intro_requests'),
        result: () => ({ rows: [{ id: LEAD, contractor_user_id: USER }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.profiles'),
        result: () => ({ rows: [{ email: null }] }),
      },
    ]),
  });
  assert.equal(lead.error, 'missing_recipient');
  const portal = await runSendPortalInvite({
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: {},
    client: sqlClient([]),
  });
  assert.equal(portal.error, 'missing_email');
  assert.equal(sent.length, 0);
});

test('endorsement and payment-direction use branding From and call mailer once', async () => {
  const sent = [];
  const endorsement = {
    id: ENDORSE,
    check_id: CHECK,
    tenant_id: TENANT,
    payee_type: 'insured',
    payee_name: 'Jane',
    contact_email: 'jane@example.com',
    token: 'abc',
    request_sent_at: null,
  };
  const endorse = await runAuthenticatedEndorsement({
    mapping,
    spoof,
    event: { headers: {} },
    send: capturingMailer(sent),
    body: { action: 'send_endorsement_request', endorsementId: ENDORSE },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_endorsements WHERE id'),
        result: () => ({ rows: [endorsement] }),
      },
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ id: CHECK, tenant_id: TENANT, check_number: '1001', carrier_name: 'Acme' }] }),
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
    ]),
  });
  assert.equal(endorse.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, PLATFORM_ENDORSEMENT_FROM);
  assert.match(sent[0].from || '', /notify@checksops\.com/);

  const pd = await runSendPaymentDirectionRequest({
    spoof,
    send: capturingMailer(sent),
    body: { claimId: CLAIM, checkId: CHECK, requestUrl: 'https://staging.checksops.com/payment-direction/x' },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.claims'),
        result: () => ({ rows: [{
          id: CLAIM,
          tenant_id: TENANT,
          policyholder_email: 'ada@example.com',
          policyholder_name: 'Ada',
          claim_number: 'CL-1',
        }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: true }] }),
      },
    ]),
  });
  assert.equal(pd.ok, true);
  assert.equal(sent.length, 2);
});

test('stakeholder resend calls the mailer and never reports sent otherwise', async () => {
  const sent = [];
  const updates = [];
  const account = {
    id: STAKE,
    tenant_id: TENANT,
    nickname: 'Ada',
    custname: 'Ada Lovelace',
    verification_recipient_email: 'ada@example.com',
  };
  const ok = await stakeholderResendVerification.run({
    ctx: { tenantId: TENANT },
    body: { stakeholder_account_id: STAKE },
    send: capturingMailer(sent),
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.stakeholder_accounts'),
        result: () => ({ rows: [account] }),
      },
      {
        match: (sql) => sql.includes('UPDATE public.stakeholder_accounts'),
        result: (_params, sql) => {
          updates.push(sql);
          return { rows: [], rowCount: 1 };
        },
      },
    ]),
  });
  assert.equal(ok.success, true);
  assert.equal(ok.emailed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ada@example.com');
  assert.match(sent[0].html, /verify-account\//);
  assert.equal(updates.some((sql) => sql.includes('verification_sent_at')), true);

  const missingSent = [];
  const missingUpdates = [];
  const missing = await stakeholderResendVerification.run({
    ctx: { tenantId: TENANT },
    body: { stakeholder_account_id: STAKE },
    send: capturingMailer(missingSent),
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.stakeholder_accounts'),
        result: () => ({ rows: [{ ...account, verification_recipient_email: null }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.external_payment_recipients'),
        result: () => ({ rows: [] }),
      },
      {
        match: (sql) => sql.includes('UPDATE public.stakeholder_accounts'),
        result: (_params, sql) => {
          missingUpdates.push(sql);
          return { rows: [], rowCount: 1 };
        },
      },
    ]),
  });
  assert.equal(missing.success, false);
  assert.notEqual(missing.emailed, true);
  assert.equal(missingSent.length, 0);
  assert.equal(missingUpdates.some((sql) => sql.includes('verification_sent_at')), false);

  const empty = await stakeholderResendVerification.run({
    ctx: { tenantId: TENANT },
    body: { stakeholder_account_id: STAKE },
    send: async () => ({ results: [], deliveredCount: 0, sunkCount: 0 }),
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.stakeholder_accounts'),
        result: () => ({ rows: [account] }),
      },
    ]),
  });
  assert.equal(empty.success, false);
  assert.notEqual(empty.emailed, true);
});

test('hire-mortgage-agent and tenant invite stay SUPPRESS and never leak passwords', async () => {
  const sent = [];
  const logs = [];
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  console.info = (...args) => logs.push(args.map(String).join(' '));
  console.warn = (...args) => logs.push(args.map(String).join(' '));
  let issuedHire = null;
  let issuedInvite = null;
  try {
    const hire = await runHireMortgageAgent({
      mapping,
      spoof,
      send: capturingMailer(sent),
      body: { email: 'agent@example.com', full_name: 'Mo Agent' },
      cognitoJson: async (target, payload) => {
        if (target === 'AdminCreateUser') {
          issuedHire = payload.TemporaryPassword;
          assert.equal(payload.MessageAction, 'SUPPRESS');
          return { User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: COGNITO_SUB }] } };
        }
        throw new Error(`unexpected ${target}`);
      },
      client: sqlClient([
        {
          match: (sql) => sql.includes("role = 'admin'"),
          result: () => ({ rows: [{ role: 'admin' }] }),
        },
        {
          match: (sql) => sql.includes('is_master_owner'),
          result: () => ({ rows: [{ is_master: true }] }),
        },
        {
          match: (sql) => sql.includes('FROM public.profiles'),
          result: () => ({ rows: [] }),
        },
        {
          match: (sql) => sql.includes('INSERT INTO public.user_roles') && sql.includes('mortgage_agent'),
          result: () => ({ rows: [{ id: '1' }] }),
        },
      ]),
    });
    assert.equal(hire.ok, true);
    assert.equal(hire.invitationSent, true);
    assert.equal(hire.temp_password, undefined);
    assert.ok(issuedHire);
    assert.equal(JSON.stringify(hire).includes(issuedHire), false);
    assert.equal(JSON.stringify(sent).includes(issuedHire), false);
    assert.match(sent[0].html, /mortgage-ops\/login/);
    assert.equal(sent[0].html.toLowerCase().includes(issuedHire.toLowerCase()), false);
    assert.doesNotMatch(sent[0].html, /TemporaryPassword|temp_password|tempPassword/);

    const invite = await runTenantInviteUser({
      mapping,
      spoof,
      identityScope: {
        ok: true,
        identityEnv: 'staging',
        mappingSource: 'identity_accounts',
      },
      send: capturingMailer(sent),
      body: { tenant_id: TENANT, email: 'member@example.com', role: 'member', full_name: 'New Member' },
      cognitoJson: async (target, payload) => {
        if (target === 'AdminCreateUser') {
          issuedInvite = payload.TemporaryPassword;
          assert.equal(payload.MessageAction, 'SUPPRESS');
          return { User: { Username: 'cog2', Attributes: [{ Name: 'sub', Value: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] } };
        }
        throw new Error(`unexpected ${target}`);
      },
      client: sqlClient([
        {
          match: (sql) => sql.includes('FROM public.tenant_users') && sql.includes('SELECT role'),
          result: () => ({ rows: [{ role: 'admin' }] }),
        },
        {
          match: (sql) => sql.includes('FROM public.tenants'),
          result: () => ({ rows: [{ id: TENANT, name: 'Acme', custom_domain: null }] }),
        },
        {
          match: (sql) => sql.includes('FROM public.profiles'),
          result: () => ({ rows: [] }),
        },
        {
          match: (sql) => sql.includes('identity_production_cognito_locks') || sql.includes('set_config'),
          result: () => ({ rows: [] }),
        },
      ]),
    });
    assert.equal(invite.ok, true);
    assert.equal(invite.tempPasswordIssued, true);
    assert.ok(issuedInvite);
    assert.equal(JSON.stringify(invite).includes(issuedInvite), false);
    assert.equal(JSON.stringify(sent[1]).includes(issuedInvite), false);
    assert.doesNotMatch(sent[1].html, /TemporaryPassword|temp_password|tempPassword/);
    assert.equal(logs.some((line) => line.includes(issuedHire) || line.includes(issuedInvite)), false);
  } finally {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
  }
});

test('OTP codes are emailed once and are not written to logs', async () => {
  const sent = [];
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.map(String).join(' '));
  try {
    const otp = await runHomeownerUploadOtpStart({
      spoof,
      send: capturingMailer(sent),
      body: { email: 'home@example.com' },
      client: sqlClient([{
        match: (sql) => sql.includes('aws_public_homeowner_upload_otp_insert'),
        result: () => ({ rows: [{ doc: { ok: true } }] }),
      }]),
    });
    assert.equal(otp.ok, true);
    assert.equal(sent.length, 1);
    const code = otp.stagingDebugCode;
    assert.match(String(code), /^\d{6}$/);
    assert.match(sent[0].html, new RegExp(code));
    assert.equal(logs.some((line) => line.includes(code)), false);
  } finally {
    console.log = origLog;
  }
});
