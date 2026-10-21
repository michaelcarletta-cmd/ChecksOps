/**
 * SQL 107 (aws/workflows/sql/107_moov_transfer_webhook_status.sql) on PostgreSQL 16, through its
 * production tool, after the real SQL 91, the owner the non-superuser checksops_admin login, with
 * payment_transfers and payment_event_log shaped as the supabase migration created them and the
 * real aws_select_ / aws_write_ policies of aws/rls/sql 12 and 24:
 *
 *   - before SQL 107 the webhook login (checksops, no user) can neither see nor update another
 *     tenant's transfer under RLS: the gap the file closes;
 *   - one apply reaches the intended fingerprint; the writer refuses without
 *     request.provider_webhook_apply = '1', refuses authenticated (EXECUTE is checksops only),
 *     refuses a bad environment / status / id;
 *   - the webhook path (applyProductionMoovTransferWebhook, the real module) against the real
 *     function: completed, then an R01 return (returned, notify once, return code and reason,
 *     manual follow-up), a replayed event (duplicate_event), a late 'completed' (stale: never
 *     backwards), a NOC (correction, status unchanged), a fee-collection leg (not_owned), an
 *     unknown transfer, and the sandbox row with the same Moov id untouched;
 *   - tenant isolation: every row written carries the transfer's own tenant; members still see
 *     only their own tenant's transfers and events.
 *
 * Run: node --test aws/tests/sql107-moov-transfer-webhook-status-pg.test.mjs (as root the PG
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
import { applyProductionMoovTransferWebhook, TRANSFER_STATUS_WRITER_SQL } from '../functions/api/providers/moov-transfer-webhook.mjs';
import { MEMBER_A, MEMBER_B, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { COLLECT_A, FUND_B, PAYMENT_SCHEMA, SANDBOX_A, SEND_A } from './helpers/sql107-payment-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql107', ROOT);
const PIN91 = loadReleaseProductionPin('sql91', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SQL91_TEXT = fs.readFileSync(path.join(ROOT, PIN91.filename), 'utf8');

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
  const workstream = 'prod-sql107-pg-test';
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
    one_use_id: `sql107-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-21T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql107-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const quietLog = { warn() {} };

/** One webhook transaction as the API login (checksops, no user), like handleProviderWebhook. */
async function asWebhook(connectAs, fn) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.provider_webhook', '1', true)");
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await c.end();
  }
}
/** The caught error of one statement as checksops (optionally under a role), or null. */
async function errorOf(connectAs, sql, params, { gucApply = '1', role = null } = {}) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    if (role) await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.provider_webhook_apply', $1, true)", [gucApply]);
    await c.query(sql, params);
    return null;
  } catch (error) {
    return error;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}
const writerArgs = (over = {}) => {
  const a = {
    env: 'production', id: 'mv-send-a', status: 'completed', providerStatus: 'completed', eventId: 'evt-x',
    type: 'transfer.updated', rc: null, rr: null, cc: null, cr: null, at: null, ...over,
  };
  return [a.env, a.id, a.status, a.providerStatus, a.eventId, a.type, a.rc, a.rr, a.cc, a.cr, a.at];
};
const transfer = async (admin, id) => (await admin.query('SELECT * FROM public.payment_transfers WHERE id = $1', [id])).rows[0];
const events = async (admin, id) => (await admin.query(
  'SELECT tenant_id, environment, event_type, previous_status, new_status, provider_metadata FROM public.payment_event_log WHERE transfer_id = $1 ORDER BY created_at, id',
  [id],
)).rows;
/** What a member (checksops with that user's GUC) can read. */
async function visibleAs(connectAs, userId) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [userId]);
    const t = (await c.query('SELECT id FROM public.payment_transfers ORDER BY id')).rows.map((r) => r.id);
    const e = (await c.query('SELECT DISTINCT transfer_id FROM public.payment_event_log ORDER BY transfer_id')).rows.map((r) => r.transfer_id);
    return { transfers: t, events: e };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}
const moovEvent = (eventId, data) => ({ eventID: eventId, type: 'transfer.updated', data });

