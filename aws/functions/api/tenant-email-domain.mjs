/**
 * Tenant sending-domain validation and SES v2 lifecycle helpers.
 * Live SESv2 is never constructed unless AWS_TENANT_EMAIL_DOMAIN_ENABLED=true
 * and no mock adapter is injected. Tests must inject a mock.
 */
import { randomUUID } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { normalizeEmail } from './email-policy.mjs';
import {
  PLATFORM_FROM_DOMAIN,
  addressDomain,
  formatFromHeader,
  parseFromHeader,
} from './email-branding.mjs';

export const DEFAULT_FROM_LOCAL_PART = 'noreply';

export const DOMAIN_STATUS = {
  not_configured: 'not_configured',
  unverified: 'unverified',
  pending: 'pending',
  verifying: 'verifying',
  verified: 'verified',
  failed: 'failed',
  disabled: 'disabled',
};

const PUBLIC_MAILBOX_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'gmx.com',
  'gmx.net',
  'yandex.com',
  'yandex.ru',
  'mail.com',
  'zoho.com',
  'fastmail.com',
  'hey.com',
  'inbox.com',
  'mail.ru',
  'pm.me',
]);

const PROTECTED_PLATFORM_DOMAINS = new Set([
  'checksops.com',
  'www.checksops.com',
  'notify.checksops.com',
  'mail.checksops.com',
  'staging.checksops.com',
  'app.checksops.com',
  'api.checksops.com',
  'checksops.invalid',
]);

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export const tenantEmailDomainEnabled = () => (
  String(process.env.AWS_TENANT_EMAIL_DOMAIN_ENABLED || 'false').trim().toLowerCase() === 'true'
);

export const tenantSesIdentityDeleteEnabled = () => (
  String(process.env.AWS_TENANT_SES_IDENTITY_DELETE_ENABLED || 'false').trim().toLowerCase() === 'true'
);

export const tenantMailFromEnabled = () => (
  String(process.env.AWS_TENANT_MAIL_FROM_ENABLED || 'false').trim().toLowerCase() === 'true'
);

export const sesConfigurationSet = () => String(process.env.AWS_SES_CONFIGURATION_SET || '').trim() || null;

export const isProtectedPlatformDomain = (domain) => {
  const host = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  if (PROTECTED_PLATFORM_DOMAINS.has(host)) return true;
  return host === PLATFORM_FROM_DOMAIN || host.endsWith(`.${PLATFORM_FROM_DOMAIN}`)
    || host === 'checksops.invalid' || host.endsWith('.checksops.invalid');
};

export const isPublicMailboxDomain = (domain) => PUBLIC_MAILBOX_DOMAINS.has(
  String(domain || '').trim().toLowerCase(),
);

const hasControlOrCrlf = (value) => /[\u0000-\u001F\u007F]/.test(String(value || ''))
  || /%0[ad]/i.test(String(value || ''));

export const sanitizeDisplayName = (value, fallback = 'ChecksOps') => {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\r\n<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
};

export const displayNameIsUnsafe = (value) => {
  const raw = String(value || '');
  if (!raw) return false;
  return hasControlOrCrlf(raw) || /[\r\n<>]/.test(raw);
};

