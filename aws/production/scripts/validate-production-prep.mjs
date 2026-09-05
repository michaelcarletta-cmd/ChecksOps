#!/usr/bin/env node
/**
 * Production-prep readiness validator.
 * Default: static checks of templates/docs (no AWS, no DNS writes).
 * --live: read-only AWS + public DNS.
 * --apply: refused (this cannot change DNS, auth, webhooks, flags, or bridges).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REGION = 'us-east-1';
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const CERT_ARN = 'arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3';
const PROD_POOL = 'us-east-1_h00WorYMT';
const STAGING_POOL = 'us-east-1_vPmQ7cL1F';
const PROD_CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';
const FLAGS_FALSE = [
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_MOOV_ENABLED',
  'AWS_CHECKALT_ENABLED',
  'AWS_PLAID_ENABLED',
  'AWS_ACTUM_ENABLED',
  'AWS_QUICKBOOKS_ENABLED',
  'AWS_PROVIDER_LIVE_READS_ENABLED',
  'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
  'AWS_COGNITO_MFA_PREFERRED',
  'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED',
];

const args = new Set(process.argv.slice(2));
if (args.has('--apply')) {
  console.error(JSON.stringify({
    ok: false,
    refused: true,
    reason: '--apply is refused. This script cannot change DNS, Cognito, SES, webhooks, flags, or bridges.',
  }));
  process.exit(2);
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const staticFlags = (rel) => {
  const text = read(rel);
  const missing = FLAGS_FALSE.filter((flag) => !new RegExp(`${flag}:\\s*"false"`).test(text));
  const envAllowed = text.match(/AllowedValues:\n(?:[ \t]+-[^\n]+\n)+/);
  const productionEnvForbidden = envAllowed ? !/(?:^|\n)[ \t]+- production(?:\n|$)/.test(envAllowed[0]) : true;
  return {
    file: rel,
    missingFalseFlags: missing,
    forbidsEnvironmentProduction: productionEnvForbidden,
    ok: missing.length === 0,
  };
};

const staticResult = {
  mode: 'static',
  productionAuthSwitch: false,
  dnsChanged: false,
  flags: [
    staticFlags('aws/production/api-cfn.yaml'),
    staticFlags('aws/production/api-template.yaml'),
  ],
  acmCnamesDocumented: /_424da145c81cf0e7659ae4a2559d8f82\.checksops\.com/.test(read('aws/production/ACM_DNS_VALIDATION.md'))
    && /_4ed6942e58099ae2ecedf7cf0da89c69\.www\.checksops\.com/.test(read('aws/production/ACM_DNS_VALIDATION.md')),
  operatorIamDocumented: fs.existsSync(path.join(ROOT, 'aws/production/iam/operator-cloudwatch-inspect.json')),
  alarmsTemplateHasResources: /AWS::CloudWatch::Alarm/.test(read('aws/production/cloudwatch-alarms.yaml')),
  stagingPoolMustNotBeReused: read('aws/production/prep-stack.yaml').includes(STAGING_POOL),
};

if (!args.has('--live')) {
  const ok = staticResult.flags.every((f) => f.ok)
    && staticResult.acmCnamesDocumented
    && staticResult.operatorIamDocumented
    && staticResult.alarmsTemplateHasResources;
  console.log(JSON.stringify({ ok, ...staticResult }, null, 2));
  process.exit(ok ? 0 : 1);
}

const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock',
    path: '/v1/tokens/oidc',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed.token || parsed.oidcToken || parsed);
      } catch (error) {
        reject(error);
      }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const runAws = (cliArgs) => {
  const out = spawnSync(AWS, ['--region', REGION, '--output', 'json', ...cliArgs], {
    encoding: 'utf8',
    env: process.env,
  });
  return {
    status: out.status,
    stdout: out.stdout || '',
    stderr: (out.stderr || '').slice(0, 800),
  };
};

const jsonOrNull = (raw) => {
  try { return JSON.parse(raw); } catch { return null; }
};

const dig = (name, type) => spawnSync('dig', ['+short', name, type], { encoding: 'utf8' }).stdout.trim();

const assumeIfNeeded = async () => {
  if (process.env.AWS_SESSION_TOKEN && process.env.AWS_ACCESS_KEY_ID) return 'existing';
  const role = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
  if (!role) throw new Error('CURSOR_AWS_ASSUME_IAM_ROLE_ARN missing');
  const token = await oidcToken();
  const tokenFile = path.join(os.tmpdir(), `checksops-oidc-${process.pid}.jwt`);
  fs.writeFileSync(tokenFile, String(token), { mode: 0o600 });
  const assumed = spawnSync(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-prod-prep-validate',
    '--web-identity-token', `file://${tokenFile}`,
    '--duration-seconds', '3600',
    '--output', 'json',
  ], { encoding: 'utf8' });
  fs.unlinkSync(tokenFile);
  if (assumed.status !== 0) throw new Error(assumed.stderr.slice(0, 400));
  const creds = JSON.parse(assumed.stdout).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
  return 'assumed';
};

const live = async () => {
  await assumeIfNeeded();
  const identity = jsonOrNull(runAws(['sts', 'get-caller-identity']).stdout);
  const acm = jsonOrNull(runAws(['acm', 'describe-certificate', '--certificate-arn', CERT_ARN]).stdout);
  const pool = jsonOrNull(runAws(['cognito-idp', 'describe-user-pool', '--user-pool-id', PROD_POOL]).stdout);
  const client = jsonOrNull(runAws(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', PROD_POOL, '--client-id', PROD_CLIENT]).stdout);
  const users = jsonOrNull(runAws(['cognito-idp', 'list-users', '--user-pool-id', PROD_POOL, '--limit', '5']).stdout);
  const mfa = jsonOrNull(runAws(['cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', PROD_POOL]).stdout);
  const cf = jsonOrNull(runAws(['cloudfront', 'get-distribution', '--id', 'E1B0ZWWO5559U5']).stdout);
  const prepStack = jsonOrNull(runAws(['cloudformation', 'describe-stacks', '--stack-name', 'checksops-production-prep']).stdout);
  const apiStack = runAws(['cloudformation', 'describe-stacks', '--stack-name', 'checksops-production-prep-api']);
  const alarmStack = runAws(['cloudformation', 'describe-stacks', '--stack-name', 'checksops-production-prep-alarms']);
  const describeAlarms = runAws(['cloudwatch', 'describe-alarms', '--alarm-names', 'checksops-production-prep-api-errors']);
  const sesAccount = runAws(['sesv2', 'get-account']);
  const lambda = runAws(['lambda', 'get-function', '--function-name', 'checksops-production-prep-api']);
  const stagingFlags = jsonOrNull(runAws(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']).stdout);
  const env = stagingFlags?.Environment?.Variables || {};
  const liveFlagsFalse = FLAGS_FALSE.filter((k) => k !== 'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED')
    .map((k) => ({ flag: k, value: env[k] ?? null, ok: env[k] === 'false' }));

  const cert = acm?.Certificate || {};
  const validation = (cert.DomainValidationOptions || []).map((v) => ({
    domain: v.DomainName,
    status: v.ValidationStatus,
    name: v.ResourceRecord?.Name || null,
    value: v.ResourceRecord?.Value || null,
    inPublicDns: v.ResourceRecord?.Name ? Boolean(dig(v.ResourceRecord.Name.replace(/\.$/, ''), 'CNAME')) : false,
  }));

  const result = {
    ok: true,
    mode: 'live-readonly',
    productionAuthSwitch: false,
    dnsChanged: false,
    caller: identity?.Arn || null,
    static: staticResult,
    acm: {
      status: cert.Status || null,
      inUseBy: cert.InUseBy || [],
      validation,
    },
    cognito: {
      poolId: pool?.UserPool?.Id || null,
      users: (users?.Users || []).length,
      mfa: mfa?.MfaConfiguration || null,
      email: pool?.UserPool?.EmailConfiguration || null,
      firstAuth: pool?.UserPool?.Policies?.SignInPolicy?.AllowedFirstAuthFactors || [],
      webAuthn: mfa?.WebAuthnConfiguration || null,
      clientFlows: client?.UserPoolClient?.ExplicitAuthFlows || [],
      stagingPoolUnused: pool?.UserPool?.Id !== STAGING_POOL,
    },
    cloudfront: {
      id: cf?.Distribution?.Id || null,
      aliases: cf?.Distribution?.DistributionConfig?.Aliases || null,
      status: cf?.Distribution?.Status || null,
    },
    dns: {
      apexA: dig('checksops.com', 'A'),
      wwwA: dig('www.checksops.com', 'A'),
      amazonsesTxt: dig('_amazonses.checksops.com', 'TXT'),
    },
    stacks: {
      prep: prepStack?.Stacks?.[0]?.StackStatus || null,
      api: apiStack.status === 0 ? jsonOrNull(apiStack.stdout)?.Stacks?.[0]?.StackStatus : 'ABSENT_OR_DENIED',
      alarms: alarmStack.status === 0 ? jsonOrNull(alarmStack.stdout)?.Stacks?.[0]?.StackStatus : 'ABSENT_OR_DENIED',
    },
    inspect: {
      describeAlarms: describeAlarms.status === 0 ? 'allowed' : 'denied',
      sesGetAccount: sesAccount.status === 0 ? 'allowed' : 'denied',
      productionPrepLambda: lambda.status === 0 ? 'present' : 'absent_or_denied',
    },
    stagingExecutionFlags: liveFlagsFalse,
  };

  const blocked = [];
  if (result.dns.apexA && result.dns.apexA !== '185.158.133.1') blocked.push('apex_dns_unexpected');
  if (result.cognito.users !== 0) blocked.push('production_pool_has_users');
  if (!result.cognito.stagingPoolUnused) blocked.push('staging_pool_reused');
  if ((result.cloudfront.aliases?.Quantity || 0) !== 0) blocked.push('cloudfront_has_aliases');
  result.blocked = blocked;
  result.ok = blocked.length === 0 && staticResult.flags.every((f) => f.ok);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
};

live().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error).slice(0, 400) }));
  process.exit(1);
});
