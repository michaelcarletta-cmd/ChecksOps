import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const extractJsonAfter = (text, label) => {
  const idx = text.indexOf(label);
  assert.ok(idx !== -1, `missing ${label}`);
  const start = text.indexOf('{', idx + label.length);
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return JSON.parse(text.slice(start, end + 1));
};

const loadHandler = () => {
  const code = read('aws/cloudfront/spa-fallback.js');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${code}\nthis.handler = handler;`, ctx);
  return ctx.handler;
};

test('SPA fallback function rewrites deep links and never HTML-ifies /prep', () => {
  const handler = loadHandler();
  const run = (uri) => handler({ request: { uri, querystring: { keep: { value: '1' } } } });

  assert.equal(run('/login').uri, '/index.html');
  assert.equal(run('/sign').uri, '/index.html');
  assert.equal(run('/endorse').uri, '/index.html');
  assert.equal(run('/acme/checks').uri, '/index.html');
  assert.equal(run('/').uri, '/index.html');
  assert.equal(run('/assets/index-C24V_ODo.js').uri, '/assets/index-C24V_ODo.js');
  assert.equal(run('/favicon.ico').uri, '/favicon.ico');
  assert.equal(run('/prep').uri, '/prep');
  assert.equal(run('/prep/health').uri, '/prep/health');
  assert.equal(run('/prep/auth/login').uri, '/prep/auth/login');
  assert.equal(run('/prepayment').uri, '/index.html');
  const kept = run('/login');
  assert.equal(kept.querystring.keep.value, '1');
});

test('Step 1 proposed distribution is API-behind-CloudFront without dropping WAF or execute-api', () => {
  const built = spawnSync(process.execPath, [path.join(ROOT, 'aws/cloudfront/build-step1-config.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(built.status, 0, built.stderr);
  const proposed = JSON.parse(read('aws/cloudfront/E1B0ZWWO5559U5.step1.proposed.json'));
  const cfg = proposed.DistributionConfig;
  assert.equal(proposed.doNotDeploy, true);
  assert.equal(cfg.Origins.Quantity, 2);
  const api = cfg.Origins.Items.find((o) => o.Id === 'ProductionPrepHttpApi');
  const s3 = cfg.Origins.Items.find((o) => o.Id === 'ProductionSpaS3');
  assert.equal(api.DomainName, 'kiqojucc02.execute-api.us-east-1.amazonaws.com');
  assert.equal(api.OriginPath, '');
  assert.equal(api.CustomHeaders.Quantity, 0);
  assert.ok(api.CustomOriginConfig);
  assert.equal(s3.OriginAccessControlId, 'E35N26NNHZAG11');
  assert.equal(cfg.CacheBehaviors.Quantity, 2);
  assert.deepEqual(cfg.CacheBehaviors.Items.map((b) => b.PathPattern), ['/prep', '/prep/*']);
  for (const b of cfg.CacheBehaviors.Items) {
    assert.equal(b.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    assert.equal(b.OriginRequestPolicyId, 'b689b0a8-53d0-40ab-baf2-68738e2966ac');
    assert.equal(b.FunctionAssociations.Quantity, 0);
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE']) {
      assert.ok(b.AllowedMethods.Items.includes(m), m);
    }
  }
  assert.equal(cfg.CustomErrorResponses.Quantity, 0);
  assert.match(cfg.WebACLId, /checksops-production-cloudfront-waf/);
  assert.deepEqual(new Set(cfg.Aliases.Items), new Set(['checksops.com', 'www.checksops.com']));
  assert.equal(cfg.DefaultCacheBehavior.TargetOriginId, 'ProductionSpaS3');
  assert.equal(cfg.DefaultCacheBehavior.FunctionAssociations.Quantity, 1);
  assert.equal(cfg.DefaultCacheBehavior.FunctionAssociations.Items[0].EventType, 'viewer-request');
  assert.equal(cfg.Logging.Enabled, true);
  assert.doesNotMatch(JSON.stringify(cfg), /x-checksops-origin-verify/);
  assert.doesNotMatch(JSON.stringify(proposed), /DisableExecuteApiEndpoint/);
  assert.doesNotMatch(JSON.stringify(cfg.CacheBehaviors), /"\/auth\*/);
  assert.doesNotMatch(JSON.stringify(cfg.CacheBehaviors), /"\/prep\*"/);
});

test('Step 1 builder refuses apply env and package is review-only', () => {
  const applied = spawnSync(process.execPath, [path.join(ROOT, 'aws/cloudfront/build-step1-config.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, CHECKSOPS_APPLY_CF_STEP1: 'I_UNDERSTAND_PRODUCTION' },
  });
  assert.equal(applied.status, 2);
  assert.match(applied.stderr, /DO_NOT_DEPLOY/);
  const pkg = read('aws/cutover/API_BEHIND_CLOUDFRONT_STEPS_1_2.md');
  assert.match(pkg, /DO NOT DEPLOY/);
  assert.match(pkg, /DO NOT CREATE THE TEMPORARY ROLE/);
  assert.match(pkg, /DisableExecuteApiEndpoint` stays/);
  assert.match(pkg, /NOT_APPLIED/);
  assert.match(pkg, /productionExecution=false/);
  assert.doesNotMatch(pkg, /aws cloudfront update-distribution/);
  assert.doesNotMatch(pkg, /aws apigatewayv2 update-api/);
});

