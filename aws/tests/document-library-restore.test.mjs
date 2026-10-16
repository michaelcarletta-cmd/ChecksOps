/**
 * Document Library restore (Compliance & Docs) API: library rows, orphan cleanup, the
 * upload limits, per-claim homeowner sharing and its public 5-minute links, the ledger
 * view's shared_documents, and the e-sign "From Document Library" copy. Mock database and
 * S3; the SQL side is covered on PostgreSQL 16 by sql94-document-library-pg.test.mjs.
 *
 * Owner policy: any tenant_users row is an equal user (the role value is ignored);
 * partners, other tenants and the platform owner get nothing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HOMEOWNER_DOCUMENT_URL_SECONDS,
  handleHomeownerSharedDocumentUrl,
  loadSharedDocumentsSafely,
  runClaimLibraryDocuments,
  runHomeownerRevokeLibraryDocument,
  runHomeownerShareLibraryDocument,
  runTenantLibraryDocumentCreate,
} from '../functions/api/tenant-library.mjs';
import { runSignatureLibraryDocumentCopy } from '../functions/api/signature-library-source.mjs';
import { authorizeSignatureDocumentPath } from '../functions/api/write-signature.mjs';
import { executeTenantDocuments } from '../functions/api/write-app-metadata.mjs';
import { handleStorageUploadUrl } from '../functions/api/storage-write.mjs';
import { authorizeStorageWritePath } from '../functions/api/storage-write-auth.mjs';
import { assembleHomeownerLedgerView } from '../functions/api/homeowner.mjs';
import { CLASS_A_FUNCTIONS } from '../functions/api/app-services.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { isAllowedTenantDocumentDocType, LIBRARY_CATEGORIES } from '../functions/api/mortgage-library-doc-types.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.env.FILES_BUCKET = 'checksops-test-files';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '3eff5f1a-929d-4ce3-9a8b-cd96b98df42b';
const MEMBER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OUTSIDER = 'bbd3c2a0-6dc0-4680-92dd-a013e1141c92';
const CLAIM = 'c1d3c2a0-6dc0-4680-92dd-a013e1141c93';
const OTHER_CLAIM = 'c2d3c2a0-6dc0-4680-92dd-a013e1141c94';
const CHECK = 'c3d3c2a0-6dc0-4680-92dd-a013e1141c95';
const DOC = 'd1d3c2a0-6dc0-4680-92dd-a013e1141c96';
const MORT_DOC = 'd2d3c2a0-6dc0-4680-92dd-a013e1141c97';
const OTHER_DOC = 'd3d3c2a0-6dc0-4680-92dd-a013e1141c98';
const SHARE = 'e1d3c2a0-6dc0-4680-92dd-a013e1141c99';
const mapping = { application_user_id: MEMBER };

const DOCS = {
  [DOC]: { id: DOC, tenant_id: TENANT, doc_type: 'library:template:tpa', file_name: 'TPA', file_path: `${TENANT}/library/template/1-a.pdf`, mime_type: 'application/pdf', file_size: 1000 },
  [MORT_DOC]: { id: MORT_DOC, tenant_id: TENANT, doc_type: 'library:mortgage:w-9', file_name: 'W-9', file_path: `${TENANT}/library/mortgage/1-b.pdf`, mime_type: 'application/pdf', file_size: 1000 },
  [OTHER_DOC]: { id: OTHER_DOC, tenant_id: OTHER_TENANT, doc_type: 'library:template:tpa', file_name: 'TPA', file_path: `${OTHER_TENANT}/library/template/1-c.pdf`, mime_type: 'application/pdf', file_size: 1000 },
};

/** A client answering membership, claim ownership, document and check lookups. */
function fakeClient({ members = { [MEMBER]: [TENANT] }, claims = { [CLAIM]: TENANT, [OTHER_CLAIM]: OTHER_TENANT }, insertError = null, checks = { [CHECK]: { id: CHECK, tenant_id: TENANT, claim_id: CLAIM } } } = {}) {
  const queries = [];
  return {
    queries,
    writes: () => queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/.test(q.sql)),
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      const text = String(sql);
      if (/^(SAVEPOINT|RELEASE|ROLLBACK)/.test(text)) return { rows: [] };
      if (/FROM public\.tenant_users WHERE user_id = \$1::uuid AND tenant_id = \$2::uuid/.test(text)) {
        return { rows: (members[params[0]] || []).includes(params[1]) ? [{ '?column?': 1 }] : [] };
      }
      if (/FROM public\.claims c\s+WHERE c\.id = \$1::uuid\s+AND \(c\.org_id = \$2::uuid/.test(text)) {
        return { rows: claims[params[0]] === params[1] ? [{ '?column?': 1 }] : [] };
      }
      if (/SELECT DISTINCT t\.tenant_id::text AS tenant_id/.test(text)) {
        const tenant = claims[params[0]];
        return { rows: tenant && (members[params[1]] || []).includes(tenant) ? [{ tenant_id: tenant }] : [] };
      }
      if (/FROM public\.tenant_documents WHERE id = \$1::uuid/.test(text)) {
        return { rows: DOCS[params[0]] ? [DOCS[params[0]]] : [] };
      }
      if (/FROM public\.check_intake_items WHERE id = \$1::uuid/.test(text)) {
        return { rows: checks[params[0]] ? [checks[params[0]]] : [] };
      }
      if (/INSERT INTO public\.tenant_documents/.test(text)) {
        if (insertError) throw insertError;
        return { rows: [{ id: 'new-doc', tenant_id: params[0], doc_type: params[1], file_path: params[2], mime_type: params[4], file_size: params[5] }] };
      }
      if (/FROM public\.tenant_documents\s+WHERE tenant_id = \$1::uuid AND doc_type LIKE 'library:%'/.test(text)) {
        return { rows: Object.values(DOCS).filter((d) => d.tenant_id === params[0] && !d.doc_type.startsWith('library:mortgage:')) };
      }
      if (/FROM public\.homeowner_shared_documents\s+WHERE tenant_id = \$1::uuid AND claim_id = \$2::uuid AND revoked_at IS NULL\s+ORDER BY/.test(text)) {
        return { rows: [{ id: SHARE, tenant_document_id: DOC, shared_at: '2026-10-16T00:00:00Z' }] };
      }
      if (/INSERT INTO public\.homeowner_shared_documents/.test(text)) {
        return { rows: [{ id: SHARE, tenant_id: params[0], claim_id: params[1], tenant_document_id: params[2], shared_at: 'now' }] };
      }
      if (/UPDATE public\.homeowner_shared_documents/.test(text)) {
        return { rows: [{ id: SHARE, revoked_at: 'now' }] };
      }
      if (/FROM public\.check_files|FROM public\.claim_files/.test(text)) return { rows: [] };
      throw new Error(`unexpected SQL ${text.slice(0, 90)}`);
    },
  };
}

