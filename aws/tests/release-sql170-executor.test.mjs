/**
 * SQL 170 (aws/workflows/sql/170_check_endorsement_email_status.sql) in the staging guarded executor, on the release
 * engine shared with SQL 90-169 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-19: "Is there anyway
 * for tenants to see if an email has been delivered and opened? For this to show up near the payee signature request",
 * then "Yeah build 1 and 2".
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 170 included); this file covers what is new:
 *
 *   - the pin: pending, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing; nothing names it;
 *   - the file and spec: three SECURITY DEFINER functions (VOLATILE, search_path public, row_security off, EXECUTE
 *     checksops), eight columns on check_endorsements with no column grant, one partial index; nothing else; the expected
 *     pre-state (everything absent) derived from the spec;
 *   - on PostgreSQL 16 (check_endorsements as production has it: RLS on, SELECT for checksops): the pre-state read back as
 *     derived; a pending pin and drift refused; one apply through the executor reaches the intended fingerprint; a
 *     re-apply is refused.
 * The behavior is aws/tests/sql170-check-endorsement-email-status-pg.test.mjs.
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
  AUTHORIZED_SQL170_CHECK_ENDORSEMENT_EMAIL_STATUS,
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
const NOW = '2026-11-19T12:00:00.000Z';
const KEY = 'sql170';
const TABLE = 'public.check_endorsements';
const INDEX = 'check_endorsements_email_message_id_idx';
const INDEX_DEF = `CREATE INDEX ${INDEX} ON ${TABLE} USING btree (email_message_id) WHERE (email_message_id IS NOT NULL)`;
const SENT = 'public.aws_endorsement_email_sent(uuid, text)';
const EVENT = 'public.aws_endorsement_email_event(text, text, timestamp with time zone, text)';
const OPENED = 'public.aws_endorsement_link_opened(uuid)';
const COLUMNS = Object.freeze([
  ['email_message_id', 'text', false, null],
  ['email_delivered_at', 'timestamp with time zone', false, null],
  ['email_bounced_at', 'timestamp with time zone', false, null],
  ['email_bounce_reason', 'text', false, null],
  ['email_complained_at', 'timestamp with time zone', false, null],
  ['link_first_opened_at', 'timestamp with time zone', false, null],
  ['link_last_opened_at', 'timestamp with time zone', false, null],
  ['link_open_count', 'integer', true, '0'],
]);
/** The pre-state both databases are expected to have: the functions, the columns and the index absent. */
const ABSENT_PRE = releaseStateHash(KEY, {});
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** check_endorsements as production has it for this file: RLS on, table SELECT for checksops and authenticated. */
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
    expiry: '2026-11-19T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql170-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 170 pending, code-derived, selectable, packed, in step with the pending production pin; no predecessor; the derived pre-state', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL170_CHECK_ENDORSEMENT_EMAIL_STATUS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/170_check_endorsement_email_status.sql');
  assert.equal(pin.migration_id, '170_check_endorsement_email_status');
  assert.equal(spec.choice, 'sql170-check-endorsement-email-status');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending until a reviewed pin change records a staging read-live.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT_PRE, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-170-apply.md'), 'utf8');
  for (const value of [ABSENT_PRE, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql170-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [EVENT, SENT, OPENED]);
  assert.deepEqual(spec.functions.map((f) => f.identity), [EVENT, SENT, OPENED]);
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 170.
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
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.authorization_phrase, 'SHOW_ENDORSEMENT_EMAIL_STATUS');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.equal(prod.staging_acceptance.ok, false);
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