test('same-origin /prep resolver keeps staging execute-api and www same-origin', async () => {
  const { resolveAwsApiBaseUrl } = await import('../../src/lib/awsApiBase.ts');
  assert.equal(
    resolveAwsApiBaseUrl('/prep', 'https://www.checksops.com'),
    'https://www.checksops.com/prep',
  );
  assert.equal(
    resolveAwsApiBaseUrl('/prep', 'https://checksops.com'),
    'https://checksops.com/prep',
  );
  assert.equal(
    resolveAwsApiBaseUrl('same-origin', 'https://www.checksops.com'),
    'https://www.checksops.com/prep',
  );
  assert.equal(resolveAwsApiBaseUrl('/prep'), '/prep');
  assert.equal(
    resolveAwsApiBaseUrl('https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging'),
    'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging',
  );
  const staging = read('src/lib/awsStaging.ts');
  assert.match(staging, /resolveAwsApiBaseUrl/);
  assert.match(staging, /window\.location\.origin/);
  const example = read('.env.production.aws.example');
  assert.match(example, /deploy-production-spa/);
  assert.match(example, /VITE_CHECKSOPS_API_URL=\/prep/);
  assert.match(example, /kiqojucc02\.execute-api\.us-east-1\.amazonaws\.com\/prep/);
  const tenant = read('src/lib/aws/tenantCompliance.ts');
  assert.match(tenant, /awsApiBaseUrl/);
  assert.doesNotMatch(tenant, /import\.meta\.env\.VITE_CHECKSOPS_API_URL/);
});

