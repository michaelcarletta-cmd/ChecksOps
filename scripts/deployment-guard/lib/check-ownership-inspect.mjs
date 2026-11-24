/**
 * Read-only production inspect of check ownership (inspect only; there is no apply). Owner
 * report 2026-11-24: on an old check (uploaded in the Lovable / Supabase era), editing the
 * endorsements or generating the deposit image fails with "check not found or not writable";
 * the check is not partner-shared. "Count the old checks."
 *
 * Writes to a check require public.aws_can_write_tenant(tenant_id) (SQL 90: the caller has a
 * public.tenant_users row for the check's tenant; aws_write_check_intake_items, aws/rls/sql/
 * 21_proposed_write_policies.sql). This inspect counts, over every check, whether its
 * ownership lets its own uploader write it: tenant_id NULL, tenant_id not in public.tenants,
 * uploaded_by NULL, or uploaded_by without a tenant_users row in the check's tenant. The
 * membership predicate is TENANT_MEMBER_SQL (aws/functions/api/workflow-transitions.mjs,
 * workflow-rpc.mjs) and aws_is_tenant_member (SQL 90): tenant_users.user_id = the user AND
 * tenant_users.tenant_id = the tenant; the role column is ignored.
 *
 * It also counts the storage scope of the image paths, because the deposit image is uploaded
 * next to the original back image (src/components/checks/EndorsementAdjuster.tsx: the folder of
 * originalImagePath) and the storage write gate (aws/functions/api/storage-write-auth.mjs,
 * authorizeStorageWritePath) takes the check id from the path's checks/<uuid>/ segment
 * (storage-paths.mjs CHECK_WRITE_PREFIXES). The Supabase-era upload prefix was
 * checks/<user id>/<claim dir> (src/pages/CheckCommandCenter.tsx), so that uuid is the
 * uploader, not the check, and the gate's SELECT finds no check: "check not found or not
 * writable". path_class says, per image column, which uuid the scoped segment names.
 *
 * One transaction: BEGIN READ ONLY, search_path pg_catalog, statement and lock timeouts,
 * TimeZone UTC (for the created month), then the fixed SELECTs in Q, then ROLLBACK. Nothing else
 * is ever sent: there is no SQL argument and every statement text is a constant of this file.
 *
 * Output: counts only, grouped by code labels, booleans and a YYYY-MM month. No id, name,
 * email, amount, check number or image path is ever returned by a statement: ids and paths are
 * used only inside predicates. Labels (status, check_stage) are printed only when they look like
 * a code label; anything else is 'other'.
 *
 * A failure (connecting included) reports the stage and the error's code / SQLSTATE only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';
import { safeErrorCode } from './mortgage-desk-access-inspect.mjs';

export { safeErrorCode };

export const INSPECT_ID = 'check-ownership-inspect';
export const CONFIG_REL = 'ops/deployment-guard/check-ownership-inspect.json';

/** How a check's ownership relates to its uploader, in the order they are decided. */
export const OWNERSHIP_CLASSES = Object.freeze({
  tenant_null: 'tenant_id is NULL: aws_can_write_tenant(NULL) is false for every caller',
  tenant_missing: 'tenant_id names no row of public.tenants',
  uploader_null: 'tenant_id is a tenant, uploaded_by is NULL (no uploader to judge)',
  uploader_not_member: 'tenant_id is a tenant, the uploader has no tenant_users row in it',
  uploader_member: 'tenant_id is a tenant and the uploader is a tenant_users member of it',
});
/** The classes in which the check's own uploader cannot write it. */
export const UPLOADER_CANNOT_WRITE = Object.freeze(['tenant_null', 'tenant_missing', 'uploader_not_member']);
/** The uploader's number of distinct tenant_users tenants. */
export const UPLOADER_TENANTS = Object.freeze(['uploader_null', 'none', 'one', 'several']);
/** How the check's claim (claim_id) relates to the check's tenant. */
export const CLAIM_CLASSES = Object.freeze(['no_claim', 'claim_missing', 'claim_org_null', 'claim_org_equal', 'claim_org_differs']);
/** The image columns whose storage scope is counted; adjuster_source is the Endorsement Adjuster's source path. */
export const IMAGE_COLUMNS = Object.freeze(['front_image_path', 'back_image_path', 'back_image_original_path', 'adjuster_source']);
/** Which uuid a path's check-scoped segment (storage-paths.mjs CHECK_WRITE_PREFIXES) names. */
export const PATH_CLASSES = Object.freeze({
  empty: 'no path',
  check_scoped_self: 'checks/<this check>/ (or check-intake/<id>/files/, checks/reupload/<id>/): writable scope',
  check_scoped_uploader: 'checks/<the uploader>/: the Supabase-era prefix; the storage gate looks up a check with the user id and finds none',
  check_scoped_tenant: 'checks/<the check tenant>/: the storage gate looks up a check with the tenant id and finds none',
  check_scoped_other_check: 'checks/<another check>/: the storage gate authorizes against that other check',
  check_scoped_other_uuid: 'checks/<another uuid>/: no check has that id',
  not_check_scoped: 'no check-scoped segment: only an existing object path match can authorize it, a new file is refused',
  url_not_parsed: 'an http(s) URL that is not a claim-files storage URL',
});

