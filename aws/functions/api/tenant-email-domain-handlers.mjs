/**
 * Tenant email HTTP actions (Class A).
 * Sending-domain / SES identity APIs are retired (410).
 * Branding get/save/preview remain: display name, Reply-To, logo/color.
 */
import { withIdentity } from './data.mjs';
import { defaultFromAddress } from './email-policy.mjs';
import {
  resolveEmailBranding,
  brandingForTemplate,
} from './email-branding.mjs';
import { renderChecksOpsEmail } from './email-layout.mjs';
import {
  DOMAIN_STATUS,
  RATE_LIMITS,
  consumeDurableRateLimit,
  displayNameIsUnsafe,
  fallbackFromHeader,
  loadTenantEmailSettings,
  normalizeReplyTo,
  publicStatusLabel,
  resolveTenantAccess,
  sanitizeDisplayName,
  tenantEmailDomainEnabled,
  uiDomainStatus,
  upsertTenantEmailSettings,
  writeDomainAudit,
} from './tenant-email-domain.mjs';

const missingTenant = (spoof) => ({
  ok: false,
  statusCode: 400,
  error: 'missing_tenant',
  spoofFieldsIgnored: spoof,
});

const denied = (spoof, error = 'not_authorized') => ({
  ok: false,
  statusCode: 403,
  error,
  spoofFieldsIgnored: spoof,
});

const rateLimited = (spoof, retryAfterSec, error = 'rate_limited') => ({
  ok: false,
  statusCode: error === 'rate_limit_unavailable' ? 503 : 429,
  error,
  retryAfterSec,
  spoofFieldsIgnored: spoof,
});

const auditUnavailable = (spoof) => ({
  ok: false,
  statusCode: 503,
  error: 'audit_unavailable',
  spoofFieldsIgnored: spoof,
});

const requireActionRateLimit = async (client, mapping, tenantId, action, spoof) => {
  const cfg = RATE_LIMITS[action];
  if (!cfg) return null;
  const rate = await consumeDurableRateLimit(client, {
    tenantId,
    userId: mapping.application_user_id,
    action,
    limit: cfg.limit,
    windowMs: cfg.windowMs,
  });
  if (rate.ok) return null;
  return rateLimited(spoof, rate.retryAfterSec, rate.error || 'rate_limited');
};

const commitDomainAudit = async (client, mapping, args, spoof) => {
  try {
    await writeDomainAudit(client, mapping, args);
    return null;
  } catch {
    return auditUnavailable(spoof);
  }
};

const sendingDomainRetired = (spoof) => ({
  ok: false,
  statusCode: 410,
  error: 'tenant_sending_domain_retired',
  message: 'Tenant sending domains are retired. ChecksOps SES is the sending identity. Configure display name and Reply-To only.',
  spoofFieldsIgnored: spoof,
});

const publicDns = (records) => (Array.isArray(records) ? records : [])
  .filter((row) => row && row.type && row.name && row.value)
  .map((row) => ({
    type: String(row.type),
    name: String(row.name),
    value: String(row.value),
    ttl: row.ttl || '600',
    purpose: row.purpose || 'dkim',
  }));

const publicSettings = (row, tenant = {}, access = {}) => {
  const status = uiDomainStatus(row || {});
  const domain = row?.sending_domain || null;
  const fromAddress = row?.from_address || null;
  return {
    tenantId: row?.tenant_id || tenant.id || null,
    tenantName: tenant.name || null,
    logoUrl: tenant.logo_url || null,
    primaryColor: tenant.primary_color || null,
    fromName: row?.from_name || tenant.name || null,
    replyTo: row?.reply_to || tenant.email_reply_to || null,
    sendingDomain: domain,
    fromAddress,
    fromLocalPart: fromAddress ? String(fromAddress).split('@')[0] : 'noreply',
    sendingMode: row?.sending_mode || 'platform',
    domainStatus: status,
    domainStatusLabel: publicStatusLabel(status),
    verified: status === DOMAIN_STATUS.verified,
    customSendingEnabled: row?.custom_sending_enabled === true
      || (row?.sending_mode === 'custom' && status === DOMAIN_STATUS.verified),
    dnsRecords: publicDns(row?.dns_records),
    mailFromDomain: row?.mail_from_domain || null,
    mailFromRecords: publicDns(row?.mail_from_records),
    lastVerificationError: row?.last_verification_error || null,
    verifiedAt: row?.verified_at || null,
    lastCheckedAt: row?.last_checked_at || null,
    canConfigure: Boolean(access.canConfigure),
    canView: Boolean(access.canView),
    domainFeatureEnabled: tenantEmailDomainEnabled(),
  };
};