test('Steps 1-2 temp role is least-privilege, gated, and is not a deleted hardening role', () => {
  const yaml = read('aws/production/cursor-api-perimeter-steps12-role.yaml');
  const allow = JSON.parse(read('aws/production/cursor-api-perimeter-steps12-role-allow.json'));
  const deny = JSON.parse(read('aws/production/cursor-api-perimeter-steps12-role-deny.json'));
  const trust = JSON.parse(read('aws/production/cursor-api-perimeter-steps12-role-trust.json'));
  assert.match(yaml, /Default: "false"/);
  assert.match(yaml, /ShouldDeployRole/);
  assert.match(yaml, /ChecksOpsCursorApiPerimeterSteps12Temp/);
  assert.match(yaml, /Does not recreate/);
  assert.match(yaml, /Does not broaden ChecksOpsCursorCloudStaging/);
  assert.doesNotMatch(yaml, /RoleName: ChecksOpsCursorSecurityHardeningTemp/);
  assert.doesNotMatch(yaml, /Default: ChecksOpsCursorCloudStaging/);
  const resources = yaml.slice(yaml.indexOf('Resources:'));
  assert.doesNotMatch(resources, /ChecksOpsCursorSecurityHardeningTemp/);
  assert.doesNotMatch(resources, /ChecksOpsCursorCloudTrailCwLogsTemp/);
  assert.doesNotMatch(resources, /ChecksOpsCursorCloudStaging/);
  assert.deepEqual(extractJsonAfter(yaml, 'PolicyDocument:'), allow);
  const allowActions = allow.Statement.flatMap((s) => [].concat(s.Action));
  const denyActions = deny.Statement.flatMap((s) => [].concat(s.Action));
  assert.ok(allowActions.includes('cloudfront:UpdateDistribution'));
  assert.ok(allowActions.includes('cloudfront:CreateFunction'));
  assert.ok(allowActions.includes('s3:PutObject'));
  assert.ok(!allowActions.includes('apigatewayv2:CreateAuthorizer'));
  assert.ok(!allowActions.includes('lambda:CreateFunction'));
  assert.ok(!allowActions.includes('secretsmanager:GetSecretValue'));
  assert.ok(!allowActions.includes('secretsmanager:CreateSecret'));
  assert.ok(denyActions.includes('apigatewayv2:*') || denyActions.includes('apigateway:*'));
  assert.ok(denyActions.includes('lambda:*'));
  assert.ok(denyActions.includes('secretsmanager:*'));
  assert.ok(denyActions.includes('rds:*'));
  assert.ok(denyActions.includes('cognito-idp:*'));
  assert.ok(denyActions.includes('route53:*'));
  assert.ok(denyActions.includes('wafv2:*'));
  assert.ok(denyActions.includes('iam:PassRole'));
  assert.equal(trust.Statement[0].Principal.Federated, 'arn:aws:iam::806168576068:oidc-provider/api.cursor.com');
  assert.equal(trust.Statement[0].Condition.StringEquals['api.cursor.com:sub'], 'user:325724407');
  const compactAllow = JSON.stringify(allow);
  const compactDeny = JSON.stringify(deny);
  assert.ok(compactAllow.length < 6144, compactAllow.length);
  assert.ok(compactDeny.length < 6144, compactDeny.length);
});

test('apply-step1 refuses unless APPLY_GATE1 is set', () => {
  const applied = spawnSync(process.execPath, [path.join(ROOT, 'aws/cloudfront/apply-step1.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, CHECKSOPS_APPLY_CF_STEP1: '' },
  });
  assert.equal(applied.status, 2);
  assert.match(applied.stderr, /APPLY_GATE1/);
});

test('Gate 1 Step 1 PASS record keeps Step 2 and origin-verify out of scope', () => {
  const doc = read('aws/cutover/API_PERIMETER_GATE1_STEP1_PASS.md');
  assert.match(doc, /Step 1 PASS/);
  assert.match(doc, /Do not start Step 2/);
  assert.match(doc, /b689b0a8-53d0-40ab-baf2-68738e2966ac/);
  assert.match(doc, /productionExecution=false/);
  assert.match(doc, /execute-api/);
  assert.doesNotMatch(doc, /DisableExecuteApiEndpoint=true/);
});

test('Gate 2 / Step 2 PASS record is same-origin /prep and does not start Step 3', () => {
  const doc = read('aws/cutover/API_PERIMETER_STEP2_PASS.md');
  assert.match(doc, /Step 2 PASS/);
  assert.match(doc, /index-reP2FWHf\.js/);
  assert.match(doc, /4ef3aaf9eac12f0a5ba47887683e7efdd93fa87b5de1af3ecc5be812b27ea076/);
  assert.match(doc, /window\.location\.origin/);
  assert.match(doc, /kiqojucc02\.execute-api/);
  assert.match(doc, /\*\*absent\*\*/);
  assert.match(doc, /productionExecution=false/);
  assert.match(doc, /holds\.ok=true/);
  assert.match(doc, /NOT_APPLIED/);
  assert.match(doc, /Do not start Step 3/);
  assert.match(doc, /Not used/);
  assert.doesNotMatch(doc, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(doc, /origin-verify secret created/);
});

test('Gate 0 role create is blocked on staging and does not recreate deleted roles', () => {
  const doc = read('aws/cutover/API_PERIMETER_GATE0_ROLE_BLOCKED.md');
  assert.match(doc, /CREATE BLOCKED/);
  assert.match(doc, /iam:CreatePolicy/);
  assert.match(doc, /DeployRole=true/);
  assert.match(doc, /Did \*\*not\*\*/);
  assert.match(doc, /ChecksOpsCursorSecurityHardeningTemp/);
  assert.match(doc, /Do not begin origin-verify|No origin-verify secret/);
  assert.doesNotMatch(doc, /aws cloudfront update-distribution/);
});
