/**
 * SQL 137 (aws/workflows/sql/137_platform_owner_identity.sql) in the staging guarded executor, on the
 * release engine shared with SQL 90-135 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 137 included); this file
 * covers what is new:
 *
 *   - the pin: pending (no read-live yet), code-derived, selectable, packed, in step with the pending
 *     production pin; the pinned commit authored the bytes; no predecessor;
 *   - the spec: one replaced function (public.is_platform_owner(), EXECUTE for authenticated, checksops
 *     and the owner; PUBLIC, anon and service_role revoked) and one table_privileges entry
 *     (identity_accounts: UPDATE / DELETE / TRUNCATE of PUBLIC, anon, authenticated and checksops,
 *     intended none, as SQL 106); the expected pre-states (aws/rls/sql/10's body with
 *     aws/identity/sql/03's or 07's grants) are derived here; the pre-conditions accept the revoked
 *     EXECUTE lines and refuse any other; the post-conditions keep every other table grant;
 *   - the file: the fail-closed precondition block (reads, never writes), the identity-only body (the
 *     same attributes as aws/rls/sql/10, profiles not read), the EXECUTE and table revokes, nothing
 *     else;
 *   - on PostgreSQL 16 (staging's grants): the read-live reads the derived pre-state; a pending pin
 *     cannot apply; drift refuses; one apply through the executor reaches the intended fingerprint and
 *     leaves every other grant as it was, then is refused as already in place.
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
  AUTHORIZED_SQL137_PLATFORM_OWNER_IDENTITY,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPostconditionFailures,
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
import { FUNCTION, OWNER_MAILBOX, SQL10_FILE, TABLE, identitySchema } from './helpers/sql137-identity-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-31T12:00:00.000Z';
const KEY = 'sql137';
const KEPT = Object.freeze(['authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']);
const REVOKED = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'service_role EXECUTE']);
const ROLES = Object.freeze(['PUBLIC', 'anon', 'authenticated', 'checksops']);
const PRIVILEGES = Object.freeze(['UPDATE', 'DELETE', 'TRUNCATE']);
/** Expected pre-states, derived below and read back on PostgreSQL 16. */
const PRE_PRODUCTION = '9862a392054d3adb7069949dac490f6423be86632abf0ac9d9d6c99d81ffdada';
const PRE_STAGING = '7349393da7ae7f94cd63f6796c76c5df2686f5274b84d7f6ad4a6ea405021f37';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL10 = fs.readFileSync(SQL10_FILE, 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** aws/rls/sql/10's is_platform_owner() as the engine reads a live function, with `acl`. */
function sql10Function(acl) {
  const def = releaseFunctionDefinitions(SQL10).is_platform_owner;
  return {
    exists: true,
    language: def.language,
    volatility: def.volatility,
    parallel: def.parallel,
    security_definer: def.security_definer,
    result: def.result,
    config: [...def.config],
    prosrc_sha256: sha(def.prosrc),
    acl: [...acl].sort(),
  };
}
const SQL10_ACL = Object.freeze(['PUBLIC EXECUTE', ...KEPT]);
const liveState = (fn, lines) => ({ functions: { [FUNCTION]: fn }, privileges: { [TABLE]: { exists: true, lines } } });

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
    expiry: '2026-10-31T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql137-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 137 pending, code-derived, selectable, packed, in step with the pending production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL137_PLATFORM_OWNER_IDENTITY, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/137_platform_owner_identity.sql');
  assert.equal(pin.migration_id, '137_platform_owner_identity');
  assert.equal(spec.choice, 'sql137-platform-owner-identity');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live recorded yet.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '9a88fca29d21f5537052f475f4133f05e89e002bdf00b22cfc3cf2cf78c6d8da');
  for (const pre of [PRE_PRODUCTION, PRE_STAGING]) assert.notEqual(pre, pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql137-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [FUNCTION]);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // SQL 136 is not this branch's; nothing in the release refuses after SQL 137, supersedes it or needs it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration replaces is_platform_owner() (SQL 126 only reads it).
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => key !== KEY && RELEASE_SQL_SPECS[key].functions.some((fn) => fn.identity === FUNCTION)), []);
  // SQL 106 (the same kind of table revoke) is unchanged.
  assert.equal(PINS.sql106.intended_replacement_sha256, releaseIntendedHash('sql106', fs.readFileSync(path.join(ROOT, PINS.sql106.filename), 'utf8')));
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [...pin.function_identities]);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.authorization, 'pending');
  assert.equal(prod.expected_live_definition_sha256, null);
  assert.equal(prod.production_inspect.status, 'pending');
  assert.ok(prod.production_inspect.note.includes(PRE_PRODUCTION));
  assert.ok(prod.production_inspect.note.includes(PRE_STAGING));
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

