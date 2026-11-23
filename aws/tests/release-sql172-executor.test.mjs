/**
 * SQL 172 (aws/workflows/sql/172_check_endorsement_email_engagement.sql) in the staging guarded executor, on the release
 * engine shared with SQL 90-171 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-23: "Yes build
 * opened and clicked" (Resend's opened and clicked events for a payee's endorsement request email, next to Delivered).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 172 included); this file covers what is new:
 *
 *   - the pin: staging-authorized (wave 64) from staging read-live run 45267758829 (applied in staging by run 45276313813), code-derived,
 *     selectable, packed, in step with the execute-authorized production pin (production's own pre-state); the pinned commit
 *     authored the bytes; predecessor SQL 170, supersedes nothing; nothing names it;
 *   - the file and spec: one SECURITY DEFINER function (VOLATILE, search_path public, row_security off, EXECUTE
 *     checksops), six columns on check_endorsements with no column grant; nothing else; no SQL 170 object; the expected
 *     pre-state (everything absent) derived from the spec;
 *   - on PostgreSQL 16 (check_endorsements as production has it: RLS on, SELECT for checksops): refused before SQL 170
 *     (predecessors_applied); with SQL 170 applied as the owner the pre-state reads back as derived; a pending pin and
 *     drift refused; one apply through the executor reaches the intended fingerprint; a re-apply is refused; SQL 170
 *     still reads applied.
 * The behavior is aws/tests/sql172-check-endorsement-email-engagement-pg.test.mjs.
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
  AUTHORIZED_SQL172_CHECK_ENDORSEMENT_EMAIL_ENGAGEMENT,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  RELEASE_STAGING_SQL_KEYS,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseStateHash,
  releaseStateText,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-23T12:00:00.000Z';
const KEY = 'sql172';
const TABLE = 'public.check_endorsements';
const ENGAGEMENT = 'public.aws_endorsement_email_engagement(text, text, timestamp with time zone)';
const COLUMNS = Object.freeze([
  ['email_first_opened_at', 'timestamp with time zone', false, null],
  ['email_last_opened_at', 'timestamp with time zone', false, null],
  ['email_open_count', 'integer', true, '0'],
  ['email_first_clicked_at', 'timestamp with time zone', false, null],
  ['email_last_clicked_at', 'timestamp with time zone', false, null],
  ['email_click_count', 'integer', true, '0'],
]);
/** The pre-state both databases are expected to have: the function and the columns absent. */
const ABSENT_PRE = releaseStateHash(KEY, {});
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL170_TEXT = fs.readFileSync(path.join(ROOT, PINS.sql170.filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** check_endorsements as production has it before SQL 170: RLS on, table SELECT for checksops and authenticated. */
const ENDORSEMENTS = `
CREATE TABLE ${TABLE} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid,
  payee_name text,
  status text NOT NULL DEFAULT 'pending',
  token text,
  signed_at timestamptz,
  request_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE ${TABLE} TO checksops, authenticated;
INSERT INTO ${TABLE} (id, payee_name, status) VALUES ('77777777-7777-4777-8777-777777777777', 'Payee', 'sent');`;

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
    expiry: '2026-11-23T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql172-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 172 staging-authorized from its read-live, code-derived, selectable, packed, in step with the execute-authorized production pin; predecessor SQL 170; the derived pre-state', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL172_CHECK_ENDORSEMENT_EMAIL_ENGAGEMENT, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/172_check_endorsement_email_engagement.sql');
  assert.equal(pin.migration_id, '172_check_endorsement_email_engagement');
  assert.equal(spec.choice, 'sql172-check-endorsement-email-engagement');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-11-23) from staging read-live run 45267758829: already_applied false,
  // precondition_failures [], predecessors { sql170: true }. It read the derived pre-state (everything absent).
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-23: staging apply (wave 64) from staging read-live run 45267758829');
  assert.equal(pin.expected_live_definition_sha256, ABSENT_PRE);
  assert.equal(pin.expected_live_definition_sha256, 'dbf6a7240cfc5dd737cd47e7f0f765cf6349c0a3a8625a39e02f4901c2e29897');
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-172-apply.md'), 'utf8'), /\*\*Status:\*\* applied in staging \(wave 64, 2026-11-23, apply run 45276313813\); staging acceptance: the staging apply under the owner's run approval \("run the SQL 172 staging apply"; no separate acceptance statement\); production pin execute-authorized on production's own pre-state \(read-only inspect SSM `03050f81-bebc-4566-a116-35147b3410f6`, 2026-11-23\) by the owner-reviewed pin change; not applied in production\./);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-172-apply.md'), 'utf8'), /read-live \(2026-11-23\)\.\*\* Run 45267758829/);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT_PRE, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-172-apply.md'), 'utf8');
  for (const value of [ABSENT_PRE, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 64, 2026-11-23, apply run 45276313813\);/);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql172-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [ENGAGEMENT]);
  assert.deepEqual(spec.functions.map((f) => f.identity), [ENGAGEMENT]);
  assert.deepEqual(spec.predecessors, ['sql170']);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 172.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [...pin.function_identities]);
  assert.deepEqual(prod.predecessors, ['sql170']);
  // Production pin execute-authorized (owner-approved pin change of 2026-11-23) on the staging apply from the same pre-state.
  // Its pre-state is production's own (read-only inspect SSM 03050f81): the six columns and the function absent, equal to the staging pin's.
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-11-23 /);
  assert.equal(prod.authorization_phrase, 'SHOW_ENDORSEMENT_EMAIL_OPENED_AND_CLICKED');
  assert.equal(prod.expected_live_definition_sha256, prod.production_inspect.live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, ABSENT_PRE);
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.notEqual(prod.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.equal(prod.staging_acceptance.ok, true);
  assert.equal(prod.staging_acceptance.reference, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/45276313813');
  assert.ok(prod.production_inspect.note.includes(ABSENT_PRE));
  assert.ok(prod.order_note.includes(ABSENT_PRE));
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

test('reviewed file and spec: one DEFINER function with EXECUTE for checksops only and six columns on check_endorsements; no SQL 170 object; nothing else', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['aws_endorsement_email_engagement']);
  const fn = defs.aws_endorsement_email_engagement;
  assert.equal(fn.security_definer, true);
  assert.equal(fn.language, 'plpgsql');
  assert.equal(fn.volatility, 'v');
  assert.equal(fn.result, 'boolean');
  assert.deepEqual([...fn.config].sort(), ['row_security=off', 'search_path=public']);
  // It writes check_endorsements only, never status, signed_at, the token, updated_at or SQL 170's columns.
  assert.deepEqual([...new Set([...fn.prosrc.matchAll(/\bpublic\.([a-z_]+)\b/g)].map((m) => m[1]))], ['check_endorsements']);
  assert.doesNotMatch(fn.prosrc, /\b(INSERT|DELETE|TRUNCATE|EXECUTE|RAISE)\b/i);
  const sets = [...fn.prosrc.matchAll(/\bSET([\s\S]*?)\bWHERE\b/g)].map((m) => [...m[1].matchAll(/(?:^|,)\s*(\w+)\s*=/g)].map((a) => a[1]));
  assert.deepEqual(sets, [
    ['email_first_opened_at', 'email_last_opened_at', 'email_open_count'],
    ['email_first_clicked_at', 'email_last_clicked_at', 'email_click_count'],
  ]);
  // The row SQL 170's aws_endorsement_email_event finds: the trimmed id, first 200 characters, equal to email_message_id.
  assert.match(fn.prosrc, /v_id text := left\(btrim\(COALESCE\(p_email_id, ''\)\), 200\);/);
  assert.equal([...fn.prosrc.matchAll(/WHERE e\.email_message_id = v_id;/g)].length, 2);
  assert.match(fn.prosrc, /IF v_kind NOT IN \('opened', 'clicked'\) OR v_id = '' THEN\s+RETURN false;/);
  assert.match(fn.prosrc, /v_at timestamp with time zone := COALESCE\(p_at, now\(\)\);/);
  for (const kind of ['opened', 'clicked']) {
    const count = kind === 'opened' ? 'open' : 'click';
    assert.match(fn.prosrc, new RegExp(`email_first_${kind}_at = COALESCE\\(e\\.email_first_${kind}_at, v_at\\),\\s+`
      + `email_last_${kind}_at = GREATEST\\(COALESCE\\(e\\.email_last_${kind}_at, v_at\\), v_at\\),\\s+`
      + `email_${count}_count = e\\.email_${count}_count \\+ 1`), kind);
  }
  assert.match(fn.prosrc, /RETURN v_count > 0;/);
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').replace(/'(?:[^']|'')*'/g, "''");
  const statements = outside.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements.map((s) => s.split(' ').slice(0, 3).join(' ')), [
    'DO $body$',
    'ALTER TABLE public.check_endorsements',
    'CREATE OR REPLACE',
    'REVOKE ALL ON',
    'DO $body$',
    'GRANT EXECUTE ON',
  ]);
  assert.equal(statements[3], `REVOKE ALL ON FUNCTION ${ENGAGEMENT} FROM PUBLIC`);
  assert.equal(statements[5], `GRANT EXECUTE ON FUNCTION ${ENGAGEMENT} TO checksops`);
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|TRIGGER|VIEW|INDEX)\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /ROW LEVEL SECURITY/i, /\bTO\s+authenticated\b/i, /\bCONSTRAINT\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/i]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  // No SQL 170 object is created, replaced or re-granted.
  for (const name of ['aws_endorsement_email_sent', 'aws_endorsement_email_event', 'aws_endorsement_link_opened', 'check_endorsements_email_message_id_idx']) {
    assert.doesNotMatch(outside, new RegExp(`(CREATE|ALTER|GRANT|REVOKE)[^;]*\\b${name}\\b`), name);
  }
  assert.match(TEXT, /NOT APPLIED\. Apply only through the guarded SQL path/);
  for (const code55000 of ['sql172_prerequisite_missing', 'sql172_definer_cannot_write', 'sql172_column_conflict']) {
    assert.match(TEXT, new RegExp(`RAISE EXCEPTION '${code55000}`), code55000);
  }
  assert.match(TEXT, /sql172_already_current/);
  // The file's own prerequisite check names SQL 170's column and function.
  assert.match(TEXT, /pg_catalog\.to_regprocedure\('public\.aws_endorsement_email_event\(text, text, timestamp with time zone, text\)'\)/);
  assert.match(TEXT, /FROM \(VALUES \('email_message_id'\), \('id'\)\) AS want\(col\)/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{ identity: ENGAGEMENT, acl: ['checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.deepEqual(spec.definer_writes, [TABLE]);
  assert.deepEqual(spec.added_columns.map((c) => [c.table, c.column, c.type, c.notnull, c.default, c.acl]),
    COLUMNS.map(([column, type, notnull, def]) => [TABLE, column, type, notnull, def, []]));
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.deepEqual(spec.prerequisites, [TABLE, 'role checksops', `column ${TABLE}.id`]);
  for (const absent of ['table_privileges', 'render', 'altered_columns', 'constraints', 'triggers', 'policies', 'tables', 'views', 'column_acl', 'whole_tables', 'indexes']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The intended and pre-state renderings, as the runbook prints them.
  const intended = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(intended, /^release sql172 v1\nfunction public\.aws_endorsement_email_engagement\(text, text, timestamp with time zone\): lang=plpgsql vol=v parallel=u secdef=true result=boolean config=row_security=off;search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE\n/);
  assert.match(intended, /\ncolumn public\.check_endorsements\.email_open_count: integer notnull=true default=[0-9a-f]{64} acl=\n/);
  assert.match(intended, /\ncolumn public\.check_endorsements\.email_first_opened_at: timestamp with time zone notnull=false default=- acl=\n/);
  assert.ok(intended.endsWith('\ncolumn public.check_endorsements.email_click_count: integer notnull=true default=' + sha('0') + ' acl='), intended.split('\n').pop());
  assert.equal(sha(intended), PINS[KEY].intended_replacement_sha256);
  assert.equal(sha(releaseStateText(KEY, {})), ABSENT_PRE);
  const scope = releaseUnrelatedScope(KEY);
  // The unrelated-state snapshot skips only the file's objects; every other object must not change.
  assert.deepEqual(scope.skip_columns, COLUMNS.map(([column]) => `${TABLE}.${column}`));
  assert.deepEqual(scope.skip_not_null_columns, COLUMNS.map(([column]) => `${TABLE}.${column}`));
  assert.deepEqual(scope.skip_indexes, []);
  // Pre-conditions: the prerequisites, SQL 170, the table owned by the login and writable past RLS.
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    altered: { [TABLE]: { exists: true, owner_is_login: true } }, definer: { [TABLE]: true },
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ predecessors_applied: false }), ['predecessors_applied']);
  assert.deepEqual(pre({ altered: { [TABLE]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ definer: { [TABLE]: false } }), ['definer_can_write_relations']);
  assert.deepEqual(pre({ prerequisites_missing: [TABLE] }), ['prerequisites_present']);
  // A column already there with another type or default refuses.
  assert.ok(pre({ columns: { [`${TABLE}.email_first_opened_at`]: { exists: true, type: 'timestamp without time zone', notnull: false, default: null, acl: [] } } }).includes('added_columns_absent_or_intended'));
  assert.ok(pre({ columns: { [`${TABLE}.email_click_count`]: { exists: true, type: 'integer', notnull: true, default: '1', acl: [] } } }).includes('added_columns_absent_or_intended'));
});

