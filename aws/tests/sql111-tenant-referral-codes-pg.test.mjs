/**
 * SQL 111 (aws/workflows/sql/111_tenant_referral_codes.sql) on PostgreSQL 16, through its
 * production tool, from the tenants referral columns and referral_events as the SPA reads them
 * with the aws/rls policies (helpers/sql111-referral-schema.mjs), the owner the non-superuser
 * checksops_admin login.
 *
 * Owner rules (2026-10-22) checked here, in cents:
 *   - referral credit = min(2500, 500 * referrals): $5.00 per referral, at most $25.00 a month;
 *   - a Supabase-era referral recorded only in tenants.referred_by_tenant_id counts once;
 *   - discount = min(credit + tenants.referral_discount_cents, monthly_rate_cents): the hand-set
 *     discount is added, and maintenance never goes below $0;
 *   - any member of the redeeming tenant may redeem (a viewer included), once per tenant; not a
 *     non-member, not the tenant's own code, not a code of a tenant it referred, not a system
 *     tenant's code, not an unknown or malformed code;
 *   - the credit function answers for a member of the tenant and for a session with no app
 *     identity (the billing scheduler), and refuses another tenant's member (42501);
 *   - the platform-owner overview answers for the platform owner only and returns no Founding.
 *
 * Run: node --test aws/tests/sql111-tenant-referral-codes-pg.test.mjs (as root the PG helpers
 * run the server as the ubuntu account).
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
import { MEMBER_A, MEMBER_B, PLATFORM_OWNER, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { CAP_TENANTS, REFERRAL_SCHEMA, TENANT_C, TENANT_LEGACY, VIEWER_A } from './helpers/sql111-referral-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql111', ROOT);
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
  const workstream = 'prod-sql111-pg-test';
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
    one_use_id: `sql111-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-22T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql111-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: [REFERRAL_SCHEMA] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** One statement as the API login (checksops), with or without an app identity. */
async function asApi(connectAs, { user = null, commit = false } = {}, run) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    if (user) await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    const value = await run(c);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return { value, error: null };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    return { value: null, error };
  } finally {
    await c.end();
  }
}

const one = (sql, params) => async (c) => (await c.query(sql, params)).rows[0].r;
const redeem = (connectAs, user, tenant, code) => asApi(connectAs, { user, commit: true },
  one('SELECT public.aws_apply_referral_code($1::uuid, $2) AS r', [tenant, code]));
const credit = (connectAs, user, tenant) => asApi(connectAs, { user },
  one('SELECT public.aws_tenant_referral_credit_cents($1::uuid) AS r', [tenant]));
const summary = (connectAs, user, tenant) => asApi(connectAs, { user },
  one('SELECT public.aws_tenant_referral_summary($1::uuid) AS r', [tenant]));
const overview = (connectAs, user) => asApi(connectAs, { user },
  one('SELECT public.aws_platform_owner_referral_overview() AS r', []));

