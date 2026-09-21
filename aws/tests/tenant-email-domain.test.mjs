import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  normalizeSendingDomain,
  normalizeFromLocalPart,
  sanitizeDisplayName,
  displayNameIsUnsafe,
  isProtectedPlatformDomain,
  resetDomainRateLimits,
  fallbackFromHeader,
  sesIdentityVerified,
  consumeDurableRateLimit,
  RATE_LIMITS,
  RATE_LIMIT_ACTIONS,
  assertSendingDomainUniquenessPreflight,
  duplicateSendingDomainCounts,
  SENDING_DOMAIN_PREFLIGHT_SQL,
  CONSUME_RATE_LIMIT_SQL,
  safeAuditPayload,
} from '../functions/api/tenant-email-domain.mjs';
import {
  runStartDomainVerification,
  runCheckDomainVerification,
  runDisableCustomSending,
  runSaveEmailBranding,
  runGetEmailBranding,
  runPreviewEmailBranding,
  runDeleteSesIdentity,
} from '../functions/api/tenant-email-domain-handlers.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';
import { sendViaSesOrSink } from '../functions/api/email.mjs';
import { sesMessageTags, normalizeSesEngagementEvent } from '../functions/api/email-ses.mjs';
import { isVerifiedCustomSender } from '../functions/api/email-branding.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const USER = '55555555-5555-4555-8555-555555555555';
const DOMAIN = 'notify.freedomadj.com';

const mapping = { application_user_id: USER };
const spoof = { ignored: true, headerTenantId: OTHER, headerUserId: 'spoof-user' };

const mockSes = (overrides = {}) => {
  const calls = [];
  const adapter = {
    calls,
    identity: {
      EmailIdentity: DOMAIN,
      VerificationStatus: 'PENDING',
      DkimAttributes: {
        Status: 'PENDING',
        SigningEnabled: true,
        Tokens: ['tokena', 'tokenb', 'tokenc'],
      },
      ...overrides.identity,
    },
    createEmailIdentity: async (input) => {
      calls.push(['createEmailIdentity', input]);
      return { ...adapter.identity, EmailIdentity: input.EmailIdentity };
    },
    getEmailIdentity: async (input) => {
      calls.push(['getEmailIdentity', input]);
      return { ...adapter.identity, EmailIdentity: input.EmailIdentity };
    },
    deleteEmailIdentity: async (input) => {
      calls.push(['deleteEmailIdentity', input]);
      return {};
    },
    ...overrides,
  };
  return adapter;
};

const ALLOWED_RATE_LIMIT_ACTIONS = new Set(RATE_LIMIT_ACTIONS);

const pgError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const createRateLimitStore = (dbNowMs = 1_700_000_000_000) => {
  const rows = new Map();
  let chain = Promise.resolve();
  const locked = async (fn) => {
    let release;
    const wait = new Promise((resolve) => { release = resolve; });
    const prev = chain;
    chain = prev.then(() => wait, () => wait);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };
  return { rows, locked, dbNowMs };
};

