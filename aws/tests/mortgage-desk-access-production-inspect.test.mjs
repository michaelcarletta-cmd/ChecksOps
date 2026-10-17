/**
 * Read-only production inspect of the Mortgage Desk access surface
 * (scripts/deployment-guard/mortgage-desk-access-production-inspect.mjs,
 * lib/mortgage-desk-access-inspect.mjs, ops/production-mortgage-desk-access-inspect.md):
 *
 *   - the configuration is inspect-only and bound to the SQL 99 pin's production RDS and
 *     checksops_admin secret; the tool is inventoried and is not a one-shot apply entry;
 *   - the CLI accepts exactly --inspect and refuses every other argument before reading a
 *     secret or connecting;
 *   - definition text is printed only for a function that matches no repository definition
 *     and has no literal beyond role and schema names, no comment, no unknown quoted
 *     identifier (and no id, email or long number); policy text goes through the same
 *     allowlist; a connection or any other failure prints only JSON with an error code;
 *   - on PostgreSQL 16, as a non-superuser checksops_admin that owns the tables: every
 *     statement is BEGIN READ ONLY, a catalog SELECT or ROLLBACK; nothing changes; the report
 *     has no row data or ids; repo-matching helpers report "exact", drifted ones "differs";
 *     a policy that no repository file creates is reported created_in_repo false; and the
 *     SQL 99 ownership preconditions come out as booleans.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../../scripts/deployment-guard/mortgage-desk-access-production-inspect.mjs';
import {
  CONFIG_REL,
  INSPECT_STATEMENTS,
  MORTGAGE_AGENT_ACCOUNT_STATUS_WORDS,
  MORTGAGE_HANDLING_REQUEST_STATUS_WORDS,
  NAMED_FUNCTIONS,
  POLICY_STATUS_WORDS,
  buildRepoIndex,
  definitionTextSafety,
  expressionReport,
  identifierShapedContent,
  inspectMortgageDeskAccess,
  loadInspectConfig,
  repoFunctionBodies,
  repoPolicyNames,
  sourceKind,
  sqlLiterals,
} from '../../scripts/deployment-guard/lib/mortgage-desk-access-inspect.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { createProductionDatabaseConnect } from '../../scripts/deployment-guard/lib/sql53-production-apply.mjs';
import { pgSkipReason, policyBlock, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOL = 'scripts/deployment-guard/mortgage-desk-access-production-inspect.mjs';
const READ_ONLY_STATEMENT_RE = /^\s*(BEGIN READ ONLY|SELECT|ROLLBACK)\b/;
const MUTATING_RE = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|LOCK|VACUUM|ANALYZE|REFRESH|COMMENT|SECURITY LABEL|REASSIGN|nextval|setval|pg_terminate|pg_cancel|lo_)\b/i;
const quiet = async (fn) => {
  const out = process.stdout.write;
  const err = process.stderr.write;
  const chunks = [];
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  try {
    const code = await fn();
    return { code, text: chunks.join('') };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
};

// --- configuration, inventory -------------------------------------------------------

test('the configuration is inspect-only and bound to the SQL 99 pin production RDS and admin secret', () => {
  const config = loadInspectConfig(ROOT);
  const sql99 = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql99-mortgage-desk-completion-messages-production-apply.json'), 'utf8'));
  assert.equal(config.read_only, true);
  assert.equal(config.apply, false);
  assert.equal(config.target_environment, 'production');
  assert.equal(config.tool, TOOL);
  assert.equal(config.execute, undefined);
  assert.equal(config.authorization_phrase, undefined);
  for (const key of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(config[key], sql99[key], key);
  assert.ok(fs.existsSync(path.join(ROOT, config.runbook)));
  assert.equal(CONFIG_REL, 'ops/deployment-guard/mortgage-desk-access-production-inspect.json');
});

test('the tool is inventoried as SAFE and is not a one-shot apply entry', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const entry = inventory.scripts.find((s) => s.path === TOOL);
  assert.ok(entry, 'inventoried');
  assert.equal(entry.classification, 'SAFE');
  assert.match(entry.note, /BEGIN READ ONLY/);
  assert.ok(!JSON.stringify(ONE_SHOT_TOOLS).includes('mortgage-desk-access'));
  const source = fs.readFileSync(path.join(ROOT, TOOL), 'utf8') + fs.readFileSync(path.join(ROOT, 'scripts/deployment-guard/lib/mortgage-desk-access-inspect.mjs'), 'utf8');
  assert.doesNotMatch(source, /CHECKSOPS_DEPLOYMENT_GUARD_APPLY|issueReceipt|acquireLease|UpdateFunctionCode|PutObject|SendCommand/);
});

test('every statement the inspect can send is read-only', () => {
  for (const sql of INSPECT_STATEMENTS) {
    assert.match(sql, READ_ONLY_STATEMENT_RE, sql);
    if (!/^\s*(BEGIN READ ONLY|ROLLBACK)\s*$/.test(sql)) assert.doesNotMatch(sql.replace(/'[^']*'/g, "''"), MUTATING_RE, sql);
  }
});

// --- CLI refusals ---------------------------------------------------------------------

test('the CLI accepts exactly --inspect and refuses everything else before a secret or connection', async () => {
  for (const argv of [[], ['--apply'], ['--inspect', '--apply'], ['--inspect', '--input', 'x.json'], ['--inspect', '--password', 'x'],
    ['--inspect', '--sql', 'SELECT 1'], ['--inspect', '--database-url', 'postgres://x'], ['--inspect=1'], ['inspect']]) {
    let touched = false;
    const deps = {
      root: ROOT,
      connect: async () => { touched = true; throw new Error('must not connect'); },
      resolveUrl: async () => { touched = true; throw new Error('must not read the secret'); },
    };
    const { code, text } = await quiet(() => main(argv, {}, deps));
    assert.equal(code, 1, argv.join(' '));
    assert.equal(touched, false, argv.join(' '));
    assert.match(text, /accepts exactly one argument: --inspect/);
    assert.doesNotMatch(text, /x\.json|postgres:\/\/|SELECT 1/);
  }
});

test('the CLI refuses a configuration that is not read-only production', async () => {
  const base = loadInspectConfig(ROOT);
  for (const config of [{ ...base, read_only: false }, { ...base, apply: true }, { ...base, target_environment: 'staging' }]) {
    const { code } = await quiet(() => main(['--inspect'], {}, { root: ROOT, config, connect: async () => { throw new Error('no'); } }));
    assert.equal(code, 1);
  }
});

test('a secret refusal is reported without its details and without connecting', async () => {
  const { code, text } = await quiet(() => main(['--inspect'], {}, {
    root: ROOT,
    resolveUrl: async () => ({ ok: false, code: 'UNRELATED_MUTATION', message: 'admin secret does not name the pinned production RDS instance', details: { dbInstanceIdentifier: 'checksops-staging' } }),
  }));
  assert.equal(code, 1);
  assert.doesNotMatch(text, /checksops-staging/);
});

// --- connection and unexpected failures: structured JSON with a code only --------------

const UNREACHABLE_HOST = 'mortgage-desk-unreachable.invalid';
const PASSWORD = 'Hunter2-not-a-real-password';
const assertCodeOnly = (text, { stage, codes }) => {
  const result = JSON.parse(text);
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result.details).sort(), ['error_code', 'read_only', 'stage']);
  assert.equal(result.details.stage, stage);
  if (codes) assert.ok(codes.includes(result.details.error_code), `error_code ${result.details.error_code}`);
  assert.ok(result.details.error_code === null || /^([0-9A-Z]{5}|E[A-Z0-9_]+)$/.test(result.details.error_code));
  for (const leak of [UNREACHABLE_HOST, '127.0.0.1', PASSWORD, 'checksops_admin:', 'postgres://', '    at ', 'node:internal', '.mjs:']) {
    assert.ok(!text.includes(leak), `leaked ${leak}`);
  }
};

test('a connection failure prints only the JSON error with its code: no hostname, stack or password', async () => {
  const config = loadInspectConfig(ROOT);
  const failing = async () => {
    const error = new Error(`getaddrinfo ENOTFOUND ${UNREACHABLE_HOST} (postgres://checksops_admin:${PASSWORD}@${UNREACHABLE_HOST}:5432/postgres)`);
    error.code = 'ENOTFOUND';
    error.hostname = UNREACHABLE_HOST;
    throw error;
  };
  const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, config, connect: failing, index: { functions: new Map(), policies: new Map() } }));
  assert.equal(code, 1);
  assertCodeOnly(text, { stage: 'connect', codes: ['ENOTFOUND'] });

  // A code that is neither a SQLSTATE nor a Node E* code is not echoed.
  const odd = async () => { const e = new Error(UNREACHABLE_HOST); e.code = `host ${UNREACHABLE_HOST}`; throw e; };
  const oddRun = await quiet(() => main(['--inspect'], {}, { root: ROOT, config, connect: odd, index: { functions: new Map(), policies: new Map() } }));
  assertCodeOnly(oddRun.text, { stage: 'connect', codes: [null] });
});

test('the real production connect to an unreachable host reports only the JSON error with its code', { timeout: 60000 }, async () => {
  const config = loadInspectConfig(ROOT);
  const index = { functions: new Map(), policies: new Map() };
  for (const [url, codes] of [
    // Closed port: refused (or pg missing, when the module is not installed).
    [`postgres://checksops_admin:${PASSWORD}@127.0.0.1:1/postgres`, ['ECONNREFUSED', 'ERR_MODULE_NOT_FOUND']],
    // A name that never resolves (.invalid); a resolver timeout has no code at all.
    [`postgres://checksops_admin:${PASSWORD}@${UNREACHABLE_HOST}:5432/postgres`, ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ETIMEDOUT', 'ERR_MODULE_NOT_FOUND', null]],
  ]) {
    // inspectMortgageDeskAccess returns exactly what the CLI prints (stdout is not captured
    // here: the test runner reports through it while the socket is pending).
    const connect = createProductionDatabaseConnect(url, { root: ROOT });
    const result = await inspectMortgageDeskAccess({ connect, root: ROOT, config, index });
    assertCodeOnly(JSON.stringify(result, null, 2), { stage: 'connect', codes });
  }
});

test('an unexpected error anywhere in the CLI prints only the JSON error with its code', async () => {
  const config = loadInspectConfig(ROOT);
  const throwing = async () => {
    const error = new Error(`connect to ${UNREACHABLE_HOST} with ${PASSWORD}`);
    error.code = 'ECONNRESET';
    throw error;
  };
  const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, config, resolveUrl: throwing }));
  assert.equal(code, 1);
  assertCodeOnly(text, { stage: 'entry', codes: ['ECONNRESET'] });
});

// --- redaction and parsing rules -----------------------------------------------------

test('identifier-shaped content is detected', () => {
  assert.equal(identifierShapedContent("x = '0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c'::uuid"), 'uuid_shaped_literal');
  assert.equal(identifierShapedContent("email = 'someone@example.com'"), 'email_shaped_literal');
  assert.equal(identifierShapedContent('amount > 123456'), 'long_number');
  assert.equal(identifierShapedContent("(status = 'completed'::text) AND aws_can_write_tenant(tenant_id)"), null);
});

test('sqlLiterals finds strings, dollar quotes and numbers, and skips comments and identifiers', () => {
  const lit = sqlLiterals("SELECT 'a''b', E'x\\'y', \"it's\" -- 'c'\n/* 'd' */ $q$e$q$, 42, col1 FROM t");
  assert.deepEqual(lit.strings, ["a'b", "E:x\\'y"]);
  assert.deepEqual(lit.dollar, ['e']);
  assert.deepEqual(lit.numbers, ['42']);
  assert.equal(lit.comments, 2);
  assert.deepEqual(lit.quotedIdentifiers, ["it's"]);
  assert.equal(sqlLiterals("SELECT '-- not a comment', '/* nor this */'").comments, 0);
});

