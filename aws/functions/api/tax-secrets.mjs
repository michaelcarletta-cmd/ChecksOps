/**
 * Tax identifier containment helpers.
 * Full TIN/EIN values must never appear in API JSON, logs, or UI state.
 */

export const TAX_SECRET_TABLES = new Set(['recipient_tax_profiles']);
export const TAX_SECRET_COLUMNS = new Set(['tin', 'tin_encrypted']);
export const PERMITTED_TENANT_TAX_ROLES = new Set(['owner', 'admin']);
const SAFE_TIN_METADATA_COLUMNS = new Set(['tin_on_file', 'tin_last_4', 'tin_type']);
const TAX_SECRET_RPC_NAMES = new Set([
  'get_recipient_tin',
  'get_recipient_tax_profile',
  'upsert_recipient_tax_profile',
  'list_recipient_tax_profiles',
  'recipient_tax_profiles',
]);

const unwrapQuoted = (value) => {
  let s = String(value ?? '').trim();
  while (
    s.length >= 2
    && (
      (s.startsWith('"') && s.endsWith('"'))
      || (s.startsWith("'") && s.endsWith("'"))
      || (s.startsWith('`') && s.endsWith('`'))
    )
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
};

/**
 * Normalize schema-qualified, quoted, case-varied, and whitespace-varied
 * SQL identifiers before tax-secret checks. Always deny on the last segment
 * so `public.recipient_tax_profiles` and `"Recipient_Tax_Profiles"` match.
 */
export const normalizeSqlName = (value) => {
  let s = unwrapQuoted(value);
  if (s.includes('.')) {
    const parts = s.split('.');
    s = unwrapQuoted(parts[parts.length - 1]);
  }
  const ident = s.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  return (ident ? ident[0] : s).toLowerCase();
};

export const sqlIdentifierTokens = (value) => String(value || '')
  .split(/[^A-Za-z0-9_]+/)
  .filter(Boolean)
  .map((token) => token.toLowerCase());

export const isTaxSecretTable = (table) => {
  if (TAX_SECRET_TABLES.has(normalizeSqlName(table))) return true;
  return sqlIdentifierTokens(table).some((token) => TAX_SECRET_TABLES.has(token));
};

export const isTaxSecretColumn = (column) => {
  const name = normalizeSqlName(column);
  if (SAFE_TIN_METADATA_COLUMNS.has(name)) return false;
  return TAX_SECRET_COLUMNS.has(name);
};

export const isTaxSecretRpc = (fn) => {
  const name = normalizeSqlName(fn);
  if (!name) return false;
  if (TAX_SECRET_RPC_NAMES.has(name)) return true;
  if (name.includes('recipient_tax_profile')) return true;
  if (name.includes('tax_secret')) return true;
  return isTaxSecretTable(fn);
};

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
  .replace(/\b(DETAIL|HINT|CONTEXT|WHERE|QUERY):\s*[^\n]*/gi, '[$1_redacted]')
  .replace(/\d{3}-?\d{2}-?\d{4}|\d{2}-?\d{7}|\d{9}/g, '[redacted]')
  .replace(/\b(?:tin|ein|ssn)\b\s*[:=]\s*\S+/gi, '[redacted]')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const denied = (message, table) => ({
  denied: true,
  error: 'tax_secret_denied',
  statusCode: 403,
  message,
  table: table ? normalizeSqlName(table) || String(table) : null,
});

const walkEmbedsForSecrets = (embeds = []) => {
  for (const embed of embeds) {
    if (isTaxSecretTable(embed?.table) || isTaxSecretTable(embed?.alias)) return true;
    const cols = embed?.columns || [];
    if (cols.some((col) => isTaxSecretColumn(col))) return true;
    if (walkEmbedsForSecrets(embed?.embeds || [])) return true;
  }
  return false;
};

export const rawMentionsTaxSecret = (raw) => {
  for (const token of sqlIdentifierTokens(raw)) {
    if (SAFE_TIN_METADATA_COLUMNS.has(token)) continue;
    if (TAX_SECRET_COLUMNS.has(token) || TAX_SECRET_TABLES.has(token)) return true;
  }
  return false;
};

/**
 * Fail-closed tax denial for generic query routes.
 * Must be evaluated on the raw table/select *before* allowlist or ident()
 * so a later accidental re-allowlist cannot return TIN, and so schema/case/
 * whitespace/alias forms return 403 tax_secret_denied instead of a parser 503.
 */
export const denyTaxSecretQuery = (table, parsed = {}, rawSelect = '', filters = []) => {
  if (isTaxSecretTable(table)) {
    return denied('Tax identifier tables are not available via generic data routes', table);
  }
  const cols = parsed?.columns || [];
  if (cols.some((col) => isTaxSecretColumn(col))) {
    return denied('Tax identifier columns are not available via generic data routes', table);
  }
  if (walkEmbedsForSecrets(parsed?.embeds || [])) {
    return denied('Tax identifier tables are not available via generic data routes', table);
  }
  if (rawMentionsTaxSecret(rawSelect)) {
    return denied('Tax identifier columns are not available via generic data routes', table);
  }
  if (rawMentionsTaxSecret(table)) {
    return denied('Tax identifier tables are not available via generic data routes', table);
  }
  for (const filter of filters || []) {
    if (isTaxSecretColumn(filter?.column) || rawMentionsTaxSecret(filter?.column)) {
      return denied('Tax identifier columns are not available via generic data routes', table);
    }
  }
  return { denied: false };
};

const collectWriteRows = (body) => {
  const values = body?.values ?? body?.payload ?? body?.row ?? body;
  if (Array.isArray(values)) return values;
  if (values && typeof values === 'object') return [values];
  return [];
};

export const denyTaxSecretWrite = (table, body = {}) => {
  if (isTaxSecretTable(table) || rawMentionsTaxSecret(table)) {
    return denied('Tax identifier tables are not available via generic data routes', table);
  }
  for (const row of collectWriteRows(body)) {
    for (const key of Object.keys(row || {})) {
      if (isTaxSecretColumn(key)) {
        return denied('Tax identifier columns are not available via generic data routes', table);
      }
    }
  }
  return { denied: false };
};

export const rpcArgsHaveTaxSecret = (args) => {
  if (!args || typeof args !== 'object') return false;
  for (const key of Object.keys(args)) {
    if (isTaxSecretColumn(key) || isTaxSecretTable(key) || isTaxSecretRpc(key)) return true;
  }
  return false;
};

export const denyTaxSecretRpc = (fn, args) => {
  if (isTaxSecretRpc(fn) || isTaxSecretTable(fn) || rpcArgsHaveTaxSecret(args)) {
    return denied('Tax identifier RPCs are not available via generic data routes', fn);
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
