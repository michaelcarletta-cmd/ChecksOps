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

const memoryClient = (opts = {}) => {
  const settings = new Map(opts.settings || []);
  const audits = [];
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
    otherDomain: opts.otherDomain || null,
    settings,
    audits,
    tenant,
  };
  return {
    state,
    query: async (sql, params = []) => {
      const compact = String(sql).replace(/\s+/g, ' ');
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
        const payload = { action: params[1], record_type: params[2], record_id: params[3], new_values: params[5], metadata: params[6] };
        const blob = JSON.stringify(payload);
        if (/otp|secret|password|arn:aws|access.key/i.test(blob) && /AKIA|otp-|token=/.test(blob)) {
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
  assert.equal(sesIdentityVerified({
    VerificationStatus: 'SUCCESS',
    DkimAttributes: { Status: 'SUCCESS', SigningEnabled: true },
  }), true);
  assert.equal(fallbackFromHeader('Freedom Adjustment').includes('noreply@checksops.com'), true);
});
