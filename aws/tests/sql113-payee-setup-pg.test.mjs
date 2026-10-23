/**
 * SQL 113 (aws/workflows/sql/113_payee_setup.sql) on PostgreSQL 16, through its production tool,
 * from the payee tables as the supabase migrations created them, restored without ACLs, with the
 * aws/rls SELECT policies (helpers/sql113-payee-schema.mjs), the owner the non-superuser
 * checksops_admin login:
 *
 *   - before SQL 113: checksops cannot read external_payment_recipients (no grant) and the payee
 *     functions do not exist;
 *   - one apply reaches the intended fingerprint: the payee columns, the five-value origin check,
 *     SELECT for checksops and authenticated, the six functions SECURITY DEFINER, owned by the
 *     login, EXECUTE checksops and the owner only (not PUBLIC, anon or authenticated); checksops
 *     reads payees only under the tenant SELECT policy;
 *   - the functions, called as checksops with request.app_user_id set (or unset for the public
 *     ones): create (member only, replay, refusals), the by-token read (not_found, expired,
 *     disconnected, no PII beyond name and email), the setup steps (terms, identity, bank linked
 *     into one payment_provider_methods row, bank verified, invalid event, bank mismatch, the
 *     60-call limit), Moov's verdict (verified refused until every step, then the stakeholder
 *     payable; failed and pending_review), reissue and disconnect;
 *   - the file run again is a no-op and the tool refuses a re-apply as already in place;
 *   - refusals: a three-value origin check (55000 sql113_origin_check_unexpected), a check that
 *     already allows provider_recipient with another value set (left as it is; the tool rolls
 *     back on the fingerprint), a missing prerequisite column (55000 sql113_prerequisite_missing)
 *     and FORCE ROW LEVEL SECURITY on a payee table (55000 sql113_definer_cannot_write).
 *
 * Run: node --test aws/tests/sql113-payee-setup-pg.test.mjs (as root the PG helpers run the server
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
import { MEMBER_A, MEMBER_B, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import {
  METHODS,
  ORIGIN_CHECK_FOUR,
  ORIGIN_CHECK_THREE_VALUES,
  PAYEE_SCHEMA,
  RECIPIENTS,
  STAKEHOLDERS,
} from './helpers/sql113-payee-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql113';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const FUNCTIONS = Object.freeze([...PIN.function_identities]);
const ORIGIN_FIVE = "CHECK ((origin = ANY (ARRAY['tenant_owned'::text, 'partner_shared'::text, 'homeowner_link'::text, 'provider_connected'::text, 'provider_recipient'::text])))";

const RID1 = 'e1000000-0000-4000-8000-000000000001';
const RID2 = 'e1000000-0000-4000-8000-000000000002';
const RID3 = 'e1000000-0000-4000-8000-000000000003';
const RID_B = 'e1000000-0000-4000-8000-00000000000b';
const ACCT1 = 'moov-acct-0001-aaaa';
const ACCT2 = 'moov-acct-0002-bbbb';
const ACCT3 = 'moov-acct-0003-cccc';
const token = (c) => `tok_${c.repeat(40)}`;
const T1 = token('a');
const T2 = token('b');
const T3 = token('c');
const BY_TOKEN_KEYS = Object.freeze([
  'ok', 'recipient_id', 'tenant_id', 'tenant_name', 'display_name', 'email', 'recipient_type', 'relationship', 'environment',
  'provider_account_id', 'onboarding_status', 'tos_accepted_at', 'identity_submitted_at', 'provider_bank_account_id',
  'provider_bank_name', 'provider_last_four', 'bank_linked_at', 'bank_verified_at', 'verified_at', 'setup_attempts',
].sort());

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
  const workstream = 'prod-sql113-pg-test';
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
    one_use_id: `sql113-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-23T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql113-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: [PAYEE_SCHEMA] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** The table's ACL lines (grantee privilege), the owner excluded. */
const tableAcl = async (admin, table) => (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
  FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [table])).rows.map((r) => r.line);