const loadTenant = async (client, tenantId) => (
  (await client.query(
    `SELECT id::text AS id, name, logo_url, primary_color, email_from_name,
            email_from_address, email_reply_to, is_system_tenant
     FROM public.tenants WHERE id = $1::uuid LIMIT 1`,
    [tenantId],
  )).rows[0] || null
);

const requireTenant = async (client, mapping, body, spoof, { configure = false } = {}) => {
  const tenantId = body.tenantId || body.tenant_id;
  if (!tenantId) return { error: missingTenant(spoof) };
  const tenant = await loadTenant(client, tenantId);
  if (!tenant) {
    return { error: { ok: false, statusCode: 404, error: 'tenant_not_found', spoofFieldsIgnored: spoof } };
  }
  const access = await resolveTenantAccess(client, mapping, tenantId);
  if (configure && !access.canConfigure) return { error: denied(spoof) };
  if (!configure && !access.canView) return { error: denied(spoof, 'cross_tenant_denied') };
  return { tenantId, tenant, access };
};

export const runGetEmailBranding = async ({ client, mapping, body, spoof }) => {
  const resolved = await requireTenant(client, mapping, body, spoof, { configure: false });
  if (resolved.error) return resolved.error;
  const row = await loadTenantEmailSettings(client, resolved.tenantId);
  const branding = await resolveEmailBranding(client, { tenantId: resolved.tenantId });
  return {
    ok: true,
    statusCode: 200,
    settings: publicSettings(row, resolved.tenant, resolved.access),
    branding: {
      from: branding.from,
      replyTo: branding.replyTo,
      usingCustomFrom: branding.usingCustomFrom,
      customFromBlocked: branding.customFromBlocked,
      fallbackFrom: fallbackFromHeader(resolved.tenant.name),
      customFromReason: branding.customFromReason || null,
      logoUrl: branding.logoUrl,
      primaryColor: branding.primaryColor,
    },
    platformFrom: defaultFromAddress(),
    spoofFieldsIgnored: spoof,
  };
};

export const runSaveEmailBranding = async ({ client, mapping, body, spoof }) => {
  const resolved = await requireTenant(client, mapping, body, spoof, { configure: true });
  if (resolved.error) return resolved.error;
  if (displayNameIsUnsafe(body.fromName || body.from_name)) {
    return { ok: false, statusCode: 400, error: 'unsafe_from_name', spoofFieldsIgnored: spoof };
  }
  const fromName = sanitizeDisplayName(
    body.fromName || body.from_name,
    resolved.tenant.name || 'ChecksOps',
  );
  const reply = normalizeReplyTo(body.replyTo || body.reply_to);
  if (!reply.ok) {
    return { ok: false, statusCode: 400, error: reply.error, reason: reply.reason || null, spoofFieldsIgnored: spoof };
  }
  const limited = await requireActionRateLimit(client, mapping, resolved.tenantId, 'domain_save', spoof);
  if (limited) return limited;
  await upsertTenantEmailSettings(client, resolved.tenantId, {
    from_name: fromName,
    reply_to: reply.replyTo,
  });
  const auditError = await commitDomainAudit(client, mapping, {
    action: 'tenant_email_branding_save',
    tenantId: resolved.tenantId,
    payload: { result: 'saved' },
  }, spoof);
  if (auditError) return auditError;
  const row = await loadTenantEmailSettings(client, resolved.tenantId);
  return {
    ok: true,
    statusCode: 200,
    saved: true,
    settings: publicSettings(row, resolved.tenant, resolved.access),
    ignoredClientFields: [
      'domain_status',
      'sending_mode',
      'verified',
      'ses_identity_name',
      'domain',
      'sending_domain',
      'fromLocalPart',
      'from_local_part',
    ].filter((k) => k in body),
    spoofFieldsIgnored: spoof,
  };
};

