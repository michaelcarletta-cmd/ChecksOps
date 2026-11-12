/**
 * SQL 153 (aws/workflows/sql/153_second_mortgagee_fee.sql) in the staging guarded executor, on the release engine
 * shared with SQL 90-156 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-10/11: the flat $5 for a
 * check's 2nd mortgage company ("Flat $5", "it should be an additional $5 if 2 mortgage companies are on check");
 * tooling "Option B".
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 153 included); this file covers what is new:
 *
 *   - the pin: staging-authorized (wave 49) from staging read-live run 43115484335, code-derived, selectable, packed, in step with the production pin (applied 2026-11-12 and retired, from production's own pre-state, the same one staging had); the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing;
 *   - the file and spec: the unique index check_billing_events_one_second_mortgagee_per_check (the file's own
 *     predicate) and two integer NOT NULL DEFAULT 0 columns on tenant_maintenance_payments; no function; the file's
 *     step 1 (an event_type CHECK rewritten from its live values) is NOT modelled: the catalog count event_type_checks
 *     (the file's own selection) must be 0 (no_event_type_check); the absent and intended states derived;
 *   - the engine's no_event_type_check (new for SQL 153): passes at 0, refuses at 1, unreadable or missing; no other
 *     key declares it or is affected by the count; the report carries the count;
 *   - on PostgreSQL 16 (the release fixture with the billing tables): the absent state read back as derived with the
 *     count 0; a CHECK on event_type is refused before execution (nothing changed, the fingerprint unchanged); a pending
 *     pin and drift cannot apply; one apply through the executor reaches the intended fingerprint, then is refused as
 *     already in place.
 * The behavior is aws/tests/sql153-second-mortgagee-fee-pg.test.mjs.
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
  AUTHORIZED_SQL153_SECOND_MORTGAGEE_FEE,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  RELEASE_STAGING_SQL_KEYS,
  collapse,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseSqlReport,
  releaseStateHash,
  releaseStateText,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-11T12:00:00.000Z';
const KEY = 'sql153';
const EVENTS = 'public.check_billing_events';
const PAYMENTS = 'public.tenant_maintenance_payments';
const INDEX = 'check_billing_events_one_second_mortgagee_per_check';
const COLUMNS = ['mortgage_ops_second_mortgagee_count', 'mortgage_ops_second_mortgagee_amount_cents'];
const INDEX_DEF = `CREATE UNIQUE INDEX ${INDEX} ON public.check_billing_events USING btree (check_intake_item_id) WHERE ((event_type = 'mortgage_ops_second_mortgagee'::text) AND (status IS DISTINCT FROM 'voided'::text) AND (check_intake_item_id IS NOT NULL))`;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
/** The index and both columns absent. */
const ABSENT = releaseStateHash(KEY, {});
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(overrides = {}) {
  const key = overrides.key || KEY;
  const pin = overrides.pin || PINS[key];
  const rest = { ...overrides };
  delete rest.pin;
  delete rest.key;
  const event = {
    action: 'apply',
    workstream_id: `staging-${RELEASE_SQL_SPECS[key].choice}`,
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
    one_use_id: `${key}-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    expiry: '2026-11-11T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key = KEY) => releaseEvent({ key, action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql153-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// What the release fixture (with SQL 98's billing tables) lacks for SQL 153: the columns its prerequisite check names.
const SQL153_SCHEMA = `
ALTER TABLE public.check_billing_events ADD COLUMN claim_id uuid, ADD COLUMN mortgage_request_id uuid;
ALTER TABLE public.mortgage_handling_requests ADD COLUMN endorsement_order integer, ADD COLUMN total_mortgagees integer;`;

test('pin: SQL 153 staging-authorized from its read-live, code-derived, selectable, packed, in step with the applied and retired production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL153_SECOND_MORTGAGEE_FEE, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/153_second_mortgagee_fee.sql');
  assert.equal(pin.migration_id, '153_second_mortgagee_fee');
  assert.equal(spec.choice, 'sql153-second-mortgagee-fee');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-11-11, "record the SQL 153 staging pin" and "merge it when green") from
  // staging read-live run 43115484335: already_applied false, precondition_failures [], event_type_checks 0. It read the derived
  // state (the index and both columns absent).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-11: staging apply (wave 49) from staging read-live run 43115484335');
  assert.equal(pin.expected_live_definition_sha256, ABSENT);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint, the source and the
  // step it does not model.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-153-apply.md'), 'utf8');
  for (const value of [ABSENT, pin.intended_replacement_sha256, pin.source_sha256, INDEX_DEF, 'no_event_type_check', '**not modelled; the tooling requires none**']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 49\) and to production \(2026-11-12\); the production pin is retired/);
  assert.match(runbook, /read-live \(2026-11-11\)\.\*\* Run 43115484335/);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql153-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], []);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only', 'production_noop']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 153, and no other release migration names its index or columns.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = JSON.stringify(RELEASE_SQL_SPECS[key]);
    for (const name of [INDEX, ...COLUMNS]) assert.ok(!other.includes(name), `${key} ${name}`);
  }
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, []);
  assert.deepEqual(prod.predecessors, []);
  // Production pin execute-authorized (owner-approved pin change of 2026-11-11, #1795) on the staging apply, then applied
  // on 2026-11-12 and retired. Its pre-state is production's own (read-only inspect SSM decbb3ce), the derived one, the
  // same pre-state staging recorded.
  assert.equal(prod.execute, false);
  assert.match(prod.authorization, /^Applied to production on 2026-11-12; execute is false again/);
  assert.equal(prod.applied.result, 'applied');
  assert.equal(prod.applied.receipt.before_hash, prod.expected_live_definition_sha256);
  assert.equal(prod.applied.receipt.after_hash, prod.intended_replacement_sha256);
  assert.equal(prod.applied.post_apply_inspect.already_applied, true);
  assert.equal(prod.authorization_phrase, 'CHARGE_SECOND_MORTGAGEE_FEE');
  assert.equal(prod.expected_live_definition_sha256, prod.production_inspect.live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, ABSENT);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.equal(prod.staging_acceptance.ok, true);
  assert.ok(prod.production_inspect.note.includes(ABSENT));
  assert.ok(prod.production_inspect.note.includes('counts.event_type_checks 0'));
  assert.ok(prod.order_note.includes(ABSENT));
  assert.ok(prod.order_note.includes('is NOT modelled by the release engine'));
  assert.ok(prod.order_note.includes('Step 1 is therefore a no-op on every database this tooling applies to'));
  assert.ok(prod.intended_post_state.note.includes(pin.intended_replacement_sha256));
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

test('reviewed file and spec: the index and the two columns modelled, the event_type CHECK step required absent by the file\'s own selection; no function', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  assert.deepEqual(releaseFunctionDefinitions(TEXT), {});
  const spec = RELEASE_SQL_SPECS[KEY];
  // The prerequisites are the file's own (sql153_prerequisite_missing), nothing more.
  assert.deepEqual(spec.prerequisites, [
    EVENTS, 'public.mortgage_handling_requests', PAYMENTS,
    ...['event_type', 'status', 'check_intake_item_id', 'claim_id', 'mortgage_request_id'].map((c) => `column ${EVENTS}.${c}`),
    'column public.mortgage_handling_requests.endorsement_order',
  ]);
  for (const name of ['public.check_billing_events', 'public.mortgage_handling_requests', 'public.tenant_maintenance_payments']) {
    assert.ok(TEXT.includes(`to_regclass('${name}')`), name);
  }
  assert.ok(TEXT.includes("column_name IN ('event_type', 'status', 'check_intake_item_id', 'claim_id', 'mortgage_request_id')"));
  assert.ok(TEXT.includes("column_name = 'endorsement_order'"));
  // The index: the file's own predicate constant (v_pred), as pg_get_indexdef renders it.
  assert.deepEqual(spec.indexes, [{ table: EVENTS, name: INDEX, def: INDEX_DEF }]);
  const pred = /v_pred constant text :=\s*'((?:[^']|'')*)';/.exec(TEXT)[1].replace(/''/g, "'");
  assert.equal(INDEX_DEF, `CREATE UNIQUE INDEX ${INDEX} ON public.check_billing_events USING btree (check_intake_item_id) WHERE ${pred}`);
  assert.deepEqual(spec.added_columns, COLUMNS.map((column) => ({ table: PAYMENTS, column, type: 'integer', notnull: true, default: '0', acl: [] })));
  for (const column of COLUMNS) assert.match(TEXT, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} integer NOT NULL DEFAULT 0`));
  assert.deepEqual(spec.altered_relations, [EVENTS, PAYMENTS]);
  // Step 1 is not modelled: the count is the file's own loop selection (every CHECK whose columns include event_type).
  assert.deepEqual(spec.extra_preconditions, ['no_event_type_check']);
  assert.deepEqual(Object.keys(spec.counts), ['event_type_checks']);
  const count = spec.counts.event_type_checks;
  assert.deepEqual(count.requires, [EVENTS]);
  for (const clause of ["c.contype = 'c'", "a.attname = 'event_type' AND NOT a.attisdropped", '= ANY (c.conkey)']) assert.ok(count.sql.includes(clause), clause);
  for (const clause of ["c.contype = 'c'", 'v_attnum = ANY (c.conkey)', "a.attname = 'event_type' AND NOT a.attisdropped"]) assert.ok(collapse(TEXT).includes(clause), clause);
  assert.ok(TEXT.includes('DO $sql153_event_type_check$'));
  for (const kind of ['tables', 'policies', 'table_privileges', 'column_acl', 'acl_functions', 'dropped_functions', 'views', 'constraints',
    'triggers', 'dropped_triggers', 'dropped_policies', 'definer_writes', 'unique_covers', 'whole_tables', 'render', 'added_indexes', 'reads_library']) {
    assert.equal(spec[kind], undefined, kind);
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, []);
  assert.deepEqual(scope.skip_indexes, [`public.${INDEX}`]);
  assert.deepEqual(scope.skip_columns, COLUMNS.map((c) => `${PAYMENTS}.${c}`));
  assert.deepEqual(scope.skip_constraints, [], 'no constraint may change: step 1 must be a no-op');
  assert.deepEqual(releaseStateText(KEY, releaseIntendedState(KEY, TEXT)).split('\n'), [
    'release sql153 v1',
    ...COLUMNS.map((c) => `column ${PAYMENTS}.${c}: integer notnull=true default=${sha('0')} acl=`),
    `index ${EVENTS} ${INDEX}: ${sha(INDEX_DEF)}`,
  ]);
  assert.equal(releaseStateText(KEY, {}), ['release sql153 v1', ...COLUMNS.map((c) => `column ${PAYMENTS}.${c}: absent`), `index ${EVENTS} ${INDEX}: absent`].join('\n'));
});