function fakeS3({ head = { ContentLength: 1000, ContentType: 'application/pdf' }, headError = null } = {}) {
  const sent = [];
  return {
    sent,
    names: () => sent.map((c) => c.name),
    s3: {
      send: async (command) => {
        const name = command.constructor?.name || '';
        sent.push({ name, input: command.input });
        if (name === 'HeadObjectCommand') {
          if (headError) throw headError;
          return head;
        }
        return {};
      },
    },
  };
}

const createBody = (overrides = {}) => ({
  tenant_id: TENANT,
  doc_type: 'library:template:tpa',
  file_path: `${TENANT}/library/template/1700000000000-0d1f.pdf`,
  file_name: 'Third Party Authorization',
  ...overrides,
});

test('every library category saves; bad slugs, unknown categories, free mortgage suffixes and wrong folders are refused', async () => {
  for (const category of LIBRARY_CATEGORIES) {
    const docType = category === 'mortgage' ? 'library:mortgage:w-9' : `library:${category}:sample-1`;
    const client = fakeClient();
    const s3 = fakeS3();
    const result = await runTenantLibraryDocumentCreate({
      client, mapping, spoof: [], deps: { s3: s3.s3 },
      body: createBody({ doc_type: docType, file_path: `${TENANT}/library/${category}/1-a.pdf` }),
    });
    assert.equal(result.ok, true, `${category}: ${JSON.stringify(result)}`);
    assert.equal(result.document.doc_type, docType);
    // Size and type are the stored object's, not the browser's.
    assert.equal(result.document.file_size, 1000);
    assert.equal(result.document.mime_type, 'application/pdf');
    assert.deepEqual(s3.names(), ['HeadObjectCommand'], 'no delete on success');
  }
  for (const docType of ['library:template:TPA', 'library:template:t--pa', 'library:template:-x', `library:template:${'a'.repeat(61)}`, 'library:other:x', 'library:mortgage:evil', 'w9']) {
    const client = fakeClient();
    const s3 = fakeS3();
    const result = await runTenantLibraryDocumentCreate({ client, mapping, spoof: [], deps: { s3: s3.s3 }, body: createBody({ doc_type: docType }) });
    assert.equal(result.error, 'category_not_allowlisted', docType);
    assert.equal(client.writes().length, 0, docType);
  }
  // The category folder must be the doc_type's; another tenant's or a nested path is refused.
  for (const filePath of [`${TENANT}/library/catalog/1-a.pdf`, `${OTHER_TENANT}/library/template/1-a.pdf`, `${TENANT}/library/template/x/1-a.pdf`, `${TENANT}/x.pdf`]) {
    const result = await runTenantLibraryDocumentCreate({ client: fakeClient(), mapping, spoof: [], deps: { s3: fakeS3().s3 }, body: createBody({ file_path: filePath }) });
    assert.equal(result.error, 'path_not_allowlisted', filePath);
  }
  // Non-members (any role value counts as a member) and the platform owner without a membership: refused.
  const outsider = await runTenantLibraryDocumentCreate({ client: fakeClient(), mapping: { application_user_id: OUTSIDER }, spoof: [], deps: { s3: fakeS3().s3 }, body: createBody() });
  assert.equal(outsider.error, 'not_authorized');
});

