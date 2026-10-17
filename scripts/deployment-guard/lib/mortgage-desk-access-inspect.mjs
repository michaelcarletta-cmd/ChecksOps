/**
 * Read-only production inspect of the Mortgage Desk access surface (inspect only; there is no
 * apply). It answers, for production, what RLS, grants, helper functions and triggers are
 * really live on the Mortgage Desk tables, and whether SQL 99's ownership preconditions hold.
 *
 * One transaction: BEGIN READ ONLY, search_path pg_catalog, statement and lock timeouts,
 * then a fixed list of catalog SELECTs (pg_class, pg_policy, pg_depend, pg_attribute,
 * pg_trigger, pg_proc, pg_roles, pg_auth_members, pg_enum and the has_*_privilege
 * functions), then ROLLBACK. It reads no table rows: not even aggregate counts.
 *
 * Output is names, booleans, hashes and counts:
 *   - tables      owner, RLS enabled / forced, every policy (name, command, permissive,
 *                 roles, USING / WITH CHECK text and sha256, the functions it depends on,
 *                 whether a repository SQL file creates a policy of that name on the table),
 *                 table and column ACL entries and effective privileges for checksops,
 *                 authenticated, PUBLIC and checksops_admin, and the non-internal triggers
 *                 (name and function name only)
 *   - functions   the named helpers, every function a policy above depends on and the
 *                 trigger functions SQL 99 relies on: existence, owner, SECURITY DEFINER,
 *                 sha256 of pg_get_functiondef and of prosrc, and whether prosrc matches a
 *                 repository definition (exactly or up to whitespace). The definition text
 *                 is printed only when it matches no repository definition AND passes
 *                 definitionTextSafety (no literals beyond role and schema names, no comment,
 *                 no unknown "quoted identifier", no id, email or long number anywhere);
 *                 otherwise "differs from repo" without text.
 *   - ownership   SQL 99: the mirror and case-assign trigger functions, homeowner_ledger_events,
 *                 profiles, check_cases (owner, RLS / FORCE) and the file's own preconditions
 *                 as booleans.
 *
 * Policy expressions are printed only under the same literal allowlist as function text
 * (expressionReport); otherwise only their sha256. A failure (connecting included) reports
 * the stage and the error's code / SQLSTATE only: no message, host or stack.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail, ok } from './errors.mjs';

export const INSPECT_ID = 'mortgage-desk-access-production-inspect';
export const CONFIG_REL = 'ops/deployment-guard/mortgage-desk-access-production-inspect.json';

/** The four Mortgage Desk tables whose policies, grants and triggers are reported. */
export const DESK_TABLES = Object.freeze([
  'mortgage_handling_requests',
  'check_intake_items',
  'check_messages',
  'mortgage_agent_accounts',
]);
/** Tables SQL 99's trigger chain reaches (owner and RLS / FORCE only). */
export const OWNERSHIP_TABLES = Object.freeze(['homeowner_ledger_events', 'profiles', 'check_cases']);
/** Grantees whose privileges are reported ('PUBLIC' is the pseudo-role 0). */
export const GRANTEES = Object.freeze(['checksops', 'authenticated', 'PUBLIC', 'checksops_admin']);
const ROLE_GRANTEES = GRANTEES.filter((g) => g !== 'PUBLIC');
/** Helpers asked for by name (schema-qualified, any signature). */
export const NAMED_FUNCTIONS = Object.freeze([
  'public.aws_can_write_tenant',
  'public.aws_can_access_tenant',
  'public.aws_is_tenant_member',
  'public.aws_is_cross_tenant_reader',
  'public.aws_is_active_mortgage_agent',
  'public.mortgage_agent_can_view_check',
  'auth.uid',
]);
/** SQL 99's trigger chain: trigger name -> the table it is expected on. */
export const OWNERSHIP_TRIGGERS = Object.freeze({
  trg_mirror_check_message_to_homeowner_ledger: 'check_messages',
  assign_case_on_ledger_events: 'homeowner_ledger_events',
});
export const SQL99_FUNCTIONS = Object.freeze(['public.aws_mortgage_desk_appended_note', 'public.aws_mortgage_desk_completion_messages']);
export const SQL99_TRIGGER = 'tr_mortgage_desk_completion_messages';
/** The columns aws/workflows/sql/99_mortgage_desk_completion_messages.sql refuses without. */
export const SQL99_COLUMNS = Object.freeze({
  check_messages: ['check_id', 'sender_id', 'body', 'is_deleted', 'created_at'],
  mortgage_handling_requests: ['id', 'status', 'check_intake_item_id', 'assigned_employee_id', 'mortgage_company', 'mortgage_servicer', 'work_notes'],
});

