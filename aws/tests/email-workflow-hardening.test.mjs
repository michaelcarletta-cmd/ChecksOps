import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processEmailQueueBatch as queueBatch } from '../functions/api/email-queue.mjs';
import {
  runSendEmail,
  runSendTransactionalEmail,
  runNotifyMortgageHandlingRequest,
  runNotifyHomeownerLead,
} from '../functions/api/email.mjs';
import { runTenantInviteUser, runHireMortgageAgent } from '../functions/api/tenant-admin.mjs';
import { runSendPaymentDirectionRequest } from '../functions/api/payment-direction-email.mjs';
import { runHomeownerUploadOtpStart } from '../functions/api/homeowner-otp.mjs';
import { runSendSignatureRequest } from '../functions/api/esign.mjs';
import { runHomeownerLedgerSend, runSendFileToHomeowner } from '../functions/api/homeowner.mjs';
import { runAuthenticatedEndorsement } from '../functions/api/check-endorsement.mjs';
import { stakeholderResendVerification } from '../functions/api/providers/parity/moov-onboard.mjs';
import { EMAIL_WORKFLOW_HARDENING_MATRIX } from './email-workflow-hardening-matrix.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '55555555-5555-4555-8555-555555555555';
const LOCK = 'mcarletta@freedomadj.com';
const CLAIM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHECK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FILE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REQUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SIGNER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const STAKE = '99999999-9999-4999-8999-999999999999';
const ENDORSE = '88888888-8888-4888-8888-888888888888';
const mapping = { application_user_id: USER };
const spoof = { ignored: true };

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

const sendClient = ({
  memberTenant = TENANT,
  visibleTenants = [TENANT],
  logs = new Map(),
  extra = {},
} = {}) => {
  const calls = [];
  const client = {
    calls,
    logs,
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: compact, params });
      if (
        compact.startsWith('SAVEPOINT ')
        || compact.startsWith('RELEASE SAVEPOINT ')
        || compact.startsWith('ROLLBACK TO SAVEPOINT ')
      ) {
        return { rows: [], rowCount: 0 };
      }
      if (typeof extra.query === 'function') {
        const hit = await extra.query(compact, params, client);
        if (hit) return hit;
      }
      if (compact.includes('FROM public.tenants')) {
        const id = String(params[0] || '');
        if (!visibleTenants.includes(id)) return { rows: [] };
        return { rows: [{ id, name: 'Condition One', email_reply_to: 'claims@notify.example.test', is_system_tenant: false }] };
      }
      if (compact.includes('FROM public.tenant_users')) {
        const tenantId = String(params[0] || '');
        const userId = String(params[1] || params[0] || '');
        if (compact.includes('WHERE user_id') && !compact.includes('tenant_id = $1')) {
          return { rows: [{ tenant_id: memberTenant, role: 'admin' }] };
        }
        if ((tenantId === memberTenant || visibleTenants.includes(tenantId)) && (userId === USER || params.includes(USER))) {
          return { rows: [{ role: 'admin' }] };
        }
        return { rows: [] };
      }
      if (compact.includes('FROM public.user_roles')) return { rows: [] };
      if (compact.includes('is_master_owner')) return { rows: [{ is_master: extra.master === true }] };
      if (compact.includes('FROM public.suppressed_emails')) return { rows: [] };
      if (compact.includes('FROM public.tenant_email_settings')) {
        return { rows: [{
          from_name: 'Condition One',
          reply_to: 'claims@notify.example.test',
          sending_mode: 'custom',
          sending_domain: 'notify.example.test',
          from_address: 'noreply@notify.example.test',
          domain_status: 'verified',
          ses_identity_name: 'notify.example.test',
          custom_sending_enabled: true,
        }] };
      }
      if (compact.includes('FROM public.email_send_log') && compact.includes('WHERE idempotency_key')) {
        const key = String(params[0] || '');
        const row = logs.get(key);
        return { rows: row ? [row] : [] };
      }
      if (compact.startsWith('INSERT INTO public.email_send_log')) {
        const pending = compact.includes("'pending'");
        const key = String(params[7] || params[5] || '');
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
            } catch { /* keep */ }
          }
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
};

