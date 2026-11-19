/**
 * SQL 170 (aws/workflows/sql/170_check_endorsement_email_status.sql) on PostgreSQL 16, through its production tool, the
 * owner the non-superuser checksops_admin login. Owner 2026-11-19: "Is there anyway for tenants to see if an email has
 * been delivered and opened? For this to show up near the payee signature request", then "Yeah build 1 and 2".
 *
 *   - production-like (check_endorsements with RLS on and no policy that lets the API role update it, table SELECT for
 *     checksops): one apply reaches the intended fingerprint and writes no row beyond link_open_count's default; then the
 *     API role (checksops), through the three functions only: a sent request stores its message id and clears an older
 *     status; delivered, bounced (with its reason) and complained reports stamp the matching endorsement once, keeping
 *     the first time; an unknown event is refused (22023); a blank or unknown id changes nothing; the opened link counts
 *     up with its first and last time; status, signed_at, the token and updated_at never change; the API role cannot
 *     update the columns itself, and authenticated, anon and PUBLIC cannot execute the functions; the file run again is a
 *     no-op (sql170_already_current) and the tool refuses a re-apply;
 *   - the file refuses, and changes nothing, when a new column already exists with another type, NOT NULL or default, or
 *     the table is missing.
 *
 * Run: node --test aws/tests/sql170-check-endorsement-email-status-pg.test.mjs (as root the PG helpers run the server as
 * the ubuntu account).
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
const KEY = 'sql170';
const TABLE = 'public.check_endorsements';
const ABSENT_PRE = releaseStateHash(KEY, {});
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const E1 = 'e1700000-0000-4000-8000-000000000001';
const E2 = 'e1700000-0000-4000-8000-000000000002';
const NEW_COLUMNS = ['email_message_id', 'email_delivered_at', 'email_bounced_at', 'email_bounce_reason', 'email_complained_at',
  'link_first_opened_at', 'link_last_opened_at', 'link_open_count'];

/**
 * check_endorsements as production has it for this file: RLS on with a SELECT-only policy for the API role (it cannot
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
CREATE POLICY sql170_test_select ON ${TABLE} FOR SELECT TO checksops USING (true);
GRANT SELECT ON TABLE ${TABLE} TO checksops, authenticated;
INSERT INTO ${TABLE} (id, payee_name, status, token, request_sent_at) VALUES
  ('${E1}', 'Payee One', 'sent', 'tok-1', '2026-11-19T01:00:00Z'),
  ('${E2}', 'Payee Two', 'pending', 'tok-2', NULL);
CREATE ROLE sql170_tenant_member LOGIN IN ROLE authenticated;`;

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
    build_timestamp: '2026-11-19T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql170-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  email_message_id, email_delivered_at::text, email_bounced_at::text, email_bounce_reason, email_complained_at::text,
  link_first_opened_at IS NOT NULL AS first_set, link_last_opened_at >= link_first_opened_at AS last_after_first, link_open_count
  FROM ${TABLE} ORDER BY id`)).rows;
const columns = async (admin) => (await admin.query(`SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
  a.attnotnull AS notnull FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`, [TABLE])).rows;
/** The file as the owner; returns the error or null, and the notices. */
async function runFile(connectAs) {
  const owner = await connectAs('checksops_admin');
  const notices = [];
  owner.on('notice', (n) => notices.push(n.message));
  try {
    await owner.query(TEXT);
    return { error: null, notices };
  } catch (error) {
    return { error, notices };
  } finally {
    await owner.end();
  }
}

