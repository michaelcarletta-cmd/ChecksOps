/**
 * One engine for the release 2026-10-17 SQL (SQL 90 to SQL 106, SQL 108 to SQL 135, SQL 137, SQL 138), shared by the staging
 * guarded executor (aws/write-path/guarded-sql-executor/index.mjs) and the production tools
 * (release-sql-production-apply.mjs): the catalog state reader, the code-derived
 * fingerprints, the pre- and post-conditions, the predecessor rules and the unrelated-catalog
 * snapshot. The specs (object names, reviewed ACLs and the PostgreSQL renderings the files
 * leave) live in release-sql-specs.mjs; the pins in sql-executor-auth.mjs.
 *
 * Fingerprint (live_definition_sha256) = sha256(releaseStateText(key, state)): one line per
 * object the file creates, replaces or drops, in spec order:
 *
 *   function   absent, or language, volatility, parallel, SECURITY DEFINER, result type,
 *              proconfig, sha256(prosrc) and the EXECUTE ACL (the owner read as `owner`)
 *   policy     absent, or cmd, permissive, roles and sha256 of the whitespace-collapsed
 *              USING / WITH CHECK expressions (pg_get_expr, search_path pg_catalog)
 *   view       absent, or sha256 of the collapsed pg_get_viewdef and its reloptions
 *   table      (created by the file) absent, or RLS / FORCE, every column (type, NOT NULL,
 *              default, column ACL), constraint, index, policy name, trigger name and the
 *              non-owner table ACL
 *   column     (added to an existing table) absent, or type, NOT NULL, default, column ACL
 *   constraint / trigger on an existing table: absent, or the collapsed definition
 *   privileges the pinned grantees' pinned table privileges (SQL 97, SQL 100)
 *   index      (created on an existing table) absent, or the collapsed pg_get_indexdef (SQL 98)
 *   unique     whether a unique index covers the named columns (SQL 98: the file adds one only
 *              when none does)
 *   function_acl
 *              (an existing function the file neither creates nor replaces, spec acl_functions,
 *              SQL 103) absent, or its EXECUTE ACL only; the post-conditions require every other
 *              attribute (body, language, SECURITY DEFINER, config, result, owner) unchanged.
 *              An entry with `attributes` (SQL 121: ALTER FUNCTION ... SECURITY DEFINER, SET
 *              search_path) also carries SECURITY DEFINER, proconfig and the reviewed body hash
 *              (attributes.prosrc_sha256): the file sets the first two, the body must be the
 *              reviewed one before and stays unchanged
 *
 * A spec may ask for more detail (spec.render, SQL 100): `grantors` adds each ACL entry's
 * grantor (the object owner read as `owner`) to the function, column and table privilege
 * lines, and `policy_comments` adds sha256 of each policy's comment (never the text), so a
 * re-GRANT by another grantor or a policy comment DROP POLICY would lose is another state.
 *
 * Owner names are never part of it, so the post-state hash is the same in staging and
 * production. The intended state is code-derived: function attributes and sha256(prosrc)
 * from the pinned file's bytes, everything PostgreSQL renders from the reviewed constants in
 * release-sql-specs.mjs (re-derived on PostgreSQL 16 by the tests).
 *
 * Reads are catalog-only (no table rows) except aggregate COUNT(*)s a migration declares
 * (SQL 94: rows its new doc_type rule would refuse), each in its own savepoint. The
 * inspect report carries flags, hashes, object names and those counts: never ids, owner
 * names, definitions or row data.
 *
 * Adding a migration (SQL 101, ...) means adding its spec, its staging pin and its
 * production pin; the engine, the executor handler, the production tool and the one-shot
 * registration are generic.
 */
import { createHash } from 'node:crypto';
import { ok } from './errors.mjs';
import { RELEASE_SQL_SPECS } from './release-sql-specs.mjs';
import {
  RELEASE_2026_10_17_PENDING_SQL_PINS,
  SQL29_FUNCTIONS,
  SQL29_POLICIES,
  readLibrarySqlState,
  sql30CheckShape,
} from './sql-executor-auth.mjs';

export { RELEASE_SQL_SPECS };
export const RELEASE_SQL_KEYS = Object.freeze(Object.keys(RELEASE_SQL_SPECS));
export const RELEASE_SQL_PINS = RELEASE_2026_10_17_PENDING_SQL_PINS;

const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');
const failed = (checks) => checks.filter(([, passed]) => !passed).map(([name]) => name);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Whitespace-collapsed PostgreSQL rendering (pretty-print line breaks differ between versions). */
export const collapse = (text) => (text == null ? null : String(text).replace(/\s+/g, ' ').trim());
const hashOrDash = (text) => (text == null || text === '' ? '-' : sha(collapse(text)));

/** The production tools' owner-approval rule (homeowner-sql-production-apply.mjs), for the staging pins too. */
export const RELEASE_OWNER_APPROVED_RE = /^owner[- ]approved\b/i;

/**
 * Whether a staging pin authorizes an apply: execute true and an owner-approved
 * authorization. A pending pin still allows inspect / read-live.
 */
export function releasePinApplyFailures(pin) {
  const authorization = typeof pin?.authorization === 'string' ? pin.authorization.trim() : '';
  return failed([
    ['pin_execute', pin?.execute === true],
    ['pin_owner_approved', authorization !== '' && authorization.toLowerCase() !== 'pending' && RELEASE_OWNER_APPROVED_RE.test(authorization)],
  ]);
}

export function releaseSpec(key) {
  const spec = RELEASE_SQL_SPECS[key];
  if (!spec) throw new Error(`unknown release SQL migration ${key}`);
  return spec;
}

export function releasePin(key) {
  const pin = RELEASE_SQL_PINS[key];
  if (!pin) throw new Error(`no staging pin for release SQL migration ${key}`);
  return pin;
}

// --- the file's functions -----------------------------------------------------------

const VOLATILITY = Object.freeze({ IMMUTABLE: 'i', STABLE: 's', VOLATILE: 'v' });
const PARALLEL = Object.freeze({ SAFE: 's', RESTRICTED: 'r', UNSAFE: 'u' });

/**
 * Every CREATE [OR REPLACE] FUNCTION public.<name>(...) of the file (top level or inside an
 * EXECUTE $fn$ ... $fn$), by name: the attributes PostgreSQL stores and the body (prosrc)
 * exactly as written between its dollar quotes. Null when a name is defined twice.
 */
export function releaseFunctionDefinitions(text) {
  const source = String(text || '');
  const out = {};
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(/gi;
  let match;
  while ((match = re.exec(source))) {
    const name = match[1];
    const rest = source.slice(match.index);
    const as = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(rest);
    if (!as) return null;
    const header = rest.slice(0, as.index);
    const bodyStart = as.index + as[0].length;
    const bodyEnd = rest.indexOf(as[1], bodyStart);
    if (bodyEnd < 0) return null;
    if (Object.hasOwn(out, name)) return null;
    const returns = /\bRETURNS\s+([A-Za-z0-9_.]+(?:\[\])?)/i.exec(header);
    const language = /\bLANGUAGE\s+([A-Za-z]+)/i.exec(header);
    const volatility = /\b(IMMUTABLE|STABLE|VOLATILE)\b/i.exec(header);
    const parallel = /\bPARALLEL\s+(SAFE|RESTRICTED|UNSAFE)\b/i.exec(header);
    // A list value (SQL 102: search_path = public, pg_temp) as PostgreSQL stores it in proconfig.
    const config = [...header.matchAll(/\bSET\s+([a-z_]+)\s*=\s*([A-Za-z0-9_]+(?:\s*,\s*[A-Za-z0-9_]+)*)/gi)]
      .map((m) => `${m[1].toLowerCase()}=${m[2].split(',').map((v) => v.trim()).join(', ')}`).sort();
    out[name] = {
      result: returns ? returns[1].toLowerCase().replace(/^public\./, '') : null,
      language: language ? language[1].toLowerCase() : null,
      volatility: volatility ? VOLATILITY[volatility[1].toUpperCase()] : 'v',
      parallel: parallel ? PARALLEL[parallel[1].toUpperCase()] : 'u',
      security_definer: /\bSECURITY\s+DEFINER\b/i.test(header),
      config,
      prosrc: rest.slice(bodyStart, bodyEnd),
    };
    re.lastIndex = match.index + bodyEnd + as[1].length;
  }
  return out;
}

const fnName = (identity) => /^public\.([a-z0-9_]+)\(/.exec(identity)?.[1] || null;

/**
 * Statements no release file may contain anywhere (top level, DO blocks, EXECUTE strings or
 * function bodies): role and session identity changes, replication-role tricks, default
 * privileges, role grants and role DDL. Returns the names of the rules that matched.
 */
const FORBIDDEN_STATEMENT_RULES = Object.freeze([
  ['set_role', /\bSET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\b/i],
  ['set_session_authorization', /\bSESSION\s+AUTHORIZATION\b/i],
  ['session_replication_role', /\bsession_replication_role\b/i],
  ['set_config_identity', /\bset_config\s*\(\s*'(?:role|session_authorization|session_replication_role)'/i],
  ['alter_default_privileges', /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i],
  ['role_ddl', /\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER|GROUP)\b/i],
  ['reassign_or_drop_owned', /\b(?:REASSIGN|DROP)\s+OWNED\b/i],
  ['security_label', /\bSECURITY\s+LABEL\b/i],
]);

export function releaseForbiddenStatements(text) {
  const source = String(text || '').replace(/--[^\n]*/g, '');
  const hits = FORBIDDEN_STATEMENT_RULES.filter(([, re]) => re.test(source)).map(([name]) => name);
  // GRANT <role> TO <role> / REVOKE <role> FROM <role>: a GRANT or REVOKE with no ON clause.
  for (const match of source.matchAll(/\b(GRANT|REVOKE)\b([^;]*?)\b(TO|FROM)\b/gi)) {
    if (!/\bON\b/i.test(match[2])) {
      hits.push('role_grant');
      break;
    }
  }
  return hits;
}

/** The reviewed bytes as the guarded tools execute them (none of SQL 90-102 has BEGIN/COMMIT), or null. */
export function releaseSqlExecutableText(key, text) {
  const spec = releaseSpec(key);
  const source = String(text || '');
  // No transaction or session control outside dollar-quoted bodies: the tools own the
  // transaction (and verify before COMMIT), and the file may not change role or session.
  const outside = source.replace(/--[^\n]*/g, '').replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '').replace(/'(?:[^']|'')*'/g, "''");
  if (/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END|ABORT)\b/i.test(outside)) return null;
  if (/\bSTART\s+TRANSACTION\b|\bSET\s+(SESSION|ROLE|LOCAL\s+ROLE)\b|\bRESET\b|\bDISCARD\b|\bCOPY\b|^\s*\\/im.test(outside)) return null;
  if (releaseForbiddenStatements(source).length) return null;
  const defs = releaseFunctionDefinitions(source);
  if (!defs) return null;
  const expected = spec.functions.map((fn) => fnName(fn.identity)).sort();
  if (!same(Object.keys(defs).sort(), expected)) return null;
  return source;
}

