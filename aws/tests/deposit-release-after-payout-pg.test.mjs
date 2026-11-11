/**
 * Deposit after payout (owner, 2026-11-11): a check that money already went out of, then marked deposited, lands in
 * Funds Released, not Deposited. RELEASE_AFTER_DEPOSIT_SQL (aws/functions/api/workflow-rpc.mjs), run through
 * releaseIfPaidOut as the API login (checksops, no superuser) on PostgreSQL 16, inside the deposit's own transaction.
 *
 * The rule must be the database's own: recompute_check_release_stage (supabase/migrations/...184659, verbatim) is
 * loaded, and for every case the release step's result is compared with what that function decides for an identical
 * check.
 *
 * Proves: a check with a settled payout and nothing pending moves to funds_released, with its claim_checks rows; a
 * check with no payout, a payout still pending, or only failed payouts stays deposited; a check already released is
 * left alone; when the login cannot update claim_checks the step is skipped, the transaction stays usable and the
 * deposit itself stands as deposited.
 *
 * Run: node --test aws/tests/deposit-release-after-payout-pg.test.mjs (needs PostgreSQL 16; as root the PG helpers
 * run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RELEASE_AFTER_DEPOSIT_SQL, releaseIfPaidOut } from '../functions/api/workflow-rpc.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { sliceFrom } from './helpers/sql145-collection-leg-schema.mjs';

const RECOMPUTE = sliceFrom('supabase/migrations/20260803184659_6c94c093-9fa2-433e-83cb-7db3f0c49cb8.sql',
  'CREATE OR REPLACE FUNCTION public.recompute_check_release_stage(_check_id uuid)', '$$;');

const T = '11111111-1111-4111-8111-111111111111';
const USER = 'a1000000-0000-4000-8000-000000000001';

const SCHEMA = `
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE no_claim_checks LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO checksops, no_claim_checks;
CREATE TYPE public.check_stage AS ENUM ('review', 'loss_draft', 'endorsing', 'ready_for_deposit', 'deposited',
  'funds_released', 'disbursed_externally', 'returned');
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, amount numeric, status text,
  check_stage public.check_stage, updated_at timestamptz DEFAULT now());
CREATE TABLE public.claim_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, check_stage public.check_stage,
  updated_at timestamptz DEFAULT now());
CREATE TABLE public.disbursement_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid,
  created_by uuid NOT NULL, status text NOT NULL DEFAULT 'pending');
CREATE TABLE public.disbursement_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL REFERENCES public.disbursement_batches(id),
  tenant_id uuid NOT NULL, amount numeric NOT NULL, status text NOT NULL DEFAULT 'pending');
${RECOMPUTE}
GRANT SELECT ON public.disbursement_batches, public.disbursement_splits TO checksops, no_claim_checks;
GRANT SELECT, UPDATE ON public.check_intake_items TO checksops, no_claim_checks;
GRANT SELECT, UPDATE ON public.claim_checks TO checksops;
`;

// name -> split statuses on the check (null = no payout batch at all)
const CASES = {
  settled: { splits: ['settled'], released: true },
  external_check: { splits: ['completed', 'paid'], released: true },
  settled_and_failed: { splits: ['settled', 'failed'], released: true },
  none: { splits: null, released: false },
  pending: { splits: ['settled', 'pending'], released: false },
  only_failed: { splits: ['failed', 'returned'], released: false },
};

const idFor = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('marking a paid-out check deposited moves it to Funds Released by the database\'s own rule (PostgreSQL 16)', { timeout: 120000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('deposit-release-', 64100);
  const connect = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const admin = await connect('ubuntu');
  try {
    await admin.query(SCHEMA);
    let n = 0;
    const seed = async (splits, stage = 'deposited') => {
      const id = idFor(++n);
      await admin.query(`INSERT INTO public.check_intake_items (id, tenant_id, amount, status, check_stage)
        VALUES ($1, $2, 1000, 'deposited', $3)`, [id, T, stage]);
      await admin.query('INSERT INTO public.claim_checks (check_intake_item_id, check_stage) VALUES ($1, $2), ($1, $2)', [id, stage]);
      if (splits) {
        const b = (await admin.query(`INSERT INTO public.disbursement_batches (tenant_id, check_intake_item_id, created_by, status)
          VALUES ($1, $2, $3, 'completed') RETURNING id`, [T, id, USER])).rows[0].id;
        for (const s of splits) {
          await admin.query('INSERT INTO public.disbursement_splits (batch_id, tenant_id, amount, status) VALUES ($1, $2, 10, $3)', [b, T, s]);
        }
      }
      return id;
    };
    const stages = async (id) => ({
      check: (await admin.query('SELECT check_stage::text AS s FROM public.check_intake_items WHERE id = $1', [id])).rows[0].s,
      claim: (await admin.query('SELECT array_agg(DISTINCT check_stage::text) AS s FROM public.claim_checks WHERE check_intake_item_id = $1', [id])).rows[0].s,
    });

    const api = await connect('checksops');
    try {
      for (const [name, c] of Object.entries(CASES)) {
        const viaDeposit = await seed(c.splits);
        const viaRecompute = await seed(c.splits);
        await api.query('BEGIN');
        const moved = await releaseIfPaidOut(api, viaDeposit);
        await api.query('COMMIT');
        assert.equal(moved, c.released, `${name}: reported`);
        const after = await stages(viaDeposit);
        const want = c.released ? 'funds_released' : 'deposited';
        assert.equal(after.check, want, `${name}: check stage`);
        assert.deepEqual(after.claim, [want], `${name}: claim_checks stage`);
        // Same decision as the database's own release rule.
        await admin.query('SELECT public.recompute_check_release_stage($1)', [viaRecompute]);
        assert.equal((await stages(viaRecompute)).check, after.check, `${name}: agrees with recompute_check_release_stage`);
      }

      // Already released: left alone, reported as not moved, nothing rewritten.
      const released = await seed(['settled'], 'funds_released');
      const before = (await admin.query('SELECT updated_at FROM public.check_intake_items WHERE id = $1', [released])).rows[0].updated_at;
      await api.query('BEGIN');
      assert.equal(await releaseIfPaidOut(api, released), false);
      await api.query('COMMIT');
      assert.equal((await stages(released)).check, 'funds_released');
      assert.deepEqual((await admin.query('SELECT updated_at FROM public.check_intake_items WHERE id = $1', [released])).rows[0].updated_at, before);

      // Each statement alone: the check UPDATE touches check_intake_items only (the SQL 89 column grants cover it).
      await api.query('BEGIN');
      const fresh = await seed(['settled']);
      assert.deepEqual((await api.query(RELEASE_AFTER_DEPOSIT_SQL.payouts, [fresh])).rows[0], { paid: 1, outstanding: 0 });
      assert.equal((await api.query(RELEASE_AFTER_DEPOSIT_SQL.check, [fresh])).rowCount, 1);
      assert.equal((await api.query(RELEASE_AFTER_DEPOSIT_SQL.claimChecks, [fresh])).rowCount, 2);
      await api.query('ROLLBACK');
    } finally {
      await api.end();
    }

    // A login that cannot update claim_checks: the step is skipped, the deposit write in the same transaction stands.
    const limited = await connect('no_claim_checks');
    const warn = console.warn;
    const warnings = [];
    console.warn = (line) => warnings.push(line);
    try {
      const id = await seed(['settled'], 'ready_for_deposit');
      await limited.query('BEGIN');
      await limited.query(`UPDATE public.check_intake_items SET status = 'deposited', check_stage = 'deposited' WHERE id = $1`, [id]);
      assert.equal(await releaseIfPaidOut(limited, id), false);
      await limited.query('SELECT 1'); // transaction still usable
      await limited.query('COMMIT');
      assert.equal((await stages(id)).check, 'deposited');
      assert.equal(warnings.length, 1);
      assert.deepEqual(JSON.parse(warnings[0]), { event: 'deposit_release_after_payout_skipped', code: '42501' });
    } finally {
      console.warn = warn;
      await limited.end();
    }
  } finally {
    await admin.end();
    server.stop();
  }
});
