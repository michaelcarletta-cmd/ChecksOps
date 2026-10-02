/**
 * Surgical overlays onto live Lambda/SPA members.
 * Never replace live workflow-rpc or write-check-workflow with origin/main.
 */
export const LIVE_WORKFLOW_RPC_ACCRUE_IMPORT = "await import('./tenant-billing-engine.mjs')";
export const ISOLATED_USAGE_IMPORT = "await import('./mortgage-ops-usage.mjs')";

export const PROD_INDEX_ASSET = '/assets/index-BgOCQCWm.js';
export const PROD_QUEUE_ASSET = 'MortgageOpsQueue-BD_nUT7A.js';

export const PROD_BILLING_INVOKE = 'const{data:S,error:Q}=await d.functions.invoke("bill-mortgage-handling",{body:{request_id:n}});if(P(null),Q||!(S!=null&&S.ok)){const W=(S==null?void 0:S.error)||(Q==null?void 0:Q.message)||"billing failed";u.error(`Marked complete — billing failed: ${W}`)}else if(S!=null&&S.already_billed)u.success("Marked complete (already billed)");else{const ee=((S.total_cents??S.flat_fee_cents)/100).toFixed(2);u.success(`Marked complete — billed $${ee} to ${S.tenant_name}`)}';
export const PROD_BILLING_REPLACEMENT = 'P(null);u.success("Marked complete")';

export function patchLiveWorkflowRpcAccrualImport(source) {
  const text = String(source || '');
  if (!text.includes(LIVE_WORKFLOW_RPC_ACCRUE_IMPORT)) {
    if (text.includes(ISOLATED_USAGE_IMPORT)) return text;
    throw new Error('live workflow-rpc does not contain tenant-billing-engine Accept import');
  }
  return text.replaceAll(LIVE_WORKFLOW_RPC_ACCRUE_IMPORT, ISOLATED_USAGE_IMPORT);
}

export function patchWriteCheckClaimId(source) {
  let out = String(source || '');
  const liveLookup = 'SELECT id, tenant_id, deposited_at, payee_line\n     FROM public.check_intake_items WHERE id = $1::uuid';
  const liveLookupPatched = 'SELECT id, tenant_id, deposited_at, payee_line, claim_id\n     FROM public.check_intake_items WHERE id = $1::uuid';
  const mainLookup = 'SELECT id, tenant_id FROM public.check_intake_items WHERE id = $1::uuid';
  const mainLookupPatched = 'SELECT id, tenant_id, claim_id FROM public.check_intake_items WHERE id = $1::uuid';

  if (out.includes(liveLookup)) out = out.replace(liveLookup, liveLookupPatched);
  else if (out.includes(mainLookup) && !out.includes(mainLookupPatched)) {
    out = out.replace(mainLookup, mainLookupPatched);
  }

  const oldInsert = `INSERT INTO public.mortgage_handling_requests (
         tenant_id, check_intake_item_id, mortgage_company, loan_number, note,
         requested_by, status
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
         $6::uuid, 'requested'
       ) RETURNING *`;
  const newInsert = `INSERT INTO public.mortgage_handling_requests (
         tenant_id, check_intake_item_id, mortgage_company, loan_number, note,
         requested_by, status, claim_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
         $6::uuid, 'requested', $7::uuid
       ) RETURNING *`;
  if (out.includes(oldInsert)) out = out.replace(oldInsert, newInsert);

  const oldParams = `        looked.check.tenant_id,
        looked.check.id,
        company.value,
        loan.value,
        note.value,
        mapping.application_user_id,
      ],`;
  const newParams = `        looked.check.tenant_id,
        looked.check.id,
        company.value,
        loan.value,
        note.value,
        mapping.application_user_id,
        looked.check.claim_id || null,
      ],`;
  if (out.includes(oldParams)) out = out.replace(oldParams, newParams);
  return out;
}

export function patchProductionMortgageOpsQueue(source) {
  const text = String(source || '');
  if (!text.includes('bill-mortgage-handling')) {
    if (text.includes(PROD_BILLING_REPLACEMENT)) return text;
    throw new Error('production MortgageOpsQueue is missing bill-mortgage-handling');
  }
  if (!text.includes(PROD_BILLING_INVOKE)) {
    throw new Error('production MortgageOpsQueue billing invoke drifted from the expected needle');
  }
  const next = text.replace(PROD_BILLING_INVOKE, PROD_BILLING_REPLACEMENT);
  if (next.includes('bill-mortgage-handling')) {
    throw new Error('production MortgageOpsQueue still references bill-mortgage-handling after patch');
  }
  return next;
}

export function assertProductionIndexAuthority(indexSource, indexName = 'index-BgOCQCWm.js') {
  const text = String(indexSource || '');
  if (!text.includes(PROD_QUEUE_ASSET)) {
    throw new Error(`production index ${indexName} does not reference ${PROD_QUEUE_ASSET}`);
  }
  if (text.includes('bill-mortgage-handling')) {
    throw new Error('production index unexpectedly contains bill-mortgage-handling');
  }
  return true;
}