// --- catalog reads -----------------------------------------------------------------

const ACL_SQL = (column, owner, kind) => `
SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = ${owner} THEN 'owner' ELSE pg_catalog.pg_get_userbyid(a.grantee) END AS grantee,
  a.privilege_type, a.is_grantable,
  CASE WHEN a.grantor = ${owner} THEN 'owner' ELSE pg_catalog.pg_get_userbyid(a.grantor) END AS grantor
FROM pg_catalog.aclexplode(COALESCE(${column}, pg_catalog.acldefault('${kind}', ${owner}))) a`;

export const RELEASE_READS = Object.freeze({
  searchPath: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
  login: 'SELECT current_user::text AS current_user, session_user::text AS session_user',
  regclass: 'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present',
  regprocedure: 'SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present',
  regtype: 'SELECT pg_catalog.to_regtype($1) IS NOT NULL AS present',
  role: 'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS present',
  column: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
WHERE a.attrelid = pg_catalog.to_regclass($1) AND a.attname = $2 AND a.attnum > 0 AND NOT a.attisdropped) AS present`,
  function: `SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer, p.provolatile::text AS volatility,
  p.proparallel::text AS parallel, l.lanname AS language,
  pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') AS prosrc_sha256,
  COALESCE(p.proconfig, ARRAY[]::text[]) AS config, pg_catalog.pg_get_function_result(p.oid) AS result
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
WHERE p.oid = pg_catalog.to_regprocedure($1)`,
  functionAcl: `SELECT x.grantee, x.privilege_type, x.is_grantable, x.grantor FROM pg_catalog.pg_proc p
CROSS JOIN LATERAL (${ACL_SQL('p.proacl', 'p.proowner', 'f')}) x
WHERE p.oid = pg_catalog.to_regprocedure($1) ORDER BY 1, 2`,
  // Objects other than its trigger that depend on a function SQL 95 drops (DROP FUNCTION without CASCADE).
  functionDependents: `SELECT count(*)::int AS n FROM pg_catalog.pg_depend d
WHERE d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND d.refobjid = pg_catalog.to_regprocedure($1)
  AND d.deptype = 'n' AND d.classid <> 'pg_catalog.pg_trigger'::pg_catalog.regclass`,
  functionTriggers: `SELECT count(*)::int AS n FROM pg_catalog.pg_trigger t
WHERE t.tgfoid = pg_catalog.to_regprocedure($1) AND NOT t.tgisinternal
  AND NOT (t.tgrelid = pg_catalog.to_regclass($2) AND t.tgname = $3)`,
  // Functions in public / auth (other than the dropped ones) whose body names a function the
  // migration drops: plpgsql and EXECUTE callers that pg_depend does not record. $1 the
  // identities dropped, $2 their bare names. Returns identities only, never bodies.
  functionCallers: `SELECT p.oid::regprocedure::text AS name
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'auth')
  AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) x WHERE pg_catalog.to_regprocedure(x) = p.oid)
  AND EXISTS (SELECT 1 FROM unnest($2::text[]) f WHERE p.prosrc ~* ('\\m' || f || '\\M'))
ORDER BY 1`,
  relation: `SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relkind::text AS kind, c.relrowsecurity AS rls,
  c.relforcerowsecurity AS forced, COALESCE(c.reloptions, ARRAY[]::text[]) AS options
FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass($1)`,
  relationAcl: `SELECT x.grantee, x.privilege_type, x.is_grantable, x.grantor FROM pg_catalog.pg_class c
CROSS JOIN LATERAL (${ACL_SQL('c.relacl', 'c.relowner', 'r')}) x
WHERE c.oid = pg_catalog.to_regclass($1) ORDER BY 1, 2`,
  columns: `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
  pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default,
  ARRAY(SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ' ' || x.privilege_type
          || CASE WHEN x.is_grantable THEN ' with grant option' ELSE '' END
        FROM pg_catalog.aclexplode(a.attacl) x ORDER BY 1)::text[] AS acl,
  ARRAY(SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(x.grantee) END || ' ' || x.privilege_type
          || CASE WHEN x.is_grantable THEN ' with grant option' ELSE '' END
          || ' grantor=' || CASE WHEN x.grantor = c.relowner THEN 'owner' ELSE pg_catalog.pg_get_userbyid(x.grantor) END
        FROM pg_catalog.aclexplode(a.attacl) x ORDER BY 1)::text[] AS acl_grantors
FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = pg_catalog.to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum`,
  // A validated contype 'n' (PostgreSQL 18 records each NOT NULL as a named constraint) is left
  // out: the column's notnull already carries it, and PostgreSQL 16 has no such row. A NOT VALID
  // one stays in (notnull is true for it too), so it is a different state.
  constraints: `SELECT con.conname AS name, pg_catalog.pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated
FROM pg_catalog.pg_constraint con WHERE con.conrelid = pg_catalog.to_regclass($1) AND NOT (con.contype = 'n' AND con.convalidated) ORDER BY 1`,
  indexes: `SELECT c.relname AS name, pg_catalog.pg_get_indexdef(i.indexrelid) AS def
FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = pg_catalog.to_regclass($1) ORDER BY 1`,
  triggers: `SELECT t.tgname AS name, t.tgenabled::text AS enabled, pg_catalog.pg_get_triggerdef(t.oid) AS def
FROM pg_catalog.pg_trigger t WHERE t.tgrelid = pg_catalog.to_regclass($1) AND NOT t.tgisinternal ORDER BY 1`,
  policies: `SELECT pol.polname AS name,
  CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END AS cmd,
  pol.polpermissive AS permissive,
  ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END FROM unnest(pol.polroles) r ORDER BY 1)::text[] AS roles,
  pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS qual,
  pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check,
  (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(d.description, 'UTF8')), 'hex')
     FROM pg_catalog.pg_description d
    WHERE d.classoid = 'pg_catalog.pg_policy'::pg_catalog.regclass AND d.objoid = pol.oid AND d.objsubid = 0) AS description_sha256
FROM pg_catalog.pg_policy pol WHERE pol.polrelid = pg_catalog.to_regclass($1) ORDER BY 1`,
  view: `SELECT pg_catalog.pg_get_viewdef(c.oid) AS def FROM pg_catalog.pg_class c
