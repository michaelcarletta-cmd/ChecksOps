/**
 * SQL 115 (aws/workflows/sql/115_provider_stakeholder_one_partner_payout.sql) on PostgreSQL 16,
 * through its production tool, the owner the non-superuser checksops_admin login, from the real
 * supabase function, trigger function and triggers (helpers/sql115-provider-stakeholder-schema.mjs):
 *
 *   - before SQL 115 a tenant with a receiving production Moov account and its partner payout
 *     cannot mark a sandbox account receiving: the trigger inserts a second active partner payout
 *     and stakeholder_accounts_one_partner_payout refuses the UPDATE (23505), as moov-sync on
 *     staging on 2026-10-25;
 *   - one apply reaches the intended fingerprint (EXECUTE the owner's only, the supabase-era
 *     PUBLIC, anon, authenticated and service_role lines revoked) and leaves the trigger function
 *     and the triggers as they were; then the same UPDATE succeeds, the tenant keeps exactly one
 *     active partner payout (the production one) and a later bank change keeps it; a tenant with
 *     one payment account still gets its partner payout; the file run again is a no-op and the
 *     tool refuses a re-apply as already in place;
 *   - an EXECUTE grant to a role the file does not revoke refuses the pre-conditions
 *     (function_acl_replaceable).
 *
 * Run: node --test aws/tests/sql115-provider-stakeholder-one-partner-payout-pg.test.mjs (as root the
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
import { PRODUCTION_ACCOUNT, PROVIDER_STAKEHOLDER_SCHEMA, SANDBOX_ACCOUNT, SYNC_FUNCTION, TENANT_B } from './helpers/sql115-provider-stakeholder-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql115', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');

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
  const workstream = 'prod-sql115-pg-test';
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
    one_use_id: `sql115-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-25T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql115-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

/** The function's EXECUTE ACL ('owner' for the owner's own line). */
const executeAcl = async (admin) => (await admin.query(`SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = p.proowner THEN 'owner'
    ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type AS line
  FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE p.oid = $1::regprocedure ORDER BY 1`, [SYNC_FUNCTION])).rows.map((r) => r.line);
/** The trigger function's source and ACL and the two triggers, as PostgreSQL prints them. */
const triggerSide = async (admin) => ({
  fn: (await admin.query(`SELECT md5(pg_catalog.pg_get_functiondef(p.oid)) || ' ' || COALESCE(p.proacl::text, '') AS d FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.trg_sync_provider_stakeholder_account()'::regprocedure`)).rows[0].d,
  triggers: (await admin.query(`SELECT t.tgname || ' ' || pg_catalog.pg_get_triggerdef(t.oid) AS d FROM pg_catalog.pg_trigger t
    WHERE t.tgname LIKE 'trg_sync_provider_stakeholder_%' ORDER BY 1`)).rows.map((r) => r.d),
});
const payouts = async (admin, tenant) => (await admin.query(`SELECT provider_environment, provider_account_id, is_active
  FROM public.stakeholder_accounts WHERE tenant_id = $1 AND is_partner_payout = true ORDER BY provider_environment`, [tenant])).rows;

/** The staging sequence of 2026-10-25: the sandbox account is created, then marked receiving by moov-sync. */
const ADD_SANDBOX = `INSERT INTO public.payment_provider_accounts (id, tenant_id, provider, environment, provider_account_id, display_name)
  VALUES ('${SANDBOX_ACCOUNT}', '${TENANT_B}', 'moov', 'sandbox', 'moov-sandbox-b', 'B')`;
const SANDBOX_RECEIVING = `UPDATE public.payment_provider_accounts SET can_receive_payments = true, updated_at = now() WHERE id = '${SANDBOX_ACCOUNT}'`;

test('PostgreSQL 16: SQL 115 through its production tool: the second-environment insert stops failing, one active partner payout stays, EXECUTE owner only, nothing else changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql115-prod-', 59715, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  // The seed's production account already created TENANT_B's partner payout through the trigger.
  assert.deepEqual(await payouts(admin, TENANT_B), [{ provider_environment: 'production', provider_account_id: 'moov-prod-b', is_active: true }]);
  assert.deepEqual(await executeAcl(admin), ['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'owner EXECUTE', 'service_role EXECUTE']);
  const side = await triggerSide(admin);
  assert.equal(side.triggers.length, 2);

  // Before SQL 115: the sandbox row is created (not receiving yet), then marking it receiving fails.
  await admin.query(ADD_SANDBOX);
  const refused = await admin.query(SANDBOX_RECEIVING).then(() => null, (error) => error);
  assert.equal(refused?.code, '23505');
  assert.equal(refused.constraint, 'stakeholder_accounts_one_partner_payout');

  const s = (await inspectReleaseProduction('sql115', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql115', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(await executeAcl(admin), ['owner EXECUTE']);
  assert.deepEqual(await triggerSide(admin), side);

  // After SQL 115: the same UPDATE succeeds and the tenant keeps its one active partner payout.
  await admin.query(SANDBOX_RECEIVING);
  assert.deepEqual(await payouts(admin, TENANT_B), [{ provider_environment: 'production', provider_account_id: 'moov-prod-b', is_active: true }]);
  // A sandbox bank (the payment method trigger) keeps it too.
  await admin.query(`INSERT INTO public.payment_provider_methods (tenant_id, provider, environment, provider_bank_account_id, bank_name, last_four, is_default)
    VALUES ('${TENANT_B}', 'moov', 'sandbox', 'bank-sandbox-b', 'Sandbox Bank', '0002', true)`);
  assert.deepEqual(await payouts(admin, TENANT_B), [{ provider_environment: 'production', provider_account_id: 'moov-prod-b', is_active: true }]);
  // The production account's own updates still refresh its row.
  await admin.query(`UPDATE public.payment_provider_accounts SET provider_account_id = 'moov-prod-b2', updated_at = now() + interval '1 minute' WHERE id = '${PRODUCTION_ACCOUNT}'`);
  assert.deepEqual(await payouts(admin, TENANT_B), [{ provider_environment: 'production', provider_account_id: 'moov-prod-b2', is_active: true }]);
  // A tenant with one payment account still gets its partner payout, as before.
  assert.deepEqual(await payouts(admin, TENANT_A), []);
  await admin.query(`INSERT INTO public.payment_provider_accounts (tenant_id, provider, environment, provider_account_id, display_name, can_receive_payments)
    VALUES ('${TENANT_A}', 'moov', 'production', 'moov-prod-a', 'A', true)`);
  assert.deepEqual(await payouts(admin, TENANT_A), [{ provider_environment: 'production', provider_account_id: 'moov-prod-a', is_active: true }]);

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await executeAcl(admin), ['owner EXECUTE']);
  const again = (await inspectReleaseProduction('sql115', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql115', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: an EXECUTE grant the file does not revoke refuses the pre-conditions; nothing is applied', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql115-acl-', 59815, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query(`GRANT EXECUTE ON FUNCTION ${SYNC_FUNCTION} TO checksops`);
  const before = await executeAcl(admin);
  const refused = (await inspectReleaseProduction('sql115', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(refused.already_applied, false);
  assert.deepEqual(refused.precondition_failures, ['function_acl_replaceable'], JSON.stringify(refused.release_sql_inspect));
  const blocked = authorized(refused.live_definition_sha256);
  const noApply = await executeReleaseProductionApply('sql115', manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  assert.deepEqual(await executeAcl(admin), before);
}));