test('PostgreSQL 16: production-like, SQL 170 through its production tool: the API role records sends, delivery reports and openings through the functions only; re-run a no-op', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql170-prod-', 60370, [ENDORSEMENTS], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  assert.equal(s.live_definition_sha256, ABSENT_PRE);
  const pin = authorized(PIN, s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const cols = await columns(admin);
  assert.deepEqual(cols.slice(-8).map((c) => [c.name, c.type, c.notnull]), [
    ['email_message_id', 'text', false], ['email_delivered_at', 'timestamp with time zone', false],
    ['email_bounced_at', 'timestamp with time zone', false], ['email_bounce_reason', 'text', false],
    ['email_complained_at', 'timestamp with time zone', false], ['link_first_opened_at', 'timestamp with time zone', false],
    ['link_last_opened_at', 'timestamp with time zone', false], ['link_open_count', 'integer', true],
  ]);
  const start = await rows(admin);
  assert.deepEqual(start.map((r) => [r.id, r.status, r.link_open_count, r.email_message_id]), [[E1, 'sent', 0, null], [E2, 'pending', 0, null]]);

  // Only checksops (and the owner) may execute them.
  const acl = (await admin.query(`SELECT p.proname, p.prosecdef, p.proacl::text[] AS acl FROM pg_catalog.pg_proc p
    WHERE p.proname LIKE 'aws_endorsement_%' ORDER BY 1`)).rows;
  assert.deepEqual(acl.map((r) => r.proname), ['aws_endorsement_email_event', 'aws_endorsement_email_sent', 'aws_endorsement_link_opened']);
  for (const r of acl) {
    assert.equal(r.prosecdef, true);
    assert.deepEqual(r.acl.map((line) => line.split('=')[0]).sort(), ['checksops', 'checksops_admin']);
  }
  const member = await connectAs('sql170_tenant_member');
  try {
    await assert.rejects(member.query(`SELECT public.aws_endorsement_link_opened('${E1}'::uuid)`), /permission denied/);
  } finally {
    await member.end();
  }

  const api = await connectAs('checksops');
  const one = async (sql, params) => (await api.query(sql, params)).rows[0].v;
  try {
    // The API role cannot write the columns itself (RLS has no UPDATE policy for it, and it holds no UPDATE).
    await assert.rejects(api.query(`UPDATE ${TABLE} SET link_open_count = 9 WHERE id = $1::uuid`, [E1]), /permission denied/);
    // A request email was sent.
    assert.equal(await one('SELECT public.aws_endorsement_email_sent($1::uuid, $2) AS v', [E1, ' re_first ']), true);
    assert.equal(await one('SELECT public.aws_endorsement_email_sent($1::uuid, $2) AS v', [E2, '   ']), false, 'a blank id changes nothing');
    assert.equal(await one('SELECT public.aws_endorsement_email_sent($1::uuid, $2) AS v', ['e1700000-0000-4000-8000-0000000000ff', 're_x']), false);
    // Delivery reports: delivered keeps its first time; bounced keeps its first reason; complained; unknown ids are 0.
    const event = (id, ev, at, reason) => one('SELECT public.aws_endorsement_email_event($1, $2, $3::timestamptz, $4) AS v', [id, ev, at, reason]);
    assert.equal(await event('re_first', 'delivered', '2026-11-19T02:00:00Z', null), 1);
    assert.equal(await event('re_first', 'DELIVERED', '2026-11-19T03:00:00Z', null), 1);
    assert.equal(await event('re_first', 'bounced', '2026-11-19T04:00:00Z', `  ${'x'.repeat(400)}  `), 1);
    assert.equal(await event('re_first', 'bounced', '2026-11-19T05:00:00Z', 'second reason'), 1);
    assert.equal(await event('re_first', 'complained', null, null), 1);
    assert.equal(await event('re_unknown', 'delivered', null, null), 0);
    assert.equal(await event('', 'delivered', null, null), 0);
    await assert.rejects(event('re_first', 'opened', null, null), (error) => error.code === '22023' && /invalid_email_event/.test(error.message));
    // The opened link.
    assert.equal(await one('SELECT public.aws_endorsement_link_opened($1::uuid) AS v', [E1]), 1);
    assert.equal(await one('SELECT public.aws_endorsement_link_opened($1::uuid) AS v', [E1]), 2);
    assert.equal(await one('SELECT public.aws_endorsement_link_opened($1::uuid) AS v', ['e1700000-0000-4000-8000-0000000000ff']), null);
  } finally {
    await api.end();
  }
  const [r1, r2] = await rows(admin);
  assert.deepEqual({ ...r1, email_complained_at: Boolean(r1.email_complained_at) }, {
    id: E1, status: 'sent', token: 'tok-1', signed_at: null, updated_at: start[0].updated_at,
    email_message_id: 're_first', email_delivered_at: '2026-11-19 02:00:00+00', email_bounced_at: '2026-11-19 04:00:00+00',
    email_bounce_reason: 'x'.repeat(300), email_complained_at: true, first_set: true, last_after_first: true, link_open_count: 2,
  });
  assert.deepEqual(r2, start[1], 'the other request is untouched');

  // A resend starts a fresh status; the openings stay.
  const api2 = await connectAs('checksops');
  try {
    assert.equal((await api2.query('SELECT public.aws_endorsement_email_sent($1::uuid, $2) AS v', [E1, 're_second'])).rows[0].v, true);
    assert.equal((await api2.query("SELECT public.aws_endorsement_email_event('re_first', 'delivered', NULL, NULL) AS v")).rows[0].v, 0,
      'a report for the earlier email no longer matches');
  } finally {
    await api2.end();
  }
  const [fresh] = await rows(admin);
  assert.deepEqual([fresh.email_message_id, fresh.email_delivered_at, fresh.email_bounced_at, fresh.email_bounce_reason, fresh.email_complained_at, fresh.link_open_count],
    ['re_second', null, null, null, null, 2]);

  // Again: a no-op; the tool refuses a re-apply.
  const again = await runFile(connectAs);
  assert.equal(again.error, null);
  assert.ok(again.notices.includes('sql170_already_current'), JSON.stringify(again.notices));
  const reapply = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(reapply.ok, false);
  assert.ok([CODES.DEPLOYMENT_COLLISION, CODES.SQL_COLLISION, CODES.UNRELATED_MUTATION].includes(reapply.code), reapply.code);
}));

