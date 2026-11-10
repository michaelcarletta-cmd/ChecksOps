/**
 * SQL 148 (aws/workflows/sql/148_second_mortgagee_link.sql) in the staging guarded executor, on the release engine
 * shared with SQL 90-147 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 148 included); this file covers what is
 * new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the production pin (pending too); the pinned
 *     commit authored the bytes; no predecessor; nothing supersedes or names it;
 *   - the file and spec: the unique index public.mortgage_handling_requests_one_open_per_check redefined in place
 *     (the spec's two definitions are the file's own constants) and one new DEFINER function,
 *     aws_link_second_mortgagee(uuid, uuid): plpgsql, VOLATILE, SECURITY DEFINER, search_path public, pg_temp, RETURNS
 *     jsonb; the sign-in gate, the member gate, both rows locked FOR UPDATE, two UPDATEs of the request table and no
 *     other write; the prerequisite, index and REVOKE DO blocks and GRANT EXECUTE TO checksops, nothing else; the
 *     spec's prerequisites, the definer relation and the per-check unique count (the file's own query);
 *   - the engine's index entry with `replaces` (new for SQL 148): the pre-state is code-derived
 *     (releaseReplacedPreState: the function absent, the index at the Supabase definition); the index is accepted only
 *     at the Supabase definition or the file's own (replaced_indexes_replaceable), the count must be 0
 *     (no_other_per_check_unique_index); the report names the live definition by label (index_definitions); a spec
 *     without `replaces` (SQL 98, SQL 147) keeps its checks and report;
 *   - on PostgreSQL 16 (the release fixture with the two-mortgagee columns and the Supabase index, verbatim): the
 *     inspect reads the pre-state as derived here and reports the Supabase definition; refused while a column is
 *     missing, the table is under FORCE ROW LEVEL SECURITY, another per-check unique index exists, or the index is
 *     absent or another definition; accepted (another fingerprint) with the index already at SQL 148's definition; a
 *     pending pin cannot apply; an unexpected pre-state is refused (DEPLOYMENT_COLLISION); one apply through the
 *     executor reaches the intended fingerprint (EXECUTE for checksops and the owner, the index re-keyed), then a
 *     second apply is refused (UNRELATED_MUTATION: already in place).
 * The behavior (who may link what, the 2nd request accepted while the 1st is open) is
 * aws/tests/sql148-second-mortgagee-link-pg.test.mjs.
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
  AUTHORIZED_SQL148_SECOND_MORTGAGEE_LINK,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  collapse,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseReplacedPreState,
  releaseSharedPostconditionFailures,
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseSqlReport,
  releaseStateHash,
  releaseStateText,
  releaseUnrelatedScope,
  replacedIndexLabel,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-10T12:00:00.000Z';
const KEY = 'sql148';
const FN = 'aws_link_second_mortgagee';
const IDENTITY = `public.${FN}(uuid, uuid)`;
const IDENTITIES = Object.freeze([IDENTITY]);
const TABLE = 'public.mortgage_handling_requests';
const INDEX = 'mortgage_handling_requests_one_open_per_check';
const INDEX_KEY = `${TABLE} ${INDEX}`;
const INDEX_REPORT_NAME = `mortgage_handling_requests ${INDEX}`;
const SUPABASE_LABEL = 'supabase_20260715110727';
const SUPABASE_MIGRATION = 'supabase/migrations/20260715110727_2bb7c7e2-f94a-476f-87fa-db5f47ccc030.sql';
const COLUMNS = Object.freeze(['id', 'tenant_id', 'check_intake_item_id', 'status', 'endorsement_order', 'total_mortgagees', 'predecessor_request_id']);
const ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The file's two index constants, as PostgreSQL renders them (the '' quoting undone). */
const fileConstant = (name) => {
  const m = new RegExp(`${name} constant text := '((?:[^']|'')*)';`).exec(TEXT);
  assert.ok(m, name);
  return m[1].replace(/''/g, "'");
};
const SQL148_DEF = fileConstant('c_sql148');
const SUPABASE_DEF = fileConstant('c_supabase');