test('orphan cleanup: a refused object (size, type) or a failed row insert deletes the uploaded S3 object', async () => {
  const cases = [
    ['too large', { head: { ContentLength: 26 * 1024 * 1024, ContentType: 'application/pdf' } }, null, 'invalid_field'],
    ['svg', { head: { ContentLength: 10, ContentType: 'image/svg+xml' } }, null, 'invalid_field'],
    ['html', { head: { ContentLength: 10, ContentType: 'text/html' } }, null, 'invalid_field'],
    ['CHECK refused', {}, Object.assign(new Error('violates check constraint'), { code: '23514' }), 'category_not_allowlisted'],
    ['insert failed', {}, Object.assign(new Error('connection reset'), { code: '08006' }), 'library_insert_failed'],
  ];
  for (const [label, s3Opts, insertError, error] of cases) {
    const s3 = fakeS3(s3Opts);
    const result = await runTenantLibraryDocumentCreate({ client: fakeClient({ insertError }), mapping, spoof: [], deps: { s3: s3.s3 }, body: createBody() });
    assert.equal(result.error, error, label);
    assert.equal(result.orphan_deleted, true, label);
    const del = s3.sent.find((c) => c.name === 'DeleteObjectCommand');
    assert.ok(del, label);
    assert.equal(del.input.Key, `files/tenant-documents/${TENANT}/library/template/1700000000000-0d1f.pdf`, label);
  }
  // A non-member never deletes anything (the key is not theirs).
  const s3 = fakeS3();
  await runTenantLibraryDocumentCreate({ client: fakeClient(), mapping: { application_user_id: OUTSIDER }, spoof: [], deps: { s3: s3.s3 }, body: createBody() });
  assert.deepEqual(s3.names(), []);
  // A missing object is reported, nothing to delete.
  const missing = fakeS3({ headError: Object.assign(new Error('NotFound'), { name: 'NotFound' }) });
  const absent = await runTenantLibraryDocumentCreate({ client: fakeClient(), mapping, spoof: [], deps: { s3: missing.s3 }, body: createBody() });
  assert.equal(absent.error, 'object_not_in_s3');
  assert.deepEqual(missing.names(), ['HeadObjectCommand']);
  // The SPA also removes the object when the create call fails.
  const ui = fs.readFileSync(path.join(ROOT, 'src/components/settings/TenantDocumentLibrary.tsx'), 'utf8');
  assert.match(ui, /tenant-library-document-create/);
  assert.match(ui, /remove\(\[uploadedPath\]\)/);
});

