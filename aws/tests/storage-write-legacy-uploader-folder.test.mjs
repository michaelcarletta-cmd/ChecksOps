/**
 * Owner 2026-11-24: two old Brosonski checks fail to deposit with "The bank-ready image couldn't
 * be saved". The deposit writes the official front image next to the stored front photo
 * (toCheckAltPath(front_image_path), which the CheckAlt submit requires). Lovable/Supabase-era
 * photos live under checks/<uploader user id>/<claim>/ (production count, SSM
 * 5215ffed-9da5-4ef1-be06-301660e6a4ca), so the storage gate read the uploader id as a check id
 * and refused. It now falls back to the check that stores that exact path, when the caller may
 * write it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authorizeStorageWritePath } from '../functions/api/storage-write-auth.mjs';

const CHECK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const UPLOADER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER = '9b2f1c7e-1d1a-4f5e-9a51-3c2d7e6b8a10';
const FRONT = `checks/${UPLOADER}/claim-1/front.jpg`;
const CHECK_ROW = {
  id: CHECK,
  tenant_id: '11111111-1111-4111-8111-111111111111',
  front_image_path: FRONT,
  back_image_path: `checks/${UPLOADER}/claim-1/back.jpg`,
  back_image_deposit_path: `checks/${CHECK}/endorsed_deposit_abc.checkalt.jpg`,
  endorsement_render_meta: null,
};

// The SQL sibling rule, evaluated in JS for the fixture: stored path, or its .deposit2/.checkalt.
const matchesStored = (row, rel) => ['front_image_path', 'back_image_path', 'back_image_deposit_path']
  .some((col) => {
    const p = String(row[col] || '').split('?')[0];
    if (!p) return false;
    const stem = p.replace(/\.[^.]+$/, '');
    return p === rel || `${stem}.deposit2.jpg` === rel || `${stem}.checkalt.jpg` === rel;
  });

const client = ({ rows = [CHECK_ROW], writable = new Set([CHECK]) } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push(sql);
      if (/is_platform_owner|is_master_owner/.test(sql)) return { rows: [{ is_platform: false, is_master: false }] };
      if (/aws_can_write_check/.test(sql)) return { rows: [{ ok: writable.has(params[0]) }] };
      if (/WHERE id = \$1::uuid/.test(sql)) return { rows: rows.filter((r) => r.id === params[0]) };
      if (/split_part\(front_image_path/.test(sql)) return { rows: rows.filter((r) => matchesStored(r, params[0])) };
      return { rows: [] };
    },
  };
};

test('the bank-ready front copy next to a legacy uploader-folder photo is allowed for a writer of the check', async () => {
  const rel = `checks/${UPLOADER}/claim-1/front.checkalt.jpg`;
  const result = await authorizeStorageWritePath(client(), 'claim-files', rel, UPLOADER);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.strategy, 'existing_check_image_or_deposit2');
  assert.equal(result.check.id, CHECK);
  assert.equal(result.rel, rel);
});

test('the .deposit2.jpg sibling and the stored photo itself are allowed the same way', async () => {
  for (const rel of [`checks/${UPLOADER}/claim-1/front.deposit2.jpg`, FRONT, `checks/${UPLOADER}/claim-1/back.checkalt.jpg`]) {
    const result = await authorizeStorageWritePath(client(), 'claim-files', rel, UPLOADER);
    assert.equal(result.ok, true, `${rel}: ${JSON.stringify(result)}`);
  }
});

test('a caller who cannot write the check is refused', async () => {
  const rel = `checks/${UPLOADER}/claim-1/front.checkalt.jpg`;
  const result = await authorizeStorageWritePath(client({ writable: new Set() }), 'claim-files', rel, UPLOADER);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'rls_denied');
});

test('any other file in the uploader folder is still refused', async () => {
  for (const rel of [
    `checks/${UPLOADER}/claim-1/new-file.jpg`,
    `checks/${UPLOADER}/claim-1/endorsed_deposit_x.checkalt.jpg`,
    `checks/${UPLOADER}/claim-2/front.checkalt.jpg`,
    `checks/${OTHER}/front.checkalt.jpg`,
  ]) {
    const result = await authorizeStorageWritePath(client(), 'claim-files', rel, UPLOADER);
    assert.equal(result.ok, false, rel);
    assert.equal(result.error, 'rls_denied', rel);
  }
});

test('a path scoped to the check itself still uses the check rule', async () => {
  const rel = `checks/${CHECK}/endorsed_deposit_abc.checkalt.jpg`;
  const result = await authorizeStorageWritePath(client(), 'claim-files', rel, UPLOADER);
  assert.equal(result.ok, true);
  assert.equal(result.strategy, 'check');
});

test('the fallback is claim-files only', async () => {
  const rel = `checks/${UPLOADER}/claim-1/front.checkalt.jpg`;
  const c = client();
  const result = await authorizeStorageWritePath(c, 'endorsement-packets', rel, UPLOADER);
  assert.equal(result.ok, false);
  assert.ok(!c.calls.some((sql) => /split_part\(front_image_path/.test(sql)));
});
