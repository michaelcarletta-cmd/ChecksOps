/**
 * The production send handler's partner rule, run verbatim against PostgreSQL 16
 * (the fake DB in moov-production-send.test.mjs mirrors it by hand).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_BIN = '/usr/lib/postgresql/16/bin';
const SEND = fs.readFileSync(path.join(ROOT, 'functions/api/providers/production/moov-send.mjs'), 'utf8');
const RULE = (() => {
  const start = SEND.indexOf('const share = (await client.query(');
  const match = SEND.slice(start).match(/`([\s\S]*?)`/);
  assert.ok(start >= 0 && match, 'partner rule not found in moov-send.mjs');
  return match[1];
})();

const CHECK = 'c0000000-0000-4000-8000-000000000001';
const OTHER_CHECK = 'c0000000-0000-4000-8000-000000000002';
const ME = '11111111-1111-4111-8111-111111111111';
const THEM = '22222222-2222-4222-8222-222222222222';
const ELSE = '33333333-3333-4333-8333-333333333333';

// initdb refuses to run as root; run the server binaries as 'ubuntu' then.
const serverUser = (() => {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('ubuntu:'));
  if (!line) return null;
  const [, , uid, gid] = line.split(':');
  return { uid: Number(uid), gid: Number(gid) };
})();
const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });

const pgSkip = (() => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return 'PostgreSQL 16 binaries not installed';
  if (typeof process.getuid === 'function' && process.getuid() === 0 && !serverUser) return 'initdb cannot run as root and no ubuntu account exists';
  return false;
})();

const partnership = (inviter, invitee, extra = {}) => ({ inviter, invitee, status: 'active', revoked_at: null, accepted_at: '2026-10-02', created_at: '2026-10-01', ...extra });
const share = (extra = {}) => ({ check: CHECK, source: ME, target: THEM, revoked_at: null, ...extra });

const CASES = [
  // [name, partnerships, shares, expected]
  ['active share alone', [], [share()], true],
  ['active partnership, inviter side', [partnership(ME, THEM)], [], true],
  ['active partnership, invitee side', [partnership(THEM, ME)], [], true],
  ['pending partnership', [partnership(ME, THEM, { status: 'pending' })], [], false],
  ['declined partnership', [partnership(ME, THEM, { status: 'declined' })], [], false],
  ['active but revoked_at set', [partnership(ME, THEM, { revoked_at: '2026-10-03' })], [], false],
  ['open invite (no invitee)', [partnership(ME, null)], [], false],
  ['partnership with another tenant', [partnership(ME, ELSE)], [], false],
  ['share only partner to sender', [], [share({ source: THEM, target: ME })], false],
  ['un-shared after acceptance', [partnership(ME, THEM)], [share({ revoked_at: '2026-10-05' })], false],
  ['un-shared on another check', [partnership(ME, THEM)], [share({ check: OTHER_CHECK, revoked_at: '2026-10-05' })], true],
  ['un-shared before the reconnect', [partnership(THEM, ME, { accepted_at: '2026-10-07' }), partnership(ME, THEM, { status: 'revoked', revoked_at: '2026-10-03' })], [share({ revoked_at: '2026-10-03' })], true],
  ['other-direction row ended after acceptance', [partnership(THEM, ME), partnership(ME, THEM, { status: 'revoked', revoked_at: '2026-10-05' })], [], false],
  ['other-direction row ended before acceptance', [partnership(THEM, ME, { accepted_at: '2026-10-07' }), partnership(ME, THEM, { status: 'revoked', revoked_at: '2026-10-05' })], [], true],
  ['no accepted_at falls back to created_at', [partnership(ME, THEM, { accepted_at: null, created_at: '2026-10-06' })], [share({ revoked_at: '2026-10-05' })], true],
  ['no timestamps: any un-share blocks', [partnership(ME, THEM, { accepted_at: null, created_at: null })], [share({ revoked_at: '2026-10-05' })], false],
];

test('PostgreSQL 16: the send handler partner rule', { timeout: 120000, skip: pgSkip }, async (t) => {
  const { default: pg } = await import('pg');
  const server = serverUser || {};
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-send-partner-'));
  if (serverUser) fs.chownSync(pgData, serverUser.uid, serverUser.gid);
  const port = 57400 + (process.pid % 1000);
  let started = false;
  t.after(() => {
    if (started) run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-m', 'immediate', 'stop'], server);
    fs.rmSync(pgData, { recursive: true, force: true });
  });
  const init = run(path.join(PG_BIN, 'initdb'), ['-D', pgData, '--auth=trust', '--no-sync', '--username=ubuntu', '--encoding=UTF8'], server);
  assert.equal(init.status, 0, init.stderr);
  fs.appendFileSync(path.join(pgData, 'postgresql.conf'), `\nlisten_addresses = ''\nport = ${port}\nunix_socket_directories = '${pgData}'\nlogging_collector = off\n`);
  const start = run(path.join(PG_BIN, 'pg_ctl'), ['-D', pgData, '-l', path.join(pgData, 'pg.log'), '-w', '-t', '30', 'start'], server);
  assert.equal(start.status, 0, start.stderr);
  started = true;

  const client = new pg.Client({ host: pgData, port, user: 'ubuntu', database: 'postgres' });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE public.tenant_partnerships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inviter_tenant_id uuid NOT NULL, invitee_tenant_id uuid,
        status text NOT NULL, created_at timestamptz, accepted_at timestamptz, revoked_at timestamptz);
      CREATE TABLE public.shared_checks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid NOT NULL, source_tenant_id uuid NOT NULL,
        target_tenant_id uuid NOT NULL, revoked_at timestamptz,
        UNIQUE (check_id, source_tenant_id, target_tenant_id));`);
    for (const [name, partnerships, shares, expected] of CASES) {
      await client.query('BEGIN');
      for (const p of partnerships) {
        await client.query(
          'INSERT INTO public.tenant_partnerships (inviter_tenant_id, invitee_tenant_id, status, created_at, accepted_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [p.inviter, p.invitee, p.status, p.created_at, p.accepted_at, p.revoked_at],
        );
      }
      for (const s of shares) {
        await client.query(
          'INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id, revoked_at) VALUES ($1, $2, $3, $4)',
          [s.check, s.source, s.target, s.revoked_at],
        );
      }
      const { rows } = await client.query(RULE, [CHECK, ME, THEM]);
      await client.query('ROLLBACK');
      assert.equal(rows.length === 1, expected, name);
    }
  } finally {
    await client.end();
  }
});
