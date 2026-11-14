/**
 * SQL 167 (aws/workflows/sql/167_claim_ledger_relink_check.sql) on PostgreSQL 16: a linked check whose claim number was
 * wrong moves to the existing claim the corrected number names (owner 2026-11-14: "Need to be able to change/correct
 * claim number once edited for ledger to link to existing claim"), before deposit only, with its loss draft file and its
 * signature requests.
 *
 * Fixture: the SQL 88 test's tables (the six claim_id case-trigger tables, check_cases, loss_draft_tracking,
 * check_intake_items with case_id), the real Supabase case migration 20260826125804 / 20260826125833 with main's SQL 87
 * and SQL 88 bodies over it (the case triggers that fire on UPDATE OF claim_id), and main's SQL 41
 * (ocr_claim_number_key and the two auto-link trigger functions, attached as the live trg_auto_link_check_to_claim and
 * trg_auto_link_check_to_claim_upd), plus the columns and tables SQL 167 reads in their production shape
 * (check_stage, deposited_at, updated_at; the global UNIQUE on claims.claim_number; signature_requests
 * .check_intake_item_id; check_audit_log with the identity_accounts actor key and the idempotency UNIQUE;
 * claim_settlements). Everything is owned by the non-superuser checksops_admin login; the function is called as
 * checksops, the API login.
 *
 * Proves: the file refuses without its prerequisites and from a login that cannot reach the relations; it installs one
 * DEFINER function (VOLATILE, search_path public, row_security off, EXECUTE checksops and the owner only); a re-run
 * changes nothing (same oid, same text, same ACL); inspect writes nothing and reports the target, the old claim's other
 * checks, its settlement rows and the rows that would move; relink moves the check, its loss draft and its signature
 * request on the old claim (and nothing else: not the other checks, their rows, a claim-only signature request, the
 * claims rows or the settlement rows) and writes one audit row; refusals: tenant mismatch, deposited (deposited_at or
 * check_stage), voided, returned, unlinked, cross-tenant (another tenant's claim or a legacy claim only another tenant
 * links), ambiguous (two same-tenant claims with one key, a legacy claim linked from two tenants), no_match (never
 * creates), the current claim (unchanged); a concurrent change of the claim or the deposit underneath is seen after the
 * lock (the guard moves only rows still on the claim it read).
 *
 * Run: node --test aws/tests/sql167-claim-ledger-relink-check-pg.test.mjs (needs PostgreSQL 16; as root the PG helpers
 * run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { AWS_ROOT, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { caseRolesSql, CLAIM_B, CLAIM_ORGLESS, CLAIM_ORGLESS_B, TENANT_A, TENANT_B } from './helpers/check-case-sql-pg.mjs';
import { claimIdSchemaSql } from './helpers/claim-id-assign-case-sql-pg.mjs';

const SQL167 = path.join(AWS_ROOT, 'workflows/sql/167_claim_ledger_relink_check.sql');
const SQL88 = path.join(AWS_ROOT, 'workflows/sql/88_claim_id_assign_case_tenant_scope.sql');
const SQL41 = path.join(AWS_ROOT, 'write-path/sql/41_ocr_detected_claim_number.sql');
const OWNER = 'checksops_admin';
const IDENTITY = 'public.claim_ledger_relink_check(uuid, uuid, text, text, uuid)';

const id = (n) => `16700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const CLAIM_WRONG = id(101);
const CLAIM_TARGET = id(102);
const CLAIM_DUP_1 = id(103);
const CLAIM_DUP_2 = id(104);
const CLAIM_SHARED = id(105);
const CLAIM_OTHER_SAME = id(106);
const CHECK = id(201);
const CHECK_SIBLING = id(202);
const CHECK_ON_TARGET = id(203);
const CHECK_DEPOSITED_AT = id(204);
const CHECK_STAGE_DEPOSITED = id(205);
const CHECK_VOIDED = id(206);
const CHECK_RETURNED = id(207);
const CHECK_UNLINKED = id(208);
const CHECK_LEGACY_A = id(209);
const CHECK_SHARED_A = id(210);
const CHECK_SHARED_B = id(211);
const CHECK_B = id(212);
const CHECK_ORGLESS_B = id(213);
const CHECK_RACE = id(214);
const CHECK_TO_LEGACY = id(215);
const LD_CHECK = id(301);
const LD_SIBLING = id(302);
const LD_CHECK_NO_CLAIM = id(303);
const LD_RACE = id(304);
const SR_CHECK = id(401);
const SR_SIBLING = id(402);
const SR_CLAIM_ONLY = id(403);
const SETTLEMENT = id(501);

const EXTRA = `
CREATE TYPE public.check_stage AS ENUM ('intake', 'review', 'endorsing', 'ready_to_deposit', 'deposited', 'voided', 'returned');
ALTER TABLE public.check_intake_items
  ADD COLUMN check_stage public.check_stage,
  ADD COLUMN deposited_at timestamptz,
  ADD COLUMN updated_at timestamptz DEFAULT now();
ALTER TABLE public.claims ADD CONSTRAINT claims_claim_number_key UNIQUE (claim_number);
ALTER TABLE public.signature_requests
  ADD COLUMN check_intake_item_id uuid REFERENCES public.check_intake_items(id) ON DELETE CASCADE;
CREATE TABLE public.identity_accounts (application_user_id uuid PRIMARY KEY);
CREATE TABLE public.check_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_description text,
  event_data jsonb DEFAULT '{}'::jsonb,
  actor_id uuid REFERENCES public.identity_accounts(application_user_id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT clock_timestamp(),
  tenant_id uuid REFERENCES public.tenants(id),
  CONSTRAINT check_audit_log_idempotent_key UNIQUE (check_id, event_type, created_at));
ALTER TABLE public.check_audit_log ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.claim_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  total_settlement numeric);
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loss_draft_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_settlements ENABLE ROW LEVEL SECURITY;
`;

// The live auto-link triggers (aws/db-copy/analysis/triggers_classified.json) over main's SQL 41 functions.
const AUTO_LINK_TRIGGERS = `
CREATE TRIGGER trg_auto_link_check_to_claim BEFORE INSERT OR UPDATE ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.auto_link_check_to_claim();
CREATE TRIGGER trg_auto_link_check_to_claim_upd BEFORE UPDATE ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_auto_link_check_to_claim();
`;

const SEED = `
INSERT INTO public.identity_accounts VALUES ('${ACTOR}');
INSERT INTO public.claims (id, org_id, claim_number, policyholder_name) VALUES
  ('${CLAIM_WRONG}', '${TENANT_A}', 'CLM-A-WRONG', 'Wanda Wrong'),
  ('${CLAIM_TARGET}', '${TENANT_A}', 'CLM-A-2', 'Tara Target'),
  ('${CLAIM_DUP_1}', '${TENANT_A}', 'CLM-A-DUP', 'Dee One'),
  ('${CLAIM_DUP_2}', '${TENANT_A}', ' clm-a-dup ', 'Dee Two'),
  ('${CLAIM_SHARED}', NULL, 'CLM-SHARED', 'Sha Red'),
  ('${CLAIM_OTHER_SAME}', '${TENANT_A}', 'CLM-A-3', 'Otto Same');
INSERT INTO public.check_intake_items (id, tenant_id, claim_id, check_stage, deposited_at, amount) VALUES
  ('${CHECK}', '${TENANT_A}', '${CLAIM_WRONG}', 'review', NULL, 1000),
  ('${CHECK_SIBLING}', '${TENANT_A}', '${CLAIM_WRONG}', 'review', NULL, 200),
  ('${CHECK_ON_TARGET}', '${TENANT_A}', '${CLAIM_TARGET}', 'review', NULL, 300),
  ('${CHECK_DEPOSITED_AT}', '${TENANT_A}', '${CLAIM_WRONG}', 'review', now(), 400),
  ('${CHECK_STAGE_DEPOSITED}', '${TENANT_A}', '${CLAIM_WRONG}', 'deposited', NULL, 401),
  ('${CHECK_VOIDED}', '${TENANT_A}', '${CLAIM_WRONG}', 'voided', NULL, 402),
  ('${CHECK_RETURNED}', '${TENANT_A}', '${CLAIM_WRONG}', 'returned', NULL, 403),
  ('${CHECK_UNLINKED}', '${TENANT_A}', NULL, 'review', NULL, 404),
  ('${CHECK_LEGACY_A}', '${TENANT_A}', '${CLAIM_ORGLESS}', 'review', NULL, 405),
  ('${CHECK_SHARED_A}', '${TENANT_A}', '${CLAIM_SHARED}', 'review', NULL, 406),
  ('${CHECK_SHARED_B}', '${TENANT_B}', '${CLAIM_SHARED}', 'review', NULL, 407),
  ('${CHECK_B}', '${TENANT_B}', '${CLAIM_B}', 'review', NULL, 408),
  ('${CHECK_ORGLESS_B}', '${TENANT_B}', '${CLAIM_ORGLESS_B}', 'review', NULL, 409),
  ('${CHECK_RACE}', '${TENANT_A}', '${CLAIM_WRONG}', 'review', NULL, 410),
  ('${CHECK_TO_LEGACY}', '${TENANT_A}', '${CLAIM_WRONG}', 'review', NULL, 411);
INSERT INTO public.loss_draft_tracking (id, check_intake_item_id, claim_id, mortgage_servicer) VALUES
  ('${LD_CHECK}', '${CHECK}', '${CLAIM_WRONG}', 'Servicer One'),
  ('${LD_SIBLING}', '${CHECK_SIBLING}', '${CLAIM_WRONG}', 'Servicer Two'),
  ('${LD_CHECK_NO_CLAIM}', '${CHECK}', NULL, 'Servicer Three'),
  ('${LD_RACE}', '${CHECK_RACE}', '${CLAIM_WRONG}', 'Servicer Four');
INSERT INTO public.signature_requests (id, check_intake_item_id, claim_id) VALUES
  ('${SR_CHECK}', '${CHECK}', '${CLAIM_WRONG}'),
  ('${SR_SIBLING}', '${CHECK_SIBLING}', '${CLAIM_WRONG}'),
  ('${SR_CLAIM_ONLY}', NULL, '${CLAIM_WRONG}');
INSERT INTO public.claim_settlements (id, claim_id, total_settlement) VALUES ('${SETTLEMENT}', '${CLAIM_WRONG}', 5000);
`;

test('SQL 167: claim_ledger_relink_check moves a not-yet-deposited check, its loss draft and its signature requests to the existing same-tenant claim the corrected number names, and refuses everything else (PostgreSQL 16)', { timeout: 300000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('sql167-', 62670);
  const connect = async (user) => {
    const c = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await c.connect();
    return c;
  };
  const admin = await connect('ubuntu');
  const clients = [admin];
  try {
    await admin.query(caseRolesSql(OWNER));
    await admin.query('CREATE ROLE other_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE, CREATE ON SCHEMA public TO other_admin;');
    const fileText = fs.readFileSync(SQL167, 'utf8');
    const owner = await connect(OWNER);
    clients.push(owner);

    // Without its prerequisites the file refuses and installs nothing.
    await assert.rejects(owner.query(fileText), (error) => {
      assert.equal(error.code, '55000');
      assert.match(error.message, /^sql167_prerequisite_missing: .*missing public\.check_audit_log, public\.check_intake_items, public\.claim_settlements, public\.claims, public\.loss_draft_tracking, public\.ocr_claim_number_key\(text\), public\.signature_requests$/);
      return true;
    });
    await owner.query(claimIdSchemaSql({ withSql87: true }));
    await owner.query(fs.readFileSync(SQL88, 'utf8'));
    await owner.query(EXTRA);
    // A column it reads missing: refused, by name.
    await assert.rejects(owner.query(fileText), /sql167_prerequisite_missing: .*missing public\.ocr_claim_number_key\(text\)$/);
    await owner.query(fs.readFileSync(SQL41, 'utf8'));
    await owner.query(AUTO_LINK_TRIGGERS);
    await owner.query('ALTER TABLE public.check_audit_log RENAME COLUMN event_data TO event_data_moved');
    await assert.rejects(owner.query(fileText), /sql167_prerequisite_missing: .*missing column public\.check_audit_log\.event_data$/);
    await owner.query('ALTER TABLE public.check_audit_log RENAME COLUMN event_data_moved TO event_data');
    await owner.query(SEED);

    // A login that does not own the relations cannot install the DEFINER (row_security off would refuse), nor can the
    // owner while a relation is under FORCE ROW LEVEL SECURITY.
    const other = await connect('other_admin');
    clients.push(other);
    await assert.rejects(other.query(fileText), /sql167_definer_cannot_reach: the login running SQL 167 must own check_audit_log, check_intake_items, claim_settlements, claims, loss_draft_tracking, signature_requests/);
    await owner.query('ALTER TABLE public.signature_requests FORCE ROW LEVEL SECURITY');
    await assert.rejects(owner.query(fileText), /sql167_definer_cannot_reach: .*must own signature_requests \(without FORCE/);
    await owner.query('ALTER TABLE public.signature_requests NO FORCE ROW LEVEL SECURITY');
    assert.equal((await admin.query('SELECT to_regprocedure($1) IS NULL AS absent', [IDENTITY])).rows[0].absent, true);

    await owner.query(fileText);
    const fn = async () => (await admin.query(`
      SELECT p.oid, r.rolname AS owner, p.prosecdef, p.provolatile, p.proconfig, p.prosrc,
             pg_get_function_result(p.oid) AS result,
             ARRAY(SELECT coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type
                     FROM aclexplode(p.proacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee ORDER BY 1) AS acl
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
    const first = await fn();
    assert.deepEqual([first.owner, first.prosecdef, first.provolatile, first.proconfig, first.result, first.acl],
      [OWNER, true, 'v', ['search_path=public', 'row_security=off'], 'jsonb', ['checksops EXECUTE', 'checksops_admin EXECUTE']]);
    // Idempotent: a second run changes nothing.
    await owner.query(fileText);
    assert.deepEqual(await fn(), first);
    // The API roles but checksops cannot call it.
    for (const role of ['authenticated', 'anon', 'service_role']) {
      await assert.rejects(admin.query(`SET ROLE ${role}; SELECT public.claim_ledger_relink_check(NULL, NULL, NULL, NULL, NULL);`), /permission denied for function claim_ledger_relink_check/, role);
      await admin.query('RESET ROLE');
    }

    const api = await connect('checksops');
    clients.push(api);
    const call = async (check, tenant, number, action, actor = ACTOR, client = api) => (await client.query(
      'SELECT public.claim_ledger_relink_check($1::uuid, $2::uuid, $3::text, $4::text, $5::uuid) AS r', [check, tenant, number, action, actor])).rows[0].r;
    // Everything the function must never write: claims, settlements, other checks and their rows (xmin changes on any UPDATE).
    const snapshot = async () => (await admin.query(`
      SELECT (SELECT jsonb_object_agg(id, jsonb_build_object('xmin', xmin::text, 'row', to_jsonb(c))) FROM public.claims c) AS claims,
             (SELECT jsonb_object_agg(id, jsonb_build_object('xmin', xmin::text, 'row', to_jsonb(s))) FROM public.claim_settlements s) AS settlements,
             (SELECT jsonb_object_agg(id, jsonb_build_object('xmin', xmin::text, 'row', to_jsonb(i))) FROM public.check_intake_items i) AS checks,
             (SELECT jsonb_object_agg(id, jsonb_build_object('xmin', xmin::text, 'row', to_jsonb(l))) FROM public.loss_draft_tracking l) AS loss_drafts,
             (SELECT jsonb_object_agg(id, jsonb_build_object('xmin', xmin::text, 'row', to_jsonb(r))) FROM public.signature_requests r) AS signatures,
             (SELECT count(*)::int FROM public.check_audit_log) AS audit,
             (SELECT count(*)::int FROM public.check_cases) AS cases`)).rows[0];
    const without = (map, ids) => Object.fromEntries(Object.entries(map).filter(([key]) => !ids.includes(key)));

    // Arguments.
    const before = await snapshot();
    assert.deepEqual(await call(null, TENANT_A, 'CLM-A-2', 'inspect'), { ok: false, persisted: false, code: 'invalid_args' });
    assert.deepEqual(await call(CHECK, TENANT_A, 'CLM-A-2', 'link_existing'), { ok: false, persisted: false, code: 'invalid_action' });
    assert.deepEqual(await call(CHECK, TENANT_A, '   ', 'relink'), { ok: false, persisted: false, code: 'invalid_args' });
    assert.deepEqual(await call(CHECK, TENANT_A, 'CLM-A-2', 'relink', null), { ok: false, persisted: false, code: 'actor_required' });
    assert.deepEqual(await call(id(999), TENANT_A, 'CLM-A-2', 'relink'), { ok: false, persisted: false, code: 'check_not_found' });

    // Refusals, for inspect and relink alike; nothing written.
    const refused = [
      [CHECK, TENANT_B, 'CLM-A-2', 'tenant_mismatch'],
      [CHECK_DEPOSITED_AT, TENANT_A, 'CLM-A-2', 'locked'],
      [CHECK_STAGE_DEPOSITED, TENANT_A, 'CLM-A-2', 'locked'],
      [CHECK_VOIDED, TENANT_A, 'CLM-A-2', 'locked'],
      [CHECK_RETURNED, TENANT_A, 'CLM-A-2', 'locked'],
      [CHECK_UNLINKED, TENANT_A, 'CLM-A-2', 'not_linked'],
      [CHECK, TENANT_A, 'CLM-B-1', 'cross_tenant'],
      [CHECK, TENANT_A, ' clm-b-1 ', 'cross_tenant'],
      [CHECK, TENANT_A, 'CLM-OB-1', 'cross_tenant'],
      [CHECK, TENANT_A, 'CLM-A-DUP', 'ambiguous'],
      [CHECK, TENANT_A, 'CLM-SHARED', 'ambiguous'],
    ];
    for (const [check, tenant, number, code] of refused) {
      for (const action of ['inspect', 'relink']) {
        assert.deepEqual(await call(check, tenant, number, action), { ok: false, persisted: false, code }, `${action} ${number} ${code}`);
      }
    }
    // No claim with that number: no_match (the caller renames as today); never a claim created.
    assert.deepEqual(await call(CHECK, TENANT_A, 'NOPE-1', 'inspect'), { ok: true, persisted: false, code: 'no_match', claim_id: null, claim_number: 'NOPE-1', check_claim_id: CLAIM_WRONG });
    assert.deepEqual(await call(CHECK, TENANT_A, 'NOPE-1', 'relink'), { ok: false, persisted: false, code: 'no_match', claim_id: null, claim_number: 'NOPE-1', check_claim_id: CLAIM_WRONG });
    // The number of the claim it is already on: unchanged.
    assert.deepEqual(await call(CHECK, TENANT_A, ' clm-a-wrong ', 'relink'), {
      ok: true, persisted: false, code: 'unchanged', claim_id: CLAIM_WRONG, claim_number: 'CLM-A-WRONG', policyholder_name: 'Wanda Wrong', check_claim_id: CLAIM_WRONG });

    // Inspect: the target, the old claim's facts and the rows that would move; nothing written.
    assert.deepEqual(await call(CHECK, TENANT_A, ' clm-a-2 ', 'inspect'), {
      ok: true, persisted: false, code: 'relink_available', can_relink: true,
      claim_id: CLAIM_TARGET, claim_number: 'CLM-A-2', policyholder_name: 'Tara Target', check_claim_id: CLAIM_WRONG,
      old_claim_id: CLAIM_WRONG, old_claim_number: 'CLM-A-WRONG',
      // Same tenant only: CHECK_SIBLING, the four locked checks, CHECK_RACE and CHECK_TO_LEGACY.
      old_claim_other_check_count: 7, old_claim_has_settlements: true,
      loss_draft_rows_to_move: 1, signature_request_rows_to_move: 1,
    });
    assert.deepEqual(await snapshot(), before, 'refusals and inspect write nothing');

    // Relink: the check, its loss draft and its signature request on the old claim move; nothing else.
    const caseIds = async () => (await admin.query(`
      SELECT (SELECT case_id FROM public.check_intake_items WHERE id = $1) AS check_case,
             (SELECT case_id FROM public.loss_draft_tracking WHERE id = $2) AS ld_case,
             (SELECT case_id FROM public.signature_requests WHERE id = $3) AS sr_case`, [CHECK, LD_CHECK, SR_CHECK])).rows[0];
    const casesBefore = await caseIds();
    const relinked = await call(CHECK, TENANT_A, 'CLM-A-2', 'relink');
    assert.deepEqual(relinked, {
      ok: true, persisted: true, code: 'relinked',
      claim_id: CLAIM_TARGET, claim_number: 'CLM-A-2', policyholder_name: 'Tara Target', check_claim_id: CLAIM_TARGET,
      old_claim_id: CLAIM_WRONG, old_claim_number: 'CLM-A-WRONG',
      old_claim_remaining_check_count: 7, old_claim_has_settlements: true,
      loss_draft_rows_moved: 1, signature_request_rows_moved: 1,
    });
    const after = await snapshot();
    assert.equal(after.checks[CHECK].row.claim_id, CLAIM_TARGET);
    assert.equal(after.loss_drafts[LD_CHECK].row.claim_id, CLAIM_TARGET);
    assert.equal(after.signatures[SR_CHECK].row.claim_id, CLAIM_TARGET);
    // This check's loss draft with no claim stays as it was (only rows on the old claim move).
    assert.deepEqual(after.loss_drafts[LD_CHECK_NO_CLAIM], before.loss_drafts[LD_CHECK_NO_CLAIM]);
    // Never the claims rows, the settlement rows, another check or another check's rows, or a claim-only request.
    assert.deepEqual(after.claims, before.claims);
    assert.deepEqual(after.settlements, before.settlements);
    assert.deepEqual(without(after.checks, [CHECK]), without(before.checks, [CHECK]));
    assert.deepEqual(without(after.loss_drafts, [LD_CHECK]), without(before.loss_drafts, [LD_CHECK]));
    assert.deepEqual(without(after.signatures, [SR_CHECK]), without(before.signatures, [SR_CHECK]));
    assert.equal(after.signatures[SR_CLAIM_ONLY].row.claim_id, CLAIM_WRONG);
    // The case triggers (SQL 87 / SQL 88 over the Supabase migration) act only on a NULL case_id: the case links stay as
    // they were, and no case is created.
    assert.deepEqual(await caseIds(), casesBefore);
    assert.equal(after.cases, before.cases);
    // One audit row in the existing shape.
    const audit = (await admin.query('SELECT check_id, tenant_id, actor_id, event_type, event_description, event_data FROM public.check_audit_log')).rows;
    assert.deepEqual(audit, [{
      check_id: CHECK, tenant_id: TENANT_A, actor_id: ACTOR, event_type: 'claim_relinked',
      event_description: 'Claim number corrected: check moved from claim CLM-A-WRONG to claim CLM-A-2',
      event_data: {
        previous_claim_id: CLAIM_WRONG, previous_claim_number: 'CLM-A-WRONG', new_claim_id: CLAIM_TARGET, new_claim_number: 'CLM-A-2',
        claim_number_entered: 'CLM-A-2', loss_draft_rows_moved: 1, signature_request_rows_moved: 1, source: 'claim_ledger_relink_check' },
    }]);
    // Again: the check is now on that claim, so unchanged and nothing written.
    assert.equal((await call(CHECK, TENANT_A, 'CLM-A-2', 'relink')).code, 'unchanged');
    assert.deepEqual(await snapshot(), after);
    // And back to the other existing same-tenant claim: the rows that moved move again; the new audit row says so.
    assert.equal((await call(CHECK, TENANT_A, 'CLM-A-3', 'relink')).old_claim_id, CLAIM_TARGET);
    assert.equal((await snapshot()).loss_drafts[LD_CHECK].row.claim_id, CLAIM_OTHER_SAME);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.check_audit_log')).rows[0].n, 2);

    // A legacy claim with no org_id that only this tenant's checks link is this tenant's (SQL 44's rule); its org_id stays NULL.
    const legacy = await call(CHECK_TO_LEGACY, TENANT_A, 'CLM-O-1', 'relink');
    assert.equal(legacy.code, 'relinked');
    assert.equal(legacy.claim_id, CLAIM_ORGLESS);
    assert.equal((await admin.query('SELECT org_id FROM public.claims WHERE id = $1', [CLAIM_ORGLESS])).rows[0].org_id, null);

    // Concurrency: the claim changed underneath while the relink waited on the row lock. The relink reads the
    // committed claim after the lock and moves only rows still on that claim (LD_RACE stays on CLAIM_WRONG).
    const racer = await connect(OWNER);
    clients.push(racer);
    await racer.query('BEGIN');
    await racer.query('UPDATE public.check_intake_items SET claim_id = $2 WHERE id = $1', [CHECK_RACE, CLAIM_OTHER_SAME]);
    const waitingApi = await connect('checksops');
    clients.push(waitingApi);
    const pending = call(CHECK_RACE, TENANT_A, 'CLM-A-2', 'relink', ACTOR, waitingApi);
    const waitForLock = async () => {
      for (let i = 0; i < 100; i += 1) {
        const n = (await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'checksops' AND wait_event_type = 'Lock'")).rows[0].n;
        if (n > 0) return;
        await delay(50);
      }
      assert.fail('the relink never waited on the row lock');
    };
    await waitForLock();
    await racer.query('COMMIT');
    const raced = await pending;
    assert.equal(raced.code, 'relinked');
    assert.equal(raced.old_claim_id, CLAIM_OTHER_SAME);
    assert.equal(raced.loss_draft_rows_moved, 0);
    assert.equal((await admin.query('SELECT claim_id FROM public.loss_draft_tracking WHERE id = $1', [LD_RACE])).rows[0].claim_id, CLAIM_WRONG);
    // The deposit recorded underneath: the relink sees it after the lock and refuses.
    await racer.query('BEGIN');
    await racer.query('UPDATE public.check_intake_items SET deposited_at = now() WHERE id = $1', [CHECK_RACE]);
    const lockedPending = call(CHECK_RACE, TENANT_A, 'CLM-A-3', 'relink', ACTOR, waitingApi);
    await waitForLock();
    await racer.query('COMMIT');
    assert.deepEqual(await lockedPending, { ok: false, persisted: false, code: 'locked' });
    assert.equal((await admin.query('SELECT claim_id FROM public.check_intake_items WHERE id = $1', [CHECK_RACE])).rows[0].claim_id, CLAIM_TARGET);

    // Never a claims row created, renamed or deleted along the way.
    assert.deepEqual((await admin.query('SELECT id, org_id, claim_number FROM public.claims ORDER BY id')).rows.map((r) => r.id),
      Object.keys(before.claims).sort());
    assert.deepEqual(Object.fromEntries((await admin.query('SELECT id, claim_number FROM public.claims')).rows.map((r) => [r.id, r.claim_number])),
      Object.fromEntries(Object.entries(before.claims).map(([key, value]) => [key, value.row.claim_number])));
  } finally {
    for (const c of clients.reverse()) await c.end().catch(() => {});
    server.stop();
  }
});
