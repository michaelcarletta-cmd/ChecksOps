import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePreflight } from '../../scripts/deployment-guard/cors-staging-live-probe.mjs';

const headers=(o={})=>new Headers(o);
test('allowed preflight requires reachable response, origin permission, and GET',()=>{
  assert.deepEqual(evaluatePreflight({status:204,headers:headers({'access-control-allow-origin':'https://staging.checksops.com','access-control-allow-methods':'GET,POST,OPTIONS'})},'https://staging.checksops.com'),{
    status:204,
    reachable:true,
    originAllowed:true,
    getAllowed:true,
    allowOrigin:'https://staging.checksops.com',
    allowMethods:'GET,POST,OPTIONS',
  });
});
test('missing CORS headers do not count as allowed',()=>{
  const r=evaluatePreflight({status:204,headers:headers({})},'https://staging.checksops.com');
  assert.equal(r.originAllowed,false); assert.equal(r.getAllowed,false);
});
test('server error is not a reachable acceptance response',()=>{
  assert.equal(evaluatePreflight({status:500,headers:headers({'access-control-allow-origin':'*','access-control-allow-methods':'GET'})},'https://staging.checksops.com').reachable,false);
});
