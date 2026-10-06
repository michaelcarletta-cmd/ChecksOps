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

const PRODUCTION_APP_ORIGIN = 'https://checksops.com';
const STAGING_APP_ORIGIN = 'https://staging.checksops.com';

const isProductionChecksopsEnv = (env = process.env.CHECKSOPS_ENV) => {
  const value = String(env || '').trim().toLowerCase();
  return value === 'production' || value === 'production-prep';
};

const isStagingAppHostName = (hostname) => {
  const host = String(hostname || '').trim().toLowerCase();
  return host === 'staging.checksops.com' || host.endsWith('.staging.checksops.com');
};

/**
 * SPA/asset origin for platform logo and mail links.
 * Production never falls back to staging.checksops.com (templates already
 * set SIGN_BASE_URL=https://checksops.com).
 */
export const emailAssetOrigin = () => {
  const configured = String(
    process.env.SIGN_BASE_URL
    || process.env.APP_PUBLIC_URL
    || process.env.VITE_APP_URL
    || '',
  ).trim().replace(/\/$/, '');
  if (configured) {
    try {
      const host = new URL(configured).hostname;
      if (isProductionChecksopsEnv() && isStagingAppHostName(host)) {
        return PRODUCTION_APP_ORIGIN;
      }
      return configured;
    } catch {
      if (isProductionChecksopsEnv()) return PRODUCTION_APP_ORIGIN;
    }
  }
  return isProductionChecksopsEnv() ? PRODUCTION_APP_ORIGIN : STAGING_APP_ORIGIN;
};

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
const SUPABASE_BRANDING = /^https?:\/\/[^/]*supabase\.co\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/([^?]+)/i;
const BRANDING_BUCKETS = new Set(['tenant-logos', 'email-assets', 'company-branding']);
const SAME_ORIGIN_API_TOKENS = new Set(['/prep', 'same-origin', 'same-origin:/prep']);

const configuredApiUrl = () => String(
  process.env.CHECKSOPS_API_URL || process.env.VITE_CHECKSOPS_API_URL || '',
).trim();

const configuredAppOrigin = () => {
  for (const key of ['SIGN_BASE_URL', 'APP_PUBLIC_URL', 'VITE_APP_URL']) {
    const value = String(process.env[key] || '').trim();
    if (value) return value.replace(/\/$/, '');
  }
  return '';
};

const checksopsEnv = () => String(process.env.CHECKSOPS_ENV || '').trim().toLowerCase();

const isProductionEnv = (env = checksopsEnv()) => isProductionChecksopsEnv(env);

/**
 * Same tokens as src/lib/awsApiBase.ts resolveAwsApiBaseUrl.
 * Production Step 2 uses /prep | same-origin against the app origin.
 * Staging keeps an absolute execute-api URL from CHECKSOPS_API_URL /
 * VITE_CHECKSOPS_API_URL. Relative /prep is not browser-reachable in email.
 */
export const resolveRuntimeApiBaseUrl = (configured, appOrigin) => {
  const value = String(configured || '').trim().replace(/\/$/, '');
  const token = value.toLowerCase();
  if (SAME_ORIGIN_API_TOKENS.has(token)) {
    if (appOrigin) {
      try {
        return new URL('/prep', appOrigin).toString().replace(/\/$/, '');
      } catch {
        return '/prep';
      }
    }
    return '/prep';
  }
  return value;
};

const parsedHttpUrl = (value) => {
  if (!isSafeHttpUrl(value)) return null;
  try {
    return new URL(String(value).trim());
  } catch {
    return null;
  }
};

const isStagingSpaHost = (url) => isStagingAppHostName(url.hostname);

const isStagingExecuteApiOrigin = (url) => {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/$/, '').toLowerCase();
  return host.includes('execute-api') && path === '/staging';
};

/**
 * Email HTML needs an absolute HTTPS API origin that browsers can fetch.
 * Staging CloudFront /prep/* is SPA HTML, not the API. Fail closed (null)
 * rather than emit an inaccessible /prep path or a staging URL in production.
 */
export const isBrowserReachableApiOrigin = (value, env = checksopsEnv()) => {
  const url = parsedHttpUrl(value);
  if (!url || url.protocol !== 'https:') return false;
  if (isStagingSpaHost(url)) return false;
  if (isProductionEnv(env) && (isStagingSpaHost(url) || isStagingExecuteApiOrigin(url))) {
    return false;
  }
  return true;
};

/**
 * Browser-reachable API origin for /storage/public.
 * Reads the existing ChecksOps API-origin configuration:
 *   CHECKSOPS_API_URL (scripts / Lambda)
 *   VITE_CHECKSOPS_API_URL (SPA)
 * then resolveAwsApiBaseUrl tokens against SIGN_BASE_URL / APP_PUBLIC_URL /
 * VITE_APP_URL. Production may derive /prep from CHECKSOPS_ENV + app origin.
 * Staging never falls back to a hard-coded execute-api URL.
 */
export const publicApiBaseUrl = () => {
  const env = checksopsEnv();
  const configured = configuredApiUrl();
  const appOrigin = configuredAppOrigin();
  const implicitProduction = !configured && isProductionEnv(env) ? '/prep' : configured;
  const resolved = resolveRuntimeApiBaseUrl(implicitProduction, appOrigin || undefined);
  if (!isBrowserReachableApiOrigin(resolved, env)) return null;
  return resolved.replace(/\/$/, '');
};

/**
 * Display URL for a stored tenant logo. Does not persist.
 * Raw object paths and legacy Supabase public/sign URLs become
 * `${apiBase}/storage/public?bucket=tenant-logos&path=...`.
 * Already-safe HTTPS URLs pass through.
 */
export const publicTenantLogoUrl = (value, apiBase = publicApiBaseUrl()) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^(javascript|data|blob|file):/i.test(raw) || raw.includes('..') || raw.startsWith('//')) {
    return null;
  }
  const base = String(apiBase || '').replace(/\/$/, '');
  const supabase = raw.match(SUPABASE_BRANDING);
  if (supabase && BRANDING_BUCKETS.has(supabase[1]) && base) {
    const path = decodeURIComponent(supabase[2]);
    const url = `${base}/storage/public?bucket=${encodeURIComponent(supabase[1])}&path=${encodeURIComponent(path)}`;
    return isSafeHttpUrl(url) ? url : null;
  }
  if (isSafeHttpUrl(raw)) return raw;
  if (!base) return null;
  if (raw.includes('/storage/public')) {
    const rel = raw.startsWith('/') ? raw : `/${raw}`;
    const abs = `${base}${rel.replace(/^\/prep(?=\/)/, '')}`;
    return isSafeHttpUrl(abs) ? abs : null;
  }
  if (/\s/.test(raw) || raw.startsWith('/') || raw.includes('://') || raw.includes('?') || raw.includes('#')) {
    return null;
  }
  if (!RAW_BRANDING_PATH.test(raw)) return null;
  const path = raw.replace(/^tenant-logos\//, '');
  const url = `${base}/storage/public?bucket=tenant-logos&path=${encodeURIComponent(path)}`;
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