test('generic tenant_documents writes enforce the categories, the MIME allowlist and 25 MB', async () => {
  const client = {
    writes: [],
    query: async (sql, params) => {
      if (/FROM public\.tenant_users/.test(sql)) return { rows: [{ role: 'viewer' }] };
      if (/INSERT INTO public\.tenant_documents/.test(sql)) { client.writes.push(params); return { rows: [{ id: 'x' }] }; }
      throw new Error(`unexpected ${sql.slice(0, 60)}`);
    },
  };
  const insert = (values) => executeTenantDocuments({ client, mapping, op: 'insert', values: { tenant_id: TENANT, file_name: 'x', ...values }, filters: [] });
  assert.equal((await insert({ doc_type: 'library:catalog:roofing', file_path: `${TENANT}/library/catalog/1.pdf`, mime_type: 'application/pdf', file_size: 10 })).error, undefined);
  assert.equal((await insert({ doc_type: 'library:catalog:roofing', file_path: `${TENANT}/library/template/1.pdf` })).error, 'path_not_allowlisted');
  assert.equal((await insert({ doc_type: 'library:catalog:roofing', file_path: `${TENANT}/library/catalog/1.svg`, mime_type: 'image/svg+xml' })).error, 'invalid_field');
  assert.equal((await insert({ doc_type: 'library:catalog:roofing', file_path: `${TENANT}/library/catalog/1.pdf`, file_size: 26 * 1024 * 1024 })).error, 'invalid_field');
  assert.equal((await insert({ doc_type: 'library:catalog:Roofing', file_path: `${TENANT}/library/catalog/1.pdf` })).error, 'category_not_allowlisted');
  assert.equal(client.writes.length, 1);
  // shared_with_homeowners is not writable (per-claim sharing replaces it).
  const allowlist = fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-allowlist.mjs'), 'utf8');
  assert.doesNotMatch(allowlist.slice(allowlist.indexOf('tenant_documents: {'), allowlist.indexOf('mortgage_request_library_documents: {')), /shared_with_homeowners/);
  assert.equal(isAllowedTenantDocumentDocType('library:letterhead:footer'), true);
});

