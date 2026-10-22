/**
 * SQL 110 (aws/workflows/sql/110_homeowner_preclaim_links.sql) on PostgreSQL 16, through its
 * production tool, from the homeowner ledger tables as the supabase migrations created them with
 * SQL 68's grants and the aws/rls policies (helpers/sql110-homeowner-schema.mjs), the owner the
 * non-superuser checksops_admin login:
 *
 *   - before SQL 110: a DELETE of a pre-claim link by checksops fails at the grant layer, and the
 *     public upload's direct INSERT (checksops, no app identity) is refused by row-level security;
 *   - one apply reaches the intended fingerprint; every other grant is unchanged; the function is
 *     EXECUTE checksops and the owner only;
 *   - the writer, called as checksops with no identity: a valid upload inserts one pending_review
 *     row from the token (and a ledger event when the link has a claim); unknown, short, revoked
 *     and expired tokens, bad paths, a bad kind or amount are refused and write nothing; the 25th
 *     upload in 24 hours is the last, the next is rate_limited; the direct INSERT stays refused;
 *   - DELETE on homeowner_ledger_tokens: a same-tenant staff identity deletes the link (its
 *     uploads stay, token_id cleared by ON DELETE SET NULL); another tenant's staff identity and
 *     a session with no identity delete nothing;
 *   - the file run again is a no-op and the tool refuses a re-apply as already in place.
 *
 * Run: node --test aws/tests/sql110-homeowner-preclaim-links-pg.test.mjs (as root the PG helpers
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
import { CLAIM_A, MEMBER_A, MEMBER_B, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import {
  HOMEOWNER_SCHEMA,
  TOKEN_CLAIM,
  TOKEN_CLAIM_ID,
  TOKEN_EXPIRED,
  TOKEN_OK,
  TOKEN_OK_ID,
  TOKEN_REVOKED,
} from './helpers/sql110-homeowner-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKENS = 'public.homeowner_ledger_tokens';
const UPLOADS = 'public.homeowner_ledger_check_uploads';
const FN = 'public.aws_public_homeowner_ledger_upload(text, text, text, text, numeric, text)';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql110', ROOT);
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
  const workstream = 'prod-sql110-pg-test';
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
    one_use_id: `sql110-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-22T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql110-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: [HOMEOWNER_SCHEMA] });
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

/** One statement as the API login (checksops) in its own rolled-back or committed transaction. */
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

const directInsert = (connectAs) => asApi(connectAs, {}, (c) => c.query(
  `INSERT INTO ${UPLOADS} (tenant_id, token_id, front_path, status) VALUES ($1::uuid, $2::uuid, 'ledger/x/1_front.jpg', 'pending_review')`,
  [TENANT_A, TOKEN_OK_ID],
));
const deleteToken = (connectAs, user, id) => asApi(connectAs, { user, commit: true }, async (c) => (await c.query(`DELETE FROM ${TOKENS} WHERE id = $1::uuid`, [id])).rowCount);
const upload = (connectAs, args) => asApi(connectAs, { commit: true }, async (c) => (await c.query(
  'SELECT public.aws_public_homeowner_ledger_upload($1, $2, $3, $4, $5, $6) AS r',
  [args.token, args.front, args.back ?? null, args.kind ?? null, args.amount ?? null, args.note ?? null],
)).rows[0].r);
const okFront = (prefixId, n = Date.now()) => `ledger/${prefixId}/${n}_front.jpg`;