test('policy text is printed only when every literal is a role or schema name and every number is short', () => {
  const withheld = [
    "(mortgage_company = 'Rocket Mortgage'::text)",
    "((mortgage_company)::text = 'Rocket Mortgage'::text)",
    "(ssn = '123-45-6789'::text)",
    "(phone = '+1 555 867 5309'::text)",
    "((auth.jwt() ->> 'email'::text) = 'jane.doe@corp'::text)",
    "(external_id = '01ARZ3NDEKTSV4RRFFQ69G5FAV'::text)",
    "(tenant_slug = 'acme-roofing'::text)",
    // 'accepted' is not a status any repository source gives mortgage_handling_requests.
    "(status = ANY (ARRAY['requested'::text, 'accepted'::text]))",
    "(status = 'jane'::text)",
    "(public.aws_is_active_mortgage_agent() AND (status = 'requested'::text) AND (mortgage_company = 'Rocket Mortgage'::text))",
    "((status = 'in_progress'::text) AND (tenant_slug = 'acme-roofing'::text))",
    "(status = 'Requested'::text)",
    // Status words are policy-literal words only, never quoted identifiers.
    '("requested" IS NOT NULL)',
    "(current_setting('request.jwt.claims'::text, true) IS NOT NULL)",
    "(note = E'Jane\\nDoe'::text)",
    '(note = $x$Jane Doe$x$)',
    '(amount > 1234.56)',
    '("Jane Doe" IS NOT NULL)',
  ];
  for (const text of withheld) {
    const report = expressionReport(text, ['checksops', 'authenticated']);
    assert.equal(report.text, null, text);
    assert.equal(report.text_withheld, 'literal_beyond_role_names', text);
    assert.match(report.sha256, /^[0-9a-f]{64}$/, text);
    assert.ok(!JSON.stringify(report).includes(text), text);
  }
  // Id-, email- and long-number-shaped content keeps its own reason.
  assert.equal(expressionReport("(tenant_id = '0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c'::uuid)").text_withheld, 'uuid_shaped_literal');
  assert.equal(expressionReport("(email = 'jane.doe@corp.com'::text)").text_withheld, 'email_shaped_literal');
  assert.equal(expressionReport('(amount > 123456)').text_withheld, 'long_number');

  const printed = [
    ['(public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id))', []],
    ['public.aws_can_write_tenant(tenant_id)', []],
    ['(assigned_employee_id = auth.uid())', []],
    ["public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)", []],
    ["(public.has_role(auth.uid(), 'admin'::public.app_role) OR public.has_role(auth.uid(), 'staff'::public.app_role))", []],
    ["(CURRENT_USER = 'checksops'::name)", ['checksops']],
    ["(COALESCE(role, ''::text) <> 'viewer'::text)", []],
    ['(length(body) <= 4000)', []],
    ['("check_id" IS NOT NULL)', [], ['check_id']],
    ['true', []],
    // The fixed repository status words.
    ["(public.aws_is_active_mortgage_agent() AND (status = ANY (ARRAY['requested'::text, 'in_progress'::text])))", []],
    ["((status = ANY (ARRAY['completed'::text, 'cancelled'::text])) AND (assigned_employee_id = auth.uid()))", []],
    ["(EXISTS ( SELECT 1 FROM public.mortgage_agent_accounts a WHERE ((a.status = 'active'::text) AND (a.status <> 'inactive'::text))))", []],
  ];
  for (const [text, words, known = []] of printed) {
    const report = expressionReport(text, words, known);
    assert.deepEqual(report, { text, sha256: report.sha256 }, text);
    assert.match(report.sha256, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual(expressionReport(null), { text: null, sha256: null });
});

test('the policy status words are fixed, come from the repository CHECK constraints, and do not apply to function text', () => {
  assert.deepEqual([...POLICY_STATUS_WORDS], ['requested', 'in_progress', 'completed', 'cancelled', 'active', 'inactive']);
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.match(read('supabase/migrations/20260715110727_2bb7c7e2-f94a-476f-87fa-db5f47ccc030.sql'),
    /CHECK \(status IN \('requested','in_progress','completed','cancelled'\)\)/);
  assert.deepEqual([...MORTGAGE_HANDLING_REQUEST_STATUS_WORDS], ['requested', 'in_progress', 'completed', 'cancelled']);
  assert.match(read('aws/tests/fixtures/mortgage-agent-compensation/47_mortgage_agent_compensation.sql'),
    /CREATE TABLE IF NOT EXISTS public\.mortgage_agent_accounts[\s\S]*?CHECK \(status IN \('active', 'inactive'\)\)/);
  assert.deepEqual([...MORTGAGE_AGENT_ACCOUNT_STATUS_WORDS], ['active', 'inactive']);
  assert.ok(Object.isFrozen(POLICY_STATUS_WORDS));
  // Function text keeps the role / schema allowlist only.
  const body = "SELECT status = 'requested'";
  const def = `CREATE OR REPLACE FUNCTION public.f()\n RETURNS boolean\n LANGUAGE sql\nAS $function$${body}$function$\n`;
  assert.equal(definitionTextSafety(def, body, []).reason, 'literal_beyond_role_names');
});

test('definition text is safe only with role and schema name literals and short numbers', () => {
  const def = (body, header = "SET search_path TO 'public'") => [`CREATE OR REPLACE FUNCTION public.f()\n RETURNS boolean\n LANGUAGE sql\n ${header}\nAS $function$${body}$function$\n`, body];
  assert.deepEqual(definitionTextSafety(...def("SELECT has_role(auth.uid(), 'mortgage_agent') AND 1 = 1"), []), { safe: true, reason: null });
  assert.deepEqual(definitionTextSafety(...def("SELECT current_user = 'checksops'"), ['checksops']), { safe: true, reason: null });
  assert.equal(definitionTextSafety(...def("SELECT status = 'completed'"), []).reason, 'literal_beyond_role_names');
  assert.equal(definitionTextSafety(...def("SELECT current_setting('request.jwt.claims', true)"), []).reason, 'literal_beyond_role_names');
  assert.equal(definitionTextSafety(...def("SELECT x = '0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c'"), []).reason, 'uuid_shaped_literal');
  assert.equal(definitionTextSafety(...def("SELECT 1 -- ask someone@example.com"), []).reason, 'email_shaped_literal');
  assert.equal(definitionTextSafety(...def('SELECT length(x) <= 50000'), []).reason, 'long_number');
  assert.equal(definitionTextSafety(...def('SELECT $x$admin$x$'), []).reason, 'nested_dollar_quoted_literal');
  assert.equal(definitionTextSafety(...def("SELECT E'\\n'"), []).reason, 'literal_beyond_role_names');
});

test('definition text is withheld when it has any comment or an unknown quoted identifier', () => {
  const def = (body, header = "SET search_path TO 'public'") => [`CREATE OR REPLACE FUNCTION public.f()\n RETURNS boolean\n LANGUAGE sql\n ${header}\nAS $function$${body}$function$\n`, body];
  for (const body of [
    'SELECT true -- exception for Jane Doe (555-867-5309), Acme Roofing',
    '-- exception for Jane Doe (555-867-5309), Acme Roofing\nSELECT true',
    "SELECT has_role(auth.uid(), 'admin') /* Acme Roofing */",
    '/* a harmless-looking note */ SELECT true',
    'SELECT true --',
  ]) assert.equal(definitionTextSafety(...def(body), []).reason, 'comment_present', body);
  for (const body of [
    'SELECT "Jane Doe".id IS NOT NULL FROM public.profiles "Jane Doe"',
    'SELECT true AS "acme-roofing"',
    'SELECT 1 FROM public."Rocket Mortgage"',
  ]) assert.equal(definitionTextSafety(...def(body), []).reason, 'quoted_identifier_beyond_known_names', body);
  // A comment or quoted identifier in the rendered header is caught too.
  assert.equal(definitionTextSafety(...def('SELECT true', 'SET search_path TO "Acme Roofing"'), []).reason, 'quoted_identifier_beyond_known_names');
  // Known schema, table, column and role names may be quoted; -- inside a string is not a comment.
  assert.deepEqual(definitionTextSafety(...def('SELECT "check_id" IS NOT NULL FROM "public"."check_messages" WHERE current_user = \'checksops\''), ['checksops'], ['check_id']), { safe: true, reason: null });
  assert.deepEqual(definitionTextSafety(...def('SELECT current_user = "checksops"::name'), ['checksops']), { safe: true, reason: null });
  assert.equal(definitionTextSafety(...def("SELECT '-- Jane Doe'"), []).reason, 'literal_beyond_role_names');
});

test('repository parsing finds function bodies and policy names as PostgreSQL stores them', () => {
  const text = `CREATE OR REPLACE FUNCTION public.a(_x uuid)\nRETURNS boolean LANGUAGE sql AS $$\n  SELECT true\n$$;\nCREATE FUNCTION b() RETURNS int LANGUAGE sql AS $fn$ SELECT 1 $fn$;\nCREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'select null';\nCREATE POLICY "tenant reads" ON public.mortgage_handling_requests FOR SELECT USING (true);\nCREATE POLICY aws_x\n  ON check_messages USING (true);\nCREATE POLICY y ON storage.objects USING (true);`;
  assert.deepEqual(repoFunctionBodies(text), [{ key: 'public.a', body: '\n  SELECT true\n' }, { key: 'public.b', body: ' SELECT 1 ' }]);
  assert.deepEqual(repoPolicyNames(text), [{ table: 'mortgage_handling_requests', policy: 'tenant reads' }, { table: 'check_messages', policy: 'aws_x' }]);
  assert.equal(sourceKind('aws/tests/fixtures/mortgage-agent-compensation/47_mortgage_agent_compensation.sql'), 'test_fixture');
  assert.equal(sourceKind('supabase/security/fixtures/legacy_recipient_tax_profiles.sql'), 'test_fixture');
  assert.equal(sourceKind('supabase/migrations/x.sql'), 'supabase_migration');
  assert.equal(sourceKind('aws/rls/sql/02_helpers.sql'), 'aws_sql');
});

test('the repository index has a definition for every named helper', () => {
  const index = buildRepoIndex(ROOT);
  for (const key of NAMED_FUNCTIONS) assert.ok((index.functions.get(key) || []).length > 0, key);
  assert.ok(index.policies.has('mortgage_handling_requests\u0000aws_select_mortgage_handling_requests'));
  assert.ok(index.policies.has('mortgage_handling_requests\u0000aws_write_mortgage_handling_requests'));
});

// --- PostgreSQL 16 --------------------------------------------------------------------

/** The full CREATE [OR REPLACE] FUNCTION statement for `signature` in a repository file, as written. */
const functionStatement = (file, signature) => {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const start = text.search(new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${signature.replace(/[.()]/g, '\\$&')}`));
  assert.ok(start >= 0, `${signature} in ${file}`);
  const rest = text.slice(start);
  const as = /\bAS\s+(\$[A-Za-z0-9_]*\$)/.exec(rest);
  const end = rest.indexOf(as[1], as.index + as[0].length);
  return rest.slice(0, rest.indexOf(';', end) + 1);
};

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHECK = '55555555-5555-4555-8555-555555555555';
const REQ = 'd1000000-0000-4000-8000-000000000001';
const AGENT = 'a1000000-0000-4000-8000-000000000003';
const LEAK_UUID = '9e9e9e9e-1234-4abc-8def-000000000042';
const COMMENT_PII = 'Jane Doe (555-867-5309), Acme Roofing';
const QUOTED_PII = 'jane-doe-acme-roofing';
const POLICY_PII = 'Rocket Mortgage';

const SCHEMA = `
SET check_function_bodies = off;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT IN ROLE authenticated;
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE ledger_owner LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE SCHEMA auth;
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'client', 'contractor', 'mortgage_agent');
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, status text, claim_id uuid);
CREATE TABLE public.check_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, sender_id uuid NOT NULL,
  body text NOT NULL, is_deleted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.mortgage_handling_requests (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, check_intake_item_id uuid,
  mortgage_company text, mortgage_servicer text, status text NOT NULL DEFAULT 'requested', assigned_employee_id uuid, work_notes text);
CREATE TABLE public.mortgage_agent_accounts (user_id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
CREATE TABLE public.homeowner_ledger_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, case_id uuid);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text);
CREATE TABLE public.check_cases (id uuid PRIMARY KEY, tenant_id uuid);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['check_intake_items','check_messages','mortgage_handling_requests','mortgage_agent_accounts'] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO checksops_admin', t);
  END LOOP;
END $$;
ALTER TABLE public.homeowner_ledger_events OWNER TO ledger_owner;
ALTER TABLE public.check_cases OWNER TO ledger_owner;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.check_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_handling_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_agent_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_agent_accounts FORCE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON public.mortgage_handling_requests TO checksops;
GRANT UPDATE (status, work_notes) ON public.mortgage_handling_requests TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.check_messages TO checksops, authenticated;
GRANT SELECT ON public.check_messages TO PUBLIC;
GRANT SELECT ON public.check_intake_items TO checksops WITH GRANT OPTION;
`;

/** Repository definitions (verbatim) plus drift: an agent policy and helpers that differ from the repo. */
const OBJECTS = () => [
  functionStatement('aws/identity/sql/02_auth_uid_guc.sql', 'auth.uid()'),
  functionStatement('aws/rls/sql/02_helpers.sql', 'public.aws_is_cross_tenant_reader()'),
  functionStatement('aws/rls/sql/11_access_helpers.sql', 'public.aws_can_access_tenant(_tenant_id uuid)'),
  functionStatement('aws/workflows/sql/90_users_only_tenant_roles.sql', 'public.aws_can_write_tenant(_tenant_id uuid)'),
  // Drifted: only role-name literals -> its text is printed.
  `CREATE OR REPLACE FUNCTION public.aws_is_active_mortgage_agent() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.mortgage_agent_accounts a WHERE a.user_id = auth.uid() AND a.is_active) AND current_user <> 'checksops_admin'
