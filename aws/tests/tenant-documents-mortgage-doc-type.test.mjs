import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { executeTenantDocuments } from '../functions/api/write-app-metadata.mjs';
import {
  LEGACY_TENANT_DOCUMENT_DOC_TYPES,
  MORTGAGE_LIBRARY_DOC_TYPES,
  TENANT_DOCUMENT_DOC_TYPES,
  isAllowedTenantDocumentDocType,
  isApprovedMortgageLibraryDocType,
} from '../functions/api/mortgage-library-doc-types.mjs';
import {
  MORTGAGE_LIBRARY_DOC_TYPES as fromFrontend,
} from '../../src/lib/mortgageLibraryDocTypes.ts';
import {
  APPLY_ACK,
  APPLY_SQL_NAME,
  APPLY_SQL_PATH,
  ROLLBACK_SQL_NAME,
  STAGING_GUARDS,
  applySqlSha256,
  evaluateGuards,
  evaluateOperatorRequest,
  runOperator,
} from '../rls/operator/tenant-documents-mortgage-doc-type.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..');
const sha256 = (rel) => createHash('sha256').update(fs.readFileSync(path.join(REPO, rel))).digest('hex');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const CANONICAL = [
  'library:mortgage:w-9',
  'library:mortgage:contractor-license',
  'library:mortgage:general-liability-insurance',
  'library:mortgage:workers-comp-insurance',
  'library:mortgage:certificate-of-insurance',
  'library:mortgage:signed-contract',
  'library:mortgage:adjuster-tpa-letter',
];

test('frontend and API Mortgage Ops allowlists are identical canonical values', () => {
  assert.deepEqual([...MORTGAGE_LIBRARY_DOC_TYPES], CANONICAL);
  assert.deepEqual([...fromFrontend], CANONICAL);
  for (const value of CANONICAL) {
    assert.equal(isApprovedMortgageLibraryDocType(value), true);
    assert.equal(isAllowedTenantDocumentDocType(value), true);
  }
  assert.equal(isApprovedMortgageLibraryDocType('library:mortgage:evil'), false);
  assert.equal(isApprovedMortgageLibraryDocType('library:mortgage:other'), false);
  assert.equal(isAllowedTenantDocumentDocType('library:template:tpa'), false);
  assert.equal(isAllowedTenantDocumentDocType('library:shingle:oakridge'), false);
  assert.equal(isAllowedTenantDocumentDocType('verification'), false);
  assert.deepEqual([...LEGACY_TENANT_DOCUMENT_DOC_TYPES], [
    'w9', 'license', 'insurance', 'saas_agreement', 'terms_of_service', 'privacy_policy',
  ]);
  assert.equal(TENANT_DOCUMENT_DOC_TYPES.length, 13);
});

test('TenantDocumentLibrary no longer emits arbitrary mortgage suffixes', () => {
  const ui = read('src/components/settings/TenantDocumentLibrary.tsx');
  assert.match(ui, /mortgageLibraryDocTypeForLabel/);
  assert.match(ui, /isApprovedMortgageLibraryDocType/);
  assert.doesNotMatch(ui, /"Other"/);
  assert.doesNotMatch(ui, /library:\$\{category\}:\$\{slug\}/);
  assert.doesNotMatch(ui, /`library:\$\{category\}:\$\{slug\}`/);
  assert.match(ui, /docType = canonical/);
});