test('PostgreSQL 16: SQL 110 through its production tool: DELETE opens under the tenant policy, the public upload writer replaces the refused direct INSERT', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql110-prod-', 61110, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const tokensAclBefore = await tableAcl(admin, TOKENS);
  assert.deepEqual(tokensAclBefore, ['checksops INSERT', 'checksops SELECT', 'checksops UPDATE']);
  const uploadsAclBefore = await tableAcl(admin, UPLOADS);

  // Before SQL 110: DELETE refused at the grant layer, even for a same-tenant staff identity.
  const del0 = await deleteToken(connectAs, MEMBER_A, TOKEN_CLAIM_ID);
  assert.equal(del0.error?.code, '42501');
  assert.match(del0.error.message, /permission denied for table homeowner_ledger_tokens/);
  // The public upload's direct INSERT (no app identity) is refused by row-level security.
  const ins0 = await directInsert(connectAs);
  assert.match(ins0.error?.message || '', /row-level security/);
  assert.equal((await upload(connectAs, { token: TOKEN_OK, front: okFront(TOKEN_OK_ID) })).error?.code, '42883');

  const s = (await inspectReleaseProduction('sql110', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql110', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(await tableAcl(admin, TOKENS), [...tokensAclBefore, 'checksops DELETE'].sort());
  assert.deepEqual(await tableAcl(admin, UPLOADS), uploadsAclBefore);
  const acl = (await admin.query(`SELECT has_function_privilege('checksops', $1::regprocedure, 'EXECUTE') AS api,
    EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
            WHERE p.oid = $1::regprocedure AND a.grantee = 0) AS public_grant,
    (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure) AS owner,
    (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure) AS secdef`, [FN])).rows[0];
  assert.deepEqual(acl, { api: true, public_grant: false, owner: 'checksops_admin', secdef: true });

  // The writer, called as checksops with no identity.
  const front = okFront(TOKEN_OK_ID, 1700000000001);
  const back = `ledger/${TOKEN_OK_ID}/1700000000001_back.png`;
  const ok = await upload(connectAs, { token: `  ${TOKEN_OK} `, front, back, kind: 'Check', amount: 1234.5, note: `  ${'n'.repeat(1200)}  ` });
  assert.equal(ok.error, null, ok.error?.message);
  assert.equal(ok.value.ok, true);
  assert.deepEqual(
    { tenant_id: ok.value.tenant_id, claim_id: ok.value.claim_id, token_id: ok.value.token_id, kind: ok.value.kind, sent_by_user_id: ok.value.sent_by_user_id },
    { tenant_id: TENANT_A, claim_id: null, token_id: TOKEN_OK_ID, kind: 'check', sent_by_user_id: MEMBER_A },
  );
  const row = (await admin.query(`SELECT * FROM ${UPLOADS} WHERE id = $1::uuid`, [ok.value.upload_id])).rows[0];
  assert.equal(row.status, 'pending_review');
  assert.equal(row.tenant_id, TENANT_A);
  assert.equal(row.claim_id, null);
  assert.equal(row.token_id, TOKEN_OK_ID);
  assert.equal(row.front_path, front);
  assert.equal(row.back_path, back);
  assert.equal(row.amount_estimate, '1234.50');
  assert.equal(row.homeowner_note, 'n'.repeat(1000));
  assert.equal(row.partner_code, 'PARTNER1');
  assert.equal(row.assigned_to_user_id, MEMBER_A);
  // No claim on the link: no ledger event (homeowner_ledger_events.claim_id is NOT NULL).
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.homeowner_ledger_events')).rows[0].n, 0);

  // A claim-linked link: the path prefix is the claim, and one ledger event is appended.
  const claimed = await upload(connectAs, { token: TOKEN_CLAIM, front: okFront(CLAIM_A, 1700000000002), kind: 'document', amount: 0 });
  assert.equal(claimed.error, null, claimed.error?.message);
  assert.equal(claimed.value.claim_id, CLAIM_A);
  assert.equal(claimed.value.kind, 'document');
  const events = (await admin.query('SELECT tenant_id, claim_id, event_type, amount, actor_label, payload_json FROM public.homeowner_ledger_events')).rows;
  assert.deepEqual(events, [{
    tenant_id: TENANT_A, claim_id: CLAIM_A, event_type: 'homeowner_check_upload', amount: '0.00', actor_label: 'Homeowner',
    payload_json: { upload_id: claimed.value.upload_id, kind: 'document' },
  }]);

  // Refusals write nothing.
  const count = async () => (await admin.query(`SELECT count(*)::int AS n FROM ${UPLOADS}`)).rows[0].n;
  const before = await count();
  const refused = async (args, error) => {
    const r = await upload(connectAs, args);
    assert.equal(r.error, null, r.error?.message);
    assert.deepEqual(r.value, { error }, JSON.stringify(args));
  };
  await refused({ token: 'no-such-token-at-all', front: okFront(TOKEN_OK_ID) }, 'not_found');
  await refused({ token: 'short', front: okFront(TOKEN_OK_ID) }, 'not_found');
  await refused({ token: null, front: okFront(TOKEN_OK_ID) }, 'not_found');
  await refused({ token: TOKEN_REVOKED, front: okFront(TOKEN_OK_ID) }, 'revoked');
  await refused({ token: TOKEN_EXPIRED, front: okFront(TOKEN_OK_ID) }, 'expired');
  await refused({ token: TOKEN_OK, front: okFront(TOKEN_OK_ID), kind: 'selfie' }, 'invalid_kind');
  await refused({ token: TOKEN_OK, front: okFront(TOKEN_OK_ID), amount: -1 }, 'invalid_amount');
  await refused({ token: TOKEN_OK, front: okFront(TOKEN_OK_ID), amount: 10000000.01 }, 'invalid_amount');
  for (const bad of [
    null,
    `ledger/${CLAIM_A}/1_front.jpg`, // another link's prefix
    `ledger/${TOKEN_OK_ID}/1_front.exe`,
    `ledger/${TOKEN_OK_ID}/1_back.jpg`, // a back image as the front
    `ledger/${TOKEN_OK_ID}/../${CLAIM_A}/1_front.jpg`,
    `ledger/${TOKEN_OK_ID}/1_front.jpg/../x`,
    `ledger/${TOKEN_OK_ID}/abc_front.jpg`,
    `/ledger/${TOKEN_OK_ID}/1_front.jpg`,
    `ledger/${TOKEN_OK_ID}/1_front.JPG`,
    `ledger/${TOKEN_OK_ID}/1_front.jpg\n`,
  ]) {
    await refused({ token: TOKEN_OK, front: bad }, 'invalid_path');
  }
  await refused({ token: TOKEN_OK, front: okFront(TOKEN_OK_ID), back: `ledger/${TOKEN_OK_ID}/1_front.jpg` }, 'invalid_path');
  await refused({ token: TOKEN_OK, front: okFront(TOKEN_OK_ID), back: `ledger/${CLAIM_A}/1_back.jpg` }, 'invalid_path');
  assert.equal(await count(), before);

  // Rate limit: 25 uploads on the link in 24 hours are allowed, the next is refused; older ones do not count.
  await admin.query(`INSERT INTO ${UPLOADS} (tenant_id, token_id, front_path, created_at)
    SELECT $1::uuid, $2::uuid, 'ledger/old/1_front.jpg', now() - interval '25 hours' FROM generate_series(1, 30)`, [TENANT_A, TOKEN_OK_ID]);
  const recent = async () => (await admin.query(`SELECT count(*)::int AS n FROM ${UPLOADS} WHERE token_id = $1::uuid AND created_at > now() - interval '24 hours'`, [TOKEN_OK_ID])).rows[0].n;
  while (await recent() < 25) {
    const r = await upload(connectAs, { token: TOKEN_OK, front: okFront(TOKEN_OK_ID, 1700000000100 + (await recent())) });
    assert.equal(r.value?.ok, true, JSON.stringify(r));
  }
  await refused({ token: TOKEN_OK, front: okFront(TOKEN_OK_ID, 1700000000999) }, 'rate_limited');
  assert.equal(await recent(), 25);

  // The direct INSERT without identity is still refused: the function is the only no-login path.
  assert.match((await directInsert(connectAs)).error?.message || '', /row-level security/);

  // DELETE: another tenant's staff and a session with no identity delete nothing; same-tenant staff deletes.
  assert.deepEqual(await deleteToken(connectAs, MEMBER_B, TOKEN_CLAIM_ID), { value: 0, error: null });
  assert.deepEqual(await deleteToken(connectAs, null, TOKEN_CLAIM_ID), { value: 0, error: null });
  assert.deepEqual(await deleteToken(connectAs, MEMBER_A, TOKEN_CLAIM_ID), { value: 1, error: null });
  assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${TOKENS} WHERE id = $1::uuid`, [TOKEN_CLAIM_ID])).rows[0].n, 0);
  // homeowner_ledger_check_uploads.token_id is ON DELETE SET NULL: the upload stays, unlinked.
  const kept = (await admin.query(`SELECT token_id FROM ${UPLOADS} WHERE id = $1::uuid`, [claimed.value.upload_id])).rows;
  assert.deepEqual(kept, [{ token_id: null }]);

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await tableAcl(admin, TOKENS), [...tokensAclBefore, 'checksops DELETE'].sort());
  const again = (await inspectReleaseProduction('sql110', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql110', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: a DELETE already held reads as half applied; a login that cannot write the tables as a definer is refused', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql110-pre-', 61120, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query(`GRANT DELETE ON TABLE ${TOKENS} TO checksops`);
  const partial = (await inspectReleaseProduction('sql110', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(partial.already_applied, false);
  assert.deepEqual(partial.precondition_failures, [], JSON.stringify(partial.release_sql_inspect));
  const pin = authorized(partial.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql110', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);

  // FORCE ROW LEVEL SECURITY on an upload table: the definer could not write it; refused before any change.
  await admin.query(`DROP FUNCTION ${FN}`);
  await admin.query(`ALTER TABLE ${UPLOADS} FORCE ROW LEVEL SECURITY`);
  const forced = (await inspectReleaseProduction('sql110', { connect, pin: PIN, root: ROOT })).details;
  assert.ok(forced.precondition_failures.includes('definer_can_write_relations'), JSON.stringify(forced.precondition_failures));
  const owner = await connectAs('checksops_admin');
  try {
    await assert.rejects(owner.query(TEXT), /sql110_definer_cannot_write/);
  } finally {
    await owner.end();
  }
}));
