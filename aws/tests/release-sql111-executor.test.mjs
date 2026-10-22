/**
 * SQL 111 (aws/workflows/sql/111_tenant_referral_codes.sql) in the staging guarded executor, on
 * the release engine shared with SQL 90-110 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 111 included); this
 * file covers what is new:
 *
 *   - the pin: pending (no read-live yet), code-derived, selectable, packed, in step with the
 *     production pin; the pinned commit authored the bytes; no predecessor;
 *   - the file and spec: one guarded prerequisite block and five SECURITY DEFINER functions,
 *     EXECUTE checksops only (the active-count helper the owner only); only
 *     aws_apply_referral_code writes, one INSERT into referral_events (definer_writes); no
 *     table, policy or grant DDL on a table; the definer-write pre-condition refuses a login that
 *     cannot write referral_events or tenants;
 *   - on PostgreSQL 16: a pending pin cannot apply; one apply through the executor reaches the
 *     intended fingerprint, then is refused as already in place.
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
  AUTHORIZED_SQL111_TENANT_REFERRAL_CODES,
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
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseStateText,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { REFERRAL_SCHEMA } from './helpers/sql111-referral-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-22T12:00:00.000Z';
const KEY = 'sql111';
const FUNCTIONS = Object.freeze([
  'public.aws_tenant_referral_active_count(uuid)',
  'public.aws_tenant_referral_credit_cents(uuid)',
  'public.aws_apply_referral_code(uuid, text)',
  'public.aws_tenant_referral_summary(uuid)',
  'public.aws_platform_owner_referral_overview()',
]);
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
    expiry: '2026-10-22T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql111-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 111 pending, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL111_TENANT_REFERRAL_CODES, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/111_tenant_referral_codes.sql');
  assert.equal(pin.migration_id, '111_tenant_referral_codes');
  assert.equal(spec.choice, 'sql111-tenant-referral-codes');
  assert.equal(sha(TEXT), pin.source_sha256);
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, false);
  assert.equal(pin.authorization, 'pending');
  assert.equal(pin.expected_live_definition_sha256, null);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql111-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FUNCTIONS);
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  assert.equal(prod.execute, false);
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

test('reviewed file and spec: one guarded block, five SECURITY DEFINER functions, EXECUTE checksops only, one referral_events INSERT; no table, policy or table grant DDL', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), [
    'aws_tenant_referral_active_count',
    'aws_tenant_referral_credit_cents',
    'aws_apply_referral_code',
    'aws_tenant_referral_summary',
    'aws_platform_owner_referral_overview',
  ]);
  const expected = {
    aws_tenant_referral_active_count: { language: 'sql', volatility: 's', result: 'integer' },
    aws_tenant_referral_credit_cents: { language: 'plpgsql', volatility: 's', result: 'integer' },
    aws_apply_referral_code: { language: 'plpgsql', volatility: 'v', result: 'jsonb' },
    aws_tenant_referral_summary: { language: 'plpgsql', volatility: 's', result: 'jsonb' },
    aws_platform_owner_referral_overview: { language: 'plpgsql', volatility: 's', result: 'jsonb' },
  };
  const writes = [];
  for (const [name, want] of Object.entries(expected)) {
    const fn = defs[name];
    assert.equal(fn.security_definer, true, name);
    assert.deepEqual({ language: fn.language, volatility: fn.volatility, result: fn.result }, want, name);
    assert.deepEqual(fn.config, ['search_path=public'], name);
    for (const m of fn.prosrc.matchAll(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)) writes.push(`${name}: ${m[1]} ${m[2]}`);
  }
  // Only the redeem writes, and only one referral_events row; no tenants row changes.
  assert.deepEqual(writes, ['aws_apply_referral_code: INSERT INTO public.referral_events']);
  const redeem = defs.aws_apply_referral_code.prosrc;
  assert.match(redeem, /FROM public\.tenants WHERE id = _tenant_id FOR UPDATE;/);
  // Any member of the tenant may redeem; the role is not checked (as everywhere since SQL 90).
  assert.match(redeem, /WHERE tu\.tenant_id = _tenant_id AND tu\.user_id = v_uid\) THEN/);
  assert.doesNotMatch(redeem, /tu\.role/);
  // The discount is the referral credit plus the hand-set discount, at most the monthly rate.
  assert.match(defs.aws_tenant_referral_summary.prosrc, /'applied_discount_cents', least\(v_earned \+ v_manual, v_rate\)/);
  assert.doesNotMatch(defs.aws_platform_owner_referral_overview.prosrc, /founding/i);
  assert.match(redeem, /v_ref_id, _tenant_id, v_uid, v_code, 500, 'active'/);
  assert.match(defs.aws_tenant_referral_credit_cents.prosrc, /least\(2500, 500 \* public\.aws_tenant_referral_active_count\(_tenant_id\)\)/);
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').replace(/'(?:[^']|'')*'/g, "''");
  const statements = outside.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // The DO block, then per function CREATE, REVOKE, (GRANT), COMMENT; the helper has no GRANT.
  assert.equal(statements.length, 1 + 3 + 4 * 4);
  assert.equal(statements[0], 'DO $body$');
  const grants = statements.filter((s) => /^GRANT\b/.test(s));
  assert.deepEqual(grants, FUNCTIONS.slice(1).map((identity) => `GRANT EXECUTE ON FUNCTION ${identity} TO checksops`));
  assert.deepEqual(statements.filter((s) => /^REVOKE\b/.test(s)), FUNCTIONS.map((identity) => `REVOKE ALL ON FUNCTION ${identity} FROM PUBLIC`));
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|TRIGGER|INDEX|VIEW)\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /ROW LEVEL SECURITY/i, /\bTO\s+authenticated\b/i, /\banon\b/, /\bTO\s+PUBLIC\b/i, /\bON TABLE\b/i]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  assert.match(TEXT, /NOT APPLIED\./);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [
    { identity: FUNCTIONS[0], acl: ['owner EXECUTE'] },
    ...FUNCTIONS.slice(1).map((identity) => ({ identity, acl: ['checksops EXECUTE', 'owner EXECUTE'] })),
  ]);
  assert.equal(spec.table_privileges, undefined);
  assert.equal(spec.altered_relations, undefined);
  assert.deepEqual(spec.definer_writes, ['public.referral_events', 'public.tenants']);
  assert.equal(spec.policies, undefined);
  assert.equal(spec.tables, undefined);
  const intended = releaseIntendedState(KEY, TEXT);
  const lines = releaseStateText(KEY, intended).split('\n');
  assert.equal(lines[0], 'release sql111 v1');
  assert.equal(lines.length, 6);
  assert.match(lines[1], /^function public\.aws_tenant_referral_active_count\(uuid\): lang=sql vol=s parallel=u secdef=true result=integer config=search_path=public prosrc=[0-9a-f]{64} acl=owner EXECUTE$/);
  assert.match(lines[3], /^function public\.aws_apply_referral_code\(uuid, text\): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE$/);
  // The definer-write pre-condition: a login that cannot write a table refuses.
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    definer: Object.fromEntries(spec.definer_writes.map((table) => [table, true])),
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.ok(!pre().includes('definer_can_write_relations'));
  assert.ok(pre({ definer: { ...base.definer, 'public.referral_events': false } }).includes('definer_can_write_relations'));
  assert.ok(pre({ definer: { ...base.definer, 'public.tenants': false } }).includes('definer_can_write_relations'));
});

test('PostgreSQL 16: SQL 111 through the executor: a pending pin cannot apply, one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql111-exec-', 61140, { extra: [REFERRAL_SCHEMA] });
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

    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.equal(r.already_applied, false);
    const pending = await handlerFor(connect)(releaseEvent({ expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