test('library upload URLs: documents and images only, a contentLength of at most 25 MB, signed into the PUT, exact category folder', async () => {
  const APP_ID = MEMBER;
  const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
  const mappingRow = { application_user_id: APP_ID, cognito_sub: SUB, email: 't@example.com', status: 'active' };
  const client = {
    query: async (sql, params) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
      if (String(sql).startsWith('SELECT set_config')) return { rows: [] };
      if (sql === LOOKUP_MAPPING_SQL) return { rows: params[0] === SUB ? [mappingRow] : [] };
      if (/FROM public\.tenant_users/.test(sql)) return { rows: [{ role: 'viewer' }] };
      return { rows: [] };
    },
    connect: async () => {},
    end: async () => {},
  };
  let signedCommand = null;
  const deps = {
    forceStorageWrites: true,
    loadDatabaseCredentials: async () => ({ username: 'u', password: 'p', host: 'h', database: 'd' }),
    createClient: () => client,
    s3: { send: async (command) => { if (command.constructor.name === 'HeadObjectCommand') { const e = new Error('nf'); e.name = 'NotFound'; throw e; } return {}; } },
    getSignedUrl: async (_s3, command) => { signedCommand = command; return 'https://s3.example/put'; },
  };
  const event = (body) => ({
    rawPath: '/storage/upload-url',
    headers: { authorization: 'Bearer x' },
    body: JSON.stringify(body),
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/storage/upload-url' }, authorizer: { jwt: { claims: { sub: SUB, email: 't@example.com', token_use: 'id' } } } },
  });
  const path0 = `${TENANT}/library/template/1-a.pdf`;
  const ok = await handleStorageUploadUrl(event({ bucket: 'tenant-documents', path: path0, contentType: 'application/pdf', contentLength: 2048 }), deps);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(signedCommand.input.ContentLength, 2048);
  for (const body of [
    { contentType: 'application/pdf' },
    { contentType: 'application/pdf', contentLength: 26 * 1024 * 1024 },
    { contentType: 'image/svg+xml', contentLength: 10 },
    { contentType: 'text/plain', contentLength: 10 },
    { contentType: 'application/octet-stream', contentLength: 10 },
  ]) {
    const refused = await handleStorageUploadUrl(event({ bucket: 'tenant-documents', path: path0, ...body }), deps);
    assert.equal(refused.ok, false, JSON.stringify(body));
    assert.equal(refused.error, 'invalid_field', JSON.stringify(body));
  }
  const memberClient = { query: async (sql) => (/FROM public\.tenant_users/.test(sql) ? { rows: [{ role: 'viewer' }] } : { rows: [] }) };
  for (const bad of [`${TENANT}/library/1-a.pdf`, `${TENANT}/library/other/1-a.pdf`, `${TENANT}/library/template/x/1-a.pdf`, `${TENANT}/library/template/.hidden`]) {
    const auth = await authorizeStorageWritePath(memberClient, 'tenant-documents', bad, MEMBER);
    assert.equal(auth.error, 'path_not_allowlisted', bad);
  }
});

