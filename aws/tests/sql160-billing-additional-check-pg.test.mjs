/**
 * SQL 160 (aws/workflows/sql/160_no_additional_check_mortgage_charge_or_manual_deposit_fee.sql) on PostgreSQL 16.
 * Owner 2026-11-12: no Mortgage Ops charge and no agent pay for an additional check on the same claim; no $4 check fee
 * for a check deposited outside ChecksOps; the $5 mortgage_handling event stops too ("start SQL 160 yes").
 *
 * The pre-state is the four live definitions read by the production billing trigger inspect of 2026-11-12, verbatim
 * (aws/tests/fixtures/sql160-live-billing-functions-2026-11-12.sql). The test proves, before and after SQL 160:
 *   - record_check_billing_event: a check marked deposited after a manual_branch deposit item was charged
 *     check_processing at the tenant rate; after SQL 160 it is not, and a check without one still is;
 *   - accrue_mortgage_ops_billing (via tr_accrue_mortgage_ops_billing): the claim's first accepted request is charged
 *     mortgage_ops_initial 1000 and a second check on the claim mortgage_ops_additional_check 500; after SQL 160 the
 *     first is still 1000 and the second records nothing;
 *   - earn_mortgage_agent_compensation (via tr_earn_mortgage_agent_compensation): the first completed request earns 1000
 *     and an additional check 500; after SQL 160 the additional one earns nothing;
 *   - tg_record_mortgage_handling_billing: the first insurance check entering review records mortgage_handling 1000 and
 *     a second check on the claim 500; after SQL 160 the second records nothing;
 *   - each replaced body is the inspected one with only the SQL 160 lines changed; owner, SECURITY DEFINER, SET options
 *     and EXECUTE grants are kept; the file is re-runnable; prerequisites and an uninspected live body are refused.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL160 = path.join(ROOT, 'aws/workflows/sql/160_no_additional_check_mortgage_charge_or_manual_deposit_fee.sql');
const LIVE = path.join(ROOT, 'aws/tests/fixtures/sql160-live-billing-functions-2026-11-12.sql');
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const FUNCTIONS = ['accrue_mortgage_ops_billing', 'earn_mortgage_agent_compensation', 'record_check_billing_event', 'tg_record_mortgage_handling_billing'];
/** prosrc sha256 of each live body as the production inspect read it (2026-11-12). */
const INSPECTED = Object.freeze({
  accrue_mortgage_ops_billing: 'fc03a9ea7d2a0783f0398309a4500412cbf8fba49801f1eeffc690ca2f727524',
  earn_mortgage_agent_compensation: '6d72d6df8c41c51a2f9cfbd6145dc5cf4f25427ed2af781a925d72c660b31e8b',
  record_check_billing_event: '8319ec76fd6e2704e119429e7b481054dfa9f92b6a9ee52a1a2dda61e710a8a9',
  tg_record_mortgage_handling_billing: 'f022f75ac73f23fdec4a92205466a0b05febdf197642ce7af85110519f2fbe1e',
});