const capturingMailer = (sent) => async (payload) => {
  sent.push(payload);
  return {
    mode: 'sink',
    deliveredCount: 0,
    sunkCount: 1,
    results: [{
      delivery: 'sink',
      status: 'sunk',
      policy: 'staging_sink',
      messageId: `sink-${sent.length}`,
      originalTo: payload.to,
    }],
  };
};

test('transactional email without a caller key still reserves and replays', async () => {
  const sent = [];
  const client = sendClient();
  const body = {
    tenantId: TENANT,
    templateName: 'generic-notification',
    recipientEmail: LOCK,
    templateData: { subject: 'Hello', message: 'World' },
  };
  const first = await runSendTransactionalEmail({
    client, mapping, spoof, send: capturingMailer(sent), body,
  });
  const second = await runSendTransactionalEmail({
    client, mapping, spoof, send: capturingMailer(sent), body,
  });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, undefined);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.reason, 'idempotent_replay');
  assert.equal(sent.length, 1);
  assert.equal([...client.logs.values()][0].tenant_id, TENANT);
});

test('freeform send-email reserves before the mailer and replays', async () => {
  const sent = [];
  const client = sendClient();
  const body = { tenantId: TENANT, to: LOCK, subject: 'Hi', html: '<p>Hi</p>' };
  const first = await runSendEmail({ client, mapping, spoof, send: capturingMailer(sent), body });
  const second = await runSendEmail({ client, mapping, spoof, send: capturingMailer(sent), body });
  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(sent.length, 1);
  assert.equal([...client.logs.values()][0].template_name, 'freeform-send-email');
});