WHERE c.oid = pg_catalog.to_regclass($1) AND c.relkind = 'v'`,
  // One index on an existing table, by name (SQL 98).
  index: `SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS def FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = pg_catalog.to_regclass($1) AND c.relname = $2`,
  // Whether a unique index on $1 covers the columns $2 and no column outside $3: SQL 98's own
  // test for check_billing_events (check_intake_item_id, event_type), as the file runs it.
  uniqueCover: `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_index i
  WHERE i.indrelid = pg_catalog.to_regclass($1) AND i.indisunique
    AND (SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attname) FROM pg_catalog.unnest(i.indkey) AS k(attnum)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) OPERATOR(pg_catalog.<@) $3::text[]
    AND (SELECT pg_catalog.array_agg(a.attname::text) FROM pg_catalog.unnest(i.indkey) AS k(attnum)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) OPERATOR(pg_catalog.@>) $2::text[]
) AS covered`,
  // Whether a SECURITY DEFINER function owned by this login may write $1 under RLS (SQL 99's
  // own check): superuser, BYPASSRLS, or a member of the owner and the table not FORCE RLS.
  definerWrite: `SELECT (me.rolsuper OR me.rolbypassrls
    OR (pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AND NOT c.relforcerowsecurity)) AS ok
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles me ON me.rolname = current_user
WHERE c.oid = pg_catalog.to_regclass($1)`,
});

const aclLine = (row) => `${row.grantee} ${row.privilege_type}${row.is_grantable === true ? ' with grant option' : ''}`;
// spec.render.grantors (SQL 100): each ACL line also names its grantor (the owner as `owner`).
const aclLineFor = (spec) => (spec?.render?.grantors === true ? (row) => `${aclLine(row)} grantor=${row.grantor}` : aclLine);
const columnAcl = (spec, row) => [...((spec?.render?.grantors === true ? row.acl_grantors : row.acl) || [])].map(String).sort();

async function prerequisitePresent(q, name) {
  if (name.startsWith('role ')) return (await q(RELEASE_READS.role, [name.slice(5)]))[0]?.present === true;
  if (name.startsWith('type ')) return (await q(RELEASE_READS.regtype, [name.slice(5)]))[0]?.present === true;
  if (name.startsWith('column ')) {
    const [, table, column] = /^column (.+)\.([a-z0-9_]+)$/.exec(name) || [];
    return Boolean(table) && (await q(RELEASE_READS.column, [table, column]))[0]?.present === true;
  }
  if (name.includes('(')) return (await q(RELEASE_READS.regprocedure, [name]))[0]?.present === true;
  return (await q(RELEASE_READS.regclass, [name]))[0]?.present === true;
}

async function readFunction(q, identity, login, spec) {
  const row = (await q(RELEASE_READS.function, [identity]))[0];
  if (!row) return { exists: false };
  const acl = (await q(RELEASE_READS.functionAcl, [identity])).map(aclLineFor(spec)).sort();
  return {
    exists: true,
    owner_is_login: row.owner === login,
    language: row.language,
    volatility: row.volatility,
    parallel: row.parallel,
    security_definer: row.security_definer === true,
    result: row.result,
    config: [...(row.config || [])].map(String).sort(),
    prosrc_sha256: row.prosrc_sha256,
    acl,
  };
}

const policyState = (row, spec) => {
  if (!row) return { exists: false };
  const state = { exists: true, cmd: row.cmd, permissive: row.permissive === true, roles: [...(row.roles || [])].map(String).sort(), qual: collapse(row.qual), with_check: collapse(row.with_check) };
  // spec.render.policy_comments (SQL 100): DROP POLICY + CREATE POLICY would lose a comment.
  if (spec?.render?.policy_comments === true) state.comment_sha256 = row.description_sha256 ?? null;
  return state;
};

async function readRelation(q, name, login) {
  const row = (await q(RELEASE_READS.relation, [name]))[0];
  if (!row) return { exists: false };
  const acl = (await q(RELEASE_READS.relationAcl, [name])).filter((r) => r.grantee !== 'owner').map(aclLine).sort();
  return { exists: true, owner_is_login: row.owner === login, kind: row.kind, rls: row.rls === true, forced: row.forced === true, options: [...(row.options || [])].map(String).sort(), acl };
}

async function readTable(q, name, login, spec) {
  const rel = await readRelation(q, name, login);
  if (!rel.exists) return { exists: false };
  const columns = (await q(RELEASE_READS.columns, [name])).map((c) => ({
    name: c.name, type: c.type, notnull: c.notnull === true, default: collapse(c.default), acl: columnAcl(spec, c),
  }));
  const constraints = (await q(RELEASE_READS.constraints, [name])).map((c) => ({ name: c.name, def: collapse(c.def), validated: c.validated === true }));
  const indexes = (await q(RELEASE_READS.indexes, [name])).map((i) => ({ name: i.name, def: collapse(i.def) }));
  const policies = (await q(RELEASE_READS.policies, [name])).map((p) => p.name).sort();
  const triggers = (await q(RELEASE_READS.triggers, [name])).map((t) => t.name).sort();
  return { exists: true, owner_is_login: rel.owner_is_login, kind: rel.kind, rls: rel.rls, forced: rel.forced, columns, constraints, indexes, policies, triggers, acl: rel.acl };
}

/** One aggregate COUNT(*) in its own savepoint; null (with a reason code) when unreadable. */
async function guardedCount(client, name, sql) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    const rows = (await client.query(sql))?.rows || [];
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return { readable: true, n: Number(rows[0]?.n) || 0 };
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    return { readable: false, reason: String(error?.code || 'unreadable').slice(0, 16) };
  }
}

const objKey = (table, name) => `${table} ${name}`;

/** The catalog state of every object one migration creates, replaces or drops. */
async function readObjects(q, spec, login) {
  const functions = {};
  for (const fn of spec.functions) functions[fn.identity] = await readFunction(q, fn.identity, login, spec);
  for (const identity of spec.dropped_functions || []) functions[identity] = await readFunction(q, identity, login, spec);
  // spec.acl_functions (SQL 103): existing functions whose ACL the file sets; read in full so the
  // post-conditions can tell that nothing but the ACL changed.
  const aclFunctions = {};
  for (const fn of spec.acl_functions || []) aclFunctions[fn.identity] = await readFunction(q, fn.identity, login, spec);
  const policies = {};
  const policyRows = new Map();
  const rowsFor = async (table) => {
    if (!policyRows.has(table)) policyRows.set(table, await q(RELEASE_READS.policies, [table]));
    return policyRows.get(table);
  };
  for (const p of [...(spec.policies || []), ...(spec.dropped_policies || [])]) {
    const present = (await q(RELEASE_READS.regclass, [p.table]))[0]?.present === true;
    const row = present ? (await rowsFor(p.table)).find((r) => r.name === p.name) : null;
    policies[objKey(p.table, p.name)] = policyState(row, spec);
  }
  const views = {};
  for (const v of spec.views || []) {
    const row = (await q(RELEASE_READS.view, [v.name]))[0];
    const rel = row ? await readRelation(q, v.name, login) : null;
    views[v.name] = row ? { exists: true, def: collapse(row.def), options: rel.options } : { exists: false };
  }
  const tables = {};
  for (const t of spec.tables || []) tables[t.name] = await readTable(q, t.name, login, spec);
  const columns = {};
  for (const c of [...(spec.added_columns || []), ...(spec.column_acl || [])]) {
    const key = `${c.table}.${c.column}`;
    if (Object.hasOwn(columns, key)) continue;
    const present = (await q(RELEASE_READS.regclass, [c.table]))[0]?.present === true;
    const row = present ? (await q(RELEASE_READS.columns, [c.table])).find((r) => r.name === c.column) : null;
    columns[key] = row
      ? { exists: true, type: row.type, notnull: row.notnull === true, default: collapse(row.default), acl: columnAcl(spec, row) }
      : { exists: false };
  }
  const constraints = {};
  for (const c of spec.constraints || []) {
    const present = (await q(RELEASE_READS.regclass, [c.table]))[0]?.present === true;
    const row = present ? (await q(RELEASE_READS.constraints, [c.table])).find((r) => r.name === c.name) : null;
    constraints[objKey(c.table, c.name)] = row ? { exists: true, def: collapse(row.def), validated: row.validated === true } : { exists: false };
  }
  const triggers = {};
  for (const t of [...(spec.triggers || []), ...(spec.dropped_triggers || [])]) {
    const present = (await q(RELEASE_READS.regclass, [t.table]))[0]?.present === true;
    const row = present ? (await q(RELEASE_READS.triggers, [t.table])).find((r) => r.name === t.name) : null;
    triggers[objKey(t.table, t.name)] = row ? { exists: true, enabled: row.enabled, def: collapse(row.def) } : { exists: false };
  }
  const privileges = {};
  for (const p of spec.table_privileges || []) {
    const rel = await readRelation(q, p.table, login);
    const all = rel.exists ? (await q(RELEASE_READS.relationAcl, [p.table])).map(aclLineFor(spec)).sort() : [];
    privileges[p.table] = {
      exists: rel.exists,
      lines: all.filter((line) => p.grantees.includes(line.split(' ')[0]) && p.privileges.includes(line.split(' ')[1])),
      other: all.filter((line) => !(p.grantees.includes(line.split(' ')[0]) && p.privileges.includes(line.split(' ')[1]))),
    };
  }
  const altered = {};
  for (const name of spec.altered_relations || []) {
    const rel = await readRelation(q, name, login);
    altered[name] = { exists: rel.exists, owner_is_login: rel.owner_is_login === true };
  }
  const indexes = {};
  for (const i of spec.indexes || []) {
    const row = (await q(RELEASE_READS.index, [i.table, i.name]))[0];
    indexes[objKey(i.table, i.name)] = row ? { exists: true, def: collapse(row.def) } : { exists: false };
  }
  const covers = {};
  for (const u of spec.unique_covers || []) {
    const present = (await q(RELEASE_READS.regclass, [u.table]))[0]?.present === true;
    covers[objKey(u.table, u.name)] = { covered: present && (await q(RELEASE_READS.uniqueCover, [u.table, u.contains, u.within]))[0]?.covered === true };
  }
  const definer = {};
  for (const table of spec.definer_writes || []) definer[table] = (await q(RELEASE_READS.definerWrite, [table]))[0]?.ok === true;
  // spec.whole_tables (SQL 100): the whole access surface of the table, not only the named
  // objects: RLS flags, every other policy, every non-owner table grant and every grant on an
  // unlisted column, so a policy or grant the file does not describe moves the fingerprint.
  const whole = {};
  for (const w of spec.whole_tables || []) {
    const rel = await readRelation(q, w.table, login);
    if (!rel.exists) {
      whole[w.table] = { exists: false };
      continue;
    }
    const named = new Set([...(spec.policies || []), ...(spec.dropped_policies || [])].filter((p) => p.table === w.table).map((p) => p.name));
    const listed = new Set((spec.column_acl || []).filter((c) => c.table === w.table).map((c) => c.column));
    whole[w.table] = {
      exists: true,
      rls: rel.rls === true,
      forced: rel.forced === true,
      other_policies: (await rowsFor(w.table)).filter((r) => !named.has(r.name))
        .map((r) => policyLine(objKey(w.table, r.name), policyState(r, spec), spec)).sort(),
      acl: (await q(RELEASE_READS.relationAcl, [w.table])).filter((r) => r.grantee !== 'owner').map(aclLineFor(spec)).sort(),
      other_column_acl: (await q(RELEASE_READS.columns, [w.table])).filter((c) => !listed.has(c.name))
        .flatMap((c) => columnAcl(spec, c).map((line) => `${c.name} ${line}`)).sort(),
    };
  }
  return { functions, acl_functions: aclFunctions, policies, views, tables, columns, constraints, triggers, privileges, altered, indexes, covers, definer, whole };
}

// --- state text --------------------------------------------------------------------

const list = (values) => [...(values || [])].join(';');
const fnLine = (identity, f) => (f?.exists
  ? `function ${identity}: lang=${f.language} vol=${f.volatility} parallel=${f.parallel} secdef=${f.security_definer === true} result=${f.result} config=${list(f.config)} prosrc=${f.prosrc_sha256} acl=${list(f.acl)}`
  : `function ${identity}: absent`);
const policyLine = (key, p, spec) => (p?.exists
  ? `policy ${key}: cmd=${p.cmd} permissive=${p.permissive === true} roles=${list(p.roles)} qual=${hashOrDash(p.qual)} with_check=${hashOrDash(p.with_check)}${
    spec?.render?.policy_comments === true ? ` comment=${p.comment_sha256 || '-'}` : ''}`
  : `policy ${key}: absent`);
const columnText = (c) => `${c.type} notnull=${c.notnull === true} default=${hashOrDash(c.default)} acl=${list(c.acl)}`;
function tableLines(name, t) {
  if (!t?.exists) return [`table ${name}: absent`];
  return [
    `table ${name}: kind=${t.kind} rls=${t.rls === true} forced=${t.forced === true}`,
    ...(t.columns || []).map((c) => `table ${name} column ${c.name}: ${columnText(c)}`),
    ...(t.constraints || []).map((c) => `table ${name} constraint ${c.name}: ${hashOrDash(c.def)} validated=${c.validated === true}`),
    ...(t.indexes || []).map((i) => `table ${name} index ${i.name}: ${hashOrDash(i.def)}`),
    `table ${name} policies: ${list(t.policies)}`,
    `table ${name} triggers: ${list(t.triggers)}`,
    `table ${name} acl: ${list(t.acl)}`,
  ];
}

/** The canonical state text of one migration (what the fingerprint hashes). */
export function releaseStateText(key, state = {}) {
  const spec = releaseSpec(key);
  const s = state || {};
  const lines = [`release ${key} ${spec.state_version || 'v1'}`];
  for (const fn of spec.functions) lines.push(fnLine(fn.identity, s.functions?.[fn.identity]));
  for (const identity of spec.dropped_functions || []) lines.push(fnLine(identity, s.functions?.[identity]));
  for (const fn of spec.acl_functions || []) {
    const row = s.acl_functions?.[fn.identity];
    if (!row?.exists) {
      lines.push(`function_acl ${fn.identity}: absent`);
      continue;
    }
    // spec attributes (SQL 121): the attributes the file alters and the reviewed body, after the ACL.
    lines.push(`function_acl ${fn.identity}: acl=${list(row.acl)}${fn.attributes
      ? ` secdef=${row.security_definer === true} config=${list(row.config)} prosrc=${row.prosrc_sha256 ?? '-'}` : ''}`);
  }
  for (const p of [...(spec.policies || []), ...(spec.dropped_policies || [])]) {
    const k = objKey(p.table, p.name);
    lines.push(policyLine(k, s.policies?.[k], spec));
  }
  for (const v of spec.views || []) {
    const row = s.views?.[v.name];
    lines.push(row?.exists ? `view ${v.name}: def=${hashOrDash(row.def)} options=${list(row.options)}` : `view ${v.name}: absent`);
  }
  for (const t of spec.tables || []) lines.push(...tableLines(t.name, s.tables?.[t.name]));
  for (const c of spec.added_columns || []) {
    const row = s.columns?.[`${c.table}.${c.column}`];
    lines.push(row?.exists ? `column ${c.table}.${c.column}: ${columnText(row)}` : `column ${c.table}.${c.column}: absent`);
  }
  for (const c of spec.column_acl || []) {
    const row = s.columns?.[`${c.table}.${c.column}`];
    lines.push(row?.exists ? `column ${c.table}.${c.column} acl: ${list(row.acl)}` : `column ${c.table}.${c.column}: absent`);
  }
  for (const c of spec.constraints || []) {
    const row = s.constraints?.[objKey(c.table, c.name)];
    lines.push(row?.exists ? `constraint ${c.table} ${c.name}: ${hashOrDash(row.def)} validated=${row.validated === true}` : `constraint ${c.table} ${c.name}: absent`);
  }
  for (const t of [...(spec.triggers || []), ...(spec.dropped_triggers || [])]) {
    const row = s.triggers?.[objKey(t.table, t.name)];
    lines.push(row?.exists ? `trigger ${t.table} ${t.name}: enabled=${row.enabled} def=${hashOrDash(row.def)}` : `trigger ${t.table} ${t.name}: absent`);
  }
  for (const p of spec.table_privileges || []) {
    const row = s.privileges?.[p.table];
    lines.push(row?.exists ? `privileges ${p.table} ${p.privileges.join(',')}: ${list(row.lines)}` : `privileges ${p.table}: absent`);
  }
  for (const i of spec.indexes || []) {
    const row = s.indexes?.[objKey(i.table, i.name)];
    lines.push(row?.exists ? `index ${i.table} ${i.name}: ${hashOrDash(row.def)}` : `index ${i.table} ${i.name}: absent`);
  }
  for (const u of spec.unique_covers || []) {
    lines.push(`unique ${u.table} ${u.name} (${u.contains.join(',')}): covered=${s.covers?.[objKey(u.table, u.name)]?.covered === true}`);
  }
  for (const w of spec.whole_tables || []) {
    const row = s.whole?.[w.table];
    if (!row?.exists) {
      lines.push(`whole ${w.table}: absent`);
      continue;
    }
    lines.push(
      `whole ${w.table}: rls=${row.rls === true} forced=${row.forced === true}`,
      `whole ${w.table} other policies: ${list(row.other_policies)}`,
      `whole ${w.table} acl: ${list(row.acl)}`,
      `whole ${w.table} other column acl: ${list(row.other_column_acl)}`,
    );
  }
  return lines.join('\n');
}

export const releaseStateHash = (key, state) => sha(releaseStateText(key, state));

/** The state the pinned file leaves (code-derived; null when the file does not parse). */
export function releaseIntendedState(key, text) {
  const spec = releaseSpec(key);
  const defs = releaseFunctionDefinitions(text);
  if (!defs) return null;
  const functions = {};
  for (const fn of spec.functions) {
    const def = defs[fnName(fn.identity)];
    if (!def) return null;
    functions[fn.identity] = {
      exists: true,
      language: def.language,
      volatility: def.volatility,
      parallel: def.parallel,
      security_definer: def.security_definer,
      // A RETURNS TABLE (...) result is stated in the spec (fn.result) as pg_get_function_result
      // renders it (SQL 117); the file's RETURNS clause gives only the word TABLE.
      result: fn.result ?? def.result,
      config: [...def.config],
      prosrc_sha256: sha(def.prosrc),
      acl: [...fn.acl].sort(),
    };
  }
  for (const identity of spec.dropped_functions || []) functions[identity] = { exists: false };
  const aclFunctions = Object.fromEntries((spec.acl_functions || []).map((fn) => [fn.identity, {
    exists: true,
    acl: [...fn.acl].sort(),
    ...(fn.attributes ? {
      security_definer: fn.attributes.security_definer === true,
      config: [...fn.attributes.config].sort(),
      prosrc_sha256: fn.attributes.prosrc_sha256,
    } : {}),
  }]));
  const policies = {};
  for (const p of spec.policies || []) {
    policies[objKey(p.table, p.name)] = {
      exists: true, cmd: p.cmd, permissive: p.permissive !== false, roles: [...p.roles].sort(), qual: collapse(p.qual), with_check: collapse(p.with_check),
      // CREATE POLICY leaves no comment; the file's COMMENT ON POLICY (spec `comment`) sets one.
      ...(spec.render?.policy_comments === true ? { comment_sha256: p.comment == null ? null : sha(p.comment) } : {}),
    };
  }
  for (const p of spec.dropped_policies || []) policies[objKey(p.table, p.name)] = { exists: false };
  const views = Object.fromEntries((spec.views || []).map((v) => [v.name, { exists: true, def: collapse(v.definition), options: [...v.options].sort() }]));
  const tables = {};
  for (const t of spec.tables || []) {
    tables[t.name] = {
      exists: true,
      kind: 'r',
      rls: t.rls === true,
      forced: t.forced === true,
      columns: t.columns.map(([name, type, notnull, def, acl = []]) => ({ name, type, notnull, default: collapse(def), acl: [...acl].sort() })),
      constraints: [...t.constraints].map(([name, def]) => ({ name, def: collapse(def), validated: true })).sort((a, b) => (a.name < b.name ? -1 : 1)),
      indexes: [...t.indexes].map(([name, def]) => ({ name, def: collapse(def) })).sort((a, b) => (a.name < b.name ? -1 : 1)),
      policies: (spec.policies || []).filter((p) => p.table === t.name).map((p) => p.name).sort(),
      triggers: (spec.triggers || []).filter((tr) => tr.table === t.name).map((tr) => tr.name).sort(),
      acl: [...t.acl].sort(),
    };
  }
  const columns = {};
  for (const c of spec.added_columns || []) {
    columns[`${c.table}.${c.column}`] = { exists: true, type: c.type, notnull: c.notnull === true, default: collapse(c.default), acl: [...(c.acl || [])].sort() };
  }
  for (const c of spec.column_acl || []) {
    columns[`${c.table}.${c.column}`] = { ...(columns[`${c.table}.${c.column}`] || { exists: true }), acl: [...c.acl].sort() };
  }
  const constraints = Object.fromEntries((spec.constraints || []).map((c) => [objKey(c.table, c.name), { exists: true, def: collapse(c.def), validated: true }]));
  const triggers = {};
  for (const t of spec.triggers || []) triggers[objKey(t.table, t.name)] = { exists: true, enabled: 'O', def: collapse(t.def) };
  for (const t of spec.dropped_triggers || []) triggers[objKey(t.table, t.name)] = { exists: false };
  const privileges = Object.fromEntries((spec.table_privileges || []).map((p) => [p.table, { exists: true, lines: [...p.intended].sort() }]));
  const indexes = Object.fromEntries((spec.indexes || []).map((i) => [objKey(i.table, i.name), { exists: true, def: collapse(i.def) }]));
  const covers = Object.fromEntries((spec.unique_covers || []).map((u) => [objKey(u.table, u.name), { covered: true }]));
  // Only the policies and grants the file names: no other policy, table grant or column grant.
  const whole = Object.fromEntries((spec.whole_tables || []).map((w) => [w.table, {
    exists: true,
    rls: w.rls === true,
    forced: w.forced === true,
    other_policies: [],
    acl: (spec.table_privileges || []).filter((p) => p.table === w.table).flatMap((p) => p.intended).sort(),
    other_column_acl: [],
  }]));
  return { functions, acl_functions: aclFunctions, policies, views, tables, columns, constraints, triggers, privileges, indexes, covers, whole };
}

export function releaseIntendedHash(key, text) {
  const state = releaseIntendedState(key, text);
  return state ? releaseStateHash(key, state) : null;
}

/**
 * The fingerprint `key` has once `laterKey` replaced some of its functions (SQL 101 replaces
 * one of SQL 90's): every object of `key` as its own file renders it, with the functions both
 * files define as the later file renders them. Pinned on the later migration
 * (superseded_intended_sha256) and re-derived by the tests.
 */
export function releaseSupersededIntendedHash(key, text, laterKey, laterText) {
  const base = releaseIntendedState(key, text);
  const later = releaseIntendedState(laterKey, laterText);
  if (!base || !later) return null;
  for (const [identity, fn] of Object.entries(later.functions)) {
    if (Object.hasOwn(base.functions, identity)) base.functions[identity] = fn;
  }
  return releaseStateHash(key, base);
}

// --- predecessors -------------------------------------------------------------------

/**
 * Whether a predecessor is in place. SQL 29 and SQL 30 by structure (SQL 90 replaces SQL 29's
 * aws_can_manage_mortgage_library and SQL 94 SQL 30's CHECK, so their own fingerprints move
 * on by design); a release migration by its own fingerprint equal to its pin's intended one,
 * or, once a later migration superseded it (SQL 93 after SQL 96), by that later one's. A later
 * migration that replaces only part of it (SQL 101: one of SQL 90's functions) pins
 * superseded_intended_sha256: then every object of the earlier one must still match too.
 */
async function predecessorApplied(client, q, key, library, login) {
  if (key === 'sql29') {
    const s = library?.sql29 || {};
    return SQL29_FUNCTIONS.every((fn) => s.functions?.[fn.identity]?.exists === true)
      && SQL29_POLICIES.every((p) => Boolean(s.policies?.[p.name]))
      && (s.other_policies || []).length === 0;
  }
  if (key === 'sql30') return ['sql30', 'sql94'].includes(library?.sql30?.check?.shape);
  if (!Object.hasOwn(RELEASE_SQL_SPECS, key)) return false;
  const objects = await readObjects(q, releaseSpec(key), login);
  if (releaseStateHash(key, objects) === releasePin(key).intended_replacement_sha256) return true;
  for (const later of RELEASE_SQL_KEYS) {
    if (!(releaseSpec(later).supersedes || []).includes(key)) continue;
    const partial = RELEASE_SQL_PINS[later]?.superseded_intended_sha256?.[key];
    if (partial != null && releaseStateHash(key, objects) !== partial) continue;
    if (await predecessorApplied(client, q, later, library, login)) return true;
  }
  return false;
}

// --- the state ----------------------------------------------------------------------

/** One migration's state: login, prerequisites, predecessors, successors, its objects and counts. */
export async function readReleaseSqlState(client, key, { counts = true } = {}) {
  const spec = releaseSpec(key);
  const q = async (sql, params = []) => ((await client.query(sql, params))?.rows || []);
  await q(RELEASE_READS.searchPath);
  const login = (await q(RELEASE_READS.login))[0] || {};
  const prerequisites = {};
  for (const name of spec.prerequisites) prerequisites[name] = await prerequisitePresent(q, name);
  const needsLibrary = (spec.predecessors || []).some((p) => p === 'sql29' || p === 'sql30') || spec.reads_library === true;
  const library = needsLibrary ? (await readLibrarySqlState(client, { counts: false })).details : null;
  await q(RELEASE_READS.searchPath);
  const predecessors = {};
  for (const p of spec.predecessors || []) predecessors[p] = await predecessorApplied(client, q, p, library, login.current_user);
  const refuseAfter = {};
  for (const marker of spec.refuse_after || []) refuseAfter[marker.key] = await prerequisitePresent(q, marker.object);
  const objects = await readObjects(q, spec, login.current_user);
  // Objects (other than the trigger the file drops first) still using a function it drops.
  const dependents = {};
  const droppedTrigger = (spec.dropped_triggers || [])[0] || null;
  for (const identity of spec.dropped_functions || []) {
    const deps = (await q(RELEASE_READS.functionDependents, [identity]))[0]?.n ?? 0;
    const trig = droppedTrigger ? (await q(RELEASE_READS.functionTriggers, [identity, droppedTrigger.table, droppedTrigger.name]))[0]?.n ?? 0 : 0;
    dependents[identity] = Number(deps) + Number(trig);
  }
  const dropped = spec.dropped_functions || [];
  const callers = dropped.length
    ? (await q(RELEASE_READS.functionCallers, [dropped, dropped.map(fnName).filter(Boolean)])).map((row) => String(row.name))
    : [];
  const state = {
    current_user: login.current_user ?? null,
    session_user: login.session_user ?? null,
    prerequisites,
    prerequisites_missing: Object.entries(prerequisites).filter(([, v]) => !v).map(([k]) => k),
    predecessors,
    predecessors_applied: Object.values(predecessors).every(Boolean),
    successors_applied: Object.entries(refuseAfter).filter(([, v]) => v).map(([k]) => k),
    library_sql30_check_shape: library?.sql30?.check?.shape ?? (spec.reads_library ? 'absent' : null),
    dependents,
    dropped_function_callers: callers,
    ...objects,
  };
  state.live_definition_sha256 = releaseStateHash(key, objects);
  if (counts && spec.counts) {
    state.counts = {};
    for (const [name, count] of Object.entries(spec.counts)) {
      let present = true;
      for (const object of count.requires || []) present = present && await prerequisitePresent(q, object);
      const out = present ? await guardedCount(client, `release_${key}_${name}`, count.sql) : { readable: false };
      state.counts[name] = out.readable ? out.n : null;
    }
    await q(RELEASE_READS.searchPath);
  }
  return ok(state);
}

// --- rules --------------------------------------------------------------------------

const PUBLIC_EXECUTE = 'PUBLIC EXECUTE';
const grantee = (line) => String(line).split(' ')[0];

/**
 * A table the file creates with CREATE TABLE IF NOT EXISTS that may already exist (SQL 98's
 * platform_billing_destination: no repository SQL created it). The file keeps its columns,
 * constraints and indexes, so those must already be the intended ones (and FORCE off); it
 * enables RLS, drops every other policy, recreates its trigger and revokes every privilege of
 * the roles in `revokes_from` before granting, so live policies may be anything, triggers only
 * the file's own and privileges only of those roles. Owned by the login (the file alters it).
 */
function preexistingTableTakeover(t, live, want) {
  const structural = (x) => tableLines(t.name, { ...x, rls: false, policies: [], triggers: [], acl: [], columns: (x.columns || []).map((c) => ({ ...c, acl: [] })) });
  const revocable = new Set(['owner', ...(t.revokes_from || [])]);
  const liveLines = want ? structural(live) : [];
  const wantLines = want ? structural(want) : [];
  // Names only (column, constraint or index name, or the table line), never definitions or rows.
  const lineName = (line) => line.slice(`table ${t.name}`.length).replace(/:.*$/, '').trim() || 'table';
  const uniq = (values) => [...new Set(values)].sort();
  const differing = uniq([...liveLines.filter((l) => !wantLines.includes(l)), ...wantLines.filter((l) => !liveLines.includes(l))].map(lineName));
  return {
    owner_is_login: live.owner_is_login === true,
    // The shape is ordered (columns by attnum): the same lines in another order still differ.
    shape_matches: same(liveLines, wantLines),
    shape_differs: differing.length === 0 && !same(liveLines, wantLines) ? ['order'] : differing,
    unexpected_triggers: (live.triggers || []).filter((name) => !(want?.triggers || []).includes(name)).sort(),
    unexpected_acl_grantees: uniq((live.acl || []).map(grantee).filter((g) => !revocable.has(g))),
    unexpected_column_acl_grantees: uniq((live.columns || []).flatMap((c) => (c.acl || []).map(grantee)).filter((g) => !revocable.has(g))),
  };
}

function preexistingTableReplaceable(t, live, want) {
  if (!want) return false;
  const d = preexistingTableTakeover(t, live, want);
  return d.owner_is_login && d.shape_matches && d.unexpected_triggers.length === 0
    && d.unexpected_acl_grantees.length === 0 && d.unexpected_column_acl_grantees.length === 0;
}

/**
 * Rules both environments apply before the migration runs. `environment` is 'production'
 * (the default, the strict rules) or 'staging' (the guarded staging executor); it only
 * changes rules that differ by environment (SQL 98's fee destination).
 */
export function releaseSharedPreconditionFailures(key, state, text, { environment = 'production' } = {}) {
  const spec = releaseSpec(key);
  const s = state || {};
  const intended = text != null ? releaseIntendedState(key, text) : null;
  const fnRows = spec.functions.map((fn) => [fn, s.functions?.[fn.identity] || { exists: false }]);
  const aclRows = (spec.acl_functions || []).map((fn) => [fn, s.acl_functions?.[fn.identity] || { exists: false }]);
  const tableOk = (t) => {
    const live = s.tables?.[t.name];
    if (!live?.exists) return true;
    if (!intended) return false;
    if (t.may_preexist === true) return preexistingTableReplaceable(t, live, intended.tables[t.name]);
    return same(tableLines(t.name, live), tableLines(t.name, intended.tables[t.name]));
  };
  const columnOk = (c) => {
    const live = s.columns?.[`${c.table}.${c.column}`];
    const want = intended?.columns?.[`${c.table}.${c.column}`];
    return !live?.exists || (want && same(columnText(live), columnText(want)));
  };
  const checks = [
    ['prerequisites_present', Array.isArray(s.prerequisites_missing) && s.prerequisites_missing.length === 0],
    ['predecessors_applied', s.predecessors_applied === true],
    ['successors_not_applied', Array.isArray(s.successors_applied) && s.successors_applied.length === 0],
    ['altered_relations_owned_by_login', Object.values(s.altered || {}).every((r) => r.exists && r.owner_is_login === true)],
    ['functions_owned_by_login', fnRows.every(([, row]) => !row.exists || row.owner_is_login === true)],
    // SQL 103: the function whose ACL the file sets must exist and be owned by the login (only the
    // owner's own entries can be revoked), and hold only entries the file keeps or revokes.
    ['acl_functions_present', aclRows.every(([, row]) => row.exists === true)],
    ['acl_functions_owned_by_login', aclRows.every(([, row]) => !row.exists || row.owner_is_login === true)],
    ['acl_functions_acl_replaceable', aclRows.every(([fn, row]) => !row.exists || (row.acl || []).every((line) => (
      fn.acl.includes(line) || (fn.revokes || []).includes(line))))],
    // SQL 121: a function the file makes SECURITY DEFINER must have the reviewed body.
    ['acl_functions_body_reviewed', aclRows.every(([fn, row]) => !row.exists || !fn.attributes
      || row.prosrc_sha256 === fn.attributes.prosrc_sha256)],
    ['dropped_functions_owned_by_login', (spec.dropped_functions || []).every((identity) => !s.functions?.[identity]?.exists || s.functions[identity].owner_is_login === true)],
    ['function_results_match', fnRows.every(([fn, row]) => !row.exists || !intended || row.result === intended.functions[fn.identity].result)],
    // An EXECUTE grant the file neither keeps nor revokes would survive CREATE OR REPLACE.
    ['function_acl_replaceable', fnRows.every(([fn, row]) => !row.exists || (row.acl || []).every((line) => (
      fn.acl.includes(line) || (fn.revokes || [PUBLIC_EXECUTE]).includes(line))))],
    ['created_tables_absent_or_intended', (spec.tables || []).every(tableOk)],
    ['added_columns_absent_or_intended', (spec.added_columns || []).every(columnOk)],
    // Every live column grant is one the file keeps or revokes (SQL 100: revokes; with
    // render.grantors only the owner's own grants are revocable by the owner).
    ['column_acl_replaceable', (spec.column_acl || []).every((c) => {
      const live = s.columns?.[`${c.table}.${c.column}`];
      return live?.exists === true && (live.acl || []).every((line) => c.acl.includes(line) || (c.revokes || []).includes(line));
    })],
    ['added_indexes_absent_or_intended', (spec.indexes || []).every((i) => {
      const live = s.indexes?.[objKey(i.table, i.name)];
      return !live?.exists || live.def === collapse(i.def);
    })],
    ['definer_can_write_relations', (spec.definer_writes || []).every((table) => s.definer?.[table] === true)],
    // SQL 98: with duplicates and no covering unique index the file only warns and skips the
    // index, so the post-state would not be fixed; refuse instead.
    ['unique_covered_or_no_duplicates', (spec.unique_covers || []).every((u) => (
      s.covers?.[objKey(u.table, u.name)]?.covered === true || s.counts?.[u.duplicates_count] === 0))],
    ['dropped_functions_have_no_other_dependents', Object.values(s.dependents || {}).every((n) => n === 0)],
    // plpgsql / EXECUTE callers are not in pg_depend; a function body naming a dropped function would break.
    ['dropped_functions_not_called_by_other_functions', Array.isArray(s.dropped_function_callers) && s.dropped_function_callers.length === 0],
  ];
  for (const extra of spec.extra_preconditions || []) {
    if (extra === 'doc_type_check_supported') {
      checks.push(['doc_type_check_supported', ['predecessor_3', 'predecessor_6', 'sql30', 'sql94'].includes(s.library_sql30_check_shape)]);
    }
    if (extra === 'no_rows_outside_sql94_rule') checks.push(['no_rows_outside_sql94_rule', s.counts?.rows_outside_sql94_rule === 0]);
    // SQL 98: the file raises 23505 on duplicate tenant periods; refuse before it runs.
    if (extra === 'no_duplicate_billing_periods') checks.push(['no_duplicate_billing_periods', s.counts?.duplicate_billing_periods === 0]);
    // SQL 98: a pre-existing platform_billing_destination is taken over only while it is empty or
    // holds exactly the reviewed row (production; staging's rule follows below): one production row on the owner-confirmed platform account
    // (41cb5d67-..., 2026-10-17), with a payment method, verified, and no sandbox row. Any other
    // row would become the fee destination unreviewed.
    if (extra === 'platform_billing_destination_absent_empty_or_reviewed') {
      const c = s.counts || {};
      // Staging (Moov sandbox, owner decision 2026-10-17, option A): exactly one verified sandbox
      // row with a payment method and no production row; the sandbox account is not compared
      // with a reviewed id (none is recorded). Production keeps the reviewed-row rule.
      const reviewedRow = environment === 'staging'
        ? c.platform_billing_destination_rows === 1 && c.platform_billing_destination_sandbox_rows === 1
          && c.platform_billing_destination_production_rows === 0
          && c.platform_billing_destination_payment_method_rows === 1 && c.platform_billing_destination_verified_rows === 1
        : c.platform_billing_destination_rows === 1 && c.platform_billing_destination_production_reviewed_account_rows === 1
          && c.platform_billing_destination_payment_method_rows === 1 && c.platform_billing_destination_verified_rows === 1;
      checks.push(['platform_billing_destination_absent_empty_or_reviewed', s.tables?.['public.platform_billing_destination']?.exists !== true
        || c.platform_billing_destination_rows === 0
        || reviewedRow === true]);
    }
    // SQL 98: the per-check default price exists (an active row), or the file seeds it (no row).
    if (extra === 'check_billing_config_active_or_empty') {
      checks.push(['check_billing_config_active_or_empty', s.counts?.check_billing_config_active_rows > 0 || s.counts?.check_billing_config_rows === 0]);
    }
  }
  return failed(checks);
}

/** Rules both environments apply after the migration ran, inside the transaction. */
export function releaseSharedPostconditionFailures(key, before, after, pin) {
  const spec = releaseSpec(key);
  const a = after || {};
  const b = before || {};
  return failed([
    ['intended_state', a.live_definition_sha256 === pin?.intended_replacement_sha256],
    ['functions_owned_by_login', spec.functions.every((fn) => a.functions?.[fn.identity]?.owner_is_login === true)],
    // SQL 103: only the ACL of an acl_functions entry changes (body, attributes and owner as before);
    // SQL 121: also SECURITY DEFINER and proconfig when the entry declares attributes.
    ['acl_functions_otherwise_unchanged', (spec.acl_functions || []).every((fn) => {
      const was = b.acl_functions?.[fn.identity];
      const now = a.acl_functions?.[fn.identity];
      if (!was?.exists || !now?.exists) return false;
      // spec attributes (SQL 121): SECURITY DEFINER and proconfig are set by the file (and fixed by
      // the fingerprint); everything else, the body included, stays as it was.
      const altered = fn.attributes ? ['acl', 'security_definer', 'config'] : ['acl'];
      const rest = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !altered.includes(k)));
      return same(rest(was), rest(now)) && now.owner_is_login === true;
    })],
    ['created_tables_owned_by_login', (spec.tables || []).every((t) => a.tables?.[t.name]?.owner_is_login === true)],
    ['altered_relations_owner_unchanged', Object.entries(b.altered || {}).every(([name, row]) => a.altered?.[name]?.owner_is_login === row.owner_is_login)],
    // Table privileges the file does not name are unchanged (SQL 97).
    ['other_table_privileges_unchanged', (spec.table_privileges || []).every((p) => same(a.privileges?.[p.table]?.other, b.privileges?.[p.table]?.other))],
  ]);
}

// --- unrelated catalog ----------------------------------------------------------------

/** What one migration may change; everything else in schema public (and auth's functions) must not. */
export function releaseUnrelatedScope(key) {
  const spec = releaseSpec(key);
  const objectName = (table, name) => `${table}.${name}`;
  return {
    skip_relations: (spec.tables || []).map((t) => t.name),
    acl_relations: (spec.table_privileges || []).map((p) => p.table),
    skip_columns: [...(spec.added_columns || []), ...(spec.column_acl || [])].map((c) => objectName(c.table, c.column)),
    skip_constraints: [...(spec.constraints || []), ...(spec.added_constraints || [])].map((c) => objectName(c.table, c.name)),
    // PostgreSQL 18 records a column's NOT NULL as a named constraint (contype 'n'): the one on a
    // column the migration adds is that column's change (SQL 98: tenants.deposits_enabled).
    skip_not_null_columns: (spec.added_columns || []).map((c) => objectName(c.table, c.column)),
    skip_policies: [...(spec.policies || []), ...(spec.dropped_policies || [])].map((p) => objectName(p.table, p.name)),
    // An acl_functions entry is skipped too (its ACL changes); acl_functions_otherwise_unchanged
    // covers the rest of it.
    skip_functions: [...spec.functions.map((fn) => fn.identity), ...(spec.dropped_functions || []), ...(spec.acl_functions || []).map((fn) => fn.identity)],
    skip_triggers: [...(spec.triggers || []), ...(spec.dropped_triggers || [])].map((t) => objectName(t.table, t.name)),
    skip_views: (spec.views || []).map((v) => v.name),
    // Indexes a migration creates on an existing table (SQL 98: the tenant period index and the
    // check_billing_events unique index it adds only when none covers the pair); its own
    // tables' indexes are skipped with them.
    skip_indexes: [...(spec.indexes || []).map((i) => `public.${i.name}`), ...(spec.added_indexes || [])],
  };
}

// $1: relations created by the migration (skipped with their indexes, columns, constraints, policies and triggers).
const SKIPPED_REL = (oid) => `EXISTS (SELECT 1 FROM unnest($1::text[]) x WHERE pg_catalog.to_regclass(x) = ${oid})`;
const RELEASE_UNRELATED_SQL = Object.freeze({
  // $4: the spec's views. Their reloptions are fingerprinted with the view (spec.views), so a
  // migration may set them (security_invoker); owner, ACL and RLS flags stay here.
  relations: `SELECT c.oid::regclass::text || ' ' || c.relkind::text || ' ' || pg_catalog.pg_get_userbyid(c.relowner) || ' '
  || c.relrowsecurity::text || ' ' || c.relforcerowsecurity::text || ' '
  || CASE WHEN (n.nspname || '.' || c.relname) = ANY ($4::text[]) THEN '<options in spec>' ELSE COALESCE(c.reloptions::text, '') END || ' '
  || CASE WHEN (n.nspname || '.' || c.relname) = ANY ($2::text[]) THEN '<acl ignored>' ELSE COALESCE(c.relacl::text, '') END AS d
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT ${SKIPPED_REL('c.oid')}
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid = c.oid AND ${SKIPPED_REL('i.indrelid')})
  AND NOT ((n.nspname || '.' || c.relname) = ANY ($3::text[]))