const T = '10000000-0000-4000-8000-000000000001';
const CLAIM = '20000000-0000-4000-8000-000000000001';
const AGENT = '30000000-0000-4000-8000-000000000001';
const id = (prefix, n) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ROLES = `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE authenticated NOLOGIN;
GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin;
`;
// The relations the four functions read and write, owned by the applying login (as in production).
const SCHEMA = `
SET ROLE checksops_admin;
CREATE TYPE public.check_stage AS ENUM ('intake', 'review', 'loss_draft', 'deposited');
CREATE TYPE public.deposit_provider AS ENUM ('checkalt', 'manual_branch');
CREATE TABLE public.tenants (id uuid PRIMARY KEY, per_check_billing_enabled boolean, per_check_rate_cents integer,
  mortgage_ops_initial_rate_cents integer, mortgage_ops_additional_rate_cents integer);
CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, claim_id uuid, status text,
  check_stage public.check_stage, check_source text);
CREATE TABLE public.deposit_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid, provider public.deposit_provider);
CREATE TABLE public.check_billing_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, check_intake_item_id uuid,
  claim_id uuid, mortgage_request_id uuid, event_type text, unit_price_cents integer, currency text, status text,
  billed_at timestamptz, billing_period text, source_kind text, source_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, check_intake_item_id, event_type));
CREATE TABLE public.mortgage_handling_requests (id uuid PRIMARY KEY, tenant_id uuid, claim_id uuid, check_intake_item_id uuid,
  status text, accepted_at timestamptz, completed_at timestamptz, assigned_employee_id uuid);
CREATE TABLE public.mortgage_ops_billing_launch (singleton boolean PRIMARY KEY, launched_at timestamptz);
CREATE TABLE public.mortgage_agent_compensation_rates (singleton boolean PRIMARY KEY, initial_cents integer, additional_cents integer);
CREATE TABLE public.mortgage_agent_compensation_exclusions (mortgage_request_id uuid);
CREATE TABLE public.mortgage_agent_compensation_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_entry_id uuid,
  agent_user_id uuid, mortgage_request_id uuid UNIQUE, check_intake_item_id uuid, claim_id uuid, tenant_id uuid, classification text,
  amount_cents integer, tenant_billing_event_id uuid, tenant_billing_event_type text, tenant_billing_amount_cents integer,
  accepted_at timestamptz, completed_at timestamptz, earned_at timestamptz, pay_period text, status text);
CREATE TABLE public.mortgage_agent_compensation_audit (entry_id uuid, actor_id uuid, action text, from_status text, to_status text, payload jsonb);
CREATE FUNCTION public.aws_check_billing_charges_when_per_check_off() RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE FUNCTION public.aws_check_billing_default_price_cents() RETURNS integer LANGUAGE sql AS 'SELECT 300';
CREATE FUNCTION public.tg_accrue_mortgage_ops_billing() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
BEGIN
  IF NEW.accepted_at IS NULL THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('in_progress', 'completed') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.accepted_at IS NOT NULL AND OLD.status IN ('in_progress', 'completed') THEN RETURN NEW; END IF;
  PERFORM public.accrue_mortgage_ops_billing(NEW.id);
  RETURN NEW;
END $fn$;
CREATE FUNCTION public.tg_earn_mortgage_agent_compensation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET row_security TO 'off' AS $fn$
BEGIN
  IF NEW.status = 'completed' AND NEW.completed_at IS NOT NULL THEN
    BEGIN PERFORM public.earn_mortgage_agent_compensation(NEW.id); EXCEPTION WHEN unique_violation THEN NULL; END;
  END IF;
  RETURN NEW;
END $fn$;
RESET ROLE;
INSERT INTO public.tenants VALUES ('${T}', true, 400, NULL, NULL);
INSERT INTO public.mortgage_ops_billing_launch VALUES (true, '2026-01-01T00:00:00Z');
INSERT INTO public.mortgage_agent_compensation_rates VALUES (true, 1000, 500);
`;
const TRIGGERS = `
SET ROLE checksops_admin;
CREATE TRIGGER trg_record_check_billing_event AFTER UPDATE OF status ON public.check_intake_items FOR EACH ROW EXECUTE FUNCTION public.record_check_billing_event();
CREATE TRIGGER tr_record_mortgage_handling_billing AFTER UPDATE ON public.check_intake_items FOR EACH ROW EXECUTE FUNCTION public.tg_record_mortgage_handling_billing();
CREATE TRIGGER tr_accrue_mortgage_ops_billing AFTER INSERT OR UPDATE ON public.mortgage_handling_requests FOR EACH ROW EXECUTE FUNCTION public.tg_accrue_mortgage_ops_billing();
CREATE TRIGGER tr_earn_mortgage_agent_compensation AFTER UPDATE OF status, completed_at ON public.mortgage_handling_requests FOR EACH ROW EXECUTE FUNCTION public.tg_earn_mortgage_agent_compensation();
GRANT EXECUTE ON FUNCTION public.record_check_billing_event() TO checksops;
GRANT EXECUTE ON FUNCTION public.accrue_mortgage_ops_billing(uuid) TO checksops, authenticated;
REVOKE ALL ON FUNCTION public.earn_mortgage_agent_compensation(uuid) FROM PUBLIC;
RESET ROLE;
`;

