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
]);

const RPC_UNWRAP_SINGLE_COLUMN = new Set([
  'has_permission',
  'is_checkalt_enabled_for_tenant',
  'get_check_dashboard_counts_for_tenant',
  'get_total_unread_check_messages',
  'get_loss_draft_dashboard_counts_for_tenant',
  'get_tenant_funds_received',
  'get_tenant_check_usage',
  'get_deposit_ops_kpis',
  'get_deposit_exception_kpis',
  'contractor_verification_status',
  'get_check_claim_settlement',
  'lookup_tenant_by_partner_code',
]);

export const ident = (name, kind = 'identifier') => {
  const value = String(name || '').replace(/^public\./, '');
  if (!IDENT.test(value)) throw new Error(`invalid ${kind}`);
  return value;
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
    return {
      ok: false,
      statusCode: rlsDenied ? 403 : 503,
      error: rlsDenied ? 'rls_denied' : 'data_query_failed',
      message: sanitizePublicError(error),
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
  const embeds = [];
  const columns = [];
  // Supports:
  //   table(cols)
  //   table!inner(cols)
  //   table!<fk_or_hint>(cols)
  //   alias:table!...(cols)
  const re = /(?:([a-zA-Z_][a-zA-Z0-9_]*):)?([a-zA-Z_][a-zA-Z0-9_]*)(?:!([a-zA-Z_][a-zA-Z0-9_]*))?\(([^)]*)\)/g;
  let remainder = raw;
  let match;
  while ((match = re.exec(raw))) {
    const alias = match[1] || null;
    const table = match[2];
    const hint = match[3] || null;
    const inner = hint === 'inner';
    const fkHint = hint && hint !== 'inner' ? hint : null;
    embeds.push({
      table,
      alias,
      inner,
      fkHint,
      columns: match[4].split(',').map((c) => c.trim()).filter(Boolean),
    });
    remainder = remainder.replace(match[0], '');
  }
  remainder.split(',').map((c) => c.trim()).filter(Boolean).forEach((col) => columns.push(col === '*' ? '*' : ident(col, 'column')));
  if (!columns.length) columns.push('*');
  return { columns, embeds };
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

export const relatedFk = (table, embedTable, fkHint = null) => {
  if (fkHint) return fkHint;
  if (embedTable === 'tenants' || embedTable === 'tenants_public') {
    if (table === 'claims') return 'org_id';
    return 'tenant_id';
  }
  if (embedTable === 'profiles') return 'user_id';
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
);

const CHECK_ID_CHILDREN = new Set([
  'check_payees',
  'check_messages',
  'check_endorsement_events',
  'check_eligibility_results',
  'check_audit_log',
  'check_payment_directions',
  'check_endorsements',
  'shared_checks',
]);

export const childFk = (parentTable, childTable) => {
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

const runSelect = async (client, body) => {
  const table = ident(body.table, 'table');
  if (!ALLOWED.has(table)) throw new Error(`table not allowlisted: ${table}`);
  const parsed = parseSelect(body.select);
  const { clauses, params } = applyFilters(body.filters || []);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  let order = '';
  if (body.order?.column) {
    const dir = body.order.ascending === false ? 'DESC' : 'ASC';
    order = `ORDER BY ${ident(body.order.column, 'column')} ${dir}`;
  }
  const limit = Number.isFinite(Number(body.limit)) ? Math.min(Math.max(Number(body.limit), 1), 500) : 200;
  const offset = Number.isFinite(Number(body.offset)) ? Math.max(Number(body.offset), 0) : 0;
  const needed = new Set(parsed.columns[0] === '*' ? ['*'] : parsed.columns);
  if (needed.has('*') === false) {
    needed.add('id');
    for (const embed of parsed.embeds) {
      // Parent-side FKs for belongs-to embeds (tenants, profiles) and named-FK hints.
      // Has-many embeds such as check_payees / checkalt_deposits live on the
      // child row (check_intake_item_id). Guessing check_payee_id onto the
      // parent SELECT makes PostgreSQL fail before the child-array path runs.
      const namedFk = fkColumnFromHint(table, embed.fkHint);
      if (namedFk || belongsToEmbed(table, embed.table)) {
        needed.add(namedFk || relatedFk(table, embed.table));
      }
    }
  }
  const cols = needed.has('*') ? '*' : [...needed].map((c) => ident(c, 'column')).join(', ');
  const countSql = `SELECT count(*)::int AS n FROM public.${table} ${where}`;
  const count = body.count ? Number((await client.query(countSql, params)).rows[0]?.n || 0) : null;
  if (body.head) {
    return { rows: [], count };
  }
  const sql = `SELECT ${cols} FROM public.${table} ${where} ${order} LIMIT ${limit} OFFSET ${offset}`;
  const rows = (await client.query(sql, params)).rows;
  if (!parsed.embeds.length) return { rows, count };
  for (const embed of parsed.embeds) {
    const relTable = ident(embed.table, 'table');
    if (!ALLOWED.has(relTable) && relTable !== 'tenants') continue;
    const namedFk = fkColumnFromHint(table, embed.fkHint);
    const fk = relatedFk(table, relTable, namedFk);
    const resultKey = embed.alias || relTable;
    const parentHasFk = rows.some((row) => Object.prototype.hasOwnProperty.call(row, fk));
    const embedCols = embedColumnSql(embed.columns);
    if (parentHasFk) {
      const ids = [...new Set(rows.map((row) => row[fk]).filter(Boolean))];
      if (!ids.length) {
        const next = [];
        for (const row of rows) {
          if (embed.inner) continue;
          next.push({ ...row, [resultKey]: null });
        }
        rows.length = 0;
        rows.push(...next);
        continue;
      }
      const related = (await client.query(
        `SELECT ${embedCols.includes('*') ? '*' : `${embedCols}, id`} FROM public.${relTable} WHERE id = ANY($1::uuid[])`,
        [ids],
      )).rows;
      const byId = new Map(related.map((row) => [String(row.id), row]));
      const next = [];
      for (const row of rows) {
        const relatedRow = byId.get(String(row[fk]));
        if (embed.inner && !relatedRow) continue;
        next.push({ ...row, [resultKey]: relatedRow || null });
      }
      rows.length = 0;
      rows.push(...next);
    } else {
      const parentIds = [...new Set(rows.map((row) => row.id).filter(Boolean))];
      const childKey = childFk(table, relTable);
      if (!parentIds.length) {
        for (const row of rows) row[resultKey] = [];
        continue;
      }
      const related = (await client.query(
        `SELECT ${embedCols.includes('*') ? '*' : `${embedCols}, ${ident(childKey, 'column')}`} FROM public.${relTable} WHERE ${ident(childKey, 'column')} = ANY($1::uuid[])`,
        [parentIds],
      )).rows;
      const byParent = new Map();
      for (const item of related) {
        const key = String(item[childKey]);
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(item);
      }
      const next = [];
      for (const row of rows) {
        const children = byParent.get(String(row.id)) || [];
        if (embed.inner && !children.length) continue;
        next.push({ ...row, [resultKey]: children });
      }
      rows.length = 0;
      rows.push(...next);
    }
  }
  return { rows, count };
};

const unwrapRpcData = (name, rows) => {
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

export const handleDataRpc = async (event, deps) => withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
  const name = ident(body.name || body.rpc, 'rpc');
  if (!READ_RPCS.has(name)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'rpc_disabled',
      message: 'This RPC is not enabled for AWS staging reads, or it is a write/provider operation',
      name,
      spoofFieldsIgnored: spoof,
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