test('PostgreSQL 16: SQL 172 through the executor: refused before SQL 170, the pre-state as derived, a pending pin and drift refused, one apply reaches the intended fingerprint, a re-apply is refused; SQL 170 still applied', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql172-exec-', 61172, { extra: [ENDORSEMENTS] });
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
    const runAsOwner = async (sql) => {
      const owner = await connectAs('checksops_admin');
      try {
        await owner.query(sql);
      } finally {
        await owner.end();
      }
    };

    // Before SQL 170: refused.
    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.predecessors, { sql170: false });
    assert.ok(early.precondition_failures.includes('predecessors_applied'));
    assert.equal(early.live_definition_sha256, ABSENT_PRE);
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);

    await runAsOwner(SQL170_TEXT);
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.predecessors, { sql170: true });
    assert.equal(r.already_applied, false);
    // The live pre-state is the one the runbook and the pins name.
    assert.equal(r.live_definition_sha256, ABSENT_PRE);
    // The committed staging pin is authorized on exactly this pre-state (wave 64, read-live run 45267758829).
    assert.equal(r.pin_executable, true);
    // A pending pin cannot apply: a pending copy of the committed pin (the committed pin is staging-authorized, wave 64).
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    // Drift between the recorded pre-state and the apply refuses.
    await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN email_open_count integer NOT NULL DEFAULT 0`);
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await admin.query(`ALTER TABLE ${TABLE} DROP COLUMN email_open_count`);
    assert.equal((await inspect()).live_definition_sha256, r.live_definition_sha256);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    // SQL 170 still reads applied: SQL 172 changes none of its objects.
    assert.deepEqual(after.release_sql_inspect.predecessors, { sql170: true });
    // The existing row got both counts 0 and nothing else changed.
    assert.deepEqual((await admin.query(`SELECT status, link_open_count, email_open_count, email_click_count, email_first_opened_at FROM ${TABLE}`)).rows,
      [{ status: 'sent', link_open_count: 0, email_open_count: 0, email_click_count: 0, email_first_opened_at: null }]);
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
