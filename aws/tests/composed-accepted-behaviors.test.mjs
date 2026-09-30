/**
 * Source union of accepted Claim Ledger + Claim # + live Signature/admin/mortgage.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { INTAKE_PROHIBITED_COLUMNS, WRITE_ALLOWLIST, pickAllowlistedValues } from '../functions/api/write-allowlist.mjs';
import { executeAppMetadataWrite, executeTenantsCreate } from '../functions/api/write-app-metadata.mjs';
import { executeSignatureWrite } from '../functions/api/write-signature.mjs';
import { SAFE_WRITE_RPCS } from '../functions/api/workflow-rpc.mjs';

const WRITE_SRC = readFileSync('aws/functions/api/write.mjs', 'utf8');
const WORKFLOW_RPC = readFileSync('aws/functions/api/workflow-rpc.mjs', 'utf8');
const WORKFLOW_WRITE = readFileSync('aws/functions/api/write-check-workflow.mjs', 'utf8');
const META_SRC = readFileSync('aws/functions/api/write-app-metadata.mjs', 'utf8');

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

test('Review Claim # peel and generic prohibitions remain', () => {
  assert.match(WRITE_SRC, /const peelReviewClaimNumber/);
  assert.match(WRITE_SRC, /review_save_detected_claim_number/);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('detected_claim_number'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('claim_id'), true);
  const deniedClaim = pickAllowlistedValues('check_intake_items', { detected_claim_number: '695064-GQ' });
  assert.equal(deniedClaim.error, 'column_not_allowlisted');
  const deniedId = pickAllowlistedValues('check_intake_items', { claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  assert.equal(deniedId.error, 'column_not_allowlisted');
});

test('Claim Ledger SQL44 routing and linked update-only remain', () => {
  assert.equal(SAFE_WRITE_RPCS.has('claim_ledger_link_or_create'), true);
  assert.match(WORKFLOW_RPC, /executeClaimLedgerLinkOrCreate/);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('update'), true);
  assert.equal(WRITE_ALLOWLIST.claims.ops.has('insert'), false);
  assert.deepEqual([...WRITE_ALLOWLIST.claims.columns], ['claim_number']);
  assert.match(META_SRC, /export const executeClaimsNumberUpdate/);
});

test('Signature draft inserts stay allowlisted and locked to draft', async () => {
  assert.equal(WRITE_ALLOWLIST.signature_requests.ops.has('insert'), true);
  assert.equal(WRITE_ALLOWLIST.signature_signers.ops.has('insert'), true);
  assert.match(WORKFLOW_WRITE, /executeSignatureWrite/);
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM public.claims/.test(sql)) return { rows: [{ id: TENANT }] };
      if (/INSERT INTO public.signature_requests/.test(sql)) {
        assert.equal(params[6], 'draft');
        return { rows: [{ id: 'sig-1', status: 'draft' }] };
      }
      return { rows: [] };
    },
  };
  const sent = await executeSignatureWrite({
    client,
    table: 'signature_requests',
    op: 'insert',
    values: {
      claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      document_name: 'Release',
      document_path: 'claim-files/demo.pdf',
      status: 'sent',
    },
  });
  assert.equal(sent.error, 'column_not_allowlisted');
  const draft = await executeSignatureWrite({
    client,
    table: 'signature_requests',
    op: 'insert',
    values: {
      claim_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      document_name: 'Release',
      document_path: 'claim-files/demo.pdf',
    },
  });
  assert.equal(draft.rows[0].status, 'draft');
});

test('admin_set_check_claim and mortgage accept accrual remain in workflow-rpc', () => {
  assert.equal(SAFE_WRITE_RPCS.has('admin_set_check_claim'), true);
  assert.match(WORKFLOW_RPC, /export const executeAdminSetCheckClaim/);
  assert.match(WORKFLOW_RPC, /accrueMortgageOpsAcceptedRequest/);
});

test('Admin tenant-create applies server Moov defaults', async () => {
  assert.equal(WRITE_ALLOWLIST.tenants.ops.has('insert'), true);
  assert.match(META_SRC, /export const executeTenantsCreate/);
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/is_platform_owner/.test(sql)) return { rows: [{ is_owner: true, is_master: false }] };
      if (/INSERT INTO public.tenants/.test(sql)) {
        assert.equal(params[2], 'moov');
        assert.equal(params[3], true);
        return { rows: [{ id: TENANT, name: params[0], slug: params[1], payment_provider: params[2] }] };
      }
      return { rows: [] };
    },
  };
  const created = await executeTenantsCreate({
    client,
    mapping: { application_user_id: APP_ID },
    values: { name: 'New Co', slug: 'New Co!' },
  });
  assert.equal(created.rows[0].payment_provider, 'moov');
  assert.equal(created.rows[0].slug, 'new-co');
});

test('endorsement-material invalidation stays wired on payee updates', () => {
  assert.match(WORKFLOW_WRITE, /invalidateEndorsementsForMaterialPayeeChange/);
  const invalidation = readFileSync('aws/functions/api/endorsement-material-invalidation.mjs', 'utf8');
  assert.match(invalidation, /export const invalidateEndorsementsForMaterialPayeeChange/);
  assert.match(invalidation, /MATERIAL_PAYEE_FIELDS/);
});

test('Check Files can attach a signature_request_id', () => {
  assert.equal(WRITE_ALLOWLIST.check_files.columns.has('signature_request_id'), true);
  assert.equal(WRITE_ALLOWLIST.check_files.filterColumns.has('file_path'), true);
});

test('dedicated settlement-breakdown RPC is routed and generic table write stays denied', () => {
  assert.equal(SAFE_WRITE_RPCS.has('save_claim_settlement_breakdown'), true);
  assert.match(WORKFLOW_RPC, /executeClaimSettlementBreakdownWrite/);
  assert.equal(WRITE_ALLOWLIST.claim_settlements, undefined);
  const clientSrc = readFileSync('src/integrations/aws/client.ts', 'utf8');
  assert.match(clientSrc, /save_claim_settlement_breakdown/);
  assert.doesNotMatch(clientSrc, /"claim_settlements",/);
});

test('Moov/provider flags stay off the tenant client allowlist', () => {
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('moov_allowlisted'), false);
  assert.equal(WRITE_ALLOWLIST.tenants.columns.has('payment_provider'), false);
  assert.ok(WRITE_ALLOWLIST.tenants.clientIgnored.has('moov_allowlisted'));
  const result = executeAppMetadataWrite;
  assert.equal(typeof result, 'function');
});
