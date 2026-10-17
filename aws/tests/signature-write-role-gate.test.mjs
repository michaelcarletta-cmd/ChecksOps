/**
 * The generic /data/write path for signature_requests and signature_signers is
 * gated by tenant role, not only by RLS: viewers and partner tenants that can
 * see a check or claim must not prepare requests or add signers.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { executeSignatureWrite } from '../functions/api/write-signature.mjs';

const CHECK = 'c0000000-0000-4000-8000-000000000001';
const CLAIM = 'a0000000-0000-4000-8000-000000000001';
const ORGLESS_CLAIM = 'a0000000-0000-4000-8000-000000000003';
const TENANT = 'b0000000-0000-4000-8000-000000000001';
const OTHER_TENANT = 'b0000000-0000-4000-8000-000000000002';
const REQUEST = 'e0000000-0000-4000-8000-000000000001';
const USER = 'd0000000-0000-4000-8000-000000000001';

function fakeClient({ role = 'operator', canWrite = true, platformOwner = false, requestStatus = 'draft', memberTenant = TENANT } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params = []) {
      const text = String(sql);
      seen.push({ text, params });
      if (/FROM public\.check_intake_items WHERE id/.test(text)) {
        return { rows: params[0] === CHECK ? [{ id: CHECK, claim_id: CLAIM, tenant_id: TENANT }] : [] };
      }
      if (/FROM public\.claims WHERE id/.test(text)) {
        if (params[0] === CLAIM) return { rows: [{ id: CLAIM, org_id: TENANT }] };
        if (params[0] === ORGLESS_CLAIM) return { rows: [{ id: ORGLESS_CLAIM, org_id: null }] };
        return { rows: [] };
      }
      if (/FROM public\.check_intake_items\s+WHERE claim_id/.test(text)) {
        return { rows: [{ tenant_id: OTHER_TENANT }, { tenant_id: TENANT }] };
      }
      if (/aws_can_write_tenant/.test(text)) return { rows: [{ ok: canWrite }] };
      if (/FROM public\.tenant_users/.test(text)) {
        const allowed = ['owner', 'admin', 'manager', 'operator'].includes(role) && params[1] === memberTenant;
        return { rows: allowed ? [{ '?column?': 1 }] : [] };
      }
      if (/is_platform_owner/.test(text)) return { rows: [{ is_owner: platformOwner }] };
      if (/FROM public\.signature_requests WHERE id/.test(text)) {
        return { rows: params[0] === REQUEST ? [{ id: REQUEST, claim_id: CLAIM, check_intake_item_id: CHECK, status: requestStatus }] : [] };
      }
      if (/INSERT INTO public\.signature_requests/.test(text)) return { rows: [{ id: REQUEST }] };
      if (/INSERT INTO public\.signature_signers/.test(text)) return { rows: [{ id: 'signer' }] };
      throw new Error(`unexpected SQL ${text.slice(0, 60)}`);
    },
  };
}

const inserted = (client, table) => client.seen.some(({ text }) => new RegExp(`INSERT INTO public\\.${table}`).test(text));
const mapping = { application_user_id: USER };

const createRequest = (client, values = {}) => executeSignatureWrite({
  client,
  mapping,
  table: 'signature_requests',
  op: 'insert',
  values: {
    check_intake_item_id: CHECK,
    document_name: 'Authorization.pdf',
    document_path: `check-intake/${CHECK}/payment-direction-1.pdf`,
    ...values,
  },
});

const addSigner = (client) => executeSignatureWrite({
  client,
  mapping,
  table: 'signature_signers',
  op: 'insert',
  values: { signature_request_id: REQUEST, signer_name: 'Pat Homeowner', signer_email: 'pat@example.com' },
});

test('owner, admin, manager and operator members may prepare requests and add signers', async () => {
  for (const role of ['owner', 'admin', 'manager', 'operator']) {
    const client = fakeClient({ role });
    assert.equal((await createRequest(client)).error, undefined, role);
    assert.equal(inserted(client, 'signature_requests'), true, role);
    const signerClient = fakeClient({ role });
    assert.equal((await addSigner(signerClient)).error, undefined, role);
    assert.equal(inserted(signerClient, 'signature_signers'), true, role);
  }
});

test('viewers and partner members are refused before any insert', async () => {
  for (const options of [{ role: 'viewer' }, { role: 'partner' }, { memberTenant: OTHER_TENANT }]) {
    const client = fakeClient(options);
    assert.equal((await createRequest(client)).error, 'not_authorized', JSON.stringify(options));
    assert.equal(inserted(client, 'signature_requests'), false);
    const signerClient = fakeClient(options);
    assert.equal((await addSigner(signerClient)).error, 'not_authorized', JSON.stringify(options));
    assert.equal(inserted(signerClient, 'signature_signers'), false);
  }
});

test('a missing identity or a tenant the caller cannot write is refused', async () => {
  const noIdentity = fakeClient();
  const result = await executeSignatureWrite({
    client: noIdentity,
    mapping: {},
    table: 'signature_signers',
    op: 'insert',
    values: { signature_request_id: REQUEST, signer_name: 'Pat', signer_email: 'pat@example.com' },
  });
  assert.equal(result.error, 'not_authorized');
  assert.equal(inserted(noIdentity, 'signature_signers'), false);

  const readOnly = fakeClient({ canWrite: false, platformOwner: true });
  assert.equal((await createRequest(readOnly)).error, 'not_authorized');
  assert.equal(inserted(readOnly, 'signature_requests'), false);
});

test('the platform owner without membership of the owning tenant may not prepare requests', async () => {
  // Owner policy: members only; the platform owner does not act on tenant signatures.
  const client = fakeClient({ role: null, platformOwner: true });
  assert.equal((await createRequest(client)).error, 'not_authorized');
  assert.equal(inserted(client, 'signature_requests'), false);
  assert.equal(client.seen.some(({ text }) => /is_platform_owner/.test(text)), false);
});

test('signers join only draft requests', async () => {
  for (const status of ['pending', 'sent', 'completed', 'cancelled', null]) {
    const client = fakeClient({ requestStatus: status });
    assert.equal((await addSigner(client)).error, 'not_authorized', String(status));
    assert.equal(inserted(client, 'signature_signers'), false, String(status));
  }
});

test('an org-less claim accepts a member of any tenant whose checks sit on it', async () => {
  const client = fakeClient({ memberTenant: TENANT });
  const result = await executeSignatureWrite({
    client,
    mapping,
    table: 'signature_requests',
    op: 'insert',
    values: {
      claim_id: ORGLESS_CLAIM,
      document_name: 'Release.pdf',
      document_path: `signatures/${ORGLESS_CLAIM}/1-release.pdf`,
    },
  });
  assert.equal(result.error, undefined);
  const outsider = fakeClient({ memberTenant: 'b0000000-0000-4000-8000-000000000009' });
  const refused = await executeSignatureWrite({
    client: outsider,
    mapping,
    table: 'signature_requests',
    op: 'insert',
    values: {
      claim_id: ORGLESS_CLAIM,
      document_name: 'Release.pdf',
      document_path: `signatures/${ORGLESS_CLAIM}/1-release.pdf`,
    },
  });
  assert.equal(refused.error, 'not_authorized');
});