test('engine: no_event_type_check passes at 0 and refuses at 1, unreadable or missing; it is SQL 153\'s alone; the report carries the count', () => {
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {},
    altered: { [EVENTS]: { exists: true, owner_is_login: true }, [PAYMENTS]: { exists: true, owner_is_login: true } },
    columns: {}, indexes: {}, counts: { event_type_checks: 0 },
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ counts: { event_type_checks: 1 } }), ['no_event_type_check']);
  assert.deepEqual(pre({ counts: { event_type_checks: 2 } }), ['no_event_type_check']);
  assert.deepEqual(pre({ counts: { event_type_checks: null } }), ['no_event_type_check']);
  assert.deepEqual(pre({ counts: {} }), ['no_event_type_check']);
  assert.deepEqual(pre({ counts: undefined }), ['no_event_type_check']);
  // The index and the columns: absent or the file's own; anything else refuses.
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(pre({ indexes: intended.indexes, columns: intended.columns }), []);
  assert.deepEqual(pre({ indexes: { [`${EVENTS} ${INDEX}`]: { exists: true, def: collapse(INDEX_DEF.replace(' AND (check_intake_item_id IS NOT NULL)', '')) } } }), ['added_indexes_absent_or_intended']);
  const column = `${PAYMENTS}.${COLUMNS[0]}`;
  assert.deepEqual(pre({ columns: { [column]: { ...intended.columns[column], type: 'bigint' } } }), ['added_columns_absent_or_intended']);
  assert.deepEqual(pre({ altered: { ...base.altered, [PAYMENTS]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  for (const name of RELEASE_SQL_SPECS[KEY].prerequisites) assert.ok(pre({ prerequisites_missing: [name] }).includes('prerequisites_present'), name);
  // No other key declares it, and the count changes no other key's preconditions.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    assert.ok(!(RELEASE_SQL_SPECS[key].extra_preconditions || []).includes('no_event_type_check'), key);
    assert.ok(!Object.hasOwn(RELEASE_SQL_SPECS[key].counts || {}, 'event_type_checks'), key);
    const text = fs.readFileSync(FILES[key], 'utf8');
    for (const n of [0, 1, null]) {
      assert.ok(!releaseSharedPreconditionFailures(key, { counts: { event_type_checks: n } }, text).includes('no_event_type_check'), `${key} ${n}`);
    }
  }
  // The read-live / inspect report carries the count; the count is not part of the fingerprint.
  assert.deepEqual(releaseSqlReport(KEY, { ...base, counts: { event_type_checks: 1 } }, TEXT).counts, { event_type_checks: 1 });
  assert.equal(releaseStateHash(KEY, { counts: { event_type_checks: 1 } }), ABSENT);
});

test('PostgreSQL 16: SQL 153 through the executor: the absent state as derived with no event_type CHECK; a CHECK on event_type refused before execution; a pending pin and drift cannot apply; one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql153-exec-', 59760, { extra: [...sql98To100Schema(), SQL153_SCHEMA] });
  const { admin, connectAs } = fx;
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
    const asOwner = async (sql) => admin.query(`SET ROLE checksops_admin; ${sql}; RESET ROLE;`);
    const checks = async () => (await admin.query(`SELECT conname, pg_catalog.pg_get_constraintdef(oid) AS def FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.check_billing_events'::regclass AND contype = 'c' ORDER BY conname`)).rows;
    const unchanged = async () => {
      assert.equal((await admin.query('SELECT pg_catalog.to_regclass($1) IS NULL AS absent', [`public.${INDEX}`])).rows[0].absent, true);
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public'
        AND table_name = 'tenant_maintenance_payments' AND column_name = ANY ($1)`, [COLUMNS])).rows[0].n, 0);
    };

    // The index and both columns absent, no CHECK on event_type: the derived state.
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(r.release_sql_inspect.predecessors, {});
    assert.deepEqual(r.release_sql_inspect.counts, { event_type_checks: 0 });
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, ABSENT);
    await unchanged();

    // A single-column CHECK on event_type (the shape the file would rewrite): reported, refused before execution,
    // nothing changed; the count is a precondition, not part of the fingerprint.
    await asOwner(`ALTER TABLE ${EVENTS} ADD CONSTRAINT check_billing_events_event_type_check
      CHECK (event_type IN ('check_processing', 'mortgage_ops_initial', 'mortgage_ops_additional_check'))`);
    const before = await checks();
    const withCheck = await inspect();
    assert.deepEqual(withCheck.precondition_failures, ['no_event_type_check'], JSON.stringify(withCheck.release_sql_inspect));
    assert.deepEqual(withCheck.release_sql_inspect.counts, { event_type_checks: 1 });
    assert.equal(withCheck.live_definition_sha256, ABSENT);
    assert.equal((await apply(ABSENT)).code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(await checks(), before, 'the CHECK was not rewritten');
    await unchanged();
    // A CHECK naming event_type with another column (the file would refuse it) is counted too.
    await asOwner(`ALTER TABLE ${EVENTS} DROP CONSTRAINT check_billing_events_event_type_check;
      ALTER TABLE ${EVENTS} ADD CONSTRAINT check_billing_events_event_status_check CHECK (event_type <> status)`);
    const multi = await inspect();
    assert.deepEqual(multi.precondition_failures, ['no_event_type_check']);
    assert.deepEqual(multi.release_sql_inspect.counts, { event_type_checks: 1 });
    assert.equal((await apply(ABSENT)).code, CODES.DEPLOYMENT_COLLISION);
    await asOwner(`ALTER TABLE ${EVENTS} DROP CONSTRAINT check_billing_events_event_status_check`);
    await unchanged();
    // A CHECK on another column only is not counted (and stays, untouched, through the apply below).
    await asOwner(`ALTER TABLE ${EVENTS} ADD CONSTRAINT check_billing_events_price_check CHECK (unit_price_cents >= 0)`);
    const OTHER_CHECK = [{ conname: 'check_billing_events_price_check', def: 'CHECK ((unit_price_cents >= 0))' }];
    assert.deepEqual(await checks(), OTHER_CHECK);
    const other = await inspect();
    assert.deepEqual(other.precondition_failures, []);
    assert.deepEqual(other.release_sql_inspect.counts, { event_type_checks: 0 });
    assert.equal(other.live_definition_sha256, ABSENT);

    // A pending pin cannot apply.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    // Drift between the recorded pre-state and the apply refuses.
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);
    await unchanged();

    const applied = await apply(ABSENT);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(after.release_sql_inspect.counts, { event_type_checks: 0 });
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.release_sql_inspect.indexes.map((row) => row.state), ['intended']);
    assert.deepEqual(after.release_sql_inspect.columns.map((row) => row.state), ['intended', 'intended']);
    assert.equal((await admin.query('SELECT pg_catalog.pg_get_indexdef($1::regclass) AS d', [`public.${INDEX}`])).rows[0].d, INDEX_DEF);
    assert.deepEqual(await checks(), OTHER_CHECK, 'step 1 changed nothing');
    // A second apply: refused, the database already past the pinned pre-state.
    assert.notEqual((await apply(ABSENT)).ok, true);
    // Re-running the reviewed bytes is a no-op on the fingerprint (idempotent).
    await asOwner(TEXT);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
