import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('CloudFront WAF keeps managed rules in COUNT and path rates conservative', () => {
  const yaml = read('production/waf-cloudfront.yaml');
  assert.match(yaml, /Name: checksops-production-cloudfront-waf/);
  assert.match(yaml, /Scope: CLOUDFRONT/);
  assert.match(yaml, /AWSManagedRulesCommonRuleSet/);
  assert.match(yaml, /AWSManagedRulesKnownBadInputsRuleSet/);
  assert.match(yaml, /AWSManagedRulesAmazonIpReputationList/);
  assert.match(yaml, /Name: AWSManagedCommonCount[\s\S]*?OverrideAction:\n\s+Count:/);
  assert.match(yaml, /Name: RateLimitGeneralCount[\s\S]*?Action:\n\s+Count: \{\}[\s\S]*?Limit: 2000/);
  assert.match(yaml, /Name: RateLimitAuth[\s\S]*?Action:\n\s+Block: \{\}[\s\S]*?Limit: 100/);
  assert.match(yaml, /Name: RateLimitStorage[\s\S]*?Action:\n\s+Block: \{\}[\s\S]*?Limit: 300/);
  assert.match(yaml, /Name: RateLimitPublic[\s\S]*?Action:\n\s+Block: \{\}[\s\S]*?Limit: 200/);
});

test('API WAF is regional, COUNT managed, and associates only to prep', () => {
  const yaml = read('production/waf-api.yaml');
  assert.match(yaml, /Name: checksops-production-api-waf/);
  assert.match(yaml, /Scope: REGIONAL/);
  assert.match(yaml, /Default: kiqojucc02/);
  assert.match(yaml, /Default: prep/);
  assert.match(yaml, /\/apis\/\$\{ApiId\}\/stages\/\$\{StageName\}/);
  assert.doesNotMatch(yaml, /psr19uhop4/);
  assert.match(yaml, /OverrideAction:\n\s+Count:/);
});

test('production CORS templates are allow-listed and staging stays wildcard', () => {
  const apiCfn = read('production/api-cfn.yaml');
  const staging = read('template.yaml');
  assert.match(apiCfn, /https:\/\/checksops\.com/);
  assert.match(apiCfn, /https:\/\/www\.checksops\.com/);
  assert.doesNotMatch(apiCfn, /AllowOrigins:\n        - '\*'/);
  assert.match(staging, /AllowOrigins:\n          - '\*'/);
});