// storage-paths.mjs CHECK_UUID_RE and CHECK_WRITE_PREFIXES, in the same order (first match wins).
const CHECK_UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

/**
 * storage-paths.mjs normalizePath(value, 'claim-files') for the forms stored on checks: trimmed;
 * an http(s) URL reduced to the object path after /storage/v1/object/[sign/|public/]claim-files/
 * (NULL when it is not one); otherwise a leading claim-files/ and leading slashes removed; empty
 * and '.' segments dropped. URL-decoding is not done (it does not change a uuid segment).
 */
export const relPathSql = (expr) => `CASE
      WHEN pg_catalog.btrim(${expr}) ~* '^https?://'
        THEN pg_catalog.substring(pg_catalog.btrim(${expr}), '/storage/v1/object/(?:sign/|public/)?claim-files/(.+)$')
      ELSE pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(pg_catalog.btrim(${expr}), '^claim-files/', ''), '(^|/)(\\./)+', '\\1', 'g'), '/{2,}', '/', 'g'), '/')
    END`;
/** storage-paths.mjs matchCheckScopedPath on a normalized path: the scoped uuid, lower case, or NULL. */
export const scopedUuidSql = (rel) => `COALESCE(
      pg_catalog.substring(pg_catalog.lower(${rel}), '^check-intake/(${CHECK_UUID_RE})/files/'),
      pg_catalog.substring(pg_catalog.lower(${rel}), '^checks/reupload/(${CHECK_UUID_RE})/'),
      pg_catalog.substring(pg_catalog.lower(${rel}), '^checks/(${CHECK_UUID_RE})/'))`;

// TENANT_MEMBER_SQL / aws_is_tenant_member: a tenant_users row for (user, tenant); role ignored.
const member = (user, tenant) => `EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.user_id = ${user} AND tu.tenant_id = ${tenant})`;

/** Every check, with its ownership class and its uploader's number of tenants. Reads only id, tenant_id, uploaded_by, deposited_at. */
const BASE = `base AS (
    SELECT c.id, c.tenant_id, c.uploaded_by, (c.deposited_at IS NOT NULL) AS deposited,
      CASE
        WHEN c.tenant_id IS NULL THEN 'tenant_null'
        WHEN NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = c.tenant_id) THEN 'tenant_missing'
        WHEN c.uploaded_by IS NULL THEN 'uploader_null'
        WHEN ${member('c.uploaded_by', 'c.tenant_id')} THEN 'uploader_member'
        ELSE 'uploader_not_member'
      END AS ownership,
      CASE WHEN c.uploaded_by IS NULL THEN 'uploader_null'
        ELSE (SELECT CASE count(DISTINCT m.tenant_id) WHEN 0 THEN 'none' WHEN 1 THEN 'one' ELSE 'several' END
              FROM public.tenant_users m WHERE m.user_id = c.uploaded_by)
      END AS uploader_tenants
    FROM public.check_intake_items c)`;
const CANNOT = UPLOADER_CANNOT_WRITE.map((k) => `'${k}'`).join(', ');