/** The pre-state both databases should have: the function absent and the index at the Supabase definition. */
const PRE = releaseStateHash(KEY, releaseReplacedPreState(KEY));
/** The function absent and the index already at SQL 148's definition: accepted, but another fingerprint. */
const INDEX_ONLY = releaseStateHash(KEY, { functions: {}, indexes: { [INDEX_KEY]: { exists: true, def: collapse(SQL148_DEF) } } });

/**
 * What SQL 148 reads on top of the release fixture (run as the superuser before everything is handed to
 * checksops_admin): the two-mortgagee columns (as #1739 / the Supabase migrations add them) and the Supabase per-check
 * unique index, verbatim from its migration.
 */
const SUPABASE_INDEX_SQL = (() => {
  const text = fs.readFileSync(path.join(ROOT, SUPABASE_MIGRATION), 'utf8');
  const from = text.indexOf(`CREATE UNIQUE INDEX ${INDEX}`);
  const to = text.indexOf(';', from);
  assert.ok(from > 0 && to > from, 'the Supabase index is in its migration');
  return text.slice(from, to + 1);
})();
const MORTGAGEE_SCHEMA = `
ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN IF NOT EXISTS endorsement_order integer,
  ADD COLUMN IF NOT EXISTS predecessor_request_id uuid REFERENCES public.mortgage_handling_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS total_mortgagees integer;
${SUPABASE_INDEX_SQL}`;

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
    expiry: '2026-11-10T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql148-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 148 pending, code-derived, selectable, packed, in step with the production pin; no predecessor; nothing names it', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL148_SECOND_MORTGAGEE_LINK, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/148_second_mortgagee_link.sql');
  assert.equal(pin.migration_id, '148_second_mortgagee_link');
  assert.equal(spec.choice, 'sql148-second-mortgagee-link');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet (and no apply authorized).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // The pre-state (the function absent, the index at the Supabase definition) has a fingerprint of its own, distinct
  // from the intended one, from "everything absent" and from the index already re-keyed.
  assert.notEqual(PRE, pin.intended_replacement_sha256);
  assert.notEqual(PRE, releaseStateHash(KEY, {}));
  assert.notEqual(PRE, INDEX_ONLY);
  assert.notEqual(INDEX_ONLY, pin.intended_replacement_sha256);
  assert.deepEqual(releaseStateText(KEY, releaseReplacedPreState(KEY)).split('\n'), [
    'release sql148 v1',
    `function ${IDENTITY}: absent`,
    `index ${TABLE} ${INDEX}: ${sha(SUPABASE_DEF)}`,
  ]);
  assert.equal(releaseStateHash(KEY, releaseReplacedPreState(KEY, SUPABASE_LABEL)), PRE);
  // The runbook and the production pin name the expected pre-state (derived here) and the intended fingerprint.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-148-apply.md'), 'utf8');
  for (const value of [PRE, pin.intended_replacement_sha256, pin.source_sha256, sha(SUPABASE_DEF), sha(SQL148_DEF), SUPABASE_DEF, SQL148_DEF, SUPABASE_LABEL]) {
    assert.ok(runbook.includes(value), value);
  }
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseReplacedPreState(KEY))}\n\`\`\``));
  const defs = releaseFunctionDefinitions(TEXT);
  assert.ok(runbook.includes(sha(defs[FN].prosrc)));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql148-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [...IDENTITIES]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  // No predecessor; nothing supersedes, refuses after or depends on it.
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['runs_before', 'supersedes', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates, replaces, drops or re-grants the function, or names the index or creates the table.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    assert.ok(!touched.includes(IDENTITY), key);
    assert.ok(!(other.indexes || []).some((i) => i.name === INDEX) && !(other.added_indexes || []).includes(`public.${INDEX}`), key);
    assert.ok(!(other.tables || []).some((t) => t.name === TABLE), key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [...IDENTITIES]);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.ok(prod.production_inspect.note.includes(PRE));
  assert.ok(prod.order_note.includes(PRE));
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

test('reviewed file and spec: the index redefined in place from the Supabase definition; one new DEFINER function with the sign-in and member gates, both rows locked and two UPDATEs of the request table; the DO blocks, the REVOKE and GRANT EXECUTE TO checksops, nothing else', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), [FN]);
  const def = defs[FN];
  assert.equal(def.language, 'plpgsql');
  assert.equal(def.volatility, 'v');
  assert.equal(def.parallel, 'u');
  assert.equal(def.security_definer, true);
  assert.equal(def.result, 'jsonb');
  assert.deepEqual(def.config, ['search_path=public, pg_temp']);
  const strip = (text) => text.replace(/--[^\n]*/g, '');
  const body = strip(def.prosrc);
  assert.match(body, /v_uid uuid := auth\.uid\(\);/);
  assert.match(body, /BEGIN\s+IF v_uid IS NULL THEN\s+RAISE EXCEPTION 'mortgagee_link_forbidden'\s+USING ERRCODE = '42501';/);
  assert.match(body, /IF NOT COALESCE\(public\.aws_can_write_tenant\(v_row\.tenant_id\), false\) THEN\s+RAISE EXCEPTION 'mortgagee_link_request_not_found'\s+USING ERRCODE = 'P0002';/);
  assert.match(body, /WHERE r\.id IN \(_first_request_id, _second_request_id\)\s+ORDER BY r\.id\s+FOR UPDATE/);
  assert.equal([...body.matchAll(/FOR UPDATE/g)].length, 1);
  assert.match(body, /RAISE EXCEPTION 'mortgagee_link_conflict'\s+USING ERRCODE = '23505';/);
  // Two writes, both UPDATEs of the request table; no INSERT, DELETE or other table.
  assert.deepEqual([...body.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.[a-z_]+)?/gi)].map((m) => m[0].trim()).filter((w) => w !== 'UPDATE'),
    ['UPDATE public.mortgage_handling_requests', 'UPDATE public.mortgage_handling_requests']);
  assert.match(body, /SET endorsement_order = 1, total_mortgagees = 2\s+WHERE id = _first_request_id;/);
  assert.match(body, /SET endorsement_order = 2, total_mortgagees = 2, predecessor_request_id = _first_request_id\s+WHERE id = _second_request_id;/);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, IDENTITIES.map((identity) => ({ identity, acl: [...ACL], revokes: [...REVOKES] })));
  // The file's prerequisite block names the same objects and columns, and nothing else.
  const fileObjects = [...TEXT.matchAll(/^\s+\('([^']+)', (?:pg_catalog\.to_reg|\(SELECT r\.oid)/gm)].map((m) => m[1]);
  assert.deepEqual(fileObjects, [TABLE, 'public.aws_can_write_tenant(uuid)', 'auth.uid()', 'role checksops']);
  const fileColumns = /FROM unnest\(ARRAY\[([^\]]+)\]\) AS want\(col\)/.exec(TEXT)[1].match(/'([a-z_]+)'/g).map((c) => c.slice(1, -1));
  assert.deepEqual(fileColumns, [...COLUMNS]);
  assert.deepEqual(spec.prerequisites, [...fileObjects, ...COLUMNS.map((c) => `column ${TABLE}.${c}`)]);
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.definer_writes, [TABLE]);
  // The index: SQL 148's definition and the one it replaces are the file's own constants, and the Supabase one is the
  // Supabase migration's index (rendered; re-derived on PostgreSQL 16 below).
  assert.deepEqual(spec.indexes, [{ table: TABLE, name: INDEX, def: SQL148_DEF, replaces: [{ label: SUPABASE_LABEL, def: SUPABASE_DEF }] }]);
  assert.match(SUPABASE_INDEX_SQL, /^CREATE UNIQUE INDEX mortgage_handling_requests_one_open_per_check\s+ON public\.mortgage_handling_requests \(check_intake_item_id\)\s+WHERE status IN \('requested','in_progress'\);$/);
  // The per-check unique count is the file's own query (sql148_other_per_check_unique).
  assert.deepEqual(spec.extra_preconditions, ['no_other_per_check_unique_index']);
  assert.deepEqual(Object.keys(spec.counts), ['other_per_check_unique_indexes']);
  const count = spec.counts.other_per_check_unique_indexes;
  assert.deepEqual(count.requires, [TABLE]);
  for (const clause of ['i.indisunique AND i.indisvalid', 'i.indnkeyatts = 1', 'i.indexprs IS NULL',
    "a.attname = 'check_intake_item_id' AND NOT a.attisdropped", `c.relname <> '${INDEX}'`]) {
    assert.ok(count.sql.includes(clause), clause);
    assert.ok(collapse(TEXT).includes(clause), clause);
  }
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'unique_covers', 'whole_tables', 'dropped_functions', 'added_indexes',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'dropped_triggers']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The prerequisite, index and REVOKE DO blocks, one CREATE OR REPLACE FUNCTION, the REVOKE from PUBLIC, the GRANT.
  const code = strip(TEXT);
  for (const block of ['sql148_prereq', 'sql148_index', 'sql148_revoke']) assert.equal([...code.matchAll(new RegExp(`\\bDO\\s+\\$${block}\\$`, 'g'))].length, 1, block);
  assert.equal([...code.matchAll(/\bDO\s+\$/g)].length, 3);
  for (const code_ of ['sql148_prerequisite_missing', 'sql148_definer_cannot_write', 'sql148_unexpected_index', 'sql148_other_per_check_unique', 'sql148_duplicate_open_requests', 'sql148_index_not_created']) {
    assert.match(code, new RegExp(code_), code_);
  }
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 1);
  assert.equal([...code.matchAll(/^GRANT\b.*$/gm)].map((m) => m[0]).join('\n'), `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`);
  assert.equal([...code.matchAll(/^REVOKE\b.*$/gm)].map((m) => m[0]).join('\n'), `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`);
  // Outside the function body: one DROP INDEX and one CREATE UNIQUE INDEX of this index, nothing else structural.
  const outsideBodies = code.replace(strip(def.prosrc), '');
  assert.deepEqual([...outsideBodies.matchAll(/\bDROP\s+\S+\s+\S+/g)].map((m) => m[0]), [`DROP INDEX public.${INDEX};`]);
  // (The file's two definition constants spell CREATE UNIQUE INDEX too, inside string literals, not as statements.)
  assert.deepEqual([...outsideBodies.matchAll(/^\s*CREATE\s+UNIQUE\s+INDEX\s+\S+/gm)].map((m) => m[0].trim()), [`CREATE UNIQUE INDEX ${INDEX}`]);
  assert.equal([...outsideBodies.matchAll(/constant text := 'CREATE UNIQUE INDEX /g)].length, 2);
  for (const forbidden of [/\bALTER\b/, /\bCOMMENT\b/, /\bCREATE\s+(TABLE|POLICY|VIEW|TRIGGER)\b/i, /\bCREATE\s+INDEX\b/i,
    /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/, /\bPOLICY\b/]) {
    assert.doesNotMatch(outsideBodies, forbidden, String(forbidden));
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [...IDENTITIES]);
  assert.deepEqual(scope.skip_indexes, [`public.${INDEX}`]);
  assert.deepEqual(scope.skip_relations, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.deepEqual(text.split('\n'), [
    'release sql148 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=${sha(def.prosrc)} acl=checksops EXECUTE;owner EXECUTE`,
    `index ${TABLE} ${INDEX}: ${sha(SQL148_DEF)}`,
  ]);
});

test('engine: an index redefined in place is accepted only at a replaced definition or its own; the count must be 0; the report labels the live definition; specs without replaces keep their checks', () => {
  const at = (def) => ({ [INDEX_KEY]: def == null ? { exists: false } : { exists: true, def: collapse(def) } });
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {},
    definer: { [TABLE]: true }, indexes: at(SUPABASE_DEF), counts: { other_per_check_unique_indexes: 0 },
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const fn = (acl, over = {}) => ({ functions: { [IDENTITY]: { ...releaseIntendedState(KEY, TEXT).functions[IDENTITY], owner_is_login: true, acl: [...acl], ...over } } });
  const OTHER_DEF = SUPABASE_DEF.replace(' WHERE (status = ANY (ARRAY[\'requested\'::text, \'in_progress\'::text]))', '');
  assert.notEqual(OTHER_DEF, SUPABASE_DEF);
  // The index: the Supabase definition or SQL 148's own; absent or any other definition refuses.
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ indexes: at(SQL148_DEF) }), []);
  assert.deepEqual(pre({ indexes: at(null) }), ['replaced_indexes_replaceable']);
  assert.deepEqual(pre({ indexes: {} }), ['replaced_indexes_replaceable']);
  assert.deepEqual(pre({ indexes: at(OTHER_DEF) }), ['replaced_indexes_replaceable']);
  // Another per-check unique index (or an unreadable count) refuses.
  assert.deepEqual(pre({ counts: { other_per_check_unique_indexes: 1 } }), ['no_other_per_check_unique_index']);
  assert.deepEqual(pre({ counts: { other_per_check_unique_indexes: null } }), ['no_other_per_check_unique_index']);
  assert.deepEqual(pre({ counts: {} }), ['no_other_per_check_unique_index']);
  // The table unreachable by the DEFINER owner, or a prerequisite missing.
  assert.deepEqual(pre({ definer: { [TABLE]: false } }), ['definer_can_write_relations']);
  for (const name of RELEASE_SQL_SPECS[KEY].prerequisites) assert.ok(pre({ prerequisites_missing: [name] }).includes('prerequisites_present'), name);
  // An existing function (a re-run): owned by the login, the jsonb result, only grants the file keeps or revokes.
  assert.deepEqual(pre(fn(ACL)), []);
  assert.deepEqual(pre(fn([...REVOKES, ...ACL])), []);
  assert.deepEqual(pre(fn([...ACL, 'sql148_plain EXECUTE'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fn(ACL, { owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fn(ACL, { result: 'SETOF record' })), ['function_results_match']);

  // The label of the live definition, never the definition.
  const [entry] = RELEASE_SQL_SPECS[KEY].indexes;
  assert.equal(replacedIndexLabel(entry, at(SUPABASE_DEF)[INDEX_KEY]), SUPABASE_LABEL);
  assert.equal(replacedIndexLabel(entry, at(SQL148_DEF)[INDEX_KEY]), 'intended');
  assert.equal(replacedIndexLabel(entry, at(null)[INDEX_KEY]), 'absent');
  assert.equal(replacedIndexLabel(entry, undefined), 'absent');
  assert.equal(replacedIndexLabel(entry, at(OTHER_DEF)[INDEX_KEY]), 'other');
  const report = (indexes) => releaseSqlReport(KEY, { ...base, indexes }, TEXT);
  assert.deepEqual(report(at(SUPABASE_DEF)).index_definitions, [{ name: INDEX_REPORT_NAME, definition: SUPABASE_LABEL }]);
  assert.deepEqual(report(at(SQL148_DEF)).index_definitions, [{ name: INDEX_REPORT_NAME, definition: 'intended' }]);
  assert.deepEqual(report(at(OTHER_DEF)).index_definitions, [{ name: INDEX_REPORT_NAME, definition: 'other' }]);
  assert.deepEqual(report(at(SUPABASE_DEF)).indexes, [{ name: INDEX_REPORT_NAME, state: 'different' }]);
  assert.deepEqual(report(at(SQL148_DEF)).indexes, [{ name: INDEX_REPORT_NAME, state: 'intended' }]);
  assert.doesNotMatch(JSON.stringify(report(at(SUPABASE_DEF))), /CREATE|check_intake_item_id\)/);

  // The pre-state helper covers only new functions and indexes redefined in place, and names labels it knows.
  assert.deepEqual(releaseReplacedPreState(KEY), { functions: { [IDENTITY]: { exists: false } }, indexes: at(SUPABASE_DEF) });
  assert.throws(() => releaseReplacedPreState(KEY, 'nope'), /replaces no definition labelled nope/);
  for (const key of ['sql98', 'sql147']) assert.throws(() => releaseReplacedPreState(key), /covers only new functions and indexes redefined in place/, key);

  // Specs without replaces: SQL 98's index entry keeps added_indexes_absent_or_intended, and no report gains
  // index_definitions.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    assert.ok(!(RELEASE_SQL_SPECS[key].indexes || []).some((i) => i.replaces), key);
    assert.equal(Object.hasOwn(releaseSqlReport(key, {}, null), 'index_definitions'), false, key);
  }
  const sql98 = RELEASE_SQL_SPECS.sql98.indexes[0];
  const sql98Text = fs.readFileSync(path.join(ROOT, PINS.sql98.filename), 'utf8');
  const sql98State = (def) => ({ ...base, indexes: { [`${sql98.table} ${sql98.name}`]: def == null ? { exists: false } : { exists: true, def: collapse(def) } } });
  const sql98Pre = (def) => releaseSharedPreconditionFailures('sql98', sql98State(def), sql98Text);
  assert.ok(!sql98Pre(null).includes('added_indexes_absent_or_intended'));
  assert.ok(!sql98Pre(sql98.def).includes('added_indexes_absent_or_intended'));
  assert.ok(sql98Pre(`${sql98.def} WHERE false`).includes('added_indexes_absent_or_intended'));
  for (const def of [null, sql98.def, `${sql98.def} WHERE false`]) assert.ok(!sql98Pre(def).includes('replaced_indexes_replaceable'));

  // Post-conditions: the intended fingerprint with the function owned by the login.
  const post = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: { [IDENTITY]: { exists: true, owner_is_login: true } },
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: PRE }), PINS[KEY]), ['intended_state']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: INDEX_ONLY }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 148 through the executor: the pre-state as derived (the Supabase index); refused while a column is missing, the table is FORCE RLS, another per-check unique index exists, or the index is absent or another definition; a pending pin and an unexpected pre-state cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql148-exec-', 60410, { extra: [MORTGAGEE_SCHEMA] });
  const { connectAs } = fx;
  try {
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
    const present = async () => (await fx.admin.query('SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present', [IDENTITY])).rows[0].present;
    const indexDef = async () => (await fx.admin.query(`SELECT pg_catalog.pg_get_indexdef(i.indexrelid) AS d, pg_catalog.pg_get_userbyid(c.relowner) AS owner
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`, [INDEX])).rows[0] || null;
    const executeAcl = async () => (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
    const asOwner = async (sql) => fx.admin.query(`SET ROLE checksops_admin; ${sql}; RESET ROLE;`);
    const restoreSupabase = async () => asOwner(`DROP INDEX IF EXISTS public.${INDEX}; ${SUPABASE_INDEX_SQL.replace(/;$/, '')}`);
    const unchanged = async () => {
      assert.equal(await present(), false);
      assert.equal((await indexDef()).d, SUPABASE_DEF);
    };

    // The pre-state: the function absent, the Supabase index (rendered as the spec and the file expect it), every
    // prerequisite present, the table reachable, no other per-check unique index.
    assert.deepEqual(await indexDef(), { d: SUPABASE_DEF, owner: 'checksops_admin' });
    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(pre.release_sql_inspect.predecessors, {});
    assert.deepEqual(pre.release_sql_inspect.definer_writes, [{ name: 'mortgage_handling_requests', ok: true }]);
    assert.deepEqual(pre.release_sql_inspect.index_definitions, [{ name: INDEX_REPORT_NAME, definition: SUPABASE_LABEL }]);
    assert.deepEqual(pre.release_sql_inspect.counts, { other_per_check_unique_indexes: 0 });
    assert.deepEqual(pre.release_sql_inspect.functions.map((f) => f.state), ['absent']);
    assert.equal(pre.already_applied, false);
    assert.equal(pre.live_definition_sha256, PRE);
    await unchanged();

    // The table under FORCE ROW LEVEL SECURITY (the DEFINER owner would be filtered): refused, nothing applied.
    await fx.admin.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`);
    const forced = await inspect();
    assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], JSON.stringify(forced.release_sql_inspect));
    assert.equal((await apply(PRE)).code, CODES.DEPLOYMENT_COLLISION);
    await unchanged();
    await fx.admin.query(`ALTER TABLE ${TABLE} NO FORCE ROW LEVEL SECURITY`);

    // A column it reads or writes missing: refused, nothing applied.
    await fx.admin.query(`ALTER TABLE ${TABLE} RENAME COLUMN predecessor_request_id TO predecessor_moved`);
    const missing = await inspect();
    assert.ok(missing.release_sql_inspect.prerequisites_missing.includes(`column ${TABLE}.predecessor_request_id`), JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
    assert.deepEqual(missing.precondition_failures, ['prerequisites_present']);
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query(`ALTER TABLE ${TABLE} RENAME COLUMN predecessor_moved TO predecessor_request_id`);
    await unchanged();

    // Another unique index keying the table on check_intake_item_id alone: refused (the file would refuse too).
    await asOwner(`CREATE UNIQUE INDEX mhr_other_per_check ON ${TABLE} (check_intake_item_id) WHERE status = 'requested'`);
    const other = await inspect();
    assert.deepEqual(other.precondition_failures, ['no_other_per_check_unique_index']);
    assert.deepEqual(other.release_sql_inspect.counts, { other_per_check_unique_indexes: 1 });
    assert.equal(other.live_definition_sha256, PRE, 'the count is a precondition, not part of the fingerprint');
    assert.equal((await apply(PRE)).code, CODES.DEPLOYMENT_COLLISION);
    await asOwner('DROP INDEX public.mhr_other_per_check');
    await unchanged();

    // The index under another definition, then absent: refused, reported by label, nothing applied.
    await asOwner(`DROP INDEX public.${INDEX}; CREATE UNIQUE INDEX ${INDEX} ON ${TABLE} (check_intake_item_id, status)`);
    const otherDef = await inspect();
    assert.deepEqual(otherDef.precondition_failures, ['replaced_indexes_replaceable']);
    assert.deepEqual(otherDef.release_sql_inspect.index_definitions, [{ name: INDEX_REPORT_NAME, definition: 'other' }]);
    assert.notEqual(otherDef.live_definition_sha256, PRE);
    assert.equal((await apply(otherDef.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await asOwner(`DROP INDEX public.${INDEX}`);
    const absent = await inspect();
    assert.deepEqual(absent.precondition_failures, ['replaced_indexes_replaceable']);
    assert.deepEqual(absent.release_sql_inspect.index_definitions, [{ name: INDEX_REPORT_NAME, definition: 'absent' }]);
    assert.equal(absent.live_definition_sha256, releaseStateHash(KEY, {}));
    assert.equal((await apply(absent.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await present(), false);
    assert.equal(await indexDef(), null);

    // The index already at SQL 148's definition (the function absent): accepted, another fingerprint, as derived.
    await asOwner(`CREATE UNIQUE INDEX ${INDEX} ON ${TABLE} (check_intake_item_id, (COALESCE(endorsement_order, 1))) WHERE status IN ('requested', 'in_progress')`);
    assert.equal((await indexDef()).d, SQL148_DEF);
    const rekeyed = await inspect();
    assert.deepEqual(rekeyed.precondition_failures, []);
    assert.deepEqual(rekeyed.release_sql_inspect.index_definitions, [{ name: INDEX_REPORT_NAME, definition: 'intended' }]);
    assert.equal(rekeyed.live_definition_sha256, INDEX_ONLY);
    await restoreSupabase();
    await unchanged();
    assert.equal((await inspect()).live_definition_sha256, PRE);

    // A pending pin cannot apply (the committed pin is pending; pend a copy with the pre-state recorded).
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: PRE });
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }));
    assert.equal(pending.ok, false);
    await unchanged();

    // An unexpected pre-state: a pin recording the intended state as the pre-state is not a valid authorization
    // package; a pin recording a hash the database does not show refuses on the live state. Nothing applied either way.
    const onIntended = await apply(PINS[KEY].intended_replacement_sha256);
    assert.equal(onIntended.ok, false, JSON.stringify(onIntended));
    assert.equal(onIntended.code, CODES.INVALID_MANIFEST);
    const unknown = await apply('f'.repeat(64));
    assert.equal(unknown.ok, false, JSON.stringify(unknown));
    assert.equal(unknown.code, CODES.DEPLOYMENT_COLLISION);
    await unchanged();
    assert.equal((await inspect()).live_definition_sha256, PRE);

    // One apply on the intended fingerprint: the function exists, owned by the login, EXECUTE for checksops and the
    // owner; the index re-keyed, owned with the table; everything else in schema public unchanged (the executor's
    // unrelated-catalog check).
    const applied = await apply(PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(applied.details.receipt.release_sql_inspect.index_definitions, [{ name: INDEX_REPORT_NAME, definition: 'intended' }]);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(after.release_sql_inspect.functions.map((f) => f.state), ['intended']);
    assert.deepEqual(after.release_sql_inspect.indexes, [{ name: INDEX_REPORT_NAME, state: 'intended' }]);
    assert.equal(await present(), true);
    assert.deepEqual(await indexDef(), { d: SQL148_DEF, owner: 'checksops_admin' });
    assert.deepEqual(await executeAcl(), { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] });
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(after.live_definition_sha256)).ok, false);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
