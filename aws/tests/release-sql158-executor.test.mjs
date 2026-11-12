/**
 * SQL 158 (aws/workflows/sql/158_mortgage_desk_oversight_and_agent_notes.sql) in the staging guarded executor, on the
 * release engine shared with SQL 90-156 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-12: Tenant
 * Management (the platform owner) sees every tenant's Mortgage Desk work with its age, assigns a queued request to an
 * agent, and writes private notes only the assigned agent reads; then "go with SQL 158" (SQL 157, never applied, kept the
 * default-privilege grants on its new table).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 158 included); this file covers what is new:
 *
 *   - the pin: staging-authorized (wave 50) from staging read-live run 43221906020, code-derived, selectable, packed, in step with the pending production pin; the pinned commit
 *     authored the bytes; no predecessor, supersedes nothing; SQL 157 has no pin;
 *   - the file and spec: SQL 157 plus SQL 118's revoke block for this table; one table (RLS on, no policy, no grant) and
 *     six SECURITY DEFINER functions (EXECUTE checksops and the owner) with their TABLE results; no other release
 *     migration touches them; the absent and intended states derived;
 *   - on PostgreSQL 16 with default privileges granting new tables to checksops and authenticated (the case that rolled
 *     SQL 117 back): the absent state read back as derived; a pending pin and drift cannot apply; one apply through the
 *     executor reaches the intended fingerprint with no grant left on the new table, then is refused as already in place;
 *     a drifted function grant or table grant is not intended; a re-run of the bytes keeps the fingerprint; SQL 157's
 *     bytes leave the default grants and never reach SQL 158's fingerprint.
 * The behavior is aws/tests/sql158-mortgage-desk-oversight-pg.test.mjs.
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
  AUTHORIZED_SQL158_MORTGAGE_DESK_OVERSIGHT_AND_AGENT_NOTES,
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
import { pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';
import { sliceFrom } from './helpers/sql145-collection-leg-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-12T12:00:00.000Z';
const KEY = 'sql158';
const TABLE = 'public.mortgage_desk_agent_notes';
const ACL = ['checksops EXECUTE', 'owner EXECUTE'];
const RESULTS = Object.freeze({
  'public.aws_mortgage_desk_overview(uuid, text, integer, integer)': 'TABLE(request_id uuid, tenant_id uuid, tenant_name text, status text, mortgage_company text, loan_number text, claim_number text, homeowner_name text, assigned_agent_id uuid, assigned_agent_name text, created_at timestamp with time zone, accepted_at timestamp with time zone, completed_at timestamp with time zone, status_since timestamp with time zone, seconds_in_status bigint, turnaround_seconds bigint, note_count integer, last_note_at timestamp with time zone, total_count bigint)',
  'public.aws_mortgage_desk_assignable_agents()': 'TABLE(agent_id uuid, agent_name text, in_progress_count integer)',
  'public.aws_mortgage_desk_assign_agent(uuid, uuid)': 'TABLE(request_id uuid, agent_id uuid, agent_name text, agent_email text, accepted_at timestamp with time zone, tenant_name text, mortgage_company text, loan_number text)',
  'public.aws_mortgage_desk_add_agent_note(uuid, text)': 'TABLE(note_id uuid, request_id uuid, agent_id uuid, agent_name text, agent_email text, created_at timestamp with time zone, tenant_name text, mortgage_company text, loan_number text)',
  'public.aws_mortgage_desk_record_agent_note_email(uuid, text)': 'boolean',
  'public.aws_mortgage_desk_agent_notes(uuid)': 'TABLE(note_id uuid, request_id uuid, author_id uuid, agent_id uuid, body text, email_status text, emailed_at timestamp with time zone, created_at timestamp with time zone)',
});
const FNS = Object.keys(RESULTS);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL157 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/157_mortgage_desk_oversight_and_agent_notes.sql'), 'utf8');
/** Everything SQL 158 creates absent. */
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
    expiry: '2026-11-12T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = (key = KEY) => releaseEvent({ key, action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql158-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// What the release fixture lacks: the Mortgage Desk columns and the agent roster (sql98To100Schema), the platform owner and