const TABLE_PRIVILEGES = Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']);
const COLUMN_PRIVILEGES = Object.freeze(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']);
const POLCMD = Object.freeze({ r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' });
const VOLATILITY = Object.freeze({ i: 'IMMUTABLE', s: 'STABLE', v: 'VOLATILE' });

/** Application role values (tenant_users.role, user_roles.role) that count as role names in literals. */
export const APP_ROLE_WORDS = Object.freeze([
  'owner', 'admin', 'manager', 'member', 'staff', 'viewer', 'read_only', 'collaborator', 'mortgage_agent',
  'contractor', 'client', 'homeowner', 'vendor', 'subcontractor', 'sales_rep', 'assistant', 'operator',
  'platform_owner',
]);
/** Schema names that appear as literals in a rendered SET search_path. */
const SCHEMA_WORDS = Object.freeze(['public', 'auth', 'pg_catalog', 'pg_temp', 'extensions']);
const MAX_NUMERIC_DIGITS = 4;

const UUID_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const LONG_DIGITS_RE = /\d{5,}/;

export const sha256 = (text) => (text == null ? null : createHash('sha256').update(String(text), 'utf8').digest('hex'));
export const collapse = (text) => (text == null ? null : String(text).replace(/\s+/g, ' ').trim());

/** Why a text must not be printed at all (id-, email- or long-number-shaped content), or null. */
export function identifierShapedContent(text) {
  const s = String(text ?? '');
  if (UUID_RE.test(s)) return 'uuid_shaped_literal';
  if (EMAIL_RE.test(s)) return 'email_shaped_literal';
  if (LONG_DIGITS_RE.test(s)) return 'long_number';
  return null;
}

/**
 * The literals of a SQL / PL/pgSQL text: single-quoted strings (E'' escapes honoured),
 * dollar-quoted strings and numeric constants; plus how many comments it has and the
 * contents of its "quoted identifiers" (neither is a literal, but both can carry free text).
 */
export function sqlLiterals(text) {
  const s = String(text ?? '');
  const strings = [];
  const dollar = [];
  const numbers = [];
  const quotedIdentifiers = [];
  let comments = 0;
  const ident = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === '-' && next === '-') {
      comments += 1;
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl + 1;
    } else if (c === '/' && next === '*') {
      comments += 1;
      let depth = 1;
      i += 2;
      while (i < s.length && depth > 0) {
        if (s[i] === '/' && s[i + 1] === '*') { depth += 1; i += 2; } else if (s[i] === '*' && s[i + 1] === '/') { depth -= 1; i += 2; } else i += 1;
      }
    } else if (c === '"') {
      let value = '';
      i += 1;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') { value += '"'; i += 2; } else if (s[i] === '"') { i += 1; break; } else { value += s[i]; i += 1; }
      }
      quotedIdentifiers.push(value);
    } else if (c === "'") {
      const escaped = /[Ee]/.test(s[i - 1] || '') && !ident(s[i - 2]);
      let value = '';
      i += 1;
      while (i < s.length) {
        if (escaped && s[i] === '\\') { value += s.slice(i, i + 2); i += 2; } else if (s[i] === "'" && s[i + 1] === "'") { value += "'"; i += 2; } else if (s[i] === "'") { i += 1; break; } else { value += s[i]; i += 1; }
      }
      strings.push(escaped ? `E:${value}` : value);
    } else if (c === '$' && !ident(s[i - 1])) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (!tag) { i += 1; continue; }
      const end = s.indexOf(tag[0], i + tag[0].length);
      const stop = end < 0 ? s.length : end;
      dollar.push(s.slice(i + tag[0].length, stop));
      i = end < 0 ? s.length : end + tag[0].length;
    } else if (/[0-9]/.test(c) && !ident(s[i - 1])) {
      const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(s.slice(i));
      numbers.push(m[0]);
      i += m[0].length;
    } else {
      i += 1;
    }
  }
  return { strings, dollar, numbers, comments, quotedIdentifiers };
}

/**
 * Why a SQL text's literals keep it from being printed, or null: a comment, a "quoted
 * identifier" that is not a known schema, table, column or role name, a dollar-quoted or E''
 * string, a string literal other than a role name (live roles, the app_role labels,
 * APP_ROLE_WORDS), a schema name or '', or a number longer than MAX_NUMERIC_DIGITS digits.
 */