/** Runs one scenario on a fresh set of ids (base n): the four charges and the agent pay, then returns them. */
async function scenario(db, n) {
  const c = (k) => id('4', n * 10 + k);
  const r = (k) => id('5', n * 10 + k);
  const claim = id('6', n);
  await db.query(`INSERT INTO public.check_intake_items (id, tenant_id, claim_id, status, check_stage, check_source) VALUES
    ($1, '${T}', $3, 'received', 'intake', 'insurance'), ($2, '${T}', $3, 'received', 'intake', 'insurance'),
    ($4, '${T}', NULL, 'received', 'intake', 'insurance'), ($5, '${T}', NULL, 'received', 'intake', 'insurance')`,
  [c(1), c(2), claim, c(3), c(4)]);
  // Two checks on one claim enter review (mortgage_handling), then each gets a Mortgage Desk request: accepted, completed.
  await db.query(`UPDATE public.check_intake_items SET check_stage = 'review' WHERE id = $1`, [c(1)]);
  await db.query(`UPDATE public.check_intake_items SET check_stage = 'review' WHERE id = $1`, [c(2)]);
  for (const [k, check] of [[1, c(1)], [2, c(2)]]) {
    await db.query(`INSERT INTO public.mortgage_handling_requests (id, tenant_id, claim_id, check_intake_item_id, status) VALUES ($1, '${T}', $2, $3, 'requested')`,
      [r(k), claim, check]);
    await db.query(`UPDATE public.mortgage_handling_requests SET status = 'in_progress', accepted_at = now(), assigned_employee_id = '${AGENT}' WHERE id = $1`, [r(k)]);
    await db.query(`UPDATE public.mortgage_handling_requests SET status = 'completed', completed_at = now() WHERE id = $1`, [r(k)]);
  }
  // A check deposited outside ChecksOps (manual_branch, written before the check becomes deposited) and one deposited otherwise.
  await db.query(`INSERT INTO public.deposit_items (check_id, provider) VALUES ($1, 'manual_branch'), ($2, 'checkalt')`, [c(3), c(4)]);
  await db.query(`UPDATE public.check_intake_items SET status = 'deposited' WHERE id = ANY($1::uuid[])`, [[c(3), c(4)]]);
  const events = (await db.query(`SELECT check_intake_item_id, event_type, unit_price_cents FROM public.check_billing_events
    WHERE check_intake_item_id = ANY($1::uuid[]) ORDER BY event_type, unit_price_cents DESC`, [[c(1), c(2), c(3), c(4)]])).rows;
  const label = { [c(1)]: 'first', [c(2)]: 'additional', [c(3)]: 'manual', [c(4)]: 'checkalt' };
  const pay = (await db.query(`SELECT mortgage_request_id, classification, amount_cents FROM public.mortgage_agent_compensation_entries
    WHERE mortgage_request_id = ANY($1::uuid[]) ORDER BY amount_cents DESC`, [[r(1), r(2)]])).rows;
  return {
    events: events.map((e) => [label[e.check_intake_item_id], e.event_type, e.unit_price_cents]),
    pay: pay.map((p) => [p.mortgage_request_id === r(1) ? 'first' : 'additional', p.classification, p.amount_cents]),
  };
}

