/**
 * Platform vs tenant email branding for AWS application mail.
 * Never bypasses sink/allowlist (those live in email-policy.mjs).
 * Unverified tenant custom From addresses are Reply-To only.
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

const RAW_BRANDING_PATH = /^(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+$|^[A-Za-z0-9._-]+\.(?:png|jpe?g|gif|webp|svg)$/i;

/** Display/delivery URL for a stored tenant logo. Does not persist. */
export const publicTenantLogoUrl = (value, origin = emailAssetOrigin()) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (isSafeHttpUrl(raw)) return raw;
  if (/^(javascript|data|blob|file):/i.test(raw) || raw.includes('..') || raw.includes('://') || raw.startsWith('//')) {
    return null;
  }
  const base = String(origin || '').replace(/\/$/, '');
  if (raw.includes('/storage/public')) {
    if (raw.startsWith('http')) return isSafeHttpUrl(raw) ? raw : null;
    const rel = raw.startsWith('/') ? raw : `/${raw}`;
    const abs = `${base}${rel}`;
    return isSafeHttpUrl(abs) ? abs : null;
  }
  if (/\s/.test(raw) || raw.startsWith('/') || raw.includes('?') || raw.includes('#')) return null;
  if (!RAW_BRANDING_PATH.test(raw)) return null;
  const path = raw.replace(/^tenant-logos\//, '');
  const url = `${base}/prep/storage/public?bucket=tenant-logos&path=${encodeURIComponent(path)}`;
  return isSafeHttpUrl(url) ? url : null;
};

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
 * Custom From is allowed only when tenant_email_settings has:
 *   sending_mode = custom
 *   domain_status = verified (server-side SES check only — never from the frontend)
 *   custom sending enabled
 *   SES identity name matching stored sending_domain
 *   from_address belonging to sending_domain (exact host or a subdomain)
 *
 * A verified subdomain does not authorize the parent domain.
 */
export const customFromFailureReason = (settings = {}) => {
  const mode = String(settings.sending_mode || '').trim().toLowerCase();
  const status = String(settings.domain_status || '').trim().toLowerCase();
  const from = normalizeEmail(settings.from_address);
  const domain = String(settings.sending_domain || '').trim().toLowerCase();
  const identity = String(settings.ses_identity_name || settings.sending_domain || '').trim().toLowerCase();
  const customEnabled = settings.custom_sending_enabled !== false && mode === 'custom';
  if (status === 'disabled' || settings.custom_sending_enabled === false) return 'custom_sending_disabled';
  if (mode !== 'custom') return 'sending_mode_not_custom';
  if (status !== 'verified') return 'domain_not_verified';
  if (!customEnabled) return 'custom_sending_disabled';
  if (!domain || !identity || identity !== domain) return 'ses_identity_mismatch';
  if (!from.includes('@')) return 'from_address_not_on_domain';
  const fromDomain = addressDomain(from);
  if (!(fromDomain === domain || fromDomain.endsWith(`.${domain}`))) return 'from_address_not_on_domain';
  return null;
};

export const isVerifiedCustomSender = (settings = {}) => customFromFailureReason(settings) === null;

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
  const customFromReason = customFromFailureReason(settings);
  const verified = customFromReason === null && Boolean(settings.from_address);
  const customFromBlocked = Boolean(requestedCustomFrom) && !verified
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
    requestedCustomFrom,
    platform.replyTo,
  );
  const primaryColor = isSafeHexColor(tenant.primary_color)
    ? String(tenant.primary_color).trim()
    : platform.primaryColor;
  const logoUrl = publicTenantLogoUrl(tenant.logo_url) || platform.logoUrl;

  if (verified) {
    return {
      ...platform,
      from: formatFromHeader(displayName, settings.from_address),
      fromName: displayName,
      fromAddress: normalizeEmail(settings.from_address),
      replyTo,
      companyName: displayName,
      companySubtitle,
      primaryColor,
      logoUrl,
      usingCustomFrom: true,
      customFromBlocked: false,
      requestedCustomFrom,
      customFromReason: null,
    };
  }

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
    customFromReason: customFromBlocked ? (customFromReason || 'domain_not_verified') : null,
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