const memoryClient = (opts = {}) => {
  const settings = new Map(opts.settings || []);
  const audits = [];
  const rateLimitStore = opts.rateLimitStore || createRateLimitStore();
  const tenant = {
    id: TENANT,
    name: 'Freedom Adjustment',
    logo_url: 'https://cdn.freedomadj.com/logo.png',
    primary_color: '#0f4c81',
    is_system_tenant: false,
    email_reply_to: 'claims@freedomadj.com',
    ...opts.tenant,
  };
  const state = {
    membershipRole: opts.membershipRole === undefined ? 'admin' : opts.membershipRole,
    systemRole: opts.systemRole || null,
    master: opts.master === true,
    platformOwner: opts.platformOwner === true,
    otherDomain: opts.otherDomain || null,
    failAudit: opts.failAudit === true,
    missingRateLimitFunction: opts.missingRateLimitFunction === true,
    dbRole: opts.dbRole || 'checksops',
    authUid: opts.authUid || USER,
    settings,
    audits,
    tenant,
    rateLimitStore,
  };
  let snapshot = null;
  const cloneMap = (map) => new Map([...map].map(([key, value]) => [key, value && typeof value === 'object' ? { ...value } : value]));
  const takeSnapshot = () => ({
    settings: cloneMap(state.settings),
    audits: state.audits.map((row) => ({ ...row })),
    rateLimits: cloneMap(state.rateLimitStore.rows),
  });
  const restoreSnapshot = (snap) => {
    state.settings.clear();
    for (const [key, value] of snap.settings) state.settings.set(key, { ...value });
    state.audits.splice(0, state.audits.length, ...snap.audits.map((row) => ({ ...row })));
    state.rateLimitStore.rows.clear();
    for (const [key, value] of snap.rateLimits) state.rateLimitStore.rows.set(key, { ...value });
  };

  return {
    state,
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ').trim();
      if (compact === 'BEGIN') {
        snapshot = takeSnapshot();
        return { rows: [], rowCount: 0 };
      }
      if (compact === 'ROLLBACK') {
        if (snapshot) restoreSnapshot(snapshot);
        snapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (compact === 'COMMIT') {
        snapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (compact.includes('FROM public.tenants')) {
        return { rows: params[0] === TENANT ? [state.tenant] : [] };
      }
      if (compact.includes('FROM public.tenant_users')) {
        if (params[0] !== TENANT) return { rows: [] };
        return { rows: state.membershipRole ? [{ role: state.membershipRole }] : [] };
      }
      if (compact.includes('FROM public.user_roles')) {
        return { rows: state.systemRole ? [{ role: state.systemRole }] : [] };
      }
      if (compact.includes('is_master_owner')) {
        return { rows: [{ is_master: state.master }] };
      }
      if (compact.includes('is_platform_owner')) {
        return { rows: [{ is_owner: state.master === true || state.platformOwner === true }] };
      }
      if (/set_config/i.test(compact) && params[0] === 'request.app_user_id') {
        state.authUid = params[1];
        return { rows: [{ set_config: params[1] }], rowCount: 1 };
      }
      if (compact.includes('consume_tenant_email_action_rate_limit')) {
        if (state.missingRateLimitFunction) {
          throw pgError(
            '42883',
            'function consume_tenant_email_action_rate_limit(uuid, uuid, text, integer, integer) does not exist',
          );
        }
        if (state.dbRole !== 'checksops') {
          throw pgError('42501', 'permission denied for function consume_tenant_email_action_rate_limit');
        }
        const [tenantId, userId, action, limit, windowSeconds] = params;
        if (!tenantId || !userId) {
          throw pgError('22023', 'invalid_rate_limit_identity');
        }
        if (String(userId) !== String(state.authUid)) {
          throw pgError('42501', 'rate_limit_caller_mismatch');
        }
        if (!ALLOWED_RATE_LIMIT_ACTIONS.has(action)) {
          throw pgError('22023', 'invalid_rate_limit_action');
        }
        const bound = Number(limit);
        const windowSecs = Number(windowSeconds);
        if (!Number.isInteger(bound) || bound < 1 || bound > 1000) {
          throw pgError('22023', 'invalid_rate_limit_bound');
        }
        if (!Number.isInteger(windowSecs) || windowSecs < 1 || windowSecs > 86400) {
          throw pgError('22023', 'invalid_rate_limit_window');
        }
        return state.rateLimitStore.locked(() => {
          const now = state.rateLimitStore.dbNowMs;
          const windowMs = windowSecs * 1000;
          const key = `${tenantId}:${userId}:${action}`;
          const prev = state.rateLimitStore.rows.get(key);
          const expired = !prev || (now - prev.window_started_at) >= windowMs;
          const next = expired
            ? { window_started_at: now, request_count: 1 }
            : { window_started_at: prev.window_started_at, request_count: prev.request_count + 1 };
          state.rateLimitStore.rows.set(key, next);
          const allowed = next.request_count <= bound;
          const retryAfterSeconds = allowed
            ? 0
            : Math.max(1, Math.ceil((next.window_started_at + windowMs - now) / 1000));
          return {
            rows: [{
              allowed,
              count: next.request_count,
              retry_after_seconds: retryAfterSeconds,
            }],
            rowCount: 1,
          };
        });
      }
      if (compact.includes('tenant_email_action_rate_limits')) {
        throw pgError('42501', 'permission denied for table tenant_email_action_rate_limits');
      }
      if (compact.includes('lower(sending_domain)')) {
        const domain = params[0];
        const except = params[1];
        if (state.otherDomain && state.otherDomain === domain && except !== OTHER) {
          return { rows: [{ tenant_id: OTHER, domain_status: 'pending', sending_domain: domain }] };
        }
        for (const [tid, row] of state.settings) {
          if (String(row.sending_domain || '').toLowerCase() === domain && tid !== except) {
            return { rows: [{ tenant_id: tid, domain_status: row.domain_status, sending_domain: row.sending_domain }] };
          }
        }
        return { rows: [] };
      }
      if (compact.includes('INSERT INTO public.audit_logs')) {
        if (state.failAudit) {
          const error = new Error('audit insert failed');
          error.code = '57014';
          throw error;
        }
        const payload = { action: params[1], record_type: params[2], record_id: params[3], new_values: params[5], metadata: params[6] };
        const blob = JSON.stringify(payload);
        if (/otp|secret|password|arn:aws|access.key|dkim|tokena|@/i.test(blob) && /AKIA|otp-|token=|noreply@|claims@/i.test(blob)) {
          throw new Error(`audit leaked secret: ${blob.slice(0, 200)}`);
        }
        state.audits.push(payload);
        return { rows: [{ id: 'audit-1' }], rowCount: 1 };
      }
      if (compact.includes('INSERT INTO public.tenant_email_settings')) {
        const cols = compact.match(/tenant_email_settings \(([^)]+)\)/)[1]
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c !== 'updated_at');
        const row = { ...(state.settings.get(params[0]) || {}) };
        cols.forEach((col, i) => {
          let value = params[i];
          if ((col === 'dns_records' || col === 'mail_from_records') && typeof value === 'string') {
            try { value = JSON.parse(value); } catch { /* keep */ }
          }
          row[col] = value;
        });
        row.tenant_id = params[0];
        state.settings.set(params[0], row);
        return { rows: [], rowCount: 1 };
      }
      if (compact.includes('FROM public.tenant_email_settings')) {
        const row = state.settings.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
};

const withTx = async (client, fn) => {
  await client.query('BEGIN');
  try {
    const result = await fn();
    const status = Number(result?.statusCode || (result?.ok === false ? 400 : 200));
    if (result?.ok !== false && status < 400) await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};

test('valid subdomain normalization and invalid domain rejection', () => {
  assert.equal(normalizeSendingDomain('Notify.FreedomAdj.com.').domain, DOMAIN);
  assert.equal(normalizeSendingDomain('mailto:x@y.com').error, 'invalid_domain');
  assert.equal(normalizeSendingDomain('user@notify.freedomadj.com').reason, 'email_address');
  assert.equal(normalizeSendingDomain('https://notify.freedomadj.com/path').reason, 'url');
  assert.equal(normalizeSendingDomain('notify.freedomadj.com/app').reason, 'path');
  assert.equal(normalizeSendingDomain('*.freedomadj.com').reason, 'wildcard');
  assert.equal(normalizeSendingDomain('127.0.0.1').reason, 'ip');
  assert.equal(normalizeSendingDomain('notify.freedomadj.com%0d%0aBcc:evil@x.com').reason, 'crlf');
  assert.equal(normalizeSendingDomain('gmail.com').error, 'invalid_domain');
  assert.equal(normalizeSendingDomain('mail.gmail.com').error, 'public_mailbox_domain');
  assert.equal(normalizeSendingDomain('notify.outlook.com').error, 'public_mailbox_domain');
  assert.equal(normalizeSendingDomain('checksops.com').error, 'invalid_domain');
  assert.equal(normalizeSendingDomain('notify.checksops.com').error, 'protected_platform_domain');
  assert.equal(normalizeSendingDomain('staging.checksops.com').error, 'protected_platform_domain');
  assert.equal(isProtectedPlatformDomain('mail.checksops.com'), true);
  assert.equal(normalizeFromLocalPart('noreply').localPart, 'noreply');
  assert.equal(normalizeFromLocalPart('bad local').ok, false);
  assert.equal(displayNameIsUnsafe('Evil\r\nBcc: x@y.com'), true);
  assert.equal(sanitizeDisplayName('Freedom\nAdjustment', 'X'), 'FreedomAdjustment');
});

test('duplicate domain across tenants is rejected', async () => {
  resetDomainRateLimits();
  const client = memoryClient({ otherDomain: DOMAIN });
  const sesv2 = mockSes();
  const result = await runStartDomainVerification({
    client,
    mapping,
    body: { tenantId: TENANT, domain: DOMAIN },
    spoof,
    sesv2,
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'domain_already_assigned');
  assert.equal(sesv2.calls.length, 0);
});

test('tenant admin can start verification pending until SES confirms', async () => {
  resetDomainRateLimits();
  const client = memoryClient();
  const sesv2 = mockSes();
  const started = await runStartDomainVerification({
    client,
    mapping,
    body: {
      tenantId: TENANT,
      domain: DOMAIN,
      fromLocalPart: 'noreply',
      fromName: 'Freedom Adjustment',
      replyTo: 'claims@freedomadj.com',
      domain_status: 'verified',
    },
    spoof,
    sesv2,
  });
  assert.equal(started.ok, true);
  assert.equal(started.status, 'pending');
  assert.equal(started.verified, false);
  assert.equal(started.dns.length, 3);
  assert.equal(started.dns[0].type, 'CNAME');
  assert.match(started.fallbackFrom, /Freedom Adjustment via ChecksOps/);
  assert.match(started.fallbackFrom, /noreply@checksops\.com/);
  const stored = client.state.settings.get(TENANT);
  assert.equal(stored.domain_status, 'pending');
  assert.equal(stored.custom_sending_enabled, false);
  assert.equal(sesv2.calls[0][0], 'createEmailIdentity');
  assert.equal(sesv2.calls[0][1].EmailIdentity, DOMAIN);

  const checked = await runCheckDomainVerification({
    client, mapping, body: { tenantId: TENANT }, spoof, sesv2,
  });
  assert.equal(checked.verified, false);
  assert.ok(['pending', 'verifying'].includes(checked.status));
  assert.equal(client.state.settings.get(TENANT).domain_status !== 'verified', true);
});

test('SES success activates custom From; DKIM failure does not', async () => {
  resetDomainRateLimits();
  const client = memoryClient();
  const sesv2 = mockSes();
  await runStartDomainVerification({
    client, mapping, body: { tenantId: TENANT, domain: DOMAIN, replyTo: 'claims@freedomadj.com' }, spoof, sesv2,
  });

  sesv2.identity.VerificationStatus = 'SUCCESS';
  sesv2.identity.DkimAttributes.Status = 'FAILED';
  const dkimFail = await runCheckDomainVerification({
    client, mapping, body: { tenantId: TENANT }, spoof, sesv2,
  });
  assert.equal(dkimFail.verified, false);
  assert.equal(isVerifiedCustomSender(client.state.settings.get(TENANT)), false);

  sesv2.identity.DkimAttributes.Status = 'SUCCESS';
  const ok = await runCheckDomainVerification({
    client, mapping, body: { tenantId: TENANT }, spoof, sesv2,
  });
  assert.equal(ok.verified, true);
  assert.equal(ok.status, 'verified');
  const row = client.state.settings.get(TENANT);
  assert.equal(row.domain_status, 'verified');
  assert.equal(row.custom_sending_enabled, true);
  assert.equal(row.from_address, `noreply@${DOMAIN}`);
  assert.equal(isVerifiedCustomSender(row), true);
  assert.ok(row.verified_at);
  assert.ok(row.last_checked_at);
});

test('authorization: member cannot configure, cross-tenant denied, platform owner can', async () => {
  resetDomainRateLimits();
  const memberClient = memoryClient({ membershipRole: 'member' });
  const sesv2 = mockSes();
  const memberStart = await runStartDomainVerification({
    client: memberClient, mapping, body: { tenantId: TENANT, domain: DOMAIN }, spoof, sesv2,
  });
  assert.equal(memberStart.statusCode, 403);
  const memberGet = await runGetEmailBranding({
    client: memberClient, mapping, body: { tenantId: TENANT }, spoof,
  });
  assert.equal(memberGet.ok, true);
  assert.equal(memberGet.settings.canConfigure, false);

  const stranger = memoryClient({ membershipRole: null, systemRole: null, master: false });
  const cross = await runGetEmailBranding({
    client: stranger, mapping, body: { tenantId: TENANT }, spoof,
  });
  assert.equal(cross.statusCode, 403);

  const platform = memoryClient({ membershipRole: null, systemRole: 'admin', master: false });
  const ownerStart = await runStartDomainVerification({
    client: platform, mapping, body: { tenantId: TENANT, domain: DOMAIN }, spoof, sesv2,
  });
  assert.equal(ownerStart.ok, true);

  const ownerOnly = memoryClient({ membershipRole: null, systemRole: null, master: false, platformOwner: true });
  const ownerGet = await runGetEmailBranding({
    client: ownerOnly, mapping, body: { tenantId: TENANT }, spoof,
  });
  assert.equal(ownerGet.ok, true);
  assert.equal(ownerGet.settings.canConfigure, true);
  const ownerSave = await runSaveEmailBranding({
    client: ownerOnly,
    mapping,
    body: { tenantId: TENANT, fromName: 'Pipeline Test', replyTo: 'ops@example.com' },
    spoof,
  });
  assert.equal(ownerSave.ok, true);
});

test('frontend cannot set verified status on save', async () => {
  resetDomainRateLimits();
  const client = memoryClient();
  client.state.settings.set(TENANT, {
    tenant_id: TENANT,
    sending_domain: DOMAIN,
    domain_status: 'pending',
    sending_mode: 'custom',
    from_address: `noreply@${DOMAIN}`,
  });
  const saved = await runSaveEmailBranding({
    client,
    mapping,
    body: {
      tenantId: TENANT,
      fromName: 'Freedom Adjustment',
      replyTo: 'claims@freedomadj.com',
      domain_status: 'verified',
      sending_mode: 'custom',
      verified: true,
    },
    spoof,
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.ignoredClientFields.sort(), ['domain_status', 'sending_mode', 'verified']);
  assert.equal(client.state.settings.get(TENANT).domain_status, 'pending');
});

test('unsafe From display names are rejected; from must belong to verified domain', async () => {
  resetDomainRateLimits();
  const client = memoryClient();
  const unsafe = await runSaveEmailBranding({
    client,
    mapping,
    body: { tenantId: TENANT, fromName: 'X\r\nBcc: evil@x.com' },
    spoof,
  });
  assert.equal(unsafe.statusCode, 400);
  assert.equal(unsafe.error, 'unsafe_from_name');

  assert.equal(isVerifiedCustomSender({
    sending_mode: 'custom',
    domain_status: 'verified',
    sending_domain: DOMAIN,
    ses_identity_name: DOMAIN,
    from_address: 'noreply@freedomadj.com',
  }), false);
  assert.equal(isVerifiedCustomSender({
    sending_mode: 'custom',
    domain_status: 'verified',
    sending_domain: DOMAIN,
    ses_identity_name: DOMAIN,
    from_address: `noreply@${DOMAIN}`,
  }), true);
});

test('disable custom sending does not delete SES identity', async () => {
  resetDomainRateLimits();
  const client = memoryClient();
  const sesv2 = mockSes();
  await runStartDomainVerification({
    client, mapping, body: { tenantId: TENANT, domain: DOMAIN }, spoof, sesv2,
  });
  sesv2.identity.VerificationStatus = 'SUCCESS';
  sesv2.identity.DkimAttributes.Status = 'SUCCESS';
  await runCheckDomainVerification({
    client, mapping, body: { tenantId: TENANT }, spoof, sesv2,
  });
  const disabled = await runDisableCustomSending({
    client, mapping, body: { tenantId: TENANT }, spoof,
  });
  assert.equal(disabled.disabled, true);
  assert.equal(disabled.sesIdentityDeleted, false);
  assert.equal(isVerifiedCustomSender(client.state.settings.get(TENANT)), false);
  assert.equal(sesv2.calls.some((c) => c[0] === 'deleteEmailIdentity'), false);

  const operator = await runDeleteSesIdentity({
    client: memoryClient({ master: true, systemRole: 'admin' }),
    mapping,
    body: { tenantId: TENANT, domain: DOMAIN },
    spoof,
    sesv2,
  });
  assert.equal(operator.statusCode, 403);
});

test('preview uses shared layout and fallback keeps tenant logo/color', async () => {
  const client = memoryClient();
  client.state.settings.set(TENANT, {
    tenant_id: TENANT,
    sending_mode: 'custom',
    sending_domain: DOMAIN,
    from_address: `noreply@${DOMAIN}`,
    domain_status: 'pending',
    from_name: 'Freedom Adjustment',
    reply_to: 'claims@freedomadj.com',
  });
  const preview = await runPreviewEmailBranding({
    client, mapping, body: { tenantId: TENANT }, spoof,
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.usingCustomFrom, false);
  assert.match(preview.from, /via ChecksOps/);
  assert.match(preview.from, /noreply@checksops\.com/);
  assert.equal(preview.replyTo, 'claims@freedomadj.com');
  assert.match(preview.html, /cdn\.freedomadj\.com\/logo\.png/);
  assert.match(preview.html, /#0f4c81/);
  assert.match(preview.html, /support@checksops\.com/);
  assert.match(preview.html, /Sent by ChecksOps/);
});

test('sink mode remains active and no live SES SDK is imported', async () => {
  const prev = process.env.AWS_EMAIL_MODE;
  process.env.AWS_EMAIL_MODE = 'sink';
  const sunk = await sendViaSesOrSink({
    to: 'claims@freedomadj.com',
    subject: 'x',
    html: '<p>x</p>',
    sesSend: async () => { throw new Error('live SES must not run'); },
  });
  assert.equal(sunk.mode, 'sink');
  process.env.AWS_EMAIL_MODE = prev;

  const src = [
    fs.readFileSync(path.join(ROOT, 'aws/functions/api/tenant-email-domain.mjs'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'aws/functions/api/tenant-email-domain-handlers.mjs'), 'utf8'),
  ].join('\n');
  assert.match(src, /@aws-sdk\/client-sesv2/);
  assert.match(src, /tenantEmailDomainEnabled/);
  assert.doesNotMatch(src, /from '@aws-sdk\/client-sesv2'/);
});

test('SES tags omit PII and engagement interface stays inert', () => {
  const tags = sesMessageTags({
    tenantId: TENANT,
    category: 'signature_request',
  });
  assert.deepEqual(tags.map((t) => t.Name).sort(), ['message_category', 'tenant_id']);
  assert.equal(sesMessageTags({ tenantId: 'not-a-uuid', category: 'claim-123' }).length, 0);
  const event = normalizeSesEngagementEvent({
    eventType: 'bounce',
    mail: { tags: { tenant_id: [TENANT], message_category: ['payment_direction'] }, timestamp: '2026-09-10T00:00:00Z' },
    bounce: { bounceType: 'Permanent' },
  });
  assert.equal(event.type, 'bounce');
  assert.equal(event.tenantId, TENANT);
  assert.equal(event.category, 'payment_direction');
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'email'), false);
});

test('class A registry includes branding routes; frontend never writes domain_status', () => {
  for (const name of [
    'tenant-domain-verify',
    'tenant-domain-check',
    'tenant-domain-disable',
    'tenant-email-branding-get',
    'tenant-email-branding-save',
    'tenant-email-preview',
    'tenant-ses-identity-delete',
  ]) {
    assert.ok(CLASS_A_FUNCTIONS.has(name), name);
  }
  const ui = fs.readFileSync(path.join(ROOT, 'src/components/settings/EmailSenderSettings.tsx'), 'utf8');
  assert.doesNotMatch(ui, /domain_status\s*:\s*['"`]/);
  assert.doesNotMatch(ui, /update\([\s\S]{0,200}domain_status/);
  assert.doesNotMatch(ui, /upsert\([\s\S]{0,200}domain_status/);
  assert.match(ui, /tenant-domain-disable/);
  assert.match(ui, /tenant-email-preview/);
  assert.match(ui, /noreply@checksops\.com/);
  assert.doesNotMatch(ui, /notify\.checksops\.com/);
  const yaml = fs.readFileSync(path.join(ROOT, 'aws/template.yaml'), 'utf8');
  assert.match(yaml, /AWS_TENANT_EMAIL_DOMAIN_ENABLED:\s*"false"/);
  assert.match(yaml, /AWS_EMAIL_MODE:\s*"sink"/);
  const proposed = fs.readFileSync(
    path.join(ROOT, 'aws/migrations/proposed/NOT_APPLIED_20260910_tenant_email_ses_domain.sql'),
    'utf8',
  );
  assert.match(proposed, /NOT APPLIED/);
  assert.match(proposed, /^BEGIN;/m);
  assert.match(proposed, /^COMMIT;/m);
  assert.match(proposed, /RAISE EXCEPTION 'tenant_email_settings duplicate sending_domain values/);
  assert.match(proposed, /tenant_email_action_rate_limits/);
  assert.match(proposed, /consume_tenant_email_action_rate_limit/);
  assert.match(proposed, /SECURITY DEFINER/);
  assert.match(proposed, /SET search_path = public, pg_temp/);
  assert.match(proposed, /OWNER TO checksops_admin/);
  assert.match(proposed, /GRANT EXECUTE ON FUNCTION public\.consume_tenant_email_action_rate_limit\(uuid, uuid, text, integer, integer\)\s+TO checksops/);
  assert.match(proposed, /REVOKE ALL ON FUNCTION public\.consume_tenant_email_action_rate_limit\(uuid, uuid, text, integer, integer\)\s+FROM PUBLIC/);
  assert.match(proposed, /REVOKE ALL ON TABLE public\.tenant_email_action_rate_limits FROM checksops/);
  assert.match(proposed, /p_user_id IS DISTINCT FROM auth\.uid\(\)/);
  assert.match(proposed, /INSERT INTO public\.tenant_email_action_rate_limits/);
  assert.match(proposed, /ON CONFLICT \(tenant_id, user_id, action\)/);
  assert.match(proposed, /now\(\)/);
  assert.doesNotMatch(proposed, /client_timestamp|request_time|Date\.now/);
  assert.doesNotMatch(proposed, /GRANT (SELECT|INSERT|UPDATE|DELETE) ON TABLE public\.tenant_email_action_rate_limits/);
  assert.match(proposed, /RETURNS TABLE\(allowed boolean, count integer, retry_after_seconds integer\)/);
  assert.doesNotMatch(proposed, /CREATE POLICY/);
  assert.doesNotMatch(proposed, /GRANT EXECUTE[\s\S]{0,200}TO (authenticated|anon|PUBLIC)/);
  assert.match(CONSUME_RATE_LIMIT_SQL, /consume_tenant_email_action_rate_limit/);
  assert.doesNotMatch(CONSUME_RATE_LIMIT_SQL, /INSERT INTO public\.tenant_email_action_rate_limits/);
  assert.doesNotMatch(CONSUME_RATE_LIMIT_SQL, /Date\.now|window_started_at/);
  assert.match(SENDING_DOMAIN_PREFLIGHT_SQL, /HAVING count\(\*\) > 1/);
  const allowedTables = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'aws/functions/api/allowed-tables.json'),
    'utf8',
  ));
  assert.equal(allowedTables.includes('tenant_email_action_rate_limits'), false);
  const classAGrants = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/68_staging_class_a_grants.sql'), 'utf8');
  assert.match(classAGrants, /GRANT EXECUTE ON FUNCTION .+ TO checksops/);
  const writeAuth = fs.readFileSync(path.join(ROOT, 'aws/rls/WRITE_AUTHORIZATION.md'), 'utf8');
  assert.match(writeAuth, /API role is `checksops`, never `checksops_admin`/);
  assert.equal(sesIdentityVerified({
    VerificationStatus: 'SUCCESS',
    DkimAttributes: { Status: 'SUCCESS', SigningEnabled: true },
  }), true);
  assert.equal(fallbackFromHeader('Freedom Adjustment').includes('noreply@checksops.com'), true);
});

test('durable rate limits persist across instances and isolate tenant/user/action', async () => {
  resetDomainRateLimits();
  const store = createRateLimitStore();
  const clientA = memoryClient({ rateLimitStore: store });
  const clientB = memoryClient({ rateLimitStore: store });
  const args = {
    tenantId: TENANT,
    userId: USER,
    action: 'domain_start',
    limit: RATE_LIMITS.domain_start.limit,
    windowMs: RATE_LIMITS.domain_start.windowMs,
  };
  for (let i = 0; i < 4; i += 1) {
    const allowed = await consumeDurableRateLimit(clientA, { ...args, memory: new Map() });
    assert.equal(allowed.ok, true, `instance A hit ${i + 1}`);
  }
  const fifth = await consumeDurableRateLimit(clientB, { ...args, memory: new Map() });
  assert.equal(fifth.ok, true);
  assert.equal(fifth.source, 'database');
  const sixth = await consumeDurableRateLimit(clientA, { ...args, memory: new Map() });
  assert.equal(sixth.ok, false);
  assert.ok(sixth.retryAfterSec >= 1);
  assert.equal(sixth.source, 'database');

  const otherTenant = await consumeDurableRateLimit(clientB, {
    ...args,
    tenantId: OTHER,
    memory: new Map(),
  });
  assert.equal(otherTenant.ok, true);
  const otherUserId = '66666666-6666-4666-8666-666666666666';
  clientB.state.authUid = otherUserId;
  const otherUser = await consumeDurableRateLimit(clientB, {
    ...args,
    userId: otherUserId,
    memory: new Map(),
  });
  assert.equal(otherUser.ok, true);
  clientB.state.authUid = USER;
  const otherAction = await consumeDurableRateLimit(clientB, {
    ...args,
    action: 'domain_check',
    limit: RATE_LIMITS.domain_check.limit,
    windowMs: RATE_LIMITS.domain_check.windowMs,
    memory: new Map(),
  });
  assert.equal(otherAction.ok, true);

  const queries = [];
  const spy = memoryClient({ rateLimitStore: createRateLimitStore() });
  const orig = spy.query;
  spy.query = async (sql, params) => {
    queries.push(params);
    return orig(sql, params);
  };
  await consumeDurableRateLimit(spy, { ...args, memory: new Map() });
  assert.equal(queries[0].length, 5);
  assert.equal(queries[0][3], RATE_LIMITS.domain_start.limit);
  assert.equal(queries[0][4], 900);
  assert.equal(queries[0].some((value) => typeof value === 'string' && /\d{4}-\d{2}-\d{2}T/.test(value)), false);
});

test('restricted checksops role can execute the consume function; other roles cannot', async () => {
  resetDomainRateLimits();
  const allowed = await consumeDurableRateLimit(memoryClient({ dbRole: 'checksops' }), {
    tenantId: TENANT,
    userId: USER,
    action: 'domain_start',
    limit: 5,
    windowMs: 15 * 60 * 1000,
    memory: new Map(),
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.source, 'database');

  const denied = await consumeDurableRateLimit(memoryClient({ dbRole: 'authenticated' }), {
    tenantId: TENANT,
    userId: USER,
    action: 'domain_start',
    limit: 5,
    windowMs: 15 * 60 * 1000,
    memory: new Map(),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'rate_limit_unavailable');
  assert.equal(denied.retryAfterSec, 60);
});

test('direct table operations remain denied to the API role', async () => {
  const client = memoryClient({ dbRole: 'checksops' });
  await assert.rejects(
    () => client.query('SELECT * FROM public.tenant_email_action_rate_limits'),
    (error) => error.code === '42501',
  );
  await assert.rejects(
    () => client.query(
      'INSERT INTO public.tenant_email_action_rate_limits (tenant_id, user_id, action, window_started_at, request_count) VALUES ($1,$2,$3,now(),1)',
      [TENANT, USER, 'domain_start'],
    ),
    (error) => error.code === '42501',
  );
  await assert.rejects(
    () => client.query('UPDATE public.tenant_email_action_rate_limits SET request_count = 0'),
    (error) => error.code === '42501',
  );
  await assert.rejects(
    () => client.query('DELETE FROM public.tenant_email_action_rate_limits'),
    (error) => error.code === '42501',
  );
  const viaFunction = await consumeDurableRateLimit(client, {
    tenantId: TENANT,
    userId: USER,
    action: 'domain_check',
    limit: 20,
    windowMs: 15 * 60 * 1000,
    memory: new Map(),
  });
  assert.equal(viaFunction.ok, true);
});

test('another user cannot consume a rate-limit counter for someone else', async () => {
  resetDomainRateLimits();
  const store = createRateLimitStore();
  const victim = memoryClient({ rateLimitStore: store, authUid: USER });
  const attackerId = '66666666-6666-4666-8666-666666666666';
  const attacker = memoryClient({ rateLimitStore: store, authUid: attackerId });
  const consumed = await consumeDurableRateLimit(victim, {
    tenantId: TENANT,
    userId: USER,
    action: 'domain_start',
    limit: 5,
    windowMs: 15 * 60 * 1000,
    memory: new Map(),
  });
  assert.equal(consumed.ok, true);
  assert.equal(store.rows.get(`${TENANT}:${USER}:domain_start`).request_count, 1);

  await assert.rejects(
    () => attacker.query(CONSUME_RATE_LIMIT_SQL, [TENANT, USER, 'domain_start', 5, 900]),
    (error) => error.code === '42501' && /rate_limit_caller_mismatch/.test(error.message),
  );
  const spoofed = await consumeDurableRateLimit(attacker, {
    tenantId: TENANT,
    userId: USER,
    action: 'domain_start',
    limit: 5,
    windowMs: 15 * 60 * 1000,
    memory: new Map(),
  });
  assert.equal(spoofed.ok, false);
  assert.equal(spoofed.error, 'rate_limit_unavailable');
  assert.equal(store.rows.get(`${TENANT}:${USER}:domain_start`).request_count, 1);
});

test('invalid actions, limits, and windows are rejected', async () => {
  const client = memoryClient();
  await assert.rejects(
    () => client.query(CONSUME_RATE_LIMIT_SQL, [TENANT, USER, 'domain_explode', 5, 900]),
    (error) => error.code === '22023' && /invalid_rate_limit_action/.test(error.message),
  );
  await assert.rejects(
    () => client.query(CONSUME_RATE_LIMIT_SQL, [TENANT, USER, 'domain_start', 0, 900]),
    (error) => error.code === '22023' && /invalid_rate_limit_bound/.test(error.message),
  );
  await assert.rejects(
    () => client.query(CONSUME_RATE_LIMIT_SQL, [TENANT, USER, 'domain_start', 1001, 900]),
    (error) => error.code === '22023' && /invalid_rate_limit_bound/.test(error.message),
  );
  await assert.rejects(
    () => client.query(CONSUME_RATE_LIMIT_SQL, [TENANT, USER, 'domain_start', 5, 0]),
    (error) => error.code === '22023' && /invalid_rate_limit_window/.test(error.message),
  );
  await assert.rejects(
    () => client.query(CONSUME_RATE_LIMIT_SQL, [TENANT, USER, 'domain_start', 5, 86401]),
    (error) => error.code === '22023' && /invalid_rate_limit_window/.test(error.message),
  );
  const closed = await consumeDurableRateLimit(client, {
    tenantId: TENANT,
    userId: USER,
    action: 'not_an_action',
    limit: 5,
    windowMs: 15 * 60 * 1000,
    memory: new Map(),
  });
  assert.equal(closed.ok, false);
  assert.equal(closed.error, 'rate_limit_unavailable');
});

test('retry_after_seconds is computed from PostgreSQL timestamps only', async () => {
  resetDomainRateLimits();
  const store = createRateLimitStore(1_700_000_000_000);
  const client = memoryClient({ rateLimitStore: store });
  const args = {
    tenantId: TENANT,
    userId: USER,
    action: 'domain_start',
    limit: 1,
    windowMs: 900_000,
    memory: new Map(),
  };
  const first = await consumeDurableRateLimit(client, args);
  assert.equal(first.ok, true);
  const denied = await consumeDurableRateLimit(client, { ...args, memory: new Map() });
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterSec, 900);
  assert.equal(denied.source, 'database');
  store.dbNowMs += 100_000;
  const later = await consumeDurableRateLimit(client, { ...args, memory: new Map() });
  assert.equal(later.ok, false);
  assert.equal(later.retryAfterSec, 800);
  assert.doesNotMatch(CONSUME_RATE_LIMIT_SQL, /Date\.now/);
  const consumeSrc = fs.readFileSync(
    path.join(ROOT, 'aws/functions/api/tenant-email-domain.mjs'),
    'utf8',
  );
  const consumeFn = consumeSrc.slice(consumeSrc.indexOf('export const consumeDurableRateLimit'));
  assert.doesNotMatch(consumeFn, /window_started_at|server_now/);
  assert.doesNotMatch(
    consumeFn,
    /retry_after_seconds[\s\S]{0,120}Date\.now\(\)|Date\.now\(\)[\s\S]{0,120}retry_after_seconds/,
  );
});

test('missing consume function fails closed', async () => {
  resetDomainRateLimits();
  const client = memoryClient({ missingRateLimitFunction: true });
  const limited = await consumeDurableRateLimit(client, {
    tenantId: TENANT,
    userId: USER,
    action: 'domain_start',
    limit: 5,
    windowMs: 15 * 60 * 1000,
    memory: new Map(),
  });
  assert.equal(limited.ok, false);
  assert.equal(limited.error, 'rate_limit_unavailable');
  assert.equal(limited.retryAfterSec, 60);

  const started = await withTx(client, () => runStartDomainVerification({
    client,
    mapping,
    body: { tenantId: TENANT, domain: DOMAIN },
    spoof,
    sesv2: mockSes(),
  }));
  assert.equal(started.statusCode, 503);
  assert.equal(started.error, 'rate_limit_unavailable');
  assert.equal(client.state.settings.get(TENANT), undefined);
});

test('consume function return row omits tenant and user identifiers', async () => {
  const client = memoryClient();
  const result = await client.query(CONSUME_RATE_LIMIT_SQL, [TENANT, USER, 'domain_save', 20, 900]);
  assert.deepEqual(Object.keys(result.rows[0]).sort(), ['allowed', 'count', 'retry_after_seconds']);
  assert.equal(result.rows[0].allowed, true);
  assert.equal(result.rows[0].count, 1);
  assert.equal(result.rows[0].retry_after_seconds, 0);
});

test('concurrent requests cannot exceed the configured rate limit', async () => {
  resetDomainRateLimits();
  const store = createRateLimitStore();
  const client = memoryClient({ rateLimitStore: store });
  const results = await Promise.all(Array.from({ length: 12 }, () => consumeDurableRateLimit(client, {
    tenantId: TENANT,
    userId: USER,
    action: 'domain_start',
    limit: 5,
    windowMs: 15 * 60 * 1000,
    memory: new Map(),
  })));
  assert.equal(results.filter((row) => row.ok).length, 5);
  assert.equal(results.filter((row) => !row.ok).length, 7);
  assert.ok(results.filter((row) => !row.ok).every((row) => row.retryAfterSec >= 1));
});

test('duplicate-domain migration preflight stops safely without PII or rewrites', () => {
  const rows = [
    { sending_domain: 'Notify.Acme.test', tenant_name: 'Acme Corp', email: 'owner@acme.test' },
    { sending_domain: 'notify.acme.test', tenant_name: 'Other LLC', email: 'other@evil.test' },
    { sending_domain: 'mail.unique.test', tenant_name: 'Solo' },
  ];
  const dupes = duplicateSendingDomainCounts(rows);
  assert.deepEqual(dupes, [{ domain: 'notify.acme.test', count: 2 }]);
  assert.throws(
    () => assertSendingDomainUniquenessPreflight(rows),
    (error) => {
      assert.equal(error.code, 'duplicate_sending_domain');
      assert.match(error.message, /notify\.acme\.test \(2\)/);
      assert.doesNotMatch(error.message, /Acme Corp|Other LLC|owner@|evil\.test|Solo/);
      return true;
    },
  );
  assert.equal(assertSendingDomainUniquenessPreflight([{ sending_domain: 'mail.unique.test' }]).ok, true);
  const sql = fs.readFileSync(
    path.join(ROOT, 'aws/migrations/proposed/NOT_APPLIED_20260910_tenant_email_ses_domain.sql'),
    'utf8',
  );
  assert.match(sql, /Do not delete, merge,\n-- or rewrite rows|Does not delete, merge,\n-- or rewrite rows/i);
  assert.doesNotMatch(sql, /DELETE FROM public\.tenant_email_settings/);
  assert.doesNotMatch(sql, /UPDATE public\.tenant_email_settings[\s\S]{0,80}sending_domain/);
});

test('mutating operations roll back when audit insertion fails', async () => {
  resetDomainRateLimits();
  const client = memoryClient({ failAudit: true });
  client.state.settings.set(TENANT, {
    tenant_id: TENANT,
    sending_domain: DOMAIN,
    domain_status: 'verified',
    sending_mode: 'custom',
    custom_sending_enabled: true,
    from_address: `noreply@${DOMAIN}`,
  });
  const disabled = await withTx(client, () => runDisableCustomSending({
    client, mapping, body: { tenantId: TENANT }, spoof,
  }));
  assert.equal(disabled.statusCode, 503);
  assert.equal(disabled.error, 'audit_unavailable');
  assert.equal(client.state.settings.get(TENANT).domain_status, 'verified');
  assert.equal(client.state.settings.get(TENANT).sending_mode, 'custom');
  assert.equal(client.state.audits.length, 0);

  const startClient = memoryClient({ failAudit: true });
  const started = await withTx(startClient, () => runStartDomainVerification({
    client: startClient,
    mapping,
    body: { tenantId: TENANT, domain: DOMAIN },
    spoof,
    sesv2: mockSes(),
  }));
  assert.equal(started.statusCode, 503);
  assert.equal(started.error, 'audit_unavailable');
  assert.equal(startClient.state.settings.get(TENANT), undefined);
});

test('read-only preview and get work without an audit write', async () => {
  const client = memoryClient({ failAudit: true });
  client.state.settings.set(TENANT, {
    tenant_id: TENANT,
    sending_mode: 'custom',
    sending_domain: DOMAIN,
    from_address: `noreply@${DOMAIN}`,
    domain_status: 'pending',
    from_name: 'Freedom Adjustment',
    reply_to: 'claims@freedomadj.com',
  });
  const preview = await runPreviewEmailBranding({
    client, mapping, body: { tenantId: TENANT }, spoof,
  });
  assert.equal(preview.ok, true);
  assert.match(preview.html, /Signature request/);
  const got = await runGetEmailBranding({
    client, mapping, body: { tenantId: TENANT }, spoof,
  });
  assert.equal(got.ok, true);
  assert.equal(client.state.audits.length, 0);
});

test('audit payloads omit DKIM tokens, addresses, ARNs, and secrets', async () => {
  resetDomainRateLimits();
  const client = memoryClient();
  const started = await runStartDomainVerification({
    client,
    mapping,
    body: {
      tenantId: TENANT,
      domain: DOMAIN,
      fromName: 'Freedom Adjustment',
      replyTo: 'claims@freedomadj.com',
    },
    spoof,
    sesv2: mockSes(),
  });
  assert.equal(started.ok, true);
  assert.equal(client.state.audits.length, 1);
  const blob = JSON.stringify(client.state.audits);
  assert.doesNotMatch(blob, /tokena|tokenb|tokenc|dkim/i);
  assert.doesNotMatch(blob, /claims@freedomadj\.com|noreply@/);
  assert.doesNotMatch(blob, /arn:aws|AKIA|otp|password|account/i);
  assert.match(blob, /notify\.freedomadj\.com/);
  const sanitized = safeAuditPayload({
    sending_domain: DOMAIN,
    from_address: 'noreply@notify.freedomadj.com',
    reply_to: 'claims@freedomadj.com',
    dkim: 'tokena',
    token: 'secret-token',
    arn: 'arn:aws:ses:us-east-1:123:identity/x',
    result: 'pending',
    replaced: false,
    claim: 'CL-1',
  });
  assert.deepEqual(sanitized, { sending_domain: DOMAIN, result: 'pending', replaced: false });
});

