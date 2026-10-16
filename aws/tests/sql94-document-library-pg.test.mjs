/**
 * PostgreSQL 16: SQL 94 (aws/workflows/sql/94_document_library_restore.sql).
 *
 * - The doc_type CHECK: every library category saves; bad slugs, unknown categories and
 *   free mortgage suffixes are refused; the predecessors (6-value Supabase list, SQL 30's
 *   13-value list) are replaced; the file is idempotent; an unsupported predecessor or a
 *   row the new rule refuses stops it. The SQL rule matches isAllowedTenantDocumentDocType.
 * - homeowner_shared_documents: same-tenant only (document, claim), no mortgage packet
 *   documents, members only (RLS), revoke once, no delete.
 * - The public readers: only the token's own claim's non-revoked shares (metadata), and
 *   revoked / expired / unbound tokens fail closed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { isAllowedTenantDocumentDocType } from '../functions/api/mortgage-library-doc-types.mjs';
import {
  CLAIM_A,
  CLAIM_A2,
  CLAIM_B,
  MEMBER_A,
  MEMBER_B,
  SQL30_FILE,
  SQL94_FILE,
  TENANT_A,
  TENANT_B,
  asApi,
  libraryFixture,
  pgSkipReason,
} from './helpers/library-sql-pg.mjs';

const SQL94 = fs.readFileSync(SQL94_FILE, 'utf8');
const SQL30_INNER = (() => {
  const text = fs.readFileSync(SQL30_FILE, 'utf8');
  return text.slice(text.indexOf('BEGIN;') + 6, text.lastIndexOf('COMMIT;'));
})();

const SAMPLES = Object.freeze({
  good: [
    'w9', 'privacy_policy', 'library:mortgage:w-9', 'library:mortgage:adjuster-tpa-letter',
    'library:template:tpa', 'library:template:third-party-authorization', 'library:shingle:oakridge-onyx-black',
    'library:siding:board-and-batten', 'library:catalog:2026', 'library:letterhead:footer-1',
    `library:template:${'a'.repeat(60)}`,
  ],
  bad: [
    'library:template:TPA', 'library:template:tpa-', 'library:template:-tpa', 'library:template:t--pa',
    'library:template:', 'library:template:tpa space', 'library:template:tpa/x', `library:template:${'a'.repeat(61)}`,
    'library:mortgage:evil', 'library:mortgage:other', 'library:other:tpa', 'library:Template:tpa', 'verification', '',
  ],
});

test('SQL 94 rule text matches the API rule (no PostgreSQL needed)', () => {
  for (const value of SAMPLES.good) assert.equal(isAllowedTenantDocumentDocType(value), true, value);
  for (const value of SAMPLES.bad) assert.equal(isAllowedTenantDocumentDocType(value), false, value);
  assert.match(SQL94, /\^library:\(template\|shingle\|siding\|catalog\|letterhead\):\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$/);
  assert.match(SQL94, /<= 60/);
  assert.doesNotMatch(SQL94, /\bBEGIN;|\bCOMMIT;/);
});

async function withFixture(t, prefix, port, fn) {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await libraryFixture(pg, prefix, port);
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

const insertDoc = (admin, docType, tenant = TENANT_A, category = docType.split(':')[1] || 'legacy') => admin.query(
  'INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name) VALUES ($1, $2, $3, $4) RETURNING id',
  [tenant, docType, `${tenant}/library/${category}/x-${Math.random().toString(16).slice(2)}.pdf`, 'Doc'],
);

test('PostgreSQL 16: SQL 94 CHECK accepts every library category, refuses bad slugs, replaces the predecessors and is idempotent', { timeout: 300000 }, async (t) => withFixture(t, 'pg-sql94-check-', 57100, async ({ admin, connectAs }) => {
  // 6-value Supabase predecessor: a template row is refused (the production gap).
  await assert.rejects(insertDoc(admin, 'library:template:tpa'), (error) => error.code === '23514');
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(SQL94);
    for (const value of SAMPLES.good) {
      const row = await insertDoc(admin, value);
      assert.equal(row.rowCount, 1, value);
    }
    for (const value of SAMPLES.bad.filter(Boolean)) {
      await assert.rejects(insertDoc(admin, value), (error) => error.code === '23514', value);
    }
    const def = (await admin.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'tenant_documents_doc_type_check'")).rows[0].d;
    assert.match(def, /aws_tenant_document_doc_type_ok\(doc_type\)/);
    // Idempotent: a second run keeps the same constraint.
    await owner.query(SQL94);
    const again = (await admin.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'tenant_documents_doc_type_check'")).rows[0].d;
    assert.equal(again, def);
    // The rule function agrees with the API on every sample.
    for (const value of [...SAMPLES.good, ...SAMPLES.bad]) {
      const okSql = (await admin.query('SELECT public.aws_tenant_document_doc_type_ok($1) AS ok', [value])).rows[0].ok;
      assert.equal(okSql === true, isAllowedTenantDocumentDocType(value), value);
    }
  } finally {
    await owner.end();
  }
}));

test('PostgreSQL 16: SQL 94 after SQL 30; unsupported predecessors and refused rows stop it', { timeout: 300000 }, async (t) => withFixture(t, 'pg-sql94-pred-', 57200, async ({ admin, connectAs }) => {
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(`BEGIN; ${SQL30_INNER} COMMIT;`);
    await insertDoc(admin, 'library:mortgage:w-9');
    await owner.query(SQL94);
    assert.equal((await insertDoc(admin, 'library:catalog:roofing')).rowCount, 1);

    // An unknown predecessor refuses.
    await admin.query('ALTER TABLE public.tenant_documents DROP CONSTRAINT tenant_documents_doc_type_check');
    await admin.query("ALTER TABLE public.tenant_documents ADD CONSTRAINT tenant_documents_doc_type_check CHECK (doc_type LIKE 'library:%' OR doc_type IN ('w9'))");
    await assert.rejects(owner.query(SQL94), /sql94_unsupported_doc_type_check/);

    // A row the new rule refuses stops it (nothing rewritten).
    await admin.query('ALTER TABLE public.tenant_documents DROP CONSTRAINT tenant_documents_doc_type_check');
    await admin.query("INSERT INTO public.tenant_documents (tenant_id, doc_type, file_path, file_name) VALUES ($1, 'library:template:BAD', 'x', 'x')", [TENANT_A]);
    await admin.query("ALTER TABLE public.tenant_documents ADD CONSTRAINT tenant_documents_doc_type_check CHECK (doc_type IN ('w9','license','insurance','saas_agreement','terms_of_service','privacy_policy')) NOT VALID");
    await assert.rejects(owner.query(SQL94), /sql94_invalid_rows/);
  } finally {
    await owner.end();
  }
}));

test('PostgreSQL 16: homeowner sharing is per claim, same tenant, members only; readers return only the token claim\'s shares', { timeout: 300000 }, async (t) => withFixture(t, 'pg-sql94-share-', 57300, async ({ admin, connectAs }) => {
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(SQL94);
  } finally {
    await owner.end();
  }
  const tmplA = (await insertDoc(admin, 'library:template:tpa')).rows[0].id;
  const catA = (await insertDoc(admin, 'library:catalog:roofing')).rows[0].id;
  const mortA = (await insertDoc(admin, 'library:mortgage:w-9')).rows[0].id;
  const tmplB = (await insertDoc(admin, 'library:template:tpa', TENANT_B)).rows[0].id;
  await admin.query(`INSERT INTO public.homeowner_ledger_tokens (tenant_id, claim_id, token, revoked_at, expires_at) VALUES
    ('${TENANT_A}', '${CLAIM_A}', 'tok-claim-a-0001', NULL, NULL),
    ('${TENANT_A}', '${CLAIM_A2}', 'tok-claim-a2-0001', NULL, NULL),
    ('${TENANT_A}', '${CLAIM_A}', 'tok-revoked-00001', now(), NULL),
    ('${TENANT_A}', '${CLAIM_A}', 'tok-expired-00001', NULL, now() - interval '1 day'),
    ('${TENANT_A}', '${CLAIM_B}', 'tok-wrong-claim-01', NULL, NULL),
    ('${TENANT_A}', NULL, 'tok-pre-claim-001', NULL, NULL)`);

  const share = (userId, tenant, claim, doc) => asApi(admin, userId, () => admin.query(
    'INSERT INTO public.homeowner_shared_documents (tenant_id, claim_id, tenant_document_id, shared_by) VALUES ($1, $2, $3, $4) RETURNING id',
    [tenant, claim, doc, userId],
  ));
  // Members of the tenant share their own non-mortgage library documents on their own claims.
  assert.equal((await share(MEMBER_A, TENANT_A, CLAIM_A, tmplA)).rowCount, 1);
  // Org-less claim of the tenant (through its check): allowed.
  assert.equal((await share(MEMBER_A, TENANT_A, CLAIM_A2, catA)).rowCount, 1);
  // Refusals: another tenant's document, another tenant's claim, a mortgage packet document,
  // a non-member, a forged shared_by.
  await assert.rejects(share(MEMBER_A, TENANT_A, CLAIM_A, tmplB), /sql94_share_document_not_allowed/);
  await assert.rejects(share(MEMBER_A, TENANT_A, CLAIM_B, tmplA), /sql94_share_claim_not_allowed/);
  await assert.rejects(share(MEMBER_A, TENANT_A, CLAIM_A, mortA), /sql94_share_document_not_allowed/);
  await assert.rejects(share(MEMBER_B, TENANT_A, CLAIM_A, tmplA), (error) => error.code === '42501');
  await assert.rejects(asApi(admin, MEMBER_A, () => admin.query(
    'INSERT INTO public.homeowner_shared_documents (tenant_id, claim_id, tenant_document_id, shared_by) VALUES ($1, $2, $3, $4)',
    [TENANT_A, CLAIM_A, tmplA, MEMBER_B],
  )), (error) => error.code === '42501');

  // Persist two shares (the asApi calls roll back) as the owner of the data.
  await admin.query(`SELECT set_config('request.app_user_id', '${MEMBER_A}', false)`);
  const s1 = (await admin.query('INSERT INTO public.homeowner_shared_documents (tenant_id, claim_id, tenant_document_id, shared_by) VALUES ($1, $2, $3, $4) RETURNING id', [TENANT_A, CLAIM_A, tmplA, MEMBER_A])).rows[0].id;
  const s2 = (await admin.query('INSERT INTO public.homeowner_shared_documents (tenant_id, claim_id, tenant_document_id, shared_by) VALUES ($1, $2, $3, $4) RETURNING id', [TENANT_A, CLAIM_A2, catA, MEMBER_A])).rows[0].id;
  const s3 = (await admin.query('INSERT INTO public.homeowner_shared_documents (tenant_id, claim_id, tenant_document_id, shared_by) VALUES ($1, $2, $3, $4) RETURNING id', [TENANT_A, CLAIM_A, catA, MEMBER_A])).rows[0].id;
  await admin.query("SELECT set_config('request.app_user_id', '', false)");

  // Members read their tenant's shares; another tenant reads none.
  const visible = async (userId) => asApi(admin, userId, async () => (await admin.query('SELECT id FROM public.homeowner_shared_documents')).rowCount);
  assert.equal(await visible(MEMBER_A), 3);
  assert.equal(await visible(MEMBER_B), 0);
  // Nobody deletes; an UPDATE may only revoke, once.
  await assert.rejects(asApi(admin, MEMBER_A, () => admin.query('DELETE FROM public.homeowner_shared_documents')), (error) => error.code === '42501');
  await assert.rejects(asApi(admin, MEMBER_A, () => admin.query('UPDATE public.homeowner_shared_documents SET claim_id = $1', [CLAIM_A2])), (error) => error.code === '42501');
  await admin.query(`UPDATE public.homeowner_shared_documents SET revoked_at = now(), revoked_by = '${MEMBER_A}' WHERE id = '${s3}'`);
  await assert.rejects(admin.query(`UPDATE public.homeowner_shared_documents SET revoked_at = now() + interval '1 hour' WHERE id = '${s3}'`), /sql94_share_already_revoked/);

  const list = async (token) => (await admin.query('SELECT public.aws_public_homeowner_shared_documents($1) AS d', [token])).rows[0].d;
  const one = async (token, id) => (await admin.query('SELECT public.aws_public_homeowner_shared_document($1, $2::uuid) AS d', [token, id])).rows[0].d;
  const a = await list('tok-claim-a-0001');
  assert.equal(a.ok, true);
  assert.deepEqual(a.documents.map((d) => d.id), [s1], 'claim A: only its non-revoked share');
  assert.deepEqual(Object.keys(a.documents[0]).sort(), ['category', 'file_name', 'file_size', 'id', 'mime_type', 'shared_at']);
  assert.equal(a.documents[0].category, 'template');
  const a2 = await list('tok-claim-a2-0001');
  assert.deepEqual(a2.documents.map((d) => d.id), [s2]);
  assert.equal((await list('tok-revoked-00001')).error, 'revoked');
  assert.equal((await list('tok-expired-00001')).error, 'expired');
  assert.equal((await list('tok-wrong-claim-01')).error, 'not_found');
  assert.deepEqual((await list('tok-pre-claim-001')).documents, []);
  assert.equal((await list('no-such-token-01')).error, 'not_found');

  const opened = await one('tok-claim-a-0001', s1);
  assert.equal(opened.ok, true);
  assert.equal(opened.tenant_id, TENANT_A);
  assert.match(opened.file_path, new RegExp(`^${TENANT_A}/library/template/`));
  // Another claim's share, a revoked share, a revoked token: nothing.
  assert.equal((await one('tok-claim-a-0001', s2)).error, 'not_found');
  assert.equal((await one('tok-claim-a-0001', s3)).error, 'not_found');
  assert.equal((await one('tok-revoked-00001', s1)).error, 'revoked');

  // Only checksops may call the readers.
  const grants = (await admin.query(`SELECT has_function_privilege('authenticated', 'public.aws_public_homeowner_shared_documents(text)', 'EXECUTE') AS auth,
    has_function_privilege('checksops', 'public.aws_public_homeowner_shared_documents(text)', 'EXECUTE') AS api`)).rows[0];
  assert.equal(grants.auth, false);
  assert.equal(grants.api, true);
}));