export const normalizeSendingDomain = (value) => {
  let raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return { ok: false, error: 'missing_domain' };
  }
  if (hasControlOrCrlf(raw)) {
    return { ok: false, error: 'invalid_domain', reason: 'crlf' };
  }
  if (/\s/.test(raw)) {
    return { ok: false, error: 'invalid_domain', reason: 'whitespace' };
  }
  if (raw.includes('@')) {
    return { ok: false, error: 'invalid_domain', reason: 'email_address' };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('//')) {
    return { ok: false, error: 'invalid_domain', reason: 'url' };
  }
  if (/[/?#\\]/.test(raw)) {
    return { ok: false, error: 'invalid_domain', reason: 'path' };
  }
  if (raw.includes('*')) {
    return { ok: false, error: 'invalid_domain', reason: 'wildcard' };
  }
  raw = raw.replace(/\.$/, '');
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return { ok: false, error: 'invalid_domain', reason: 'ip' };
  }
  const hostname = raw.split(':')[0];
  if (isIPv4(hostname) || isIPv6(hostname)) {
    return { ok: false, error: 'invalid_domain', reason: 'ip' };
  }
  const labels = hostname.split('.');
  if (labels.length < 3) {
    return { ok: false, error: 'invalid_domain', reason: 'subdomain_required' };
  }
  if (labels.some((label) => !HOST_LABEL.test(label))) {
    return { ok: false, error: 'invalid_domain', reason: 'malformed' };
  }
  if (hostname.length > 253) {
    return { ok: false, error: 'invalid_domain', reason: 'malformed' };
  }
  if (isProtectedPlatformDomain(hostname)) {
    return { ok: false, error: 'protected_platform_domain' };
  }
  if (isPublicMailboxDomain(hostname) || labels.slice(-2).join('.') && isPublicMailboxDomain(labels.slice(-2).join('.'))) {
    return { ok: false, error: 'public_mailbox_domain' };
  }
  // Also reject notify.gmail.com style hosts under a public mailbox registrable domain.
  for (let i = 1; i < labels.length - 1; i += 1) {
    const parent = labels.slice(i).join('.');
    if (isPublicMailboxDomain(parent)) {
      return { ok: false, error: 'public_mailbox_domain' };
    }
  }
  return { ok: true, domain: hostname };
};

export const normalizeFromLocalPart = (value) => {
  const raw = String(value || DEFAULT_FROM_LOCAL_PART).trim().toLowerCase();
  if (hasControlOrCrlf(raw) || raw.includes('@')) {
    return { ok: false, error: 'invalid_from_local_part' };
  }
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(raw) || raw.includes('..')) {
    return { ok: false, error: 'invalid_from_local_part' };
  }
  return { ok: true, localPart: raw || DEFAULT_FROM_LOCAL_PART };
};

export const fromAddressOnVerifiedDomain = (fromAddress, sendingDomain) => {
  const fromDomain = addressDomain(fromAddress);
  const domain = String(sendingDomain || '').trim().toLowerCase();
  if (!fromDomain || !domain) return false;
  return fromDomain === domain || fromDomain.endsWith(`.${domain}`);
};

export const normalizeReplyTo = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return { ok: true, replyTo: null };
  if (hasControlOrCrlf(raw) || displayNameIsUnsafe(raw)) {
    return { ok: false, error: 'invalid_reply_to', reason: 'crlf' };
  }
  const addr = normalizeEmail(raw);
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(addr)) {
    return { ok: false, error: 'invalid_reply_to' };
  }
  const domain = addressDomain(addr);
  if (isPublicMailboxDomain(domain)) {
    return { ok: false, error: 'public_mailbox_domain' };
  }
  if (isProtectedPlatformDomain(domain) && addr !== 'support@checksops.com') {
    return { ok: false, error: 'protected_platform_domain' };
  }
  return { ok: true, replyTo: addr };
};

export const mailFromRecordsFor = (mailFromDomain, region = process.env.AWS_REGION || 'us-east-1') => {
  const host = String(mailFromDomain || '').trim().toLowerCase().replace(/\.$/, '');
  const sesRegion = String(region || 'us-east-1').trim() || 'us-east-1';
  if (!host) return [];
  return [
    {
      type: 'MX',
      name: host,
      value: `feedback-smtp.${sesRegion}.amazonses.com`,
      ttl: '600',
      purpose: 'mail_from',
    },
    {
      type: 'TXT',
      name: host,
      value: 'v=spf1 include:amazonses.com ~all',
      ttl: '600',
      purpose: 'mail_from',
    },
  ];
};

