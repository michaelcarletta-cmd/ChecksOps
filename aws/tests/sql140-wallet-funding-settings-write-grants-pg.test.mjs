/**
 * SQL 140 (aws/workflows/sql/140_wallet_funding_settings_write_grants.sql) on PostgreSQL 16, through its
 * production tool, the owner the non-superuser checksops_admin login, with the save the WalletOps automatic
 * funding route runs as checksops (saveTenantWalletFundingSettings, aws/functions/api/tenant-settings-handlers.mjs,
 * POST /functions/v1/save-tenant-wallet-funding-settings):
 *
 *   - the restore's grants (table SELECT only): the save is refused at the grant layer ("permission denied for
 *     table tenant_wallet_funding_settings", the staging log of 2026-11-02); one apply reaches the intended
 *     fingerprint, the thirteen columns carry exactly checksops INSERT and UPDATE as pinned, the table ACL and
 *     every other column are unchanged; then the first save inserts the tenant's row with the server-stamped
 *     acceptance, a second save updates it (updated_at moves), the policies decide (another tenant's member is
 *     refused by row-level security), a column outside the grant is still refused; the file run again is a
 *     no-op and the tool refuses a re-apply as already in place;
 *   - table-level writes held by checksops (a restore that kept them): the save already passes; the apply adds
 *     the column lines and keeps the table ACL;
 *   - another role's grant on one of the columns refuses the pre-conditions (column_acl_replaceable);
 *   - a missing column fails the file closed (sql140_column_missing) with nothing changed.
 *
 * SQL 136's money-write gate is not in this fixture (aws/tests/sql136-money-write-restrictive-pg.test.mjs); the
 * save sets request.money_write all the same.
 * Run: node --test aws/tests/sql140-wallet-funding-settings-write-grants-pg.test.mjs (as root the PG helpers
 * run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
import { saveTenantWalletFundingSettings } from '../functions/api/tenant-settings-handlers.mjs';
import { SET_MONEY_WRITE_SQL } from '../functions/api/money-write-flag.mjs';
import { MEMBER_A, MEMBER_B, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { COLUMNS, TABLE, pinned, walletFundingSchema } from './helpers/sql140-wallet-funding-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql140', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
/** Expected pre-state (also derived without a database by release-sql140-executor.test.mjs). */
const PRE_NONE = 'fa08a3db73806391d757885c9165d0f1bf56a4571a22b1a32e2e63c73578952d';
const BANK = '77777777-7777-4777-8777-777777777777';

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
  const workstream = 'prod-sql140-pg-test';
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
    one_use_id: `sql140-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-02T13:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql140-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

async function withPg(t, prefix, port, mode, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [walletFundingSchema(mode)] });
  try {
    await fx.admin.query(`INSERT INTO public.payment_provider_methods (id, tenant_id, environment, last_four, provider, connection_status)
      VALUES ($1::uuid, $2::uuid, 'sandbox', '6789', 'moov', 'connected')`, [BANK, TENANT_B]);
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** The table's ACL (owner excluded) and every column's ACL. */
const acls = async (admin) => ({
  table: (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [TABLE])).rows.map((r) => r.line),
  columns: Object.fromEntries((await admin.query(`SELECT a.attname AS name,
    ARRAY(SELECT pg_catalog.pg_get_userbyid(x.grantee) || ' ' || x.privilege_type FROM pg_catalog.aclexplode(a.attacl) x ORDER BY 1)::text[] AS acl
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [TABLE])).rows.map((r) => [r.name, r.acl])),
});

/**
 * The route's save as the API login (checksops, a member of authenticated) for `user`, in one transaction
 * with request.app_user_id set as withIdentity sets it; returns the handler's result, or { error } when the
 * database refused the statement. The handler sets request.money_write itself.
 */
