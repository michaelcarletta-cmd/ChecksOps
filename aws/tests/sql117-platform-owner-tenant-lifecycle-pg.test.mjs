/**
 * SQL 117 (aws/workflows/sql/117_platform_owner_tenant_lifecycle.sql) on PostgreSQL 16, through
 * its production tool, the owner the non-superuser checksops_admin login, after the real SQL 90
 * to SQL 102 files:
 *
 *   - the read-only inspect finds every prerequisite and no pre-condition failure; one apply
 *     reaches the code-derived intended fingerprint (tenant_deactivations and the six functions,
 *     including aws_platform_owner_deactivated_tenants()'s RETURNS TABLE result); the file run
 *     again is a no-op and the tool refuses a re-apply as already in place;
 *   - the functions work for the platform owner through the API role (deactivate suspends the
 *     memberships through SQL 102's column guard, reactivate restores them), and are refused to
 *     anyone else;
 *   - a tenant_deactivations table of another shape refuses the pre-conditions; nothing is applied.
 *
 * Run: node --test aws/tests/sql117-platform-owner-tenant-lifecycle-pg.test.mjs (as root the
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
import { releaseIntendedHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  MEMBER_A, PLATFORM_OWNER, REPO_ROOT, TENANT_A, TENANT_B, pgSkipReason, releaseFixture, sql98To100Schema,
} from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql117', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const sql = (name) => fs.readFileSync(path.join(REPO_ROOT, 'aws/workflows/sql', name), 'utf8');
const BEFORE = Object.freeze([
  '90_users_only_tenant_roles.sql', '91_moov_onboarding.sql', '92_signature_request_check_files_link_grant.sql',
  '93_tenant_company_info.sql', '94_document_library_restore.sql', '96_platform_owner_tenant_pricing.sql',
  '97_financial_stepup_log_server_writer.sql', '95_remove_freedom_claims_bridge.sql', '98_tenant_fee_collection.sql',
  '99_mortgage_desk_completion_messages.sql', '100_mortgage_desk_live_access.sql', '101_invite_identity_insert_order.sql',
  '102_platform_owner_tenant_profile.sql',
]);

/** The tenants and tenant_users columns production has that the fixture's trimmed shapes lack. */
const LIFECYCLE_SCHEMA = `
ALTER TABLE public.tenants ADD COLUMN slug text UNIQUE, ADD COLUMN custom_domain text UNIQUE,
  ADD COLUMN max_checks_per_month integer DEFAULT 100, ADD COLUMN is_test_account boolean NOT NULL DEFAULT false,
  ADD COLUMN moov_environment text NOT NULL DEFAULT 'sandbox', ADD COLUMN kyc_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN kyc_notes text, ADD COLUMN internal_notes text,
  ADD COLUMN is_system_tenant boolean NOT NULL DEFAULT false, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.tenant_users ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.payment_provider_accounts ADD COLUMN provider text NOT NULL DEFAULT 'moov';
UPDATE public.tenants SET slug = 'tenant-a', partner_code = 'PA', subscription_status = 'trialing' WHERE id = '${TENANT_A}';
UPDATE public.tenants SET slug = 'tenant-b', partner_code = 'PB' WHERE id = '${TENANT_B}';
`;

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
  const workstream = 'prod-sql117-pg-test';
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
    one_use_id: `sql117-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-27T00:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql117-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

/** The fixture with the real SQL 90 to SQL 102 files applied as checksops_admin. */
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [...sql98To100Schema(), LIFECYCLE_SCHEMA] });
  try {
    await fx.applyPredecessors();
    const owner = await fx.connectAs('checksops_admin');
    try {
      for (const file of BEFORE) await owner.query(sql(file));
    } finally {
      await owner.end();
    }
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('the pins carry the code-derived intended fingerprint', () => {
  assert.equal(PIN.intended_replacement_sha256, releaseIntendedHash('sql117', TEXT));
  assert.equal(PIN.intended_post_state.fingerprint, PIN.intended_replacement_sha256);
});

test('PostgreSQL 16: SQL 117 through its production tool reaches the intended fingerprint; the functions work for the platform owner only', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql117-prod-', 60117, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const s = (await inspectReleaseProduction('sql117', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql117', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);

  // The functions through the API role: the platform owner only.
  const api = await connectAs('checksops');
  const as = async (user, text, params = []) => {
    await api.query('BEGIN');
    try {
      await api.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
      const out = await api.query(text, params);
      await api.query('COMMIT');
      return out.rows;
    } catch (error) {
      await api.query('ROLLBACK');
      throw error;
    }
  };
  try {
    await admin.query('INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [TENANT_A, MEMBER_A, 'admin']);
    const members = Number((await admin.query('SELECT count(*)::int AS n FROM public.tenant_users WHERE tenant_id = $1', [TENANT_A])).rows[0].n);
    assert.ok(members >= 1);
    await assert.rejects(as(MEMBER_A, 'SELECT public.aws_platform_owner_deactivate_tenant($1, $2)', [TENANT_A, 'x']), /platform owner required/);
    const off = (await as(PLATFORM_OWNER, 'SELECT public.aws_platform_owner_deactivate_tenant($1, $2) AS r', [TENANT_A, 'Closed']))[0].r;
    assert.equal(off.suspended, members);
    assert.equal(Number((await admin.query('SELECT count(*)::int AS n FROM public.tenant_users WHERE tenant_id = $1', [TENANT_A])).rows[0].n), 0);
    assert.equal((await admin.query('SELECT subscription_status FROM public.tenants WHERE id = $1', [TENANT_A])).rows[0].subscription_status, 'inactive');
    const listed = await as(PLATFORM_OWNER, 'SELECT tenant_id::text, suspended_memberships FROM public.aws_platform_owner_deactivated_tenants()');
    assert.deepEqual(listed, [{ tenant_id: TENANT_A, suspended_memberships: members }]);
    const on = (await as(PLATFORM_OWNER, 'SELECT public.aws_platform_owner_reactivate_tenant($1) AS r', [TENANT_A]))[0].r;
    assert.equal(on.restored, members);
    assert.equal((await admin.query('SELECT subscription_status FROM public.tenants WHERE id = $1', [TENANT_A])).rows[0].subscription_status, 'trialing');
  } finally {
    await api.end();
  }

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  const again = (await inspectReleaseProduction('sql117', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql117', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: a tenant_deactivations table of another shape refuses the pre-conditions; nothing is applied', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql117-shape-', 60217, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query('CREATE TABLE public.tenant_deactivations (tenant_id uuid PRIMARY KEY, note text)');
  } finally {
    await owner.end();
  }
  const refused = (await inspectReleaseProduction('sql117', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(refused.already_applied, false);
  assert.ok(refused.precondition_failures.includes('created_tables_absent_or_intended'), JSON.stringify(refused.precondition_failures));
  const blocked = authorized(refused.live_definition_sha256);
  const noApply = await executeReleaseProductionApply('sql117', manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  assert.equal((await admin.query("SELECT to_regprocedure('public.aws_platform_owner_deactivate_tenant(uuid, text)') IS NULL AS absent")).rows[0].absent, true);
}));