export const dkimRecordsFromTokens = (domain, tokens = []) => (
  (Array.isArray(tokens) ? tokens : [])
    .map((token) => String(token || '').trim())
    .filter(Boolean)
    .map((token) => ({
      type: 'CNAME',
      name: `${token}._domainkey.${domain}`,
      value: `${token}.dkim.amazonses.com`,
      ttl: '600',
      purpose: 'dkim',
    }))
);

export const publicStatusLabel = (status) => {
  switch (String(status || '').toLowerCase()) {
    case 'pending':
      return 'Pending DNS';
    case 'verifying':
      return 'Verifying';
    case 'verified':
      return 'Verified';
    case 'failed':
      return 'Failed';
    case 'disabled':
      return 'Disabled';
    case 'unverified':
    case 'not_configured':
    case '':
    case 'unset':
      return 'Not configured';
    default:
      return 'Not configured';
  }
};

export const uiDomainStatus = (row = {}) => {
  const domain = String(row.sending_domain || '').trim();
  const status = String(row.domain_status || '').trim().toLowerCase();
  if (!domain || !status || status === 'unverified') return DOMAIN_STATUS.not_configured;
  if (status === 'pending' && row.last_checked_at) return DOMAIN_STATUS.verifying;
  if ([
    DOMAIN_STATUS.pending,
    DOMAIN_STATUS.verifying,
    DOMAIN_STATUS.verified,
    DOMAIN_STATUS.failed,
    DOMAIN_STATUS.disabled,
  ].includes(status)) return status;
  return DOMAIN_STATUS.not_configured;
};

const SETTINGS_COLUMNS = new Set([
  'from_name',
  'reply_to',
  'sending_mode',
  'provider',
  'sending_domain',
  'from_address',
  'domain_status',
  'dns_records',
  'verified_at',
  'last_verification_error',
  'last_checked_at',
  'ses_identity_name',
  'custom_sending_enabled',
  'mail_from_domain',
  'mail_from_records',
]);

const undefinedColumn = (error) => (
  error?.code === '42703' || /column .* does not exist/i.test(String(error?.message || ''))
);

const checkViolation = (error) => (
  error?.code === '23514' || /check constraint/i.test(String(error?.message || ''))
);

const uniqueViolation = (error) => (
  error?.code === '23505' || /unique|duplicate key/i.test(String(error?.message || ''))
);

const compatibleStatus = (status) => {
  if (status === DOMAIN_STATUS.verifying) return DOMAIN_STATUS.pending;
  if (status === DOMAIN_STATUS.disabled) return DOMAIN_STATUS.unverified;
  return status;
};

const dropUnknownKeys = (patch, message) => {
  const next = { ...patch };
  const match = String(message || '').match(/column "([^"]+)"/i);
  if (match?.[1] && match[1] in next) {
    delete next[match[1]];
    return next;
  }
  for (const extra of [
    'last_checked_at',
    'ses_identity_name',
    'custom_sending_enabled',
    'mail_from_domain',
    'mail_from_records',
  ]) {
    delete next[extra];
  }
  return next;
};