test('homeowner share: same tenant only, members only, no mortgage packet documents; revoke', async () => {
  const body = { tenant_id: TENANT, claim_id: CLAIM, tenant_document_id: DOC };
  const ok = await runHomeownerShareLibraryDocument({ client: fakeClient(), mapping, body, spoof: [] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.share.claim_id, CLAIM);
  const refusals = [
    ['another tenant\'s document', { ...body, tenant_document_id: OTHER_DOC }, {}, 'document_not_shareable'],
    ['a mortgage packet document', { ...body, tenant_document_id: MORT_DOC }, {}, 'document_not_shareable'],
    ['another tenant\'s claim', { ...body, claim_id: OTHER_CLAIM }, {}, 'claim_not_in_tenant'],
    ['a non-member', body, { mapping: { application_user_id: OUTSIDER } }, 'not_authorized'],
    ['a member of the other tenant naming this tenant', body, { members: { [MEMBER]: [OTHER_TENANT] } }, 'not_authorized'],
    ['a bad id', { ...body, claim_id: 'x' }, {}, 'invalid_uuid'],
  ];
  for (const [label, input, opts, error] of refusals) {
    const client = fakeClient(opts.members ? { members: opts.members } : {});
    const result = await runHomeownerShareLibraryDocument({ client, mapping: opts.mapping || mapping, body: input, spoof: [] });
    assert.equal(result.error, error, label);
    assert.equal(client.writes().length, 0, label);
  }
  const revoked = await runHomeownerRevokeLibraryDocument({ client: fakeClient(), mapping, body, spoof: [] });
  assert.equal(revoked.revoked, 1);
  const outsiderRevoke = await runHomeownerRevokeLibraryDocument({ client: fakeClient(), mapping: { application_user_id: OUTSIDER }, body, spoof: [] });
  assert.equal(outsiderRevoke.error, 'not_authorized');
  const otherClaimRevoke = await runHomeownerRevokeLibraryDocument({ client: fakeClient(), mapping, body: { ...body, claim_id: OTHER_CLAIM }, spoof: [] });
  assert.equal(otherClaimRevoke.error, 'claim_not_in_tenant');

  // The picker list: the claim tenant's non-mortgage library and this claim's shares.
  const listed = await runClaimLibraryDocuments({ client: fakeClient(), mapping, body: { claim_id: CLAIM }, spoof: [] });
  assert.equal(listed.tenant_id, TENANT);
  assert.deepEqual(listed.documents.map((d) => d.id), [DOC]);
  assert.deepEqual(listed.shares.map((s) => s.tenant_document_id), [DOC]);
  const notMine = await runClaimLibraryDocuments({ client: fakeClient(), mapping, body: { claim_id: OTHER_CLAIM }, spoof: [] });
  assert.equal(notMine.error, 'not_authorized');
});

test('homeowner link: token tenant, claim, revoked and expired are enforced by SQL 94; the URL lives 5 minutes; only the tenant\'s own non-mortgage library key', async () => {
  const publicClient = (doc) => ({
    queries: [],
    async query(sql, params) {
      this.queries.push(String(sql));
      if (/aws_public_homeowner_shared_document/.test(sql)) return { rows: [{ doc: typeof doc === 'function' ? doc(params) : doc }] };
      return { rows: [] };
    },
    end: async () => {},
  });
  const event = (body) => ({ body: JSON.stringify(body), headers: {}, requestContext: { http: { method: 'POST' } } });
  let signed = null;
  const deps = (doc) => ({
    connectPublic: async () => publicClient(doc),
    s3: { send: async () => ({}) },
    getSignedUrl: async (_s3, command, opts) => { signed = { command, opts }; return 'https://s3.example/get?sig'; },
  });
  const good = { ok: true, id: SHARE, tenant_id: TENANT, file_path: `${TENANT}/library/template/1-a.pdf`, file_name: 'TPA "x".pdf', mime_type: 'application/pdf' };
  const res = await handleHomeownerSharedDocumentUrl(event({ token: 'tok-claim-a-0001', shared_document_id: SHARE }), deps(good));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.expires_in, 300);
  assert.equal(HOMEOWNER_DOCUMENT_URL_SECONDS, 300);
  assert.equal(signed.opts.expiresIn, 300);
  assert.equal(signed.command.input.Key, `files/tenant-documents/${TENANT}/library/template/1-a.pdf`);
  assert.equal(signed.command.input.ResponseContentType, 'application/pdf');
  assert.doesNotMatch(signed.command.input.ResponseContentDisposition, /"x"/);
  for (const [error, status] of [['revoked', 410], ['expired', 410], ['not_found', 404]]) {
    signed = null;
    const refused = await handleHomeownerSharedDocumentUrl(event({ token: 'tok-claim-a-0001', shared_document_id: SHARE }), deps({ ok: false, error }));
    assert.equal(refused.statusCode, status, error);
    assert.equal(signed, null, error);
  }
  // A stored path that is not the token tenant's own non-mortgage library key never signs.
  for (const file_path of [`${OTHER_TENANT}/library/template/1-a.pdf`, `${TENANT}/library/mortgage/1-a.pdf`, `checks/${CHECK}/front.jpg`, 'https://x.supabase.co/storage/v1/object/sign/tenant-documents/a.pdf']) {
    signed = null;
    const refused = await handleHomeownerSharedDocumentUrl(event({ token: 'tok-claim-a-0001', shared_document_id: SHARE }), deps({ ...good, file_path }));
    assert.equal(refused.statusCode, 404, file_path);
    assert.equal(signed, null, file_path);
  }
  // An HTML or unknown type is served as a download, never rendered.
  await handleHomeownerSharedDocumentUrl(event({ token: 'tok-claim-a-0001', shared_document_id: SHARE }), deps({ ...good, mime_type: 'text/html' }));
  assert.equal(signed.command.input.ResponseContentType, 'application/octet-stream');
  assert.equal((await handleHomeownerSharedDocumentUrl(event({ token: 'short', shared_document_id: SHARE }), deps(good))).error, 'invalid_token');
  assert.equal((await handleHomeownerSharedDocumentUrl(event({ token: 'tok-claim-a-0001', shared_document_id: 'x' }), deps(good))).error, 'invalid_uuid');
});

