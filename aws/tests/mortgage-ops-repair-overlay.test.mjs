import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ISOLATED_USAGE_IMPORT,
  PROD_BILLING_INVOKE,
  PROD_INDEX_ASSET,
  PROD_QUEUE_ASSET,
  assertProductionIndexAuthority,
  patchLiveWorkflowRpcAccrualImport,
  patchProductionMortgageOpsQueue,
  patchWriteCheckClaimId,
} from '../../scripts/lib/mortgage-ops-repair-overlay.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('SQL 39 is a narrow Accept/Complete overlay', () => {
  const sql = readFileSync(path.join(ROOT, 'aws/rls/sql/39_mortgage_ops_agent_accept_complete.sql'), 'utf8');
  assert.match(sql, /CREATE POLICY aws_update_mortgage_ops_accept_complete/);
  assert.match(sql, /FOR UPDATE TO authenticated, checksops/);
  assert.match(sql, /FOR INSERT TO authenticated, checksops/);
  assert.match(sql, /FOR SELECT TO authenticated, checksops/);
  assert.match(sql, /GRANT UPDATE \(\s*assigned_employee_id,\s*accepted_at,\s*completed_at\s*\)/s);
  assert.equal(/GRANT UPDATE ON TABLE public\.mortgage_handling_requests/.test(sql), false);
  assert.match(sql, /DROP POLICY IF EXISTS aws_update_mortgage_handling_requests/);
  assert.doesNotMatch(sql, /DROP POLICY IF EXISTS aws_write_mortgage_handling_requests/);
  assert.doesNotMatch(sql, /DROP POLICY IF EXISTS aws_write_check_billing_events/);
  assert.doesNotMatch(sql, /FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /SECURITY DEFINER[\s\S]*accrue_mortgage_ops_billing/);
  assert.doesNotMatch(sql, /\bmoov\b/i);
  assert.doesNotMatch(sql, /\bstripe\b/i);
  assert.doesNotMatch(sql, /bill-mortgage-handling/);
  assert.match(sql, /assigned_employee_id = auth\.uid\(\)/);
  assert.match(sql, /status = 'requested' AND assigned_employee_id IS NULL/);
});

test('source workflow-rpc Accept uses isolated usage, not the Moov engine', () => {
  const src = readFileSync(path.join(ROOT, 'aws/functions/api/workflow-rpc.mjs'), 'utf8');
  assert.match(src, /accrueMortgageOpsAcceptedRequest/);
  assert.match(src, /mortgage-ops-usage\.mjs/);
  assert.equal(src.includes("import('./tenant-billing-engine.mjs')"), false);
  assert.equal(src.includes('save_claim_settlement_breakdown'), false);
});

test('source write-check insert server-derives claim_id', () => {
  const src = readFileSync(path.join(ROOT, 'aws/functions/api/write-check-workflow.mjs'), 'utf8');
  assert.match(src, /SELECT id, tenant_id, claim_id FROM public\.check_intake_items/);
  assert.match(src, /requested_by, status, claim_id/);
  assert.match(src, /looked\.check\.claim_id \|\| null/);
});

test('SPA Complete no longer invokes bill-mortgage-handling', () => {
  const src = readFileSync(path.join(ROOT, 'src/pages/mortgage-ops/MortgageOpsQueue.tsx'), 'utf8');
  assert.equal(src.includes('bill-mortgage-handling'), false);
  assert.match(src, /toast\.success\("Marked complete"\)/);
  assert.match(src, /accept_mortgage_handling_request/);
  assert.match(src, /update_mortgage_handling_request_status/);
});

test('live workflow-rpc overlay only retargets the Accept import', () => {
  const live = `if (!rows.length) return { error: 'already_taken' };
  try {
    const { accrueMortgageOpsAcceptedRequest } = await import('./tenant-billing-engine.mjs');
    await accrueMortgageOpsAcceptedRequest(client, { request: rows[0], persist: true });
  } catch {}
  case 'save_claim_settlement_breakdown':
  case 'admin_set_check_claim':`;
  const patched = patchLiveWorkflowRpcAccrualImport(live);
  assert.equal(patched.includes(ISOLATED_USAGE_IMPORT), true);
  assert.equal(patched.includes("import('./tenant-billing-engine.mjs')"), false);
  assert.match(patched, /save_claim_settlement_breakdown/);
  assert.match(patched, /admin_set_check_claim/);
});

test('live write-check overlay adds claim_id without dropping live lookup columns', () => {
  const live = `const rows = (await client.query(
    \`SELECT id, tenant_id, deposited_at, payee_line
     FROM public.check_intake_items WHERE id = $1::uuid\`,
    [checkId],
  )).rows;
      \`INSERT INTO public.mortgage_handling_requests (
         tenant_id, check_intake_item_id, mortgage_company, loan_number, note,
         requested_by, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
         $6::uuid, 'requested'
       ) RETURNING *\`,
      [
        looked.check.tenant_id,
        looked.check.id,
        company.value,
        loan.value,
        note.value,
        mapping.application_user_id,
      ],`;
  const patched = patchWriteCheckClaimId(live);
  assert.match(patched, /deposited_at, payee_line, claim_id/);
  assert.match(patched, /requested_by, status, claim_id/);
  assert.match(patched, /looked\.check\.claim_id \|\| null/);
});

test('production queue overlay removes Complete billing from the Branding composition', () => {
  const fixture = readFileSync(
    path.join(ROOT, 'tests/fixtures/current-live-MortgageOpsQueue-BD_nUT7A.js'),
    'utf8',
  );
  assert.equal(fixture.includes(PROD_BILLING_INVOKE), true);
  const patched = patchProductionMortgageOpsQueue(fixture);
  assert.equal(patched.includes('bill-mortgage-handling'), false);
  assert.match(patched, /P\(null\);u\.success\("Marked complete"\)/);
  assert.match(patched, /accept_mortgage_handling_request/);
});

test('production index authority remains BgOCQCWm', () => {
  const index = `lazy(()=>import("./${PROD_QUEUE_ASSET}")) ${PROD_INDEX_ASSET}`;
  assert.equal(assertProductionIndexAuthority(index), true);
  assert.equal(PROD_INDEX_ASSET, '/assets/index-BgOCQCWm.js');
});