ORDER BY 1`,
  columns: `SELECT a.attrelid::regclass::text || ' ' || a.attnum::text || ' ' || a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod)
  || ' ' || a.attnotnull::text || ' ' || COALESCE(a.attacl::text, '') || ' ' || COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '') AS d
FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
  AND NOT ${SKIPPED_REL('c.oid')} AND NOT ((n.nspname || '.' || c.relname || '.' || a.attname) = ANY ($2::text[]))
ORDER BY 1`,
  constraints: `SELECT COALESCE(con.conrelid::regclass::text, '-') || ' ' || con.conname || ' ' || con.contype::text || ' ' || pg_catalog.pg_get_constraintdef(con.oid) AS d
FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
LEFT JOIN pg_catalog.pg_class r ON r.oid = con.conrelid
WHERE n.nspname = 'public' AND NOT ${SKIPPED_REL('con.conrelid')}
  AND NOT ((n.nspname || '.' || COALESCE(r.relname, '') || '.' || con.conname) = ANY ($2::text[]))
  AND NOT (con.contype = 'n' AND (n.nspname || '.' || COALESCE(r.relname, '') || '.' || COALESCE((SELECT a.attname FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1]), '')) = ANY ($3::text[]))
ORDER BY 1`,
  policies: `SELECT c.oid::regclass::text || ' ' || pol.polname || ' ' || pol.polcmd::text || ' ' || pol.polpermissive::text || ' ' || pol.polroles::text
  || ' ' || COALESCE(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || COALESCE(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS d
FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT ${SKIPPED_REL('c.oid')} AND NOT ((n.nspname || '.' || c.relname || '.' || pol.polname) = ANY ($2::text[]))
ORDER BY 1`,
  // Every attribute (strictness, result type, language, kind, defaults, leakproof, parallel,
  // cost/rows, the full pg_get_functiondef), not only the ones a spec fingerprints.
  functions: `SELECT p.oid::regprocedure::text || ' ' || pg_catalog.pg_get_userbyid(p.proowner) || ' ' || md5(p.prosrc) || ' '
  || p.prosecdef::text || ' ' || p.provolatile::text || ' ' || COALESCE(p.proconfig::text, '') || ' ' || COALESCE(p.proacl::text, '')
  || ' strict=' || p.proisstrict::text || ' ret=' || p.prorettype::regtype::text || ' retset=' || p.proretset::text
  || ' lang=' || l.lanname || ' kind=' || p.prokind::text || ' leakproof=' || p.proleakproof::text || ' parallel=' || p.proparallel::text
  || ' cost=' || p.procost::text || ' rows=' || p.prorows::text
  || ' args=' || pg_catalog.pg_get_function_arguments(p.oid) || ' result=' || COALESCE(pg_catalog.pg_get_function_result(p.oid), '')
  || ' def=' || CASE WHEN p.prokind IN ('f', 'p') THEN md5(pg_catalog.pg_get_functiondef(p.oid)) ELSE '-' END AS d
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang
WHERE n.nspname IN ('public', 'auth') AND NOT EXISTS (SELECT 1 FROM unnest($1::text[]) x WHERE pg_catalog.to_regprocedure(x) = p.oid)
ORDER BY 1`,
  // Index definitions (the relations category sees only their names and owners).
  indexes: `SELECT c.oid::regclass::text || ' ' || pg_catalog.pg_get_indexdef(i.indexrelid) || ' valid=' || i.indisvalid::text AS d
FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT ${SKIPPED_REL('i.indrelid')} AND NOT ((n.nspname || '.' || c.relname) = ANY ($2::text[]))
ORDER BY 1`,
  // Default privileges of every role (ALTER DEFAULT PRIVILEGES).
  default_acl: `SELECT pg_catalog.pg_get_userbyid(d.defaclrole) || ' ' || COALESCE(n.nspname, '-') || ' ' || d.defaclobjtype::text || ' '
  || COALESCE(d.defaclacl::text, '') AS d
FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
ORDER BY 1`,
  // Role memberships (GRANT <role> TO <role>).
  role_memberships: `SELECT pg_catalog.pg_get_userbyid(m.roleid) || ' ' || pg_catalog.pg_get_userbyid(m.member) || ' admin=' || m.admin_option::text AS d
FROM pg_catalog.pg_auth_members m ORDER BY 1`,
  // Role attributes (LOGIN, SUPERUSER, BYPASSRLS, INHERIT, ...): names and flags only.
  roles: `SELECT r.rolname || ' super=' || r.rolsuper::text || ' inherit=' || r.rolinherit::text || ' createrole=' || r.rolcreaterole::text
  || ' createdb=' || r.rolcreatedb::text || ' login=' || r.rolcanlogin::text || ' replication=' || r.rolreplication::text
  || ' bypassrls=' || r.rolbypassrls::text AS d
FROM pg_catalog.pg_roles r ORDER BY 1`,
  triggers: `SELECT t.tgrelid::regclass::text || ' ' || t.tgname || ' ' || t.tgenabled::text || ' ' || pg_catalog.pg_get_triggerdef(t.oid) AS d
FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal AND NOT ${SKIPPED_REL('c.oid')}
  AND NOT ((n.nspname || '.' || c.relname || '.' || t.tgname) = ANY ($2::text[]))
ORDER BY 1`,
  views: `SELECT c.oid::regclass::text || ' ' || md5(pg_catalog.pg_get_viewdef(c.oid)) AS d
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm') AND NOT ((n.nspname || '.' || c.relname) = ANY ($1::text[]))
ORDER BY 1`,
  types: `SELECT t.oid::regtype::text || ' ' || t.typtype::text || ' ' || pg_catalog.pg_get_userbyid(t.typowner) || ' '
  || COALESCE((SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid), '') AS d
FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd') ORDER BY 1`,
  schema: `SELECT n.nspname || ' ' || pg_catalog.pg_get_userbyid(n.nspowner) || ' ' || COALESCE(n.nspacl::text, '') AS d
FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public', 'auth') ORDER BY 1`,
});