test('SQL 30 is an unapplied AWS operator package with no automatic path', () => {
  const apply = read(`aws/rls/sql/${APPLY_SQL_NAME}`);
  const rollback = read(`aws/rls/sql/${ROLLBACK_SQL_NAME}`);
  const complete = read('aws/rls/oneshot/completeAuth.mjs');
  const index = read('aws/rls/oneshot/index.mjs');
  const writePlan = read('aws/rls/oneshot/writePlan.mjs');
  const ci = read('.github/workflows/aws-migration-ci.yml');
  const pkg = read('package.json');
  const operator = read('aws/rls/operator/tenant-documents-mortgage-doc-type.mjs');

  assert.match(apply, /^BEGIN;/m);
  assert.match(apply, /^COMMIT;/m);
  assert.match(apply, /SET LOCAL lock_timeout = '3s'/);
  assert.match(apply, /SET LOCAL statement_timeout = '15s'/);
  assert.match(apply, /tenant_documents_doc_type_check/);
  assert.match(apply, /sql30_already_current/);
  assert.match(apply, /existing rows would violate replacement constraint/);
  assert.doesNotMatch(apply, /CREATE POLICY/i);
  assert.doesNotMatch(apply, /CREATE FUNCTION/i);
  assert.doesNotMatch(apply, /CREATE TRIGGER/i);
  assert.doesNotMatch(apply, /\bGRANT\b/);
  assert.doesNotMatch(apply, /\bREVOKE\b/);
  assert.doesNotMatch(apply, /\bUPDATE\b/);
  assert.doesNotMatch(apply, /\bDELETE\b/);
  assert.doesNotMatch(apply, /\bINSERT\b/);
  assert.doesNotMatch(apply, /LIKE 'library:mortgage:%'/);
  for (const value of CANONICAL) {
    assert.match(apply, new RegExp(`'${value}'`));
  }

  assert.match(rollback, /Mortgage Ops document rows would be invalidated/);
  assert.doesNotMatch(rollback, /\bDELETE\b/);
  assert.doesNotMatch(rollback, /\bUPDATE\b/);
  assert.doesNotMatch(rollback, /\bINSERT\b/);

  assert.doesNotMatch(complete, /readSql\('30_tenant_documents_mortgage_doc_type\.sql'\)/);
  assert.doesNotMatch(index, /applySql\('30_tenant_documents_mortgage_doc_type\.sql'\)/);
  assert.doesNotMatch(writePlan, /30_tenant_documents_mortgage_doc_type/);
  assert.doesNotMatch(index, /from '\.\/tenant-documents-mortgage-doc-type/);
  assert.doesNotMatch(complete, /24_complete_write_policies\.sql[\s\S]*30_tenant/);
  assert.doesNotMatch(operator, /readSql\('29_mortgage_ops_library_parity\.sql'\)/);
  assert.doesNotMatch(operator, /readSql\('24_complete_write_policies\.sql'\)/);
  assert.doesNotMatch(operator, /completeAuth/);
  assert.match(operator, /productionDefault: false/);
  assert.match(ci, /bun run test:aws-api/);
  assert.doesNotMatch(ci, /30_tenant_documents_mortgage_doc_type\.sql/);
  assert.doesNotMatch(pkg, /30_tenant_documents_mortgage_doc_type/);

  const migrations = fs.readdirSync(path.join(REPO, 'supabase/migrations'));
  assert.equal(migrations.some((name) => /tenant_documents_mortgage_doc_type|library:mortgage:w-9/.test(name)), false);
  for (const name of migrations) {
    if (!name.endsWith('.sql')) continue;
    const body = fs.readFileSync(path.join(REPO, 'supabase/migrations', name), 'utf8');
    assert.doesNotMatch(body, /library:mortgage:adjuster-tpa-letter/, name);
  }

  const sql29 = read('aws/rls/sql/29_mortgage_ops_library_parity.sql');
  assert.match(sql29, /td\.doc_type LIKE 'library:mortgage:%'/);
  assert.match(sql29, /_doc_type NOT LIKE 'library:mortgage:%'/);
});

test('operator plan refuses live work and requires staging SHA guards', async () => {
  const sha = applySqlSha256();
  assert.equal(sha, sha256(`aws/rls/sql/${APPLY_SQL_NAME}`));
  const plan = await runOperator({ mode: 'plan', env: {} });
  assert.equal(plan.connected, false);
  assert.equal(plan.applied, false);
  assert.equal(plan.appliesSql24, false);
  assert.equal(plan.appliesSql29, false);
  assert.equal(plan.completeAuth, false);
  assert.equal(plan.productionDefault, false);

  const badSha = evaluateOperatorRequest({
    mode: 'preflight',
    expectedSha: '0'.repeat(64),
    identity: { Account: STAGING_GUARDS.account, Region: STAGING_GUARDS.region },
    env: {
      AWS_REGION: STAGING_GUARDS.region,
      RDS_HOST: STAGING_GUARDS.endpointHost,
      CHECKSOPS_RDS_IDENTIFIER: STAGING_GUARDS.rdsIdentifier,
      CHECKSOPS_DATABASE: STAGING_GUARDS.database,
      CHECKSOPS_AWS_ACCOUNT: STAGING_GUARDS.account,
    },
  });
  assert.equal(badSha.ok, false);
  assert.equal(badSha.refusals.includes('expected_sql_sha_mismatch'), true);

  const prodHost = evaluateGuards({
    identity: { Account: STAGING_GUARDS.account, Region: STAGING_GUARDS.region },
    env: {
      AWS_REGION: STAGING_GUARDS.region,
      RDS_HOST: 'checksops-production.example.rds.amazonaws.com',
      CHECKSOPS_RDS_IDENTIFIER: 'checksops-production',
      CHECKSOPS_DATABASE: 'checksops',
      CHECKSOPS_AWS_ACCOUNT: STAGING_GUARDS.account,
    },
  });
  assert.equal(prodHost.ok, false);

  const applyRefused = evaluateOperatorRequest({
    mode: 'apply',
    expectedSha: sha,
    identity: { Account: STAGING_GUARDS.account, Region: STAGING_GUARDS.region },
    env: {
      AWS_REGION: STAGING_GUARDS.region,
      RDS_HOST: STAGING_GUARDS.endpointHost,
      CHECKSOPS_RDS_IDENTIFIER: STAGING_GUARDS.rdsIdentifier,
      CHECKSOPS_DATABASE: STAGING_GUARDS.database,
      CHECKSOPS_AWS_ACCOUNT: STAGING_GUARDS.account,
      CHECKSOPS_OPERATOR_EXECUTE: '1',
      CHECKSOPS_SQL30_APPLY: APPLY_ACK,
    },
  });
  assert.equal(applyRefused.ok, true);
  const withoutAck = evaluateOperatorRequest({
    mode: 'apply',
    expectedSha: sha,
    identity: { Account: STAGING_GUARDS.account, Region: STAGING_GUARDS.region },
    env: {
      AWS_REGION: STAGING_GUARDS.region,
      RDS_HOST: STAGING_GUARDS.endpointHost,
      CHECKSOPS_RDS_IDENTIFIER: STAGING_GUARDS.rdsIdentifier,
      CHECKSOPS_DATABASE: STAGING_GUARDS.database,
      CHECKSOPS_AWS_ACCOUNT: STAGING_GUARDS.account,
      CHECKSOPS_OPERATOR_EXECUTE: '1',
    },
  });
  assert.equal(withoutAck.refusals.includes('apply_ack_required'), true);

  const live = await runOperator({
    mode: 'preflight',
    expectedSha: sha,
    identity: { Account: STAGING_GUARDS.account, Region: STAGING_GUARDS.region },
    env: {
      AWS_REGION: STAGING_GUARDS.region,
      RDS_HOST: STAGING_GUARDS.endpointHost,
      CHECKSOPS_RDS_IDENTIFIER: STAGING_GUARDS.rdsIdentifier,
      CHECKSOPS_DATABASE: STAGING_GUARDS.database,
      CHECKSOPS_AWS_ACCOUNT: STAGING_GUARDS.account,
      CHECKSOPS_EXPECTED_SQL_SHA: sha,
    },
  });
  assert.equal(live.connected, false);
  assert.equal(live.refusals.includes('query_fn_required_in_this_process'), true);
});

test('executeTenantDocuments validates the exact allowlist before write', async () => {
  const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
  const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM public.tenant_users/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/INSERT INTO public.tenant_documents/.test(sql)) {
        return { rows: [{ id: 'doc-1', doc_type: params[1] }] };
      }
      if (/UPDATE public.tenant_documents/.test(sql)) {
        return { rows: [{ id: 'doc-1', doc_type: params[0] }] };
      }
      throw new Error(`unexpected query ${sql}`);
    },
  };
  const evil = await executeTenantDocuments({
    client,
    mapping: { application_user_id: APP_ID },
    op: 'insert',
    values: {
      tenant_id: TENANT,
      doc_type: 'library:mortgage:evil',
      file_path: `${TENANT}/library/mortgage/x.pdf`,
      file_name: 'evil',
    },
    filters: [],
  });
  assert.equal(evil.error, 'category_not_allowlisted');
  assert.equal(queries.some((row) => /INSERT INTO public.tenant_documents/.test(row.sql)), false);

  const ok = await executeTenantDocuments({
    client,
    mapping: { application_user_id: APP_ID },
    op: 'insert',
    values: {
      tenant_id: TENANT,
      doc_type: 'library:mortgage:w-9',
      file_path: `${TENANT}/library/mortgage/w9.pdf`,
      file_name: 'W-9',
    },
    filters: [],
  });
  assert.equal(ok.rows[0].doc_type, 'library:mortgage:w-9');

  const updateEvil = await executeTenantDocuments({
    client,
    mapping: { application_user_id: APP_ID },
    op: 'update',
    values: { doc_type: 'library:template:tpa' },
    filters: [{ column: 'id', op: 'eq', value: '33333333-3333-4333-8333-333333333333' }],
  });
  assert.equal(updateEvil.error, 'category_not_allowlisted');
});

test('documented SQL SHA matches the apply file bytes', () => {
  const docs = read('aws/rls/sql/30_tenant_documents_mortgage_doc_type.md');
  const sha = applySqlSha256();
  assert.match(docs, new RegExp(sha));
  assert.match(docs, /unapplied AWS operator package/i);
  assert.match(docs, /Do not apply from completeAuth/i);
  assert.equal(APPLY_SQL_PATH.endsWith(APPLY_SQL_NAME), true);
  assert.equal(ROLLBACK_SQL_NAME, '30_tenant_documents_mortgage_doc_type_rollback.sql');
});