export function literalAllowlistReason(text, allowedWords = [], knownIdentifiers = []) {
  const allowed = new Set([...allowedWords, ...APP_ROLE_WORDS, ...SCHEMA_WORDS, '']);
  const known = new Set([...allowedWords, ...SCHEMA_WORDS, ...DESK_TABLES, ...OWNERSHIP_TABLES, ...knownIdentifiers]);
  const lit = sqlLiterals(text);
  if (lit.comments) return 'comment_present';
  if (lit.quotedIdentifiers.some((v) => !known.has(v))) return 'quoted_identifier_beyond_known_names';
  if (lit.dollar.length) return 'nested_dollar_quoted_literal';
  if (lit.strings.some((v) => !allowed.has(v))) return 'literal_beyond_role_names';
  if (lit.numbers.some((n) => n.replace(/[^0-9]/g, '').length > MAX_NUMERIC_DIGITS)) return 'long_number';
  return null;
}

/**
 * pg_get_functiondef text with the body taken out, so the outer $function$ quote is not
 * counted as a literal; the body (prosrc) is scanned as code separately.
 */
function functionHeader(def, prosrc) {
  const d = String(def ?? '');
  const body = String(prosrc ?? '');
  if (!body) return d;
  const at = d.indexOf(body);
  if (at < 0) return null;
  const before = d.slice(0, at).replace(/\$[A-Za-z0-9_]*\$\s*$/, '');
  const after = d.slice(at + body.length).replace(/^\s*\$[A-Za-z0-9_]*\$/, '');
  return `${before}${after}`;
}

/**
 * Whether a function definition may be printed: no id-, email- or long-number-shaped content
 * anywhere (comments included), and header and body each pass literalAllowlistReason (no
 * comment at all, no unknown "quoted identifier", no string literal other than a role or
 * schema name or '', no nested dollar-quoted or E'' string, no number over
 * MAX_NUMERIC_DIGITS digits).
 */
export function definitionTextSafety(def, prosrc, allowedWords = [], knownIdentifiers = []) {
  const shaped = identifierShapedContent(def);
  if (shaped) return { safe: false, reason: shaped };
  const header = functionHeader(def, prosrc);
  if (header == null) return { safe: false, reason: 'unparsed_definition' };
  for (const part of [header, String(prosrc ?? '')]) {
    const reason = literalAllowlistReason(part, allowedWords, knownIdentifiers);
    if (reason) return { safe: false, reason };
  }
  return { safe: true, reason: null };
}

// --- repository source -------------------------------------------------------------

/** Repository directories whose .sql files are compared (fixtures and unapplied files are labelled). */
export const REPO_SQL_DIRS = Object.freeze(['aws', 'supabase']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '.deployment-guard']);

export function listRepoSqlFiles(root) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(child); } else if (entry.isFile() && entry.name.endsWith('.sql')) out.push(child);
    }
  };
  for (const dir of REPO_SQL_DIRS) walk(dir);
  return out.sort();
}