test('ledger view: shared_documents is the Lambda\'s claim-scoped metadata list (no paths, no URLs); a missing SQL 94 reader gives []', async () => {
  const rows = [{ id: SHARE, file_name: 'TPA', mime_type: 'application/pdf', file_size: 1, category: 'template', shared_at: 'x', file_path: 'leak', url: 'leak' }];
  const client = { query: async (sql) => (/aws_public_homeowner_shared_documents/.test(sql) ? { rows: [{ doc: { ok: true, documents: rows } }] } : { rows: [] }) };
  const docs = await loadSharedDocumentsSafely(client, 'tok-claim-a-0001');
  assert.deepEqual(docs, [{ id: SHARE, file_name: 'TPA', mime_type: 'application/pdf', file_size: 1, category: 'template', shared_at: 'x' }]);
  const missing = { query: async (sql) => { if (/aws_public_homeowner_shared_documents/.test(sql)) throw new Error('function does not exist'); return { rows: [] }; } };
  assert.deepEqual(await loadSharedDocumentsSafely(missing, 'tok'), []);
  const view = assembleHomeownerLedgerView({ ok: true, mode: 'claim', token: { claim_id: CLAIM }, shared_documents: [{ id: 'rpc-supplied', url: 'x' }] }, [], { sharedDocuments: docs });
  assert.deepEqual(view.shared_documents, docs);
  const none = assembleHomeownerLedgerView({ ok: true, mode: 'claim', token: { claim_id: CLAIM }, shared_documents: [{ id: 'rpc-supplied' }] }, []);
  assert.deepEqual(none.shared_documents, []);
});

test('e-sign "From Document Library": a member copies a non-mortgage PDF/DOCX into the claim\'s signature folder; non-members, other tenants, mortgage documents refused', async () => {
  const run = (overrides = {}, clientOpts = {}, s3Opts = {}) => {
    const s3 = fakeS3(s3Opts);
    const client = fakeClient(clientOpts);
    return {
      s3,
      result: runSignatureLibraryDocumentCopy({
        client,
        mapping: overrides.mapping || mapping,
        body: { tenant_document_id: DOC, claim_id: CLAIM, ...overrides.body },
        spoof: [],
        deps: { s3: s3.s3, getSignedUrl: async () => 'https://s3.example/get' },
      }),
    };
  };
  const ok = run();
  const res = await ok.result;
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.path, new RegExp(`^signatures/${CLAIM}/library-\\d+-[0-9a-f-]+\\.pdf$`));
  assert.equal(res.bucket, 'claim-files');
  const copy = ok.s3.sent.find((c) => c.name === 'CopyObjectCommand');
  assert.equal(copy.input.CopySource, encodeURI(`checksops-test-files/files/tenant-documents/${TENANT}/library/template/1-a.pdf`));
  assert.equal(copy.input.Key, `files/claim-files/${res.path}`);
  // The returned path passes the unchanged signature path rule; a tenant-documents path never does.
  assert.equal(await authorizeSignatureDocumentPath(fakeClient(), { path: res.path, claimId: CLAIM }), true);
  assert.equal(await authorizeSignatureDocumentPath(fakeClient(), { path: DOCS[DOC].file_path, claimId: CLAIM }), false);
  // Check-scoped when only a check is given.
  const byCheck = await run({ body: { claim_id: undefined, check_intake_item_id: CHECK } }).result;
  assert.match(byCheck.path, new RegExp(`^check-intake/${CHECK}/files/library-`));
  const refusals = [
    ['non-member', { mapping: { application_user_id: OUTSIDER } }, {}, {}, 'not_authorized'],
    ['another tenant\'s document', { body: { tenant_document_id: OTHER_DOC } }, {}, {}, 'not_authorized'],
    ['mortgage packet document', { body: { tenant_document_id: MORT_DOC } }, {}, {}, 'document_not_signable'],
    ['another tenant\'s claim', { body: { claim_id: OTHER_CLAIM } }, {}, {}, 'claim_not_in_tenant'],
    ['another tenant\'s check', { body: { check_intake_item_id: CHECK } }, { checks: { [CHECK]: { id: CHECK, tenant_id: OTHER_TENANT, claim_id: CLAIM } } }, {}, 'check_not_in_tenant'],
    ['a check on another claim', { body: { check_intake_item_id: CHECK } }, { checks: { [CHECK]: { id: CHECK, tenant_id: TENANT, claim_id: OTHER_CLAIM } } }, {}, 'check_not_on_claim'],
    ['an image (not signable)', {}, {}, { head: { ContentLength: 10, ContentType: 'image/png' } }, 'document_not_signable'],
    ['no claim or check', { body: { claim_id: undefined } }, {}, {}, 'missing_required_field'],
  ];
  for (const [label, overrides, clientOpts, s3Opts, error] of refusals) {
    const { result, s3 } = run(overrides, clientOpts, s3Opts);
    const r = await result;
    assert.equal(r.error, error, label);
    assert.equal(s3.sent.some((c) => c.name === 'CopyObjectCommand'), false, label);
  }
});

