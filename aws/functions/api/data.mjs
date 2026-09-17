import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadDatabaseCredentials } from './secrets.mjs';
import { buildClientConfig, buildWriteClientConfig, sanitizePublicError } from './db-health.mjs';
import {
  APP_USER_EMAIL_GUC,
  APP_USER_ID_GUC,
  bearerToken,
  cognitoClaimsFromEvent,
  refuseSubAsApplicationId,
  verifyCognitoIdToken,
} from './cognito.mjs';
import { LOOKUP_MAPPING_SQL } from './identity.mjs';
import { denyTaxSecretQuery, denyTaxSecretRpc } from './tax-secrets.mjs';

const { Client } = pg;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ALLOWED = new Set(JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'allowed-tables.json'),
  'utf8',
)));
ALLOWED.add('tenants_public');

const READ_RPCS = new Set([
  'get_check_dashboard_counts_for_tenant',
  'get_check_stage_totals',
  'get_total_unread_check_messages',
  'get_check_unread_counts',
  'get_loss_draft_dashboard_counts_for_tenant',
  'get_tenant_funds_received',
  'get_tenant_check_usage',
  'get_deposit_ops_kpis',
  'get_deposit_aging_summary',
  'get_deposit_exception_kpis',
  'has_permission',
  'get_my_tenant_partner_codes',
  'contractor_verification_status',
  'is_checkalt_enabled_for_tenant',
  'list_partner_payout_options',
  'get_all_checks_safety_net',
  'get_stuck_checks',
  'get_check_claim_settlement',
  'lookup_tenant_by_partner_code',
  'get_tenant_users_with_profiles',
  'is_approval_required',
  'is_master_owner',
  'is_platform_owner',
]);

const RPC_UNWRAP_SINGLE_COLUMN = new Set([
  'has_permission',
  'is_checkalt_enabled_for_tenant',
  'get_check_dashboard_counts_for_tenant',
  'get_total_unread_check_messages',
  'get_loss_draft_dashboard_counts_for_tenant',
  'get_tenant_check_usage',
  'get_deposit_ops_kpis',
  'get_deposit_exception_kpis',
  'contractor_verification_status',
  'get_check_claim_settlement',
  'lookup_tenant_by_partner_code',
  'is_master_owner',
  'is_platform_owner',
]);

export const ident = (name, kind = 'identifier') => {
  const value = String(name || '').replace(/^public\./, '');
  if (!IDENT.test(value)) throw new Error(`invalid ${kind}`);
  return value;
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const sanitizeLogText = (value, max = 200) => String(value || '')
  .replace(/(?:postgres(?:ql)?|mysql|mongodb):\/\/\S+/gi, '[db-url]')
  .replace(/\b(DETAIL|HINT|CONTEXT|WHERE|QUERY):\s*[^\n]*/gi, '[$1_redacted]')
  .replace(/\b(?:bearer|token|authorization|password|secret|api[_-]?key|tin|ein|ssn)\b(?:\s*[:=]\s*|\s+)\S+/gi, '[redacted]')
  .replace(/\d{3}-\d{2}-\d{4}/g, '[redacted]')
  .replace(/\d{2}-\d{7}/g, '[redacted]')
  .replace(/\b\d{9}\b/g, '[redacted]')
  .replace(EMAIL_RE, '[email]')
  .replace(UUID_RE, '[id]')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const safeQueryLogContext = (body = {}) => ({
  table: typeof body?.table === 'string' ? body.table.slice(0, 120) : '',
  select: typeof body?.select === 'string' ? body.select : '',
  requestId: body?.requestId || null,
  route: body?.route || null,
});

export const classifyDataQueryFailure = (error, body = {}) => {
  const ctx = safeQueryLogContext(body);
  const publicMessage = sanitizePublicError(error);
  const message = sanitizeLogText(publicMessage, 200);
  let errorClass = 'data_query_failed';
  if (/invalid column/i.test(message)) errorClass = 'invalid_column';
  else if (/invalid table/i.test(message)) errorClass = 'invalid_table';
  else if (/invalid rpc/i.test(message)) errorClass = 'invalid_rpc';
  else if (/invalid identifier/i.test(message)) errorClass = 'invalid_identifier';
  else if (error?.code === '57014' || /timeout/i.test(message)) errorClass = 'query_timeout';
  else if (error?.code === '42501' || /row-level security/i.test(message)) errorClass = 'rls_denied';
  const tableRaw = String(ctx.table || '');
  const table = IDENT.test(tableRaw) ? tableRaw : '[rejected]';
  const selectShape = sanitizeLogText(ctx.select, 180);
  return { errorClass, table, selectShape, message };
};

export const logDataQueryFailure = (error, body = {}) => {
  const ctx = safeQueryLogContext(body);
  const classified = classifyDataQueryFailure(error, ctx);
  console.error(JSON.stringify({
    service: 'checksops-api',
    event: 'data_query_failed',
    errorClass: classified.errorClass,
    table: classified.table,
    selectShape: classified.selectShape,
    message: classified.message,
    requestId: ctx.requestId || null,
    route: ctx.route || null,
    status: classified.errorClass === 'rls_denied' ? 403 : 503,
  }));
  return classified;
};

export const DEFAULT_PAGE_LIMIT = 200;
export const MAX_PAGE_LIMIT = 500;

/**
 * Resolve SELECT LIMIT. null/undefined/''/NaN/0/negative use the default 200.
 * Number(null)===0 must not become LIMIT 1. Explicit 1..500 is honored; larger values clamp to 500.
 */
export const resolvePageLimit = (limit) => {
  if (limit === null || limit === undefined || limit === '') return DEFAULT_PAGE_LIMIT;
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_PAGE_LIMIT);
};

