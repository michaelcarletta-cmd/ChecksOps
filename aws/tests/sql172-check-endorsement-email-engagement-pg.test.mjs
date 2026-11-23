/**
 * SQL 172 (aws/workflows/sql/172_check_endorsement_email_engagement.sql) on PostgreSQL 16, through its production tool,
 * the owner the non-superuser checksops_admin login, SQL 170 applied first as that owner. Owner 2026-11-23: "Yes build
 * opened and clicked" (Resend's opened and clicked events for a payee's endorsement request email, next to Delivered).
 *
 *   - production-like (check_endorsements with RLS on and no policy that lets the API role update it, table SELECT for
 *     checksops; SQL 170 applied): one apply reaches the intended fingerprint, adds the six columns and writes no row
 *     beyond the two counts' default; then the API role (checksops), through the function only: an opened event twice
 *     counts 2, keeps the first time and moves the latest time (an older event arriving late does not move it back); a
 *     clicked event the same; a NULL time is now(); an unknown kind, a blank id or an unknown id changes nothing and
 *     returns false; status, signed_at, the token, updated_at and SQL 170's columns never change; the API role cannot
 *     update the columns itself, and authenticated, anon and PUBLIC cannot execute the function; the file run again is a
 *     no-op (sql172_already_current) and the tool refuses a re-apply; SQL 170's functions are unchanged;
 *   - the file refuses, and changes nothing, without SQL 170 (its column or function) or when a new column already
 *     exists with another type, NOT NULL or default.
 *
 * Run: node --test aws/tests/sql172-check-endorsement-email-engagement-pg.test.mjs (as root the PG helpers run the server
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
import { releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql172';
const TABLE = 'public.check_endorsements';
const ABSENT_PRE = releaseStateHash(KEY, {});
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SQL170_TEXT = fs.readFileSync(path.join(ROOT, loadReleaseProductionPin('sql170', ROOT).filename), 'utf8');
const E1 = 'e1720000-0000-4000-8000-000000000001';
const E2 = 'e1720000-0000-4000-8000-000000000002';
const NEW_COLUMNS = ['email_first_opened_at', 'email_last_opened_at', 'email_open_count', 'email_first_clicked_at',
  'email_last_clicked_at', 'email_click_count'];

/**
 * check_endorsements as production has it before SQL 170: RLS on with a SELECT-only policy for the API role (it cannot
 * update rows itself), table SELECT for checksops and authenticated, two requests. A tenant-member login (member of
 * authenticated, not checksops) checks the function ACL. Run as the superuser before ownership.
 */
const ENDORSEMENTS = `
CREATE TABLE ${TABLE} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid,
  payee_name text,
  status text NOT NULL DEFAULT 'pending',
  token text,
  signed_at timestamptz,
  request_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT '2026-11-01T00:00:00Z');
ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;
CREATE POLICY sql172_test_select ON ${TABLE} FOR SELECT TO checksops USING (true);
GRANT SELECT ON TABLE ${TABLE} TO checksops, authenticated;
INSERT INTO ${TABLE} (id, payee_name, status, token, request_sent_at) VALUES
  ('${E1}', 'Payee One', 'sent', 'tok-1', '2026-11-23T01:00:00Z'),
  ('${E2}', 'Payee Two', 'sent', 'tok-2', '2026-11-23T01:00:00Z');
CREATE ROLE sql172_tenant_member LOGIN IN ROLE authenticated;`;

