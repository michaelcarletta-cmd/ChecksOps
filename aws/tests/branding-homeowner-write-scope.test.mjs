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

test('tenant-logos and company-branding: a stored logo_url/letterhead_url never authorizes delete or move', async () => {
  const { handleStorageDelete, handleStorageMove } = await import('../functions/api/storage-write.mjs');
  const { LOOKUP_MAPPING_SQL } = await import('../functions/api/identity.mjs');
  process.env.FILES_BUCKET = process.env.FILES_BUCKET || 'files-test';
  const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
  const victimLogo = `${OTHER}/logo-1.png`;
  const victimLetterhead = 'letterhead_1739999999999.png';
  // The caller's own tenant row points logo_url at another tenant's key, and a
  // letterhead row is visible: neither may authorize the object.
  const client = {
    connect: async () => {},
    end: async () => {},
    async query(sql, params = []) {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT') return { rows: [] };
      if (text.startsWith('SELECT set_config')) return { rows: [{}] };
      if (text === LOOKUP_MAPPING_SQL) return { rows: [{ application_user_id: USER, cognito_sub: SUB, status: 'active' }] };
      if (/is_platform_owner/.test(text)) return { rows: [{ is_platform: false, is_master: false }] };
      if (/tenant_users WHERE user_id = \$1::uuid AND tenant_id/.test(text)) return { rows: params[1] === OWN ? [{}] : [] };
      if (/FROM tenants|FROM public\.tenants|company_branding/.test(text)) return { rows: [{}] };
      return { rows: [] };
    },
  };
  const sent = [];
  const deps = {
    forceStorageWrites: true,
    loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'x', host: 'h' }),
    createClient: () => client,
    s3: {
      async send(command) {
        sent.push(command.constructor.name);
        if (command.constructor.name === 'HeadObjectCommand') {
          const error = new Error('NotFound');
          error.name = 'NotFound';
          throw error;
        }
        return {};
      },
    },
  };
  const event = (path, body) => ({
    rawPath: path,
    headers: { authorization: 'Bearer t' },
    body: JSON.stringify(body),
    requestContext: { stage: 'staging', http: { method: 'POST', path }, authorizer: { jwt: { claims: { sub: SUB, token_use: 'id' } } } },
  });
  for (const [bucket, path, to] of [
    ['tenant-logos', victimLogo, `${OWN}/stolen.png`],
    ['company-branding', victimLetterhead, 'letterhead_1740000000000.png'],
  ]) {
    const del = await handleStorageDelete(event('/storage/delete', { bucket, path }), deps);
    assert.equal(del.error, 'storage_forbidden', `${bucket} delete: ${JSON.stringify(del)}`);
    const move = await handleStorageMove(event('/storage/move', { bucket, from: path, to }), deps);
    assert.equal(move.error, 'storage_forbidden', `${bucket} move: ${JSON.stringify(move)}`);
  }
  assert.deepEqual(sent.filter((name) => /Delete|Copy/.test(name)), []);
  // The caller's own logo is still deletable.
  const own = await handleStorageDelete(event('/storage/delete', { bucket: 'tenant-logos', path: `${OWN}/logo-1.png` }), deps);
  assert.equal(own.ok, true, JSON.stringify(own));
});