test('PostgreSQL 16: the file refuses, and changes nothing, on a conflicting column or a missing table', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql170-refuse-', 60470, [ENDORSEMENTS], async ({ admin, connectAs }) => {
  const functions = async () => (await admin.query("SELECT count(*)::int AS n FROM pg_catalog.pg_proc WHERE proname LIKE 'aws_endorsement_%'")).rows[0].n;
  for (const [alter, undo] of [
    [`ALTER TABLE ${TABLE} ADD COLUMN email_bounce_reason varchar(10)`, `ALTER TABLE ${TABLE} DROP COLUMN email_bounce_reason`],
    [`ALTER TABLE ${TABLE} ADD COLUMN link_open_count integer`, `ALTER TABLE ${TABLE} DROP COLUMN link_open_count`],
    [`ALTER TABLE ${TABLE} ADD COLUMN link_open_count integer NOT NULL DEFAULT 1`, `ALTER TABLE ${TABLE} DROP COLUMN link_open_count`],
    [`ALTER TABLE ${TABLE} ADD COLUMN email_delivered_at timestamp`, `ALTER TABLE ${TABLE} DROP COLUMN email_delivered_at`],
  ]) {
    await admin.query(alter);
    const before = (await columns(admin)).map((c) => c.name);
    const { error } = await runFile(connectAs);
    assert.ok(error, alter);
    assert.equal(error.code, '55000', alter);
    assert.match(error.message, /^sql170_column_conflict: /, alter);
    assert.deepEqual((await columns(admin)).map((c) => c.name), before, alter);
    assert.equal(await functions(), 0, alter);
    await admin.query(undo);
  }
  assert.ok((await columns(admin)).every((c) => !NEW_COLUMNS.includes(c.name)));
  await admin.query(`ALTER TABLE ${TABLE} RENAME TO check_endorsements_gone`);
  const { error } = await runFile(connectAs);
  assert.equal(error?.code, '55000');
  assert.match(error.message, /^sql170_prerequisite_missing: public\.check_endorsements/);
  assert.equal(await functions(), 0);
}));
