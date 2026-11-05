/**
 * SQL 143 (aws/workflows/sql/143_mortgage_companies_member_delete_unused.sql) in the staging guarded executor, on the
 * release engine shared with SQL 90-143 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 143 included); this file covers what
 * is new:
 *
 *   - the pin: staging-authorized (wave 38) from staging read-live run 42020037212, code-derived, selectable, packed, in step with the pending production pin;
 *     the pinned commit authored the bytes; predecessor SQL 142, which it supersedes (no partial fingerprint pinned:
 *     nothing of SQL 142 survives); the expected pre-state (SQL 142's two policies, nothing of SQL 143) is derived here;
 *   - the spec: two SECURITY DEFINER functions (the editor helper, EXECUTE authenticated, checksops and the owner; the
 *     in-use guard, the owner only), three PERMISSIVE policies TO authenticated (INSERT, UPDATE, DELETE on
 *     aws_can_edit_mortgage_company_directory() AND is_active), SQL 142's two dropped, the BEFORE DELETE OR UPDATE OF
 *     id trigger, the table as altered_relations; the seven extra preconditions read catalog counts and fail closed
 *     unless each is 1;
 *   - on PostgreSQL 16 (helpers/sql142-mortgage-companies-schema.mjs plus SQL 142's file, owned by checksops_admin):
 *     the read-live reads the derived pre-state, read-only; a changed owner policy, a changed SQL 142 policy, an
 *     unexpected policy or a FORCE RLS referencing table is seen read-only and refuses the apply; a pending pin and
 *     drift cannot apply; one apply reaches the intended fingerprint, the other policies unchanged, then is refused as
 *     already in place.
 * Who may write and delete after the apply is aws/tests/sql143-mortgage-companies-member-delete-tool-pg.test.mjs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL143_MORTGAGE_COMPANIES_MEMBER_DELETE_UNUSED,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPreconditionFailures,
  releaseStateHash,
  releaseStateText,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { mortgageCompaniesSchema } from './helpers/sql142-mortgage-companies-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-05T12:00:00.000Z';
const KEY = 'sql143';
const TABLE = 'public.mortgage_companies';
const INSERT_POLICY = 'aws_insert_mortgage_companies_member';
const UPDATE_POLICY = 'aws_update_mortgage_companies_member';
const DELETE_POLICY = 'aws_delete_mortgage_companies_member';
const SQL142_INSERT = 'aws_insert_mortgage_companies_tenant_admin';
const SQL142_UPDATE = 'aws_update_mortgage_companies_tenant_admin';
const EDITOR = 'public.aws_can_edit_mortgage_company_directory()';
const GUARD = 'public.aws_mortgage_company_in_use_guard()';
const TRIGGER = 'aws_mortgage_company_in_use_guard';
const TRIGGER_DEF = 'CREATE TRIGGER aws_mortgage_company_in_use_guard BEFORE DELETE OR UPDATE OF id ON public.mortgage_companies FOR EACH ROW EXECUTE FUNCTION public.aws_mortgage_company_in_use_guard()';
const EDITOR_ACTIVE = '(public.aws_can_edit_mortgage_company_directory() AND is_active)';
const COUNTS = ['mortgage_companies_rls_enabled', 'mortgage_companies_id_uuid_is_active_boolean', 'mortgage_company_references_uuid',
  'mortgage_companies_owner_policy_intact', 'mortgage_companies_sql142_policies_replaceable', 'mortgage_companies_no_unexpected_policy',
  'mortgage_company_references_readable_by_login'];
const OWNER_FORMS = ['(aws_is_authenticated() AND aws_is_cross_tenant_reader())', '(public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())'];
const SQL142_FORMS = ['(aws_is_tenant_manager_admin() AND is_active)', '(public.aws_is_tenant_manager_admin() AND is_active)'];
/** Expected pre-state (SQL 142's two policies, nothing of SQL 143), derived below and read back on PostgreSQL 16. */
const PRE_SQL142 = 'c62a1b0b337cca713cd8551f1a1c70f507ef451e40731baa6e8479abae51038d';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL142_TEXT = fs.readFileSync(path.join(ROOT, PINS.sql142.filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));
const INTENDED = releaseIntendedState(KEY, TEXT);
/** The pre-state: nothing of SQL 143; SQL 142's two policies as SQL 142's file leaves them. */
function afterSql142() {
  const sql142 = releaseIntendedState('sql142', SQL142_TEXT);
  return {
    ...INTENDED,
    functions: Object.fromEntries(Object.keys(INTENDED.functions).map((k) => [k, { exists: false }])),
    policies: Object.fromEntries(Object.keys(INTENDED.policies).map((k) => [k, sql142.policies[k] || { exists: false }])),
    triggers: Object.fromEntries(Object.keys(INTENDED.triggers).map((k) => [k, { exists: false }])),
  };
}

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(overrides = {}) {
  const pin = overrides.pin || PINS[KEY];
  const rest = { ...overrides };
  delete rest.pin;
  const event = {
    action: 'apply',
    workstream_id: `staging-${RELEASE_SQL_SPECS[KEY].choice}`,
    branch: 'main',
    commit: pin.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256 || READ_LIVE_EXPECTED_SENTINEL,
    one_use_id: `${KEY}-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    expiry: '2026-11-05T23:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql143-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 143 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; predecessor SQL 142, which it supersedes; the derived pre-state', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL143_MORTGAGE_COMPANIES_MEMBER_DELETE_UNUSED, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/143_mortgage_companies_member_delete_unused.sql');
  assert.equal(pin.migration_id, '143_mortgage_companies_member_delete_unused');
  assert.equal(spec.choice, 'sql143-mortgage-companies-member-delete-unused');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-11-05, "record the SQL 143 staging pin") from staging read-live
  // run 42020037212: already_applied false, precondition_failures []. It read the derived pre-state.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-05: staging apply (wave 38) from staging read-live run 42020037212');
  assert.equal(pin.expected_live_definition_sha256, PRE_SQL142);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, 'd14d6ac55a8cc18c49d502cb508ddcb3a03969b7d196843224156d4ef0483029');
  // The pre-state is derivable: SQL 142's two policies as its file leaves them, nothing of SQL 143.
  assert.equal(releaseStateHash(KEY, afterSql142()), PRE_SQL142);
  assert.notEqual(PRE_SQL142, pin.intended_replacement_sha256);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql143-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [EDITOR, GUARD]);
  assert.deepEqual(spec.predecessors, ['sql142']);
  assert.deepEqual(spec.supersedes, ['sql142']);
  // No partial fingerprint for SQL 142: its two policies are all it has and SQL 143 drops both.
  assert.equal(pin.superseded_intended_sha256, undefined);
  for (const none of ['runs_before', 'refuse_after', 'definer_writes', 'table_privileges', 'whole_tables', 'acl_functions', 'dropped_functions', 'dropped_triggers']) assert.equal(spec[none], undefined, none);
  // Nothing supersedes, refuses after or depends on SQL 143; only SQL 142 (before it) fingerprints a mortgage_companies policy.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY && k !== 'sql142')) {
    const other = RELEASE_SQL_SPECS[key];
    assert.ok(![...(other.policies || []), ...(other.dropped_policies || [])].some((p) => p.table === TABLE), key);
    assert.ok(![...(other.triggers || []), ...(other.dropped_triggers || [])].some((tr) => tr.table === TABLE), key);
    assert.ok(!(other.whole_tables || []).some((w) => w.table === TABLE), key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [EDITOR, GUARD]);
  assert.deepEqual(prod.predecessors, ['sql142']);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.ok(prod.production_inspect.note.includes(PRE_SQL142));
  assert.ok(prod.order_note.includes(PRE_SQL142));
  // The runbook: the intended fingerprint and text, the source, the derived pre-state.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-143-apply.md'), 'utf8');
  assert.match(runbook, /\*\*Status:\*\* staging pin execute-authorized \(wave 38\); not applied anywhere\. The production pin is pending\./);
  assert.match(runbook, /read-live \(2026-11-05\)\.\*\* Run 42020037212/);
  assert.ok(runbook.includes(pin.expected_live_definition_sha256));
  assert.match(runbook, /\*\*Pre-state: derivable\.\*\*/);
  for (const value of [pin.intended_replacement_sha256, pin.source_sha256, PRE_SQL142, sha(EDITOR_ACTIVE)]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, INTENDED)}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, afterSql142())}\n\`\`\``));
  let bytes = null;
  if (/^[0-9a-f]{40}$/.test(pin.commit)) {
    try {
      bytes = execFileSync('git', ['-C', ROOT, 'show', `${pin.commit}:${pin.filename}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      bytes = null;
    }
  }
  if (bytes !== null) assert.equal(sha(bytes), pin.source_sha256, 'the pinned commit carries the pinned bytes');
});

test('reviewed file and spec: two SECURITY DEFINER functions, three PERMISSIVE policies (INSERT, UPDATE, DELETE), SQL 142\'s two dropped, the guard trigger; prerequisites, the altered table and the fail-closed counts', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [
    { identity: EDITOR, acl: ['authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'] },
    { identity: GUARD, acl: ['owner EXECUTE'] },
  ]);
  const fns = INTENDED.functions;
  assert.deepEqual({ ...fns[EDITOR], prosrc_sha256: undefined }, { exists: true, language: 'sql', volatility: 's', parallel: 'u', security_definer: true,
    result: 'boolean', config: ['row_security=off', 'search_path=public'], prosrc_sha256: undefined, acl: ['authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE'] });
  assert.deepEqual({ ...fns[GUARD], prosrc_sha256: undefined }, { exists: true, language: 'plpgsql', volatility: 'v', parallel: 'u', security_definer: true,
    result: 'trigger', config: ['row_security=off', 'search_path=public'], prosrc_sha256: undefined, acl: ['owner EXECUTE'] });
  // The file revokes the guard from PUBLIC, authenticated and checksops and grants the helper to the two roles.
  assert.match(TEXT, /REVOKE ALL ON FUNCTION public\.aws_mortgage_company_in_use_guard\(\) FROM PUBLIC;/);
  assert.match(TEXT, /REVOKE ALL ON FUNCTION public\.aws_can_edit_mortgage_company_directory\(\) FROM PUBLIC;/);
  assert.deepEqual(spec.policies, [
    { table: TABLE, name: INSERT_POLICY, cmd: 'INSERT', roles: ['authenticated'], permissive: true, qual: null, with_check: EDITOR_ACTIVE },
    { table: TABLE, name: UPDATE_POLICY, cmd: 'UPDATE', roles: ['authenticated'], permissive: true, qual: EDITOR_ACTIVE, with_check: EDITOR_ACTIVE },
    { table: TABLE, name: DELETE_POLICY, cmd: 'DELETE', roles: ['authenticated'], permissive: true, qual: EDITOR_ACTIVE, with_check: null },
  ]);
  assert.deepEqual(spec.dropped_policies, [{ table: TABLE, name: SQL142_INSERT }, { table: TABLE, name: SQL142_UPDATE }]);
  // The dropped ones are exactly SQL 142's.
  assert.deepEqual(RELEASE_SQL_SPECS.sql142.policies.map((p) => p.name), [SQL142_INSERT, SQL142_UPDATE]);
  assert.deepEqual(INTENDED.policies, {
    [`${TABLE} ${INSERT_POLICY}`]: { exists: true, cmd: 'INSERT', permissive: true, roles: ['authenticated'], qual: null, with_check: EDITOR_ACTIVE },
    [`${TABLE} ${UPDATE_POLICY}`]: { exists: true, cmd: 'UPDATE', permissive: true, roles: ['authenticated'], qual: EDITOR_ACTIVE, with_check: EDITOR_ACTIVE },
    [`${TABLE} ${DELETE_POLICY}`]: { exists: true, cmd: 'DELETE', permissive: true, roles: ['authenticated'], qual: EDITOR_ACTIVE, with_check: null },
    [`${TABLE} ${SQL142_INSERT}`]: { exists: false },
    [`${TABLE} ${SQL142_UPDATE}`]: { exists: false },
  });
  assert.deepEqual(spec.triggers, [{ table: TABLE, name: TRIGGER, def: TRIGGER_DEF }]);
  assert.deepEqual(INTENDED.triggers, { [`${TABLE} ${TRIGGER}`]: { exists: true, enabled: 'O', def: TRIGGER_DEF } });
  assert.deepEqual([...spec.altered_relations], [TABLE]);
  assert.deepEqual([...spec.prerequisites], [TABLE, `column ${TABLE}.id`, `column ${TABLE}.is_active`,
    'public.claims', 'column public.claims.mortgage_company_id', 'public.loss_draft_tracking', 'column public.loss_draft_tracking.mortgage_company_id',
    'public.check_cases', 'column public.check_cases.mortgage_company_id', 'public.aws_is_authenticated()', 'public.aws_is_cross_tenant_reader()',
    'public.aws_has_any_tenant_membership()', 'public.aws_is_active_mortgage_agent(uuid)', 'auth.uid()', 'role authenticated', 'role checksops']);
  assert.deepEqual([...spec.extra_preconditions], COUNTS);
  assert.deepEqual(Object.keys(spec.counts), COUNTS);
  // Catalog only: every count reads pg_catalog, never a table's rows.
  for (const [name, count] of Object.entries(spec.counts)) {
    assert.match(count.sql, /^(SELECT (count\(\*\)::int|\(count\(\*\) = [23]\)::int) AS n FROM pg_catalog\.|WITH f AS \(SELECT ARRAY)/, name);
    assert.doesNotMatch(count.sql.replace(/'(?:[^']|'')*'/g, "''"), /\bpublic\./, name);
  }
  // The policy forms the counts accept are the file's own.
  for (const form of OWNER_FORMS) {
    assert.ok(spec.counts.mortgage_companies_owner_policy_intact.sql.includes(`'${form}'`), form);
    assert.ok(TEXT.includes(`'${form}'`), form);
  }
  for (const form of SQL142_FORMS) {
    assert.ok(spec.counts.mortgage_companies_sql142_policies_replaceable.sql.includes(`'${form}'`), form);
    assert.ok(TEXT.includes(`'${form}'`), form);
  }
  for (const name of ['aws_select_mortgage_companies', 'aws_write_mortgage_companies', SQL142_INSERT, SQL142_UPDATE, INSERT_POLICY, UPDATE_POLICY, DELETE_POLICY]) {
    assert.ok(spec.counts.mortgage_companies_no_unexpected_policy.sql.includes(`'${name}'`), name);
    assert.ok(TEXT.includes(`'${name}'`), name);
  }

  const live = (counts) => ({
    current_user: 'checksops_admin',
    prerequisites_missing: [],
    predecessors_applied: true,
    successors_applied: [],
    dependents: {},
    dropped_function_callers: [],
    functions: {},
    altered: { [TABLE]: { exists: true, owner_is_login: true } },
    counts: { ...Object.fromEntries(COUNTS.map((c) => [c, 1])), ...counts },
  });
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({}), TEXT), []);
  for (const name of COUNTS) {
    assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({ [name]: 0 }), TEXT), [name], name);
    assert.deepEqual(releaseSharedPreconditionFailures(KEY, live({ [name]: null }), TEXT), [name], name);
  }
  const notOwned = live({});
  notOwned.altered[TABLE] = { exists: true, owner_is_login: false };
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, notOwned, TEXT), ['altered_relations_owned_by_login']);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, { ...live({}), predecessors_applied: false }, TEXT), ['predecessors_applied']);
  // A pre-existing function owned by someone else, or carrying a grant the file does not keep, refuses.
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, { ...live({}), functions: { [GUARD]: { exists: true, owner_is_login: false, acl: ['owner EXECUTE'], result: 'trigger' } } }, TEXT), ['functions_owned_by_login']);
  assert.deepEqual(releaseSharedPreconditionFailures(KEY, { ...live({}), functions: { [GUARD]: { exists: true, owner_is_login: true, acl: ['authenticated EXECUTE', 'owner EXECUTE'], result: 'trigger' } } }, TEXT), ['function_acl_replaceable']);
});

test('PostgreSQL 16: SQL 143 through the executor: the derived pre-state read-only; a changed owner or SQL 142 policy, an unexpected policy or a FORCE RLS referencing table refuse first; a pending pin and drift cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const references = `
CREATE OR REPLACE FUNCTION public.aws_has_any_tenant_membership() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.aws_is_active_mortgage_agent(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
ALTER TABLE public.claims ADD COLUMN mortgage_company_id uuid REFERENCES public.mortgage_companies(id);
ALTER TABLE public.loss_draft_tracking ADD COLUMN mortgage_company_id uuid REFERENCES public.mortgage_companies(id) ON DELETE SET NULL;
CREATE TABLE public.check_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, mortgage_company_id uuid);
ALTER TABLE public.check_cases ENABLE ROW LEVEL SECURITY;`;
  const fx = await releaseFixture(pg, 'pg-sql143-exec-', 61435, { extra: [mortgageCompaniesSchema(), references] });
  const { admin, connectAs } = fx;
  try {
    const owner = await connectAs('checksops_admin');
    try {
      await owner.query(SQL142_TEXT);
    } finally {
      await owner.end();
    }
    const seen = [];
    const connect = async () => {
      const client = await connectAs('checksops_admin');
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const inspect = async () => {
      seen.length = 0;
      const result = await handlerFor(connect)(inspectEvent());
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
      return result.details.receipt;
    };
    const apply = async (live) => {
      const pin = Object.freeze({ ...PINS[KEY], expected_live_definition_sha256: live, execute: true, authorization: 'Owner approved test fixture' });
      return handlerFor(connect, { pins: { [KEY]: pin } })(releaseEvent({ pin }));
    };
    const others = async () => (await admin.query(`SELECT pol.polname, pol.polcmd::text AS cmd, pol.polpermissive, pol.polroles::text AS roles,
      pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS q, pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS w
      FROM pg_catalog.pg_policy pol WHERE pol.polrelid = 'public.mortgage_companies'::regclass AND pol.polname NOT IN ($1, $2, $3, $4, $5) ORDER BY 1`,
    [INSERT_POLICY, UPDATE_POLICY, DELETE_POLICY, SQL142_INSERT, SQL142_UPDATE])).rows;
    const P = 'ON public.mortgage_companies';

    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.equal(pre.already_applied, false);
    assert.equal(pre.live_definition_sha256, PRE_SQL142, 'the fixture pre-state equals the derived one');
    assert.deepEqual(pre.release_sql_inspect.counts, Object.fromEntries(COUNTS.map((c) => [c, 1])));
    const before = await others();

    // Each fail-closed condition is seen read-only first and refuses the apply; nothing changes.
    await admin.query(`ALTER POLICY aws_write_mortgage_companies ${P} USING (true)`);
    const ownerDrift = await inspect();
    assert.deepEqual(ownerDrift.precondition_failures, ['mortgage_companies_owner_policy_intact']);
    assert.equal(ownerDrift.live_definition_sha256, PRE_SQL142, 'the owner policy is not in the fingerprint');
    assert.equal((await apply(PRE_SQL142)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`ALTER POLICY aws_write_mortgage_companies ${P} USING (public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())`);
    assert.deepEqual((await inspect()).precondition_failures, []);
    await admin.query(`CREATE POLICY sql143_stray ${P} FOR DELETE TO authenticated USING (true)`);
    assert.deepEqual((await inspect()).precondition_failures, ['mortgage_companies_no_unexpected_policy']);
    assert.equal((await apply(PRE_SQL142)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`DROP POLICY sql143_stray ${P}`);
    await admin.query('ALTER TABLE public.check_cases FORCE ROW LEVEL SECURITY');
    assert.deepEqual((await inspect()).precondition_failures, ['mortgage_company_references_readable_by_login']);
    assert.equal((await apply(PRE_SQL142)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query('ALTER TABLE public.check_cases NO FORCE ROW LEVEL SECURITY');
    await admin.query(`ALTER POLICY ${SQL142_UPDATE} ${P} WITH CHECK (true)`);
    const sql142Drift = await inspect();
    assert.deepEqual(sql142Drift.precondition_failures, ['predecessors_applied', 'mortgage_companies_sql142_policies_replaceable']);
    assert.notEqual(sql142Drift.live_definition_sha256, PRE_SQL142, 'SQL 142\'s policies are in the fingerprint');
    assert.equal((await apply(PRE_SQL142)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`ALTER POLICY ${SQL142_UPDATE} ${P} WITH CHECK (public.aws_is_tenant_manager_admin() AND is_active)`);
    assert.equal((await inspect()).live_definition_sha256, PRE_SQL142);
    assert.deepEqual(await others(), before);

    // A pending pin cannot apply; a wrong recorded state refuses.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: PRE_SQL142 });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    assert.equal((await apply(PINS[KEY].intended_replacement_sha256)).code, CODES.INVALID_MANIFEST);
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal((await inspect()).live_definition_sha256, PRE_SQL142);

    // One apply on the intended fingerprint.
    const applied = await apply(PRE_SQL142);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRE_SQL142);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(await others(), before, 'the SELECT and owner policies unchanged');
    const rendered = (await admin.query(`SET search_path = pg_catalog; SELECT pol.polname, pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS q,
      pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS w FROM pg_catalog.pg_policy pol
      WHERE pol.polrelid = 'public.mortgage_companies'::regclass ORDER BY 1;
      SELECT pg_catalog.pg_get_triggerdef(tg.oid) AS def FROM pg_catalog.pg_trigger tg WHERE tg.tgname = '${TRIGGER}'`));
    await admin.query('RESET search_path');
    assert.deepEqual(rendered[1].rows.filter((r) => r.polname.endsWith('_member')), [
      { polname: DELETE_POLICY, q: EDITOR_ACTIVE, w: null },
      { polname: INSERT_POLICY, q: null, w: EDITOR_ACTIVE },
      { polname: UPDATE_POLICY, q: EDITOR_ACTIVE, w: EDITOR_ACTIVE },
    ]);
    assert.ok(!rendered[1].rows.some((r) => [SQL142_INSERT, SQL142_UPDATE].includes(r.polname)));
    assert.deepEqual(rendered[2].rows, [{ def: TRIGGER_DEF }]);
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(PRE_SQL142)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
