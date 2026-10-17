/**
 * send-signature-request action "delete": a tenant member may delete only a
 * draft or unsent request. The generic /data/write allowlist stays insert-only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  handleSendSignatureRequest,
  runDeleteSignatureRequest,
  signatureRequestDeletable,
} from '../functions/api/esign.mjs';
import { WRITE_ALLOWLIST } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '55555555-5555-4555-8555-555555555555';
const CHECK = '3916f620-9d20-499b-8450-9e1a8e70a3c9';
const REQUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const mapping = { application_user_id: USER };
const spoof = { ignored: true };

const client = ({ request, signers = [], member = true, canWrite = true, deleteRowCount = 1 }, seen) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    seen.push({ sql: compact, params });
    if (compact.startsWith('DELETE FROM public.signature_requests')) return { rows: [], rowCount: deleteRowCount };
    if (compact.includes('FROM public.signature_requests')) return { rows: request ? [request] : [] };
    if (compact.includes('FROM public.signature_signers')) return { rows: signers };
    if (compact.includes('FROM public.check_intake_items')) {
      return { rows: [{ id: CHECK, tenant_id: TENANT, check_number: '1' }] };
    }
    if (compact.includes('aws_can_write_tenant')) return { rows: [{ ok: canWrite }] };
    if (compact.includes('FROM public.tenant_users')) return { rows: member ? [{ x: 1 }] : [] };
    return { rows: [], rowCount: 0 };
  },
});

const draft = (over = {}) => ({
  id: REQUEST,
  claim_id: null,
  check_intake_item_id: CHECK,
  status: 'draft',
  sent_at: null,
  final_pdf_path: null,
  delivery_mode: null,
  ...over,
});

const deletes = (seen) => seen.filter((row) => /^DELETE\b/i.test(row.sql));

test('signatureRequestDeletable allows drafts and all-failed unsent requests only', () => {
  assert.equal(signatureRequestDeletable(draft(), [{ status: 'pending' }]), true);
  assert.equal(signatureRequestDeletable(draft({ status: 'failed' }), [{ status: 'pending', delivery_status: 'failed' }]), true);
  assert.equal(signatureRequestDeletable(draft({ status: 'pending' }), []), false);
  assert.equal(signatureRequestDeletable(draft({ status: 'completed' }), []), false);
  assert.equal(signatureRequestDeletable(draft({ status: 'signed' }), []), false);
  assert.equal(signatureRequestDeletable(draft({ sent_at: '2026-10-01T00:00:00Z' }), []), false);
  assert.equal(signatureRequestDeletable(draft({ final_pdf_path: 'signed/x.pdf' }), []), false);
  assert.equal(signatureRequestDeletable(draft({ delivery_mode: 'manual_bypass' }), []), false);
  assert.equal(signatureRequestDeletable(draft(), [{ status: 'signed' }]), false);
  assert.equal(signatureRequestDeletable(draft(), [{ viewed_at: '2026-10-01T00:00:00Z' }]), false);
  assert.equal(signatureRequestDeletable(draft({ status: 'failed' }), [{ delivery_status: 'sent' }]), false);
  assert.equal(signatureRequestDeletable(null, []), false);
});

test('a tenant member deletes a draft request; the DELETE re-checks status in SQL', async () => {
  const seen = [];
  const result = await runDeleteSignatureRequest({
    client: client({ request: draft(), signers: [{ status: 'pending' }] }, seen),
    mapping,
    body: { requestId: REQUEST },
    spoof,
  });
  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  const [del] = deletes(seen);
  assert.ok(del, 'issued a DELETE');
  assert.deepEqual(del.params, [REQUEST]);
  assert.match(del.sql, /status IN \('draft', 'failed'\)/);
  assert.match(del.sql, /sent_at IS NULL/);
  assert.match(del.sql, /final_pdf_path IS NULL/);
  assert.equal(deletes(seen).length, 1, 'only the request row; children cascade');
  assert.equal(seen.some((row) => /storage|s3/i.test(row.sql)), false);
});

for (const [label, request, signers] of [
  ['a sent pending request', draft({ status: 'pending', sent_at: '2026-10-01T00:00:00Z' }), [{ status: 'pending', delivery_status: 'sent' }]],
  ['a completed request', draft({ status: 'completed', final_pdf_path: 'signed/x.pdf' }), [{ status: 'signed' }]],
  ['a manual-bypass request', draft({ status: 'pending', delivery_mode: 'manual_bypass' }), [{ status: 'pending' }]],
  ['a draft a signer already viewed', draft(), [{ status: 'pending', viewed_at: '2026-10-01T00:00:00Z' }]],
]) {
  test(`deleting ${label} returns 409 not_deletable without a DELETE`, async () => {
    const seen = [];
    const result = await runDeleteSignatureRequest({
      client: client({ request, signers }, seen),
      mapping,
      body: { requestId: REQUEST },
      spoof,
    });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal(result.error, 'not_deletable');
    assert.equal(deletes(seen).length, 0);
  });
}

test('a non-member or a caller without tenant write gets 403 and no DELETE', async () => {
  for (const opts of [{ member: false }, { canWrite: false }]) {
    const seen = [];
    const result = await runDeleteSignatureRequest({
      client: client({ request: draft(), ...opts }, seen),
      mapping,
      body: { requestId: REQUEST },
      spoof,
    });
    assert.equal(result.statusCode, 403);
    assert.equal(deletes(seen).length, 0);
  }
});

test('missing or unknown request ids fail closed', async () => {
  const seen = [];
  assert.equal((await runDeleteSignatureRequest({
    client: client({ request: draft() }, seen), mapping, body: { requestId: 'nope' }, spoof,
  })).statusCode, 400);
  assert.equal((await runDeleteSignatureRequest({
    client: client({ request: null }, seen), mapping, body: { requestId: REQUEST }, spoof,
  })).statusCode, 404);
  assert.equal(deletes(seen).length, 0);
});

test('a raced status change (DELETE matched no row) returns 409', async () => {
  const seen = [];
  const result = await runDeleteSignatureRequest({
    client: client({ request: draft(), deleteRowCount: 0 }, seen),
    mapping,
    body: { requestId: REQUEST },
    spoof,
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
});

test('the handler routes action "delete" and the generic allowlist stays insert-only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/esign.mjs'), 'utf8');
  assert.match(src, /String\(ctx\.body\?\.action \|\| ''\) === 'delete'\s*\?\s*runDeleteSignatureRequest\(ctx\)/);
  assert.equal(typeof handleSendSignatureRequest, 'function');
  assert.deepEqual([...WRITE_ALLOWLIST.signature_requests.ops], ['insert']);
  assert.deepEqual([...WRITE_ALLOWLIST.signature_signers.ops], ['insert']);
});

test('the SPA deletes through the server handler and no longer removes the source document', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/components/claim-detail/SignatureRequests.tsx'), 'utf8');
  assert.match(src, /body: \{ action: "delete", requestId: request\.id \}/);
  assert.equal(/from\("signature_requests"\)\s*\.delete\(\)/.test(src), false);
  assert.equal(/\.remove\(\[request\.document_path\]\)/.test(src), false);
  assert.match(src, /canDeleteSignatureRequest\(request\) && \(/);
});

test('delete locks the request and its signers FOR UPDATE and re-checks signers in the DELETE', async () => {
  const seen = [];
  const result = await runDeleteSignatureRequest({
    client: client({ request: draft(), signers: [{ status: 'pending' }] }, seen),
    mapping,
    body: { requestId: REQUEST },
    spoof,
  });
  assert.equal(result.ok, true);
  const lockRequest = seen.findIndex((row) => /FROM public\.signature_requests WHERE id = \$1::uuid FOR UPDATE/.test(row.sql));
  const lockSigners = seen.findIndex((row) => /FROM public\.signature_signers WHERE signature_request_id = \$1::uuid FOR UPDATE/.test(row.sql));
  const del = seen.findIndex((row) => /^DELETE FROM public\.signature_requests/.test(row.sql));
  assert.ok(lockRequest >= 0 && lockSigners > lockRequest && del > lockSigners, JSON.stringify(seen.map((r) => r.sql)));
  assert.match(seen[del].sql, /NOT EXISTS \( SELECT 1 FROM public\.signature_signers s/);
  assert.match(seen[del].sql, /s\.viewed_at IS NOT NULL/);
  assert.match(seen[del].sql, /s\.signed_at IS NOT NULL/);
});

test('a claim-only request (no check) is refused with 409 delete_not_supported_for_claim_only', async () => {
  const seen = [];
  const result = await runDeleteSignatureRequest({
    client: {
      query: async (sql, params = []) => {
        const compact = String(sql).replace(/\s+/g, ' ');
        seen.push({ sql: compact, params });
        if (compact.includes('FROM public.signature_requests')) return { rows: [draft({ claim_id: '22222222-2222-4222-8222-222222222222', check_intake_item_id: null })] };
        if (compact.includes('FROM public.claims')) return { rows: [{ id: 'c', tenant_id: TENANT }] };
        if (compact.includes('aws_can_write_tenant')) return { rows: [{ ok: true }] };
        if (compact.includes('FROM public.tenant_users')) return { rows: [{ x: 1 }] };
        return { rows: [], rowCount: 0 };
      },
    },
    mapping,
    body: { requestId: REQUEST },
    spoof,
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'delete_not_supported_for_claim_only');
  assert.equal(deletes(seen).length, 0);
});