export const upsertTenantEmailSettings = async (client, tenantId, patch, attempt = 0) => {
  const body = { ...patch };
  if (attempt > 6) throw new Error('tenant_email_settings_update_exhausted');
  const keys = Object.keys(body).filter((key) => SETTINGS_COLUMNS.has(key) && body[key] !== undefined);
  if (!keys.length) return { rowCount: 0 };
  const cols = ['tenant_id', ...keys];
  const values = [tenantId, ...keys.map((key) => (
    key === 'dns_records' || key === 'mail_from_records'
      ? JSON.stringify(body[key] ?? [])
      : body[key]
  ))];
  const placeholders = cols.map((col, i) => {
    if (col === 'dns_records' || col === 'mail_from_records') return `$${i + 1}::jsonb`;
    if (col === 'verified_at' || col === 'last_checked_at') return `$${i + 1}::timestamptz`;
    if (col === 'custom_sending_enabled') return `$${i + 1}::boolean`;
    return `$${i + 1}`;
  });
  const updates = keys.map((key) => `${key} = EXCLUDED.${key}`).join(', ');
  try {
    return await client.query(
      `INSERT INTO public.tenant_email_settings (${cols.join(', ')}, updated_at)
       VALUES (${placeholders.join(', ')}, now())
       ON CONFLICT (tenant_id) DO UPDATE
         SET ${updates}, updated_at = now()`,
      values,
    );
  } catch (error) {
    if (undefinedColumn(error)) {
      return upsertTenantEmailSettings(client, tenantId, dropUnknownKeys(body, error.message), attempt + 1);
    }
    if (checkViolation(error) && body.domain_status) {
      const fallback = compatibleStatus(body.domain_status);
      if (fallback !== body.domain_status) {
        return upsertTenantEmailSettings(client, tenantId, { ...body, domain_status: fallback }, attempt + 1);
      }
    }
    if (uniqueViolation(error)) {
      const err = new Error('domain_already_assigned');
      err.code = 'domain_already_assigned';
      throw err;
    }
    throw error;
  }
};

export const loadTenantEmailSettings = async (client, tenantId) => {
  try {
    return (await client.query(
      `SELECT * FROM public.tenant_email_settings WHERE tenant_id = $1::uuid LIMIT 1`,
      [tenantId],
    )).rows[0] || null;
  } catch {
    return (await client.query(
      `SELECT from_name, reply_to, sending_mode, provider, sending_domain, from_address,
              domain_status, dns_records, verified_at, last_verification_error, tenant_id
       FROM public.tenant_email_settings WHERE tenant_id = $1::uuid LIMIT 1`,
      [tenantId],
    )).rows[0] || null;
  }
};

export const findDomainOwner = async (client, domain, exceptTenantId = null) => {
  const host = String(domain || '').trim().toLowerCase();
  if (!host) return null;
  const { rows } = await client.query(
    `SELECT tenant_id::text AS tenant_id, domain_status, sending_domain
     FROM public.tenant_email_settings
     WHERE lower(sending_domain) = $1
       AND sending_domain IS NOT NULL
       AND ($2::uuid IS NULL OR tenant_id <> $2::uuid)
     LIMIT 1`,
    [host, exceptTenantId],
  );
  return rows[0] || null;
};

const buckets = new Map();

export const resetDomainRateLimits = () => buckets.clear();

export const consumeRateLimit = (key, limit, windowMs) => {
  const now = Date.now();
  const bucket = buckets.get(key) || [];
  const fresh = bucket.filter((ts) => now - ts < windowMs);
  if (fresh.length >= limit) {
    buckets.set(key, fresh);
    return { ok: false, retryAfterSec: Math.ceil((windowMs - (now - fresh[0])) / 1000) };
  }
  fresh.push(now);
  buckets.set(key, fresh);
  return { ok: true };
};

const AUDIT_REDACT = /otp|token|secret|password|authorization|credential|arn:aws|account[_-]?id|access[_-]?key/i;

export const safeAuditPayload = (payload = {}) => {
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (AUDIT_REDACT.test(key)) continue;
    if (typeof value === 'string' && AUDIT_REDACT.test(value)) continue;
    if (typeof value === 'string' && value.includes('@') && key.toLowerCase().includes('email')) continue;
    if (typeof value === 'string' && /arn:aws|[A-Z0-9]{16,}/.test(value) && /secret|arn|key/i.test(key)) continue;
    out[key] = value;
  }
  return out;
};