/** A member of `tenant` for redeeming on its behalf (the cap tenants have none in the fixture). */
async function addMember(admin, tenant, user, role = 'viewer') {
  await admin.query("INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES ($1, $2, 'active') ON CONFLICT DO NOTHING", [user, `${user}@example.invalid`]);
  await admin.query('INSERT INTO public.profiles (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user, `${user}@example.invalid`]);
  await admin.query('INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ($1, $2, $3)', [tenant, user, role]);
}

test('PostgreSQL 16: SQL 111 through its production tool: redeem, $5 per referral up to $25, discount = credit + hand-set at most the rate', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql111-prod-', 61111, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');

  // Before SQL 111 the functions do not exist.
  assert.equal((await redeem(connectAs, MEMBER_A, TENANT_A, 'BRAVO-2')).error?.code, '42883');

  const s = (await inspectReleaseProduction('sql111', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql111', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);

  // Refusals: a non-member, a malformed, unknown or system code, the tenant's own code.
  const notMember = await redeem(connectAs, MEMBER_B, TENANT_A, 'CHARLIE-3');
  assert.equal(notMember.error, null, notMember.error?.message);
  assert.equal(notMember.value.error, 'not_authorized');
  for (const [code, want] of [['x', 'invalid_code'], ['NOPE-9', 'invalid_code'], ['SYSTEM-0', 'invalid_code'], ['alpha-1', 'own_code']]) {
    const r = await redeem(connectAs, MEMBER_A, TENANT_A, code);
    assert.equal(r.value?.error, want, code);
  }
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.referral_events')).rows[0].n, 0);

  // A viewer of A (any member, the role is not checked) redeems B's code, trimmed and upper-cased.
  const ok = await redeem(connectAs, VIEWER_A, TENANT_A, '  bravo-2 ');
  assert.equal(ok.error, null, ok.error?.message);
  assert.equal(ok.value.success, true, JSON.stringify(ok.value));
  assert.equal(ok.value.referrer_tenant_id, TENANT_B);
  const ev = (await admin.query('SELECT referrer_tenant_id, referred_tenant_id, referred_user_id, referral_code_used, discount_applied_cents, status FROM public.referral_events')).rows;
  assert.deepEqual(ev, [{ referrer_tenant_id: TENANT_B, referred_tenant_id: TENANT_A, referred_user_id: VIEWER_A, referral_code_used: 'BRAVO-2', discount_applied_cents: 500, status: 'active' }]);
  // No tenants row changed.
  const a = (await admin.query('SELECT referred_by_tenant_id, referral_discount_cents FROM public.tenants WHERE id = $1', [TENANT_A])).rows[0];
  assert.deepEqual(a, { referred_by_tenant_id: null, referral_discount_cents: 0 });

  // Once per tenant; B cannot use the code of a tenant it referred.
  assert.equal((await redeem(connectAs, MEMBER_A, TENANT_A, 'CHARLIE-3')).value.error, 'already_redeemed');
  assert.equal((await redeem(connectAs, MEMBER_B, TENANT_B, 'ALPHA-1')).value.error, 'mutual_referral');

  // B: 1 referral -> $5.00, for a member of B and for the billing scheduler (no identity).
  assert.equal((await credit(connectAs, MEMBER_B, TENANT_B)).value, 500);
  assert.equal((await credit(connectAs, null, TENANT_B)).value, 500);
  assert.equal((await credit(connectAs, MEMBER_A, TENANT_B)).error?.code, '42501');
  const sb = (await summary(connectAs, MEMBER_B, TENANT_B)).value;
  assert.equal(sb.active_referrals, 1);
  assert.equal(sb.earned_credit_cents, 500);
  assert.equal(sb.applied_discount_cents, 500);
  assert.deepEqual(sb.referrals.map((r) => [r.name, r.status]), [['A', 'active']]);
  const sa = (await summary(connectAs, VIEWER_A, TENANT_A)).value;
  assert.equal(sa.referred_by.tenant_id, TENANT_B);
  assert.equal(sa.referred_by.code, 'BRAVO-2');
  assert.equal(sa.active_referrals, 0);
  assert.equal(sa.applied_discount_cents, 0);

  // C: one Supabase-era referral (LEGACY) counts once -> $5.00.
  assert.equal((await credit(connectAs, null, TENANT_C)).value, 500);

  // Six more tenants use C's code: 7 referrals -> capped at $25.00.
  const counts = [];
  for (const [i, tenant] of CAP_TENANTS.entries()) {
    const user = `b1000000-0000-4000-8000-00000000020${i}`;
    await addMember(admin, tenant, user);
    const r = await redeem(connectAs, user, tenant, 'charlie-3');
    assert.equal(r.value?.success, true, JSON.stringify(r.value ?? r.error?.message));
    counts.push((await credit(connectAs, null, TENANT_C)).value);
  }
  assert.deepEqual(counts, [1000, 1500, 2000, 2500, 2500, 2500]);
  const sc = (await summary(connectAs, null, TENANT_C)).error;
  assert.equal(sc?.code, '42501', 'the summary needs an identity that can access the tenant');

  // The discount adds the hand-set figure and never exceeds the monthly rate.
  const cMember = 'b1000000-0000-4000-8000-0000000002cc';
  await addMember(admin, TENANT_C, cMember);
  const disc = async () => (await summary(connectAs, cMember, TENANT_C)).value;
  let c = await disc();
  assert.deepEqual([c.active_referrals, c.earned_credit_cents, c.manual_discount_cents, c.monthly_rate_cents, c.applied_discount_cents], [7, 2500, 0, 9900, 2500]);
  await admin.query('UPDATE public.tenants SET referral_discount_cents = 1000 WHERE id = $1', [TENANT_C]);
  c = await disc();
  assert.equal(c.applied_discount_cents, 3500, '$25.00 credit + $10.00 hand-set');
  await admin.query('UPDATE public.tenants SET monthly_rate_cents = 2000 WHERE id = $1', [TENANT_C]);
  c = await disc();
  assert.equal(c.applied_discount_cents, 2000, 'at most the $20.00 rate: maintenance $0.00');
  assert.equal(c.referrals.length, 7);
  assert.ok(c.referrals.some((r) => r.name === 'Legacy'));

  // A referral keeps counting whatever the referred tenant does later.
  await admin.query("UPDATE public.tenants SET name = name WHERE id = $1", [TENANT_LEGACY]);
  assert.equal((await credit(connectAs, null, TENANT_C)).value, 2500);

  // The platform-owner overview: the owner only, the same figures, no Founding.
  assert.equal((await overview(connectAs, MEMBER_A)).error?.code, '42501');
  const ov = (await overview(connectAs, PLATFORM_OWNER)).value;
  assert.ok(Array.isArray(ov));
  assert.equal(ov.some((row) => row.slug === 'system'), false);
  const rowC = ov.find((row) => row.tenant_id === TENANT_C);
  assert.deepEqual([rowC.active_referrals, rowC.earned_credit_cents, rowC.manual_discount_cents, rowC.applied_discount_cents], [7, 2500, 1000, 2000]);
  assert.equal(ov.find((row) => row.tenant_id === TENANT_A).referred_by.tenant_id, TENANT_B);
  for (const row of ov) assert.equal(Object.hasOwn(row, 'is_founding_partner'), false);

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  const again = (await inspectReleaseProduction('sql111', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql111', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));
