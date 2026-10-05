#!/usr/bin/env node
/**
 * Receipt-gated, CORS-only production HTTP API writer.
 *
 * Exact permitted mutation:
 *   AllowOrigins: ["*"] -> ["https://checksops.com","https://www.checksops.com"]
 *
 * Everything else is pinned and re-read immediately before UpdateApi.
 * No Lambda, CloudFront, route, authorizer, integration, stage, SQL, Cognito,
 * WAF, provider, financial, or SPA mutation is performed.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enforceScriptGuard } from './require-guard.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
export const API_ID = 'kiqojucc02';
export const CF_ID = 'E1B0ZWWO5559U5';
export const PREP_LAMBDA = 'checksops-production-prep-api';
export const EXPECTED = Object.freeze({
  cors: {
    AllowHeaders: ['authorization','content-type','x-request-id','x-bridge-secret'],
    AllowMethods: ['GET','POST','OPTIONS'],
    AllowOrigins: ['*'],
    MaxAge: 86400,
  },
  routes: [
    { RouteKey: '$default', AuthorizationType: 'CUSTOM', AuthorizerId: '0dwrwx' },
    { RouteKey: 'OPTIONS /{proxy+}', AuthorizationType: 'NONE', AuthorizerId: null },
  ],
  authorizer: { AuthorizerId: '0dwrwx', Name: 'checksops-production-origin-verify' },
  cloudfront: {
    Status: 'Deployed',
    ETag: 'E1VC38T7YXB528',
    WebACLId: 'arn:aws:wafv2:us-east-1:806168576068:global/webacl/checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7',
  },
  lambda: {
    CodeSha256: 'RUOC6wUAE9eCkhbhF8h8FAfUyegj9KCrvZt5vCojOlw=',
    RevisionId: '48b8b0da-7448-435b-b9ea-d068a4497f1e',
  },
});
export const TARGET_ORIGINS = Object.freeze(['https://checksops.com','https://www.checksops.com']);

const stable = (v) => JSON.stringify(v, Object.keys(v || {}).sort());
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const eq = (a,b) => JSON.stringify(a) === JSON.stringify(b);

function awsJson(args, env=process.env) {
  const out=execFileSync(AWS,['--region',REGION,'--output','json',...args],{encoding:'utf8',env});
  return out.trim()?JSON.parse(out):{};
}

export function normalizeSnapshot({api,routes,authorizers,cloudfront,lambda}) {
  const routeRows=(routes.Items||[]).map(r=>({
    RouteKey:r.RouteKey,
    AuthorizationType:r.AuthorizationType,
    AuthorizerId:r.AuthorizerId||null,
  })).sort((a,b)=>a.RouteKey.localeCompare(b.RouteKey));
  const auth=(authorizers.Items||[]).find(a=>a.AuthorizerId===EXPECTED.authorizer.AuthorizerId);
  return {
    api: {
      ApiId: api.ApiId,
      DisableExecuteApiEndpoint: api.DisableExecuteApiEndpoint,
      CorsConfiguration: api.CorsConfiguration,
    },
    routes: routeRows,
    authorizer: auth?{AuthorizerId:auth.AuthorizerId,Name:auth.Name}:null,
    cloudfront: {
      Status: cloudfront.Distribution?.Status,
      ETag: cloudfront.ETag,
      WebACLId: cloudfront.Distribution?.DistributionConfig?.WebACLId,
    },
    lambda: { CodeSha256:lambda.CodeSha256, RevisionId:lambda.RevisionId },
  };
}

export function validatePinnedSnapshot(s) {
  const errors=[];
  if(s.api.ApiId!==API_ID) errors.push('api_id_drift');
  if(s.api.DisableExecuteApiEndpoint!==false) errors.push('execute_api_state_drift');
  if(!eq(s.api.CorsConfiguration,EXPECTED.cors)) errors.push('cors_baseline_drift');
  if(!eq(s.routes,EXPECTED.routes)) errors.push('routes_drift');
  if(!eq(s.authorizer,EXPECTED.authorizer)) errors.push('authorizer_drift');
  if(!eq(s.cloudfront,EXPECTED.cloudfront)) errors.push('cloudfront_drift');
  if(!eq(s.lambda,EXPECTED.lambda)) errors.push('lambda_drift');
  return {ok:errors.length===0,errors,fingerprint:hash(s)};
}

export function desiredCors(current) {
  const keys=Object.keys(current||{}).sort();
  const expectedKeys=Object.keys(EXPECTED.cors).sort();
  if(!eq(keys,expectedKeys)) throw new Error('cors_shape_drift');
  return {...current,AllowOrigins:[...TARGET_ORIGINS]};
}

function readSnapshot(env=process.env) {
  return normalizeSnapshot({
    api:awsJson(['apigatewayv2','get-api','--api-id',API_ID],env),
    routes:awsJson(['apigatewayv2','get-routes','--api-id',API_ID],env),
    authorizers:awsJson(['apigatewayv2','get-authorizers','--api-id',API_ID],env),
    cloudfront:awsJson(['cloudfront','get-distribution','--id',CF_ID],env),
    lambda:awsJson(['lambda','get-function-configuration','--function-name',PREP_LAMBDA],env),
  });
}

export function assertOnlyCorsDelta(before,after) {
  const expected=structuredClone(before);
  expected.api.CorsConfiguration=desiredCors(before.api.CorsConfiguration);
  if(!eq(after,expected)) throw new Error('post_write_non_cors_drift');
}

export function main(env=process.env) {
  if(env.CHECKSOPS_PRODUCTION_CORS_EXECUTE!=='1') {
    process.stdout.write(JSON.stringify({ok:false,plan_only:true,api_id:API_ID,allowed_delta:{AllowOrigins:TARGET_ORIGINS}})+'\n');
    return 2;
  }

  const first=readSnapshot(env);
  const checked=validatePinnedSnapshot(first);
  if(!checked.ok) throw new Error('preflight_drift:'+checked.errors.join(','));

  enforceScriptGuard({
    script:import.meta.url,
    target_environment:'production',
    target_component:'production-http-api',
    deployment_type:'apigateway-cors-update',
    preflight_live_fingerprint:first,
    workstream_id:env.CHECKSOPS_WORKSTREAM_ID,
    commit:env.CHECKSOPS_COMMIT,
  },{env});

  // Mandatory TOCTOU read immediately before the only mutation.
  const second=readSnapshot(env);
  const rechecked=validatePinnedSnapshot(second);
  if(!rechecked.ok || rechecked.fingerprint!==checked.fingerprint) {
    throw new Error('toctou_drift:'+(rechecked.errors||[]).join(','));
  }

  const desired=desiredCors(second.api.CorsConfiguration);
  awsJson(['apigatewayv2','update-api','--api-id',API_ID,'--cors-configuration',JSON.stringify(desired)],env);

  const after=readSnapshot(env);
  assertOnlyCorsDelta(second,after);
  if(!eq(after.api.CorsConfiguration.AllowOrigins,TARGET_ORIGINS)) throw new Error('cors_post_verify_failed');
  process.stdout.write(JSON.stringify({ok:true,api_id:API_ID,before_fingerprint:checked.fingerprint,after_fingerprint:hash(after),AllowOrigins:after.api.CorsConfiguration.AllowOrigins})+'\n');
  return 0;
}

const isDirect=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isDirect){try{process.exitCode=main();}catch(e){process.stderr.write(JSON.stringify({ok:false,message:e?.message||String(e)})+'\n');process.exitCode=2;}}