export function sourceKind(file) {
  if (/(^|\/)fixtures\//.test(file)) return 'test_fixture';
  if (/unapplied/.test(file)) return 'unapplied';
  if (file.startsWith('supabase/migrations/')) return 'supabase_migration';
  return 'aws_sql';
}

const IDENT = '(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))';
const unq = (quoted, bare) => (quoted ?? bare ?? '').toLowerCase();

/**
 * Every CREATE [OR REPLACE] FUNCTION of a text, by schema.name (unqualified = public): the
 * body between its dollar quotes, exactly as PostgreSQL stores it in prosrc.
 */
export function repoFunctionBodies(text) {
  const source = String(text ?? '');
  const out = [];
  const re = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:${IDENT}\\s*\\.\\s*)?${IDENT}\\s*\\(`, 'gi');
  let m;
  while ((m = re.exec(source))) {
    const schema = m[1] || m[2] ? unq(m[1], m[2]) : 'public';
    const name = unq(m[3], m[4]);
    const rest = source.slice(m.index);
    const as = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(rest);
    if (!as || rest.slice(0, as.index).includes(';')) continue;
    const start = as.index + as[0].length;
    const end = rest.indexOf(as[1], start);
    if (end < 0) continue;
    out.push({ key: `${schema}.${name}`, body: rest.slice(start, end) });
  }
  return out;
}

/** Every CREATE POLICY <name> ON [public.]<table> of a text. */
export function repoPolicyNames(text) {
  const out = [];
  const re = new RegExp(`CREATE\\s+POLICY\\s+${IDENT}\\s+ON\\s+(?:${IDENT}\\s*\\.\\s*)?${IDENT}`, 'gi');
  let m;
  while ((m = re.exec(String(text ?? '')))) {
    const schema = m[3] || m[4] ? unq(m[3], m[4]) : 'public';
    if (schema !== 'public') continue;
    out.push({ table: unq(m[5], m[6]), policy: m[1] ?? m[2] });
  }
  return out;
}

/** The repository index the live state is compared with: function body hashes and policy names. */
export function buildRepoIndex(root) {
  const functions = new Map();
  const policies = new Map();
  for (const file of listRepoSqlFiles(root)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const { key, body } of repoFunctionBodies(text)) {
      if (!functions.has(key)) functions.set(key, []);
      functions.get(key).push({ file, kind: sourceKind(file), exact: sha256(body), collapsed: sha256(collapse(body)) });
    }
    for (const { table, policy } of repoPolicyNames(text)) {
      const k = `${table}\u0000${policy}`;
      if (!policies.has(k)) policies.set(k, []);
      policies.get(k).push(file);
    }
  }
  return { functions, policies };
}

export function compareWithRepo(index, key, prosrc) {
  const defs = index.functions.get(key) || [];
  const exact = sha256(prosrc);
  const collapsed = sha256(collapse(prosrc));
  const exactFiles = defs.filter((d) => d.exact === exact);
  const wsFiles = defs.filter((d) => d.collapsed === collapsed);
  const matched = exactFiles.length ? exactFiles : wsFiles;
  return {
    repo_definitions: defs.length,
    repo_match: exactFiles.length ? 'exact' : (wsFiles.length ? 'whitespace_only' : 'differs_from_repo'),
    matched_sources: [...new Set(matched.map((d) => d.file))],
    matched_kinds: [...new Set(matched.map((d) => d.kind))].sort(),
  };
}

// --- catalog queries (fixed text; parameters are the constant name lists above) -------

export const Q = Object.freeze({
  begin: 'BEGIN READ ONLY',
  searchPath: "SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)",
  statementTimeout: "SELECT pg_catalog.set_config('statement_timeout', '20000', true)",
  lockTimeout: "SELECT pg_catalog.set_config('lock_timeout', '2000', true)",
  session: `SELECT current_user::text AS current_user, session_user::text AS session_user,
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('server_version_num')::int AS server_version_num`,
  roleNames: 'SELECT r.rolname::text AS rolname FROM pg_catalog.pg_roles r',
  appRoles: `SELECT e.enumlabel::text AS label FROM pg_catalog.pg_enum e
  JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typname = 'app_role'`,
  roles: `SELECT r.rolname::text AS rolname, r.rolsuper, r.rolbypassrls, r.rolinherit, r.rolcanlogin
  FROM pg_catalog.pg_roles r WHERE r.rolname = ANY($1::text[]) ORDER BY 1`,
  memberships: `SELECT pg_catalog.pg_get_userbyid(m.member)::text AS member, pg_catalog.pg_get_userbyid(m.roleid)::text AS role,
  m.admin_option, (pg_catalog.to_jsonb(m) ->> 'inherit_option')::boolean AS inherit_option,
  (pg_catalog.to_jsonb(m) ->> 'set_option')::boolean AS set_option
  FROM pg_catalog.pg_auth_members m
  WHERE pg_catalog.pg_get_userbyid(m.member) = ANY($1::text[]) OR pg_catalog.pg_get_userbyid(m.roleid) = ANY($1::text[])
  ORDER BY 1, 2`,
  tables: `SELECT c.relname::text AS relname, c.relkind::text AS relkind, pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
  c.relrowsecurity, c.relforcerowsecurity, c.relacl IS NULL AS acl_default,
  pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE') AS current_user_has_owner_privileges
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY 1`,
  policies: `SELECT c.relname::text AS table_name, pol.polname::text AS policy, pol.polcmd::text AS cmd, pol.polpermissive AS permissive,
  ARRAY(SELECT CASE WHEN r = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(r)::text END FROM pg_catalog.unnest(pol.polroles) AS r ORDER BY 1) AS roles,
  pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
  pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
  FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY 1, 2`,
  policyFunctions: `SELECT DISTINCT c.relname::text AS table_name, pol.polname::text AS policy, (pn.nspname || '.' || p.proname)::text AS function_name
  FROM pg_catalog.pg_depend d
  JOIN pg_catalog.pg_policy pol ON d.classid = 'pg_catalog.pg_policy'::regclass AND d.objid = pol.oid
  JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_proc p ON d.refclassid = 'pg_catalog.pg_proc'::regclass AND d.refobjid = p.oid
  JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
  WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND pn.nspname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY 1, 2, 3`,
  tableAcl: `SELECT c.relname::text AS table_name, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
  pg_catalog.pg_get_userbyid(a.grantor)::text AS grantor, a.privilege_type::text AS privilege, a.is_grantable
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
  LATERAL pg_catalog.aclexplode(c.relacl) AS a
  WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
    AND (a.grantee = 0 OR pg_catalog.pg_get_userbyid(a.grantee) = ANY($2::text[]))
  ORDER BY 1, 2, 4`,
  columnAcl: `SELECT c.relname::text AS table_name, att.attname::text AS column_name,
  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS grantee,
  a.privilege_type::text AS privilege, a.is_grantable
  FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid = att.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
  LATERAL pg_catalog.aclexplode(att.attacl) AS a
  WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND att.attnum > 0 AND NOT att.attisdropped
    AND (a.grantee = 0 OR pg_catalog.pg_get_userbyid(a.grantee) = ANY($2::text[]))
  ORDER BY 1, 3, 4, 2`,
  effective: `SELECT c.relname::text AS table_name, r.rolname::text AS grantee,
  ARRAY(SELECT p FROM pg_catalog.unnest($3::text[]) AS p WHERE pg_catalog.has_table_privilege(r.oid, c.oid, p) ORDER BY 1) AS table_privileges,
  ARRAY(SELECT p FROM pg_catalog.unnest($4::text[]) AS p WHERE pg_catalog.has_any_column_privilege(r.oid, c.oid, p) ORDER BY 1) AS any_column_privileges
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace CROSS JOIN pg_catalog.pg_roles r
  WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND r.rolname = ANY($2::text[])
  ORDER BY 1, 2`,
  columns: `SELECT c.relname::text AS table_name, att.attname::text AS column_name
  FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid = att.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) AND att.attnum > 0 AND NOT att.attisdropped`,
  triggers: `SELECT c.relname::text AS table_name, t.tgname::text AS trigger, (pn.nspname || '.' || p.proname)::text AS function_name
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
  WHERE NOT t.tgisinternal AND n.nspname = 'public' AND (c.relname = ANY($1::text[]) OR t.tgname = ANY($2::text[]))
  ORDER BY 1, 2`,
  functions: `SELECT n.nspname::text AS schema, p.proname::text AS name, pg_catalog.pg_get_function_identity_arguments(p.oid)::text AS identity_args,
  pg_catalog.pg_get_userbyid(p.proowner)::text AS owner, p.prosecdef AS security_definer, l.lanname::text AS language,
  p.provolatile::text AS volatility, COALESCE(p.proconfig, ARRAY[]::text[]) AS proconfig, p.prosrc,
  pg_catalog.pg_get_functiondef(p.oid) AS definition
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang
  WHERE p.prokind = 'f' AND (n.nspname || '.' || p.proname) = ANY($1::text[])
  ORDER BY 1, 2, 3`,
  sql99: `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'aws_is_tenant_member' AND p.proargtypes::text = ('uuid'::regtype::oid)::text) AS aws_is_tenant_member_uuid_present,
  EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'auth' AND p.proname = 'uid' AND p.pronargs = 0) AS auth_uid_present,
  (SELECT me.rolsuper OR me.rolbypassrls OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity)
     FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE n.nspname = 'public' AND t.relname = 'check_messages' AND t.relkind IN ('r', 'p')) AS definer_can_write_check_messages`,
  rollback: 'ROLLBACK',
});

/** Every statement the inspect may send, for the tests' allowlist. */
export const INSPECT_STATEMENTS = Object.freeze(Object.values(Q));

const byKey = (rows, keyFn) => {
  const m = new Map();
  for (const row of rows) {
    const k = keyFn(row);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(row);
  }
  return m;
};
const asArray = (v) => (Array.isArray(v) ? v : (v == null ? [] : String(v).replace(/^\{|\}$/g, '').split(',').filter(Boolean)));

/**
 * A policy USING / WITH CHECK expression: printed only when it has no id-, email- or
 * long-number-shaped content and passes the same literal allowlist as function text;
 * otherwise only its sha256 (an id-shaped reason is kept, every other is
 * 'literal_beyond_role_names').
 */
export function expressionReport(text, allowedWords = [], knownIdentifiers = []) {
  if (text == null) return { text: null, sha256: null };
  const shaped = identifierShapedContent(text);
  if (shaped) return { text: null, sha256: sha256(text), text_withheld: shaped };
  if (literalAllowlistReason(text, allowedWords, knownIdentifiers)) return { text: null, sha256: sha256(text), text_withheld: 'literal_beyond_role_names' };
  return { text, sha256: sha256(text) };
}

/** A Node / pg error's code (SQLSTATE or a Node E* code) and nothing else: no message, host or stack. */
export function safeErrorCode(error) {
  const code = error?.code;
  if (typeof code !== 'string') return null;
  return /^[0-9A-Z]{5}$/.test(code) || /^E[A-Z0-9_]{2,40}$/.test(code) ? code : null;
}

function functionReport(row, index, allowedWords, knownIdentifiers) {
  const key = `${row.schema}.${row.name}`;
  const cmp = compareWithRepo(index, key, row.prosrc);
  const out = {
    function: `${key}(${row.identity_args})`,
    owner: row.owner,
    security_definer: row.security_definer === true,
    language: row.language,
    volatility: VOLATILITY[row.volatility] || row.volatility,
    proconfig_names: asArray(row.proconfig).map((c) => String(c).split('=')[0]).sort(),
    sets_row_security: asArray(row.proconfig).some((c) => /^row_security=/i.test(String(c))),
    functiondef_sha256: sha256(row.definition),
    prosrc_sha256: sha256(row.prosrc),
    ...cmp,
  };
  if (cmp.repo_match === 'differs_from_repo') {
    const safety = definitionTextSafety(row.definition, row.prosrc, allowedWords, knownIdentifiers);
    if (safety.safe) out.definition = row.definition;
    else out.definition_withheld = `differs from repo (${safety.reason})`;
  }
  return out;
}

/** Builds the report from the query results (pure; the tests feed it PostgreSQL 16 output). */
export function buildMortgageDeskAccessReport(r, index, config = {}) {
  const allowedWords = [...(r.roleNames || []).map((x) => x.rolname), ...(r.appRoles || []).map((x) => x.label)];
  const knownIdentifiers = [...new Set((r.columns || []).map((c) => c.column_name))];
  const tablesByName = new Map((r.tables || []).map((t) => [t.relname, t]));
  const policies = byKey(r.policies || [], (p) => p.table_name);
  const deps = byKey(r.policyFunctions || [], (d) => `${d.table_name}\u0000${d.policy}`);
  const tacl = byKey(r.tableAcl || [], (a) => `${a.table_name}\u0000${a.grantee}`);
  const cacl = byKey(r.columnAcl || [], (a) => `${a.table_name}\u0000${a.grantee}`);
  const eff = new Map((r.effective || []).map((e) => [`${e.table_name}\u0000${e.grantee}`, e]));
  const triggers = byKey(r.triggers || [], (t) => t.table_name);
  const roles = new Map((r.roles || []).map((x) => [x.rolname, x]));
  const fnRows = byKey(r.functions || [], (f) => `${f.schema}.${f.name}`);
  const columns = byKey(r.columns || [], (c) => c.table_name);

  const tables = {};
  for (const name of DESK_TABLES) {
    const t = tablesByName.get(name);
    if (!t) { tables[name] = { present: false }; continue; }
    const grants = {};
    for (const grantee of GRANTEES) {
      const exists = grantee === 'PUBLIC' || roles.has(grantee);
      const direct = (tacl.get(`${name}\u0000${grantee}`) || []).map((a) => ({ privilege: a.privilege, grantable: a.is_grantable === true, grantor: a.grantor }));
      const colEntries = cacl.get(`${name}\u0000${grantee}`) || [];
      const columnPrivileges = {};
      for (const e of colEntries) {
        const k = e.is_grantable ? `${e.privilege} WITH GRANT OPTION` : e.privilege;
        (columnPrivileges[k] ||= []).push(e.column_name);
      }
      for (const k of Object.keys(columnPrivileges)) columnPrivileges[k].sort();
      const e = eff.get(`${name}\u0000${grantee}`);
      grants[grantee] = {
        role_exists: exists,
        table_acl: direct,
        column_acl: columnPrivileges,
        column_acl_entry_count: colEntries.length,
        ...(grantee === 'PUBLIC' ? {} : {
          effective_table_privileges: exists && e ? asArray(e.table_privileges) : null,
          effective_any_column_privileges: exists && e ? asArray(e.any_column_privileges) : null,
        }),
      };
    }
    tables[name] = {
      present: true,
      relkind: t.relkind,
      owner: t.owner,
      rls_enabled: t.relrowsecurity === true,
      rls_forced: t.relforcerowsecurity === true,
      acl_default: t.acl_default === true,
      policy_count: (policies.get(name) || []).length,
      policies: (policies.get(name) || []).map((p) => {
        const repoFiles = index.policies.get(`${name}\u0000${p.policy}`) || [];
        return {
          policy: p.policy,
          command: POLCMD[p.cmd] || p.cmd,
          permissive: p.permissive === true,
          roles: asArray(p.roles),
          using: expressionReport(p.using_expr, allowedWords, knownIdentifiers),
          with_check: expressionReport(p.check_expr, allowedWords, knownIdentifiers),
          depends_on_functions: (deps.get(`${name}\u0000${p.policy}`) || []).map((d) => d.function_name),
          created_in_repo: repoFiles.length > 0,
          repo_sources: repoFiles,
        };
      }),
      grants,
      triggers: (triggers.get(name) || []).map((x) => ({ trigger: x.trigger, function: x.function_name })),
    };
  }

  const fnReport = (key) => {
    const rows = fnRows.get(key) || [];
    return { present: rows.length > 0, overloads: rows.map((row) => functionReport(row, index, allowedWords, knownIdentifiers)) };
  };
  const functions = {};
  for (const key of NAMED_FUNCTIONS) functions[key] = fnReport(key);
  const policyDeps = [...new Set((r.policyFunctions || []).map((d) => d.function_name))].filter((k) => !NAMED_FUNCTIONS.includes(k)).sort();
  const policy_dependency_functions = Object.fromEntries(policyDeps.map((k) => [k, fnReport(k)]));

  const triggerRows = (r.triggers || []).filter((t) => Object.hasOwn(OWNERSHIP_TRIGGERS, t.trigger));
  const chain = {};
  for (const [trigger, expectedTable] of Object.entries(OWNERSHIP_TRIGGERS)) {
    const rows = triggerRows.filter((t) => t.trigger === trigger);
    chain[trigger] = {
      present: rows.length > 0,
      on_tables: rows.map((t) => t.table_name).sort(),
      on_expected_table: rows.some((t) => t.table_name === expectedTable),
      functions: [...new Set(rows.map((t) => t.function_name))].sort().map((k) => ({ name: k, ...fnReport(k) })),
    };
  }
  const ownershipTables = Object.fromEntries([...OWNERSHIP_TABLES, 'check_messages', 'mortgage_handling_requests'].map((name) => {
    const t = tablesByName.get(name);
    return [name, t ? {
      present: true,
      owner: t.owner,
      rls_enabled: t.relrowsecurity === true,
      rls_forced: t.relforcerowsecurity === true,
      current_user_has_owner_privileges: t.current_user_has_owner_privileges === true,
    } : { present: false }];
  }));

  const s99 = r.sql99?.[0] || {};
  const presentCols = (table) => new Set((columns.get(table) || []).map((c) => c.column_name));
  const missingColumns = Object.entries(SQL99_COLUMNS).flatMap(([table, cols]) => cols.filter((c) => !presentCols(table).has(c)).map((c) => `${table}.${c}`));
  const sql99ObjectsPresent = {
    functions: Object.fromEntries(SQL99_FUNCTIONS.map((k) => [k, (fnRows.get(k) || []).length > 0])),
    trigger: (r.triggers || []).some((t) => t.trigger === SQL99_TRIGGER),
  };
  const adminLogin = config.admin_login || null;
  const mhr = tablesByName.get('mortgage_handling_requests');
  const cm = tablesByName.get('check_messages');
  const preconditions = [
    ['aws_is_tenant_member_uuid_present', s99.aws_is_tenant_member_uuid_present === true],
    ['auth_uid_present', s99.auth_uid_present === true],
    ['sql99_columns_present', missingColumns.length === 0],
    ['connected_as_admin_login', adminLogin != null && r.session?.[0]?.current_user === adminLogin],
    ['admin_owns_check_messages', cm?.current_user_has_owner_privileges === true],
    ['check_messages_not_forced', cm ? cm.relforcerowsecurity !== true : false],
    ['definer_can_write_check_messages', s99.definer_can_write_check_messages === true],
    ['admin_owns_mortgage_handling_requests', mhr?.current_user_has_owner_privileges === true],
  ];
  const sql99 = {
    preconditions: Object.fromEntries(preconditions),
    precondition_failures: preconditions.filter(([, v]) => !v).map(([k]) => k),
    missing_columns: missingColumns,
    sql99_objects_present: sql99ObjectsPresent,
  };

  const session = r.session?.[0] || {};
  const roleReport = Object.fromEntries(ROLE_GRANTEES.map((name) => {
    const x = roles.get(name);
    return [name, x ? { exists: true, superuser: x.rolsuper === true, bypassrls: x.rolbypassrls === true, inherit: x.rolinherit === true, can_login: x.rolcanlogin === true } : { exists: false }];
  }));
  return {
    read_only: true,
    inspect: INSPECT_ID,
    transaction_read_only: session.transaction_read_only === 'on',
    server_major_version: Number.isInteger(session.server_version_num) ? Math.floor(session.server_version_num / 10000) : null,
    current_user: session.current_user ?? null,
    session_user: session.session_user ?? null,
    admin_login: adminLogin,
    roles: roleReport,
    role_memberships: (r.memberships || []).map((m) => ({
      member: m.member, role: m.role, admin_option: m.admin_option === true, inherit_option: m.inherit_option, set_option: m.set_option,
    })),
    tables,
    functions,
    policy_dependency_functions,
    sql99_ownership: { trigger_chain: chain, tables: ownershipTables, ...sql99 },
  };
}

export function loadInspectConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
}

/**
 * Runs the inspect on a connected client: BEGIN READ ONLY ... ROLLBACK, catalog only. The
 * client is always rolled back and closed.
 */
export async function inspectMortgageDeskAccess({ connect, root, config, index }) {
  const cfg = config || loadInspectConfig(root);
  const repo = index || buildRepoIndex(root);
  const allTables = [...DESK_TABLES, ...OWNERSHIP_TABLES];
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
    const r = {};
    r.session = await rows(Q.session);
    if (r.session?.[0]?.transaction_read_only !== 'on') {
      return fail(CODES.UNRELATED_MUTATION, 'mortgage desk access inspect refused: the transaction is not read-only');
    }
    r.roleNames = await rows(Q.roleNames);
    r.appRoles = await rows(Q.appRoles);
    r.roles = await rows(Q.roles, [ROLE_GRANTEES]);
    r.memberships = await rows(Q.memberships, [ROLE_GRANTEES]);
    r.tables = await rows(Q.tables, [[...allTables]]);
    r.policies = await rows(Q.policies, [[...DESK_TABLES]]);
    r.policyFunctions = await rows(Q.policyFunctions, [[...DESK_TABLES]]);
    r.tableAcl = await rows(Q.tableAcl, [[...DESK_TABLES], ROLE_GRANTEES]);
    r.columnAcl = await rows(Q.columnAcl, [[...DESK_TABLES], ROLE_GRANTEES]);
    r.effective = await rows(Q.effective, [[...DESK_TABLES], ROLE_GRANTEES, [...TABLE_PRIVILEGES], [...COLUMN_PRIVILEGES]]);
    r.columns = await rows(Q.columns, [[...new Set([...allTables, ...Object.keys(SQL99_COLUMNS)])]]);
    r.triggers = await rows(Q.triggers, [[...DESK_TABLES, ...OWNERSHIP_TABLES], [...Object.keys(OWNERSHIP_TRIGGERS), SQL99_TRIGGER]]);
    const chainFns = r.triggers.filter((t) => Object.hasOwn(OWNERSHIP_TRIGGERS, t.trigger)).map((t) => t.function_name);
    const fnKeys = [...new Set([...NAMED_FUNCTIONS, ...SQL99_FUNCTIONS, ...r.policyFunctions.map((d) => d.function_name), ...chainFns])];
    r.functions = await rows(Q.functions, [fnKeys]);
    r.sql99 = await rows(Q.sql99);
    return ok(buildMortgageDeskAccessReport(r, repo, cfg));
  } catch (error) {
    return fail(CODES.UNRELATED_MUTATION, 'mortgage desk access inspect failed', {
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