test('SES mode fail-closes send-email when audit storage is down', async () => {
  await withEnv({
    AWS_EMAIL_MODE: 'ses',
    CHECKSOPS_ENV: 'staging',
    AWS_EMAIL_SES_LOCK_RECIPIENT: LOCK,
  }, async () => {
    const sent = [];
    const client = sendClient();
    const original = client.query.bind(client);
    client.query = async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ').trim();
      if (compact.includes('FROM public.email_send_log') && compact.includes('idempotency_key')) {
        throw new Error('email_send_log unavailable');
      }
      return original(sql, params);
    };
    const result = await runSendEmail({
      client,
      mapping,
      spoof,
      send: capturingMailer(sent),
      body: { tenantId: TENANT, to: LOCK, subject: 'Hi', html: '<p>Hi</p>' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
    assert.equal(result.error, 'idempotency_unavailable');
    assert.equal(sent.length, 0);
  });
});

test('tenant invite keeps Cognito side effects but does not email twice', async () => {
  const sent = [];
  let created = 0;
  const client = sendClient({
    extra: {
      query: async (compact) => {
        if (compact.includes('FROM public.profiles')) return { rows: [{ id: USER }] };
        if (compact.includes('INSERT INTO public.tenant_users')) return { rows: [], rowCount: 1 };
        if (compact.includes('INSERT INTO public.identity_accounts')) return { rows: [], rowCount: 1 };
        return null;
      },
    },
  });
  const cognitoJson = async (target) => {
    if (target === 'AdminCreateUser') {
      created += 1;
      return { User: { Username: 'sub-1', Attributes: [{ Name: 'sub', Value: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }] } };
    }
    return { Username: 'sub-1', UserAttributes: [{ Name: 'sub', Value: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }] };
  };
  const body = { tenantId: TENANT, email: LOCK, role: 'member', fullName: 'Ada' };
  const first = await runTenantInviteUser({
    client, mapping, spoof, send: capturingMailer(sent), cognitoJson, body,
  });
  const second = await runTenantInviteUser({
    client, mapping, spoof, send: capturingMailer(sent), cognitoJson, body,
  });
  assert.equal(first.ok, true);
  assert.equal(first.invited, true);
  assert.equal(second.duplicate, true);
  assert.equal(sent.length, 1);
  assert.equal(created, 2);
});

test('hire-mortgage-agent retries replay email without a second SES send', async () => {
  const sent = [];
  const client = sendClient({ extra: { master: true } });
  const original = client.query.bind(client);
  client.query = async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ').trim();
    if (compact.includes('FROM public.profiles')) return { rows: [] };
    if (compact.includes('INSERT INTO public.identity_accounts')) return { rows: [], rowCount: 1 };
    if (compact.includes('INSERT INTO public.profiles')) return { rows: [], rowCount: 1 };
    if (compact.includes('INSERT INTO public.user_roles')) return { rows: [{ id: 'role-1' }] };
    return original(sql, params);
  };
  let created = 0;
  const cognitoJson = async () => {
    created += 1;
    return {
      User: { Attributes: [{ Name: 'sub', Value: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }] },
    };
  };
  const body = { email: LOCK, fullName: 'Ada' };
  const first = await runHireMortgageAgent({
    client, mapping, spoof, send: capturingMailer(sent), cognitoJson, body,
  });
  const second = await runHireMortgageAgent({
    client, mapping, spoof, send: capturingMailer(sent), cognitoJson, body,
  });
  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(sent.length, 1);
  assert.equal(created, 1);
});

test('payment-direction, mortgage notify, and lead notify persist MessageId and tenant', async () => {
  const sent = [];
  const mail = capturingMailer(sent);
  const pd = await runSendPaymentDirectionRequest({
    spoof,
    send: mail,
    body: {
      claimId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      checkId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      requestUrl: 'https://staging.checksops.com/pd',
    },
    client: sendClient({
      extra: {
        query: async (compact) => {
          if (compact.includes('FROM public.claims')) {
            return { rows: [{
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              tenant_id: TENANT,
              policyholder_email: LOCK,
              policyholder_name: 'Ada',
              claim_number: 'CL-1',
              insurance_company: 'Acme',
            }] };
          }
          if (compact.includes('aws_can_write_tenant')) return { rows: [{ ok: true }] };
          if (compact.includes('FROM public.company_branding')) return { rows: [{ company_name: 'C1C' }] };
          return null;
        },
      },
    }),
  });
  assert.equal(pd.ok, true);
  assert.ok(pd.providerMessageId);

  const mortgage = await runNotifyMortgageHandlingRequest({
    mapping,
    spoof,
    send: mail,
    body: { request_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    client: sendClient({
      extra: {
        query: async (compact) => {
          if (compact.includes('FROM public.mortgage_handling_requests')) {
            return { rows: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', tenant_id: TENANT, mortgage_company: 'Bank', status: 'open' }] };
          }
          return null;
        },
      },
    }),
  });
  assert.equal(mortgage.ok, true);
  assert.ok(mortgage.providerMessageId);

  const lead = await runNotifyHomeownerLead({
    mapping,
    spoof,
    send: mail,
    body: { lead_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    client: sendClient({
      extra: {
        query: async (compact) => {
          if (compact.includes('FROM public.homeowner_intro_requests')) {
            return { rows: [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', homeowner_name: 'Ada', contractor_user_id: USER }] };
          }
          if (compact.includes('FROM public.profiles')) return { rows: [{ email: LOCK }] };
          return null;
        },
      },
    }),
  });
  assert.equal(lead.ok, true);
  assert.ok(lead.providerMessageId);
});

test('OTP with a caller idempotency key does not mint a second code', async () => {
  const sent = [];
  let inserts = 0;
  const client = sendClient({
    extra: {
      query: async (compact) => {
        if (compact.includes('aws_public_homeowner_upload_otp_insert')) {
          inserts += 1;
          return { rows: [{ doc: { ok: true } }] };
        }
        return null;
      },
    },
  });
  const body = { email: LOCK, idempotencyKey: 'otp-once-1' };
  const first = await runHomeownerUploadOtpStart({ client, spoof, send: capturingMailer(sent), body });
  const second = await runHomeownerUploadOtpStart({ client, spoof, send: capturingMailer(sent), body });
  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(inserts, 1);
  assert.equal(sent.length, 1);
});

test('email queue claims per row and skips SES on replay', async () => {
  const sent = [];
  const logs = new Map();
  const rows = [{
    id: 'queue-1',
    recipient_email: LOCK,
    subject: 'Queued',
    html_body: '<p>Hi</p>',
    text_body: 'Hi',
    template_name: 'queue',
    tenant_id: TENANT,
    attempts: 0,
  }];
  const client = sendClient({
    logs,
    extra: {
      query: async (compact) => {
        if (compact.includes('FROM public.email_outbox')) return { rows };
        if (compact.startsWith('UPDATE public.email_outbox')) return { rows: [], rowCount: 1 };
        return null;
      },
    },
  });
  const first = await queueBatch(client, 10, spoof, capturingMailer(sent));
  assert.equal(first.processed, 1);
  const second = await queueBatch(client, 10, spoof, capturingMailer(sent));
  assert.equal(second.processed, 1);
  assert.equal(sent.length, 1);
});

test('esign, endorsement, ledger, send-file, and stakeholder retries skip SES and side-effect writes', async () => {
  const sent = [];
  const mail = capturingMailer(sent);

  let tokenRotates = 0;
  const esignClient = sendClient({
    extra: {
      query: async (compact) => {
        if (compact.includes('FROM public.signature_requests')) {
          return { rows: [{ id: REQUEST, document_name: 'Release', claim_id: CLAIM, field_data: [] }] };
        }
        if (compact.includes('FROM public.signature_signers')) {
          return { rows: [{ id: SIGNER, signer_name: 'Ada', signer_email: LOCK }] };
        }
        if (compact.includes('FROM public.claims')) {
          return { rows: [{ id: CLAIM, claim_number: 'CL-1', policyholder_name: 'Ada', tenant_id: TENANT }] };
        }
        if (compact.includes('aws_can_write_tenant')) return { rows: [{ ok: true }] };
        if (compact.includes('UPDATE public.signature_signers') && compact.includes('token_hash')) {
          tokenRotates += 1;
          return { rows: [], rowCount: 1 };
        }
        return null;
      },
    },
  });
  const esignBody = { requestId: REQUEST };
  const esignFirst = await runSendSignatureRequest({
    mapping, spoof, send: mail, body: esignBody, client: esignClient,
  });
  const esignSecond = await runSendSignatureRequest({
    mapping, spoof, send: mail, body: esignBody, client: esignClient,
  });
  assert.equal(esignFirst.ok, true);
  assert.equal(esignSecond.ok, true);
  assert.equal(esignSecond.results?.[0]?.duplicate, true);
  assert.equal(tokenRotates, 1);

  let endorsementTokens = 0;
  const endorseClient = sendClient({
    extra: {
      query: async (compact) => {
        if (compact.includes('FROM public.check_endorsements WHERE id')) {
          return { rows: [{
            id: ENDORSE,
            check_id: CHECK,
            tenant_id: TENANT,
            payee_type: 'insured',
            payee_name: 'Jane',
            contact_email: LOCK,
            token: 'abc',
            request_sent_at: null,
          }] };
        }
        if (compact.includes('FROM public.check_intake_items')) {
          return { rows: [{ id: CHECK, tenant_id: TENANT, check_number: '1001', carrier_name: 'Acme' }] };
        }
        if (compact.includes('aws_can_write_tenant')) return { rows: [{ ok: true }] };
        if (compact.includes('UPDATE public.check_endorsements') && compact.includes('token = $2')) {
          endorsementTokens += 1;
          return { rows: [], rowCount: 1 };
        }
        return null;
      },
    },
  });
  const endorseBody = { action: 'send_endorsement_request', endorsementId: ENDORSE };
  const endorseFirst = await runAuthenticatedEndorsement({
    mapping, spoof, event: { headers: {} }, send: mail, body: endorseBody, client: endorseClient,
  });
  const endorseSecond = await runAuthenticatedEndorsement({
    mapping, spoof, event: { headers: {} }, send: mail, body: endorseBody, client: endorseClient,
  });
  assert.equal(endorseFirst.ok, true);
  assert.equal(endorseSecond.duplicate, true);
  assert.equal(endorsementTokens, 1);

  let ledgerInserts = 0;
  const ledgerClient = sendClient({
    extra: {
      query: async (compact) => {
        if (compact.includes('INSERT INTO public.homeowner_ledger_tokens')) {
          ledgerInserts += 1;
          return { rows: [{ id: 't1', token: 'ledgertok' }] };
        }
        if (compact.includes('FROM public.homeowner_ledger_tokens')) {
          return { rows: [{ id: 't1', token: 'ledgertok' }] };
        }
        return null;
      },
    },
  });
  const ledgerBody = {
    homeowner_email: LOCK,
    homeowner_name: 'Ada',
    tenant_id: TENANT,
    claim_id: CLAIM,
  };
  const ledgerFirst = await runHomeownerLedgerSend({
    mapping, spoof, send: mail, body: ledgerBody, client: ledgerClient,
  });
  const ledgerSecond = await runHomeownerLedgerSend({
    mapping, spoof, send: mail, body: ledgerBody, client: ledgerClient,
  });
  assert.equal(ledgerFirst.ok, true);
  assert.equal(ledgerSecond.duplicate, true);
  assert.equal(ledgerInserts, 0);

  let timeline = 0;
  const fileClient = sendClient({
    extra: {
      query: async (compact) => {
        if (compact.includes('FROM public.check_files')) {
          return { rows: [{ id: FILE, check_id: CHECK, tenant_id: TENANT, file_name: 'est.pdf' }] };
        }
        if (compact.includes('FROM public.check_intake_items')) {
          return { rows: [{ claim_id: CLAIM }] };
        }
        if (compact.includes('FROM public.homeowner_ledger_tokens')) {
          return { rows: [{ token: 'ledgertok', homeowner_email: LOCK, homeowner_name: 'Ada' }] };
        }
        if (compact.includes('INSERT INTO public.homeowner_ledger_events')) {
          timeline += 1;
          return { rows: [], rowCount: 1 };
        }
        return null;
      },
    },
  });
  const fileBody = { check_file_id: FILE, note: 'See attached' };
  const fileFirst = await runSendFileToHomeowner({
    mapping, spoof, send: mail, body: fileBody, client: fileClient,
  });
  const fileSecond = await runSendFileToHomeowner({
    mapping, spoof, send: mail, body: fileBody, client: fileClient,
  });
  assert.equal(fileFirst.ok, true);
  assert.equal(fileSecond.duplicate, true);
  assert.equal(timeline, 1);

  let stakeholderUpdates = 0;
  const stakeClient = sendClient({
    extra: {
      query: async (compact) => {
        if (compact.includes('FROM public.stakeholder_accounts')) {
          return { rows: [{
            id: STAKE,
            tenant_id: TENANT,
            nickname: 'Ada',
            custname: 'Ada Lovelace',
            verification_recipient_email: LOCK,
            verification_sent_at: null,
          }] };
        }
        if (compact.includes('UPDATE public.stakeholder_accounts')) {
          stakeholderUpdates += 1;
          return { rows: [], rowCount: 1 };
        }
        return null;
      },
    },
  });
  const stakeBody = { stakeholder_account_id: STAKE };
  const stakeFirst = await stakeholderResendVerification.run({
    ctx: { tenantId: TENANT }, body: stakeBody, send: mail, client: stakeClient,
  });
  const stakeSecond = await stakeholderResendVerification.run({
    ctx: { tenantId: TENANT }, body: stakeBody, send: mail, client: stakeClient,
  });
  assert.equal(stakeFirst.success, true);
  assert.equal(stakeSecond.duplicate, true);
  assert.equal(stakeholderUpdates, 2);
  assert.equal(sent.length, 5);
});

test('hardening matrix covers every requested workflow', () => {
  const required = [
    'send-email',
    'send-transactional-email',
    'tenant-invite-user',
    'hire-mortgage-agent',
    'send-signature-request',
    'send-endorsement-request',
    'send-payment-direction-request',
    'homeowner-ledger-send',
    'send-file-to-homeowner',
    'homeowner-upload-otp',
    'notify-mortgage-handling-request',
    'notify-homeowner-lead',
    'stakeholder-resend-verification',
    'process-email-queue',
    'send-portal-invite',
  ];
  for (const name of required) {
    const row = EMAIL_WORKFLOW_HARDENING_MATRIX.find((item) => item.workflow === name);
    assert.ok(row, `missing matrix row ${name}`);
    assert.ok(['hardened', 'not_applicable', 'remaining_gap'].includes(row.status), name);
    assert.ok(row.tenantAuth);
    assert.ok(row.preSendReservation);
    assert.ok(row.idempotency);
    assert.ok(row.messageIdPersistence);
    assert.ok(row.retryBehavior);
  }
});