test('SQL 160: no Mortgage Ops charge or agent pay for an additional check, no $4 for a manual deposit, from the inspected live bodies (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('sql160-', 55160);
  const connect = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const admin = await connect('ubuntu');
  const clients = [admin];
  try {
    await admin.query(ROLES);
    const fileText = fs.readFileSync(SQL160, 'utf8');
    const owner = await connect('checksops_admin');
    clients.push(owner);

    // Without its prerequisites the file refuses and changes nothing.
    await assert.rejects(owner.query(fileText), /sql160_prerequisite_missing: public\.deposit_items\.check_id/);
    await admin.query(SCHEMA);
    await assert.rejects(owner.query(fileText), /sql160_prerequisite_missing: public\.record_check_billing_event\(\)/);

    // The live pre-state: the four inspected definitions, verbatim; their prosrc hashes are the inspected ones.
    await owner.query(fs.readFileSync(LIVE, 'utf8'));
    await admin.query(TRIGGERS);
    const fns = async () => (await admin.query(`
      SELECT p.proname, r.rolname AS owner, p.prosecdef, p.proconfig, p.prosrc,
             ARRAY(SELECT coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type
                     FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a LEFT JOIN pg_roles g ON g.oid = a.grantee ORDER BY 1) AS acl
        FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1) ORDER BY p.proname`, [FUNCTIONS])).rows;
    const before = await fns();
    assert.deepEqual(Object.fromEntries(before.map((f) => [f.proname, sha(f.prosrc)])), INSPECTED);

    // Today's behaviour (the inspected bodies): every additional-check charge and the manual-deposit $4.
    const today = await scenario(admin, 1);
    assert.deepEqual(today.events, [
      ['manual', 'check_processing', 400],
      ['checkalt', 'check_processing', 400],
      ['first', 'mortgage_handling', 1000],
      ['additional', 'mortgage_handling', 500],
      ['additional', 'mortgage_ops_additional_check', 500],
      ['first', 'mortgage_ops_initial', 1000],
    ]);
    assert.deepEqual(today.pay, [['first', 'initial', 1000], ['additional', 'additional', 500]]);

    // A live body nobody inspected is never replaced.
    await admin.query(`CREATE OR REPLACE FUNCTION public.earn_mortgage_agent_compensation(p_request_id uuid) RETURNS public.mortgage_agent_compensation_entries
      LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET row_security TO 'off' AS $fn$ BEGIN RETURN NULL; END $fn$`);
    await assert.rejects(owner.query(fileText), /sql160_live_body_drift: public\.earn_mortgage_agent_compensation\(uuid\)/);
    await admin.query(`SET ROLE checksops_admin; ${fs.readFileSync(LIVE, 'utf8')} RESET ROLE;`);
    assert.deepEqual(Object.fromEntries((await fns()).map((f) => [f.proname, sha(f.prosrc)])), INSPECTED);

    // Apply SQL 160.
    await owner.query(fileText);
    const after = await fns();
    // Owner, SECURITY DEFINER, SET options and EXECUTE grants are kept; only the bodies changed.
    assert.deepEqual(after.map((f) => [f.proname, f.owner, f.prosecdef, f.proconfig, f.acl]), before.map((f) => [f.proname, f.owner, f.prosecdef, f.proconfig, f.acl]));
    for (const f of after) assert.notEqual(sha(f.prosrc), INSPECTED[f.proname], f.proname);
    // Each new body is the inspected one with only the SQL 160 lines changed.
    const byName = Object.fromEntries(before.map((f) => [f.proname, f.prosrc]));
    for (const f of after) {
      const removed = byName[f.proname].split('\n').filter((line) => !f.prosrc.split('\n').includes(line));
      const added = f.prosrc.split('\n').filter((line) => !byName[f.proname].split('\n').includes(line));
      assert.ok(added.some((line) => /SQL 160/.test(line)), f.proname);
      if (f.proname === 'accrue_mortgage_ops_billing') {
        assert.ok(removed.includes("    v_event_type := 'mortgage_ops_additional_check';"), 'the additional-check branch is gone');
        assert.ok(!f.prosrc.includes("'mortgage_ops_additional_check',\n          v_additional_rate,"), 'no additional-check insert remains');
      } else {
        assert.deepEqual(removed, [], `${f.proname}: lines are only added`);
      }
    }

    // After SQL 160: the first check is still charged 1000 and pays the agent 1000; the additional check records
    // nothing and earns nothing; the manual deposit is not charged; another deposit still is.
    const now = await scenario(admin, 2);
    assert.deepEqual(now.events, [
      ['checkalt', 'check_processing', 400],
      ['first', 'mortgage_handling', 1000],
      ['first', 'mortgage_ops_initial', 1000],
    ]);
    assert.deepEqual(now.pay, [['first', 'initial', 1000]]);

    // Re-runnable: a second run finds SQL 160's own bodies and leaves them as they are.
    const once = Object.fromEntries(after.map((f) => [f.proname, sha(f.prosrc)]));
    await owner.query(fileText);
    assert.deepEqual(Object.fromEntries((await fns()).map((f) => [f.proname, sha(f.prosrc)])), once);
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    server.stop();
  }
});

test('SQL 160 file: four CREATE OR REPLACE, the inspected hashes in its drift guard, no other DDL or data change', () => {
  const text = fs.readFileSync(SQL160, 'utf8');
  const outside = text.replace(/--[^\n]*/g, '').replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.deepEqual([...outside.matchAll(/CREATE OR REPLACE FUNCTION (public\.[a-z_]+)/g)].map((m) => m[1]),
    ['public.record_check_billing_event', 'public.accrue_mortgage_ops_billing', 'public.earn_mortgage_agent_compensation', 'public.tg_record_mortgage_handling_billing']);
  assert.doesNotMatch(outside, /\b(CREATE\s+(TABLE|TRIGGER|POLICY|INDEX|VIEW)|ALTER|DROP|GRANT|REVOKE|INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i);
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 2);
  for (const hash of Object.values(INSPECTED)) assert.ok(text.includes(`'${hash}'`), hash);
  assert.doesNotMatch(outside, /\bBEGIN;|\bCOMMIT;/);
});
