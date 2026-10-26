/**
 * SQL 116 (aws/workflows/sql/116_moov_onboarding_profile_industry.sql) on PostgreSQL 16, through
 * its production tool, the owner the non-superuser checksops_admin login, after SQL 91's real file:
 *
 *   - one apply reaches the intended fingerprint (moov_onboarding_profiles.industry, text,
 *     nullable, no default, no column grant); an existing profile row is unchanged and reads
 *     industry NULL; every other column of the table, its ACL, policies and triggers stay as
 *     they were; the API role can write the column through SQL 91's table grant; the file run
 *     again is a no-op and the tool refuses a re-apply as already in place;
 *   - SQL 91 still counts as applied (by SQL 116's fingerprint) for SQL 105's production tool;
 *   - an industry column of another shape refuses the pre-conditions
 *     (added_columns_absent_or_intended, and predecessors_applied: SQL 91's table is no longer as
 *     SQL 91 left it); nothing is applied.
 *
 * Run: node --test aws/tests/sql116-moov-onboarding-profile-industry-pg.test.mjs (as root the
 * PG helpers run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  executeReleaseProductionApply,
  inspectReleaseProduction,
  loadReleaseProductionPin,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql116', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SQL91_TEXT = fs.readFileSync(path.join(ROOT, loadReleaseProductionPin('sql91', ROOT).filename), 'utf8');
const TABLE = 'public.moov_onboarding_profiles';

const authorized = (live) => Object.freeze({
  ...PIN,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
function manifest(pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = 'prod-sql116-pg-test';
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: 'a'.repeat(40),
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: live,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `sql116-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-26T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql116-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

/** The fixture with SQL 91's real file applied as checksops_admin (the table's owner). */
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
  const fx = await releaseFixture(pg, prefix, port);
  try {
    const owner = await fx.connectAs('checksops_admin');
    try {
      await owner.query(SQL91_TEXT);
    } finally {
      await owner.end();
    }
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** Every column of the table (name, type, not null, has a default, column ACL). */
const columns = async (admin) => (await admin.query(`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
    a.attnotnull AS notnull, a.atthasdef AS hasdef, COALESCE(a.attacl::text, '') AS acl
  FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [TABLE])).rows;
/** The table's ACL, RLS flags, policies and triggers. */
const tableSide = async (admin) => ({
  rel: (await admin.query(`SELECT COALESCE(c.relacl::text, '') || ' ' || c.relrowsecurity || ' ' || c.relforcerowsecurity AS d
    FROM pg_catalog.pg_class c WHERE c.oid = $1::regclass`, [TABLE])).rows[0].d,
  policies: (await admin.query(`SELECT policyname || ' ' || cmd || ' ' || COALESCE(qual, '') || ' ' || COALESCE(with_check, '') AS d
    FROM pg_catalog.pg_policies WHERE schemaname = 'public' AND tablename = 'moov_onboarding_profiles' ORDER BY 1`)).rows.map((r) => r.d),
  triggers: (await admin.query(`SELECT t.tgname || ' ' || pg_catalog.pg_get_triggerdef(t.oid) AS d FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal ORDER BY 1`, [TABLE])).rows.map((r) => r.d),
});

test('PostgreSQL 16: SQL 116 through its production tool: one nullable text column, existing rows unchanged, SQL 91 still applied, nothing else changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql116-prod-', 59716, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query(`INSERT INTO ${TABLE} (tenant_id, environment, legal_name) VALUES ($1, 'sandbox', 'Freedom Test LLC')`, [TENANT_A]);
  const before = await columns(admin);
  const side = await tableSide(admin);
  assert.equal(before.some((c) => c.name === 'industry'), false);

  const s = (await inspectReleaseProduction('sql116', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, { sql91: true });
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql116', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);

  // Exactly one column added; everything else on the table as it was; the row reads NULL.
  const now = await columns(admin);
  assert.deepEqual(now.filter((c) => c.name !== 'industry'), before);
  assert.deepEqual(now.filter((c) => c.name === 'industry'), [{ name: 'industry', type: 'text', notnull: false, hasdef: false, acl: '' }]);
  assert.deepEqual(await tableSide(admin), side);
  assert.deepEqual((await admin.query(`SELECT legal_name, industry FROM ${TABLE} WHERE tenant_id = $1`, [TENANT_A])).rows,
    [{ legal_name: 'Freedom Test LLC', industry: null }]);
  // SQL 91's table grant covers the new column for the API role.
  assert.deepEqual((await admin.query(`SELECT pg_catalog.has_column_privilege('checksops', $1::regclass, 'industry', 'UPDATE') AS u,
    pg_catalog.has_column_privilege('checksops', $1::regclass, 'industry', 'SELECT') AS s`, [TABLE])).rows, [{ u: true, s: true }]);

  // SQL 91 still counts as applied (by SQL 116's fingerprint) for SQL 105.
  const sql105 = (await inspectReleaseProduction('sql105', { connect, pin: loadReleaseProductionPin('sql105', ROOT), root: ROOT })).details;
  assert.deepEqual(sql105.predecessors, { sql91: true });

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await columns(admin), now);
  const again = (await inspectReleaseProduction('sql116', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.deepEqual(again.predecessors, { sql91: true });
  const replay = await executeReleaseProductionApply('sql116', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: an industry column of another shape refuses the pre-conditions; nothing is applied', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql116-shape-', 59816, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query(`ALTER TABLE ${TABLE} ADD COLUMN industry character varying(64) DEFAULT 'none'`);
  const before = await columns(admin);
  const refused = (await inspectReleaseProduction('sql116', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(refused.already_applied, false);
  // The column is not SQL 116's, and SQL 91's table is no longer as SQL 91 left it (SQL 116 is not in place to stand for it).
  assert.deepEqual(refused.precondition_failures, ['predecessors_applied', 'added_columns_absent_or_intended'], JSON.stringify(refused.release_sql_inspect));
  const blocked = authorized(refused.live_definition_sha256);
  const noApply = await executeReleaseProductionApply('sql116', manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  assert.deepEqual(await columns(admin), before);
}));