// Desk agent helpers SQL 158 calls (main's text), the Mortgage Ops audit table (SQL 84's columns), and default privileges
// that grant new tables to checksops and authenticated.
const EXTRA = [
  ...sql98To100Schema(),
  sliceFrom('aws/rls/sql/20_write_helpers.sql', 'CREATE OR REPLACE FUNCTION public.aws_is_authenticated()', '$$;'),
  sliceFrom('aws/rls/sql/10_owner_helpers_from_identity.sql', 'CREATE OR REPLACE FUNCTION public.is_platform_owner()', '$$;'),
  sliceFrom('aws/workflows/sql/100_mortgage_desk_live_access.sql', 'CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent()', '$$;'),
  `CREATE TABLE IF NOT EXISTS public.mortgage_ops_request_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mortgage_request_id uuid NOT NULL, actor_id uuid, action text NOT NULL,
  previous_agent_id uuid, reason text NOT NULL, from_status text, to_status text, accepted_at_preserved timestamptz,
  tenant_billing_event_id uuid, payload jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.mortgage_ops_request_audit ENABLE ROW LEVEL SECURITY;
ALTER DEFAULT PRIVILEGES FOR ROLE checksops_admin IN SCHEMA public GRANT ALL ON TABLES TO checksops, authenticated;`,
];

test('pin: SQL 158 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; no predecessor; SQL 157 has no pin', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL158_MORTGAGE_DESK_OVERSIGHT_AND_AGENT_NOTES, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/158_mortgage_desk_oversight_and_agent_notes.sql');
  assert.equal(pin.migration_id, '158_mortgage_desk_oversight_and_agent_notes');
  assert.equal(spec.choice, 'sql158-mortgage-desk-oversight-and-agent-notes');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending until a reviewed pin change records a staging read-live.
  assertStagingPinState(assert, KEY, pin);
  // Staging apply authorized (owner approved 2026-11-12, "approve SQL 158") from staging read-live run 43221906020:
  // already_applied false, precondition_failures []. It read the derived state (the table and all six functions absent).
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-12: staging apply (wave 50) from staging read-live run 43221906020');
  assert.equal(pin.expected_live_definition_sha256, ABSENT);
  assert.equal(pin.expected_live_definition_sha256, 'ed94cf62003c8ef29667a8b79dd081f8e0491bde28cf8ec1acee1154b877e233');
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-158-apply.md'), 'utf8'), /\*\*Status:\*\* staging pin execute-authorized \(wave 50\); not applied anywhere\. The production pin is pending\./);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-158-apply.md'), 'utf8'), /read-live \(2026-11-12\)\.\*\* Run 43221906020/);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.notEqual(ABSENT, pin.intended_replacement_sha256);
  assert.ok(RELEASE_STAGING_SQL_KEYS.includes(KEY));
  // SQL 157 is never applied: no spec, no pin, no workflow choice, not packed.
  assert.equal(RELEASE_SQL_SPECS.sql157, undefined);
  assert.equal(PINS.sql157, undefined);
  assert.ok(!AUTHORIZED_STAGING_SQL.some((p) => /\/157_/.test(p.filename)));
  assert.ok(!Object.keys(packed).some((file) => /\/157_/.test(file)));
  assert.doesNotMatch(workflow, /- sql157-/);
  // The runbook names the absent and intended states (derived here), the intended fingerprint and the source.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-158-apply.md'), 'utf8');
  for (const value of [ABSENT, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, releaseIntendedState(KEY, TEXT))}\n\`\`\``));
  assert.ok(runbook.includes(`\`\`\`\n${releaseStateText(KEY, {})}\n\`\`\``));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql158-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['supersedes', 'runs_before', 'refuse_after', 'production_only']) assert.equal(spec[absent], undefined, absent);
  // Nothing supersedes, refuses after or depends on SQL 158, and no other release migration touches its objects.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    for (const fn of FNS) assert.ok(!touched.includes(fn), `${key} ${fn}`);
    assert.ok(!(other.tables || []).some((t) => t.name === TABLE), key);
  }
  const prod = productionPin();
  assert.equal(prod.migration, KEY);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, FNS);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.authorization_phrase, 'START_MORTGAGE_DESK_OVERSIGHT_AND_AGENT_NOTES');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.equal(prod.staging_acceptance.ok, false);
  assert.ok(prod.production_inspect.note.includes(ABSENT));
  assert.ok(prod.order_note.includes(ABSENT));
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

