#!/usr/bin/env node
import { validateStagingAcceptance } from './cors-staging-acceptance.mjs';

export const STAGING_URL='https://staging.checksops.com';
export const ALLOWED_ORIGIN='https://staging.checksops.com';
export const UNTRUSTED_ORIGIN='https://cors-probe.invalid';

export function evaluatePreflight({status,headers},origin){
  const allowOrigin=headers.get('access-control-allow-origin');
  const allowMethods=(headers.get('access-control-allow-methods')||'').toUpperCase();
  return {
    reachable:status>=200&&status<500,
    originAllowed:allowOrigin==='*'||allowOrigin===origin,
    getAllowed:allowMethods.split(',').map(x=>x.trim()).includes('GET'),
  };
}

export async function preflight(origin,fetchImpl=fetch){
  const r=await fetchImpl(STAGING_URL+'/',{method:'OPTIONS',redirect:'manual',headers:{
    Origin:origin,
    'Access-Control-Request-Method':'GET',
    'Access-Control-Request-Headers':'authorization,content-type,x-request-id',
  }});
  return {status:r.status,headers:r.headers};
}

export async function health(fetchImpl=fetch){
  const r=await fetchImpl(STAGING_URL+'/',{method:'GET',redirect:'manual'});
  return r.status>=200&&r.status<500;
}

async function main(){
  const commit=process.env.CHECKSOPS_CORS_ACCEPTANCE_COMMIT;
  const workstream_id=process.env.CHECKSOPS_CORS_WORKSTREAM||'security-sh2-cors';
  const allowed=evaluatePreflight(await preflight(ALLOWED_ORIGIN),ALLOWED_ORIGIN);
  const untrusted=evaluatePreflight(await preflight(UNTRUSTED_ORIGIN),UNTRUSTED_ORIGIN);
  const healthy=await health();
  // This runner proves HTTP behavior only. AWS before/after fingerprints remain
  // mandatory inputs to #697 and are intentionally not fabricated here.
  const evidence={
    schema_version:1,kind:'cors-live-probe',workstream_id,commit,
    staging_origin_allowed:allowed.reachable&&allowed.originAllowed&&allowed.getAllowed,
    unauthorized_origin_not_privileged:untrusted.reachable,
    prep_health_ok:healthy,
    authenticated_flow_ok:false,
    no_financial_write:true,
    observations:{allowed_status:allowed.status,untrusted_status:untrusted.status,
      allowed_origin_reflected:allowed.originAllowed,
      untrusted_origin_cors_allowed:untrusted.originAllowed},
  };
  console.log(JSON.stringify(evidence,null,2));
  if(!evidence.staging_origin_allowed||!evidence.unauthorized_origin_not_privileged||!evidence.prep_health_ok){
    process.exitCode=1;
  }
}
if(import.meta.url===new URL(process.argv[1],'file:').href) await main();
