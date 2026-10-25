/**
 * SQL 115 (aws/workflows/sql/115_provider_stakeholder_one_partner_payout.sql) in the staging
 * guarded executor, on the release engine shared with SQL 90-114 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 115 included); this
 * file covers what is new:
 *
 *   - the pin: pending (no read-live yet), code-derived, selectable, packed, in step with the
 *     production pin; the pinned commit authored the bytes; no predecessor;
 *   - the spec's one function: public.sync_provider_stakeholder_account(uuid) replaced with the
 *     supabase signature and attributes, EXECUTE the owner's only, the four supabase-era lines
 *     revoked; another live EXECUTE line, a function not owned by the login or a definer that
 *     cannot write stakeholder_accounts refuses; the trigger function and the triggers are in
 *     the unrelated snapshot;
 *   - the file: the prerequisite block, the function, the REVOKE and the guarded role REVOKEs,
 *     nothing else; the body differs from the supabase one only by the one-payout guard;
 *   - on PostgreSQL 16 (the real supabase function and triggers): one apply through the
 *     executor reaches the intended fingerprint, then is refused as already in place.
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
  AUTHORIZED_SQL115_PROVIDER_STAKEHOLDER_ONE_PARTNER_PAYOUT,
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
import { assertStagingPinState } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { PROVIDER_STAKEHOLDER_SCHEMA, SUPABASE_SYNC_FILE, SYNC_FUNCTION } from './helpers/sql115-provider-stakeholder-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-25T12:00:00.000Z';
const KEY = 'sql115';
const REVOKED = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

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
    expiry: '2026-10-25T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql115-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 115 pending, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL115_PROVIDER_STAKEHOLDER_ONE_PARTNER_PAYOUT, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/115_provider_stakeholder_one_partner_payout.sql');
  assert.equal(pin.migration_id, '115_provider_stakeholder_one_partner_payout');
  assert.equal(spec.choice, 'sql115-provider-stakeholder-one-partner-payout');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending: no staging read-live yet, so no pre-state, no approval, execute false.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '8aed39a49d988a60bdedac07a3a97f424a9de5c1499e4f50738f749326a62452');
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql115-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [SYNC_FUNCTION]);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  // Nothing in the release refuses after SQL 115, supersedes it or needs it.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // No other release migration creates, replaces or sets the ACL of this function.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => key !== KEY && [...RELEASE_SQL_SPECS[key].functions, ...(RELEASE_SQL_SPECS[key].acl_functions || [])]
    .some((fn) => fn.identity === SYNC_FUNCTION)), []);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
  assert.equal(prod.expected_live_definition_sha256, null);
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

test('reviewed file and spec: the supabase function with the one-payout guard, EXECUTE owner only; another grant, another owner or a definer that cannot write refuses', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['sync_provider_stakeholder_account']);
  const def = defs.sync_provider_stakeholder_account;
  assert.deepEqual([def.language, def.volatility, def.security_definer, def.result, [...def.config]], ['plpgsql', 'v', true, 'uuid', ['search_path=public']]);
  // The body is the supabase one plus the payout lookup, the early return and the conditional re-activation.
  const supabase = fs.readFileSync(SUPABASE_SYNC_FILE, 'utf8');
  const start = supabase.indexOf('CREATE OR REPLACE FUNCTION public.sync_provider_stakeholder_account(_tenant_id uuid)');
  const original = releaseFunctionDefinitions(supabase.slice(start, supabase.indexOf('$function$;', start) + '$function$;'.length)).sync_provider_stakeholder_account;
  assert.equal(original.result, def.result);
  assert.deepEqual([...original.config], []);
  const added = [
    '  payout_id    uuid;\n',
    `  -- The tenant's active partner payout other than this account's own row (SQL 115): one per
  -- tenant (stakeholder_accounts_one_partner_payout), whichever environment holds it.
  SELECT id INTO payout_id
  FROM public.stakeholder_accounts
  WHERE tenant_id = _tenant_id
    AND is_partner_payout = true
    AND is_active = true
    AND id IS DISTINCT FROM existing_id
  LIMIT 1;

`,
    `    IF payout_id IS NOT NULL THEN
      RETURN payout_id;
    END IF;
`,
  ];
  let body = def.prosrc;
  for (const part of added) {
    assert.ok(body.includes(part), part);
    body = body.replace(part, '');
  }
  body = body.replace('is_active                = CASE WHEN payout_id IS NULL THEN true ELSE is_active END,', 'is_active                = true,');
  assert.equal(body, original.prosrc);
  const code = TEXT.replace(/--[^\n]*/g, '');
  const statements = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').split(';').map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(statements.map((s) => s.replace(/\s+/g, ' ')), [
    'DO $body$',
    'CREATE OR REPLACE FUNCTION public.sync_provider_stakeholder_account(_tenant_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $body$',
    'REVOKE ALL ON FUNCTION public.sync_provider_stakeholder_account(uuid) FROM PUBLIC',
    'DO $body$',
  ]);
  assert.match(code, /ARRAY\['anon', 'authenticated', 'service_role'\]/);
  assert.deepEqual([...code.matchAll(/'(REVOKE[^']*)'/g)].map((m) => m[1]), ['REVOKE ALL ON FUNCTION public.sync_provider_stakeholder_account(uuid) FROM %I']);
  for (const forbidden of [/\bGRANT\b/i, /ROW LEVEL SECURITY/i, /\bPOLICY\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /\bDELETE\b/, /\bTRIGGER\b/]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.match(TEXT, /Not applied by this change\./);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, [...fn.acl], [...fn.revokes]]), [[SYNC_FUNCTION, ['owner EXECUTE'], [...REVOKED]]]);
  assert.deepEqual(spec.definer_writes, ['public.stakeholder_accounts']);
  assert.equal(spec.column_acl, undefined);
  assert.equal(spec.altered_relations, undefined);
  assert.equal(spec.render, undefined);
  assert.ok(spec.prerequisites.includes(SYNC_FUNCTION));
  const intended = releaseIntendedState(KEY, TEXT);
  assert.equal(releaseStateText(KEY, intended), `release sql115 v1\nfunction ${SYNC_FUNCTION}: lang=plpgsql vol=v parallel=u secdef=true result=uuid config=search_path=public prosrc=${sha(def.prosrc)} acl=owner EXECUTE`);
  // Unrelated snapshot: only the function is skipped; the trigger function and triggers stay in it.
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [SYNC_FUNCTION]);
  for (const field of ['skip_relations', 'skip_constraints', 'skip_policies', 'skip_triggers', 'skip_views', 'skip_indexes', 'skip_columns', 'skip_not_null_columns', 'acl_relations']) {
    assert.deepEqual(scope[field], [], field);
  }
  // Pre-conditions: the supabase-era lines pass; another grantee refuses; owner and definer checks.
  const live = (acl, over = {}) => ({ exists: true, owner_is_login: true, result: 'uuid', acl, ...over });
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], definer: { 'public.stakeholder_accounts': true } };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  for (const acl of [[], ['owner EXECUTE'], ['PUBLIC EXECUTE', 'owner EXECUTE'], [...REVOKED, 'owner EXECUTE']]) {
    assert.deepEqual(pre({ functions: { [SYNC_FUNCTION]: live(acl) } }), [], JSON.stringify(acl));
  }
  assert.deepEqual(pre({ functions: { [SYNC_FUNCTION]: live(['checksops EXECUTE', 'owner EXECUTE']) } }), ['function_acl_replaceable']);
  assert.deepEqual(pre({ functions: { [SYNC_FUNCTION]: live(['owner EXECUTE'], { owner_is_login: false }) } }), ['functions_owned_by_login']);
  assert.deepEqual(pre({ functions: { [SYNC_FUNCTION]: live(['owner EXECUTE'], { result: 'void' }) } }), ['function_results_match']);
  assert.deepEqual(pre({ functions: { [SYNC_FUNCTION]: live(['owner EXECUTE']) }, definer: { 'public.stakeholder_accounts': false } }), ['definer_can_write_relations']);
  assert.deepEqual(pre({ functions: { [SYNC_FUNCTION]: live([]) }, prerequisites_missing: [SYNC_FUNCTION] }), ['prerequisites_present']);
  // Post-conditions: the intended fingerprint (the rest is the unrelated snapshot's).
  const pin = PINS[KEY];
  const owned = { functions: { [SYNC_FUNCTION]: live(['owner EXECUTE']) } };
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, { ...owned, live_definition_sha256: pin.intended_replacement_sha256 }, pin), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, { ...owned, live_definition_sha256: 'f'.repeat(64) }, pin), ['intended_state']);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, { functions: { [SYNC_FUNCTION]: live(['owner EXECUTE'], { owner_is_login: false }) },
    live_definition_sha256: pin.intended_replacement_sha256 }, pin), ['functions_owned_by_login']);
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [PROVIDER_STAKEHOLDER_SCHEMA] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: SQL 115 through the executor: drift refused, one apply on the intended fingerprint, then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql115-exec-', 59215, async ({ admin, connectAs }) => {
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
  const acl = async () => (await admin.query(`SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type AS line
    FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure ORDER BY 1`, [SYNC_FUNCTION])).rows.map((row) => row.line);

  const r = await inspect();
  assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
  assert.deepEqual(r.release_sql_inspect.predecessors, {});
  assert.equal(r.already_applied, false);
  // A pending pin cannot apply.
  const pending = await handlerFor(connect)(releaseEvent({ expected_live_definition_sha256: r.live_definition_sha256 }));
  assert.equal(pending.ok, false);
  // Drift between the recorded pre-state and the apply refuses.
  const before = await acl();
  await admin.query(`REVOKE ALL ON FUNCTION ${SYNC_FUNCTION} FROM anon`);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
  await admin.query(`GRANT EXECUTE ON FUNCTION ${SYNC_FUNCTION} TO anon`);
  assert.deepEqual(await acl(), before);

  const applied = await apply(r.live_definition_sha256);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
  const after = await inspect();
  assert.equal(after.already_applied, true);
  assert.deepEqual(after.precondition_failures, []);
  assert.deepEqual(await acl(), ['checksops_admin EXECUTE']);
  assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
}));
