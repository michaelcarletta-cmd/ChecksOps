// Mortgage Desk request view: every check tenant's auto-shared library documents (SQL 156, action
// shared_library_documents), grouped by company, the requesting tenant first; files open through the
// tenant-documents storage signer (storage.mjs authorizeObject, via shared_check_library_documents).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  canReadMortgageDeskSharedLibrary,
  groupSharedLibraryDocuments,
  loadMortgageDeskSharedLibraryDocuments,
  MORTGAGE_DESK_ESIGN_FUNCTION,
  MORTGAGE_DESK_SHARED_LIBRARY_BUCKET,
  sharedLibraryDocLabel,
} from '../../src/lib/mortgageDeskEsign.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGE = fs.readFileSync(path.join(ROOT, 'src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx'), 'utf8');

const doc = (over) => ({
  tenant_id: 't-req', tenant_name: 'Acme Roofing', requesting_tenant: true, tenant_document_id: 'd1',
  doc_type: 'library:mortgage:w9', file_name: 'W9.pdf', file_path: 't-req/library/w9.pdf', mime_type: 'application/pdf',
  file_size: 10, created_at: '2026-11-01T00:00:00Z', ...over,
});

test('groups by company: the requesting tenant first, then partners by name, documents in server order', () => {
  const rows = [
    doc({ tenant_id: 'p-z', tenant_name: 'Zeta Partners', requesting_tenant: false, tenant_document_id: 'z1', file_path: 'p-z/a.pdf' }),
    doc({ tenant_document_id: 'd1' }),
    doc({ tenant_id: 'p-b', tenant_name: 'beta builders', requesting_tenant: false, tenant_document_id: 'b1', file_path: 'p-b/a.pdf' }),
    doc({ tenant_document_id: 'd2', file_path: 't-req/library/coi.pdf' }),
    doc({ tenant_id: 'p-b', tenant_name: 'beta builders', requesting_tenant: false, tenant_document_id: 'b2', file_path: 'p-b/b.pdf' }),
    doc({ tenant_id: 'p-x', tenant_name: null, requesting_tenant: false, tenant_document_id: 'x1', file_path: 'p-x/a.pdf' }),
    doc({ tenant_id: '', tenant_document_id: 'bad' }),
    doc({ file_path: '', tenant_document_id: 'bad2' }),
  ];
  const groups = groupSharedLibraryDocuments(rows);
  assert.deepEqual(groups.map((g) => [g.tenantName, g.requestingTenant, g.documents.map((d) => d.tenant_document_id)]), [
    ['Acme Roofing', true, ['d1', 'd2']],
    ['beta builders', false, ['b1', 'b2']],
    ['Unnamed company', false, ['x1']],
    ['Zeta Partners', false, ['z1']],
  ]);
  assert.deepEqual(groupSharedLibraryDocuments([]), []);
});

test('labels and the read rule match SQL 156 (platform owner; agent while queued or in progress, or theirs)', () => {
  assert.equal(sharedLibraryDocLabel('library:mortgage:proof_of_insurance'), 'proof of insurance');
  assert.equal(sharedLibraryDocLabel(null), '');
  for (const [req, uid, owner, ok] of [
    [{ status: 'requested', assigned_employee_id: null }, 'a', false, true],
    [{ status: 'in_progress', assigned_employee_id: 'b' }, 'a', false, true],
    [{ status: 'completed', assigned_employee_id: 'a' }, 'a', false, true],
    [{ status: 'completed', assigned_employee_id: 'b' }, 'a', false, false],
    [{ status: 'completed', assigned_employee_id: 'b' }, 'a', true, true],
    [null, 'a', true, false],
  ]) assert.equal(canReadMortgageDeskSharedLibrary(req, uid, owner), ok, JSON.stringify(req));
});

test('loader calls the API action and returns its rows or the refusal message', async () => {
  // (The API action itself is #1798's, tested in mortgage-desk-shared-library-api.test.mjs.)
  const calls = [];
  const ok = { functions: { invoke: async (name, opts) => { calls.push([name, opts.body]); return { data: { ok: true, data: [doc({})] } }; } } };
  const out = await loadMortgageDeskSharedLibraryDocuments(ok, 'req-1');
  assert.deepEqual(calls, [[MORTGAGE_DESK_ESIGN_FUNCTION, { action: 'shared_library_documents', request_id: 'req-1' }]]);
  assert.equal(out.error, null);
  assert.equal(out.data.length, 1);
  const refused = { functions: { invoke: async () => ({ data: { ok: false, message: 'not_authorized' } }) } };
  assert.deepEqual(await loadMortgageDeskSharedLibraryDocuments(refused, 'req-1'), { data: null, error: 'not_authorized' });
  const odd = { functions: { invoke: async () => ({ data: { ok: true } }) } };
  assert.equal((await loadMortgageDeskSharedLibraryDocuments(odd, 'req-1')).data, null);
});

test('the request view loads the grouped list on AWS and opens files through the tenant-documents signer', () => {
  assert.equal(MORTGAGE_DESK_SHARED_LIBRARY_BUCKET, 'tenant-documents');
  assert.match(PAGE, /mortgageUsesAwsBackend && canReadMortgageDeskSharedLibrary\(r, user\?\.id, isPlatformOwner\(user\?\.email, user\?\.id\)\)/);
  assert.match(PAGE, /loadMortgageDeskSharedLibraryDocuments\(deskEsignClient, r\.id\)/);
  assert.match(PAGE, /downloadFromBucket\(MORTGAGE_DESK_SHARED_LIBRARY_BUCKET, d\.file_path, d\.file_name\)/);
  // downloadFromBucket signs through supabase.storage (the AWS adapter -> storage.mjs), never the Desk's sign_url action.
  assert.match(PAGE, /const downloadFromBucket = async \(bucket: string, path: string, name: string\) => \{\n\s+const \{ data, error \} = await supabase\.storage/);
  assert.match(PAGE, /Requesting company/);
});