/** Hashes, by category, of everything the migration must not change. */
export async function readReleaseUnrelatedSnapshot(client, key) {
  const scope = releaseUnrelatedScope(key);
  const params = {
    relations: [scope.skip_relations, scope.acl_relations, scope.skip_indexes, scope.skip_views],
    columns: [scope.skip_relations, scope.skip_columns],
    constraints: [scope.skip_relations, scope.skip_constraints, scope.skip_not_null_columns],
    policies: [scope.skip_relations, scope.skip_policies],
    functions: [scope.skip_functions],
    triggers: [scope.skip_relations, scope.skip_triggers],
    views: [scope.skip_views],
    indexes: [scope.skip_relations, scope.skip_indexes],
  };
  await client.query(RELEASE_READS.searchPath);
  const categories = {};
  const counts = {};
  for (const [name, sql] of Object.entries(RELEASE_UNRELATED_SQL)) {
    const rows = (await client.query(sql, params[name] || []))?.rows || [];
    categories[name] = sha(rows.map((row) => row.d).join('\n'));
    counts[name] = rows.length;
  }
  return { categories, counts, sha256: sha(JSON.stringify(categories)) };
}

export function releaseChangedCategories(before, after) {
  return Object.keys(before?.categories || {}).filter((name) => before.categories[name] !== after?.categories?.[name]);
}

