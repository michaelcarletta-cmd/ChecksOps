/**
 * SQL 146 (aws/workflows/sql/146_moov_status_catch_up_writes.sql) on PostgreSQL 16, through its production tool
 * (lib/release-sql-production-apply.mjs, the owner the non-superuser checksops_admin login), with the catch-up's reads
 * and writes made as checksops (the API login, a member of authenticated) for the platform owner, who is not a member
 * of the tenant, under production's policies on payment_transfers, tenant_maintenance_payments and payment_event_log
 * (helpers/sql146-catch-up-schema.mjs) and SQL 90's membership-only helpers, with SQL 109's writer applied:
 *
 *   - the incident, reproduced: the plan reads every candidate row; the apply's lock statements as
 *     moov-status-catch-up.mjs ran them before this change (main 2fb3acae6, verbatim) return no row for the platform
 *     owner (with or without the money-write flag or the webhook apply context), while a member of the tenant gets the
 *     row: PostgreSQL applies the UPDATE policies to SELECT ... FOR UPDATE, and payment_transfers' are membership-only.
 *     The obligation's lock is empty without the money-write flag (SQL 136's restrictive UPDATE gate). The fee leg's
 *     UPDATE finds no row for the owner, and its payment_event_log INSERT is refused (42501) outside the webhook apply
 *     context. Production run 42395949680: catch_up_state_changed_since_plan, found {legs: {}, obligations: {}};
 *   - the live webhook (no user): the SQL 109 writer applies a send leg (a DEFINER, unaffected); the fee leg's
 *     settlement sees no row (no_billing_occurrence), a separate gap this change does not touch;
 *   - before SQL 146 the changed catch-up refuses the first transfer and rolls it back (the lock function is absent);
 *     nothing changes;
 *   - SQL 146 through the production tool: the derived pre-state, a pending pin refuses, one apply reaches the intended
 *     fingerprint (EXECUTE for checksops and the owner only on both functions);
 *   - then the same reviewed plan applies: exactly the planned rows change (send and funding legs completed through
 *     SQL 109, the fee leg and its obligation settled, three event rows), an amount Moov disagrees with stays refused
 *     and untouched, and a new plan has nothing left to apply;
 *   - refused: the lock without the webhook apply context, for a member, another tenant's member or no user; the leg
 *     writer without the context, for a member of the tenant or of another tenant; bad inputs; a plain login and
 *     authenticated cannot execute either; the leg writer leaves a SQL 109 leg, an unknown transfer and a wrong amount
 *     alone and never moves a leg backwards; a member's and the owner's direct UPDATEs are still filtered by RLS (tenant
 *     isolation unchanged);
 *   - the file run again is a no-op; the tool refuses a re-apply as already in place;
 *   - FORCE ROW LEVEL SECURITY on a relation they lock or write, a missing column or SQL 91's helper missing refuses the
 *     pre-conditions and the file; nothing changes.
 *
 * Run: node --test aws/tests/sql146-moov-status-catch-up-writes-pg.test.mjs (needs PostgreSQL 16; as root the PG
 * helpers run the server as the ubuntu account).
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
import {
  COLLECTION_LEG_STATUS_SQL,
  LOCK_ROWS_SQL,
  runCatchUpApply,
  runCatchUpPlan,
} from '../functions/api/providers/moov-status-catch-up.mjs';
import { applyProductionMoovTransferWebhook } from '../functions/api/providers/moov-transfer-webhook.mjs';
import { applyCollectionV2ProviderCompletion } from '../functions/api/tenant-collection-v2-settlement.mjs';
import { MEMBER_A, MEMBER_B, PLATFORM_OWNER, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { SQL90_WRITE_HELPERS } from './helpers/sql145-collection-leg-schema.mjs';
import {
  FEE_CENTS, FEE_LEG, FEE_LEG_META, FEE_OBLIGATION, FEE_TRANSFER, FUND, FUND_CENTS, FUND_TRANSFER, SEND, SEND_CENTS, SEND_TRANSFER,
  catchUpSchema, fakeConfirm, trustedTransfer,
} from './helpers/sql146-catch-up-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql146';
const LOCK_IDENTITY = 'public.aws_moov_catch_up_lock_rows(text, text, uuid[])';
const LEG_IDENTITY = 'public.aws_moov_apply_collection_leg_status(text, text, bigint, text, text, text, timestamp with time zone)';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SQL109_TEXT = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/109_moov_transfer_webhook_status.sql'), 'utf8');
/** Expected pre-state (both functions absent; also derived by release-sql146-executor.test.mjs). */
const ABSENT_PRE = releaseStateHash(KEY, { functions: { [LOCK_IDENTITY]: { exists: false }, [LEG_IDENTITY]: { exists: false } } });
const quiet = { warn: () => {}, log: () => {} };

