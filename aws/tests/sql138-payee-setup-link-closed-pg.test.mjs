/**
 * SQL 138 (aws/workflows/sql/138_payee_setup_link_closed_after_verification.sql) on PostgreSQL 16,
 * through its production tool, from the payee tables (helpers/sql113-payee-schema.mjs) with SQL 113
 * applied by the owner, the non-superuser checksops_admin login; the payee functions called as checksops
 * (the API login) exactly as aws/functions/api/providers/payees/handlers.mjs calls them:
 *
 *   - the finding, before SQL 138: a verified payee's old link still records bank_linked, which
 *     disconnects the verified bank's payment_provider_methods row and connects another;
 *   - one apply reaches the intended fingerprint; the function keeps its owner, SECURITY DEFINER,
 *     search_path and EXECUTE ACL (checksops and the owner; not PUBLIC, anon or authenticated);
 *   - setup works end to end for an unverified payee: terms, identity, bank linked, bank replaced while
 *     unverified, bank verified, Moov's verdict verified, the stakeholder payable;
 *   - after verification the old link is refused for every write event (bank_linked with a new bank,
 *     the same bank, tos_accepted, identity_submitted, bank_verified, an unknown event; also once the
 *     link has expired): already_verified, and nothing is written (the payee row, its stakeholder row,
 *     every payment_provider_methods row and the attempt counter as they were); reads still return
 *     (aws_public_payee_by_token: the verified state, so the page shows "You're all set");
 *     aws_payee_reissue_link still refuses a verified payee;
 *   - an unverified payee: the not_found, expired and disconnected answers as before; the tenant's
 *     reissue replaces the token, the old link is refused for read and write (not_found), the fresh link
 *     reads and records;
 *   - a concurrent verdict: a bank_linked that waited on aws_payee_apply_status('verified') sees
 *     verified_at and is refused;
 *   - the file run again is a no-op and the tool refuses a re-apply as already in place;
 *   - preconditions fail closed: a missing column (55000 sql138_prerequisite_missing) and a function
 *     owned by another role (55000 sql138_function_not_owned), nothing changed.
 *
 * Run: node --test aws/tests/sql138-payee-setup-link-closed-pg.test.mjs (as root the PG helpers run the
 * server as the ubuntu account).
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
import { releaseFunctionDefinitions } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { PAYEE_BY_TOKEN_SQL, PAYEE_RECORD_SQL } from '../../aws/functions/api/providers/payees/handlers.mjs';
import { MEMBER_A, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { METHODS, PAYEE_SCHEMA, RECIPIENTS, STAKEHOLDERS } from './helpers/sql113-payee-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql138';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SQL113 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/113_payee_setup.sql'), 'utf8');
const IDENTITY = 'public.aws_public_payee_record(text, text, jsonb)';
/** The pre-state derived from SQL 113's bytes (aws/tests/release-sql138-executor.test.mjs). */
const PRE = 'ec36c29e3472a9777b4a1d08ff7c3da5c00b1dc70cb4b754ef5b04ff0e73633c';

