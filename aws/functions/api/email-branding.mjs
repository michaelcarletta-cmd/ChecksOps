/**
 * Platform vs tenant email branding for AWS application mail.
 * Never bypasses sink/allowlist (those live in email-policy.mjs).
 * ChecksOps SES always owns From. Tenant branding is display name, logo,
 * color, and Reply-To. Legacy sending-domain rows cannot change Source.
 */
import { defaultFromAddress, defaultReplyTo, normalizeEmail } from './email-policy.mjs';

export const PLATFORM_SUPPORT_EMAIL = 'support@checksops.com';
export const PLATFORM_PRIMARY_COLOR = '#1a56db';
export const PLATFORM_FROM_LOCAL = 'noreply';
export const PLATFORM_FROM_DOMAIN = 'checksops.com';

export const emailAssetOrigin = () => String(
  process.env.SIGN_BASE_URL
  || process.env.APP_PUBLIC_URL
  || process.env.VITE_APP_URL
  || 'https://staging.checksops.com',
).replace(/\/$/, '');

export const checksOpsLogoUrl = () => `${emailAssetOrigin()}/checksops-logo.png`;

/**
 * Allow only https URLs in email href/src attributes.
 * http is permitted solely for loopback hosts (local test environments).
 * javascript:, data:, file:, and protocol-relative URLs are rejected.
 */
export const isSafeHttpUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('//') || /[\u0000-\u001F\u007F]/.test(raw)) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (!parsed.hostname) return false;
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'https:') return true;
  if (protocol === 'http:') {
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }
  return false;
};

export const safeHttpUrl = (value, fallback = null) => (
  isSafeHttpUrl(value) ? String(value).trim() : fallback
);

export { defaultReplyTo };

export const parseFromHeader = (from) => {
  const text = String(from || defaultFromAddress() || '').trim();
  const match = text.match(/^(.*)<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].trim().replace(/^"|"$/g, '') || 'ChecksOps',
      address: match[2].trim().toLowerCase(),
    };
  }
  if (text.includes('@')) return { name: 'ChecksOps', address: text.toLowerCase() };
  return {
    name: 'ChecksOps Staging',
    address: `${PLATFORM_FROM_LOCAL}@${PLATFORM_FROM_DOMAIN}`,
  };
};

export const isSafeHexColor = (value) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value || '').trim());

export const addressDomain = (email) => {
  const addr = normalizeEmail(email);
  if (!addr.includes('@')) return '';
  return addr.split('@').pop();
};

export const formatFromHeader = (name, address) => {
  const display = String(name || '').trim().replace(/[\r\n<>]/g, '');
  const addr = normalizeEmail(address);
  if (!addr.includes('@')) return defaultFromAddress();
  if (!display) return addr;
  const quoted = /[",\\]/.test(display) ? `"${display.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : display;
  return `${quoted} <${addr}>`;
};

/**
 * Tenant custom From is retired. ChecksOps SES is the only sending identity.
 * Legacy sending_mode / domain_status / sending_domain / from_address /
 * SES identity rows stay dormant and never win Source.
 */
export const customFromFailureReason = (_settings = {}) => 'custom_from_retired';

export const isVerifiedCustomSender = (_settings = {}) => false;

export const platformBranding = () => {
  const parsed = parseFromHeader(defaultFromAddress());
  return {
    from: formatFromHeader(parsed.name, parsed.address),
    fromName: parsed.name || 'ChecksOps',
    fromAddress: parsed.address,
    replyTo: defaultReplyTo(),
    companyName: parsed.name || 'ChecksOps',
    companySubtitle: null,
    primaryColor: PLATFORM_PRIMARY_COLOR,
    logoUrl: checksOpsLogoUrl(),
    usingCustomFrom: false,
    customFromBlocked: false,
    requestedCustomFrom: null,
    customFromReason: null,
  };
};

const firstNonEmpty = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

export const resolveEmailBranding = async (client, { tenantId = null, senderOverride = null } = {}) => {
  const platform = platformBranding();
  if (senderOverride === 'checksops' || !tenantId) return platform;

  let tenant = {};
  let settings = {};
  if (client?.query) {
    try {
      tenant = (await client.query(
        `SELECT name, logo_url, primary_color, is_system_tenant,
                email_from_name, email_from_address, email_reply_to
         FROM public.tenants WHERE id = $1::uuid LIMIT 1`,
        [tenantId],
      )).rows[0] || {};
    } catch {
      tenant = {};
    }
    try {
      settings = (await client.query(
        `SELECT from_name, reply_to, sending_mode, sending_domain, from_address, domain_status,
                ses_identity_name, custom_sending_enabled
         FROM public.tenant_email_settings WHERE tenant_id = $1::uuid LIMIT 1`,
        [tenantId],
      )).rows[0] || {};
    } catch {
      try {
        settings = (await client.query(
          `SELECT from_name, reply_to, sending_mode, sending_domain, from_address, domain_status
           FROM public.tenant_email_settings WHERE tenant_id = $1::uuid LIMIT 1`,
          [tenantId],
        )).rows[0] || {};
      } catch {
        settings = {};
      }
    }
  }

  const requestedCustomFrom = firstNonEmpty(settings.from_address, tenant.email_from_address);
  const customFromBlocked = Boolean(requestedCustomFrom)
    && normalizeEmail(requestedCustomFrom) !== platform.fromAddress;

  const displayName = firstNonEmpty(
    settings.from_name,
    tenant.email_from_name,
    tenant.is_system_tenant === false ? tenant.name : null,
    platform.fromName,
  );
  const companySubtitle = tenant.is_system_tenant === false
    ? firstNonEmpty(tenant.name)
    : null;
  const replyTo = firstNonEmpty(
    settings.reply_to,
    tenant.email_reply_to,
    platform.replyTo,
  );
  const primaryColor = isSafeHexColor(tenant.primary_color)
    ? String(tenant.primary_color).trim()
    : platform.primaryColor;
  const logoUrl = safeHttpUrl(tenant.logo_url, platform.logoUrl);

  const fallbackName = companySubtitle
    ? `${displayName && displayName !== platform.fromName ? displayName : companySubtitle} via ChecksOps`
    : platform.fromName;

  return {
    ...platform,
    from: formatFromHeader(fallbackName, platform.fromAddress),
    fromName: fallbackName,
    fromAddress: platform.fromAddress,
    replyTo,
    companyName: companySubtitle || platform.companyName,
    companySubtitle,
    primaryColor,
    logoUrl,
    usingCustomFrom: false,
    customFromBlocked,
    requestedCustomFrom,
    customFromReason: customFromBlocked ? 'custom_from_retired' : null,
  };
};

export const brandingForTemplate = (branding = {}) => ({
  branding: {
    companyName: branding.companyName,
    companySubtitle: branding.companySubtitle,
    primaryColor: branding.primaryColor,
    logoUrl: branding.logoUrl,
  },
  companyName: branding.companyName,
});