test('the platform owner (no membership) gets nothing: homeowner Library sharing, revoke, list and e-sign library copy are members only', async () => {
  const PLATFORM_OWNER = 'f0d3c2a0-6dc0-4680-92dd-a013e1141c9f';
  /** fakeClient, but every platform-owner probe answers true (and is recorded). */
  const ownerClient = () => {
    const base = fakeClient();
    const probes = [];
    return {
      probes,
      writes: base.writes,
      query: async (sql, params = []) => {
        if (/is_platform_owner|is_master_owner|aws_is_cross_tenant_reader/.test(String(sql))) {
          probes.push(String(sql));
          return { rows: [{ is_owner: true, is_platform: true, is_master: true, ok: true }] };
        }
        return base.query(sql, params);
      },
    };
  };
  const owner = { application_user_id: PLATFORM_OWNER };
  const body = { tenant_id: TENANT, claim_id: CLAIM, tenant_document_id: DOC };
  for (const [label, runFn] of [
    ['share', runHomeownerShareLibraryDocument],
    ['revoke', runHomeownerRevokeLibraryDocument],
    ['list', runClaimLibraryDocuments],
  ]) {
    const client = ownerClient();
    const result = await runFn({ client, mapping: owner, body, spoof: [] });
    assert.equal(result.error, 'not_authorized', label);
    assert.equal(client.writes().length, 0, label);
    assert.deepEqual(client.probes, [], `${label}: no platform-owner branch`);
  }
  const s3 = fakeS3();
  const client = ownerClient();
  const copied = await runSignatureLibraryDocumentCopy({
    client, mapping: owner, body: { tenant_document_id: DOC, claim_id: CLAIM }, spoof: [],
    deps: { s3: s3.s3, getSignedUrl: async () => 'https://s3.example/get' },
  });
  assert.equal(copied.error, 'not_authorized');
  assert.equal(s3.sent.some((c) => c.name === 'CopyObjectCommand'), false);
  assert.deepEqual(client.probes, [], 'e-sign copy: no platform-owner branch');
});

test('routes are registered; the Library UI no longer offers tenant-wide homeowner sharing', () => {
  for (const name of ['tenant-library-document-create', 'claim-library-documents', 'homeowner-share-library-document', 'homeowner-share-library-document-revoke', 'homeowner-shared-document-url', 'signature-library-document-copy']) {
    assert.ok(CLASS_A_FUNCTIONS.has(name), name);
  }
  const ui = fs.readFileSync(path.join(ROOT, 'src/components/settings/TenantDocumentLibrary.tsx'), 'utf8');
  assert.doesNotMatch(ui, /shared_with_homeowners/);
  assert.doesNotMatch(ui, /Share with Clients/);
  const files = fs.readFileSync(path.join(ROOT, 'src/components/check-review/CheckFilesSection.tsx'), 'utf8');
  assert.match(files, /<HomeownerLibraryShare claimId=/);
  const sig = fs.readFileSync(path.join(ROOT, 'src/components/claim-detail/SignatureRequests.tsx'), 'utf8');
  assert.match(sig, /<SelectItem value="library">From Document Library<\/SelectItem>/);
  const signatureRule = fs.readFileSync(path.join(ROOT, 'aws/functions/api/write-signature.mjs'), 'utf8');
  assert.doesNotMatch(signatureRule, /tenant-documents|library\//, 'the signature path rule stays strict');
});