export const resolvePageOffset = (offset) => {
  if (offset === null || offset === undefined || offset === '') return 0;
  const n = Number(offset);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
};

export const parseBody = (event) => {
  if (!event?.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return {}; }
};

export const ignoredSpoof = (event, body) => {
  const headers = event?.headers || {};
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]));
  const query = event?.queryStringParameters || {};
  return {
    ignored: true,
    queryUserId: query.user_id || query.applicationUserId || query.sub || null,
    queryTenantId: query.tenant_id || query.tenantId || null,
    headerUserId: lower['x-user-id'] || lower['x-application-user-id'] || null,
    headerTenantId: lower['x-tenant-id'] || null,
    headerRole: lower['x-role'] || null,
    bodyUserId: body.user_id || body.applicationUserId || body.sub || null,
    bodyTenantId: body.tenant_id || body.tenantId || null,
    bodyRole: body.role || null,
  };
};

export const resolveClaims = async (event) => {
  let claims = cognitoClaimsFromEvent(event);
  if (!claims?.sub) {
    const token = bearerToken(event);
    if (!token) return { ok: false, statusCode: 401, error: 'missing_cognito_token' };
    try {
      claims = await verifyCognitoIdToken(token);
    } catch (error) {
      return { ok: false, statusCode: 401, error: 'invalid_cognito_token', message: String(error.message || error).slice(0, 200) };
    }
  }
  return { ok: true, claims };
};