test('reviewed file and spec: SQL 157 plus the revoke of every non-owner grant; one table with no grant, six SECURITY DEFINER functions with their ACLs and results; no other object', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  // SQL 158's statements are SQL 157's, but the revoke block and its own labels.
  const code = (text) => text.split('\n').filter((line) => !line.startsWith('--')).join('\n');
  const normalize = (text) => code(text).replace(/sql15[78]_/g, 'sqlN_').replace(/'SQL 15[78]: /g, "'SQL N: ").replace(/'sql15[78]'/g, "'sqlN'");
  const revoke = /DO \$sql158_table_acl\$[\s\S]*?\$sql158_table_acl\$;\n/;
  assert.match(TEXT, revoke);
  assert.equal(normalize(TEXT.replace(revoke, '')), normalize(SQL157.replace('REVOKE ALL ON TABLE public.mortgage_desk_agent_notes FROM PUBLIC, checksops;\n', '')));
  // The revoke block is SQL 118's, for this table.
  const sql118 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/118_platform_owner_tenant_lifecycle.sql'), 'utf8');
  const block118 = sql118.match(/DO \$sql118_table_acl\$[\s\S]*?\$sql118_table_acl\$;\n/)[0];
  assert.equal(TEXT.match(revoke)[0], block118.replace(/sql118/g, 'sql158').replace(/tenant_deactivations/g, 'mortgage_desk_agent_notes'));
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs).sort(), FNS.map((fn) => fn.replace(/^public\.|\(.*$/g, '')).sort());
  for (const name of Object.keys(defs)) {
    assert.equal(defs[name].security_definer, true, name);
    assert.deepEqual([...defs[name].config].sort(), ['row_security=off', 'search_path=public'], name);
  }
  const spec = RELEASE_SQL_SPECS[KEY];
  // Results are stated as the catalog reads them (pg_get_function_result), where the engine needs them (RETURNS TABLE).
  assert.deepEqual(spec.functions, FNS.map((identity) => ({
    identity, acl: ACL, ...(RESULTS[identity] !== 'boolean' ? { result: RESULTS[identity] } : {}),
  })));
  assert.deepEqual(spec.tables.map((t) => [t.name, t.rls, t.forced, t.acl]), [[TABLE, true, false, []]]);
  assert.deepEqual(spec.tables[0].constraints.map(([name]) => name), [
    'mortgage_desk_agent_notes_body_length', 'mortgage_desk_agent_notes_email_status', 'mortgage_desk_agent_notes_pkey', 'mortgage_desk_agent_notes_request_id_fkey']);
  assert.ok(spec.tables[0].constraints.some(([, def]) => def === 'FOREIGN KEY (request_id) REFERENCES public.mortgage_handling_requests(id) ON DELETE CASCADE'));
  assert.deepEqual(spec.definer_writes, ['public.mortgage_handling_requests', 'public.mortgage_ops_request_audit', 'public.mortgage_agent_accounts',
    'public.identity_accounts', 'public.profiles', 'public.user_roles', 'public.tenants']);
  for (const name of ['auth.uid()', 'public.is_platform_owner()', 'public.aws_is_mortgage_ops_agent()', 'public.has_role(uuid, public.app_role)']) {
    assert.ok(spec.prerequisites.includes(name), name);
    assert.ok(TEXT.includes(name.replace('(uuid, public.app_role)', '(')), name);
  }
  for (const kind of ['policies', 'table_privileges', 'column_acl', 'acl_functions', 'dropped_functions', 'views', 'indexes', 'added_columns', 'constraints', 'triggers', 'altered_relations']) {
    assert.equal(spec[kind], undefined, kind);
  }
  assert.deepEqual(releaseUnrelatedScope(KEY).skip_functions, FNS);
  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(text, /^release sql158 v1\n/);
  assert.match(text, /\ntable public\.mortgage_desk_agent_notes acl: (\n|$)/);
  assert.equal(releaseStateText(KEY, {}), ['release sql158 v1', ...FNS.map((fn) => `function ${fn}: absent`), `table ${TABLE}: absent`].join('\n'));
});