export const Q = Object.freeze({
  begin: 'BEGIN READ ONLY',
  searchPath: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
  statementTimeout: "SELECT pg_catalog.set_config('statement_timeout', '20000', true)",
  lockTimeout: "SELECT pg_catalog.set_config('lock_timeout', '2000', true)",
  timeZone: "SELECT pg_catalog.set_config('TimeZone', 'UTC', true)",
  session: `SELECT current_user::text AS current_user, session_user::text AS session_user,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('server_version_num')::int AS server_version_num`,
  columns: `SELECT c.relname::text AS table_name, a.attname::text AS column_name
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY 1, a.attnum`,
  // Whether row-level security filters what this login reads (true would make the counts partial).
  rowSecurity: `SELECT c.relname::text AS table_name, pg_catalog.row_security_active(c.oid) AS row_security_active
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])
  ORDER BY 1`,
  ownership: `WITH ${BASE}
  SELECT b.ownership, b.uploader_tenants, b.deposited, count(*)::int AS checks
  FROM base b GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  affected: `WITH ${BASE}
  SELECT count(DISTINCT b.tenant_id)::int AS tenants_with_checks,
  count(DISTINCT b.tenant_id) FILTER (WHERE b.ownership = 'tenant_missing')::int AS missing_tenants,
  count(DISTINCT b.tenant_id) FILTER (WHERE b.ownership = 'uploader_not_member')::int AS tenants_with_uploader_not_member,
  count(DISTINCT b.tenant_id) FILTER (WHERE b.ownership IN (${CANNOT}))::int AS tenants_affected,
  count(DISTINCT b.uploaded_by) FILTER (WHERE b.ownership IN (${CANNOT}))::int AS uploaders_affected
  FROM base b`,
  byMonth: `WITH ${BASE}
  SELECT b.ownership, b.deposited, COALESCE(pg_catalog.to_char(c.created_at, 'YYYY-MM'), '') AS created_month, count(*)::int AS checks
  FROM base b JOIN public.check_intake_items c ON c.id = b.id
  GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  byStage: `WITH ${BASE}
  SELECT b.ownership, b.deposited, COALESCE(c.status::text, '') AS status, COALESCE(c.check_stage::text, '') AS check_stage, count(*)::int AS checks
  FROM base b JOIN public.check_intake_items c ON c.id = b.id
  GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
  claims: `WITH ${BASE}
  SELECT b.ownership, b.deposited,
  CASE WHEN c.claim_id IS NULL THEN 'no_claim'
       WHEN cl.id IS NULL THEN 'claim_missing'
       WHEN cl.org_id IS NULL THEN 'claim_org_null'
       WHEN cl.org_id = c.tenant_id THEN 'claim_org_equal'
       ELSE 'claim_org_differs' END AS claim_class,
  CASE WHEN cl.org_id IS NULL OR b.uploaded_by IS NULL THEN NULL ELSE ${member('b.uploaded_by', 'cl.org_id')} END AS uploader_member_of_claim_org,
  count(*)::int AS checks
  FROM base b JOIN public.check_intake_items c ON c.id = b.id LEFT JOIN public.claims cl ON cl.id = c.claim_id
  GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
  imagePaths: `WITH ${BASE},
  paths AS (
    SELECT b.id, b.tenant_id, b.uploaded_by, b.ownership, b.deposited, v.image_column, v.raw,
      ${relPathSql('v.raw')} AS rel
    FROM base b JOIN public.check_intake_items c ON c.id = b.id
    CROSS JOIN LATERAL (VALUES ('front_image_path', c.front_image_path), ('back_image_path', c.back_image_path),
      ('back_image_original_path', c.back_image_original_path),
      ('adjuster_source', COALESCE(c.back_image_original_path, c.back_image_path))) v(image_column, raw)),
  scoped AS (
    SELECT p.*, ${scopedUuidSql('p.rel')} AS scope FROM paths p)
  SELECT s.image_column, s.ownership, s.deposited,
  CASE WHEN s.raw IS NULL OR pg_catalog.btrim(s.raw) = '' THEN 'empty'
       WHEN s.rel IS NULL THEN 'url_not_parsed'
       WHEN s.scope IS NULL THEN 'not_check_scoped'
       WHEN s.scope = s.id::text THEN 'check_scoped_self'
       WHEN s.scope = s.uploaded_by::text THEN 'check_scoped_uploader'
       WHEN s.scope = s.tenant_id::text THEN 'check_scoped_tenant'
       WHEN EXISTS (SELECT 1 FROM public.check_intake_items o WHERE o.id = s.scope::uuid) THEN 'check_scoped_other_check'
       ELSE 'check_scoped_other_uuid' END AS path_class,
  count(*)::int AS checks
  FROM scoped s GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
  rollback: 'ROLLBACK',
});

/** Every statement the inspect may send, for the tests' allowlist. */
export const INSPECT_STATEMENTS = Object.freeze(Object.values(Q));

const T = Object.freeze({
  check_intake_items: ['id', 'tenant_id', 'uploaded_by', 'deposited_at', 'created_at', 'status', 'check_stage', 'claim_id',
    'front_image_path', 'back_image_path', 'back_image_original_path'],
  tenants: ['id'],
  tenant_users: ['user_id', 'tenant_id'],
  claims: ['id', 'org_id'],
});
export const INSPECT_TABLES = Object.freeze(Object.keys(T));
const BASE_REQUIRES = { check_intake_items: ['id', 'tenant_id', 'uploaded_by', 'deposited_at'], tenants: ['id'], tenant_users: ['user_id', 'tenant_id'] };
const withBase = (extra) => Object.fromEntries(Object.keys({ ...BASE_REQUIRES, ...extra })
  .map((t) => [t, [...new Set([...(BASE_REQUIRES[t] || []), ...(extra[t] || [])])]]));
/** The columns each data statement reads. */
export const STATEMENT_REQUIRES = Object.freeze({
  ownership: BASE_REQUIRES,
  affected: BASE_REQUIRES,
  byMonth: withBase({ check_intake_items: ['created_at'] }),
  byStage: withBase({ check_intake_items: ['status', 'check_stage'] }),
  claims: withBase({ check_intake_items: ['claim_id'], claims: ['id', 'org_id'] }),
  imagePaths: withBase({ check_intake_items: ['front_image_path', 'back_image_path', 'back_image_original_path'] }),
});

const LABEL_RE = /^[a-z][a-z0-9_]{0,40}$/;
const label = (v) => (v === '' || v == null ? '(none)' : LABEL_RE.test(String(v)) ? String(v) : 'other');
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const month = (v) => (v === '' || v == null ? '(none)' : MONTH_RE.test(String(v)) ? String(v) : 'other');
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const known = (list) => (v) => (list.includes(v) ? v : 'other');
const ownership = known(Object.keys(OWNERSHIP_CLASSES));
const tenantsOf = known(UPLOADER_TENANTS);
const bool = (v) => (v === true ? true : v === false ? false : null);
const section = (r, key, map) => (r[key] === undefined
  ? { read: false, reason: r.skipped?.[key] || 'not_read' }
  : { read: true, rows: r[key].map(map) });

/** Pure: the totals and the class x uploader-tenants matrix from the ownership rows. */
export function summarize(rows) {
  const blank = () => ({ checks: 0, deposited: 0, not_deposited: 0 });
  const byClass = Object.fromEntries(Object.keys(OWNERSHIP_CLASSES).map((k) => [k, {
    ...blank(), uploader_tenants: Object.fromEntries(UPLOADER_TENANTS.map((u) => [u, 0])),
  }]));
  const total = blank();
  let uploadedByNull = 0;
  for (const row of rows) {
    const n = int(row.checks) || 0;
    const cls = byClass[ownership(row.ownership)];
    const add = (o) => { o.checks += n; o[row.deposited === true ? 'deposited' : 'not_deposited'] += n; };
    add(total);
    if (cls) {
      add(cls);
      const u = tenantsOf(row.uploader_tenants);
      if (Object.hasOwn(cls.uploader_tenants, u)) cls.uploader_tenants[u] += n;
    }
    if (row.uploader_tenants === 'uploader_null') uploadedByNull += n;
  }
  const cannot = blank();
  for (const k of UPLOADER_CANNOT_WRITE) for (const f of Object.keys(cannot)) cannot[f] += byClass[k][f];
  return { total, uploaded_by_null: uploadedByNull, uploader_cannot_write: cannot, by_ownership: byClass };
}

/** Pure: builds the report from the rows the statements returned. Counts and labels only. */
export function buildReport(r) {
  const session = r.session?.[0] || {};
  const affected = r.affected?.[0] || {};
  return {
    inspect: INSPECT_ID,
    read_only: true,
    transaction_read_only: session.transaction_read_only === 'on',
    current_user: session.current_user,
    session_user: session.session_user,
    server_major_version: Math.floor(Number(session.server_version_num || 0) / 10000),
    question: 'how many checks have an ownership (tenant_id, uploaded_by, tenant_users membership) or an image path scope that keeps their own uploader from writing them?',
    membership_rule: 'tenant_users.user_id = check uploaded_by AND tenant_users.tenant_id = check tenant_id (TENANT_MEMBER_SQL, aws_is_tenant_member; role ignored)',
    ownership_classes: OWNERSHIP_CLASSES,
    path_classes: PATH_CLASSES,
    row_security: r.rowSecurity === undefined
      ? { read: false, reason: 'not_read' }
      : Object.fromEntries(r.rowSecurity.map((x) => [label(x.table_name), x.row_security_active === true])),
    summary: r.ownership === undefined ? { read: false, reason: r.skipped?.ownership || 'not_read' } : { read: true, ...summarize(r.ownership) },
    ownership: section(r, 'ownership', (x) => ({
      ownership: ownership(x.ownership), uploader_tenants: tenantsOf(x.uploader_tenants), deposited: x.deposited === true, checks: int(x.checks),
    })),
    affected: r.affected === undefined
      ? { read: false, reason: r.skipped?.affected || 'not_read' }
      : {
        read: true,
        tenants_with_checks: int(affected.tenants_with_checks),
        missing_tenants: int(affected.missing_tenants),
        tenants_with_uploader_not_member: int(affected.tenants_with_uploader_not_member),
        tenants_affected: int(affected.tenants_affected),
        uploaders_affected: int(affected.uploaders_affected),
      },
    by_month: section(r, 'byMonth', (x) => ({
      ownership: ownership(x.ownership), deposited: x.deposited === true, created_month: month(x.created_month), checks: int(x.checks),
    })),
    by_stage: section(r, 'byStage', (x) => ({
      ownership: ownership(x.ownership), deposited: x.deposited === true, status: label(x.status), check_stage: label(x.check_stage), checks: int(x.checks),
    })),
    claims: section(r, 'claims', (x) => ({
      ownership: ownership(x.ownership), deposited: x.deposited === true, claim_class: known(CLAIM_CLASSES)(x.claim_class),
      uploader_member_of_claim_org: bool(x.uploader_member_of_claim_org), checks: int(x.checks),
    })),
    image_paths: section(r, 'imagePaths', (x) => ({
      image_column: known(IMAGE_COLUMNS)(x.image_column), ownership: ownership(x.ownership), deposited: x.deposited === true,
      path_class: known(Object.keys(PATH_CLASSES))(x.path_class), checks: int(x.checks),
    })),
  };
}

export function loadInspectConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
}

/**
 * Runs the inspect on a connected client: BEGIN READ ONLY ... ROLLBACK of the fixed statements
 * in Q only. A data statement runs only when every table and column it reads exists. Returns
 * the structured result; never throws.
 */
export async function inspectCheckOwnership({ connect }) {
  const names = new Map(Object.entries(Q).map(([k, v]) => [v, k]));
  let client = null;
  let stage = null;
  const rows = async (sql, params) => { stage = names.get(sql); return (await client.query(sql, params)).rows; };
  try {
    stage = 'connect';
    client = await connect();
    await rows(Q.begin);
    await rows(Q.searchPath);
    await rows(Q.statementTimeout);
    await rows(Q.lockTimeout);
    await rows(Q.timeZone);
    const r = { skipped: {} };
    r.session = await rows(Q.session);
    if (r.session?.[0]?.transaction_read_only !== 'on') {
      return fail(CODES.UNRELATED_MUTATION, 'check ownership inspect refused: the transaction is not read-only');
    }
    r.columns = await rows(Q.columns, [[...INSPECT_TABLES]]);
    r.rowSecurity = await rows(Q.rowSecurity, [[...INSPECT_TABLES]]);
    const have = new Set(r.columns.map((c) => `${c.table_name}.${c.column_name}`));
    const missing = (key) => Object.entries(STATEMENT_REQUIRES[key]).flatMap(([t, cols]) => cols.filter((c) => !have.has(`${t}.${c}`)).map((c) => `${t}.${c}`));
    for (const key of Object.keys(STATEMENT_REQUIRES)) {
      const gone = missing(key);
      if (gone.length) { r.skipped[key] = `columns_missing:${gone.join(',')}`; continue; }
      r[key] = await rows(Q[key]);
    }
    return ok(buildReport(r));
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, 'check ownership inspect failed', {
      read_only: true,
      stage,
      error_code: safeErrorCode(error),
    });
  } finally {
    if (client) {
      try { await client.query(Q.rollback); } catch { /* closed below */ }
      try { await client.end(); } catch { /* nothing to report */ }
    }
  }
}
