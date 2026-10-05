#!/usr/bin/env node
/**
 * Read-only staging acceptance validator for the production CORS allow-list change.
 * It never mutates AWS. The caller supplies two independently captured staging
 * snapshots (before/after validation) plus observed CORS probe results.
 */
import { createHash } from 'node:crypto';

export const STAGING_API_ID='psr19uhop4';
export const STAGING_ORIGIN='https://staging.checksops.com';

const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=(v)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function normalizeStagingSnapshot({api,routes,lambda,cloudfront}) {
  return {
    api:{
      ApiId:api.ApiId,
      DisableExecuteApiEndpoint:api.DisableExecuteApiEndpoint,
      CorsConfiguration:api.CorsConfiguration,
    },
    routes:(routes.Items||[]).map(r=>({
      RouteKey:r.RouteKey,
      AuthorizationType:r.AuthorizationType,
      AuthorizerId:r.AuthorizerId||null,
      Target:r.Target||null,
    })).sort((a,b)=>a.RouteKey.localeCompare(b.RouteKey)),
    lambda:{CodeSha256:lambda.CodeSha256,RevisionId:lambda.RevisionId},
    cloudfront:{
      Id:cloudfront.Id,
      Status:cloudfront.Status,
      Aliases:[...(cloudfront.Aliases||[])].sort(),
    },
  };
}

export function validateStagingAcceptance(input={}) {
  const errors=[];
  const {before,after,probes,manual_uat,workstream_id,commit}=input;
  if(!workstream_id) errors.push('missing_workstream');
  if(!/^[0-9a-f]{40}$/.test(String(commit||''))) errors.push('missing_commit');
  if(!before||!after) errors.push('missing_snapshot');
  if(before?.api?.ApiId!==STAGING_API_ID) errors.push('wrong_staging_api');
  if(before?.api?.DisableExecuteApiEndpoint!==false) errors.push('execute_api_state_drift');
  if(!before?.api?.CorsConfiguration?.AllowOrigins?.includes('*')) errors.push('unexpected_staging_cors_baseline');
  if(!before?.cloudfront?.Aliases?.includes('staging.checksops.com')) errors.push('wrong_staging_cloudfront');
  if(before&&after&&!eq(before,after)) errors.push('staging_moved_during_acceptance');
  if(probes?.staging_origin_allowed!==true) errors.push('staging_origin_probe_failed');
  if(probes?.unauthorized_origin_not_privileged!==true) errors.push('unauthorized_origin_probe_failed');
  if(probes?.prep_health_ok!==true) errors.push('prep_health_failed');
  if(probes?.authenticated_flow_ok!==true) {
    const expectedFingerprint=before?hash(before):null;
    if(!manual_uat
      || manual_uat.kind!=='cors-manual-auth-uat'
      || manual_uat.workstream_id!==workstream_id
      || manual_uat.commit!==commit
      || manual_uat.staging_fingerprint!==expectedFingerprint
      || !String(manual_uat.operator||'').trim()
      || manual_uat.authenticated_login_ok!==true
      || manual_uat.no_financial_write!==true) {
      errors.push('authenticated_flow_failed');
    }
  }
  if(probes?.no_financial_write!==true) errors.push('financial_write_forbidden');
  if(errors.length) return {ok:false,errors};
  const evidence={
    schema_version:1,
    kind:'cors-staging-acceptance',
    workstream_id,
    commit,
    staging_api_id:STAGING_API_ID,
    staging_origin:STAGING_ORIGIN,
    live_fingerprint:hash(before),
    probes:{
      staging_origin_allowed:true,
      unauthorized_origin_not_privileged:true,
      prep_health_ok:true,
      authenticated_flow_ok:true,
      authenticated_flow_source:probes?.authenticated_flow_ok===true?'automated':'manual-attestation',
      no_financial_write:true,
    },
  };
  return {ok:true,reference:'cors-staging:'+hash(evidence),evidence};
}