test('PostgreSQL 16: SQL 107 through its production tool; the webhook write-back of status, ACH return and NOC is idempotent, never backwards, tenant-scoped', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql107-', 59910, { extra: [PAYMENT_SCHEMA] });
  const { admin, connectAs } = fx;
  try {
    const owner = await connectAs('checksops_admin');
    try {
      await owner.query(SQL91_TEXT);
    } finally {
      await owner.end();
    }

    // Before SQL 107: the webhook login sees no transfer and updates nothing (RLS), so a
    // return could never be written back; the writer does not exist yet.
    const blind = await asWebhook(connectAs, async (c) => {
      await c.query("SELECT set_config('request.provider_webhook_apply', '1', true)");
      const seen = (await c.query("SELECT id FROM public.payment_transfers WHERE provider_transfer_id = 'mv-send-a'")).rows.length;
      const updated = (await c.query("UPDATE public.payment_transfers SET status = 'returned' WHERE provider_transfer_id = 'mv-send-a'")).rowCount;
      return { seen, updated };
    });
    assert.deepEqual(blind, { seen: 0, updated: 0 });
    const missing = await asWebhook(connectAs, (c) => applyProductionMoovTransferWebhook(
      c, moovEvent('evt-0', { transferID: 'mv-send-a', status: 'completed' }), { eventId: 'evt-0', log: quietLog },
    ));
    assert.equal(missing.skipped, 'status_writer_unavailable');
    assert.equal(missing.applied, false);

    // Apply through the production tool.
    const connect = () => connectAs('checksops_admin');
    const s = (await inspectReleaseProduction('sql107', { connect, pin: PIN, root: ROOT })).details;
    assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
    assert.equal(s.already_applied, false);
    assert.deepEqual(s.predecessors, { sql91: true });
    const pin = authorized(s.live_definition_sha256);
    const applied = await executeReleaseProductionApply('sql107', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);

    // Gates: the GUC, the EXECUTE grant, the inputs.
    const noGuc = await errorOf(connectAs, TRANSFER_STATUS_WRITER_SQL, writerArgs(), { gucApply: '0' });
    assert.equal(noGuc?.code, '42501');
    assert.match(noGuc.message, /moov_webhook_apply_required/);
    const asAuthenticated = await errorOf(connectAs, TRANSFER_STATUS_WRITER_SQL, writerArgs(), { role: 'authenticated' });
    assert.equal(asAuthenticated?.code, '42501');
    assert.match(asAuthenticated.message, /permission denied for function/);
    assert.equal((await errorOf(connectAs, TRANSFER_STATUS_WRITER_SQL, writerArgs({ env: 'staging' })))?.code, '22023');
    assert.equal((await errorOf(connectAs, TRANSFER_STATUS_WRITER_SQL, writerArgs({ status: 'settled' })))?.code, '22023');
    assert.equal((await errorOf(connectAs, TRANSFER_STATUS_WRITER_SQL, writerArgs({ eventId: ' ' })))?.code, '22023');
    assert.equal((await transfer(admin, SEND_A)).status, 'submitted', 'refusals changed nothing');

    const hook = (eventId, data) => asWebhook(connectAs, (c) => applyProductionMoovTransferWebhook(
      c, moovEvent(eventId, data), { eventId, log: quietLog },
    ));

    // 1) completed.
    const done = await hook('evt-1', { transferID: 'mv-send-a', status: 'completed', completedOn: '2026-10-21T15:00:00Z' });
    assert.equal(done.outcome, 'applied');
    assert.equal(done.status, 'completed');
    assert.equal(done.notify, false);
    assert.equal(done.tenant_id, TENANT_A);
    let row = await transfer(admin, SEND_A);
    assert.equal(row.status, 'completed');
    assert.equal(row.provider_status, 'completed');
    assert.equal(row.completed_at.toISOString(), '2026-10-21T15:00:00.000Z');

    // 2) R01 after completion: returned, notify, code and reason recorded, follow-up flagged.
    const bounced = await hook('evt-2', {
      transferID: 'mv-send-a',
      status: 'completed',
      source: { achDetails: { status: 'returned', return: { code: 'R01', reason: 'Insufficient funds' } } },
    });
    assert.equal(bounced.outcome, 'applied');
    assert.equal(bounced.previous_status, 'completed');
    assert.equal(bounced.status, 'returned');
    assert.equal(bounced.notify, true);
    assert.equal(bounced.return_code, 'R01');
    row = await transfer(admin, SEND_A);
    assert.equal(row.status, 'returned');
    assert.equal(row.failure_reason, 'ACH return R01: Insufficient funds');
    assert.equal(row.provider_metadata.moov_return.code, 'R01');
    assert.equal(row.provider_metadata.moov_return.reason, 'Insufficient funds');
    assert.match(row.provider_metadata.manual_follow_up.reason, /returned \(R01\)/);
    assert.equal(row.provider_metadata.moov_last_webhook.event_id, 'evt-2');

    // 3) The same event again (a redelivery past the receipt): duplicate, nothing written.
    const before = await events(admin, SEND_A);
    const dup = await hook('evt-2', { transferID: 'mv-send-a', status: 'failed', source: { achDetails: { return: { code: 'R01' } } } });
    assert.equal(dup.outcome, 'duplicate_event');
    assert.equal(dup.applied, false);
    assert.deepEqual(await events(admin, SEND_A), before);

    // 4) A late 'completed' / 'pending' (out of order): stale; the return stays.
    const late = await hook('evt-3', { transferID: 'mv-send-a', status: 'completed' });
    assert.equal(late.outcome, 'stale');
    const older = await hook('evt-4', { transferID: 'mv-send-a', status: 'pending' });
    assert.equal(older.outcome, 'stale');
    row = await transfer(admin, SEND_A);
    assert.equal(row.status, 'returned');
    assert.equal(row.failure_reason, 'ACH return R01: Insufficient funds');
    const log = await events(admin, SEND_A);
    assert.deepEqual(log.map((e) => [e.previous_status, e.new_status, e.provider_metadata.outcome]), [
      ['submitted', 'completed', 'applied'],
      ['completed', 'returned', 'applied'],
      ['returned', 'returned', 'stale'],
      ['returned', 'returned', 'stale'],
    ]);
    assert.ok(log.every((e) => e.tenant_id === TENANT_A && e.environment === 'production'));
    assert.equal(log[1].provider_metadata.return_code, 'R01');
    assert.equal(log[1].provider_metadata.moov_event_id, 'evt-2');

    // 5) A NOC on tenant B's funding: status unchanged, correction recorded for a person.
    const noc = await hook('evt-5', {
      transferID: 'mv-fund-b', status: 'pending',
      source: { achDetails: { status: 'corrected', correction: { code: 'C01', reason: 'Incorrect account number' } } },
    });
    assert.equal(noc.outcome, 'correction');
    assert.equal(noc.tenant_id, TENANT_B);
    const fund = await transfer(admin, FUND_B);
    assert.equal(fund.status, 'pending');
    assert.equal(fund.provider_metadata.moov_correction.code, 'C01');
    assert.match(fund.provider_metadata.manual_follow_up.reason, /notification of change \(C01\)/);
    // Then R10 before completion (Moov 'failed'): returned.
    const r10 = await hook('evt-6', {
      transferID: 'mv-fund-b', status: 'failed',
      source: { achDetails: { status: 'returned', return: { code: 'r10', reason: 'Customer advises not authorized' } } },
    });
    assert.equal(r10.status, 'returned');
    assert.equal(r10.notify, true);
    assert.equal((await transfer(admin, FUND_B)).failure_reason, 'ACH return R10: Customer advises not authorized');

    // 6) Not ours: a fee-collection leg, an unknown id; the sandbox row with the same id untouched.
    const collect = await hook('evt-7', { transferID: 'mv-collect-a', status: 'failed' });
    assert.equal(collect.outcome, 'not_owned');
    assert.equal((await transfer(admin, COLLECT_A)).status, 'submitted');
    assert.deepEqual(await events(admin, COLLECT_A), []);
    const unknown = await hook('evt-8', { transferID: 'mv-nobody', status: 'failed' });
    assert.equal(unknown.outcome, 'unknown_transfer');
    const sandbox = await transfer(admin, SANDBOX_A);
    assert.equal(sandbox.status, 'submitted');
    assert.deepEqual(sandbox.provider_metadata, {});

    // 7) Tenant isolation holds: each member sees only its own tenant's transfers and events.
    const a = await visibleAs(connectAs, MEMBER_A);
    assert.ok(a.transfers.includes(SEND_A) && !a.transfers.includes(FUND_B));
    assert.ok(a.events.includes(SEND_A) && !a.events.includes(FUND_B));
    const b = await visibleAs(connectAs, MEMBER_B);
    assert.deepEqual(b.transfers, [FUND_B]);
    assert.deepEqual(b.events, [FUND_B]);

    // Idempotent file; the tool refuses a re-apply; SQL 91 keeps its fingerprint.
    const again = await connectAs('checksops_admin');
    try {
      await again.query(TEXT);
    } finally {
      await again.end();
    }
    const inspect2 = (await inspectReleaseProduction('sql107', { connect, pin, root: ROOT })).details;
    assert.equal(inspect2.already_applied, true);
    const replay = await executeReleaseProductionApply('sql107', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(replay.code, CODES.UNRELATED_MUTATION);
    const s91 = (await inspectReleaseProduction('sql91', { connect, pin: PIN91, root: ROOT })).details;
    assert.equal(s91.live_definition_sha256, PIN91.intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