const authorized = (pin, live) => Object.freeze({
  ...pin,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
function manifest(pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${pin.migration}-pg-test`;
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
    one_use_id: `${pin.migration}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-23T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql172-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

async function withPg(t, prefix, port, extra, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

const rows = async (admin) => (await admin.query(`SELECT id::text, status, token, signed_at, updated_at::text,
  email_message_id, email_delivered_at::text, link_open_count,
  email_first_opened_at::text, email_last_opened_at::text, email_open_count,
  email_first_clicked_at::text, email_last_clicked_at::text, email_click_count
  FROM ${TABLE} ORDER BY id`)).rows;
const columns = async (admin) => (await admin.query(`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
  a.attnotnull AS notnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS def
  FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [TABLE])).rows;
const sql170Functions = async (admin) => (await admin.query(`SELECT p.oid::regprocedure::text AS f, md5(p.prosrc) AS src, p.proacl::text AS acl
  FROM pg_catalog.pg_proc p WHERE p.proname IN ('aws_endorsement_email_sent', 'aws_endorsement_email_event', 'aws_endorsement_link_opened')
  ORDER BY 1`)).rows;
/** A SQL text as the owner; returns the error or null, and the notices. */
async function runAsOwner(connectAs, sql) {
  const owner = await connectAs('checksops_admin');
  const notices = [];
  owner.on('notice', (n) => notices.push(n.message));
  try {
    await owner.query(sql);
    return { error: null, notices };
  } catch (error) {
    return { error, notices };
  } finally {
    await owner.end();
  }
}

test('PostgreSQL 16: production-like, SQL 172 after SQL 170 through its production tool: the API role records opened and clicked events through the function only; re-run a no-op', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql172-prod-', 61272, [ENDORSEMENTS], async ({ admin, connectAs }) => {
  assert.equal((await runAsOwner(connectAs, SQL170_TEXT)).error, null);
  const before170 = await sql170Functions(admin);
  assert.equal(before170.length, 3);
  const connect = () => connectAs('checksops_admin');
  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, { sql170: true });
  assert.equal(s.live_definition_sha256, ABSENT_PRE);
  const pin = authorized(PIN, s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  // The six columns, after SQL 170's eight.
  const cols = await columns(admin);
  assert.deepEqual(cols.slice(-6).map((c) => [c.name, c.type, c.notnull, c.def]), [
    ['email_first_opened_at', 'timestamp with time zone', false, null], ['email_last_opened_at', 'timestamp with time zone', false, null],
    ['email_open_count', 'integer', true, '0'], ['email_first_clicked_at', 'timestamp with time zone', false, null],
    ['email_last_clicked_at', 'timestamp with time zone', false, null], ['email_click_count', 'integer', true, '0'],
  ]);
  assert.equal(cols.at(-7).name, 'link_open_count');
  const start = await rows(admin);
  assert.deepEqual(start.map((r) => [r.id, r.email_open_count, r.email_click_count, r.email_first_opened_at, r.email_first_clicked_at]),
    [[E1, 0, 0, null, null], [E2, 0, 0, null, null]]);
  // SQL 170's functions are unchanged.
  assert.deepEqual(await sql170Functions(admin), before170);

  // Only checksops (and the owner) may execute it.
  const acl = (await admin.query(`SELECT p.prosecdef, p.proacl::text[] AS acl FROM pg_catalog.pg_proc p
    WHERE p.proname = 'aws_endorsement_email_engagement'`)).rows;
  assert.equal(acl.length, 1);
  assert.equal(acl[0].prosecdef, true);
  assert.deepEqual(acl[0].acl.map((line) => line.split('=')[0]).sort(), ['checksops', 'checksops_admin']);
  const member = await connectAs('sql172_tenant_member');
  try {
    await assert.rejects(member.query("SELECT public.aws_endorsement_email_engagement('re_one', 'opened', NULL)"), /permission denied/);
  } finally {
    await member.end();
  }
  // PUBLIC (an empty grantee) and authenticated hold nothing: the ACL above lists only checksops and the owner.
  assert.equal((await admin.query(`SELECT has_function_privilege('public', 'public.aws_endorsement_email_engagement(text, text, timestamp with time zone)', 'EXECUTE') AS ok`)).rows[0].ok, false);
  assert.equal((await admin.query(`SELECT has_function_privilege('authenticated', 'public.aws_endorsement_email_engagement(text, text, timestamp with time zone)', 'EXECUTE') AS ok`)).rows[0].ok, false);

  const api = await connectAs('checksops');
  const engage = async (id, kind, at) => (await api.query('SELECT public.aws_endorsement_email_engagement($1, $2, $3::timestamptz) AS v', [id, kind, at])).rows[0].v;
  try {
    // The API role cannot write the columns itself (RLS has no UPDATE policy for it, and it holds no UPDATE).
    await assert.rejects(api.query(`UPDATE ${TABLE} SET email_open_count = 9 WHERE id = $1::uuid`, [E1]), /permission denied/);
    // SQL 170 stores the request email's id; the delivery report as before.
    assert.equal((await api.query('SELECT public.aws_endorsement_email_sent($1::uuid, $2) AS v', [E1, 're_one'])).rows[0].v, true);
    assert.equal((await api.query("SELECT public.aws_endorsement_email_event('re_one', 'delivered', '2026-11-23T02:00:00Z', NULL) AS v")).rows[0].v, 1);
    // Opened twice: count 2, the first time kept, the latest time moves; an older event arriving late does not move it back.
    assert.equal(await engage('re_one', 'opened', '2026-11-23T03:00:00Z'), true);
    assert.equal(await engage(' re_one ', 'OPENED', '2026-11-23T05:00:00Z'), true);
    let [r1] = await rows(admin);
    assert.deepEqual([r1.email_first_opened_at, r1.email_last_opened_at, r1.email_open_count],
      ['2026-11-23 03:00:00+00', '2026-11-23 05:00:00+00', 2]);
    assert.equal(await engage('re_one', 'opened', '2026-11-23T04:00:00Z'), true);
    [r1] = await rows(admin);
    assert.deepEqual([r1.email_first_opened_at, r1.email_last_opened_at, r1.email_open_count],
      ['2026-11-23 03:00:00+00', '2026-11-23 05:00:00+00', 3]);
    // Clicked.
    assert.equal(await engage('re_one', 'clicked', '2026-11-23T06:00:00Z'), true);
    assert.equal(await engage('re_one', 'clicked', '2026-11-23T07:00:00Z'), true);
    [r1] = await rows(admin);
    assert.deepEqual([r1.email_first_clicked_at, r1.email_last_clicked_at, r1.email_click_count],
      ['2026-11-23 06:00:00+00', '2026-11-23 07:00:00+00', 2]);
    // An unknown kind, a blank or NULL id and an unknown id change nothing and return false.
    const snapshot = await rows(admin);
    for (const [id, kind] of [['re_one', 'delivered'], ['re_one', 'bounced'], ['re_one', ''], ['re_one', null], ['', 'opened'], ['   ', 'clicked'], [null, 'opened'], ['re_unknown', 'opened'], ['re_unknown', 'clicked']]) {
      assert.equal(await engage(id, kind, '2026-11-23T08:00:00Z'), false, `${id} ${kind}`);
    }
    assert.deepEqual(await rows(admin), snapshot);
    // A NULL time is now().
    const t0 = (await admin.query('SELECT now() AS t')).rows[0].t;
    assert.equal(await engage('re_one', 'clicked', null), true);
    const last = (await admin.query(`SELECT email_last_clicked_at AS t, email_click_count AS n FROM ${TABLE} WHERE id = $1::uuid`, [E1])).rows[0];
    assert.ok(last.t >= t0, String(last.t));
    assert.equal(last.n, 3);
  } finally {
    await api.end();
  }
  const [end1, end2] = await rows(admin);
  // Nothing else on the row changed: status, token, signed_at, updated_at and SQL 170's columns.
  assert.deepEqual([end1.status, end1.token, end1.signed_at, end1.updated_at, end1.email_message_id, end1.email_delivered_at, end1.link_open_count],
    ['sent', 'tok-1', null, start[0].updated_at, 're_one', '2026-11-23 02:00:00+00', 0]);
  assert.deepEqual(end2, start[1], 'the other request is untouched');

  // Again: a no-op; the tool refuses a re-apply.
  const again = await runAsOwner(connectAs, TEXT);
  assert.equal(again.error, null);
  assert.ok(again.notices.includes('sql172_already_current'), JSON.stringify(again.notices));
  assert.deepEqual((await rows(admin))[0], end1);
  const reapply = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(reapply.ok, false);
  assert.ok([CODES.DEPLOYMENT_COLLISION, CODES.SQL_COLLISION, CODES.UNRELATED_MUTATION].includes(reapply.code), reapply.code);
  assert.deepEqual(await sql170Functions(admin), before170);
}));

test('PostgreSQL 16: the file refuses, and changes nothing, without SQL 170 or on a conflicting column', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql172-refuse-', 61372, [ENDORSEMENTS], async ({ admin, connectAs }) => {
  const engagement = async () => (await admin.query("SELECT count(*)::int AS n FROM pg_catalog.pg_proc WHERE proname = 'aws_endorsement_email_engagement'")).rows[0].n;
  // Without SQL 170: refused.
  let result = await runAsOwner(connectAs, TEXT);
  assert.equal(result.error?.code, '55000');
  assert.match(result.error.message, /^sql172_prerequisite_missing: public\.aws_endorsement_email_event\(text, text, timestamp with time zone, text\)$/);
  assert.equal(await engagement(), 0);
  assert.ok((await columns(admin)).every((c) => !NEW_COLUMNS.includes(c.name)));

  assert.equal((await runAsOwner(connectAs, SQL170_TEXT)).error, null);
  // SQL 170's column gone: refused.
  await admin.query(`ALTER TABLE ${TABLE} RENAME COLUMN email_message_id TO email_message_id_gone`);
  result = await runAsOwner(connectAs, TEXT);
  assert.equal(result.error?.code, '55000');
  assert.match(result.error.message, /^sql172_prerequisite_missing: column public\.check_endorsements\.email_message_id$/);
  assert.equal(await engagement(), 0);
  await admin.query(`ALTER TABLE ${TABLE} RENAME COLUMN email_message_id_gone TO email_message_id`);

  for (const [alter, undo] of [
    [`ALTER TABLE ${TABLE} ADD COLUMN email_first_opened_at timestamp`, `ALTER TABLE ${TABLE} DROP COLUMN email_first_opened_at`],
    [`ALTER TABLE ${TABLE} ADD COLUMN email_open_count integer`, `ALTER TABLE ${TABLE} DROP COLUMN email_open_count`],
    [`ALTER TABLE ${TABLE} ADD COLUMN email_click_count integer NOT NULL DEFAULT 1`, `ALTER TABLE ${TABLE} DROP COLUMN email_click_count`],
    [`ALTER TABLE ${TABLE} ADD COLUMN email_last_clicked_at text`, `ALTER TABLE ${TABLE} DROP COLUMN email_last_clicked_at`],
  ]) {
    await admin.query(alter);
    const before = (await columns(admin)).map((c) => c.name);
    const { error } = await runAsOwner(connectAs, TEXT);
    assert.ok(error, alter);
    assert.equal(error.code, '55000', alter);
    assert.match(error.message, /^sql172_column_conflict: /, alter);
    assert.deepEqual((await columns(admin)).map((c) => c.name), before, alter);
    assert.equal(await engagement(), 0, alter);
    await admin.query(undo);
  }
  assert.ok((await columns(admin)).every((c) => !NEW_COLUMNS.includes(c.name)));
  // With SQL 170 in place and nothing conflicting, the file runs (as the owner) and adds exactly the six columns.
  const ok = await runAsOwner(connectAs, TEXT);
  assert.equal(ok.error, null);
  assert.ok(!ok.notices.includes('sql172_already_current'));
  assert.deepEqual((await columns(admin)).map((c) => c.name).filter((n) => NEW_COLUMNS.includes(n)), NEW_COLUMNS);
  assert.equal(await engagement(), 1);
}));
