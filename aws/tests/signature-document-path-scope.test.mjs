/**
 * A signature request's document_path must be a file of the request's own
 * check or claim. Storage grants read access to any signature_requests path the
 * caller can see, so an unscoped path let one tenant read another's file.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  authorizeSignatureDocumentPath,
  executeSignatureRequests,
} from '../functions/api/write-signature.mjs';

const CHECK = 'c0000000-0000-4000-8000-000000000001';
const OTHER_CHECK = 'c0000000-0000-4000-8000-000000000002';
const CLAIM = 'a0000000-0000-4000-8000-000000000001';
const OTHER_CLAIM = 'a0000000-0000-4000-8000-000000000002';

/** Fake client: the check links CLAIM; `filesFound` answers the ownership lookup. */
function fakeClient({ filesFound = false } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      const text = String(sql);
      seen.push(text);
      if (/FROM public\.check_intake_items WHERE id/.test(text)) {
        return { rows: params[0] === CHECK ? [{ id: CHECK, claim_id: CLAIM }] : [] };
      }
      if (/FROM public\.claims WHERE id/.test(text)) {
        return { rows: [CLAIM, OTHER_CLAIM].includes(params[0]) ? [{ id: params[0] }] : [] };
      }
      if (/FROM public\.check_files/.test(text)) return { rows: filesFound ? [{ '?column?': 1 }] : [] };
      if (/INSERT INTO public\.signature_requests/.test(text)) return { rows: [{ id: 'new', document_path: params[3] }] };
      throw new Error(`unexpected SQL ${text.slice(0, 60)}`);
    },
  };
}

const insert = (client, values) => executeSignatureRequests({
  client,
  op: 'insert',
  values: { document_name: 'Authorization.pdf', ...values },
});
const inserted = (client) => client.seen.some((text) => /INSERT INTO public\.signature_requests/.test(text));

test('another check or claim\'s file is refused and nothing is inserted', async () => {
  for (const documentPath of [
    `checks/${OTHER_CHECK}/front.jpg`,
    `check-intake/${OTHER_CHECK}/files/report.pdf`,
    `signatures/${OTHER_CLAIM}/1-doc.pdf`,
    'tenant-b/anything.pdf',
    `checks/${CHECK}/../${OTHER_CHECK}/front.jpg`,
  ]) {
    const client = fakeClient();
    const result = await insert(client, { check_intake_item_id: CHECK, document_path: documentPath });
    assert.equal(result.error === 'not_authorized' || result.error === 'invalid_field', true, `${documentPath}: ${JSON.stringify(result)}`);
    assert.equal(inserted(client), false, documentPath);
  }
});

test('the request\'s own check folders and claim signature folder are accepted without a lookup', async () => {
  for (const documentPath of [
    `check-intake/${CHECK}/payment-direction-1.pdf`,
    `check-intake/${CHECK}/files/upload.pdf`,
    `checks/${CHECK}/front.jpg`,
    `checks/reupload/${CHECK}/front.jpg`,
    `signatures/${CLAIM}/123-authorization.pdf`,
  ]) {
    const client = fakeClient();
    const result = await insert(client, { check_intake_item_id: CHECK, document_path: documentPath });
    assert.equal(result.error, undefined, `${documentPath}: ${JSON.stringify(result)}`);
    assert.equal(inserted(client), true, documentPath);
    assert.equal(client.seen.some((text) => /FROM public\.check_files/.test(text)), false, documentPath);
  }
  // Claim-only request (no check) uses the claim's own signature folder.
  const claimOnly = fakeClient();
  const result = await insert(claimOnly, { claim_id: OTHER_CLAIM, document_path: `signatures/${OTHER_CLAIM}/1.pdf` });
  assert.equal(result.error, undefined, JSON.stringify(result));
  const crossed = fakeClient();
  assert.equal((await insert(crossed, { claim_id: OTHER_CLAIM, document_path: `signatures/${CLAIM}/1.pdf` })).error, 'not_authorized');
  assert.equal(inserted(crossed), false);
});

test('a file recorded on the request\'s own check or claim is accepted', async () => {
  const client = fakeClient({ filesFound: true });
  const result = await insert(client, { check_intake_item_id: CHECK, document_path: 'claims/attachments/report.pdf' });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(inserted(client), true);
});

// initdb refuses to run as root; run the server binaries as 'ubuntu' then.
const PG_BIN = '/usr/lib/postgresql/16/bin';
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

test('PostgreSQL 16: the ownership lookup matches only the request\'s own check and claim files; loss-draft paths are not trusted', { timeout: 120000, skip: pgSkip }, async (t) => {
  const { default: pg } = await import('pg');
  const server = serverUser || {};
  const pgData = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-sig-path-'));
  if (serverUser) fs.chownSync(pgData, serverUser.uid, serverUser.gid);
  const port = 57900 + (process.pid % 90);
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
      CREATE TABLE public.check_files (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, file_path text);
      CREATE TABLE public.claim_files (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid, file_path text);
      CREATE TABLE public.loss_draft_tracking (id uuid PRIMARY KEY, claim_id uuid NOT NULL, check_intake_item_id uuid);
      CREATE TABLE public.loss_draft_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), loss_draft_id uuid, file_path text);
      INSERT INTO public.check_files (check_intake_item_id, file_path) VALUES ('${CHECK}', 'own/check.pdf'), ('${OTHER_CHECK}', 'other/check.pdf');
      INSERT INTO public.claim_files (claim_id, file_path) VALUES ('${CLAIM}', 'own/claim.pdf?token=x'), ('${OTHER_CLAIM}', 'other/claim.pdf');
      INSERT INTO public.loss_draft_tracking (id, claim_id) VALUES ('d0000000-0000-4000-8000-000000000001', '${CLAIM}'), ('d0000000-0000-4000-8000-000000000002', '${OTHER_CLAIM}');
      INSERT INTO public.loss_draft_documents (loss_draft_id, file_path) VALUES
        ('d0000000-0000-4000-8000-000000000001', 'own/loss.pdf'), ('d0000000-0000-4000-8000-000000000002', 'other/loss.pdf');`);
    const ask = (p, ids) => authorizeSignatureDocumentPath(client, { path: p, ...ids });
    const own = { claimId: CLAIM, checkId: CHECK };
    assert.equal(await ask('own/check.pdf', own), true);
    assert.equal(await ask('own/claim.pdf', own), true);
    // A member can set loss_draft_documents.file_path to anything, so it never authorizes.
    assert.equal(await ask('own/loss.pdf', own), false);
    assert.equal(await ask('own/claim.pdf', { claimId: CLAIM, checkId: null }), true);
    assert.equal(await ask('own/check.pdf', { claimId: CLAIM, checkId: null }), false);
    for (const foreign of ['other/check.pdf', 'other/claim.pdf', 'other/loss.pdf', 'missing.pdf']) {
      assert.equal(await ask(foreign, own), false, foreign);
    }
  } finally {
    await client.end();
  }
});
