/**
 * SQL 164 (aws/workflows/sql/164_wallet_withdrawal_leg_and_limits.sql) on PostgreSQL 16, through its production tool,
 * after the real SQL 91 and SQL 109, the owner the non-superuser checksops_admin login, with SQL 109's payment schema
 * (helpers/sql109-payment-schema.mjs) plus one transfer-to-bank leg and a tenant_wallet_funding_settings table:
 *
 *   - before SQL 164 the webhook writer answers not_owned for a wallet_withdrawal leg: its status would never update;
 *   - one apply through the production tool reaches the intended fingerprint;
 *   - after it the webhook path (applyProductionMoovTransferWebhook, the real module) writes the withdrawal's status
 *     (completed), a later ACH return (returned, notify, code), a replay (duplicate_event); the existing legs keep
 *     SQL 109's behavior (a funding leg applied, a fee-collection leg still not_owned); every row written carries the
 *     transfer's own tenant;
 *   - the limit columns: NULL or positive only (the CHECKs refuse 0 and negatives), column INSERT and UPDATE for
 *     checksops on exactly these two columns, nothing for authenticated;
 *   - the file is idempotent and the tool refuses a re-apply; SQL 109 still reads applied through SQL 164.
 *
 * Run: node --test aws/tests/sql164-wallet-withdrawal-leg-and-limits-pg.test.mjs (as root the PG helpers run the server
 * as the ubuntu account).
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
import { applyProductionMoovTransferWebhook } from '../functions/api/providers/moov-transfer-webhook.mjs';
import { TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { COLLECT_A, FUND_B, PAYMENT_SCHEMA } from './helpers/sql109-payment-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql164', ROOT);
const PIN109 = loadReleaseProductionPin('sql109', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SQL91_TEXT = fs.readFileSync(path.join(ROOT, loadReleaseProductionPin('sql91', ROOT).filename), 'utf8');
const SQL109_TEXT = fs.readFileSync(path.join(ROOT, PIN109.filename), 'utf8');
const WITHDRAW_A = 'b1000000-0000-4000-8000-0000000000e1';

/** A transfer-to-bank leg and the funding-settings table (as the superuser, before ownership is handed over). */
const EXTRA = `
INSERT INTO public.payment_transfers (id, tenant_id, environment, provider_transfer_id, provider_status, status, idempotency_key, amount_cents, leg_role) VALUES
  ('${WITHDRAW_A}', '${TENANT_A}', 'production', 'mv-withdraw-a', 'pending', 'submitted', 'wallet-withdraw:a', 7500, 'wallet_withdrawal');
CREATE TABLE public.tenant_wallet_funding_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL UNIQUE,
  maximum_single_pull_cents bigint, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_wallet_funding_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.tenant_wallet_funding_settings TO checksops, authenticated;
INSERT INTO public.tenant_wallet_funding_settings (tenant_id) VALUES ('${TENANT_A}'), ('${TENANT_B}');`;

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
  const workstream = 'prod-sql164-pg-test';
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
    one_use_id: `sql164-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-13T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql164-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const quietLog = { warn() {} };
const moovEvent = (eventId, data) => ({ eventID: eventId, type: 'transfer.updated', data });

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
const transfer = async (admin, id) => (await admin.query('SELECT * FROM public.payment_transfers WHERE id = $1', [id])).rows[0];
const events = async (admin, id) => (await admin.query(
  'SELECT tenant_id, previous_status, new_status FROM public.payment_event_log WHERE transfer_id = $1 ORDER BY created_at, id', [id],
)).rows;
/** The caught error of one statement as the owner, or null. */
async function ownerError(connectAs, sql) {
  const c = await connectAs('checksops_admin');
  try {
    await c.query(sql);
    return null;
  } catch (error) {
    return error;
  } finally {
    await c.end();
  }
}

test('PostgreSQL 16: SQL 164 through its production tool; the transfer-to-bank leg\'s status is written back after it and not before; the limits\' CHECKs and column grants', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql164-', 59964, { extra: [PAYMENT_SCHEMA, EXTRA] });
  const { admin, connectAs } = fx;
  try {
    const owner = await connectAs('checksops_admin');
    try {
      await owner.query(SQL91_TEXT);
      await owner.query(SQL109_TEXT);
    } finally {
      await owner.end();
    }
    const hook = (eventId, data) => asWebhook(connectAs, (c) => applyProductionMoovTransferWebhook(
      c, moovEvent(eventId, data), { eventId, log: quietLog },
    ));

    // Before SQL 164: SQL 109's writer does not own the withdrawal leg.
    const early = await hook('evt-w0', { transferID: 'mv-withdraw-a', status: 'completed' });
    assert.equal(early.outcome, 'not_owned');
    assert.equal((await transfer(admin, WITHDRAW_A)).status, 'submitted');
    assert.deepEqual(await events(admin, WITHDRAW_A), []);

    // Apply through the production tool.
    const connect = () => connectAs('checksops_admin');
    const s = (await inspectReleaseProduction('sql164', { connect, pin: PIN, root: ROOT })).details;
    assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
    assert.equal(s.already_applied, false);
    assert.deepEqual(s.predecessors, { sql109: true });
    const pin = authorized(s.live_definition_sha256);
    const applied = await executeReleaseProductionApply('sql164', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);

    // After SQL 164: the withdrawal leg is written back like a funding leg.
    const done = await hook('evt-w1', { transferID: 'mv-withdraw-a', status: 'completed', completedOn: '2026-11-13T15:00:00Z' });
    assert.equal(done.outcome, 'applied');
    assert.equal(done.status, 'completed');
    assert.equal(done.tenant_id, TENANT_A);
    let row = await transfer(admin, WITHDRAW_A);
    assert.equal(row.status, 'completed');
    assert.equal(row.completed_at.toISOString(), '2026-11-13T15:00:00.000Z');
    const bounced = await hook('evt-w2', {
      transferID: 'mv-withdraw-a',
      status: 'completed',
      source: { achDetails: { status: 'returned', return: { code: 'R03', reason: 'No account' } } },
    });
    assert.equal(bounced.outcome, 'applied');
    assert.equal(bounced.status, 'returned');
    assert.equal(bounced.notify, true);
    row = await transfer(admin, WITHDRAW_A);
    assert.equal(row.status, 'returned');
    assert.equal(row.failure_reason, 'ACH return R03: No account');
    const replay = await hook('evt-w2', { transferID: 'mv-withdraw-a', status: 'completed' });
    assert.equal(replay.outcome, 'duplicate_event');
    assert.deepEqual((await events(admin, WITHDRAW_A)).map((e) => [e.tenant_id, e.previous_status, e.new_status]), [
      [TENANT_A, 'submitted', 'completed'],
      [TENANT_A, 'completed', 'returned'],
    ]);

    // SQL 109's legs keep their behavior.
    const fund = await hook('evt-f1', { transferID: 'mv-fund-b', status: 'completed' });
    assert.equal(fund.outcome, 'applied');
    assert.equal((await transfer(admin, FUND_B)).status, 'completed');
    const collect = await hook('evt-c1', { transferID: 'mv-collect-a', status: 'failed' });
    assert.equal(collect.outcome, 'not_owned');
    assert.equal((await transfer(admin, COLLECT_A)).status, 'submitted');

    // The limits: NULL or positive only.
    const table = 'public.tenant_wallet_funding_settings';
    for (const column of ['wallet_withdraw_max_per_transfer_cents', 'wallet_withdraw_max_per_day_cents']) {
      for (const bad of [0, -1]) {
        const error = await ownerError(connectAs, `UPDATE ${table} SET ${column} = ${bad} WHERE tenant_id = '${TENANT_A}'`);
        assert.equal(error?.code, '23514', `${column} = ${bad}`);
      }
      assert.equal(await ownerError(connectAs, `UPDATE ${table} SET ${column} = 250000 WHERE tenant_id = '${TENANT_A}'`), null);
      assert.equal(await ownerError(connectAs, `UPDATE ${table} SET ${column} = NULL WHERE tenant_id = '${TENANT_A}'`), null);
      const privileges = (await admin.query(
        `SELECT has_column_privilege('checksops', $1, $2, 'INSERT') AS ci, has_column_privilege('checksops', $1, $2, 'UPDATE') AS cu,
                has_column_privilege('authenticated', $1, $2, 'UPDATE') AS au, has_column_privilege('authenticated', $1, $2, 'INSERT') AS ai`,
        [table, column],
      )).rows[0];
      assert.deepEqual(privileges, { ci: true, cu: true, au: false, ai: false }, column);
    }
    // The new grants are column grants only: checksops still has no table-wide UPDATE.
    assert.equal((await admin.query("SELECT has_table_privilege('checksops', 'public.tenant_wallet_funding_settings', 'UPDATE') AS u")).rows[0].u, false);

    // Idempotent file; the tool refuses a re-apply; SQL 109 still reads applied through SQL 164.
    const again = await connectAs('checksops_admin');
    try {
      await again.query(TEXT);
    } finally {
      await again.end();
    }
    const inspect2 = (await inspectReleaseProduction('sql164', { connect, pin, root: ROOT })).details;
    assert.equal(inspect2.already_applied, true);
    const reapply = await executeReleaseProductionApply('sql164', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
    assert.deepEqual(inspect2.predecessors, { sql109: true });
  } finally {
    await fx.close();
  }
});