export const writeDomainAudit = async (client, mapping, {
  action,
  tenantId,
  payload = {},
}) => {
  try {
    await client.query(
      `INSERT INTO public.audit_logs (
         user_id, action, record_type, record_id, old_values, new_values, metadata
       ) VALUES (
         $1::uuid, $2::text, $3::text, $4::text, $5::jsonb, $6::jsonb, $7::jsonb
       )`,
      [
        mapping?.application_user_id || null,
        String(action || '').slice(0, 120),
        'tenant_email_domain',
        String(tenantId || '').slice(0, 200),
        null,
        JSON.stringify(safeAuditPayload(payload)),
        JSON.stringify(safeAuditPayload({
          tenant_id: tenantId,
          actor_user_id: mapping?.application_user_id || null,
        })),
      ],
    );
  } catch {
    // Audit must not break the domain workflow.
  }
};

export const resolveTenantAccess = async (client, mapping, tenantId) => {
  const userId = mapping.application_user_id;
  const membership = (await client.query(
    `SELECT role FROM public.tenant_users
     WHERE tenant_id = $1::uuid AND user_id = $2::uuid LIMIT 1`,
    [tenantId, userId],
  )).rows[0];
  const system = (await client.query(
    `SELECT role FROM public.user_roles WHERE user_id = $1::uuid LIMIT 1`,
    [userId],
  )).rows[0];
  let master = false;
  try {
    master = (await client.query(`SELECT public.is_master_owner() AS is_master`)).rows[0]?.is_master === true;
  } catch {
    master = false;
  }
  const platformAdmin = system?.role === 'admin' || master === true;
  const tenantAdmin = membership?.role === 'admin';
  const member = Boolean(membership);
  return {
    platformAdmin,
    tenantAdmin,
    member,
    canView: platformAdmin || member,
    canConfigure: platformAdmin || tenantAdmin,
    canDeleteIdentity: platformAdmin && master === true,
    role: tenantAdmin ? 'admin' : (membership?.role || (platformAdmin ? 'platform_admin' : null)),
  };
};

let liveSesV2Promise = null;

export const createLiveSesV2Adapter = async () => {
  if (!tenantEmailDomainEnabled()) return null;
  if (liveSesV2Promise) return liveSesV2Promise;
  liveSesV2Promise = import('@aws-sdk/client-sesv2').then((mod) => {
    const client = new mod.SESv2Client({ region: process.env.AWS_REGION || 'us-east-1' });
    return {
      createEmailIdentity: (input) => client.send(new mod.CreateEmailIdentityCommand(input)),
      getEmailIdentity: (input) => client.send(new mod.GetEmailIdentityCommand(input)),
      deleteEmailIdentity: (input) => client.send(new mod.DeleteEmailIdentityCommand(input)),
      putMailFrom: (input) => client.send(new mod.PutEmailIdentityMailFromAttributesCommand(input)),
    };
  }).catch((error) => {
    liveSesV2Promise = null;
    const err = new Error('sesv2_unavailable');
    err.cause = error;
    throw err;
  });
  return liveSesV2Promise;
};

export const resolveSesV2 = async (injected) => {
  if (injected) return injected;
  if (!tenantEmailDomainEnabled()) return null;
  return createLiveSesV2Adapter();
};

export const sesIdentityVerified = (identity = {}) => {
  const verification = String(
    identity.VerificationStatus || identity.verificationStatus || '',
  ).toUpperCase();
  const dkim = String(
    identity.DkimAttributes?.Status
    || identity.DkimAttributes?.status
    || identity.dkimStatus
    || '',
  ).toUpperCase();
  const signingEnabled = identity.DkimAttributes?.SigningEnabled
    ?? identity.DkimAttributes?.signingEnabled
    ?? true;
  return verification === 'SUCCESS' && dkim === 'SUCCESS' && signingEnabled !== false;
};

export const fallbackFromHeader = (tenantName) => {
  const name = sanitizeDisplayName(tenantName, 'ChecksOps');
  const display = name.toLowerCase().includes('checksops') ? name : `${name} via ChecksOps`;
  return formatFromHeader(display, `${DEFAULT_FROM_LOCAL_PART}@${PLATFORM_FROM_DOMAIN}`);
};

export { parseFromHeader, formatFromHeader, randomUUID };