test('reviewed file and spec: preconditions, the identity-only body with aws/rls/sql/10\'s attributes, the EXECUTE and table revokes; the derived pre-states; revoked lines pass, another EXECUTE grant refuses', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['is_platform_owner']);
  const before = releaseFunctionDefinitions(SQL10).is_platform_owner;
  const after = defs.is_platform_owner;
  // Same attributes as aws/rls/sql/10; only the body changes, and it no longer reads profiles.
  for (const k of ['language', 'volatility', 'parallel', 'security_definer', 'result']) assert.deepEqual(after[k], before[k], k);
  assert.deepEqual([...after.config].sort(), [...before.config].sort());
  assert.deepEqual([...after.config].sort(), ['row_security=off', 'search_path=public']);
  assert.match(before.prosrc, /FROM public\.profiles p/);
  assert.doesNotMatch(after.prosrc, /profiles/);
  // The new body is the old identity branch, unchanged.
  const identityBranch = /SELECT EXISTS \(\s*SELECT 1\s*FROM public\.identity_accounts ia[\s\S]*?lower\(ia\.email\) = 'checksopsadmin@gmail\.com'\s*\)/.exec(before.prosrc)[0];
  assert.equal(after.prosrc.trim(), `${identityBranch};`);
  assert.ok(after.prosrc.includes(`'${OWNER_MAILBOX}'`));
  assert.match(after.prosrc, /ia\.application_user_id = auth\.uid\(\)/);
  assert.match(after.prosrc, /ia\.status IN \('active', 'isolated_test'\)/);

  const code = TEXT.replace(/--[^\n]*/g, '');
  const blockEnd = code.indexOf('$sql137_preconditions$;') + '$sql137_preconditions$;'.length;
  assert.ok(code.trimStart().startsWith('DO $sql137_preconditions$'));
  const block = code.slice(0, blockEnd);
  for (const raise of ['sql137_table_missing', 'sql137_column_missing', 'sql137_function_missing', 'sql137_role_missing',
    'sql137_owner_email_not_unique', 'sql137_owner_identity_count', 'sql137_owner_profile_without_identity']) {
    assert.match(block, new RegExp(`RAISE EXCEPTION '${raise}:`), raise);
  }
  // The block only reads.
  assert.doesNotMatch(block, /\b(GRANT|REVOKE|ALTER|CREATE|DROP|INSERT INTO|UPDATE public|DELETE FROM|TRUNCATE|EXECUTE)\b/);
  // Top-level statements: semicolons inside dollar-quoted bodies and string literals are not statement ends.
  const statements = code.slice(blockEnd).replace(/\$([a-z0-9_]*)\$[\s\S]*?\$\1\$|'[^']*'/g, (body) => body.replace(/;/g, '\u0000'))
    .split(';').map((s) => s.replace(/\u0000/g, ';').replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.equal(statements.length, 8, JSON.stringify(statements));
  assert.match(statements[0], /^CREATE OR REPLACE FUNCTION public\.is_platform_owner\(\) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS \$\$/);
  assert.match(statements[1], /^COMMENT ON FUNCTION public\.is_platform_owner\(\) IS /);
  assert.equal(statements[2], 'REVOKE ALL ON FUNCTION public.is_platform_owner() FROM PUBLIC');
  assert.match(statements[3], /^DO \$sql137_function_acl\$ .*ARRAY\['anon', 'service_role'\].*REVOKE ALL ON FUNCTION public\.is_platform_owner\(\) FROM %I.*\$sql137_function_acl\$$/);
  assert.equal(statements[4], 'GRANT EXECUTE ON FUNCTION public.is_platform_owner() TO checksops, authenticated');
  assert.equal(statements[5], `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${TABLE} FROM PUBLIC`);
  assert.equal(statements[6], `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE ${TABLE} FROM checksops, authenticated`);
  assert.match(statements[7], /^DO \$sql137_table_acl\$ .*REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public\.identity_accounts FROM anon.*\$sql137_table_acl\$$/);
  const rest = code.slice(blockEnd);
  for (const forbidden of [/ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bINSERT\b/, /\bSEQUENCE\b/i, /\bis_master_owner\b/, /ON TABLE public\.profiles/, /GRANT [^;]* ON TABLE/i]) {
    assert.doesNotMatch(rest, forbidden, String(forbidden));
  }
  assert.match(TEXT, /Not applied by this change/);
  assert.match(TEXT, /security audit 2026-10-29, finding 15/);
  assert.match(TEXT, /10_owner_helpers_from_identity\.sql/);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, [...fn.acl], [...fn.revokes], fn.result]), [[FUNCTION, [...KEPT], [...REVOKED], undefined]]);
  assert.deepEqual(spec.table_privileges.map((p) => [p.table, [...p.grantees], [...p.privileges], [...p.intended]]), [[TABLE, [...ROLES], [...PRIVILEGES], []]]);
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.deepEqual(spec.prerequisites, [
    TABLE, 'public.profiles', 'public.identity_accounts_email_lower_key', FUNCTION, 'auth.uid()',
    `column ${TABLE}.application_user_id`, `column ${TABLE}.email`, `column ${TABLE}.status`,
    'column public.profiles.id', 'column public.profiles.email', 'role checksops', 'role authenticated',
  ]);
  for (const absent of ['render', 'whole_tables', 'column_acl', 'acl_functions', 'definer_writes']) assert.equal(spec[absent], undefined, absent);
  const intended = releaseIntendedState(KEY, TEXT);
  assert.deepEqual(intended.privileges, { [TABLE]: { exists: true, lines: [] } });
  assert.deepEqual(intended.functions[FUNCTION].acl, [...KEPT]);
  assert.equal(releaseStateText(KEY, intended), [
    'release sql137 v1',
    `function ${FUNCTION}: lang=sql vol=s parallel=u secdef=true result=boolean config=row_security=off;search_path=public prosrc=${sha(after.prosrc)} acl=${KEPT.join(';')}`,
    `privileges ${TABLE} UPDATE,DELETE,TRUNCATE: `,
  ].join('\n'));
  // The expected pre-states: aws/rls/sql/10 with aws/rls/sql/15's grants; aws/identity/sql/03 (none) or 07 (checksops UPDATE).
  assert.equal(releaseStateHash(KEY, liveState(sql10Function(SQL10_ACL), [])), PRE_PRODUCTION);
  assert.equal(releaseStateHash(KEY, liveState(sql10Function(SQL10_ACL), ['checksops UPDATE'])), PRE_STAGING);
  // The intended state is reached from the function body and ACL plus no revoked line, nothing else.
  const intendedFn = { ...intended.functions[FUNCTION] };
  assert.equal(releaseStateHash(KEY, liveState(intendedFn, [])), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, liveState({ ...intendedFn, acl: [...SQL10_ACL] }, [])), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, liveState(intendedFn, ['anon UPDATE'])), PINS[KEY].intended_replacement_sha256);
  assert.notEqual(releaseStateHash(KEY, liveState(sql10Function(KEPT), [])), PINS[KEY].intended_replacement_sha256);
  // Unrelated snapshot: the function is skipped, the table's ACL is read for its other grants.
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [FUNCTION]);
  assert.deepEqual(scope.acl_relations, [TABLE]);
  for (const field of ['skip_relations', 'skip_columns', 'skip_constraints', 'skip_policies', 'skip_triggers', 'skip_views', 'skip_indexes', 'skip_not_null_columns']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions.
  const owned = { [TABLE]: { exists: true, owner_is_login: true } };
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], altered: owned };
  const fnWith = (acl, extra = {}) => ({ functions: { [FUNCTION]: { ...sql10Function(acl), owner_is_login: true, ...extra } } });
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...fnWith(SQL10_ACL), ...over }, TEXT);
  for (const acl of [SQL10_ACL, KEPT, [...KEPT, ...REVOKED], ['owner EXECUTE'], []]) assert.deepEqual(pre(fnWith(acl)), [], JSON.stringify(acl));
  assert.deepEqual(pre(fnWith([...SQL10_ACL, 'reporting EXECUTE'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fnWith([...SQL10_ACL, 'checksops EXECUTE with grant option'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fnWith(SQL10_ACL, { owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fnWith(SQL10_ACL, { result: 'text' })), ['function_results_match']);
  assert.deepEqual(pre({ altered: { [TABLE]: { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
  assert.deepEqual(pre({ prerequisites_missing: ['public.identity_accounts_email_lower_key'] }), ['prerequisites_present']);
  // Post-conditions: the intended fingerprint and every other identity_accounts grant unchanged.
  const pin = PINS[KEY];
  const other = (lines) => ({ privileges: { [TABLE]: { exists: true, lines: [], other: lines } } });
  const kept = ['authenticated SELECT', 'checksops INSERT', 'checksops SELECT'];
  const ok = { live_definition_sha256: pin.intended_replacement_sha256, functions: { [FUNCTION]: { owner_is_login: true } }, ...other(kept) };
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, other(kept), ok, pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, other(kept), { ...ok, ...other(['authenticated SELECT', 'checksops SELECT']) }, pin), ['other_table_privileges_unchanged']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, other(kept), { ...ok, live_definition_sha256: 'f'.repeat(64) }, pin), ['intended_state']);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [identitySchema('staging')] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 137 through the executor: the derived staging pre-state, a pending pin cannot apply, drift refused, one apply on the intended fingerprint keeps every other grant, then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql137-exec-', 60535, async ({ admin, connectAs }) => {
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
  const acls = async () => ({
    function: (await admin.query(`SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = p.proowner THEN 'owner' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type AS line
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure ORDER BY 1`, [FUNCTION])).rows.map((r) => r.line),
    table: (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [TABLE])).rows.map((r) => r.line),
    profiles: (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
      FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
      WHERE c.oid = 'public.profiles'::regclass AND a.grantee <> c.relowner ORDER BY 1`)).rows.map((r) => r.line),
  });

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, {});
  assert.equal(r.already_applied, false);
  assert.equal(r.live_definition_sha256, PRE_STAGING);
  const before = await acls();
  assert.deepEqual(before.function, [...SQL10_ACL]);
  assert.deepEqual(before.table, ['authenticated SELECT', 'checksops INSERT', 'checksops SELECT', 'checksops UPDATE']);
  // A pending pin cannot apply (the committed pin is pending; pend a copy anyway).
  const pendingCopy = pendingPin(PINS[KEY]);
  const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  await admin.query(`GRANT DELETE ON TABLE ${TABLE} TO checksops`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`REVOKE DELETE ON TABLE ${TABLE} FROM checksops`);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  const now = await acls();
  assert.deepEqual(now.function, [...KEPT]);
  assert.deepEqual(now.table, ['authenticated SELECT', 'checksops INSERT', 'checksops SELECT']);
  assert.deepEqual(now.profiles, before.profiles);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