test('reviewed file and spec: three DEFINER functions with EXECUTE for checksops only, eight columns and one partial index on check_endorsements; nothing else', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs).sort(), ['aws_endorsement_email_event', 'aws_endorsement_email_sent', 'aws_endorsement_link_opened']);
  for (const [name, result] of [['aws_endorsement_email_sent', 'boolean'], ['aws_endorsement_email_event', 'integer'], ['aws_endorsement_link_opened', 'integer']]) {
    const fn = defs[name];
    assert.equal(fn.security_definer, true, name);
    assert.equal(fn.language, 'plpgsql', name);
    assert.equal(fn.volatility, 'v', name);
    assert.equal(fn.result, result, name);
    assert.deepEqual([...fn.config].sort(), ['row_security=off', 'search_path=public'], name);
    // Each writes check_endorsements only, never status, signed_at, the token or updated_at.
    assert.deepEqual([...new Set([...fn.prosrc.matchAll(/\bpublic\.([a-z_]+)\b/g)].map((m) => m[1]))], ['check_endorsements'], name);
    assert.doesNotMatch(fn.prosrc, /\b(INSERT|DELETE|TRUNCATE|EXECUTE)\b/i, name);
    assert.doesNotMatch(fn.prosrc, /\b(status|signed_at|token|updated_at)\s*=/, name);
  }
  assert.match(defs.aws_endorsement_email_event.prosrc, /IF v_event NOT IN \('delivered', 'bounced', 'complained'\) THEN\s+RAISE EXCEPTION 'invalid_email_event' USING ERRCODE = '22023';/);
  assert.match(defs.aws_endorsement_email_sent.prosrc, /email_delivered_at = NULL,\s+email_bounced_at = NULL,\s+email_bounce_reason = NULL,\s+email_complained_at = NULL/);
  assert.match(defs.aws_endorsement_link_opened.prosrc, /link_open_count = e\.link_open_count \+ 1/);
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').replace(/'(?:[^']|'')*'/g, "''");
  const statements = outside.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements.map((s) => s.split(' ').slice(0, 3).join(' ')), [
    'DO $body$',
    'ALTER TABLE public.check_endorsements',
    'CREATE INDEX IF',
    'CREATE OR REPLACE',
    'CREATE OR REPLACE',
    'CREATE OR REPLACE',
    'REVOKE ALL ON',
    'REVOKE ALL ON',
    'REVOKE ALL ON',
    'DO $body$',
    'GRANT EXECUTE ON',
    'GRANT EXECUTE ON',
    'GRANT EXECUTE ON',
  ]);
  assert.equal(statements[2], `CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} (email_message_id) WHERE email_message_id IS NOT NULL`);
  assert.deepEqual(statements.slice(6, 9), [SENT, EVENT, OPENED].map((f) => `REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`));
  assert.deepEqual(statements.slice(10), [SENT, EVENT, OPENED].map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO checksops`));
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|TRIGGER|VIEW)\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /ROW LEVEL SECURITY/i, /\bTO\s+authenticated\b/i, /\bCONSTRAINT\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/i]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  assert.match(TEXT, /NOT APPLIED\. Apply only through the guarded SQL path/);
  for (const code55000 of ['sql170_prerequisite_missing', 'sql170_definer_cannot_write', 'sql170_column_conflict']) {
    assert.match(TEXT, new RegExp(`RAISE EXCEPTION '${code55000}`), code55000);
  }
  assert.match(TEXT, /sql170_already_current/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [EVENT, SENT, OPENED].map((identity) => ({ identity, acl: ['checksops EXECUTE', 'owner EXECUTE'] })));
  assert.deepEqual(spec.definer_writes, [TABLE]);
  assert.deepEqual(spec.added_columns.map((c) => [c.table, c.column, c.type, c.notnull, c.default, c.acl]),
    COLUMNS.map(([column, type, notnull, def]) => [TABLE, column, type, notnull, def, []]));
  assert.deepEqual(spec.indexes, [{ table: TABLE, name: INDEX, def: INDEX_DEF }]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.deepEqual(spec.prerequisites, [TABLE, 'role checksops', `column ${TABLE}.id`]);
  for (const absent of ['table_privileges', 'render', 'altered_columns', 'constraints', 'triggers', 'policies', 'tables', 'views', 'column_acl', 'whole_tables']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The intended and pre-state renderings, as the runbook prints them.
  const intended = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(intended, /^release sql170 v1\nfunction public\.aws_endorsement_email_event\(text, text, timestamp with time zone, text\): lang=plpgsql vol=v parallel=u secdef=true result=integer config=row_security=off;search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE\n/);
  assert.match(intended, /\ncolumn public\.check_endorsements\.link_open_count: integer notnull=true default=[0-9a-f]{64} acl=\n/);
  assert.match(intended, /\ncolumn public\.check_endorsements\.email_message_id: text notnull=false default=- acl=\n/);
  assert.ok(intended.endsWith(`\nindex ${TABLE} ${INDEX}: ${sha(INDEX_DEF)}`), intended.split('\n').pop());
  assert.equal(sha(intended), PINS[KEY].intended_replacement_sha256);
  assert.equal(sha(releaseStateText(KEY, {})), ABSENT_PRE);
  const scope = releaseUnrelatedScope(KEY);
  // The unrelated-state snapshot skips only the file's objects; every other object must not change.
  assert.deepEqual(scope.skip_columns, COLUMNS.map(([column]) => `${TABLE}.${column}`));
  assert.deepEqual(scope.skip_not_null_columns, COLUMNS.map(([column]) => `${TABLE}.${column}`));
  assert.deepEqual(scope.skip_indexes, [`public.${INDEX}`]);
  // Pre-conditions: the prerequisites, the table owned by the login and writable past RLS. No predecessor.
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    altered: { [TABLE]: { exists: true, owner_is_login: true } }, definer: { [TABLE]: true },
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ altered: { [TABLE]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ definer: { [TABLE]: false } }), ['definer_can_write_relations']);
  assert.deepEqual(pre({ prerequisites_missing: [TABLE] }), ['prerequisites_present']);
  // A column already there with another type, or an index with another definition, refuses.
  assert.ok(pre({ columns: { [`${TABLE}.email_message_id`]: { exists: true, type: 'character varying(10)', notnull: false, default: null, acl: [] } } }).includes('added_columns_absent_or_intended'));
  assert.ok(pre({ indexes: { [`${TABLE} ${INDEX}`]: { exists: true, def: `CREATE INDEX ${INDEX} ON ${TABLE} USING btree (email_message_id)` } } }).includes('added_indexes_absent_or_intended'));
});

async function withPg(t, prefix, port, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [ENDORSEMENTS] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 170 through the executor: the pre-state as derived, a pending pin and drift refused, one apply reaches the intended fingerprint, a re-apply is refused', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql170-exec-', 60270, async ({ admin, connectAs }) => {
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

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.equal(r.already_applied, false);
  // The live pre-state is the one the runbook and the pins name.
  assert.equal(r.live_definition_sha256, ABSENT_PRE);
  // A pending pin cannot apply.
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN email_message_id text`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`ALTER TABLE ${TABLE} DROP COLUMN email_message_id`);
  assert.equal((await inspect()).live_definition_sha256, r.live_definition_sha256);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  // The existing row got link_open_count 0 and nothing else changed.
  assert.deepEqual((await admin.query(`SELECT status, link_open_count, email_message_id FROM ${TABLE}`)).rows,
    [{ status: 'sent', link_open_count: 0, email_message_id: null }]);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