test('PostgreSQL 16, default privileges on: SQL 158 through the executor: the absent state as derived, a pending pin and drift cannot apply, one apply on the intended fingerprint (no grant on the new table), then already in place; drifted grants are not intended', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql158-exec-', 59750, { extra: EXTRA });
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
    const asOwner = async (text) => {
      const owner = await connectAs('checksops_admin');
      try { await owner.query(text); } finally { await owner.end(); }
    };
    const tableGrantees = async () => (await admin.query(`SELECT DISTINCT a.grantee::regrole::text AS g FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.oid = '${TABLE}'::regclass AND a.grantee <> c.relowner ORDER BY 1`)).rows.map((row) => row.g);

    // The table and the six functions absent: the derived state.
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(r.release_sql_inspect.definer_writes.map((w) => [w.name, w.ok]), [
      ['mortgage_handling_requests', true], ['mortgage_ops_request_audit', true], ['mortgage_agent_accounts', true],
      ['identity_accounts', true], ['profiles', true], ['user_roles', true], ['tenants', true]]);
    assert.equal(r.already_applied, false);
    assert.equal(r.live_definition_sha256, ABSENT);
    // A pending pin cannot apply.
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT });
    assert.equal((await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }))).ok, false);
    assert.equal((await admin.query(`SELECT to_regclass('${TABLE}') AS t`)).rows[0].t, null);
    // Drift between the recorded pre-state and the apply refuses.
    assert.equal((await apply('f'.repeat(64))).code, CODES.DEPLOYMENT_COLLISION);

    const applied = await apply(ABSENT);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    // The default-privilege grants on the new table are gone.
    assert.deepEqual(await tableGrantees(), []);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.release_sql_inspect.functions.map((row) => row.state), FNS.map(() => 'intended'));
    assert.deepEqual(after.release_sql_inspect.function_acl.map((row) => row.acl), FNS.map(() => ACL));
    // The live results are the spec's.
    for (const fn of FNS) {
      assert.equal((await admin.query('SELECT pg_get_function_result($1::regprocedure) AS r', [fn])).rows[0].r, RESULTS[fn], fn);
    }
    // No policy or trigger came with it; authenticated cannot call any function.
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_policy WHERE polrelid = '${TABLE}'::regclass`)).rows[0].n, 0);
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = '${TABLE}'::regclass AND NOT tgisinternal`)).rows[0].n, 0);
    for (const fn of FNS) {
      assert.equal((await admin.query(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS a`, [fn])).rows[0].a, false, fn);
    }
    // A second apply: refused, the database already past the pinned pre-state.
    assert.notEqual((await apply(ABSENT)).ok, true);
    // A drifted function grant is not intended, nor a table grant.
    await admin.query(`GRANT EXECUTE ON FUNCTION ${FNS[0]} TO authenticated`);
    try {
      assert.equal((await inspect()).already_applied, false);
    } finally {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${FNS[0]} FROM authenticated`);
    }
    await admin.query(`GRANT SELECT ON ${TABLE} TO authenticated`);
    try {
      assert.equal((await inspect()).already_applied, false);
    } finally {
      await admin.query(`REVOKE SELECT ON ${TABLE} FROM authenticated`);
    }
    // Re-running the reviewed bytes is a no-op on the fingerprint (idempotent).
    await asOwner(TEXT);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});

test('PostgreSQL 16, default privileges on: SQL 157 leaves the default-privilege grants on its table, so it never reaches SQL 158\'s fingerprint', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql157-acl-', 59755, { extra: EXTRA });
  try {
    const owner = await fx.connectAs('checksops_admin');
    try {
      await owner.query(SQL157);
    } finally {
      await owner.end();
    }
    const grantees = (await fx.admin.query(`SELECT DISTINCT a.grantee::regrole::text AS g FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.oid = '${TABLE}'::regclass AND a.grantee <> c.relowner ORDER BY 1`)).rows.map((row) => row.g);
    assert.deepEqual(grantees, ['authenticated']);
    const connect = async () => fx.connectAs('checksops_admin');
    const result = await handlerFor(connect)(inspectEvent());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(result.details.receipt.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.equal(result.details.receipt.already_applied, false);
  } finally {
    await fx.close();
  }
});