async function saveAs(connectAs, user, body) {
  const c = await connectAs('checksops');
  const seen = [];
  const query = c.query.bind(c);
  c.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    const result = await saveTenantWalletFundingSettings(c, { tenantId: TENANT_B, userId: user, body });
    await c.query(result.ok ? 'COMMIT' : 'ROLLBACK');
    return { ...result, seen };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    return { error, seen };
  } finally {
    await c.end();
  }
}
const FULL = Object.freeze({
  funding_bank_account_id: BANK,
  funding_strategy: 'target_balance',
  target_wallet_balance_cents: 250000,
  maximum_single_pull_cents: 2500000,
  maximum_daily_pull_cents: 5000000,
  auto_funding_enabled: true,
  authorization_version: '2026-01-ach-debit-v1',
});
const deniedOnTable = (result) => {
  assert.equal(result.error?.code, '42501', JSON.stringify(result));
  assert.match(result.error.message, /permission denied for table tenant_wallet_funding_settings/);
  // The flag was set before the refused statement, as in staging.
  assert.ok(result.seen.includes(SET_MONEY_WRITE_SQL));
};

async function applyAndCheck({ admin, connectAs }, expectedPre) {
  const connect = () => connectAs('checksops_admin');
  const before = await acls(admin);
  const s = (await inspectReleaseProduction('sql140', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  assert.equal(s.live_definition_sha256, expectedPre);
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql140', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const after = await acls(admin);
  assert.deepEqual(after.table, before.table);
  for (const [name, acl] of Object.entries(after.columns)) {
    assert.deepEqual(acl, COLUMNS.includes(name) ? pinned(name) : before.columns[name], name);
  }
  return { before, after, pin };
}

test('PostgreSQL 16: the restore\'s grants (table SELECT only): the save is refused at the grant layer; SQL 140 through its production tool; then the save inserts, updates and RLS decides; nothing else changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql140-none-', 59740, 'none', async (fx) => {
  const { admin, connectAs } = fx;
  const connect = () => connectAs('checksops_admin');
  const before = await acls(admin);
  assert.deepEqual(before.table, ['authenticated SELECT', 'checksops SELECT']);
  for (const c of COLUMNS) assert.deepEqual(before.columns[c], [], c);

  // Before SQL 140: the save is refused before any policy runs (the staging log's error).
  deniedOnTable(await saveAs(connectAs, MEMBER_B, FULL));
  deniedOnTable(await saveAs(connectAs, MEMBER_B, { target_wallet_balance_cents: 100 }));
  assert.equal(Number((await admin.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n), 0);

  const { after, pin } = await applyAndCheck(fx, PRE_NONE);
  for (const c of COLUMNS) assert.deepEqual(after.columns[c], pinned(c), c);

  // After SQL 140: the first save inserts the row, the server stamps the acceptance.
  const first = await saveAs(connectAs, MEMBER_B, { ...FULL, authorization_accepted_at: '1999-01-01T00:00:00.000Z' });
  assert.equal(first.ok, true, JSON.stringify(first.error ? { message: first.error.message, code: first.error.code } : first));
  assert.equal(first.settings.tenant_id, TENANT_B);
  assert.equal(first.settings.target_wallet_balance_cents, 250000);
  assert.equal(first.settings.funding_strategy, 'target_balance');
  assert.equal(first.settings.authorization_accepted_by, MEMBER_B);
  assert.ok(first.settings.authorization_accepted_at && !String(first.settings.authorization_accepted_at).startsWith('1999'));
  assert.deepEqual(first.ignoredClientFields, ['authorization_accepted_at']);
  const stored = (await admin.query(`SELECT target_wallet_balance_cents::int AS target, auto_funding_enabled, updated_at FROM ${TABLE} WHERE tenant_id = $1::uuid`, [TENANT_B])).rows[0];
  assert.equal(stored.target, 250000);
  assert.equal(stored.auto_funding_enabled, true);
  // A second save updates the row (the UPDATE grant, updated_at included) and keeps what it did not name.
  const second = await saveAs(connectAs, MEMBER_B, { target_wallet_balance_cents: 100, auto_funding_enabled: false });
  assert.equal(second.ok, true, JSON.stringify(second.error ? second.error.message : second));
  assert.equal(second.settings.target_wallet_balance_cents, 100);
  assert.equal(second.settings.auto_funding_enabled, false);
  assert.equal(second.settings.funding_strategy, 'target_balance');
  const again = (await admin.query(`SELECT target_wallet_balance_cents::int AS target, updated_at FROM ${TABLE} WHERE tenant_id = $1::uuid`, [TENANT_B])).rows[0];
  assert.equal(again.target, 100);
  assert.ok(new Date(again.updated_at) >= new Date(stored.updated_at));
  assert.equal(Number((await admin.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n), 1);
  // Another tenant's viewer: past the grant layer, refused by aws_write_tenant_wallet_funding_settings.
  const other = await saveAs(connectAs, MEMBER_A, { target_wallet_balance_cents: 5 });
  assert.equal(other.ok ?? false, false, JSON.stringify(other.settings || null));
  if (other.error) {
    assert.equal(other.error.code, '42501');
    assert.match(other.error.message, /row-level security policy for table "tenant_wallet_funding_settings"/);
  } else {
    assert.equal(other.error_code ?? other.error, 'wallet_funding_update_not_applied');
  }
  assert.equal(Number((await admin.query(`SELECT target_wallet_balance_cents::int AS t FROM ${TABLE} WHERE tenant_id = $1::uuid`, [TENANT_B])).rows[0].t), 100);
  // A column outside the grant is still refused at the grant layer.
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_B]);
    await assert.rejects(c.query(`UPDATE ${TABLE} SET created_at = now() WHERE tenant_id = $1::uuid`, [TENANT_B]), (error) => error.code === '42501' && /permission denied for table tenant_wallet_funding_settings/.test(error.message));
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await acls(admin), after);
  const replayInspect = (await inspectReleaseProduction('sql140', { connect, pin, root: ROOT })).details;
  assert.equal(replayInspect.already_applied, true);
  assert.equal(replayInspect.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql140', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: table-level writes held by checksops: the save already passes; SQL 140 adds the column lines and keeps the table ACL', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql140-table-', 59840, 'table', async (fx) => {
  const { admin, connectAs } = fx;
  const before = await acls(admin);
  assert.deepEqual(before.table, ['authenticated SELECT', 'checksops INSERT', 'checksops SELECT', 'checksops UPDATE']);
  const saved = await saveAs(connectAs, MEMBER_B, FULL);
  assert.equal(saved.ok, true, JSON.stringify(saved.error ? saved.error.message : saved));
  const { after } = await applyAndCheck(fx, PRE_NONE);
  assert.deepEqual(after.table, before.table);
  const updated = await saveAs(connectAs, MEMBER_B, { target_wallet_balance_cents: 42 });
  assert.equal(updated.ok, true, JSON.stringify(updated.error ? updated.error.message : updated));
  assert.equal(updated.settings.target_wallet_balance_cents, 42);
}));

test('PostgreSQL 16: another role\'s grant on a pinned column refuses the pre-conditions; a missing column fails the file closed', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql140-other-', 59940, 'none', async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query('DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$');
  await admin.query(`GRANT UPDATE (funding_strategy) ON TABLE ${TABLE} TO service_role`);
  const refused = (await inspectReleaseProduction('sql140', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(refused.already_applied, false);
  assert.deepEqual(refused.precondition_failures, ['column_acl_replaceable'], JSON.stringify(refused.release_sql_inspect));
  const blocked = authorized(refused.live_definition_sha256);
  const noApply = await executeReleaseProductionApply('sql140', manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  assert.deepEqual((await acls(admin)).columns.funding_strategy, ['service_role UPDATE']);
  await admin.query(`REVOKE UPDATE (funding_strategy) ON TABLE ${TABLE} FROM service_role`);

  // The file's own preconditions: a missing column raises sql140_column_missing and changes nothing.
  await admin.query(`ALTER TABLE ${TABLE} DROP COLUMN authorization_version`);
  const before = await acls(admin);
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query('BEGIN');
    await assert.rejects(owner.query(TEXT), (error) => error.code === '42703' && /sql140_column_missing: public\.tenant_wallet_funding_settings\.authorization_version/.test(error.message));
    await owner.query('ROLLBACK');
  } finally {
    await owner.end();
  }
  assert.deepEqual(await acls(admin), before);
  const missing = (await inspectReleaseProduction('sql140', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(missing.missing_dependencies, [`column ${TABLE}.authorization_version`]);
}));