// --- report -------------------------------------------------------------------------

const label = (live, want) => {
  if (!live?.exists) return want?.exists === false ? 'intended' : 'absent';
  if (want?.exists === false) return 'present';
  return want && same(live, want) ? 'intended' : 'different';
};

/**
 * Readable, non-sensitive report (no owner names, definitions or rows) for read-live and
 * inspect: per object 'intended' | 'different' | 'absent' (| 'present' for one the file
 * drops), prerequisites, predecessors and the declared aggregate counts.
 */
export function releaseSqlReport(key, state, text) {
  const spec = releaseSpec(key);
  const s = state || {};
  const want = text != null ? releaseIntendedState(key, text) : null;
  const strip = (row) => {
    if (!row || !row.exists) return row;
    const { owner_is_login: _o, ...rest } = row;
    return rest;
  };
  const objectLabels = (entries) => entries.map(([name, live, intended]) => ({ name, state: label(strip(live), intended) }));
  return {
    live_definition_sha256: s.live_definition_sha256 ?? null,
    prerequisites_missing: [...(s.prerequisites_missing || [])],
    predecessors: { ...(s.predecessors || {}) },
    successors_applied: [...(s.successors_applied || [])],
    functions: objectLabels([...spec.functions.map((fn) => fn.identity), ...(spec.dropped_functions || [])]
      .map((identity) => [identity.replace(/^public\./, ''), s.functions?.[identity], want?.functions?.[identity]])),
    policies: objectLabels([...(spec.policies || []), ...(spec.dropped_policies || [])]
      .map((p) => [objKey(p.table, p.name).replace(/^public\./, ''), s.policies?.[objKey(p.table, p.name)], want?.policies?.[objKey(p.table, p.name)]])),
    views: objectLabels((spec.views || []).map((v) => [v.name.replace(/^public\./, ''), s.views?.[v.name], want?.views?.[v.name]])),
    tables: (spec.tables || []).map((t) => {
      const live = s.tables?.[t.name];
      const intended = want?.tables?.[t.name];
      return {
        name: t.name.replace(/^public\./, ''),
        state: !live?.exists ? 'absent' : (intended && same(tableLines(t.name, live), tableLines(t.name, intended)) ? 'intended' : 'different'),
        rls: live?.rls === true,
        column_count: (live?.columns || []).length,
        policy_count: (live?.policies || []).length,
        // A pre-existing table the file may take over: why it would be refused, by name only.
        ...(t.may_preexist === true && live?.exists && intended ? { takeover: preexistingTableTakeover(t, live, intended) } : {}),
      };
    }),
    columns: [
      ...objectLabels((spec.added_columns || [])
        .map((c) => [`${c.table}.${c.column}`.replace(/^public\./, ''), s.columns?.[`${c.table}.${c.column}`], want?.columns?.[`${c.table}.${c.column}`]])),
      ...(spec.column_acl || []).map((c) => {
        const live = s.columns?.[`${c.table}.${c.column}`];
        const intended = want?.columns?.[`${c.table}.${c.column}`];
        return {
          name: `${c.table}.${c.column} acl`.replace(/^public\./, ''),
          state: !live?.exists ? 'absent' : (intended && same(live.acl, intended.acl) ? 'intended' : 'different'),
          acl: [...(live?.acl || [])],
        };
      }),
    ],
    constraints: objectLabels((spec.constraints || []).map((c) => [objKey(c.table, c.name).replace(/^public\./, ''), s.constraints?.[objKey(c.table, c.name)], want?.constraints?.[objKey(c.table, c.name)]])),
    triggers: objectLabels([...(spec.triggers || []), ...(spec.dropped_triggers || [])]
      .map((t) => [objKey(t.table, t.name).replace(/^public\./, ''), s.triggers?.[objKey(t.table, t.name)], want?.triggers?.[objKey(t.table, t.name)]])),
    // The pinned privilege lines, and (informational) any non-owner UPDATE / DELETE / TRUNCATE
    // grant on the same table, which the file leaves as it is (SQL 97: its guard is INSERT only).
    table_privileges: (spec.table_privileges || []).map((p) => ({
      name: p.table.replace(/^public\./, ''),
      lines: [...(s.privileges?.[p.table]?.lines || [])],
      other_write_grants: (s.privileges?.[p.table]?.other || [])
        .filter((line) => !line.startsWith('owner ') && ['UPDATE', 'DELETE', 'TRUNCATE'].includes(line.split(' ')[1])),
    })),
    function_acl: spec.functions.map((fn) => ({ name: fn.identity.replace(/^public\./, ''), acl: [...(s.functions?.[fn.identity]?.acl || [])] })),
    // SQL 103: functions whose ACL only the file sets ('intended' | 'different' | 'absent', and the ACL).
    acl_functions: (spec.acl_functions || []).map((fn) => {
      const live = s.acl_functions?.[fn.identity];
      const intended = want?.acl_functions?.[fn.identity] ?? {
        acl: [...fn.acl].sort(),
        ...(fn.attributes ? {
          security_definer: fn.attributes.security_definer === true,
          config: [...fn.attributes.config].sort(),
          prosrc_sha256: fn.attributes.prosrc_sha256,
        } : {}),
      };
      const attrs = (row) => (fn.attributes ? [row?.security_definer === true, list(row?.config), row?.prosrc_sha256 ?? null] : []);
      return {
        name: fn.identity.replace(/^public\./, ''),
        state: !live?.exists ? 'absent' : (same(live.acl, intended.acl) && same(attrs(live), attrs(intended)) ? 'intended' : 'different'),
        acl: [...(live?.acl || [])],
        // SQL 121: the attributes the file sets, and whether the body is the reviewed one (never the body).
        ...(fn.attributes && live?.exists ? {
          security_definer: live.security_definer === true,
          config: [...(live.config || [])],
          body_reviewed: live.prosrc_sha256 === fn.attributes.prosrc_sha256,
        } : {}),
      };
    }),
    indexes: objectLabels((spec.indexes || []).map((i) => [objKey(i.table, i.name).replace(/^public\./, ''), s.indexes?.[objKey(i.table, i.name)], want?.indexes?.[objKey(i.table, i.name)]])),
    unique_covers: (spec.unique_covers || []).map((u) => ({
      name: objKey(u.table, u.name).replace(/^public\./, ''), columns: [...u.contains], covered: s.covers?.[objKey(u.table, u.name)]?.covered === true,
    })),
    definer_writes: (spec.definer_writes || []).map((table) => ({ name: table.replace(/^public\./, ''), ok: s.definer?.[table] === true })),
    // spec.render.policy_comments: whether each policy carries a comment (never its text).
    policy_comments: spec.render?.policy_comments === true
      ? (spec.policies || []).map((p) => ({ name: objKey(p.table, p.name).replace(/^public\./, ''), present: Boolean(s.policies?.[objKey(p.table, p.name)]?.comment_sha256) }))
      : null,
    dropped_function_dependents: Object.values(s.dependents || {}).reduce((n, v) => n + (Number(v) || 0), 0),
    // Names and a count only (never the bodies).
    dropped_function_callers: [...(s.dropped_function_callers || [])].map((name) => name.replace(/^public\./, '')),
    dropped_function_caller_count: (s.dropped_function_callers || []).length,
    doc_type_check_shape: s.library_sql30_check_shape ?? null,
    counts: s.counts ?? null,
  };
}
