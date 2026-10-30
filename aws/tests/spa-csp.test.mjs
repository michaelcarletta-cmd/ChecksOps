/**
 * SPA Content-Security-Policy (2026-10-30): the staging report-only policy is built from
 * scripts/deployment-guard/lib/spa-csp.mjs, allows only the origins the SPA loads, never allows
 * 'unsafe-eval' or inline script beyond index.html's hashed script, and the template attaches
 * nothing. Runbook: ops/security/SPA_CSP_ROLLOUT.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import yaml from 'js-yaml';

import { STAGING_API_ORIGIN, buildCsp, cspDirectives, inlineScriptHashes } from '../../scripts/deployment-guard/lib/spa-csp.mjs';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const INDEX = read('index.html');
const TEMPLATE_REL = 'aws/staging/cloudfront-security-headers.yaml';
const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('!Ref', { kind: 'scalar', construct: (data) => ({ Ref: data }) })]);
const template = yaml.load(read(TEMPLATE_REL), { schema: CFN_SCHEMA });
const directive = (policy, name) => policy.split('; ').find((d) => d.startsWith(`${name} `))?.split(' ').slice(1) || null;

test('the staging template carries exactly the built report-only policy and the production baseline headers', () => {
  const resources = Object.values(template.Resources);
  assert.equal(resources.length, 1);
  const [policy] = resources;
  assert.equal(policy.Type, 'AWS::CloudFront::ResponseHeadersPolicy');
  const config = policy.Properties.ResponseHeadersPolicyConfig;
  assert.equal(config.Name, 'checksops-staging-browser-security-headers');
  assert.deepEqual(config.CustomHeadersConfig.Items.map((h) => h.Header), ['Content-Security-Policy-Report-Only']);
  assert.equal(config.CustomHeadersConfig.Items[0].Value, buildCsp({ environment: 'staging', indexHtml: INDEX }));
  // Report-only at this step: no enforcing CSP yet.
  assert.equal(config.SecurityHeadersConfig.ContentSecurityPolicy, undefined);
  const production = yaml.load(read('aws/production/cloudfront-security-headers.yaml'), { schema: CFN_SCHEMA });
  const baseline = Object.values(production.Resources)[0].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
  assert.deepEqual(config.SecurityHeadersConfig, baseline);
});

test('the template attaches nothing: no distribution, behavior or cache resources', () => {
  const text = read(TEMPLATE_REL);
  assert.match(text, /Source-only definition: this template does not attach/);
  for (const resource of Object.values(template.Resources)) assert.equal(resource.Type, 'AWS::CloudFront::ResponseHeadersPolicy');
  assert.equal(/AWS::CloudFront::Distribution|DistributionConfig|CacheBehavior/.test(text), false);
});

test('the policy blocks plugins, eval, foreign framing and form posts, and allows only index.html\'s hashed inline script', () => {
  for (const environment of ['staging', 'production']) {
    const policy = buildCsp({ environment, indexHtml: INDEX });
    assert.equal(policy.includes("'unsafe-eval'"), false, environment);
    assert.deepEqual(directive(policy, 'object-src'), ["'none'"], environment);
    assert.deepEqual(directive(policy, 'frame-ancestors'), ["'self'"], environment);
    assert.deepEqual(directive(policy, 'base-uri'), ["'self'"], environment);
    assert.deepEqual(directive(policy, 'form-action'), ["'self'"], environment);
    assert.deepEqual(directive(policy, 'default-src'), ["'self'"], environment);
    const script = directive(policy, 'script-src');
    assert.equal(script.includes("'unsafe-inline'"), false, environment);
    assert.deepEqual(script.filter((s) => s.startsWith("'sha256-")), inlineScriptHashes(INDEX), environment);
    for (const source of [...script, ...directive(policy, 'connect-src')]) {
      assert.ok(source === "'self'" || source.startsWith("'sha256-") || source.startsWith('https://') || ['data:', 'blob:'].includes(source), `${environment} ${source}`);
    }
  }
  // index.html has exactly one inline script today; a new one changes the hash list and this test.
  assert.equal(inlineScriptHashes(INDEX).length, 1);
});

test('connect-src names the API each environment calls and nothing wider', () => {
  const staging = directive(buildCsp({ environment: 'staging', indexHtml: INDEX }), 'connect-src');
  const production = directive(buildCsp({ environment: 'production', indexHtml: INDEX }), 'connect-src');
  assert.ok(staging.includes(STAGING_API_ORIGIN));
  assert.equal(production.includes(STAGING_API_ORIGIN), false);
  for (const list of [staging, production]) {
    assert.ok(list.includes('https://api.zippopotam.us'));
    assert.ok(list.includes('https://*.s3.amazonaws.com'));
    assert.equal(list.some((s) => s === 'https:' || s === '*' || s === 'https://*'), false);
  }
  assert.throws(() => cspDirectives({ environment: 'dev', indexHtml: INDEX }));
});

test('the pdf.js worker is self-hosted: no unpkg anywhere in the policy, scripts only from the SPA itself', () => {
  for (const environment of ['staging', 'production']) {
    const policy = buildCsp({ environment, indexHtml: INDEX });
    assert.equal(policy.includes('unpkg'), false, environment);
    assert.deepEqual(directive(policy, 'worker-src'), ["'self'", 'blob:'], environment);
    assert.deepEqual(directive(policy, 'script-src'), ["'self'", ...inlineScriptHashes(INDEX)], environment);
  }
  assert.equal(read(TEMPLATE_REL).includes('unpkg'), false);
});

test('2026-10-30 click-through: staging tenant logos load from the API, production stays same-origin', () => {
  // Owner's console on staging (policy d3f84b15): 22 img-src reports for
  // <STAGING_API_ORIGIN>/staging/storage/public?bucket=tenant-logos&path=... (getPublicUrl in
  // src/integrations/aws/storage.ts, src/lib/brandingPublicUrl.ts).
  const storage = read('src/integrations/aws/storage.ts');
  assert.match(storage, /\$\{awsApiBaseUrl\(\)\}\/storage\/public\?bucket=/);
  const staging = directive(buildCsp({ environment: 'staging', indexHtml: INDEX }), 'img-src');
  const production = directive(buildCsp({ environment: 'production', indexHtml: INDEX }), 'img-src');
  assert.ok(staging.includes(STAGING_API_ORIGIN));
  assert.equal(production.some((s) => s.includes('execute-api')), false);
  assert.deepEqual(production, ["'self'", 'data:', 'blob:', 'https://*.s3.amazonaws.com', 'https://*.s3.us-east-1.amazonaws.com']);
  // Only images: frame-src stays without the API host in both environments.
  for (const environment of ['staging', 'production']) {
    assert.equal(directive(buildCsp({ environment, indexHtml: INDEX }), 'frame-src').some((s) => s.includes('execute-api')), false, environment);
  }
});

test('index.html carries no CSP meta tag: frame-ancestors is ignored there and the header sets it', () => {
  assert.equal(/http-equiv=["']Content-Security-Policy/i.test(INDEX), false);
  for (const environment of ['staging', 'production']) {
    assert.deepEqual(directive(buildCsp({ environment, indexHtml: INDEX }), 'frame-ancestors'), ["'self'"], environment);
  }
});

test('enforce appends only upgrade-insecure-requests; the report-only policy and production default are unchanged', () => {
  for (const environment of ['staging', 'production']) {
    const reportOnly = buildCsp({ environment, indexHtml: INDEX });
    const enforcing = buildCsp({ environment, indexHtml: INDEX, enforce: true });
    assert.equal(enforcing, `${reportOnly}; upgrade-insecure-requests`, environment);
    assert.equal(buildCsp({ environment, indexHtml: INDEX, enforce: false }), reportOnly, environment);
    assert.equal(reportOnly.includes('upgrade-insecure-requests'), false, environment);
    assert.deepEqual(cspDirectives({ environment, indexHtml: INDEX, enforce: true }).at(-1), ['upgrade-insecure-requests', []]);
    // A directive without sources is the bare name, no trailing space.
    assert.equal(enforcing.endsWith('upgrade-insecure-requests'), true, environment);
  }
  // The template's report-only value is still exactly the default build.
  const config = Object.values(template.Resources)[0].Properties.ResponseHeadersPolicyConfig;
  assert.equal(config.CustomHeadersConfig.Items[0].Value, buildCsp({ environment: 'staging', indexHtml: INDEX }));
});