/** The apply's lock statements as moov-status-catch-up.mjs ran them before this change (main 2fb3acae6), verbatim. */
const PRE_SQL146_LOCK_LEGS_SQL = `SELECT id, status FROM public.payment_transfers /* moov_status_catch_up_lock */
 WHERE provider = 'moov' AND environment = $1 AND provider_transfer_id = $2
 ORDER BY id FOR UPDATE`;
const PRE_SQL146_LOCK_OBLIGATIONS_SQL = `SELECT id, status FROM public.tenant_maintenance_payments /* moov_status_catch_up_lock */
 WHERE id::text = ANY ($1::text[])
 ORDER BY id FOR UPDATE`;

/** A fourth candidate Moov reports with another amount: the plan refuses it and it must stay untouched. */
const MISMATCH = 'c1460000-0000-4000-8000-0000000000a4';
const MISMATCH_TRANSFER = 'mv-catchup-mismatch';
const RECORDS = Object.freeze({
  [SEND_TRANSFER]: trustedTransfer(SEND_TRANSFER, 'completed', SEND_CENTS),
  [FUND_TRANSFER]: trustedTransfer(FUND_TRANSFER, 'completed', FUND_CENTS),
  [FEE_TRANSFER]: trustedTransfer(FEE_TRANSFER, 'completed', FEE_CENTS),
  [MISMATCH_TRANSFER]: trustedTransfer(MISMATCH_TRANSFER, 'completed', 1001),
});
const confirm = fakeConfirm(RECORDS);

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
  const workstream = 'prod-sql146-pg-test';
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
    one_use_id: `sql146-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-07T12:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql146-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: catchUpSchema() });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/**
 * One API transaction as `login` (checksops: the API login): BEGIN, the user (none when null), each GUC in `gucs` set
 * to '1', then run(client); committed when commit is true, else rolled back.
 */
async function asApi(connectAs, user, run, { login = 'checksops', gucs = [], commit = false } = {}) {
  const c = await connectAs(login);
  try {
    await c.query('BEGIN');
    if (user) await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    for (const name of gucs) await c.query('SELECT set_config($1, \'1\', true)', [name]);
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
const WEBHOOK_APPLY = 'request.provider_webhook_apply';
const MONEY_WRITE = 'request.money_write';
const statuses = (result) => Object.fromEntries(result.rows.map((row) => [row.id, row.status]));
const lockRows = (connectAs, user, args, options) => asApi(connectAs, user, async (c) => (await c.query(LOCK_ROWS_SQL, args)).rows[0].locked, options);
const legStatus = (connectAs, user, args, options) => asApi(connectAs, user, async (c) => (await c.query(COLLECTION_LEG_STATUS_SQL, args)).rows[0].result, options);
const feeArgs = (over = {}) => {
  const a = { env: 'production', transfer: FEE_TRANSFER, amount: FEE_CENTS, status: 'settled', providerStatus: 'completed', reason: 'transfer.updated', at: null, ...over };
  return [a.env, a.transfer, a.amount, a.status, a.providerStatus, a.reason, a.at];
};
const denied = (r, message) => r.error?.code === '42501' && r.error.message === message;
const invalid = (r, message) => r.error?.code === '22023' && r.error.message === message;
const NO_EXECUTE = (r, name) => r.error?.code === '42501' && new RegExp(`permission denied for function ${name}`).test(r.error.message);
async function asOwner(connectAs, sql) {
  const owner = await connectAs('checksops_admin');
  try {
    return await owner.query(sql);
  } finally {
    await owner.end();
  }
}
const present = async (admin, identity) => (await admin.query('SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present', [identity])).rows[0].present;
const legRows = async (admin) => statuses(await admin.query('SELECT id, status FROM public.payment_transfers ORDER BY id'));
const obligationRows = async (admin) => statuses(await admin.query('SELECT id, status FROM public.tenant_maintenance_payments ORDER BY id'));
const events = async (admin) => (await admin.query(`SELECT provider_transfer_id, event_type, previous_status, new_status
  FROM public.payment_event_log ORDER BY provider_transfer_id, event_type`)).rows;
const BEFORE_LEGS = Object.freeze({ [SEND]: 'submitted', [FUND]: 'pending', [FEE_LEG]: 'submitted', [MISMATCH]: 'submitted' });

test('PostgreSQL 16: the incident reproduced (the platform owner\'s FOR UPDATE lock reads no row); SQL 146 through its production tool; the reviewed plan then applies exactly its rows; everyone else and every other row refused; then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql146-tool-', 61466, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query('CREATE ROLE sql146_plain LOGIN NOSUPERUSER NOBYPASSRLS');
  await admin.query(`INSERT INTO public.payment_transfers (id, tenant_id, environment, provider_transfer_id, provider_status, status, idempotency_key,
      amount_cents, leg_role, provider_metadata) VALUES ($1, $2, 'production', $3, 'created', 'submitted', 'send:catchup:mismatch', 1000, 'send_bank', '{}')`,
  [MISMATCH, TENANT_A, MISMATCH_TRANSFER]);
  // Production's state: SQL 90's membership-only helpers, SQL 109's writer applied (2026-10-21).
  await admin.query(SQL90_WRITE_HELPERS);
  await asOwner(connectAs, SQL109_TEXT);
  assert.deepEqual(await legRows(admin), BEFORE_LEGS);

  // The plan (read-only) sees every candidate: three to apply, the amount mismatch refused.
  const client = await connectAs('checksops');
  try {
    const plan = await runCatchUpPlan({ client, environment: 'production', actorId: PLATFORM_OWNER, limit: 50, secrets: {}, confirm });
    assert.equal(plan.ok, true, plan.error);
    assert.deepEqual(plan.transfer_ids, [FEE_TRANSFER, FUND_TRANSFER, SEND_TRANSFER]);
    assert.deepEqual(plan.counts, { candidates: 4, apply: 3, skip: 0, refuse: 1, by_reason: { completed: 3, amount_mismatch: 1 } });
    const fee = plan.manifest.entries.find((e) => e.provider_transfer_id === FEE_TRANSFER);
    assert.deepEqual([fee.legs[0].predicted_status, fee.obligations[0].predicted_status], ['settled', 'settled']);

    // The incident: main's lock statements, as the platform owner in a write transaction.
    const lockAs = (user, sql, args, gucs = []) => asApi(connectAs, user, async (c) => statuses(await c.query(sql, args)), { gucs });
    const sendLock = ['production', SEND_TRANSFER];
    assert.deepEqual((await asApi(connectAs, PLATFORM_OWNER, async (c) => statuses(await c.query(
      'SELECT id, status FROM public.payment_transfers WHERE provider_transfer_id = $1', [SEND_TRANSFER])))).value, { [SEND]: 'submitted' }, 'plain SELECT');
    for (const gucs of [[], [MONEY_WRITE], [WEBHOOK_APPLY], [MONEY_WRITE, WEBHOOK_APPLY]]) {
      assert.deepEqual((await lockAs(PLATFORM_OWNER, PRE_SQL146_LOCK_LEGS_SQL, sendLock, gucs)).value, {}, `owner lock ${gucs}`);
    }
    assert.deepEqual((await lockAs(MEMBER_A, PRE_SQL146_LOCK_LEGS_SQL, sendLock, [MONEY_WRITE])).value, { [SEND]: 'submitted' }, 'member lock');
    assert.deepEqual((await lockAs(PLATFORM_OWNER, PRE_SQL146_LOCK_OBLIGATIONS_SQL, [[FEE_OBLIGATION]])).value, {}, 'obligation lock, no flag');
    assert.deepEqual((await lockAs(PLATFORM_OWNER, PRE_SQL146_LOCK_OBLIGATIONS_SQL, [[FEE_OBLIGATION]], [MONEY_WRITE])).value, { [FEE_OBLIGATION]: 'due' });
    // Which checks: the owner reads (cross-tenant reader) but is no member; SQL 136's gate is true with the flag.
    const checks = await asApi(connectAs, PLATFORM_OWNER, async (c) => (await c.query(`SELECT public.is_platform_owner() AS owner,
        public.aws_is_cross_tenant_reader() AS reader, public.aws_can_write_tenant($1::uuid) AS sql24_write,
        $1::uuid IN (SELECT public.aws_user_tenant_ids()) AS sql72_member, public.aws_money_write_allowed() AS sql136_gate`, [TENANT_A])).rows[0], { gucs: [MONEY_WRITE] });
    assert.deepEqual(checks.value, { owner: true, reader: true, sql24_write: false, sql72_member: false, sql136_gate: true });
    // The fee leg's UPDATE finds no row; the event row is refused outside the webhook apply context, allowed inside it.
    const update = await asApi(connectAs, PLATFORM_OWNER, async (c) => (await c.query(
      "UPDATE public.payment_transfers SET status = 'settled' WHERE id = $1", [FEE_LEG])).rowCount, { gucs: [MONEY_WRITE] });
    assert.equal(update.value, 0);
    const insertEvent = (gucs) => asApi(connectAs, PLATFORM_OWNER, async (c) => (await c.query(`INSERT INTO public.payment_event_log
        (provider, environment, tenant_id, provider_transfer_id, event_type) VALUES ('moov', 'production', $1, $2, 'collection_v2.completed')`,
    [TENANT_A, FEE_TRANSFER])).rowCount, { gucs });
    const refusedEvent = await insertEvent([MONEY_WRITE]);
    assert.ok(refusedEvent.error?.code === '42501' && /row-level security policy for table "payment_event_log"/.test(refusedEvent.error.message), refusedEvent.error?.message);
    assert.equal((await insertEvent([WEBHOOK_APPLY])).value, 1);

    // The live webhook (no user): SQL 109's DEFINER writer applies a send leg; the fee leg's settlement sees no row.
    const webhook = await asApi(connectAs, null, async (c) => {
      const send = await applyProductionMoovTransferWebhook(c, RECORDS[SEND_TRANSFER], { eventId: 'evt-send', log: quiet });
      const feeTransfer = await applyProductionMoovTransferWebhook(c, RECORDS[FEE_TRANSFER], { eventId: 'evt-fee', log: quiet });
      const feeCollection = await applyCollectionV2ProviderCompletion(c, RECORDS[FEE_TRANSFER], { dryRun: false });
      return { send: [send.outcome, send.status], fee: [feeTransfer.outcome, feeCollection.skipped] };
    }, { gucs: ['request.provider_webhook'] });
    assert.deepEqual(webhook.value, { send: ['applied', 'completed'], fee: ['not_owned', 'no_billing_occurrence'] });

    // Before SQL 146 the changed catch-up refuses the first transfer and rolls it back: nothing changes.
    const request = { actorId: PLATFORM_OWNER, limit: 50, statement: 'apply the Moov catch-up in production', manifestSha256: plan.manifest_sha256, transferIds: plan.transfer_ids };
    const early = await runCatchUpApply({ client, environment: 'production', secrets: {}, confirm, log: quiet, request });
    assert.equal(early.ok, false);
    assert.equal(early.error, 'catch_up_apply_exception');
    assert.equal(early.failure.sqlstate, '42883');
    assert.equal(early.failure.rolled_back, true);
    assert.equal(early.stopped_at, FEE_TRANSFER);
    assert.deepEqual(early.applied, []);
    assert.deepEqual(await legRows(admin), BEFORE_LEGS);
    assert.deepEqual(await events(admin), []);

    // SQL 146 through the production tool: the derived pre-state, a pending pin refuses, one apply.
    const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
    assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
    assert.equal(s.already_applied, false);
    assert.equal(s.live_definition_sha256, ABSENT_PRE);
    const pendingPin = { ...PIN, authorization: 'pending', execute: false, expected_live_definition_sha256: ABSENT_PRE };
    const pendingApply = await executeReleaseProductionApply(KEY, manifest(pendingPin), { root: ROOT, pin: pendingPin, connect, consumedPath: consumedPath() });
    assert.equal(pendingApply.ok, false);
    assert.equal(await present(admin, LOCK_IDENTITY), false);
    const pin = authorized(s.live_definition_sha256);
    const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    for (const identity of [LOCK_IDENTITY, LEG_IDENTITY]) {
      const acl = (await admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile, p.proconfig,
          pg_catalog.pg_get_function_result(p.oid) AS result,
          (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
             FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
        FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [identity])).rows[0];
      assert.deepEqual(acl, { owner: 'checksops_admin', prosecdef: true, provolatile: 'v', proconfig: ['search_path=public, pg_temp'], result: 'jsonb', execute: ['checksops', 'checksops_admin'] }, identity);
    }

    // The same reviewed plan now applies, one transaction per transfer: exactly the planned rows change.
    const done = await runCatchUpApply({ client, environment: 'production', secrets: {}, confirm, log: quiet, request });
    assert.equal(done.ok, true, JSON.stringify(done.failure || done.error));
    assert.equal(done.current_manifest_sha256, plan.manifest_sha256);
    assert.deepEqual(done.applied.map((r) => [r.provider_transfer_id, r.transfer_outcome, r.collection_leg_outcome, r.collection_outcome]), [
      [FEE_TRANSFER, 'not_owned', 'applied', 'applied'],
      [FUND_TRANSFER, 'applied', null, 'unrelated_transfer'],
      [SEND_TRANSFER, 'applied', null, 'unrelated_transfer'],
    ]);
    assert.deepEqual(await legRows(admin), { [SEND]: 'completed', [FUND]: 'completed', [FEE_LEG]: 'settled', [MISMATCH]: 'submitted' });
    assert.deepEqual(await obligationRows(admin), { [FEE_OBLIGATION]: 'settled' });
    const feeRow = (await admin.query('SELECT provider_status, completed_at, failure_reason, amount_cents::int AS amount, provider_metadata FROM public.payment_transfers WHERE id = $1', [FEE_LEG])).rows[0];
    assert.deepEqual([feeRow.provider_status, feeRow.completed_at?.toISOString(), feeRow.failure_reason, feeRow.amount, feeRow.provider_metadata],
      ['completed', '2026-09-05T15:00:00.000Z', null, FEE_CENTS, FEE_LEG_META]);
    assert.deepEqual(await events(admin), [
      { provider_transfer_id: FEE_TRANSFER, event_type: 'collection_v2.completed', previous_status: 'due', new_status: 'settled' },
      { provider_transfer_id: FUND_TRANSFER, event_type: 'transfer.updated', previous_status: 'pending', new_status: 'completed' },
      { provider_transfer_id: SEND_TRANSFER, event_type: 'transfer.updated', previous_status: 'submitted', new_status: 'completed' },
    ]);
    // Idempotent: the same manifest is refused as changed and writes nothing; a new plan has nothing to apply.
    const again = await runCatchUpApply({ client, environment: 'production', secrets: {}, confirm, log: quiet, request });
    assert.equal(again.error, 'catch_up_plan_changed');
    const after = await runCatchUpPlan({ client, environment: 'production', actorId: PLATFORM_OWNER, limit: 50, secrets: {}, confirm });
    assert.deepEqual(after.transfer_ids, []);
    assert.deepEqual(after.counts, { candidates: 1, apply: 0, skip: 0, refuse: 1, by_reason: { amount_mismatch: 1 } });
    // Another actor is refused before anything is read from Moov.
    const notOwner = await runCatchUpPlan({ client, environment: 'production', actorId: MEMBER_A, limit: 50, secrets: {}, confirm });
    assert.equal(notOwner.error, 'catch_up_actor_not_platform_owner');
  } finally {
    await client.end();
  }

  // Refusal rows in the sandbox environment (the plan above reads production only).
  const FEE2 = 'c1460000-0000-4000-8000-0000000000c1';
  await admin.query(`INSERT INTO public.payment_transfers (id, tenant_id, environment, provider_transfer_id, provider_status, status, idempotency_key,
      amount_cents, leg_role, provider_metadata) VALUES
    ($1, $2, 'sandbox', 'mv-sbx-fee', 'created', 'submitted', 'billing-2026-10-x-bank', 5000, 'ach_debit', $3::jsonb),
    (gen_random_uuid(), $2, 'sandbox', 'mv-sbx-send', 'created', 'submitted', 'send:sbx', 5000, 'send_bank', '{}'),
    (gen_random_uuid(), $2, 'sandbox', 'mv-sbx-other', 'created', 'submitted', 'other:sbx', 5000, 'ach_debit', '{"collection_contract":"other"}')`,
  [FEE2, TENANT_B, JSON.stringify({ ...FEE_LEG_META, obligation_id: FEE_OBLIGATION, billing_period: '2026-10' })]);
  const sbx = (over) => feeArgs({ env: 'sandbox', transfer: 'mv-sbx-fee', amount: 5000, ...over });
  const sbxStatus = async () => (await admin.query('SELECT status FROM public.payment_transfers WHERE id = $1', [FEE2])).rows[0].status;

  // The lock: the webhook apply context and the platform owner, nobody else.
  const lockArgs = ['production', SEND_TRANSFER, [FEE_OBLIGATION]];
  assert.ok(denied(await lockRows(connectAs, PLATFORM_OWNER, lockArgs), 'moov_catch_up_webhook_apply_required'));
  assert.ok(denied(await lockRows(connectAs, PLATFORM_OWNER, lockArgs, { gucs: [MONEY_WRITE] }), 'moov_catch_up_webhook_apply_required'));
  for (const user of [MEMBER_A, MEMBER_B, null]) {
    assert.ok(denied(await lockRows(connectAs, user, lockArgs, { gucs: [WEBHOOK_APPLY] }), 'moov_catch_up_forbidden'), String(user));
  }
  assert.deepEqual((await lockRows(connectAs, PLATFORM_OWNER, lockArgs, { gucs: [WEBHOOK_APPLY] })).value,
    { legs: { [SEND]: 'completed' }, obligations: { [FEE_OBLIGATION]: 'settled' } });
  assert.deepEqual((await lockRows(connectAs, PLATFORM_OWNER, ['production', 'mv-none', null], { gucs: [WEBHOOK_APPLY] })).value, { legs: {}, obligations: {} });
  for (const args of [['staging', SEND_TRANSFER, []], ['production', ' ', []], ['production', SEND_TRANSFER, Array.from({ length: 51 }, () => FEE_OBLIGATION)]]) {
    assert.ok(invalid(await lockRows(connectAs, PLATFORM_OWNER, args, { gucs: [WEBHOOK_APPLY] }), 'moov_catch_up_invalid'), JSON.stringify(args).slice(0, 60));
  }

  // The leg writer: the webhook apply context; with a user only the platform owner; with no user the context alone.
  assert.ok(denied(await legStatus(connectAs, PLATFORM_OWNER, sbx(), { gucs: [MONEY_WRITE] }), 'moov_collection_leg_webhook_apply_required'));
  assert.ok(denied(await legStatus(connectAs, null, sbx()), 'moov_collection_leg_webhook_apply_required'));
  assert.ok(denied(await legStatus(connectAs, MEMBER_B, sbx(), { gucs: [WEBHOOK_APPLY] }), 'moov_collection_leg_forbidden'), 'member of the tenant');
  assert.ok(denied(await legStatus(connectAs, MEMBER_A, sbx(), { gucs: [WEBHOOK_APPLY] }), 'moov_collection_leg_forbidden'), 'member of another tenant');
  for (const over of [{ status: 'completed' }, { status: null }, { amount: 0 }, { amount: null }, { env: 'staging' }, { transfer: '' }]) {
    assert.ok(invalid(await legStatus(connectAs, PLATFORM_OWNER, sbx(over), { gucs: [WEBHOOK_APPLY] }), 'moov_collection_leg_invalid'), JSON.stringify(over));
  }
  // Rows it leaves alone (nothing written): an unknown transfer, a SQL 109 leg, a leg of another contract, another amount.
  const outcome = async (over, user = PLATFORM_OWNER) => (await legStatus(connectAs, user, sbx(over), { gucs: [WEBHOOK_APPLY], commit: true })).value.outcome;
  assert.equal(await outcome({ transfer: 'mv-sbx-none' }), 'unknown_transfer');
  assert.equal(await outcome({ transfer: 'mv-sbx-send' }), 'not_owned');
  assert.equal(await outcome({ transfer: 'mv-sbx-other' }), 'not_owned');
  assert.equal(await outcome({ amount: 5001 }), 'amount_mismatch');
  assert.equal(await sbxStatus(), 'submitted');
  // Never backwards: returned (the webhook, no user), then a late settled is stale and an equal returned unchanged.
  assert.equal(await outcome({ status: 'returned', providerStatus: 'Returned', reason: 'R01' }, null), 'applied');
  const returned = (await admin.query('SELECT status, provider_status, failure_reason, completed_at FROM public.payment_transfers WHERE id = $1', [FEE2])).rows[0];
  assert.deepEqual(returned, { status: 'returned', provider_status: 'returned', failure_reason: 'R01', completed_at: null });
  assert.equal(await outcome({ status: 'settled' }), 'stale');
  assert.equal(await outcome({ status: 'failed' }), 'stale');
  assert.equal(await outcome({ status: 'returned' }), 'unchanged');
  assert.equal(await sbxStatus(), 'returned');

  // A plain login and authenticated hold no EXECUTE on either function.
  assert.ok(NO_EXECUTE(await lockRows(connectAs, PLATFORM_OWNER, lockArgs, { login: 'sql146_plain', gucs: [WEBHOOK_APPLY] }), 'aws_moov_catch_up_lock_rows'));
  assert.ok(NO_EXECUTE(await legStatus(connectAs, PLATFORM_OWNER, sbx(), { login: 'sql146_plain', gucs: [WEBHOOK_APPLY] }), 'aws_moov_apply_collection_leg_status'));
  for (const sql of [LOCK_ROWS_SQL, COLLECTION_LEG_STATUS_SQL]) {
    const c = await connectAs('checksops');
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE authenticated');
      await c.query("SELECT set_config('request.app_user_id', $1, true)", [PLATFORM_OWNER]);
      await c.query("SELECT set_config('request.provider_webhook_apply', '1', true)");
      await assert.rejects(c.query(sql, sql === LOCK_ROWS_SQL ? lockArgs : sbx()), (e) => e.code === '42501' && /permission denied for function/.test(e.message));
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  }
  // Tenant isolation unchanged: the owner's and another tenant's member's direct UPDATEs still find no row.
  for (const user of [PLATFORM_OWNER, MEMBER_A]) {
    const r = await asApi(connectAs, user, async (c) => (await c.query("UPDATE public.payment_transfers SET status = 'failed' WHERE id = $1", [FEE2])).rowCount,
      { gucs: [MONEY_WRITE, WEBHOOK_APPLY] });
    assert.equal(r.value, 0, String(user));
  }

  // Idempotent: the file again is a no-op; the tool refuses a re-apply.
  const pin = authorized(ABSENT_PRE);
  await asOwner(connectAs, TEXT);
  const replayInspect = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(replayInspect.already_applied, true);
  assert.equal(replayInspect.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.deepEqual(replayInspect.precondition_failures, [], JSON.stringify(replayInspect.release_sql_inspect));
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: SQL 146 with a relation it locks or writes under FORCE ROW LEVEL SECURITY, a missing column or SQL 91\'s helper missing refuses the pre-conditions; the file\'s own rules agree; nothing changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql146-drift-', 61467, async ({ admin, connectAs }) => {
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
    await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && new RegExp(`sql146_definer_cannot_write: .*${table}`).test(e.message), table);
    assert.equal(await present(admin, LOCK_IDENTITY), false, table);
    await admin.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`);
  }

  // A column it writes missing: prerequisites missing, and the file refuses.
  await admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN completed_at TO completed_moved');
  const missing = await inspect();
  assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.payment_transfers.completed_at'),
    JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
  assert.ok(missing.precondition_failures.includes('prerequisites_present'));
  await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && /sql146_prerequisite_missing: .*completed_at/.test(e.message));
  assert.equal(await present(admin, LOCK_IDENTITY), false);
  await admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN completed_moved TO completed_at');
  // SQL 91's webhook apply helper missing: refused too.
  await admin.query('ALTER FUNCTION public.aws_moov_webhook_apply_active() RENAME TO aws_moov_webhook_apply_moved');
  const noHelper = await inspect();
  assert.ok(noHelper.release_sql_inspect.prerequisites_missing.includes('public.aws_moov_webhook_apply_active()'), JSON.stringify(noHelper.release_sql_inspect.prerequisites_missing));
  await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && /sql146_prerequisite_missing: .*aws_moov_webhook_apply_active/.test(e.message));
  await admin.query('ALTER FUNCTION public.aws_moov_webhook_apply_moved() RENAME TO aws_moov_webhook_apply_active');
  assert.deepEqual((await inspect()).precondition_failures, []);
  assert.equal(await present(admin, LOCK_IDENTITY), false);
  assert.equal(await present(admin, LEG_IDENTITY), false);
}));