/** One statement as the API login (checksops) in its own transaction, committed or rolled back. */
async function asApi(connectAs, { user = null, commit = true } = {}, run) {
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
const fnCall = (connectAs, user, sql, params) => asApi(connectAs, { user }, async (c) => (await c.query(`SELECT ${sql} AS r`, params)).rows[0].r);

/** aws_payee_create as `user` (null: no identity); `over` replaces any argument. */
const create = (connectAs, user, over = {}) => {
  const a = {
    id: RID1, tenant: TENANT_A, name: 'Jane Homeowner', email: 'Jane@Example.com', type: 'individual', rel: 'homeowner',
    env: 'sandbox', acct: ACCT1, token: T1, expires: "now() + interval '7 days'", claim: null, check: null, ...over,
  };
  return fnCall(connectAs, user, `public.aws_payee_create($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, ${a.expires}, $10::uuid, $11::uuid)`,
    [a.id, a.tenant, a.name, a.email, a.type, a.rel, a.env, a.acct, a.token, a.claim, a.check]);
};
const byToken = (connectAs, tok) => fnCall(connectAs, null, 'public.aws_public_payee_by_token($1)', [tok]);
const record = (connectAs, tok, event, data = {}) => fnCall(connectAs, null, 'public.aws_public_payee_record($1, $2, $3::jsonb)', [tok, event, JSON.stringify(data)]);
const applyStatus = (connectAs, acct, status, env = 'sandbox') => fnCall(connectAs, null, 'public.aws_payee_apply_status($1, $2, $3)', [env, acct, status]);
const reissue = (connectAs, user, id, tok, expires = "now() + interval '7 days'") => fnCall(connectAs, user, `public.aws_payee_reissue_link($1::uuid, $2, ${expires})`, [id, tok]);
const disconnect = (connectAs, user, id) => fnCall(connectAs, user, 'public.aws_payee_disconnect($1::uuid)', [id]);

/** The value of a call that must succeed (no SQL error). */
const value = (r) => {
  assert.equal(r.error, null, r.error?.message);
  return r.value;
};

test('PostgreSQL 16: SQL 113 through its production tool: payee columns, origin, SELECT grant and the six payee functions', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql113-prod-', 61130, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const row = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
  const count = async (table, where = 'true', params = []) => Number((await row(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).n);
  assert.deepEqual(await tableAcl(admin, RECIPIENTS), []);
  const stakeholdersAclBefore = await tableAcl(admin, STAKEHOLDERS);
  const methodsAclBefore = await tableAcl(admin, METHODS);

  // Before SQL 113: no grant, no function.
  const read0 = await asApi(connectAs, { user: MEMBER_A }, (c) => c.query(`SELECT count(*) FROM ${RECIPIENTS}`));
  assert.equal(read0.error?.code, '42501');
  assert.equal((await create(connectAs, MEMBER_A)).error?.code, '42883');

  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);

  // The catalog: SELECT for checksops and authenticated only; the other tables' grants unchanged.
  assert.deepEqual(await tableAcl(admin, RECIPIENTS), ['authenticated SELECT', 'checksops SELECT']);
  assert.deepEqual(await tableAcl(admin, STAKEHOLDERS), stakeholdersAclBefore);
  assert.deepEqual(await tableAcl(admin, METHODS), methodsAclBefore);
  assert.deepEqual(await row("SELECT pg_catalog.pg_get_constraintdef(oid) AS d FROM pg_catalog.pg_constraint WHERE conname = 'stakeholder_accounts_origin_check'"), { d: ORIGIN_FIVE });
  const cols = (await admin.query(`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
      pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS def
    FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = ANY ($2::text[]) ORDER BY a.attname`,
  [RECIPIENTS, ['tos_accepted_at', 'identity_submitted_at', 'bank_verified_at', 'verified_at', 'disconnected_at', 'provider_bank_account_id', 'setup_attempts']])).rows;
  assert.deepEqual(cols, [
    { name: 'bank_verified_at', type: 'timestamp with time zone', notnull: false, def: null },
    { name: 'disconnected_at', type: 'timestamp with time zone', notnull: false, def: null },
    { name: 'identity_submitted_at', type: 'timestamp with time zone', notnull: false, def: null },
    { name: 'provider_bank_account_id', type: 'text', notnull: false, def: null },
    { name: 'setup_attempts', type: 'integer', notnull: true, def: '0' },
    { name: 'tos_accepted_at', type: 'timestamp with time zone', notnull: false, def: null },
    { name: 'verified_at', type: 'timestamp with time zone', notnull: false, def: null },
  ]);
  for (const identity of FUNCTIONS) {
    const acl = await row(`SELECT has_function_privilege('checksops', $1::regprocedure, 'EXECUTE') AS api,
      has_function_privilege('anon', $1::regprocedure, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS authenticated,
      EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
              WHERE p.oid = $1::regprocedure AND a.grantee = 0) AS public_grant,
      (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure) AS owner,
      (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure) AS secdef`, [identity]);
    assert.deepEqual(acl, { api: true, anon: false, authenticated: false, public_grant: false, owner: 'checksops_admin', secdef: true }, identity);
  }

  // aws_payee_create: a member of the tenant creates the payee and its pending stakeholder row.
  const before = { r: await count(RECIPIENTS), s: await count(STAKEHOLDERS) };
  const refusedCreate = async (user, over, error) => assert.deepEqual(value(await create(connectAs, user, over)), { error }, JSON.stringify(over));
  await refusedCreate(null, {}, 'forbidden');
  await refusedCreate(MEMBER_B, {}, 'forbidden');
  await refusedCreate(MEMBER_A, { tenant: TENANT_B }, 'forbidden');
  await refusedCreate(MEMBER_A, { id: null }, 'invalid_recipient_id');
  await refusedCreate(MEMBER_A, { name: '   ' }, 'invalid_name');
  for (const email of ['not-an-email', 'a@b', 'a b@example.com', '', null]) await refusedCreate(MEMBER_A, { email }, 'invalid_email');
  for (const type of ['llc', '', null]) await refusedCreate(MEMBER_A, { type }, 'invalid_type');
  await refusedCreate(MEMBER_A, { env: 'live' }, 'invalid_environment');
  for (const acct of ['short', 'has space in it', null]) await refusedCreate(MEMBER_A, { acct }, 'invalid_provider_account');
  for (const tok of ['too-short', `${'x'.repeat(40)}!`, null]) await refusedCreate(MEMBER_A, { token: tok }, 'invalid_token');
  for (const expires of ["now() - interval '1 minute'", "now() + interval '31 days'", 'NULL']) await refusedCreate(MEMBER_A, { expires }, 'invalid_expiry');
  assert.deepEqual({ r: await count(RECIPIENTS), s: await count(STAKEHOLDERS) }, before);

  const c1 = value(await create(connectAs, MEMBER_A));
  assert.equal(c1.ok, true);
  assert.equal(c1.replayed, false);
  assert.equal(c1.recipient_id, RID1);
  const r1 = await row(`SELECT * FROM ${RECIPIENTS} WHERE id = $1`, [RID1]);
  assert.equal(r1.stakeholder_account_id, c1.stakeholder_account_id);
  assert.deepEqual(
    { tenant_id: r1.tenant_id, provider: r1.provider, environment: r1.environment, display_name: r1.display_name, email: r1.email, recipient_type: r1.recipient_type, relationship: r1.relationship, provider_account_id: r1.provider_account_id, onboarding_status: r1.onboarding_status, secure_token: r1.secure_token, created_by: r1.created_by, setup_attempts: r1.setup_attempts },
    { tenant_id: TENANT_A, provider: 'moov', environment: 'sandbox', display_name: 'Jane Homeowner', email: 'jane@example.com', recipient_type: 'individual', relationship: 'homeowner', provider_account_id: ACCT1, onboarding_status: 'invited', secure_token: T1, created_by: MEMBER_A, setup_attempts: 0 },
  );
  const s1 = await row(`SELECT * FROM ${STAKEHOLDERS} WHERE id = $1`, [c1.stakeholder_account_id]);
  assert.deepEqual(
    { tenant_id: s1.tenant_id, origin: s1.origin, verification_status: s1.verification_status, verification_source: s1.verification_source, account_type: s1.account_type, nickname: s1.nickname, homeowner_email: s1.homeowner_email, homeowner_name: s1.homeowner_name, provider: s1.provider, provider_environment: s1.provider_environment, provider_account_id: s1.provider_account_id, provider_bank_account_id: s1.provider_bank_account_id, is_active: s1.is_active, is_primary: s1.is_primary, is_partner_payout: s1.is_partner_payout, created_by: s1.created_by, verified_at: s1.verified_at },
    { tenant_id: TENANT_A, origin: 'provider_recipient', verification_status: 'pending', verification_source: 'moov', account_type: 'homeowner', nickname: 'Jane Homeowner', homeowner_email: 'jane@example.com', homeowner_name: 'Jane Homeowner', provider: 'moov', provider_environment: 'sandbox', provider_account_id: ACCT1, provider_bank_account_id: null, is_active: true, is_primary: false, is_partner_payout: false, created_by: MEMBER_A, verified_at: null },
  );
  // A replay with the same recipient id returns the same rows; a different account or a reused account conflicts.
  assert.deepEqual(value(await create(connectAs, MEMBER_A)), { ok: true, replayed: true, recipient_id: RID1, stakeholder_account_id: c1.stakeholder_account_id });
  await refusedCreate(MEMBER_A, { acct: ACCT2 }, 'conflict');
  await refusedCreate(MEMBER_A, { id: RID2, token: T2 }, 'conflict');
  assert.deepEqual({ r: await count(RECIPIENTS), s: await count(STAKEHOLDERS) }, { r: before.r + 1, s: before.s + 1 });
  // A business payee; an unknown relationship is stored as 'other'.
  const c2 = value(await create(connectAs, MEMBER_A, { id: RID2, name: 'Acme Roofing LLC', email: 'pay@acme.example', type: 'Business', rel: 'Partner', acct: ACCT2, token: T2 }));
  assert.equal(c2.ok, true);
  const s2 = await row(`SELECT account_type, homeowner_email, origin FROM ${STAKEHOLDERS} WHERE id = $1`, [c2.stakeholder_account_id]);
  assert.deepEqual(s2, { account_type: 'other', homeowner_email: null, origin: 'provider_recipient' });
  assert.equal((await row(`SELECT recipient_type FROM ${RECIPIENTS} WHERE id = $1`, [RID2])).recipient_type, 'business');
  assert.equal(value(await create(connectAs, MEMBER_A, { id: RID3, name: 'Third Payee', email: 'third@example.com', acct: ACCT3, token: T3 })).ok, true);
  assert.equal(value(await create(connectAs, MEMBER_B, { id: RID_B, tenant: TENANT_B, name: 'B Payee', email: 'b@example.com', acct: 'moov-acct-000b-bbbb', token: token('d') })).ok, true);

  // checksops reads payees only under the tenant SELECT policy.
  const visible = async (user) => value(await asApi(connectAs, { user }, async (c) => (await c.query(`SELECT id FROM ${RECIPIENTS} ORDER BY id`)).rows.map((r) => r.id)));
  assert.deepEqual(await visible(MEMBER_A), [RID1, RID2, RID3]);
  assert.deepEqual(await visible(MEMBER_B), [RID_B]);
  assert.deepEqual(await visible(null), []);
  const write = await asApi(connectAs, { user: MEMBER_A }, (c) => c.query(`UPDATE ${RECIPIENTS} SET onboarding_status = 'verified' WHERE id = $1`, [RID1]));
  assert.equal(write.error?.code, '42501');

  // aws_public_payee_by_token: the payee's own state by its link token, nothing else.
  for (const tok of ['short', null, token('z'), `  ${'q'.repeat(20)}  `]) assert.deepEqual(value(await byToken(connectAs, tok)), { error: 'not_found' }, String(tok));
  const view = value(await byToken(connectAs, `  ${T1}  `));
  assert.deepEqual(Object.keys(view).sort(), [...BY_TOKEN_KEYS]);
  assert.deepEqual(
    { ok: view.ok, recipient_id: view.recipient_id, tenant_name: view.tenant_name, display_name: view.display_name, email: view.email, onboarding_status: view.onboarding_status, setup_attempts: view.setup_attempts },
    { ok: true, recipient_id: RID1, tenant_name: 'A', display_name: 'Jane Homeowner', email: 'jane@example.com', onboarding_status: 'invited', setup_attempts: 0 },
  );
  await admin.query(`UPDATE ${RECIPIENTS} SET token_expires_at = now() - interval '1 minute' WHERE id = $1`, [RID3]);
  assert.deepEqual(value(await byToken(connectAs, T3)), { error: 'expired' });
  assert.deepEqual(value(await record(connectAs, T3, 'tos_accepted')), { error: 'expired' });
  await admin.query(`UPDATE ${RECIPIENTS} SET token_expires_at = now() + interval '1 day', disconnected_at = now() WHERE id = $1`, [RID3]);
  assert.deepEqual(value(await byToken(connectAs, T3)), { error: 'disconnected' });
  assert.deepEqual(value(await record(connectAs, T3, 'tos_accepted')), { error: 'disconnected' });
  assert.equal((await row(`SELECT setup_attempts FROM ${RECIPIENTS} WHERE id = $1`, [RID3])).setup_attempts, 0);

  // aws_public_payee_record: one setup step per call.
  assert.deepEqual(value(await record(connectAs, T1, 'delete_everything')), { error: 'invalid_event' });
  assert.deepEqual(value(await record(connectAs, T1, 'bank_verified', { provider_bank_account_id: 'bank-0001-aaaa' })), { error: 'bank_mismatch' });
  const tos = value(await record(connectAs, T1, 'TOS_Accepted'));
  assert.equal(tos.onboarding_status, 'tos_accepted');
  assert.ok(tos.tos_accepted_at);
  assert.equal(tos.setup_attempts, 3);
  const firstTos = tos.tos_accepted_at;
  assert.equal(value(await record(connectAs, T1, 'tos_accepted')).tos_accepted_at, firstTos);
  const ident = value(await record(connectAs, T1, 'identity_submitted', { ssn: '123-45-6789' }));
  assert.equal(ident.onboarding_status, 'identity_submitted');
  assert.ok(ident.identity_submitted_at);
  assert.deepEqual(value(await applyStatus(connectAs, ACCT1, 'verified')), { error: 'setup_incomplete' });
  for (const [data, error] of [
    [{ provider_bank_account_id: 'x', last_four: '6789', account_type: 'checking' }, 'invalid_bank_account'],
    [{ provider_bank_account_id: 'bank-0001-aaaa', last_four: '67a9', account_type: 'checking' }, 'invalid_last_four'],
    [{ provider_bank_account_id: 'bank-0001-aaaa', last_four: '123456789', account_type: 'checking' }, 'invalid_last_four'],
    [{ provider_bank_account_id: 'bank-0001-aaaa', last_four: '6789', account_type: 'brokerage' }, 'invalid_account_type'],
  ]) {
    assert.deepEqual(value(await record(connectAs, T1, 'bank_linked', data)), { error }, JSON.stringify(data));
  }
  assert.equal(await count(METHODS), 0);
  const bankData = { provider_bank_account_id: 'bank-0001-aaaa', bank_name: ' First Bank ', last_four: '6789', account_type: 'Checking', holder_name: 'Jane Homeowner', account_number: '000123456789', routing_number: '021000021' };
  const linked = value(await record(connectAs, T1, 'bank_linked', bankData));
  assert.deepEqual(
    { onboarding_status: linked.onboarding_status, provider_bank_account_id: linked.provider_bank_account_id, provider_bank_name: linked.provider_bank_name, provider_last_four: linked.provider_last_four, bank_verified_at: linked.bank_verified_at },
    { onboarding_status: 'bank_linked', provider_bank_account_id: 'bank-0001-aaaa', provider_bank_name: 'First Bank', provider_last_four: '6789', bank_verified_at: null },
  );
  const m1 = (await admin.query(`SELECT * FROM ${METHODS}`)).rows;
  assert.equal(m1.length, 1);
  assert.deepEqual(
    { tenant_id: m1[0].tenant_id, external_recipient_id: m1[0].external_recipient_id, provider: m1[0].provider, environment: m1[0].environment, provider_account_id: m1[0].provider_account_id, provider_bank_account_id: m1[0].provider_bank_account_id, bank_name: m1[0].bank_name, account_type: m1[0].account_type, last_four: m1[0].last_four, holder_name: m1[0].holder_name, verification_status: m1[0].verification_status, connection_status: m1[0].connection_status, can_receive: m1[0].can_receive, can_send: m1[0].can_send, provider_metadata: m1[0].provider_metadata },
    { tenant_id: TENANT_A, external_recipient_id: RID1, provider: 'moov', environment: 'sandbox', provider_account_id: ACCT1, provider_bank_account_id: 'bank-0001-aaaa', bank_name: 'First Bank', account_type: 'checking', last_four: '6789', holder_name: 'Jane Homeowner', verification_status: 'pending', connection_status: 'connected', can_receive: true, can_send: false, provider_metadata: {} },
  );
  assert.ok(m1[0].connected_at);
  // No identity, account or routing number is stored anywhere.
  const everything = JSON.stringify([
    ...(await admin.query(`SELECT * FROM ${RECIPIENTS}`)).rows, ...(await admin.query(`SELECT * FROM ${STAKEHOLDERS}`)).rows, ...(await admin.query(`SELECT * FROM ${METHODS}`)).rows,
  ]);
  for (const secret of ['000123456789', '021000021', '123-45-6789']) assert.ok(!everything.includes(secret), secret);
  // Linking the same bank again updates the one row.
  assert.equal(value(await record(connectAs, T1, 'bank_linked', bankData)).provider_bank_account_id, 'bank-0001-aaaa');
  assert.equal(await count(METHODS), 1);
  assert.deepEqual(value(await applyStatus(connectAs, ACCT1, 'verified')), { error: 'setup_incomplete' });
  assert.deepEqual(value(await record(connectAs, T1, 'bank_verified', { provider_bank_account_id: 'bank-9999-zzzz' })), { error: 'bank_mismatch' });
  const bv = value(await record(connectAs, T1, 'bank_verified', { provider_bank_account_id: 'bank-0001-aaaa' }));
  assert.equal(bv.onboarding_status, 'bank_verified');
  assert.ok(bv.bank_verified_at);
  assert.equal((await row(`SELECT verification_status FROM ${METHODS} WHERE external_recipient_id = $1`, [RID1])).verification_status, 'verified');
  // A new bank replaces the earlier one and must be verified again.
  const bank2 = { ...bankData, provider_bank_account_id: 'bank-0002-bbbb', last_four: '4321', account_type: 'savings' };
  assert.equal(value(await record(connectAs, T1, 'bank_linked', bank2)).bank_verified_at, null);
  assert.deepEqual((await admin.query(`SELECT provider_bank_account_id, connection_status, disconnected_at IS NOT NULL AS gone FROM ${METHODS} WHERE external_recipient_id = $1 ORDER BY provider_bank_account_id`, [RID1])).rows, [
    { provider_bank_account_id: 'bank-0001-aaaa', connection_status: 'disconnected', gone: true },
    { provider_bank_account_id: 'bank-0002-bbbb', connection_status: 'connected', gone: false },
  ]);
  assert.deepEqual(value(await applyStatus(connectAs, ACCT1, 'verified')), { error: 'setup_incomplete' });
  assert.equal(value(await record(connectAs, T1, 'bank_verified', { provider_bank_account_id: 'bank-0002-bbbb' })).onboarding_status, 'bank_verified');

  // aws_payee_apply_status: Moov's verdict.
  const stakeholder = async (id) => row(`SELECT verification_status, verification_source, provider, provider_environment, provider_account_id, provider_bank_account_id,
    provider_bank_name, provider_last_four, verified_at IS NOT NULL AS verified, verification_completed_at IS NOT NULL AS completed, is_active FROM ${STAKEHOLDERS} WHERE id = $1`, [id]);
  for (const [status, env, acct, error] of [['approved', 'sandbox', ACCT1, 'invalid_status'], ['verified', 'sandbox', 'moov-acct-none-0000', 'not_found'], ['verified', 'production', ACCT1, 'not_found']]) {
    assert.deepEqual(value(await applyStatus(connectAs, acct, status, env)), { error }, `${status} ${env} ${acct}`);
  }
  assert.deepEqual(value(await applyStatus(connectAs, ACCT1, 'pending_review')), { ok: true, recipient_id: RID1, tenant_id: TENANT_A, stakeholder_account_id: c1.stakeholder_account_id, status: 'pending_review' });
  assert.equal((await stakeholder(c1.stakeholder_account_id)).verification_status, 'pending');
  assert.equal((await row(`SELECT onboarding_status FROM ${RECIPIENTS} WHERE id = $1`, [RID1])).onboarding_status, 'pending_review');
  assert.equal(value(await applyStatus(connectAs, ACCT1, 'failed')).ok, true);
  assert.equal((await stakeholder(c1.stakeholder_account_id)).verification_status, 'failed');
  assert.equal(value(await applyStatus(connectAs, ` ${ACCT1} `, 'VERIFIED', 'Sandbox')).status, 'verified');
  assert.deepEqual(await stakeholder(c1.stakeholder_account_id), {
    verification_status: 'verified', verification_source: 'moov', provider: 'moov', provider_environment: 'sandbox', provider_account_id: ACCT1,
    provider_bank_account_id: 'bank-0002-bbbb', provider_bank_name: 'First Bank', provider_last_four: '4321', verified: true, completed: true, is_active: true,
  });
  const rv = await row(`SELECT onboarding_status, verified_at IS NOT NULL AS verified, token_used_at IS NOT NULL AS used FROM ${RECIPIENTS} WHERE id = $1`, [RID1]);
  assert.deepEqual(rv, { onboarding_status: 'verified', verified: true, used: true });
  // A later failed or pending_review verdict never takes a verified payee back.
  assert.equal(value(await applyStatus(connectAs, ACCT1, 'failed')).ok, true);
  assert.equal((await stakeholder(c1.stakeholder_account_id)).verification_status, 'verified');
  assert.equal((await row(`SELECT onboarding_status FROM ${RECIPIENTS} WHERE id = $1`, [RID1])).onboarding_status, 'verified');
  assert.deepEqual(value(await reissue(connectAs, MEMBER_A, RID1, token('e'))), { error: 'already_verified' });
  // Another tenant's stakeholder rows are untouched by any of this.
  assert.equal((await row(`SELECT verification_status FROM ${STAKEHOLDERS} WHERE provider_account_id = 'moov-acct-000b-bbbb'`)).verification_status, 'pending');

  // The 60-call limit on one link, then a reissued link starts again.
  let calls = 0;
  for (;;) {
    const r = value(await record(connectAs, T2, 'tos_accepted'));
    if (r.error) {
      assert.deepEqual(r, { error: 'rate_limited' });
      break;
    }
    calls += 1;
    assert.ok(calls <= 60, 'more than 60 calls allowed');
  }
  assert.equal(calls, 60);
  assert.equal((await row(`SELECT setup_attempts FROM ${RECIPIENTS} WHERE id = $1`, [RID2])).setup_attempts, 60);
  const T2B = token('f');
  assert.deepEqual(value(await reissue(connectAs, MEMBER_B, RID2, T2B)), { error: 'not_found' });
  assert.deepEqual(value(await reissue(connectAs, null, RID2, T2B)), { error: 'not_found' });
  assert.deepEqual(value(await reissue(connectAs, MEMBER_A, RID2, 'short')), { error: 'invalid_token' });
  assert.deepEqual(value(await reissue(connectAs, MEMBER_A, RID2, T2B, "now() + interval '40 days'")), { error: 'invalid_expiry' });
  assert.deepEqual(value(await reissue(connectAs, MEMBER_A, RID2, T2B)), { ok: true, recipient_id: RID2, email: 'pay@acme.example', display_name: 'Acme Roofing LLC', tenant_id: TENANT_A });
  assert.deepEqual(value(await byToken(connectAs, T2)), { error: 'not_found' });
  const fresh = value(await byToken(connectAs, T2B));
  assert.equal(fresh.setup_attempts, 0);
  assert.equal(value(await record(connectAs, T2B, 'bank_linked', { provider_bank_account_id: 'bank-0003-cccc', last_four: '1111', account_type: 'checking' })).onboarding_status, 'bank_linked');

  // aws_payee_disconnect: only a member of the tenant; the payee can no longer be paid.
  assert.deepEqual(value(await disconnect(connectAs, MEMBER_B, RID2)), { error: 'not_found' });
  assert.deepEqual(value(await disconnect(connectAs, null, RID2)), { error: 'not_found' });
  assert.deepEqual(value(await disconnect(connectAs, MEMBER_A, RID2)), { ok: true, recipient_id: RID2, stakeholder_account_id: c2.stakeholder_account_id, provider_account_id: ACCT2, environment: 'sandbox' });
  assert.deepEqual(await row(`SELECT onboarding_status, secure_token, disconnected_at IS NOT NULL AS gone, token_expires_at <= now() AS closed FROM ${RECIPIENTS} WHERE id = $1`, [RID2]),
    { onboarding_status: 'disconnected', secure_token: null, gone: true, closed: true });
  assert.equal((await stakeholder(c2.stakeholder_account_id)).is_active, false);
  assert.deepEqual((await admin.query(`SELECT connection_status FROM ${METHODS} WHERE external_recipient_id = $1`, [RID2])).rows, [{ connection_status: 'disconnected' }]);
  assert.deepEqual(value(await byToken(connectAs, T2B)), { error: 'not_found' });
  assert.deepEqual(value(await applyStatus(connectAs, ACCT2, 'verified')), { error: 'disconnected' });
  assert.deepEqual(value(await reissue(connectAs, MEMBER_A, RID2, token('g'))), { error: 'disconnected' });
  assert.equal(value(await disconnect(connectAs, MEMBER_A, RID2)).ok, true);
  // RID1's methods and stakeholder are untouched by RID2's disconnect.
  assert.equal((await stakeholder(c1.stakeholder_account_id)).is_active, true);
  assert.equal(await count(METHODS, "external_recipient_id = $1 AND connection_status = 'connected'", [RID1]), 1);

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await tableAcl(admin, RECIPIENTS), ['authenticated SELECT', 'checksops SELECT']);
  assert.deepEqual(await row("SELECT pg_catalog.pg_get_constraintdef(oid) AS d FROM pg_catalog.pg_constraint WHERE conname = 'stakeholder_accounts_origin_check'"), { d: ORIGIN_FIVE });
  const again = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: SQL 113 refuses an unexpected origin check, a missing prerequisite and a login that cannot write the payee tables as a definer', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql113-pre-', 61140, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const runFile = async () => {
    const owner = await connectAs('checksops_admin');
    try {
      await owner.query('BEGIN');
      await owner.query(TEXT);
      await owner.query('ROLLBACK');
      return null;
    } catch (error) {
      await owner.query('ROLLBACK').catch(() => {});
      return error;
    } finally {
      await owner.end();
    }
  };
  const originDef = async () => (await admin.query("SELECT pg_catalog.pg_get_constraintdef(oid) AS d FROM pg_catalog.pg_constraint WHERE conname = 'stakeholder_accounts_origin_check'")).rows[0]?.d ?? null;
  assert.equal(await originDef(), ORIGIN_CHECK_FOUR);
  const exists = async () => (await admin.query("SELECT count(*)::int AS n FROM pg_catalog.pg_proc WHERE proname LIKE 'aws_payee%' OR proname LIKE 'aws_public_payee%'")).rows[0].n;

  // A three-value origin check (before 20260728110453): the file refuses; nothing is applied.
  await admin.query(ORIGIN_CHECK_THREE_VALUES);
  const three = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(three.precondition_failures, [], 'the engine leaves the origin guard to the file');
  assert.deepEqual(three.release_sql_inspect.constraints.map((c) => c.state), ['different']);
  const e1 = await runFile();
  assert.equal(e1?.code, '55000');
  assert.match(e1.message, /^sql113_origin_check_unexpected: stakeholder_accounts_origin_check is CHECK/);
  const pin3 = authorized(three.live_definition_sha256);
  const refused3 = await executeReleaseProductionApply(KEY, manifest(pin3), { root: ROOT, pin: pin3, connect, consumedPath: consumedPath() });
  assert.equal(refused3.ok, false, JSON.stringify(refused3));
  assert.doesNotMatch(await originDef(), /provider_recipient/);
  assert.equal(await exists(), 0);
  // No origin check at all also refuses.
  await admin.query(`ALTER TABLE ${STAKEHOLDERS} DROP CONSTRAINT stakeholder_accounts_origin_check`);
  assert.match((await runFile())?.message || '', /^sql113_origin_check_unexpected: stakeholder_accounts_origin_check is absent/);
  // A check that already allows provider_recipient with another value set is left as it is, so
  // the fingerprint is not the intended one and the tool rolls the whole apply back.
  const six = "CHECK ((origin = ANY (ARRAY['tenant_owned'::text, 'partner_shared'::text, 'homeowner_link'::text, 'provider_connected'::text, 'provider_recipient'::text, 'legacy'::text])))";
  await admin.query(`ALTER TABLE ${STAKEHOLDERS} ADD CONSTRAINT stakeholder_accounts_origin_check ${six}`);
  assert.equal(await runFile(), null);
  const sixState = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  const pin6 = authorized(sixState.live_definition_sha256);
  const refused6 = await executeReleaseProductionApply(KEY, manifest(pin6), { root: ROOT, pin: pin6, connect, consumedPath: consumedPath() });
  assert.equal(refused6.ok, false, JSON.stringify(refused6));
  assert.equal(await originDef(), six);
  assert.equal(await exists(), 0);
  assert.deepEqual(await tableAcl(admin, RECIPIENTS), []);
  await admin.query(`ALTER TABLE ${STAKEHOLDERS} DROP CONSTRAINT stakeholder_accounts_origin_check`);
  await admin.query(`ALTER TABLE ${STAKEHOLDERS} ADD CONSTRAINT stakeholder_accounts_origin_check ${ORIGIN_CHECK_FOUR}`);

  // A missing prerequisite column: the inspect names it and the file refuses.
  await admin.query(`ALTER TABLE ${METHODS} RENAME COLUMN holder_name TO holder`);
  const missing = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.ok(missing.precondition_failures.includes('prerequisites_present'), JSON.stringify(missing.precondition_failures));
  assert.deepEqual(missing.release_sql_inspect.prerequisites_missing, ['column public.payment_provider_methods.holder_name']);
  const e2 = await runFile();
  assert.equal(e2?.code, '55000');
  assert.match(e2.message, /^sql113_prerequisite_missing: SQL 113 needs the payee tables; missing payment_provider_methods\.holder_name$/);
  await admin.query(`ALTER TABLE ${METHODS} RENAME COLUMN holder TO holder_name`);

  // FORCE ROW LEVEL SECURITY on a payee table: the definer could not write it; refused before any change.
  await admin.query(`ALTER TABLE ${METHODS} FORCE ROW LEVEL SECURITY`);
  const forced = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.ok(forced.precondition_failures.includes('definer_can_write_relations'), JSON.stringify(forced.precondition_failures));
  const e3 = await runFile();
  assert.equal(e3?.code, '55000');
  assert.match(e3.message, /^sql113_definer_cannot_write/);
  await admin.query(`ALTER TABLE ${METHODS} NO FORCE ROW LEVEL SECURITY`);

  // Back to the supabase state: the inspect is clean and the file applies.
  const clean = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(clean.precondition_failures, []);
  assert.equal(await runFile(), null);
}));