export const withIdentity = async (event, fn, deps = {}) => {
  const claimsResult = await resolveClaims(event);
  if (!claimsResult.ok) return claimsResult;
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  const createClient = deps.createClient || ((config) => new Client(config));
  const write = deps.write === true;
  const commit = deps.commit === true;
  let client;
  let didCommit = false;
  try {
    const credentials = await loadCredentials();
    const config = write
      ? buildWriteClientConfig(credentials, { queryTimeoutMillis: 12000 })
      : buildClientConfig(credentials, { queryTimeoutMillis: 12000 });
    client = createClient(config);
    await client.connect();
    await client.query('BEGIN');
    if (write) {
      await client.query('SET TRANSACTION READ WRITE');
    }
    const mapping = (await client.query(LOOKUP_MAPPING_SQL, [claimsResult.claims.sub])).rows[0];
    if (!mapping) {
      await client.query('ROLLBACK');
      return { ok: false, statusCode: 401, error: 'identity_not_linked', spoofFieldsIgnored: spoof };
    }
    refuseSubAsApplicationId(mapping.application_user_id, claimsResult.claims.sub);
    await client.query('SELECT set_config($1, $2, true)', [APP_USER_ID_GUC, mapping.application_user_id]);
    await client.query('SELECT set_config($1, $2, true)', [APP_USER_EMAIL_GUC, mapping.email || claimsResult.claims.email || '']);
    const result = await fn({ client, mapping, claims: claimsResult.claims, body, spoof });
    const status = Number(result?.statusCode || (result?.ok === false ? 400 : 200));
    if (commit && result?.ok !== false && status < 400) {
      await client.query('COMMIT');
      didCommit = true;
    } else {
      await client.query('ROLLBACK');
    }
    return result;
  } catch (error) {
    if (client && !didCommit) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    const pgCode = error?.code || null;
    const rlsDenied = pgCode === '42501' || /row-level security/i.test(String(error?.message || ''));
    const classified = logDataQueryFailure(error, {
      table: typeof body?.table === 'string' ? body.table : undefined,
      select: typeof body?.select === 'string' ? body.select : undefined,
      requestId: event?.requestContext?.requestId
        || event?.headers?.['x-amzn-requestid']
        || event?.headers?.['x-request-id']
        || null,
      route: event?.rawPath || event?.requestContext?.http?.path || null,
    });
    return {
      ok: false,
      statusCode: rlsDenied ? 403 : 503,
      error: rlsDenied ? 'rls_denied' : 'data_query_failed',
      message: classified.message,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const withIdentityWrite = (event, fn, deps = {}) => (
  withIdentity(event, fn, { ...deps, write: true, commit: true })
);

export const parseSelect = (select) => {
  const raw = String(select || '*').trim() || '*';
  if (raw === '*') return { columns: ['*'], embeds: [] };
  return parseSelectList(raw);
};

/**
 * Derive parent FK column from PostgREST named-hint like
 * `shared_checks_source_tenant_id_fkey` → `source_tenant_id`.
 */
export const fkColumnFromHint = (parentTable, hint) => {
  if (!hint || hint === 'inner') return null;
  let rest = String(hint);
  if (rest.endsWith('_fkey')) rest = rest.slice(0, -5);
  const prefix = `${parentTable}_`;
  if (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rest) && rest.length > 0) return rest;
  return null;
};

export const embedColumnSql = (columns) => {
  if (!columns?.length || columns.includes('*')) return '*';
  return columns.map((c) => ident(c, 'column')).join(', ');
};

const TENANTS_PUBLIC_COLUMNS = new Set([
  'id', 'name', 'slug', 'logo_url', 'primary_color', 'secondary_color',
  'custom_domain', 'subscription_status', 'plan_tier', 'is_system_tenant', 'partner_code',
]);

/**
 * AWS RLS `aws_select_tenants` is membership-only. Partner names must come
 * from `tenants_public` (security_invoker=false), not base `tenants`.
 */
export const embedRelationTable = (embedTable, columns = []) => {
  if (embedTable !== 'tenants') return embedTable;
  const requested = (columns || []).filter((c) => c && c !== '*');
  if (!requested.length) return 'tenants';
  if (requested.every((c) => TENANTS_PUBLIC_COLUMNS.has(String(c).replace(/"/g, '')))) {
    return 'tenants_public';
  }
  return 'tenants';
};

export const relatedFk = (table, embedTable, fkHint = null) => {
  if (fkHint) return fkHint;
  if (embedTable === 'tenants' || embedTable === 'tenants_public') {
    if (table === 'claims') return 'org_id';
    return 'tenant_id';
  }
  if (embedTable === 'profiles') return 'user_id';
  // Live RDS: disbursement_splits.batch_id / deposit_items.batch_id, not *_batch_id.
  if (embedTable === 'disbursement_batches' || embedTable === 'deposit_batches') return 'batch_id';
  if (table === 'checkalt_deposits' && embedTable === 'check_intake_items') {
    return 'check_intake_item_id';
  }
  if (table === 'deposit_items' && embedTable === 'check_intake_items') {
    return 'check_id';
  }
  if (embedTable.endsWith('batches')) return `${embedTable.replace(/batches$/, 'batch')}_id`;
  if (embedTable.endsWith('s')) {
    const singular = embedTable.slice(0, -1);
    return `${singular}_id`;
  }
  return `${embedTable}_id`;
};

export const belongsToEmbed = (table, embedTable) => (
  embedTable === 'tenants'
  || embedTable === 'tenants_public'
  || embedTable === 'profiles'
  || embedTable === 'disbursement_batches'
  || embedTable === 'stakeholder_accounts'
  || embedTable === 'claims'
  || (table === 'checkalt_deposits' && embedTable === 'check_intake_items')
  || (table === 'deposit_items' && embedTable === 'check_intake_items')
);

const QUALIFIED_COLUMN = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/;

const PUBLIC_CONFIG_TABLES = {
  checkalt_config: 'checkalt_config_public',
  deposit_provider_config: 'deposit_provider_config_public',
};

export const IS_PLATFORM_OWNER_SQL = 'SELECT public.is_platform_owner() AS is_owner';

export const CHECKALT_AUTO_DEPOSIT_PUBLIC = 'checkalt_tenant_auto_deposit_public';
export const CHECKALT_AUTO_DEPOSIT_READ_COLUMNS = Object.freeze([
  'tenant_id',
  'auto_approve_enabled',
  'auto_approve_max_cents',
  'registered',
]);
/** Derived, non-secret registration flag. Never selected as registered_at. */
export const CHECKALT_AUTO_DEPOSIT_REGISTERED_EXPR = '(registered_at IS NOT NULL)';

export const autoDepositColumnSql = (column) => (
  column === 'registered'
    ? `${CHECKALT_AUTO_DEPOSIT_REGISTERED_EXPR} AS registered`
    : ident(column, 'column')
);

export const rewriteAutoDepositFilters = (filters = []) => {
  for (const filter of filters) {
    const op = String(filter.op || 'eq');
    if (op === 'or') throw new Error('invalid column');
    const col = String(filter.column || filter.col || '');
    if (!CHECKALT_AUTO_DEPOSIT_READ_COLUMNS.includes(col)) throw new Error('invalid column');
  }
  return filters.map((filter) => {
    const col = String(filter.column || filter.col || '');
    if (col !== 'registered') return filter;
    const op = String(filter.op || 'eq');
    const truthy = filter.value === true || filter.value === 'true' || filter.value === 't';
    const falsy = filter.value === false || filter.value === 'false' || filter.value === 'f';
    if ((op === 'eq' || op === 'is') && truthy) {
      return { column: 'registered_at', op: 'not', notOp: 'is', value: null };
    }
    if ((op === 'eq' || op === 'is') && falsy) {
      return { column: 'registered_at', op: 'is', value: null };
    }
    throw new Error('invalid column');
  });
};
export const CHECKALT_PLATFORM_OWNER_READ_TABLES = new Set([
  'checkalt_config',
  'checkalt_config_public',
  'checkalt_tenant_accounts',
]);

const requestedTableName = (table) => String(table || '').replace(/^public\./, '');

export const isCheckAltAutoDepositPublic = (table) => (
  requestedTableName(table) === CHECKALT_AUTO_DEPOSIT_PUBLIC
);

export const isCheckAltPlatformOwnerRead = (table) => (
  CHECKALT_PLATFORM_OWNER_READ_TABLES.has(requestedTableName(table))
);

/** Map secret-bearing config tables to tenant-safe public-column views. */
export const resolvePublicTable = (table) => PUBLIC_CONFIG_TABLES[table] || table;

export const splitEmbedFilters = (filters = []) => {
  const parent = [];
  const embed = [];
  for (const filter of filters) {
    const col = String(filter.column || filter.col || '');
    const match = col.match(QUALIFIED_COLUMN);
    if (match) {
      embed.push({ ...filter, embedTable: match[1], embedColumn: match[2] });
    } else {
      parent.push(filter);
    }
  }
  return { parent, embed };
};

export const applyEmbedFilters = (parentTable, embedFilters = [], params = []) => {
  const clauses = [];
  const parent = ident(parentTable, 'table');
  for (const filter of embedFilters) {
    const embedTable = ident(filter.embedTable, 'table');
    const fk = ident(relatedFk(parent, embedTable), 'column');
    const inner = applyAtomic(
      filter.embedColumn,
      String(filter.op || 'eq'),
      filter.value,
      params,
    );
    clauses.push(
      `EXISTS (SELECT 1 FROM public.${embedTable} WHERE ${embedTable}.id = ${parent}.${fk} AND ${inner})`,
    );
  }
  return clauses;
};

const CHECK_ID_CHILDREN = new Set([
  'check_payees',
  'check_messages',
  'check_endorsement_events',
  'check_eligibility_results',
  'check_audit_log',
  'check_payment_directions',
  'check_endorsements',
  'shared_checks',
  'aws_partner_check_payees',
  'aws_partner_check_endorsements',
]);

export const childFk = (parentTable, childTable) => {
  if (childTable === 'aws_partner_signature_signers' || childTable === 'signature_signers') {
    return 'signature_request_id';
  }
  if (parentTable === 'check_intake_items') {
    return CHECK_ID_CHILDREN.has(childTable) ? 'check_id' : 'check_intake_item_id';
  }
  if (parentTable.endsWith('s')) return `${parentTable.slice(0, -1)}_id`;
  return `${parentTable}_id`;
};

const splitTopLevel = (value, sep = ',') => {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of String(value || '')) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
};

const EMBED_HEAD_RE = /^(?:([a-zA-Z_][a-zA-Z0-9_]*):)?([a-zA-Z_][a-zA-Z0-9_]*)(?:!([a-zA-Z_][a-zA-Z0-9_]*))?$/;

const parseEmbedHead = (head) => {
  const m = String(head || '').trim().match(EMBED_HEAD_RE);
  if (!m) return null;
  const first = m[1] || null;
  const second = m[2];
  const bang = m[3] || null;
  // Supabase `relation:fk_column(...)` (e.g. check_intake_items:check_intake_item_id).
  if (!bang && first && /_id$/.test(second)) {
    return { alias: null, table: first, inner: false, fkHint: second };
  }
  return {
    alias: first,
    table: second,
    inner: bang === 'inner',
    fkHint: bang && bang !== 'inner' ? bang : null,
  };
};

const parseSelectList = (raw) => {
  const columns = [];
  const embeds = [];
  for (const part of splitTopLevel(raw)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const open = trimmed.indexOf('(');
    if (open !== -1 && trimmed.endsWith(')')) {
      const head = parseEmbedHead(trimmed.slice(0, open).trim());
      if (head) {
        const inner = parseSelectList(trimmed.slice(open + 1, -1).trim() || '*');
        embeds.push({
          table: head.table,
          alias: head.alias,
          inner: head.inner,
          fkHint: head.fkHint,
          columns: inner.columns,
          embeds: inner.embeds,
        });
        continue;
      }
    }
    columns.push(trimmed === '*' ? '*' : ident(trimmed, 'column'));
  }
  if (!columns.length) columns.push('*');
  return { columns, embeds };
};

const applyAtomic = (column, op, rawValue, params) => {
  const col = ident(column, 'column');
  if (op === 'is') {
    const value = String(rawValue).toLowerCase();
    if (value === 'null') return `${col} IS NULL`;
    if (value === 'true') return `${col} IS TRUE`;
    if (value === 'false') return `${col} IS FALSE`;
  }
  if (op === 'in') {
    const inner = String(rawValue).replace(/^\(/, '').replace(/\)$/, '');
    const values = splitTopLevel(inner).map((item) => item.replace(/^"+|"+$/g, ''));
    if (!values.length) return 'FALSE';
    const placeholders = values.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `${col} IN (${placeholders.join(', ')})`;
  }
  params.push(rawValue);
  const placeholder = `$${params.length}`;
  if (op === 'eq') return `${col} = ${placeholder}`;
  if (op === 'neq') return `${col} <> ${placeholder}`;
  if (op === 'gt') return `${col} > ${placeholder}`;
  if (op === 'gte') return `${col} >= ${placeholder}`;
  if (op === 'lte') return `${col} <= ${placeholder}`;
  if (op === 'lt') return `${col} < ${placeholder}`;
  if (op === 'like') return `${col} LIKE ${placeholder}`;
  if (op === 'ilike') return `${col} ILIKE ${placeholder}`;
  throw new Error(`unsupported filter ${op}`);
};

export const parseOrExpr = (expr, params) => {
  const parseTerm = (term) => {
    const trimmed = String(term || '').trim();
    if (trimmed.startsWith('and(') && trimmed.endsWith(')')) {
      return `(${splitTopLevel(trimmed.slice(4, -1)).map(parseTerm).join(' AND ')})`;
    }
    if (trimmed.startsWith('or(') && trimmed.endsWith(')')) {
      return `(${splitTopLevel(trimmed.slice(3, -1)).map(parseTerm).join(' OR ')})`;
    }
    const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.*)$/);
    if (!match) throw new Error(`unsupported or term ${trimmed.slice(0, 80)}`);
    return applyAtomic(match[1], match[2], match[3], params);
  };
  const terms = splitTopLevel(expr).map(parseTerm);
  return terms.length ? `(${terms.join(' OR ')})` : 'TRUE';
};

export const applyFilters = (filters = []) => {
  const clauses = [];
  const params = [];
  for (const filter of filters) {
    const op = String(filter.op || 'eq');
    if (op === 'or') {
      clauses.push(parseOrExpr(filter.value, params));
      continue;
    }
    if (op === 'not') {
      const notOp = String(filter.notOp || 'eq');
      if (notOp === 'is' && (filter.value === null || String(filter.value).toLowerCase() === 'null')) {
        clauses.push(`${ident(filter.column, 'column')} IS NOT NULL`);
        continue;
      }
      if (notOp === 'in') {
        const values = Array.isArray(filter.value)
          ? filter.value
          : splitTopLevel(String(filter.value).replace(/^\(/, '').replace(/\)$/, '').replace(/"/g, ''));
        if (!values.length) continue;
        const placeholders = values.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        clauses.push(`${ident(filter.column, 'column')} NOT IN (${placeholders.join(', ')})`);
        continue;
      }
      params.push(filter.value);
      clauses.push(`${ident(filter.column, 'column')} <> $${params.length}`);
      continue;
    }
    const col = ident(filter.column || filter.col, 'column');
    if (op === 'eq') {
      params.push(filter.value);
      clauses.push(`${col} = $${params.length}`);
    } else if (op === 'neq') {
      params.push(filter.value);
      clauses.push(`${col} <> $${params.length}`);
    } else if (op === 'gt') {
      params.push(filter.value);
      clauses.push(`${col} > $${params.length}`);
    } else if (op === 'gte') {
      params.push(filter.value);
      clauses.push(`${col} >= $${params.length}`);
    } else if (op === 'lt') {
      params.push(filter.value);
      clauses.push(`${col} < $${params.length}`);
    } else if (op === 'lte') {
      params.push(filter.value);
      clauses.push(`${col} <= $${params.length}`);
    } else if (op === 'like') {
      params.push(filter.value);
      clauses.push(`${col} LIKE $${params.length}`);
    } else if (op === 'ilike') {
      params.push(filter.value);
      clauses.push(`${col} ILIKE $${params.length}`);
    } else if (op === 'is') {
      if (filter.value === null || filter.value === 'null') clauses.push(`${col} IS NULL`);
      else if (filter.value === true || filter.value === 'true') clauses.push(`${col} IS TRUE`);
      else if (filter.value === false || filter.value === 'false') clauses.push(`${col} IS FALSE`);
    } else if (op === 'in') {
      const values = Array.isArray(filter.value) ? filter.value : [];
      if (!values.length) {
        clauses.push('FALSE');
        continue;
      }
      const placeholders = values.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      clauses.push(`${col} IN (${placeholders.join(', ')})`);
    } else {
      throw new Error(`unsupported filter ${op}`);
    }
  }
  return { clauses, params };
};

const columnsNeededForEmbeds = (parentTable, columns, embeds) => {
  const needed = new Set(columns[0] === '*' ? ['*'] : columns);
  if (needed.has('*')) return needed;
  needed.add('id');
  for (const embed of embeds || []) {
    // Parent-side FKs for belongs-to embeds (tenants, profiles) and named-FK hints.
    // Has-many embeds such as check_payees / checkalt_deposits live on the
    // child row (check_intake_item_id). Guessing check_payee_id onto the
    // parent SELECT makes PostgreSQL fail before the child-array path runs.
    const namedFk = fkColumnFromHint(parentTable, embed.fkHint);
    if (namedFk || belongsToEmbed(parentTable, embed.table)) {
      needed.add(namedFk || relatedFk(parentTable, embed.table));
    }
  }
  return needed;
};

const attachEmbeds = async (client, rows, parentTable, embeds) => {
  if (!embeds?.length || !rows?.length) return rows;
  let current = rows;
  for (const embed of embeds) {
    const relTable = ident(embedRelationTable(embed.table, embed.columns), 'table');
    if (!ALLOWED.has(relTable) && relTable !== 'tenants') continue;
    const namedFk = fkColumnFromHint(parentTable, embed.fkHint);
    const fk = relatedFk(parentTable, relTable, namedFk);
    // Keep the requested PostgREST relation/alias even when the query
    // internally rewrites tenants → tenants_public.
    const resultKey = embed.alias || embed.table;
    const parentHasFk = current.some((row) => Object.prototype.hasOwnProperty.call(row, fk));
    const nestedNeeded = columnsNeededForEmbeds(relTable, embed.columns, embed.embeds);
    if (parentHasFk) {
      const ids = [...new Set(current.map((row) => row[fk]).filter(Boolean))];
      if (!ids.length) {
        const next = [];
        for (const row of current) {
          if (embed.inner) continue;
          next.push({ ...row, [resultKey]: null });
        }
        current = next;
        continue;
      }
      const embedCols = nestedNeeded.has('*')
        ? '*'
        : [...nestedNeeded].map((c) => ident(c, 'column')).join(', ');
      const related = (await client.query(
        `SELECT ${embedCols} FROM public.${relTable} WHERE id = ANY($1::uuid[])`,
        [ids],
      )).rows;
      const nested = await attachEmbeds(client, related, relTable, embed.embeds || []);
      const byId = new Map(nested.map((row) => [String(row.id), row]));
      const next = [];
      for (const row of current) {
        const relatedRow = byId.get(String(row[fk]));
        if (embed.inner && !relatedRow) continue;
        next.push({ ...row, [resultKey]: relatedRow || null });
      }
      current = next;
    } else {
      const parentIds = [...new Set(current.map((row) => row.id).filter(Boolean))];
      const childKey = childFk(parentTable, relTable);
      if (!parentIds.length) {
        for (const row of current) row[resultKey] = [];
        continue;
      }
      if (!nestedNeeded.has('*')) nestedNeeded.add(childKey);
      const embedCols = nestedNeeded.has('*')
        ? '*'
        : [...nestedNeeded].map((c) => ident(c, 'column')).join(', ');
      const related = (await client.query(
        `SELECT ${embedCols} FROM public.${relTable} WHERE ${ident(childKey, 'column')} = ANY($1::uuid[])`,
        [parentIds],
      )).rows;
      const nested = await attachEmbeds(client, related, relTable, embed.embeds || []);
      const byParent = new Map();
      for (const item of nested) {
        const key = String(item[childKey]);
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(item);
      }
      const next = [];
      for (const row of current) {
        const children = byParent.get(String(row.id)) || [];
        if (embed.inner && !children.length) continue;
        next.push({ ...row, [resultKey]: children });
      }
      current = next;
    }
  }
  return current;
};

const runSelect = async (client, body) => {
  const requested = ident(body.table, 'table');
  const autoDeposit = requested === CHECKALT_AUTO_DEPOSIT_PUBLIC;
  const table = ident(autoDeposit ? 'checkalt_tenant_accounts' : resolvePublicTable(body.table), 'table');
  if (!ALLOWED.has(requested) && !ALLOWED.has(table)) throw new Error(`table not allowlisted: ${table}`);
  if (autoDeposit && body.order?.column && !CHECKALT_AUTO_DEPOSIT_READ_COLUMNS.includes(body.order.column)) {
    throw new Error('invalid column');
  }
  const parsed = parseSelect(autoDeposit ? CHECKALT_AUTO_DEPOSIT_READ_COLUMNS.join(', ') : body.select);
  const { parent: parentFilters, embed: embedFilters } = splitEmbedFilters(body.filters || []);
  if (autoDeposit && embedFilters.length) throw new Error('embeds_not_allowed');
  const { clauses, params } = applyFilters(autoDeposit ? rewriteAutoDepositFilters(parentFilters) : parentFilters);
  clauses.push(...applyEmbedFilters(table, embedFilters, params));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  let order = '';
  if (body.order?.column) {
    const dir = body.order.ascending === false ? 'DESC' : 'ASC';
    const orderCol = autoDeposit && body.order.column === 'registered'
      ? CHECKALT_AUTO_DEPOSIT_REGISTERED_EXPR
      : ident(body.order.column, 'column');
    order = `ORDER BY ${orderCol} ${dir}`;
  }
  const limit = resolvePageLimit(body.limit);
  const offset = resolvePageOffset(body.offset);
  const needed = autoDeposit
    ? new Set(CHECKALT_AUTO_DEPOSIT_READ_COLUMNS)
    : columnsNeededForEmbeds(table, parsed.columns, parsed.embeds);
  const cols = needed.has('*')
    ? '*'
    : [...needed].map((c) => (autoDeposit ? autoDepositColumnSql(c) : ident(c, 'column'))).join(', ');
  const countSql = `SELECT count(*)::int AS n FROM public.${table} ${where}`;
  const count = body.count ? Number((await client.query(countSql, params)).rows[0]?.n || 0) : null;
  if (body.head) {
    return { rows: [], count };
  }
  const sql = `SELECT ${cols} FROM public.${table} ${where} ${order} LIMIT ${limit} OFFSET ${offset}`;
  const rows = (await client.query(sql, params)).rows;
  const attached = await attachEmbeds(client, rows, table, parsed.embeds);
  return { rows: attached, count };
};

export const unwrapRpcData = (name, rows) => {
  if (RPC_UNWRAP_SINGLE_COLUMN.has(name)) {
    if (!rows.length) return null;
    const row = rows[0];
    const keys = Object.keys(row);
    if (keys.length === 1) return row[keys[0]];
    return row;
  }
  return rows;
};

const publicTenantsQuery = async (event, deps = {}) => {
  const body = parseBody(event);
  const spoof = ignoredSpoof(event, body);
  if (ident(body.table, 'table') !== 'tenants_public') {
    return { ok: false, statusCode: 401, error: 'missing_cognito_token', spoofFieldsIgnored: spoof };
  }
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  const createClient = deps.createClient || ((config) => new Client(config));
  let client;
  try {
    const credentials = await loadCredentials();
    client = createClient(buildClientConfig(credentials, { queryTimeoutMillis: 8000 }));
    await client.connect();
    await client.query('BEGIN');
    const { rows, count } = await runSelect(client, { ...body, table: 'tenants_public', op: 'select' });
    await client.query('ROLLBACK');
    let data = rows;
    if (body.maybeSingle) data = rows[0] || null;
    if (body.single) data = rows[0] || null;
    return {
      ok: true,
      statusCode: 200,
      data,
      count,
      applicationUserId: null,
      authorizationSource: 'public_tenants_view',
      spoofFieldsIgnored: spoof,
    };
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    return { ok: false, statusCode: 503, error: 'data_query_failed', message: sanitizePublicError(error) };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

export const handleDataQuery = async (event, deps) => {
  const claims = cognitoClaimsFromEvent(event);
  const token = bearerToken(event);
  const body = parseBody(event);
  if (!claims?.sub && !token && (body.table === 'tenants_public') && (body.op || 'select') === 'select') {
    return publicTenantsQuery(event, deps);
  }
  return withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
  if ((body.op || 'select') !== 'select') {
    return {
      ok: false,
      statusCode: 403,
      error: 'writes_disabled',
      message: 'Staging application writes are disabled (default_transaction_read_only=on)',
      spoofFieldsIgnored: spoof,
    };
  }
  const rawTable = String(body.table || '');
  const rawSelect = body.select == null ? '*' : String(body.select);
  const earlyDeny = denyTaxSecretQuery(rawTable, null, rawSelect, body.filters);
  if (earlyDeny.denied) {
    return {
      ok: false,
      statusCode: 403,
      error: earlyDeny.error,
      message: earlyDeny.message,
      table: earlyDeny.table,
      spoofFieldsIgnored: spoof,
    };
  }
  let parsedSelect = { columns: [], embeds: [] };
  try {
    parsedSelect = parseSelect(body.select);
  } catch {
    parsedSelect = { columns: [], embeds: [] };
  }
  const secretDeny = denyTaxSecretQuery(rawTable, parsedSelect, rawSelect, body.filters);
  if (secretDeny.denied) {
    return {
      ok: false,
      statusCode: 403,
      error: secretDeny.error,
      message: secretDeny.message,
      table: secretDeny.table,
      spoofFieldsIgnored: spoof,
    };
  }
  if (isCheckAltPlatformOwnerRead(rawTable)) {
    const owner = (await client.query(IS_PLATFORM_OWNER_SQL)).rows[0];
    if (!owner?.is_owner) {
      return {
        ok: false,
        statusCode: 403,
        error: 'not_authorized',
        message: 'Platform owner required for CheckAlt configuration',
        table: requestedTableName(rawTable),
        spoofFieldsIgnored: spoof,
      };
    }
  }
  const { rows, count } = await runSelect(client, body);
  let data = rows;
  if (body.single) {
    if (rows.length !== 1) {
      return { ok: false, statusCode: 406, error: 'not_single', data: null, count, spoofFieldsIgnored: spoof };
    }
    data = rows[0];
  } else if (body.maybeSingle) {
    if (rows.length > 1) {
      return { ok: false, statusCode: 406, error: 'not_single', data: null, count, spoofFieldsIgnored: spoof };
    }
    data = rows[0] || null;
  }
  return {
    ok: true,
    statusCode: 200,
    data,
    count,
    applicationUserId: mapping.application_user_id,
    authUid: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
    authorizationSource: 'rls',
  };
}, deps);
};

export const handleDataRpc = async (event, deps) => {
  const earlyBody = parseBody(event);
  const earlyRpcName = earlyBody.name || earlyBody.rpc;
  const taxRpcDeny = denyTaxSecretRpc(earlyRpcName, earlyBody.args);
  if (taxRpcDeny.denied) {
    return withIdentity(event, async ({ spoof }) => ({
      ok: false,
      statusCode: 403,
      error: taxRpcDeny.error,
      message: taxRpcDeny.message,
      spoofFieldsIgnored: spoof,
    }), deps);
  }
  let earlyName = '';
  try {
    earlyName = ident(earlyRpcName, 'rpc');
  } catch {
    earlyName = '';
  }
  if (earlyName) {
    const { PARTNER_SHARE_RPCS, handlePartnerShareRpc } = await import('./partner-share-lifecycle.mjs');
    if (PARTNER_SHARE_RPCS.has(earlyName)) {
      return handlePartnerShareRpc(event, deps);
    }
    const { SAFE_WRITE_RPCS, handleSafeWriteRpc } = await import('./workflow-rpc.mjs');
    if (SAFE_WRITE_RPCS.has(earlyName)) {
      return handleSafeWriteRpc(event, deps);
    }
  }
  return withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
  const rpcDeny = denyTaxSecretRpc(body.name || body.rpc, body.args);
  if (rpcDeny.denied) {
    return {
      ok: false,
      statusCode: 403,
      error: rpcDeny.error,
      message: rpcDeny.message,
      spoofFieldsIgnored: spoof,
    };
  }
  const name = ident(body.name || body.rpc, 'rpc');
  if (!READ_RPCS.has(name)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'rpc_disabled',
      message: 'This RPC is not enabled for AWS staging reads, or it is a write/provider operation',
      name,
      spoofFieldsIgnored: spoof,
      classification: 'disabled',
    };
  }
  const args = body.args && typeof body.args === 'object' ? body.args : {};
  const keys = Object.keys(args);
  const params = [];
  const placeholders = keys.map((key, index) => {
    ident(key, 'arg');
    params.push(args[key]);
    return `${key} := $${index + 1}`;
  });
  const sql = placeholders.length
    ? `SELECT * FROM public.${name}(${placeholders.join(', ')})`
    : `SELECT * FROM public.${name}()`;
  const rows = (await client.query(sql, params)).rows;
  return {
    ok: true,
    statusCode: 200,
    data: unwrapRpcData(name, rows),
    applicationUserId: mapping.application_user_id,
    cognitoSub: claims.sub,
    spoofFieldsIgnored: spoof,
  };
}, deps);
};

export const handleWritesDisabled = async (event) => {
  const body = parseBody(event);
  return {
    ok: false,
    statusCode: 403,
    error: 'writes_disabled',
    message: 'Staging application writes are disabled',
    spoofFieldsIgnored: ignoredSpoof(event, body),
  };
};

export const handleStorageStub = async () => ({
  ok: false,
  statusCode: 501,
  error: 's3_migration_required',
  message: 'Production Storage is not migrated. Staging returns an S3 abstraction stub only.',
  buckets: [
    'claim-files',
    'deposit-attachments',
    'loss-draft-documents',
    'company-branding',
    'tenant-logos',
    'endorsement-packets',
    'homeowner-uploads',
  ],
});

export const handleFunctionsDisabled = async (event) => {
  const body = parseBody(event);
  return {
    ok: false,
    statusCode: 403,
    error: 'provider_disabled',
    message: 'Moov, CheckAlt, Plaid, Resend, and other provider functions are disabled on AWS staging',
    name: body.name || null,
  };
};
