import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  HEADER_NAME,
  SECRET_NAME,
  evaluateOriginVerify,
  headerFromEvent,
  parseSecretString,
  secretsMatch,
} from '../functions/origin-verify/authorizer.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const design = read('aws/cutover/API_BEHIND_CLOUDFRONT_STEP3_DESIGN.md');
const yaml = read('aws/production/cursor-api-perimeter-step3-role.yaml');
const allow = JSON.parse(read('aws/production/cursor-api-perimeter-step3-role-allow.json'));
const deny = JSON.parse(read('aws/production/cursor-api-perimeter-step3-role-deny.json'));
const trust = JSON.parse(read('aws/production/cursor-api-perimeter-step3-role-trust.json'));
const authorizer = read('aws/functions/origin-verify/authorizer.mjs');
const banner = read('src/components/AwsStagingBanner.tsx');
const financialSql = read('aws/financial/sql/64_financial_activation_grants.sql');

test('Step 3 design is review-only and does not deploy', () => {
  assert.match(design, /STOP FOR REVIEW\. DO NOT DEPLOY STEP 3/);
  assert.match(design, /DO NOT DEPLOY FROM THIS PR|READ-ONLY INSPECTION \+ DESIGN ONLY/);
  assert.match(design, /Do \*\*not\*\* set `DisableExecuteApiEndpoint=true`/);
  assert.match(design, /productionExecution=false/);
  assert.match(design, /Moov=false/);
  assert.match(design, /CheckAlt=false/);
  assert.match(design, /provider=false/);
  assert.match(design, /financial=false/);
  assert.match(design, /64_financial_activation_grants\.sql` stays \*\*NOT_APPLIED\*\*/);
  assert.match(design, /Vite\nenvironment variables \(`VITE_\*`\)/);
  assert.match(design, /Do \*\*not\*\* delete or\nbroaden `ChecksOpsCursorApiPerimeterSteps12Temp`/);
  assert.equal([...design.matchAll(/DisableExecuteApiEndpoint=true/g)].length, 2);
  assert.match(design, /Would outage `\/prep`/);
  assert.doesNotMatch(design, /aws cloudfront update-distribution/);
  assert.doesNotMatch(design, /aws apigatewayv2 update-api/);
  assert.doesNotMatch(design, /aws apigatewayv2 create-authorizer/);
  assert.doesNotMatch(design, /origin-verify secret created/);
});

test('Step 3 architecture keeps HTTP API and adds observe-before-require', () => {
  assert.match(design, /AuthorizerType` \| `REQUEST`/);
  assert.match(design, /AuthorizerPayloadFormatVersion` \| `2\.0`/);
  assert.match(design, /EnableSimpleResponses` \| `true`/);
  assert.match(design, /\$context\.httpMethod/);
  assert.match(design, /AuthorizerResultTtlInSeconds` \| `0`/);
  assert.match(design, /OPTIONS \/\{\{proxy\+\}\}|OPTIONS \/\{\proxy\+\}/);
  assert.match(design, /observe/);
  assert.match(design, /ORIGIN_VERIFY_REQUIRE=true/);
  assert.match(design, /remove:header\.x-checksops-origin-verify/);
  assert.match(design, /dual|current.+\n.*next|"current".*"next"/);
  assert.match(design, /x-checksops-origin-verify/);
  assert.match(design, /checksops\/production\/cloudfront-origin-verify/);
  assert.match(design, /kiqojucc02/);
  assert.match(design, /E1B0ZWWO5559U5/);
  assert.match(design, /Do \*\*not\*\* convert HTTP API `kiqojucc02` to REST/);
  assert.match(design, /operator confirms/);
});

test('Step 3 validation and rollback preserve holds and execute-api', () => {
  assert.match(design, /CloudFront `\/prep\/health`/);
  assert.match(design, /Raw execute-api without header/);
  assert.match(design, /fabricated header/);
  assert.match(design, /holds\.ok=true/);
  assert.match(design, /AuthorizationType=NONE/);
  assert.match(design, /GetDistributionConfig/);
  assert.match(design, /AwsStagingBanner/);
  assert.match(design, /window\.location\.hostname/);
  assert.match(design, /Do \*\*not\*\* rename or invert `isAwsStaging\(\)`/);
});

test('reference authorizer never logs headers and supports dual-secret observe/require', () => {
  assert.equal(HEADER_NAME, 'x-checksops-origin-verify');
  assert.equal(SECRET_NAME, 'checksops/production/cloudfront-origin-verify');
  assert.match(authorizer, /safeObserveLog/);
  assert.doesNotMatch(authorizer, /console\.(info|debug|warn)/);
  assert.doesNotMatch(authorizer, /console\.log\(event/);
  assert.doesNotMatch(authorizer, /VITE_/);
  assert.match(authorizer, /timingSafeEqual/);
  assert.match(authorizer, /ORIGIN_VERIFY_REQUIRE/);

  const secrets = { current: 'current-secret-value', next: 'next-secret-value' };
  assert.equal(headerFromEvent({ headers: { 'X-Checksops-Origin-Verify': 'abc' } }), 'abc');
  assert.equal(secretsMatch('current-secret-value', secrets), true);
  assert.equal(secretsMatch('next-secret-value', secrets), true);
  assert.equal(secretsMatch('nope', secrets), false);
  assert.deepEqual(parseSecretString('{"current":"a","next":"b"}'), { current: 'a', next: 'b' });

  const observeMissing = evaluateOriginVerify({ header: '', secrets, require: false });
  assert.equal(observeMissing.isAuthorized, true);
  assert.equal(observeMissing.context.originHeaderPresent, '0');
  assert.equal(observeMissing.context.originVerified, '0');

  const requireMissing = evaluateOriginVerify({ header: '', secrets, require: true });
  assert.equal(requireMissing.isAuthorized, false);

  const requireWrong = evaluateOriginVerify({ header: 'fabricated', secrets, require: true });
  assert.equal(requireWrong.isAuthorized, false);
  assert.equal(requireWrong.context.originHeaderPresent, '1');
  assert.equal(requireWrong.context.originVerified, '0');

  const requireCurrent = evaluateOriginVerify({
    header: 'current-secret-value',
    secrets,
    require: true,
  });
  assert.equal(requireCurrent.isAuthorized, true);
  assert.equal(requireCurrent.context.originVerified, '1');

  const requireNext = evaluateOriginVerify({
    header: 'next-secret-value',
    secrets,
    require: true,
  });
  assert.equal(requireNext.isAuthorized, true);
});

test('Step 3 role template is gated and least-privilege', () => {
  assert.match(yaml, /DeployRole:\n    Type: String\n    Default: "false"/);
  assert.match(yaml, /ChecksOpsCursorApiPerimeterStep3Temp/);
  assert.match(yaml, /DO NOT DEPLOY FROM THIS PR/);
  assert.match(yaml, /Does not broaden\n {2}ChecksOpsCursorCloudStaging/);
  assert.match(yaml, /Does not delete or broaden\n {2}ChecksOpsCursorApiPerimeterSteps12Temp/);
  assert.match(yaml, /checksops-production-origin-verify/);
  assert.match(yaml, /user:325724407/);
  assert.match(yaml, /lambda.amazonaws.com/);
  assert.doesNotMatch(yaml, /DeployRole default true/);
  assert.equal(trust.Statement[0].Condition.StringEquals['api.cursor.com:aud'], 'sts.amazonaws.com');
  assert.equal(trust.Statement[0].Condition.StringEquals['api.cursor.com:sub'], 'user:325724407');

  const allowText = JSON.stringify(allow);
  const denyText = JSON.stringify(deny);
  assert.match(allowText, /E1B0ZWWO5559U5/);
  assert.match(allowText, /checksops-production-origin-verify/);
  assert.match(allowText, /kiqojucc02/);
  assert.match(allowText, /cloudfront-origin-verify/);
  assert.doesNotMatch(allowText, /checksops-production-prep-api/);
  assert.doesNotMatch(allowText, /CreateInvalidation/);
  assert.match(denyText, /rds:\*/);
  assert.match(denyText, /cognito-idp:\*/);
  assert.match(denyText, /wafv2:\*/);
  assert.match(denyText, /route53:\*/);
  assert.match(denyText, /cloudtrail:\*/);
  assert.match(denyText, /DenyApiLevelAndStageMutation/);
  assert.match(denyText, /ChecksOpsCursorApiPerimeterSteps12Temp/);
  assert.match(denyText, /ChecksOpsCursor\*/);
  assert.match(denyText, /checksops-production-api-execution/);
  assert.ok(allowText.length < 6144, allowText.length);
  assert.ok(denyText.length < 6144, denyText.length);
});

test('staging banner is suppressed on production hosts and financial SQL stays unapplied', () => {
  const indexHtml = read('index.html');
  assert.match(banner, /AWS staging — Cognito \+ RDS/);
  assert.match(banner, /window\.location\.hostname/);
  assert.match(banner, /checksops\.com/);
  assert.match(banner, /www\.checksops\.com/);
  assert.match(banner, /isAwsStaging\(\)/);
  assert.match(indexHtml, /checksops-production-host/);
  assert.match(indexHtml, /data-testid="aws-staging-banner"/);
  assert.match(financialSql, /DO NOT APPLY THIS FILE/);
});
