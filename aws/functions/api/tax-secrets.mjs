/**
 * Tax identifier containment helpers.
 * Full TIN/EIN values must never appear in API JSON, logs, or UI state.
 */

export const TAX_SECRET_TABLES = new Set(['recipient_tax_profiles']);
export const TAX_SECRET_COLUMNS = new Set(['tin', 'tin_encrypted']);
export const PERMITTED_TENANT_TAX_ROLES = new Set(['owner', 'admin']);

export const maskTinMetadata = (tin) => {
  const raw = tin == null ? '' : String(tin);
  const digits = raw.replace(/\D/g, '');
  if (!digits) {
    return { tin_on_file: false, tin_last_4: null, tin_type: null };
  }
  let tinType = null;
  if (digits.length === 9) {
    const trimmed = raw.trim();
    if (/^\d{2}-\d{7}$/.test(trimmed)) tinType = 'ein';
    else if (/^\d{3}-\d{2}-\d{4}$/.test(trimmed)) tinType = 'ssn';
    else tinType = 'unknown';
  }
  return {
    tin_on_file: true,
    tin_last_4: digits.slice(-4),
    tin_type: tinType,
  };
};

const omitSecretKeys = (row) => {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    const lower = String(key).toLowerCase();
    if (TAX_SECRET_COLUMNS.has(lower)) continue;
    if (lower === 'ein' || lower === 'ssn') continue;
    out[key] = value;
  }
  return out;
};

export const publicTaxProfile = (row) => {
  if (!row) return null;
  const safe = omitSecretKeys(row);
  const masked = maskTinMetadata(row.tin);
  return {
    ...safe,
    tin_on_file: safe.tin_on_file == null ? masked.tin_on_file : Boolean(safe.tin_on_file),
    tin_last_4: safe.tin_last_4 ?? masked.tin_last_4,
    tin_type: safe.tin_type ?? masked.tin_type,
  };
};

export const evaluateTaxAccess = ({
  isPlatformOwner = false,
  platformRoles = [],
  tenantMembershipRole = null,
} = {}) => {
  if (isPlatformOwner === true) {
    return { allowed: true, reason: 'platform_owner' };
  }
  const roles = Array.isArray(platformRoles) ? platformRoles.map((r) => String(r || '').toLowerCase()) : [];
  if (roles.includes('admin')) {
    return { allowed: true, reason: 'platform_admin' };
  }
  const tenantRole = tenantMembershipRole == null ? '' : String(tenantMembershipRole).toLowerCase();
  if (PERMITTED_TENANT_TAX_ROLES.has(tenantRole)) {
    return { allowed: true, reason: 'tenant_finance_admin' };
  }
  return { allowed: false, reason: 'not_authorized' };
};

export const sanitizeTaxError = (value, max = 200) => String(value || '')
  .replace(/\d{3}-?\d{2}-?\d{4}|\d{2}-?\d{7}|\d{9}/g, '[redacted]')
  .replace(/\b(?:tin|ein|ssn)\b\s*[:=]\s*\S+/gi, '[redacted]')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const walkEmbedsForSecrets = (embeds = []) => {
  for (const embed of embeds) {
    if (TAX_SECRET_TABLES.has(String(embed?.table || ''))) return true;
    const cols = embed?.columns || [];
    if (cols.some((col) => TAX_SECRET_COLUMNS.has(String(col)))) return true;
    if (walkEmbedsForSecrets(embed?.embeds || [])) return true;
  }
  return false;
};

export const denyTaxSecretQuery = (table, parsed = {}) => {
  const name = String(table || '');
  if (TAX_SECRET_TABLES.has(name)) {
    return {
      denied: true,
      error: 'tax_secret_denied',
      statusCode: 403,
      message: 'Tax identifier tables are not available via generic data routes',
      table: name,
    };
  }
  const cols = parsed.columns || [];
  if (cols.some((col) => TAX_SECRET_COLUMNS.has(String(col)))) {
    return {
      denied: true,
      error: 'tax_secret_denied',
      statusCode: 403,
      message: 'Tax identifier columns are not available via generic data routes',
      table: name,
    };
  }
  if (walkEmbedsForSecrets(parsed.embeds || [])) {
    return {
      denied: true,
      error: 'tax_secret_denied',
      statusCode: 403,
      message: 'Tax identifier tables are not available via generic data routes',
      table: name,
    };
  }
  return { denied: false };
};

export const jsonHasFullTin = (value, sampleTin) => {
  const blob = JSON.stringify(value);
  if (sampleTin) {
    const digits = String(sampleTin).replace(/\D/g, '');
    if (digits.length >= 5 && blob.includes(digits)) return true;
    if (blob.includes(String(sampleTin))) return true;
  }
  return false;
};
