import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeStagingSnapshot, validateStagingAcceptance } from '../../scripts/deployment-guard/cors-staging-acceptance.mjs';

function snap(){
  return normalizeStagingSnapshot({
    api:{ApiId:'psr19uhop4',DisableExecuteApiEndpoint:false,CorsConfiguration:{AllowHeaders:['authorization','content-type','x-request-id'],AllowMethods:['GET','POST','PUT','PATCH','DELETE','OPTIONS'],AllowOrigins:['*']}},
    routes:{Items:[{RouteKey:'$default',AuthorizationType:'NONE',Target:'integrations/abc'}]},
    lambda:{CodeSha256:'sha',RevisionId:'rev'},
    cloudfront:{Id:'E1CG52WRQZI7X1',Status:'Deployed',Aliases:['staging.checksops.com']},
  });
}
const good=()=>({workstream_id:'security-sh2-cors',commit:'a'.repeat(40),before:snap(),after:snap(),probes:{staging_origin_allowed:true,unauthorized_origin_not_privileged:true,prep_health_ok:true,authenticated_flow_ok:true,no_financial_write:true}});

function manualGood(){
  const x=good();
  x.probes.authenticated_flow_ok=false;
  const fingerprint=validateStagingAcceptance({...x,probes:{...x.probes,authenticated_flow_ok:true}}).evidence.live_fingerprint;
  x.manual_uat={kind:'cors-manual-auth-uat',workstream_id:x.workstream_id,commit:x.commit,staging_fingerprint:fingerprint,operator:'michaelcarletta-cmd',authenticated_login_ok:true,no_financial_write:true};
  return x;
}

test('read-only staging acceptance emits deterministic reference',()=>{
  const a=validateStagingAcceptance(good());
  const b=validateStagingAcceptance(good());
  assert.equal(a.ok,true);
  assert.equal(a.reference,b.reference);
  assert.match(a.reference,/^cors-staging:[0-9a-f]{64}$/);
});

test('staging drift fails closed',()=>{
  const x=good(); x.after.lambda.RevisionId='moved';
  const r=validateStagingAcceptance(x);
  assert.equal(r.ok,false);
  assert.ok(r.errors.includes('staging_moved_during_acceptance'));
});

test('missing or failed probes fail closed',()=>{
  for(const key of ['staging_origin_allowed','unauthorized_origin_not_privileged','prep_health_ok','authenticated_flow_ok','no_financial_write']){
    for(const value of [false,undefined]){
      const x=good(); x.probes[key]=value;
      assert.equal(validateStagingAcceptance(x).ok,false);
    }
  }
});

test('financial mutation is never accepted as UAT',()=>{
  const x=good(); x.probes.no_financial_write=false;
  const r=validateStagingAcceptance(x);
  assert.equal(r.ok,false);
  assert.ok(r.errors.includes('financial_write_forbidden'));
});


test('manual authenticated UAT is accepted only when bound to exact staging evidence',()=>{
  const r=validateStagingAcceptance(manualGood());
  assert.equal(r.ok,true);
  assert.equal(r.evidence.probes.authenticated_flow_source,'manual-attestation');
});

test('manual UAT fails closed on provenance or fingerprint mismatch',()=>{
  for(const mutate of [
    x=>{x.manual_uat.commit='b'.repeat(40);},
    x=>{x.manual_uat.staging_fingerprint='0'.repeat(64);},
    x=>{x.manual_uat.operator='';},
    x=>{x.manual_uat.authenticated_login_ok=false;},
    x=>{x.manual_uat.no_financial_write=false;},
  ]){
    const x=manualGood(); mutate(x);
    const r=validateStagingAcceptance(x);
    assert.equal(r.ok,false);
    assert.ok(r.errors.includes('authenticated_flow_failed'));
  }
});
