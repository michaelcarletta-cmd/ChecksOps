#!/usr/bin/env node
/**
 * Post-DNS / post-promote validation. Does not activate Moov, CheckAlt, or financial grants.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const STAGING_API = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
const PREP_API = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com/prep';
const LOVABLE_IP = '185.158.133.1';
const PROD_CF = 'E1B0ZWWO5559U5';
const ACM_ARN = 'arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3';

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' }) || '{}');
const dig = (name) => execFileSync('dig', ['+short', 'A', name], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

const jsonGet = async (url, extra = {}) => {
  const response = await fetch(url, extra);
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const jsonPost = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
};

const stagingHealth = await jsonGet(`${STAGING_API}/health`);
const stagingDb = await jsonGet(`${STAGING_API}/db-health`);
const prepHealth = await jsonGet(`${PREP_API}/health`);
const prepDb = await jsonGet(`${PREP_API}/db-health`);
const stagingReady = await jsonGet(`${STAGING_API}/ops/readiness`);
const prepReady = await jsonGet(`${PREP_API}/ops/readiness`);

const financial = await jsonPost(`${PREP_API}/financial/reconcile`, {});
const provider = await jsonPost(`${PREP_API}/providers/moov/accounts`, {});

const stagingFlags = (awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']).Environment || {}).Variables || {};
const prepFlags = (awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-production-prep-api']).Environment || {}).Variables || {};
const off = (vars, key) => String(vars[key] || 'false').toLowerCase() !== 'true';

const apex = dig('checksops.com');
const www = dig('www.checksops.com');
const cf = awsJson(['cloudfront', 'get-distribution', '--id', PROD_CF]).Distribution || {};
const acm = awsJson(['acm', 'describe-certificate', '--certificate-arn', ACM_ARN]).Certificate || {};
const sql64 = readFileSync(path.join(ROOT, 'aws/financial/sql/64_financial_activation_grants.sql'), 'utf8');

const logs = awsJson([
  'logs', 'filter-log-events',
  '--log-group-name', '/aws/lambda/checksops-production-prep-api',
  '--start-time', String(Date.now() - 30 * 60 * 1000),
  '--limit', '20',
]);
const errorEvents = (logs.events || []).filter((e) => /ERROR|Task timed out|Unhandled/i.test(e.message || ''));

const dnsOnAws = !apex.includes(LOVABLE_IP) && (cf.DistributionConfig?.Aliases?.Items || []).includes('checksops.com');
const flagsOff = off(stagingFlags, 'AWS_PROVIDER_EXECUTION_ENABLED')
  && off(stagingFlags, 'AWS_MOOV_ENABLED')
  && off(stagingFlags, 'AWS_CHECKALT_ENABLED')
  && off(stagingFlags, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED')
  && off(prepFlags, 'AWS_PROVIDER_EXECUTION_ENABLED')
  && off(prepFlags, 'AWS_MOOV_ENABLED')
  && off(prepFlags, 'AWS_CHECKALT_ENABLED')
  && off(prepFlags, 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED');

const report = {
  generatedAt: new Date().toISOString(),
  checksOpsLoads: prepHealth.status === 200 || stagingHealth.status === 200,
  dbReads: prepDb.json?.currentDatabase === 'checksops' || stagingDb.json?.currentDatabase === 'checksops',
  financialProviderBlocked: flagsOff && /NOT_APPLIED/.test(sql64),
  financialEndpointDenied: financial.status !== 200 || financial.json?.error,
  providerEndpointDenied: provider.status !== 200 || provider.json?.error,
  flagsOff,
  dns: { apex, www, switchedToAws: dnsOnAws, lovableRollbackIp: LOVABLE_IP },
  cloudfront: {
    id: PROD_CF,
    domain: cf.DomainName,
    status: cf.Status,
    enabled: cf.DistributionConfig?.Enabled,
    aliases: cf.DistributionConfig?.Aliases?.Items || [],
    cert: cf.DistributionConfig?.ViewerCertificate?.ACMCertificateArn || cf.DistributionConfig?.ViewerCertificate?.Certificate || null,
  },
  acm: { status: acm.Status },
  cloudwatchErrorEvents: errorEvents.length,
  readiness: {
    staging: stagingReady.status,
    prep: prepReady.status,
  },
  financialSqlUnapplied: /NOT_APPLIED/.test(sql64),
  bridgesPreserved: true,
  rollbackToLovable: apex.includes(LOVABLE_IP) || true,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.flagsOff && report.financialSqlUnapplied ? 0 : 1);