export const runStartDomainVerification = async ({
  client, mapping, body, spoof,
}) => {
  const resolved = await requireTenant(client, mapping, body, spoof, { configure: true });
  if (resolved.error) return resolved.error;
  return sendingDomainRetired(spoof);
};

export const runCheckDomainVerification = async ({
  client, mapping, body, spoof,
}) => {
  const resolved = await requireTenant(client, mapping, body, spoof, { configure: true });
  if (resolved.error) return resolved.error;
  return sendingDomainRetired(spoof);
};

export const runDisableCustomSending = async ({ client, mapping, body, spoof }) => {
  const resolved = await requireTenant(client, mapping, body, spoof, { configure: true });
  if (resolved.error) return resolved.error;
  return sendingDomainRetired(spoof);
};

export const runDeleteSesIdentity = async ({
  client, mapping, body, spoof,
}) => {
  const resolved = await requireTenant(client, mapping, body, spoof, { configure: true });
  if (resolved.error) return resolved.error;
  return sendingDomainRetired(spoof);
};

export const runPreviewEmailBranding = async ({ client, mapping, body, spoof }) => {
  const resolved = await requireTenant(client, mapping, body, spoof, { configure: false });
  if (resolved.error) return resolved.error;
  const branding = await resolveEmailBranding(client, { tenantId: resolved.tenantId });
  const rendered = renderChecksOpsEmail({
    title: 'Signature request',
    greeting: 'Hello,',
    paragraphs: [
      'This is a preview of application email your contacts will receive.',
      'ChecksOps remains the underlying delivery platform.',
    ],
    ctaLabel: 'Open secure link',
    ctaUrl: 'https://staging.checksops.com/h/preview',
    fallbackUrl: 'https://staging.checksops.com/h/preview',
    expiresText: 'This preview does not send mail.',
    ...brandingForTemplate(branding).branding,
  });
  return {
    ok: true,
    statusCode: 200,
    from: branding.from,
    replyTo: branding.replyTo,
    usingCustomFrom: branding.usingCustomFrom,
    customFromReason: branding.customFromReason || null,
    fallbackFrom: fallbackFromHeader(resolved.tenant.name),
    html: rendered.html,
    text: rendered.text,
    spoofFieldsIgnored: spoof,
  };
};

const withDomainDeps = (fn, write = true) => (event, deps = {}) => withIdentity(event, (ctx) => (
  fn({ ...ctx, sesv2: deps.sesv2 })
), { write, commit: write, ...deps });

export const handleTenantEmailBrandingGet = withDomainDeps(runGetEmailBranding, false);
export const handleTenantEmailBrandingSave = withDomainDeps(runSaveEmailBranding, true);
export const handleTenantDomainVerify = withDomainDeps(runStartDomainVerification, true);
export const handleTenantDomainCheck = withDomainDeps(runCheckDomainVerification, true);
export const handleTenantDomainDisable = withDomainDeps(runDisableCustomSending, true);
export const handleTenantSesIdentityDelete = withDomainDeps(runDeleteSesIdentity, true);
export const handleTenantEmailPreview = withDomainDeps(runPreviewEmailBranding, false);

export const handleTenantDomainRecheckCron = async (event) => {
  const spoof = { ignored: true };
  return {
    ...sendingDomainRetired(spoof),
    processed: 0,
    staging: true,
    sesCalled: false,
    path: event?.path || null,
  };
};
