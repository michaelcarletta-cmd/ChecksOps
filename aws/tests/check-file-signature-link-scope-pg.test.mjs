/**
 * check_files.signature_request_id may only link a signature request of the
 * file's own check (or, for a claim-only request, that check's claim). Run
 * against PostgreSQL 16.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { executeCheckFiles } from '../functions/api/write-check-workflow.mjs';

const PG_BIN = '/usr/lib/postgresql/16/bin';
const CHECK = 'c0000000-0000-4000-8000-000000000001';
const OTHER_CHECK = 'c0000000-0000-4000-8000-000000000002';
const CLAIM = 'a0000000-0000-4000-8000-000000000001';
const OTHER_CLAIM = 'a0000000-0000-4000-8000-000000000002';
const FILE = 'f0000000-0000-4000-8000-000000000001';
const OWN_REQ = 'e0000000-0000-4000-8000-000000000001';
const OWN_CLAIM_REQ = 'e0000000-0000-4000-8000-000000000002';
const FOREIGN_REQ = 'e0000000-0000-4000-8000-000000000003';
const FOREIGN_CLAIM_REQ = 'e0000000-0000-4000-8000-000000000004';

// initdb refuses to run as root; run the server binaries as 'ubuntu' then.
const serverUser = (() => {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('ubuntu:'));
  if (!line) return null;
  const [, , uid, gid] = line.split(':');
  return { uid: Number(uid), gid: Number(gid) };
})();
const pgSkip = (() => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return 'PostgreSQL 16 binaries not installed';
  if (typeof process.getuid === 'function' && process.getuid() === 0 && !serverUser) return 'initdb cannot run as root and no ubuntu account exists';
  return false;
})();
const run = (bin, args, opts = {}) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...opts });

test('PostgreSQL 16: check_files links only its own check\'s (or claim\'s) signature request', { timeout: 120000, skip: pgSkip }, async (t) => {
  const { default: pg } = await import('pg');
  const server = serverUser || {};
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-file-sig-link-'));
  if (serverUser) fs.chownSync(pgData, serverUser.uid, serverUser.gid);
  const port = 58100 + (process.pid % 90);
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
      CREATE TABLE public.check_intake_items (id uuid PRIMARY KEY, tenant_id uuid, claim_id uuid);
      CREATE TABLE public.signature_requests (id uuid PRIMARY KEY, check_intake_item_id uuid, claim_id uuid);
      CREATE TABLE public.check_files (id uuid PRIMARY KEY, check_intake_item_id uuid, description text, category text,
        signature_request_id uuid REFERENCES public.signature_requests (id));
      INSERT INTO public.check_intake_items VALUES ('${CHECK}', gen_random_uuid(), '${CLAIM}'), ('${OTHER_CHECK}', gen_random_uuid(), '${OTHER_CLAIM}');
      INSERT INTO public.signature_requests VALUES
        ('${OWN_REQ}', '${CHECK}', '${CLAIM}'), ('${OWN_CLAIM_REQ}', NULL, '${CLAIM}'),
        ('${FOREIGN_REQ}', '${OTHER_CHECK}', '${OTHER_CLAIM}'), ('${FOREIGN_CLAIM_REQ}', NULL, '${OTHER_CLAIM}');
      INSERT INTO public.check_files (id, check_intake_item_id) VALUES ('${FILE}', '${CHECK}');`);
    const link = (signature_request_id) => executeCheckFiles({
      client, mapping: {}, op: 'update', values: { signature_request_id }, filters: [{ column: 'id', op: 'eq', value: FILE }],
    });
    const linked = async () => (await client.query('SELECT signature_request_id FROM public.check_files WHERE id = $1', [FILE])).rows[0].signature_request_id;

    for (const foreign of [FOREIGN_REQ, FOREIGN_CLAIM_REQ, 'e0000000-0000-4000-8000-000000000009']) {
      assert.equal((await link(foreign)).error, 'rls_denied', foreign);
      assert.equal(await linked(), null, foreign);
    }
    for (const own of [OWN_REQ, OWN_CLAIM_REQ]) {
      const result = await link(own);
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(await linked(), own);
    }
    // Unlinking stays allowed.
    assert.equal((await link(null)).error, undefined);
    assert.equal(await linked(), null);
  } finally {
    await client.end();
  }
});
