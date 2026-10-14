/**
 * Uploads and deletes for tenant-logos, company-branding and homeowner-uploads
 * used to accept any short path from any member of any tenant (with upsert and
 * delete). Logos are now scoped to the caller's own tenant, the shared
 * company-branding folder is add-only for members, and homeowner check photos
 * are written only by the server-side homeowner portal.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authorizeStorageWritePath } from '../functions/api/storage-write-auth.mjs';

const USER = 'b0000000-0000-4000-8000-000000000001';
const OWN = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';

function fakeClient({ platformOwner = false } = {}) {
  return {
    async query(sql, params = []) {
      const text = String(sql);
      if (/is_platform_owner/.test(text)) return { rows: [{ is_platform: platformOwner, is_master: false }] };
      if (/FROM public\.tenant_users WHERE user_id = \$1::uuid AND tenant_id/.test(text)) {
        return { rows: params[1] === OWN ? [{ '?column?': 1 }] : [] };
      }
      if (/FROM public\.tenant_users WHERE user_id = \$1::uuid LIMIT 1/.test(text)) return { rows: [{ '?column?': 1 }] };
      throw new Error(`unexpected SQL ${text.slice(0, 70)}`);
    },
  };
}

const auth = (bucket, path, opts) => authorizeStorageWritePath(fakeClient(opts), bucket, path, USER);

test('tenant-logos: only {own tenant}/{file}; platform owners may write any tenant', async () => {
  assert.equal((await auth('tenant-logos', `${OWN}/logo-1.png`)).ok, true);
  assert.equal((await auth('tenant-logos', `${OWN}/1.png`)).ok, true);
  for (const path of [`${OTHER}/logo-1.png`, 'logo.png', `${OWN}/nested/logo.png`, `x/${OWN}/logo.png`]) {
    assert.equal((await auth('tenant-logos', path)).ok, false, path);
  }
  assert.equal((await auth('tenant-logos', `${OTHER}/logo-1.png`, { platformOwner: true })).ok, true);
});

test('company-branding: members may only add new timestamped letterheads (create-only)', async () => {
  for (const path of ['letterhead_1739999999999.png', 'invoice_letterhead_1739999999999.pdf']) {
    const result = await auth('company-branding', path);
    assert.equal(result.ok, true, path);
    assert.equal(result.createOnly, true, path);
  }
  for (const path of [`${OTHER}/logo.png`, 'logo.png', 'letterhead_x.png', 'a/letterhead_1.png']) {
    assert.equal((await auth('company-branding', path)).ok, false, path);
  }
  const owner = await auth('company-branding', 'letterhead_1.png', { platformOwner: true });
  assert.equal(owner.ok, true);
  assert.equal(owner.createOnly, undefined);
});

test('homeowner-uploads: no client uploads or deletes', async () => {
  for (const path of ['homeowner/lead/1_front.jpg', 'ledger/claim/1_front.jpg']) {
    const result = await auth('homeowner-uploads', path);
    assert.equal(result.ok, false, path);
    assert.equal(result.error, 'bucket_not_allowed', path);
  }
});
