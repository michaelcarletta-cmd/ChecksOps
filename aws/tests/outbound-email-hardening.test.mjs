import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyRecipientPolicy,
  emailMode,
} from '../functions/api/email-policy.mjs';
import {
  runSendEmail,
  runSendTransactionalEmail,
  sendViaSesOrSink,
} from '../functions/api/email.mjs';
import { requireAuthorizedTenant } from '../functions/api/tenant-email-domain.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const USER = '55555555-5555-4555-8555-555555555555';
const LOCK = 'mcarletta@freedomadj.com';
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
  uniqueOnKey = true,
  failIdempotencySelect = false,
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
      if (failIdempotencySelect && compact.includes('FROM public.email_send_log') && compact.includes('idempotency_key')) {
        throw new Error('email_send_log unavailable');
      }
      if (compact.includes('FROM public.tenants')) {
        const id = String(params[0] || '');
        if (!visibleTenants.includes(id)) return { rows: [] };
        return {
          rows: [{
            id,
            name: id === TENANT ? 'Condition One' : 'Other Tenant',
            logo_url: null,
            primary_color: '#123456',
            email_from_name: 'Ops',
            email_from_address: 'noreply@notify.example.test',
            email_reply_to: 'claims@notify.example.test',
            is_system_tenant: false,
          }],
        };
      }
      if (compact.includes('FROM public.tenant_users')) {
        const tenantId = String(params[0] || '');
        const userId = String(params[1] || '');
        if (tenantId === memberTenant && userId === USER) {
          return { rows: [{ role: 'admin' }] };
        }
        return { rows: [] };
      }
      if (compact.includes('FROM public.user_roles')) return { rows: [] };
      if (compact.includes('is_master_owner')) return { rows: [{ is_master: false }] };
      if (compact.includes('FROM public.suppressed_emails')) return { rows: [] };
      if (compact.includes('FROM public.tenant_email_settings')) {
        return {
          rows: [{
            from_name: 'Condition One',
            reply_to: 'claims@notify.example.test',
            sending_mode: 'custom',
            sending_domain: 'notify.example.test',
            from_address: 'noreply@notify.example.test',
            domain_status: 'verified',
            ses_identity_name: 'notify.example.test',
            custom_sending_enabled: true,
          }],
        };
      }
      if (compact.includes('FROM public.email_send_log') && compact.includes('WHERE idempotency_key')) {
        const key = String(params[0] || '');
        const row = logs.get(key);
        return { rows: row ? [row] : [] };
      }
      if (compact.startsWith('INSERT INTO public.email_send_log')) {
        const key = String(params[7] || params[5] || '');
        if (uniqueOnKey && key && logs.has(key)) {
          const error = new Error('duplicate key');
          error.code = '23505';
          throw error;
        }
        const id = String(params[0]);
        const row = {
          id,
          status: compact.includes("'pending'") ? 'pending' : 'sunk',
          provider_message_id: null,
          recipient_email: params[2],
          tenant_id: params[3],
          metadata: {},
          error_message: null,
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

const brandingQueries = (client) => client.calls.filter((c) => c.sql.includes('tenant_email_settings')).length;

test('same-tenant authorized transactional send reaches the mailer', async () => {
  const sent = [];
  const client = sendClient();
  const result = await runSendTransactionalEmail({
    client,
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: {
      tenantId: TENANT,
      templateName: 'generic-notification',
      recipientEmail: LOCK,
      templateData: { subject: 'Hello', message: 'World' },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, LOCK);
  assert.ok(brandingQueries(client) >= 1);
});

test('same-tenant authorized send-email reaches the mailer', async () => {
  const sent = [];
  const result = await runSendEmail({
    client: sendClient(),
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: {
      tenantId: TENANT,
      to: LOCK,
      subject: 'Hello',
      html: '<p>Hi</p>',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
});

test('missing tenant is denied before branding or mailer', async () => {
  const sent = [];
  const client = sendClient();
  const result = await runSendTransactionalEmail({
    client,
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: {
      templateName: 'generic-notification',
      recipientEmail: LOCK,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'missing_tenant');
  assert.equal(sent.length, 0);
  assert.equal(brandingQueries(client), 0);
});

test('cross-tenant send is denied before branding or SES', async () => {
  const sent = [];
  const hidden = sendClient({ visibleTenants: [] });
  const hiddenResult = await runSendEmail({
    client: hidden,
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: { tenantId: OTHER, to: LOCK, subject: 'x', html: '<p>x</p>' },
  });
  assert.equal(hiddenResult.ok, false);
  assert.equal(hiddenResult.statusCode, 404);
  assert.equal(hiddenResult.error, 'tenant_not_found');
  assert.equal(brandingQueries(hidden), 0);

  const visibleOther = sendClient({ visibleTenants: [OTHER], memberTenant: TENANT });
  const denied = await runSendTransactionalEmail({
    client: visibleOther,
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: {
      tenantId: OTHER,
      templateName: 'generic-notification',
      recipientEmail: LOCK,
    },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.error, 'cross_tenant_denied');
  assert.equal(sent.length, 0);
  assert.equal(brandingQueries(visibleOther), 0);

  const access = await requireAuthorizedTenant(
    sendClient({ visibleTenants: [OTHER], memberTenant: TENANT }),
    mapping,
    OTHER,
    { configure: false },
  );
  assert.equal(access.ok, false);
  assert.equal(access.error, 'cross_tenant_denied');
});

test('unapproved Reply-To and claimEmailCc are rejected', async () => {
  const sent = [];
  const gmail = await runSendEmail({
    client: sendClient(),
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: {
      tenantId: TENANT,
      to: LOCK,
      subject: 'x',
      html: '<p>x</p>',
      replyTo: 'attacker@gmail.com',
    },
  });
  assert.equal(gmail.ok, false);
  assert.equal(gmail.statusCode, 400);
  assert.equal(gmail.error, 'public_mailbox_domain');

  const crlf = await runSendTransactionalEmail({
    client: sendClient(),
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: {
      tenantId: TENANT,
      templateName: 'generic-notification',
      recipientEmail: LOCK,
      claimEmailCc: 'claims@notify.example.test\r\nBcc: victim@example.com',
    },
  });
  assert.equal(crlf.ok, false);
  assert.equal(crlf.statusCode, 400);
  assert.equal(crlf.error, 'invalid_reply_to');
  assert.equal(sent.length, 0);
});

test('unapproved recipient cannot reach SES even in ses mode', async () => {
  await withEnv({
    AWS_EMAIL_MODE: 'ses',
    CHECKSOPS_ENV: 'staging',
    AWS_EMAIL_SES_LOCK_RECIPIENT: LOCK,
  }, async () => {
    const sesSend = async () => {
      throw new Error('SES must not be called for unapproved recipients');
    };
    const mismatch = await sendViaSesOrSink({
      to: 'victim@example.com',
      subject: 'no',
      html: '<p>no</p>',
      sesSend,
    });
    assert.equal(mismatch.results[0].delivery, 'sink');
    assert.equal(mismatch.results[0].policy, 'staging_ses_lock_mismatch');
    assert.equal(mismatch.results[0].blocked, true);
  });

  await withEnv({
    AWS_EMAIL_MODE: 'ses',
    CHECKSOPS_ENV: 'staging',
    AWS_EMAIL_SES_LOCK_RECIPIENT: undefined,
  }, async () => {
    let called = false;
    const missing = await sendViaSesOrSink({
      to: LOCK,
      subject: 'no',
      html: '<p>no</p>',
      sesSend: async () => {
        called = true;
        return { MessageId: 'should-not-send' };
      },
    });
    assert.equal(called, false);
    assert.equal(missing.results[0].delivery, 'sink');
    assert.equal(missing.results[0].policy, 'staging_ses_lock_required');
  });
});

test('unique-violation claim replays without a second send', async () => {
  const sent = [];
  const logs = new Map();
  const client = sendClient({ logs, uniqueOnKey: true });
  const originalQuery = client.query.bind(client);
  let selects = 0;
  client.query = async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ').trim();
    if (compact.includes('FROM public.email_send_log') && compact.includes('WHERE idempotency_key')) {
      selects += 1;
      if (selects === 1) return { rows: [] };
    }
    return originalQuery(sql, params);
  };
  logs.set('txn-race-1', {
    id: 'already-claimed',
    status: 'pending',
    provider_message_id: null,
    recipient_email: LOCK,
    tenant_id: TENANT,
    metadata: {},
    error_message: null,
    idempotency_key: 'txn-race-1',
  });
  const result = await runSendTransactionalEmail({
    client,
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: {
      tenantId: TENANT,
      templateName: 'generic-notification',
      recipientEmail: LOCK,
      idempotencyKey: 'txn-race-1',
      templateData: { subject: 'Race', message: 'Once' },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.reason, 'idempotent_replay');
  assert.equal(sent.length, 0);
  assert.ok(client.calls.some((c) => c.sql.startsWith('ROLLBACK TO SAVEPOINT email_send_log_write')));
});

test('duplicate idempotency key cannot send twice', async () => {
  const sent = [];
  const client = sendClient();
  const body = {
    tenantId: TENANT,
    templateName: 'generic-notification',
    recipientEmail: LOCK,
    idempotencyKey: 'txn-lock-1',
    templateData: { subject: 'Once', message: 'Only' },
  };
  const first = await runSendTransactionalEmail({
    client,
    mapping,
    spoof,
    send: capturingMailer(sent),
    body,
  });
  const second = await runSendTransactionalEmail({
    client,
    mapping,
    spoof,
    send: capturingMailer(sent),
    body,
  });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, undefined);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.reason, 'idempotent_replay');
  assert.equal(sent.length, 1);
  assert.ok(client.calls.some((c) => c.sql.startsWith('SAVEPOINT email_send_log_write')));
});

test('idempotency lookup failure is fail-closed in ses mode and does not send', async () => {
  await withEnv({ AWS_EMAIL_MODE: 'ses', CHECKSOPS_ENV: 'staging', AWS_EMAIL_SES_LOCK_RECIPIENT: LOCK }, async () => {
    const sent = [];
    const result = await runSendTransactionalEmail({
      client: sendClient({ failIdempotencySelect: true }),
      mapping,
      spoof,
      send: capturingMailer(sent),
      body: {
        tenantId: TENANT,
        templateName: 'generic-notification',
        recipientEmail: LOCK,
        idempotencyKey: 'txn-lock-2',
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
    assert.equal(result.error, 'idempotency_unavailable');
    assert.equal(sent.length, 0);
  });
});

test('sink mode still sends when idempotency storage is unavailable', async () => {
  const sent = [];
  const result = await runSendTransactionalEmail({
    client: sendClient({ failIdempotencySelect: true }),
    mapping,
    spoof,
    send: capturingMailer(sent),
    body: {
      tenantId: TENANT,
      templateName: 'generic-notification',
      recipientEmail: LOCK,
      idempotencyKey: 'txn-lock-sink',
    },
  });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
});

test('sink and ses-identity never call SES even with a lock configured', async () => {
  for (const mode of ['sink', 'ses-identity']) {
    await withEnv({
      AWS_EMAIL_MODE: mode,
      CHECKSOPS_ENV: 'staging',
      AWS_EMAIL_SES_LOCK_RECIPIENT: LOCK,
    }, async () => {
      let called = false;
      const result = await sendViaSesOrSink({
        to: LOCK,
        subject: 'stay sunk',
        html: '<p>stay sunk</p>',
        sesSend: async () => {
          called = true;
          return { MessageId: 'nope' };
        },
      });
      assert.equal(emailMode(), mode);
      assert.equal(called, false);
      assert.equal(result.results[0].delivery, 'sink');
      assert.equal(result.results[0].policy, mode === 'ses-identity' ? 'staging_ses_identity' : 'staging_sink');
    });
  }
});

test('approved lock recipient is the only ses-mode delivery', () => {
  const prev = {
    mode: process.env.AWS_EMAIL_MODE,
    env: process.env.CHECKSOPS_ENV,
    lock: process.env.AWS_EMAIL_SES_LOCK_RECIPIENT,
  };
  process.env.AWS_EMAIL_MODE = 'ses';
  process.env.CHECKSOPS_ENV = 'staging';
  process.env.AWS_EMAIL_SES_LOCK_RECIPIENT = LOCK;
  try {
    const [ok] = applyRecipientPolicy([LOCK]);
    const [blocked] = applyRecipientPolicy(['checksops-tester@freedomadj.com']);
    assert.equal(ok.delivery, 'ses');
    assert.equal(ok.policy, 'staging_ses_lock');
    assert.equal(blocked.delivery, 'sink');
    assert.equal(blocked.policy, 'staging_ses_lock_mismatch');
  } finally {
    if (prev.mode === undefined) delete process.env.AWS_EMAIL_MODE;
    else process.env.AWS_EMAIL_MODE = prev.mode;
    if (prev.env === undefined) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = prev.env;
    if (prev.lock === undefined) delete process.env.AWS_EMAIL_SES_LOCK_RECIPIENT;
    else process.env.AWS_EMAIL_SES_LOCK_RECIPIENT = prev.lock;
  }
});
