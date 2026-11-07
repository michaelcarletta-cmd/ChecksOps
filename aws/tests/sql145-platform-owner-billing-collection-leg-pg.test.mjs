/**
 * SQL 145 (aws/workflows/sql/145_platform_owner_billing_collection_leg.sql) on PostgreSQL 16, through its production
 * tool (lib/release-sql-production-apply.mjs, the owner the non-superuser checksops_admin login), with the writes made
 * as checksops (the API login, a member of authenticated) for an application user, as the fee pull makes them:
 *
 *   - the incident, reproduced: the API's collection_insert_leg statement as tenant-collection-v2.mjs ran it before this
 *     change, for the platform owner (not a member of the billed tenant) with request.money_write = '1', passes under
 *     the pre-SQL 90 aws_can_write_tenant (Freedom's 2026-09 leg, 2026-09-29) and fails with 42501 'new row violates
 *     row-level security policy for table "payment_transfers"' once SQL 90's membership-only helpers are in place
 *     (production since 2026-10-19; the 2026-11-06T22:53:11Z failure). The failing check is the permissive policies'
 *     WITH CHECK: aws_can_write_tenant(tenant_id) and tenant_id IN aws_user_tenant_ids() are false for the owner, while
 *     SQL 136's restrictive gate aws_money_write_allowed() is true. A member of the tenant still inserts directly;
 *   - the read-only inspect reads the derived pre-state (the function absent); a pending pin refuses; one apply reaches
 *     the intended fingerprint (EXECUTE for checksops and the owner only);
 *   - after it the API's own store (createPostgresCollectionStore(client).putLeg, savepoint collection_insert_leg) saves
 *     the platform owner's leg with exactly the columns the earlier INSERT wrote; a repeat with the transfer id updates
 *     it (ON CONFLICT); a wallet leg plus a bank leg up to the obligation's amount pass, beyond it refused;
 *   - refused: a non-member non-owner and a member of the tenant (the function is the platform owner's only; members
 *     keep their own policies), no user, no money-write flag, a key, period, leg role, contract or obligation that is
 *     not this leg's, another tenant's obligation, an existing row of another kind under the key; a non-member's
 *     direct INSERT is still refused by RLS (tenant isolation unchanged); authenticated and a plain login cannot
 *     execute it at all;
 *   - the file run again is a no-op; the tool refuses a re-apply as already in place;
 *   - FORCE ROW LEVEL SECURITY on a relation it writes or reads, or a missing column, refuses the pre-conditions and the
 *     file; nothing changes.
 *
 * Run: node --test aws/tests/sql145-platform-owner-billing-collection-leg-pg.test.mjs (needs PostgreSQL 16; as root
 * the PG helpers run the server as the ubuntu account).
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
import { releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { COLLECTION_INSERT_LEG_SQL, createPostgresCollectionStore } from '../functions/api/tenant-collection-v2.mjs';
import { MEMBER_A, MEMBER_B, PLATFORM_OWNER, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import {
  AMOUNT_A, OBLIGATION_A, OBLIGATION_A_SEPT, OBLIGATION_B, PERIOD, SQL90_WRITE_HELPERS, bankKey, collectionLegSchema, walletKey,
} from './helpers/sql145-collection-leg-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql145';
const IDENTITY = 'public.aws_platform_owner_insert_billing_collection_leg(uuid, text, text, text, bigint, text, text, uuid, text, text, text, text, jsonb)';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
/** Expected pre-state (the function absent; also derived by release-sql145-executor.test.mjs). */
const ABSENT_PRE = releaseStateHash(KEY, { functions: { [IDENTITY]: { exists: false } } });
const DEST = Object.freeze({ account: '41cb5d67-4911-4bef-aad5-d8ee9c582208', pm: 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c' });

/** The statement tenant-collection-v2.mjs ran for collection_insert_leg before this change (main 79e60a602), verbatim. */
const PRE_SQL145_INSERT = `INSERT INTO public.payment_transfers
             (tenant_id, provider, environment, status, idempotency_key, amount_cents,
              platform_fee_cents, net_amount_cents, speed, description,
              source_tenant_account_id, wallet_id, leg_role, provider_transfer_id,
              provider_status, failure_reason, provider_metadata, submitted_at)
           VALUES ($1::uuid, 'moov', $2, $3, $4, $5, 0, $5, 'standard', $6,
                   $7, $8::uuid, $9, $10, $11, $12, $13::jsonb, now())
           ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
             provider_transfer_id = COALESCE(EXCLUDED.provider_transfer_id, payment_transfers.provider_transfer_id),
             provider_status = COALESCE(EXCLUDED.provider_status, payment_transfers.provider_status),
             status = EXCLUDED.status,
             updated_at = now()
           RETURNING *`;

/** The collection leg row the API builds (executeCollectionLeg's `persisted`), for putLeg. */
const legRow = (over = {}) => {
  const legType = over.leg_type || 'ach_debit';
  const tenant = over.tenant_id || TENANT_A;
  const period = over.billing_period || PERIOD;
  return {
    tenant_id: tenant,
    obligation_id: OBLIGATION_A,
    billing_period: period,
    billing_type: 'monthly_subscription',
    leg_type: legType,
    environment: 'production',
    destination_account_id: DEST.account,
    destination_payment_method_id: DEST.pm,
    source_payment_method_id: 'debit-pm-bank',
    source_account_id: 'acct-tenant',
    amount_cents: AMOUNT_A,
    idempotency_key: legType === 'wallet' ? walletKey(tenant, period) : bankKey(tenant, period),
    // One Moov transfer per leg (payment_transfers_provider_id_uniq).
    provider_transfer_id: `mv-${tenant.slice(0, 8)}-${period}-${legType}`,
    provider_status: 'created',
    status: 'submitted',
    ...over,
  };
};
/** The 13 parameters putLeg passes (the earlier INSERT's, in its order). */
const legParams = (row) => [
  row.tenant_id, row.environment, row.status, row.idempotency_key, row.amount_cents,
  `ChecksOps collection v2 ${row.billing_period} ${row.leg_type}`, row.source_account_id || null, row.wallet_id || null,
  row.leg_type, row.provider_transfer_id || null, row.provider_status || null, row.failure_reason || null,
  JSON.stringify({
    collection_contract: 'tenant-collection-v2', obligation_id: row.obligation_id, billing_period: row.billing_period,
    billing_type: 'monthly_subscription', leg_type: row.leg_type, destination_account_id: DEST.account,
    destination_payment_method_id: DEST.pm, source_payment_method_id: row.source_payment_method_id,
    source_wallet_id: null, source_account_id: row.source_account_id || null, ...(row.metadata || {}),
  }),
];

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
  const workstream = 'prod-sql145-pg-test';
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
    one_use_id: `sql145-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-07T12:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql145-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: collectionLegSchema() });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/**
 * One API transaction as `login` (checksops: the API login) for an application user: BEGIN, the user, the
 * money-write flag (unless flag is false), then run(client); committed when commit is true, else rolled back.
 */
async function asApi(connectAs, user, run, { login = 'checksops', flag = true, commit = false } = {}) {
  const c = await connectAs(login);
  try {
    await c.query('BEGIN');
    if (user) await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    if (flag) await c.query("SELECT set_config('request.money_write', '1', true)");
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
const leg = (connectAs, user, row, options) => asApi(connectAs, user, async (c) => (await c.query(COLLECTION_INSERT_LEG_SQL, legParams(row))).rows[0], options);
const RLS_REFUSED = (r) => r.error?.code === '42501' && r.error.message === 'new row violates row-level security policy for table "payment_transfers"';
const FORBIDDEN = (r) => r.error?.code === '42501' && r.error.message === 'billing_collection_leg_forbidden';
const INVALID = (r, what) => r.error?.code === '22023' && r.error.message === `billing_collection_leg_invalid: ${what}`;
const NO_EXECUTE = (r) => r.error?.code === '42501' && /permission denied for function aws_platform_owner_insert_billing_collection_leg/.test(r.error.message);
async function asOwner(connectAs, sql) {
  const owner = await connectAs('checksops_admin');
  try {
    return await owner.query(sql);
  } finally {
    await owner.end();
  }
}
const present = async (admin) => (await admin.query('SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present', [IDENTITY])).rows[0].present;
const legs = async (admin) => (await admin.query(`SELECT tenant_id, provider, environment, status, idempotency_key, amount_cents::int AS amount_cents,
    platform_fee_cents::int AS platform_fee_cents, net_amount_cents::int AS net_amount_cents, speed, description, source_tenant_account_id, wallet_id,
    leg_role, provider_transfer_id, provider_status, failure_reason, provider_metadata, submitted_at IS NOT NULL AS submitted
  FROM public.payment_transfers WHERE idempotency_key LIKE 'billing-%' ORDER BY idempotency_key`)).rows;

test('PostgreSQL 16: the incident reproduced (the platform owner\'s collection leg passes before SQL 90, 42501 after it); SQL 145 through its production tool; the API store then saves the leg; everyone else and every other row refused; then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql145-tool-', 61456, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query('CREATE ROLE sql145_plain LOGIN NOSUPERUSER NOBYPASSRLS');
  const septRow = legRow({ billing_period: '2026-09', obligation_id: OBLIGATION_A_SEPT });
  const direct = (user, row = legRow()) => asApi(connectAs, user, async (c) => (await c.query(PRE_SQL145_INSERT, legParams(row))).rows[0]);

  // September (pre-SQL 90 aws_can_write_tenant: the platform owner may write any tenant): the API's direct INSERT passes.
  const september = await direct(PLATFORM_OWNER, septRow);
  assert.equal(september.error, null, september.error?.message);
  assert.equal(september.value.idempotency_key, bankKey(TENANT_A, '2026-09'));

  // SQL 90's membership-only helpers (production since 2026-10-19): the same INSERT for the platform owner is the incident.
  await admin.query(SQL90_WRITE_HELPERS);
  const incident = await direct(PLATFORM_OWNER);
  assert.ok(RLS_REFUSED(incident), `${incident.error?.code} ${incident.error?.message}`);
  assert.equal(incident.error.routine, 'ExecWithCheckOptions');
  // Which check fails: both permissive policies' WITH CHECK are false for the owner; SQL 136's restrictive gate is true.
  const checks = await asApi(connectAs, PLATFORM_OWNER, async (c) => (await c.query(`SELECT public.is_platform_owner() AS owner,
      public.aws_can_write_tenant($1::uuid) AS sql24_write, $1::uuid IN (SELECT public.aws_user_tenant_ids()) AS sql72_member,
      public.aws_money_write_allowed() AS sql136_gate`, [TENANT_A])).rows[0]);
  assert.deepEqual(checks.value, { owner: true, sql24_write: false, sql72_member: false, sql136_gate: true });
  // A member of the tenant still writes its own leg directly; a member of another tenant cannot.
  assert.equal((await direct(MEMBER_A)).error, null);
  assert.ok(RLS_REFUSED(await direct(MEMBER_B)), 'non-member direct insert');
  assert.deepEqual(await legs(admin), []);

  // SQL 145 through the production tool: the derived pre-state, a pending pin refuses, one apply.
  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.equal(s.live_definition_sha256, ABSENT_PRE);
  const pendingPin = { ...PIN, authorization: 'pending', execute: false, expected_live_definition_sha256: ABSENT_PRE };
  const pendingApply = await executeReleaseProductionApply(KEY, manifest(pendingPin), { root: ROOT, pin: pendingPin, connect, consumedPath: consumedPath() });
  assert.equal(pendingApply.ok, false);
  assert.equal(await present(admin), false);
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const acl = (await admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile, p.proconfig,
      (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
         FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
    FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
  assert.deepEqual(acl, { owner: 'checksops_admin', prosecdef: true, provolatile: 'v', proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] });

  // The API's own store, as the platform owner's pull runs it: the leg saves, with exactly the earlier INSERT's columns.
  const saved = await asApi(connectAs, PLATFORM_OWNER, async (c) => {
    const store = await createPostgresCollectionStore(c);
    return store.putLeg(legRow());
  }, { flag: false, commit: true });
  assert.equal(saved.error, null, saved.error?.message);
  assert.equal(saved.value.idempotency_key, bankKey(TENANT_A));
  assert.deepEqual(await legs(admin), [{
    tenant_id: TENANT_A, provider: 'moov', environment: 'production', status: 'submitted', idempotency_key: bankKey(TENANT_A),
    amount_cents: AMOUNT_A, platform_fee_cents: 0, net_amount_cents: AMOUNT_A, speed: 'standard',
    description: `ChecksOps collection v2 ${PERIOD} ach_debit`, source_tenant_account_id: 'acct-tenant', wallet_id: null,
    leg_role: 'ach_debit', provider_transfer_id: legRow().provider_transfer_id, provider_status: 'created', failure_reason: null,
    provider_metadata: JSON.parse(legParams(legRow())[12]), submitted: true,
  }]);
  // A repeat of the same leg (ON CONFLICT): status and provider status update; still one row.
  const repeat = await leg(connectAs, PLATFORM_OWNER, legRow({ provider_status: 'completed', status: 'settled' }), { commit: true });
  assert.equal(repeat.error, null, repeat.error?.message);
  assert.deepEqual([repeat.value.status, repeat.value.provider_status], ['settled', 'completed']);
  assert.equal((await legs(admin)).length, 1);
  // A wallet leg on top: allowed up to the obligation's amount (bank + wallet <= 13900), refused beyond it.
  assert.ok(INVALID(await leg(connectAs, PLATFORM_OWNER, legRow({ leg_type: 'wallet', amount_cents: 1 })), 'amount'), 'over the obligation');
  await admin.query(`UPDATE public.payment_transfers SET status = 'failed' WHERE idempotency_key = $1`, [bankKey(TENANT_A)]);
  const wallet = await leg(connectAs, PLATFORM_OWNER, legRow({ leg_type: 'wallet', amount_cents: 4000 }));
  assert.equal(wallet.error, null, wallet.error?.message);
  assert.equal(wallet.value.leg_role, 'wallet');

  // Refused callers: a member of another tenant, a member of the billed tenant (members keep their own policies), no user,
  // the owner without the money-write flag.
  const fresh = legRow({ tenant_id: TENANT_B, obligation_id: OBLIGATION_B, amount_cents: 5000 });
  assert.ok(FORBIDDEN(await leg(connectAs, MEMBER_A, fresh)), 'non-member non-owner');
  assert.ok(FORBIDDEN(await leg(connectAs, MEMBER_B, fresh)), 'member of the billed tenant');
  assert.ok(FORBIDDEN(await leg(connectAs, null, fresh)), 'no user');
  const noFlag = await leg(connectAs, PLATFORM_OWNER, fresh, { flag: false });
  assert.ok(noFlag.error?.code === '42501' && noFlag.error.message === 'billing_collection_leg_not_server_write', noFlag.error?.message);
  assert.equal((await leg(connectAs, PLATFORM_OWNER, fresh)).error, null, 'the owner with the flag');
  // Tenant isolation unchanged: a non-member's direct INSERT into another tenant is still refused.
  assert.ok(RLS_REFUSED(await asApi(connectAs, MEMBER_A, async (c) => c.query(PRE_SQL145_INSERT, legParams(fresh)))), 'direct insert across tenants');

  // Refused rows: only a tenant-collection-v2 leg of an existing obligation of that tenant and period.
  const refusedRow = async (row, what) => assert.ok(INVALID(await leg(connectAs, PLATFORM_OWNER, row), what), `${what}: ${JSON.stringify(row).slice(0, 80)}`);
  await refusedRow(legRow({ idempotency_key: 'send:a:0:bank' }), 'key');
  await refusedRow(legRow({ idempotency_key: bankKey(TENANT_B) }), 'key');
  await refusedRow(legRow({ leg_type: 'wallet', idempotency_key: bankKey(TENANT_A) }), 'key');
  await refusedRow(legRow({ metadata: { collection_contract: 'other' } }), 'key');
  await refusedRow(legRow({ billing_period: '2026-13', idempotency_key: bankKey(TENANT_A, '2026-13') }), 'key');
  assert.ok(INVALID(await leg(connectAs, PLATFORM_OWNER, legRow({ leg_type: 'send_bank' })), 'leg_role'));
  await refusedRow(legRow({ status: 'completed' }), 'row');
  await refusedRow(legRow({ environment: 'staging' }), 'row');
  await refusedRow(legRow({ obligation_id: OBLIGATION_B }), 'obligation');
  await refusedRow(legRow({ obligation_id: 'not-a-uuid' }), 'obligation');
  await refusedRow(legRow({ billing_period: '2026-09', idempotency_key: bankKey(TENANT_A, '2026-09') }), 'obligation');
  // An existing row of another kind under the key (not a tenant-collection-v2 leg): never overwritten.
  await admin.query(`INSERT INTO public.payment_transfers (tenant_id, environment, status, idempotency_key, amount_cents, leg_role)
    VALUES ($1, 'production', 'submitted', $2, 100, 'send_bank')`, [TENANT_B, walletKey(TENANT_B)]);
  const conflict = await leg(connectAs, PLATFORM_OWNER, legRow({ tenant_id: TENANT_B, obligation_id: OBLIGATION_B, leg_type: 'wallet', amount_cents: 100 }));
  assert.ok(conflict.error?.code === '23505' && conflict.error.message === 'billing_collection_leg_conflict', conflict.error?.message);
  assert.equal((await admin.query('SELECT status, leg_role FROM public.payment_transfers WHERE idempotency_key = $1', [walletKey(TENANT_B)])).rows[0].leg_role, 'send_bank');

  // authenticated and a plain login hold no EXECUTE.
  assert.ok(NO_EXECUTE(await leg(connectAs, PLATFORM_OWNER, fresh, { login: 'sql145_plain' })), 'plain login');
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [PLATFORM_OWNER]);
    await assert.rejects(c.query(COLLECTION_INSERT_LEG_SQL, legParams(fresh)), (e) => e.code === '42501' && /permission denied for function/.test(e.message));
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }

  // Idempotent: the file again is a no-op; the tool refuses a re-apply.
  await asOwner(connectAs, TEXT);
  const replayInspect = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(replayInspect.already_applied, true);
  assert.equal(replayInspect.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.deepEqual(replayInspect.precondition_failures, [], JSON.stringify(replayInspect.release_sql_inspect));
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: SQL 145 with a relation it writes or reads under FORCE ROW LEVEL SECURITY, or a missing column, refuses the pre-conditions; the file\'s own rules agree; nothing changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql145-drift-', 61457, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const inspect = async () => (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;

  for (const table of ['payment_transfers', 'tenant_maintenance_payments']) {
    await admin.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    const forced = await inspect();
    assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], `${table}: ${JSON.stringify(forced.release_sql_inspect)}`);
    assert.equal(forced.live_definition_sha256, ABSENT_PRE);
    const blocked = authorized(forced.live_definition_sha256);
    const noApply = await executeReleaseProductionApply(KEY, manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
    assert.equal(noApply.ok, false, table);
    await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && new RegExp(`sql145_definer_cannot_write: .*${table}`).test(e.message), table);
    assert.equal(await present(admin), false, table);
    await admin.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`);
  }

  // A column it writes missing: prerequisites missing, and the file refuses.
  await admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN net_amount_cents TO net_moved');
  const missing = await inspect();
  assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.payment_transfers.net_amount_cents'),
    JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
  assert.ok(missing.precondition_failures.includes('prerequisites_present'));
  await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && /sql145_prerequisite_missing: .*net_amount_cents/.test(e.message));
  assert.equal(await present(admin), false);
  await admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN net_moved TO net_amount_cents');
  // SQL 136's gate missing (SQL 136 not applied): refused too.
  await admin.query('ALTER FUNCTION public.aws_money_write_allowed() RENAME TO aws_money_write_moved');
  const noGate = await inspect();
  assert.ok(noGate.release_sql_inspect.prerequisites_missing.includes('public.aws_money_write_allowed()'), JSON.stringify(noGate.release_sql_inspect.prerequisites_missing));
  await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && /sql145_prerequisite_missing: .*aws_money_write_allowed/.test(e.message));
  await admin.query('ALTER FUNCTION public.aws_money_write_moved() RENAME TO aws_money_write_allowed');
  assert.deepEqual((await inspect()).precondition_failures, []);
  assert.equal(await present(admin), false);
}));