const RID_V = 'e1380000-0000-4000-8000-000000000001'; // set up and verified after SQL 138
const RID_U = 'e1380000-0000-4000-8000-000000000002'; // stays unverified (reissue)
const RID_OLD = 'e1380000-0000-4000-8000-000000000003'; // verified before SQL 138 (the finding)
const RID_C = 'e1380000-0000-4000-8000-000000000004'; // concurrent verdict
const token = (c) => `tok_${c.repeat(40)}`;
const BANK = { provider_bank_account_id: 'bank-1380-aaaa', bank_name: 'First Bank', last_four: '6789', account_type: 'checking', holder_name: 'Jane Payee' };
const ATTACKER = { provider_bank_account_id: 'bank-evil-9999', bank_name: 'Other Bank', last_four: '9999', account_type: 'checking', holder_name: 'Someone Else' };

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
  const workstream = 'prod-sql138-pg-test';
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
    one_use_id: `sql138-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-31T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql138-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

/** One statement as the API login (checksops) in its own transaction, committed. */
async function asApi(connectAs, user, run) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    if (user) await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    const value = await run(c);
    await c.query('COMMIT');
    return value;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await c.end();
  }
}
const fnCall = (connectAs, user, sql, params) => asApi(connectAs, user, async (c) => (await c.query(`SELECT ${sql} AS r`, params)).rows[0].r);
// The public calls exactly as the API makes them (handlers.mjs PAYEE_BY_TOKEN_SQL / PAYEE_RECORD_SQL).
const byToken = (connectAs, tok) => asApi(connectAs, null, async (c) => (await c.query(PAYEE_BY_TOKEN_SQL, [tok])).rows[0].result);
const record = (connectAs, tok, event, data = {}) => asApi(connectAs, null, async (c) => (await c.query(PAYEE_RECORD_SQL, [tok, event, JSON.stringify(data)])).rows[0].result);
const create = (connectAs, id, acct, tok) => fnCall(connectAs, MEMBER_A,
  "public.aws_payee_create($1::uuid, $2::uuid, $3, $4, 'individual', 'homeowner', 'sandbox', $5, $6, now() + interval '7 days', NULL, NULL)",
  [id, TENANT_A, 'Jane Payee', `${acct}@example.com`, acct, tok]);
const applyStatus = (connectAs, acct, status) => fnCall(connectAs, null, "public.aws_payee_apply_status('sandbox', $1, $2)", [acct, status]);
const reissue = (connectAs, id, tok) => fnCall(connectAs, MEMBER_A, "public.aws_payee_reissue_link($1::uuid, $2, now() + interval '7 days')", [id, tok]);

/** A payee through every step to Moov's verdict verified. */
async function setUpAndVerify(connectAs, id, acct, tok, bank = BANK) {
  assert.equal((await create(connectAs, id, acct, tok)).ok, true);
  assert.equal((await record(connectAs, tok, 'tos_accepted')).onboarding_status, 'tos_accepted');
  assert.equal((await record(connectAs, tok, 'identity_submitted')).onboarding_status, 'identity_submitted');
  assert.equal((await record(connectAs, tok, 'bank_linked', bank)).onboarding_status, 'bank_linked');
  assert.equal((await record(connectAs, tok, 'bank_verified', { provider_bank_account_id: bank.provider_bank_account_id })).onboarding_status, 'bank_verified');
  assert.equal((await applyStatus(connectAs, acct, 'verified')).status, 'verified');
}

test('PostgreSQL 16: SQL 138 through its production tool: a verified payee\'s setup link records nothing; reads, unverified setup and reissue unchanged', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql138-prod-', 61390, { extra: [PAYEE_SCHEMA] });
  const { admin, connectAs } = fx;
  try {
    const connect = () => connectAs('checksops_admin');
    const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
    const asOwner = async (sql) => {
      const owner = await connectAs('checksops_admin');
      try { await owner.query(sql); } finally { await owner.end(); }
    };
    const body = async () => (await row('SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure', [IDENTITY])).prosrc;
    /** Every row a refused call must leave as it was. */
    const snapshot = async (id) => ({
      recipient: await row(`SELECT * FROM ${RECIPIENTS} WHERE id = $1`, [id]),
      stakeholder: await row(`SELECT s.* FROM ${STAKEHOLDERS} s JOIN ${RECIPIENTS} r ON r.stakeholder_account_id = s.id WHERE r.id = $1`, [id]),
      methods: (await admin.query(`SELECT * FROM ${METHODS} ORDER BY provider_bank_account_id`)).rows,
    });
    const funcAcl = async () => row(`SELECT has_function_privilege('checksops', $1::regprocedure, 'EXECUTE') AS api,
      has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated,
      EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure AND a.grantee = 0) AS public_grant,
      (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure) AS owner,
      (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure) AS secdef,
      (SELECT p.proconfig FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure) AS config`, [IDENTITY]);

    await asOwner(SQL113);
    assert.equal(await body(), releaseFunctionDefinitions(SQL113).aws_public_payee_record.prosrc);

    // The finding, under SQL 113 alone: after verification the old link still swaps the bank.
    const T_OLD = token('o');
    await setUpAndVerify(connectAs, RID_OLD, 'moov-acct-1380-old0', T_OLD, { ...BANK, provider_bank_account_id: 'bank-1380-old0' });
    const swapped = await record(connectAs, T_OLD, 'bank_linked', ATTACKER);
    assert.equal(swapped.ok, true, JSON.stringify(swapped));
    assert.equal(swapped.provider_bank_account_id, ATTACKER.provider_bank_account_id);
    assert.equal(swapped.onboarding_status, 'verified', 'SQL 113 keeps the payee verified');
    assert.deepEqual((await admin.query(`SELECT provider_bank_account_id, connection_status FROM ${METHODS} WHERE external_recipient_id = $1 ORDER BY 1`, [RID_OLD])).rows, [
      { provider_bank_account_id: 'bank-1380-old0', connection_status: 'disconnected' },
      { provider_bank_account_id: ATTACKER.provider_bank_account_id, connection_status: 'connected' },
    ]);

    // One apply through the production tool, from the derived pre-state.
    const aclBefore = await funcAcl();
    assert.deepEqual(aclBefore, { api: true, anon: false, authenticated: false, public_grant: false, owner: 'checksops_admin', secdef: true, config: ['search_path=public'] });
    const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
    assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
    assert.equal(s.already_applied, false);
    assert.equal(s.live_definition_sha256, PRE);
    const pin = authorized(s.live_definition_sha256);
    const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRE);
    assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
    assert.equal(await body(), releaseFunctionDefinitions(TEXT).aws_public_payee_record.prosrc);
    assert.deepEqual(await funcAcl(), aclBefore);
    assert.match((await row('SELECT pg_catalog.obj_description($1::regprocedure, \'pg_proc\') AS c', [IDENTITY])).c, /^SQL 113, SQL 138: .*already_verified/);

    // The payee verified before SQL 138 is now closed too (verified_at is what counts).
    assert.deepEqual(await record(connectAs, T_OLD, 'bank_linked', BANK), { error: 'already_verified' });

    // Setup works end to end for a new, unverified payee, including replacing a bank not yet verified.
    const TV = token('v');
    assert.equal((await create(connectAs, RID_V, 'moov-acct-1380-vvvv', TV)).ok, true);
    assert.equal((await record(connectAs, TV, 'tos_accepted')).onboarding_status, 'tos_accepted');
    assert.equal((await record(connectAs, TV, 'identity_submitted')).onboarding_status, 'identity_submitted');
    assert.equal((await record(connectAs, TV, 'bank_linked', { ...BANK, provider_bank_account_id: 'bank-1380-first' })).onboarding_status, 'bank_linked');
    const replaced = await record(connectAs, TV, 'bank_linked', BANK);
    assert.equal(replaced.provider_bank_account_id, BANK.provider_bank_account_id, 'an unverified payee can still replace the bank');
    assert.deepEqual((await admin.query(`SELECT provider_bank_account_id, connection_status FROM ${METHODS} WHERE external_recipient_id = $1 ORDER BY 1`, [RID_V])).rows, [
      { provider_bank_account_id: BANK.provider_bank_account_id, connection_status: 'connected' },
      { provider_bank_account_id: 'bank-1380-first', connection_status: 'disconnected' },
    ]);
    assert.equal((await record(connectAs, TV, 'bank_verified', { provider_bank_account_id: BANK.provider_bank_account_id })).onboarding_status, 'bank_verified');
    assert.equal((await applyStatus(connectAs, 'moov-acct-1380-vvvv', 'verified')).status, 'verified');
    const sv = await row(`SELECT s.verification_status, s.provider_bank_account_id FROM ${STAKEHOLDERS} s JOIN ${RECIPIENTS} r ON r.stakeholder_account_id = s.id WHERE r.id = $1`, [RID_V]);
    assert.deepEqual(sv, { verification_status: 'verified', provider_bank_account_id: BANK.provider_bank_account_id });

    // After verification: every write event through the old link is refused, and nothing is written.
    const before = await snapshot(RID_V);
    assert.ok(before.recipient.verified_at);
    for (const [event, data] of [
      ['bank_linked', ATTACKER], ['BANK_LINKED', ATTACKER], ['bank_linked', BANK], ['tos_accepted', {}], ['identity_submitted', {}],
      ['bank_verified', { provider_bank_account_id: BANK.provider_bank_account_id }], ['bank_verified', { provider_bank_account_id: ATTACKER.provider_bank_account_id }],
      ['delete_everything', {}], ['', {}],
    ]) {
      assert.deepEqual(await record(connectAs, `  ${TV}  `, event, data), { error: 'already_verified' }, `${event} ${JSON.stringify(data)}`);
    }
    assert.deepEqual(await snapshot(RID_V), before, 'the payee, its stakeholder and every bank row are as they were');
    assert.equal(before.methods.filter((m) => m.provider_bank_account_id === ATTACKER.provider_bank_account_id).length, 1, 'only the pre-SQL 138 swap of the other payee');
    // Reads still return: the payee's verified state ("You're all set").
    const view = await byToken(connectAs, TV);
    assert.equal(view.ok, true);
    assert.equal(view.recipient_id, RID_V);
    assert.ok(view.verified_at);
    assert.equal(view.onboarding_status, 'verified');
    assert.equal(view.provider_bank_account_id, BANK.provider_bank_account_id);
    assert.equal(view.setup_attempts, before.recipient.setup_attempts, 'refused calls do not count');
    // The tenant cannot issue a fresh link for a verified payee (unchanged).
    assert.deepEqual(await reissue(connectAs, RID_V, token('w')), { error: 'already_verified' });
    // Once the link has expired the verified answer still comes first, and nothing is written.
    await admin.query(`UPDATE ${RECIPIENTS} SET token_expires_at = now() - interval '1 minute' WHERE id = $1`, [RID_V]);
    assert.deepEqual(await record(connectAs, TV, 'bank_linked', ATTACKER), { error: 'already_verified' });
    assert.deepEqual((await snapshot(RID_V)).methods, before.methods);
    assert.deepEqual(await byToken(connectAs, TV), { error: 'expired' });

    // An unverified payee: the old answers, then the tenant's reissue closes the old link for read and write.
    const TU = token('u');
    const TU2 = token('x');
    assert.equal((await create(connectAs, RID_U, 'moov-acct-1380-uuuu', TU)).ok, true);
    assert.deepEqual(await record(connectAs, token('z'), 'tos_accepted'), { error: 'not_found' });
    assert.deepEqual(await record(connectAs, 'short', 'tos_accepted'), { error: 'not_found' });
    assert.equal((await record(connectAs, TU, 'tos_accepted')).onboarding_status, 'tos_accepted');
    await admin.query(`UPDATE ${RECIPIENTS} SET token_expires_at = now() - interval '1 minute' WHERE id = $1`, [RID_U]);
    assert.deepEqual(await record(connectAs, TU, 'identity_submitted'), { error: 'expired' });
    assert.deepEqual(await reissue(connectAs, RID_U, TU2), { ok: true, recipient_id: RID_U, email: 'moov-acct-1380-uuuu@example.com', display_name: 'Jane Payee', tenant_id: TENANT_A });
    assert.deepEqual(await byToken(connectAs, TU), { error: 'not_found' });
    assert.deepEqual(await record(connectAs, TU, 'bank_linked', ATTACKER), { error: 'not_found' });
    const freshView = await byToken(connectAs, TU2);
    assert.equal(freshView.ok, true);
    assert.equal(freshView.setup_attempts, 0);
    assert.equal((await record(connectAs, TU2, 'identity_submitted')).onboarding_status, 'identity_submitted');
    assert.equal((await record(connectAs, TU2, 'bank_linked', { ...BANK, provider_bank_account_id: 'bank-1380-uuuu' })).onboarding_status, 'bank_linked');
    await admin.query(`UPDATE ${RECIPIENTS} SET disconnected_at = now() WHERE id = $1`, [RID_U]);
    assert.deepEqual(await record(connectAs, TU2, 'bank_linked', ATTACKER), { error: 'disconnected' });
    await admin.query(`UPDATE ${RECIPIENTS} SET disconnected_at = NULL WHERE id = $1`, [RID_U]);

    // A concurrent verdict: a bank_linked that waits on aws_payee_apply_status('verified') sees verified_at.
    const TC = token('c');
    assert.equal((await create(connectAs, RID_C, 'moov-acct-1380-cccc', TC)).ok, true);
    for (const [event, data] of [['tos_accepted', {}], ['identity_submitted', {}], ['bank_linked', { ...BANK, provider_bank_account_id: 'bank-1380-cccc' }], ['bank_verified', { provider_bank_account_id: 'bank-1380-cccc' }]]) {
      assert.equal((await record(connectAs, TC, event, data)).ok, true, event);
    }
    const verdict = await connectAs('checksops');
    const writer = await connectAs('checksops');
    try {
      await verdict.query('BEGIN');
      assert.equal((await verdict.query("SELECT public.aws_payee_apply_status('sandbox', 'moov-acct-1380-cccc', 'verified') AS r")).rows[0].r.status, 'verified');
      await writer.query('BEGIN');
      const pending = writer.query(PAYEE_RECORD_SQL, [TC, 'bank_linked', JSON.stringify(ATTACKER)]);
      await new Promise((resolve) => { setTimeout(resolve, 300); });
      await verdict.query('COMMIT');
      assert.deepEqual((await pending).rows[0].result, { error: 'already_verified' });
      await writer.query('COMMIT');
    } finally {
      await verdict.end();
      await writer.end();
    }
    assert.deepEqual((await admin.query(`SELECT provider_bank_account_id, connection_status FROM ${METHODS} WHERE external_recipient_id = $1`, [RID_C])).rows,
      [{ provider_bank_account_id: 'bank-1380-cccc', connection_status: 'connected' }]);

    // The file run again is a no-op; the tool refuses a re-apply as already in place.
    const done = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
    assert.equal(done.already_applied, true);
    assert.equal(done.live_definition_sha256, PIN.intended_replacement_sha256);
    await asOwner(TEXT);
    assert.equal((await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details.live_definition_sha256, PIN.intended_replacement_sha256);
    assert.deepEqual(await funcAcl(), aclBefore);
    const again = await executeReleaseProductionApply(KEY, manifest(authorized(PRE)), { root: ROOT, pin: authorized(PRE), connect, consumedPath: consumedPath() });
    assert.equal(again.ok, false);
    assert.equal(again.code, CODES.UNRELATED_MUTATION);

    // Preconditions fail closed, nothing changed: a missing column, then a function owned by another role.
    const failsWith = async (setup, message) => {
      await admin.query('BEGIN');
      try {
        await admin.query(setup);
        await admin.query('SET LOCAL ROLE checksops_admin');
        await assert.rejects(admin.query(TEXT), (error) => error.code === '55000' && error.message.startsWith(message));
      } finally {
        await admin.query('ROLLBACK');
      }
    };
    await failsWith(`ALTER TABLE ${RECIPIENTS} RENAME COLUMN verified_at TO verified_at_moved`, 'sql138_prerequisite_missing: SQL 138 needs SQL 113\'s payee setup first; missing column public.external_payment_recipients.verified_at');
    await failsWith(`CREATE ROLE sql138_other NOLOGIN; ALTER FUNCTION ${IDENTITY} OWNER TO sql138_other`, 'sql138_function_not_owned');
    await failsWith(`ALTER TABLE ${METHODS} FORCE ROW LEVEL SECURITY`, 'sql138_definer_cannot_write');
    assert.equal(await body(), releaseFunctionDefinitions(TEXT).aws_public_payee_record.prosrc);
    assert.deepEqual(await funcAcl(), aclBefore);
  } finally {
    await fx.close();
  }
});
