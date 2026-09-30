/**
 * Tenant email-domain HTTP actions (Class A).
 * Domain verification status is written only from SES GetEmailIdentity results.
 */
import { withIdentity } from './data.mjs';
import { defaultFromAddress } from './email-policy.mjs';
import {
  resolveEmailBranding,
  brandingForTemplate,
  isSafeHexColor,
  isSafeHttpUrl,
  safeHttpUrl,
} from './email-branding.mjs';
import { renderChecksOpsEmail } from './email-layout.mjs';
import {
  DEFAULT_FROM_LOCAL_PART,
  DOMAIN_STATUS,
  RATE_LIMITS,
  consumeDurableRateLimit,
  dkimRecordsFromTokens,
  displayNameIsUnsafe,
  fallbackFromHeader,
  findDomainOwner,
  fromAddressOnVerifiedDomain,
  loadTenantEmailSettings,
  mailFromRecordsFor,
  normalizeFromLocalPart,
  normalizeReplyTo,
  normalizeSendingDomain,
  publicStatusLabel,
  resolveSesV2,
  resolveTenantAccess,
  sanitizeDisplayName,
  sesIdentityVerified,
  tenantEmailDomainEnabled,
  tenantSesIdentityDeleteEnabled,
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

const featureDisabled = (spoof) => ({
  ok: false,
  statusCode: 503,
  error: 'tenant_email_domain_disabled',
  message: 'Tenant SES domain APIs are disabled in this environment.',
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
    fromLocalPart: fromAddress ? String(fromAddress).split('@')[0] : DEFAULT_FROM_LOCAL_PART,
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

const dkimTokensFromIdentity = (identity = {}) => (
  identity.DkimAttributes?.Tokens
  || identity.DkimAttributes?.tokens
  || identity.DkimTokens
  || identity.tokens
  || []
);

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
  const local = normalizeFromLocalPart(body.fromLocalPart || body.from_local_part || DEFAULT_FROM_LOCAL_PART);
  if (!local.ok) {
    return { ok: false, statusCode: 400, error: local.error, spoofFieldsIgnored: spoof };
  }
  const existing = await loadTenantEmailSettings(client, resolved.tenantId);
  const domain = existing?.sending_domain || null;
  const fromAddress = domain ? `${local.localPart}@${domain}` : null;
  const limited = await requireActionRateLimit(client, mapping, resolved.tenantId, 'domain_save', spoof);
  if (limited) return limited;
  const tenantPatch = {};
  if ('primaryColor' in body || 'primary_color' in body) {
    const color = String(body.primaryColor || body.primary_color || '').trim();
    if (color && !isSafeHexColor(color)) {
      return { ok: false, statusCode: 400, error: 'invalid_field', field: 'primary_color', spoofFieldsIgnored: spoof };
    }
    if (color) tenantPatch.primary_color = color;
  }
  if ('logoUrl' in body || 'logo_url' in body) {
    const raw = body.logoUrl ?? body.logo_url;
    if (raw !== null && raw !== '') {
      const text = String(raw).trim();
      if (text) {
        const ok = text.startsWith('/') || !text.includes('://') || isSafeHttpUrl(text);
        if (!ok) {
          return { ok: false, statusCode: 400, error: 'invalid_field', field: 'logo_url', spoofFieldsIgnored: spoof };
        }
        tenantPatch.logo_url = text.includes('://') ? safeHttpUrl(text, null) : text;
      }
    }
  }
  if (Object.keys(tenantPatch).length) {
    const sets = Object.keys(tenantPatch).map((col, i) => `${col} = $${i + 1}`);
    await client.query(
      `UPDATE public.tenants SET ${sets.join(', ')} WHERE id = $${sets.length + 1}::uuid`,
      [...Object.values(tenantPatch), resolved.tenantId],
    );
  }
  await upsertTenantEmailSettings(client, resolved.tenantId, {
    from_name: fromName,
    reply_to: reply.replyTo,
    from_address: fromAddress,
  });
  const auditError = await commitDomainAudit(client, mapping, {
    action: 'tenant_email_branding_save',
    tenantId: resolved.tenantId,
    payload: { sending_domain: domain || null },
  }, spoof);
  if (auditError) return auditError;
  const row = await loadTenantEmailSettings(client, resolved.tenantId);
  const tenant = await loadTenant(client, resolved.tenantId) || resolved.tenant;
  return {
    ok: true,
    statusCode: 200,
    saved: true,
    settings: publicSettings(row, tenant, resolved.access),
    ignoredClientFields: ['domain_status', 'sending_mode', 'verified', 'ses_identity_name'].filter((k) => k in body),
    spoofFieldsIgnored: spoof,
  };
};

export const runStartDomainVerification = async ({
  client, mapping, body, spoof, sesv2,
}) => {
  const resolved = await requireTenant(client, mapping, body, spoof, { configure: true });
  if (resolved.error) return resolved.error;
  const parsed = normalizeSendingDomain(body.domain || body.sending_domain);
  if (!parsed.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: parsed.error,
      reason: parsed.reason || null,
      spoofFieldsIgnored: spoof,
    };
  }
  const local = normalizeFromLocalPart(body.fromLocalPart || body.from_local_part || DEFAULT_FROM_LOCAL_PART);
  if (!local.ok) {
    return { ok: false, statusCode: 400, error: local.error, spoofFieldsIgnored: spoof };
  }
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
  const limited = await requireActionRateLimit(client, mapping, resolved.tenantId, 'domain_start', spoof);
  if (limited) return limited;

  const owner = await findDomainOwner(client, parsed.domain, resolved.tenantId);
  if (owner) {
    return { ok: false, statusCode: 409, error: 'domain_already_assigned', spoofFieldsIgnored: spoof };
  }

  if (!tenantEmailDomainEnabled() && !sesv2) {
    return featureDisabled(spoof);
  }
  let adapter;
  try {
    adapter = await resolveSesV2(sesv2);
  } catch {
    return { ok: false, statusCode: 503, error: 'sesv2_unavailable', spoofFieldsIgnored: spoof };
  }
  if (!adapter?.createEmailIdentity) {
    return featureDisabled(spoof);
  }

  const existing = await loadTenantEmailSettings(client, resolved.tenantId);
  const replacing = Boolean(existing?.sending_domain && existing.sending_domain !== parsed.domain);
  const fromAddress = `${local.localPart}@${parsed.domain}`;

  let identity;
  try {
    identity = await adapter.createEmailIdentity({
      EmailIdentity: parsed.domain,
      DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
      Tags: [
        { Key: 'service', Value: 'checksops-tenant-email' },
        { Key: 'tenant_id', Value: String(resolved.tenantId) },
      ],
    });
  } catch (error) {
    const name = String(error?.name || error?.Code || '');
    if (!/AlreadyExists/i.test(name)) {
      const auditError = await commitDomainAudit(client, mapping, {
        action: 'tenant_email_domain_start_failed',
        tenantId: resolved.tenantId,
        payload: { sending_domain: parsed.domain, result: 'ses_create_failed' },
      }, spoof);
      if (auditError) return auditError;
      return {
        ok: false,
        statusCode: 502,
        error: 'ses_create_failed',
        spoofFieldsIgnored: spoof,
      };
    }
    try {
      identity = await adapter.getEmailIdentity({ EmailIdentity: parsed.domain });
    } catch {
      return { ok: false, statusCode: 502, error: 'ses_create_failed', spoofFieldsIgnored: spoof };
    }
  }

  const tokens = dkimTokensFromIdentity(identity);
  const dnsRecords = dkimRecordsFromTokens(parsed.domain, tokens);
  const mailFromInput = String(body.mailFromDomain || body.mail_from_domain || '').trim().toLowerCase();
  let mailFromDomain = null;
  let mailFromRecords = [];
  if (mailFromInput) {
    const mailFrom = normalizeSendingDomain(mailFromInput);
    if (!mailFrom.ok || mailFrom.domain === parsed.domain || !mailFrom.domain.endsWith(`.${parsed.domain}`)) {
      return { ok: false, statusCode: 400, error: 'invalid_mail_from_domain', spoofFieldsIgnored: spoof };
    }
    mailFromDomain = mailFrom.domain;
    mailFromRecords = mailFromRecordsFor(mailFromDomain);
  }

  try {
    await upsertTenantEmailSettings(client, resolved.tenantId, {
      sending_domain: parsed.domain,
      ses_identity_name: parsed.domain,
      from_address: fromAddress,
      from_name: fromName,
      reply_to: reply.replyTo,
      sending_mode: 'custom',
      domain_status: DOMAIN_STATUS.pending,
      custom_sending_enabled: false,
      dns_records: dnsRecords,
      verified_at: null,
      last_verification_error: null,
      mail_from_domain: mailFromDomain,
      mail_from_records: mailFromRecords,
    });
  } catch (error) {
    if (error?.code === 'domain_already_assigned') {
      return { ok: false, statusCode: 409, error: 'domain_already_assigned', spoofFieldsIgnored: spoof };
    }
    throw error;
  }

  const auditError = await commitDomainAudit(client, mapping, {
    action: replacing ? 'tenant_email_domain_replace' : 'tenant_email_domain_start',
    tenantId: resolved.tenantId,
    payload: { sending_domain: parsed.domain, replaced: replacing },
  }, spoof);
  if (auditError) return auditError;

  const row = await loadTenantEmailSettings(client, resolved.tenantId);
  return {
    ok: true,
    statusCode: 200,
    domain: parsed.domain,
    status: DOMAIN_STATUS.pending,
    verified: false,
    dns: publicDns(dnsRecords),
    mailFromRecords: publicDns(mailFromRecords),
    fallbackFrom: fallbackFromHeader(resolved.tenant.name),
    settings: publicSettings(row, resolved.tenant, resolved.access),
    spoofFieldsIgnored: spoof,
  };
};

export const runCheckDomainVerification = async ({
  client, mapping, body, spoof, sesv2,
}) => {
  const resolved = await requireTenant(client, mapping, body, spoof, { configure: true });
  if (resolved.error) return resolved.error;
  const limited = await requireActionRateLimit(client, mapping, resolved.tenantId, 'domain_check', spoof);
  if (limited) return limited;

  const row = await loadTenantEmailSettings(client, resolved.tenantId);
  const storedDomain = String(row?.sending_domain || '').trim().toLowerCase();
  if (!storedDomain) {
    return { ok: false, statusCode: 400, error: 'domain_not_configured', spoofFieldsIgnored: spoof };
  }
  if (String(row.domain_status || '').toLowerCase() === DOMAIN_STATUS.disabled) {
    return {
      ok: true,
      statusCode: 200,
      domain: storedDomain,
      status: DOMAIN_STATUS.disabled,
      verified: false,
      settings: publicSettings(row, resolved.tenant, resolved.access),
      spoofFieldsIgnored: spoof,
    };
  }

  if (!tenantEmailDomainEnabled() && !sesv2) {
    return featureDisabled(spoof);
  }
  let adapter;
  try {
    adapter = await resolveSesV2(sesv2);
  } catch {
    return { ok: false, statusCode: 503, error: 'sesv2_unavailable', spoofFieldsIgnored: spoof };
  }
  if (!adapter?.getEmailIdentity) return featureDisabled(spoof);

  let identity;
  try {
    identity = await adapter.getEmailIdentity({ EmailIdentity: storedDomain });
  } catch {
    await upsertTenantEmailSettings(client, resolved.tenantId, {
      domain_status: DOMAIN_STATUS.failed,
      last_checked_at: new Date().toISOString(),
      last_verification_error: 'identity_lookup_failed',
      custom_sending_enabled: false,
    });
    const auditError = await commitDomainAudit(client, mapping, {
      action: 'tenant_email_domain_check',
      tenantId: resolved.tenantId,
      payload: { sending_domain: storedDomain, result: 'failed' },
    }, spoof);
    if (auditError) return auditError;
    const failed = await loadTenantEmailSettings(client, resolved.tenantId);
    return {
      ok: true,
      statusCode: 200,
      domain: storedDomain,
      status: DOMAIN_STATUS.failed,
      verified: false,
      settings: publicSettings(failed, resolved.tenant, resolved.access),
      spoofFieldsIgnored: spoof,
    };
  }

  const identityName = String(
    identity.EmailIdentity
    || identity.IdentityName
    || identity.identityName
    || storedDomain,
  ).trim().toLowerCase();
  if (identityName !== storedDomain) {
    await upsertTenantEmailSettings(client, resolved.tenantId, {
      domain_status: DOMAIN_STATUS.failed,
      last_checked_at: new Date().toISOString(),
      last_verification_error: 'identity_mismatch',
      custom_sending_enabled: false,
    });
    const auditError = await commitDomainAudit(client, mapping, {
      action: 'tenant_email_domain_check',
      tenantId: resolved.tenantId,
      payload: { sending_domain: storedDomain, result: 'identity_mismatch' },
    }, spoof);
    if (auditError) return auditError;
    const failed = await loadTenantEmailSettings(client, resolved.tenantId);
    return {
      ok: true,
      statusCode: 200,
      domain: storedDomain,
      status: DOMAIN_STATUS.failed,
      verified: false,
      settings: publicSettings(failed, resolved.tenant, resolved.access),
      spoofFieldsIgnored: spoof,
    };
  }

  const tokens = dkimTokensFromIdentity(identity);
  const dnsRecords = tokens.length ? dkimRecordsFromTokens(storedDomain, tokens) : publicDns(row.dns_records);
  const verified = sesIdentityVerified(identity)
    && fromAddressOnVerifiedDomain(row.from_address, storedDomain);
  const nextStatus = verified
    ? DOMAIN_STATUS.verified
    : (String(identity.VerificationStatus || '').toUpperCase() === 'FAILED'
      || String(identity.DkimAttributes?.Status || '').toUpperCase() === 'FAILED'
      ? DOMAIN_STATUS.failed
      : DOMAIN_STATUS.verifying);

  await upsertTenantEmailSettings(client, resolved.tenantId, {
    domain_status: nextStatus,
    ses_identity_name: storedDomain,
    dns_records: dnsRecords,
    last_checked_at: new Date().toISOString(),
    last_verification_error: verified ? null : (nextStatus === DOMAIN_STATUS.failed ? 'ses_not_verified' : null),
    verified_at: verified ? (row.verified_at || new Date().toISOString()) : null,
    custom_sending_enabled: verified,
    sending_mode: verified ? 'custom' : (row.sending_mode || 'custom'),
  });

  const auditError = await commitDomainAudit(client, mapping, {
    action: verified ? 'tenant_email_domain_verify' : 'tenant_email_domain_check',
    tenantId: resolved.tenantId,
    payload: { sending_domain: storedDomain, result: nextStatus },
  }, spoof);
  if (auditError) return auditError;

  const updated = await loadTenantEmailSettings(client, resolved.tenantId);
  return {
    ok: true,
    statusCode: 200,
    domain: storedDomain,
    status: uiDomainStatus(updated),
    verified,
    dns: publicDns(updated?.dns_records || dnsRecords),
    settings: publicSettings(updated, resolved.tenant, resolved.access),
    spoofFieldsIgnored: spoof,
  };
};

export const runDisableCustomSending = async ({ client, mapping, body, spoof }) => {
  const resolved = await requireTenant(client, mapping, body, spoof, { configure: true });
  if (resolved.error) return resolved.error;
  const limited = await requireActionRateLimit(client, mapping, resolved.tenantId, 'domain_disable', spoof);
  if (limited) return limited;
  const existing = await loadTenantEmailSettings(client, resolved.tenantId);
  await upsertTenantEmailSettings(client, resolved.tenantId, {
    sending_mode: 'platform',
    domain_status: DOMAIN_STATUS.disabled,
    custom_sending_enabled: false,
  });
  const auditError = await commitDomainAudit(client, mapping, {
    action: 'tenant_email_domain_disable',
    tenantId: resolved.tenantId,
    payload: { sending_domain: existing?.sending_domain || null },
  }, spoof);
  if (auditError) return auditError;
  const row = await loadTenantEmailSettings(client, resolved.tenantId);
  return {
    ok: true,
    statusCode: 200,
    disabled: true,
    sesIdentityDeleted: false,
    settings: publicSettings(row, resolved.tenant, resolved.access),
    fallbackFrom: fallbackFromHeader(resolved.tenant.name),
    spoofFieldsIgnored: spoof,
  };
};

export const runDeleteSesIdentity = async ({
  client, mapping, body, spoof, sesv2,
}) => {
  const resolved = await requireTenant(client, mapping, body, spoof, { configure: true });
  if (resolved.error) return resolved.error;
  if (!resolved.access.canDeleteIdentity || !tenantSesIdentityDeleteEnabled()) {
    return denied(spoof, 'operator_delete_required');
  }
  const limited = await requireActionRateLimit(client, mapping, resolved.tenantId, 'domain_delete', spoof);
  if (limited) return limited;
  const domain = String(body.domain || body.sending_domain || '').trim().toLowerCase();
  const parsed = normalizeSendingDomain(domain);
  if (!parsed.ok) {
    return { ok: false, statusCode: 400, error: parsed.error, spoofFieldsIgnored: spoof };
  }
  const others = await findDomainOwner(client, parsed.domain, null);
  if (others) {
    return {
      ok: false,
      statusCode: 409,
      error: 'identity_still_mapped',
      spoofFieldsIgnored: spoof,
    };
  }
  if (!tenantEmailDomainEnabled() && !sesv2) return featureDisabled(spoof);
  const adapter = await resolveSesV2(sesv2);
  if (!adapter?.deleteEmailIdentity) return featureDisabled(spoof);
  await adapter.deleteEmailIdentity({ EmailIdentity: parsed.domain });
  const auditError = await commitDomainAudit(client, mapping, {
    action: 'tenant_ses_identity_delete',
    tenantId: resolved.tenantId,
    payload: { sending_domain: parsed.domain },
  }, spoof);
  if (auditError) return auditError;
  return {
    ok: true,
    statusCode: 200,
    deleted: true,
    domain: parsed.domain,
    spoofFieldsIgnored: spoof,
  };
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
    ok: true,
    statusCode: 200,
    processed: 0,
    staging: true,
    sesCalled: false,
    message: 'tenant-domain-recheck-cron remains a no-op; SES polling is not activated in this PR',
    spoofFieldsIgnored: spoof,
    path: event?.path || null,
  };
};
