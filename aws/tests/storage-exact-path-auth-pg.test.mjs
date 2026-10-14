/**
 * claim-files read authorization (storage.mjs BUCKET_AUTH_SQL) run against
 * PostgreSQL 16. A visible row must hold exactly the requested object (raw,
 * bucket-prefixed, with a query string, or as a Supabase storage URL). A row
 * whose path merely ENDS with another tenant's key must not authorize it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { BUCKET_AUTH_SQL } from '../functions/api/storage.mjs';
import { normalizePath, pathCandidates } from '../functions/api/storage-paths.mjs';

const PG_BIN = '/usr/lib/postgresql/16/bin';
const OWN = 'c0000000-0000-4000-8000-000000000001';
const VICTIM = 'c0000000-0000-4000-8000-000000000002';
const VICTIM_KEY = `checks/${VICTIM}/front.jpg`;

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

test('no claim-files authorization query matches a path by suffix', () => {
  for (const sql of BUCKET_AUTH_SQL['claim-files']) {
    assert.doesNotMatch(sql, /LIKE '%' \|\| \$2/, sql.slice(0, 80));
  }
});

test('PostgreSQL 16: claim-files reads need an exact stored path; suffix rows no longer authorize', { timeout: 120000, skip: pgSkip }, async (t) => {
  const { default: pg } = await import('pg');
  const server = serverUser || {};
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-storage-auth-'));
  if (serverUser) fs.chownSync(pgData, serverUser.uid, serverUser.gid);
  const port = 57990 + (process.pid % 9);
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
      CREATE TABLE check_files (file_path text);
      CREATE TABLE claim_files (file_path text);
      CREATE TABLE check_intake_items (front_image_path text, back_image_path text, back_image_original_path text, back_image_deposit_path text);
      CREATE TABLE homeowner_check_uploads (file_path text);
      CREATE TABLE signature_requests (document_path text, final_pdf_path text);
      CREATE TABLE cash_job_attachments (file_path text);`);
    const authorized = async (requested) => {
      const rel = normalizePath(requested, 'claim-files');
      for (const sql of BUCKET_AUTH_SQL['claim-files']) {
        if ((await client.query(sql, [pathCandidates('claim-files', requested), rel])).rows.length) return true;
      }
      return false;
    };
    const reset = () => client.query(`TRUNCATE check_files, claim_files, check_intake_items, homeowner_check_uploads, signature_requests, cash_job_attachments`);

    // The attack: a visible row whose path ends with the victim's key.
    for (const [table, column] of [
      ['signature_requests', 'document_path'], ['check_files', 'file_path'], ['claim_files', 'file_path'],
      ['check_intake_items', 'front_image_path'], ['check_intake_items', 'back_image_deposit_path'],
      ['cash_job_attachments', 'file_path'],
    ]) {
      await reset();
      await client.query(`INSERT INTO ${table} (${column}) VALUES ($1)`, [`checks/${OWN}/x/${VICTIM_KEY}`]);
      assert.equal(await authorized(VICTIM_KEY), false, `${table}.${column} suffix`);
      assert.equal(await authorized(`checks/${OWN}/x/${VICTIM_KEY}`), true, `${table}.${column} own exact`);
    }

    // Legitimate stored forms still authorize the same object.
    for (const stored of [
      VICTIM_KEY,
      `claim-files/${VICTIM_KEY}`,
      `${VICTIM_KEY}?token=abc`,
      `/${VICTIM_KEY}`,
      `https://proj.supabase.co/storage/v1/object/sign/claim-files/${VICTIM_KEY}?token=x`,
      `https://proj.supabase.co/storage/v1/object/public/claim-files/${VICTIM_KEY}`,
    ]) {
      await reset();
      await client.query('INSERT INTO check_files (file_path) VALUES ($1)', [stored]);
      assert.equal(await authorized(VICTIM_KEY), true, stored);
    }
    // A different file of the same check does not authorize the image.
    await reset();
    await client.query('INSERT INTO check_files (file_path) VALUES ($1)', [`checks/${VICTIM}/back.jpg`]);
    assert.equal(await authorized(VICTIM_KEY), false);
  } finally {
    await client.end();
  }
});