$$;`,
  // Drifted with an id literal -> withheld.
  `CREATE OR REPLACE FUNCTION public.aws_is_tenant_member(_tenant_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT _tenant_id = '${LEAK_UUID}'::uuid
$$;`,
  'CREATE OR REPLACE FUNCTION public.mirror_check_message_to_homeowner_ledger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$ BEGIN RETURN NEW; END $$;',
  'ALTER FUNCTION public.mirror_check_message_to_homeowner_ledger() OWNER TO ledger_owner;',
  functionStatement('aws/workflows/sql/88_claim_id_assign_case_tenant_scope.sql', 'public.tg_claim_id_assign_case()'),
  'ALTER FUNCTION public.tg_claim_id_assign_case() OWNER TO ledger_owner;',
  'CREATE TRIGGER trg_mirror_check_message_to_homeowner_ledger AFTER INSERT ON public.check_messages FOR EACH ROW EXECUTE FUNCTION public.mirror_check_message_to_homeowner_ledger();',
  'CREATE TRIGGER assign_case_on_ledger_events BEFORE INSERT OR UPDATE OF claim_id ON public.homeowner_ledger_events FOR EACH ROW EXECUTE FUNCTION public.tg_claim_id_assign_case();',
  policyBlock('12_final_select_policies.sql', 'aws_select_mortgage_handling_requests'),
  policyBlock('24_complete_write_policies.sql', 'aws_write_mortgage_handling_requests'),
  `CREATE POLICY prod_agent_read_mortgage_handling_requests ON public.mortgage_handling_requests FOR SELECT TO authenticated
    USING (public.aws_is_active_mortgage_agent() AND status = ANY (ARRAY['requested', 'in_progress']));`,
  `CREATE POLICY prod_agent_accepted_check_messages ON public.check_messages FOR SELECT TO authenticated
    USING (public.aws_is_active_mortgage_agent() AND body <> 'accepted' AND body <> 'jane');`,
  `CREATE POLICY prod_agent_update_mortgage_handling_requests ON public.mortgage_handling_requests FOR UPDATE TO authenticated
    USING (assigned_employee_id = auth.uid()) WITH CHECK (assigned_employee_id = auth.uid() OR tenant_id = '${LEAK_UUID}'::uuid);`,
  'CREATE POLICY aws_select_check_messages ON public.check_messages FOR SELECT TO authenticated USING (true);',
  // Drifted: free text in a comment and in a quoted identifier -> withheld.
  `CREATE OR REPLACE FUNCTION public.aws_desk_exception() RETURNS boolean LANGUAGE sql STABLE AS $$
  -- exception for ${COMMENT_PII}
  SELECT current_user <> 'checksops' AS "${QUOTED_PII}"
$$;`,
  `CREATE POLICY prod_desk_exception_check_messages ON public.check_messages FOR SELECT TO authenticated
    USING (public.aws_desk_exception() AND body <> '${POLICY_PII}');`,
  'CREATE POLICY prod_desk_admin_check_messages ON public.check_messages FOR DELETE TO authenticated USING (current_user = \'checksops\');',
  `INSERT INTO public.check_intake_items VALUES ('${CHECK}', '${TENANT}', 'new', NULL);`,
  `INSERT INTO public.mortgage_handling_requests VALUES ('${REQ}', '${TENANT}', '${CHECK}', 'Ledger Bank', NULL, 'accepted', '${AGENT}', 'private note');`,
  `INSERT INTO public.profiles VALUES ('${AGENT}', 'agent@example.com');`,
];

const catalogSnapshot = async (c) => (await c.query(`SELECT
  (SELECT string_agg(polname || ':' || pg_get_expr(polqual, polrelid), ',' ORDER BY polname) FROM pg_policy) AS policies,
  (SELECT string_agg(relname || ':' || COALESCE(relacl::text, '-') || relrowsecurity || relforcerowsecurity, ',' ORDER BY relname) FROM pg_class WHERE relnamespace = 'public'::regnamespace) AS classes,
  (SELECT string_agg(proname || ':' || md5(prosrc) || proowner::regrole::text, ',' ORDER BY proname) FROM pg_proc WHERE pronamespace IN ('public'::regnamespace, 'auth'::regnamespace)) AS procs,
  (SELECT count(*) FROM public.mortgage_handling_requests) AS mhr_rows`)).rows[0];

test('PostgreSQL 16: the inspect is read-only, reports the live access surface and finds the drift', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const server = startPg('pg-mortgage-desk-access-', 61300);
  const open = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const su = await open('ubuntu');
  try {
    await su.query(SCHEMA);
    for (const sql of OBJECTS()) await su.query(sql);
    const before = await catalogSnapshot(su);

    const statements = [];
    const connect = async () => {
      const c = await open('checksops_admin');
      const query = c.query.bind(c);
      c.query = (sql, params) => { statements.push(typeof sql === 'string' ? sql : sql.text); return query(sql, params); };
      return c;
    };
    const config = loadInspectConfig(ROOT);
    const { code, text } = await quiet(() => main(['--inspect'], {}, { root: ROOT, config, connect }));
    assert.equal(code, 0, text);
    const result = JSON.parse(text);
    const report = result.details;

    // Read-only: only allowlisted statements, nothing changed.
    assert.ok(statements.length > 5);
    for (const sql of statements) assert.ok(INSPECT_STATEMENTS.includes(sql), sql);
    assert.equal(statements[0], 'BEGIN READ ONLY');
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.deepEqual(await catalogSnapshot(su), before);
    assert.equal(report.read_only, true);
    assert.equal(report.transaction_read_only, true);
    assert.equal(report.server_major_version, 16);
    assert.equal(report.current_user, 'checksops_admin');

    // No row data, ids, emails or the drifted literal anywhere in the output.
    for (const leak of [TENANT, CHECK, REQ, AGENT, LEAK_UUID, 'agent@example.com', 'private note', 'Ledger Bank',
      COMMENT_PII, 'Jane Doe', '555-867-5309', 'Acme Roofing', QUOTED_PII, POLICY_PII, "'accepted'", "'jane'"]) {
      assert.ok(!text.includes(leak), `leaked ${leak}`);
    }

    // Roles.
    assert.deepEqual(report.roles.checksops, { exists: true, superuser: false, bypassrls: false, inherit: true, can_login: true });
    assert.ok(report.role_memberships.some((m) => m.member === 'checksops' && m.role === 'authenticated' && m.inherit_option === true));

    // Tables: owner, RLS, policies, grants, triggers.
    const mhr = report.tables.mortgage_handling_requests;
    assert.equal(mhr.owner, 'checksops_admin');
    assert.equal(mhr.rls_enabled, true);
    assert.equal(mhr.rls_forced, false);
    assert.equal(report.tables.mortgage_agent_accounts.rls_forced, true);
    const pol = Object.fromEntries(mhr.policies.map((p) => [p.policy, p]));
    assert.deepEqual(Object.keys(pol).sort(), ['aws_select_mortgage_handling_requests', 'aws_write_mortgage_handling_requests', 'prod_agent_read_mortgage_handling_requests', 'prod_agent_update_mortgage_handling_requests']);
    assert.equal(pol.aws_select_mortgage_handling_requests.created_in_repo, true);
    assert.deepEqual(pol.aws_select_mortgage_handling_requests.repo_sources, ['aws/rls/sql/12_final_select_policies.sql', 'aws/workflows/sql/98_mortgage_desk_live_access.sql']);
    // aws_write_ is still created by 24 (a rebuilt database then drops it in SQL 98).
    assert.deepEqual(pol.aws_write_mortgage_handling_requests.repo_sources, ['aws/rls/sql/24_complete_write_policies.sql']);
    assert.equal(pol.aws_select_mortgage_handling_requests.command, 'SELECT');
    assert.deepEqual(pol.aws_select_mortgage_handling_requests.roles, ['authenticated']);
    assert.equal(pol.aws_select_mortgage_handling_requests.using.text, '(public.aws_is_cross_tenant_reader() OR public.aws_can_access_tenant(tenant_id))');
    assert.deepEqual(pol.aws_select_mortgage_handling_requests.depends_on_functions.sort(), ['public.aws_can_access_tenant', 'public.aws_is_cross_tenant_reader']);
    assert.equal(pol.aws_write_mortgage_handling_requests.command, 'ALL');
    assert.equal(pol.aws_write_mortgage_handling_requests.with_check.text, 'public.aws_can_write_tenant(tenant_id)');
    assert.equal(pol.prod_agent_read_mortgage_handling_requests.created_in_repo, false);
    // Only repository status words besides the helper call: the exact text is printed.
    assert.equal(pol.prod_agent_read_mortgage_handling_requests.using.text,
      "(public.aws_is_active_mortgage_agent() AND (status = ANY (ARRAY['requested'::text, 'in_progress'::text])))");
    assert.equal(pol.prod_agent_read_mortgage_handling_requests.using.text_withheld, undefined);
    assert.match(pol.prod_agent_read_mortgage_handling_requests.using.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(pol.prod_agent_read_mortgage_handling_requests.depends_on_functions, ['public.aws_is_active_mortgage_agent']);
    const cmPol = Object.fromEntries(report.tables.check_messages.policies.map((p) => [p.policy, p]));
    // A word outside the fixed status list ('accepted', 'jane') is still withheld.
    assert.equal(cmPol.prod_agent_accepted_check_messages.using.text, null);
    assert.equal(cmPol.prod_agent_accepted_check_messages.using.text_withheld, 'literal_beyond_role_names');
    assert.equal(cmPol.prod_desk_exception_check_messages.using.text, null);
    assert.equal(cmPol.prod_desk_exception_check_messages.using.text_withheld, 'literal_beyond_role_names');
    assert.equal(cmPol.prod_desk_admin_check_messages.using.text, "(CURRENT_USER = 'checksops'::name)");
    assert.equal(cmPol.aws_select_check_messages.using.text, 'true');
    const exception = report.policy_dependency_functions['public.aws_desk_exception'].overloads[0];
    assert.equal(exception.repo_match, 'differs_from_repo');
    assert.equal(exception.definition, undefined);
    assert.equal(exception.definition_withheld, 'differs from repo (comment_present)');
    assert.equal(pol.prod_agent_update_mortgage_handling_requests.command, 'UPDATE');
    assert.equal(pol.prod_agent_update_mortgage_handling_requests.using.text, '(assigned_employee_id = auth.uid())');
    assert.equal(pol.prod_agent_update_mortgage_handling_requests.with_check.text, null);
    assert.equal(pol.prod_agent_update_mortgage_handling_requests.with_check.text_withheld, 'uuid_shaped_literal');
    assert.match(pol.prod_agent_update_mortgage_handling_requests.with_check.sha256, /^[0-9a-f]{64}$/);

    assert.deepEqual(mhr.grants.checksops.table_acl.map((a) => a.privilege).sort(), ['SELECT', 'UPDATE']);
    assert.deepEqual(mhr.grants.checksops.effective_table_privileges, ['SELECT', 'UPDATE']);
    assert.deepEqual(mhr.grants.authenticated.table_acl, []);
    assert.deepEqual(mhr.grants.authenticated.column_acl, { UPDATE: ['status', 'work_notes'] });
    assert.deepEqual(mhr.grants.authenticated.effective_any_column_privileges, ['UPDATE']);
    assert.deepEqual(mhr.grants.PUBLIC, { role_exists: true, table_acl: [], column_acl: {}, column_acl_entry_count: 0 });
    assert.deepEqual(mhr.grants.checksops_admin.table_acl.map((a) => a.privilege).sort(), ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']);
    assert.deepEqual(report.tables.check_messages.grants.PUBLIC.table_acl, [{ privilege: 'SELECT', grantable: false, grantor: 'checksops_admin' }]);
    assert.equal(report.tables.check_intake_items.grants.checksops.table_acl[0].grantable, true);
    assert.deepEqual(report.tables.check_messages.triggers, [{ trigger: 'trg_mirror_check_message_to_homeowner_ledger', function: 'public.mirror_check_message_to_homeowner_ledger' }]);

    // Functions: repo-matching helpers are exact; drifted ones differ, text only when safe.
    for (const key of ['auth.uid', 'public.aws_is_cross_tenant_reader', 'public.aws_can_access_tenant', 'public.aws_can_write_tenant']) {
      const [f] = report.functions[key].overloads;
      assert.equal(f.repo_match, 'exact', key);
      assert.equal(f.definition, undefined, key);
      assert.match(f.functiondef_sha256, /^[0-9a-f]{64}$/);
    }
    assert.ok(report.functions['public.aws_can_write_tenant'].overloads[0].matched_sources.includes('aws/workflows/sql/90_users_only_tenant_roles.sql'));
    assert.equal(report.functions['public.aws_can_write_tenant'].overloads[0].sets_row_security, true);
    const agent = report.functions['public.aws_is_active_mortgage_agent'].overloads[0];
    assert.equal(agent.repo_match, 'differs_from_repo');
    assert.match(agent.definition, /mortgage_agent_accounts/);
    const member = report.functions['public.aws_is_tenant_member'].overloads[0];
    assert.equal(member.repo_match, 'differs_from_repo');
    assert.equal(member.definition, undefined);
    assert.equal(member.definition_withheld, 'differs from repo (uuid_shaped_literal)');
    assert.deepEqual(report.functions['public.mortgage_agent_can_view_check'], { present: false, overloads: [] });

    // SQL 99 ownership.
    const own = report.sql99_ownership;
    assert.equal(own.trigger_chain.trg_mirror_check_message_to_homeowner_ledger.on_expected_table, true);
    assert.equal(own.trigger_chain.trg_mirror_check_message_to_homeowner_ledger.functions[0].overloads[0].owner, 'ledger_owner');
    assert.equal(own.trigger_chain.assign_case_on_ledger_events.functions[0].name, 'public.tg_claim_id_assign_case');
    assert.equal(own.trigger_chain.assign_case_on_ledger_events.functions[0].overloads[0].repo_match, 'exact');
    assert.equal(own.tables.homeowner_ledger_events.owner, 'ledger_owner');
    assert.equal(own.tables.profiles.owner, 'ubuntu');
    assert.equal(own.tables.profiles.rls_forced, true);
    assert.equal(own.tables.check_messages.current_user_has_owner_privileges, true);
    assert.deepEqual(own.precondition_failures, []);
    assert.deepEqual(own.sql99_objects_present, { functions: { 'public.aws_mortgage_desk_appended_note': false, 'public.aws_mortgage_desk_completion_messages': false }, trigger: false });

    // FORCE on check_messages is a SQL 99 blocker.
    await su.query('ALTER TABLE public.check_messages FORCE ROW LEVEL SECURITY');
    const forced = await inspectMortgageDeskAccess({ connect: () => open('checksops_admin'), root: ROOT, config });
    assert.deepEqual(forced.details.sql99_ownership.precondition_failures, ['check_messages_not_forced', 'definer_can_write_check_messages']);
  } finally {
    await su.end().catch(() => {});
    server.stop();
  }
});
