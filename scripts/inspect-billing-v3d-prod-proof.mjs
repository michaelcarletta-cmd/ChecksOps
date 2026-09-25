#!/usr/bin/env node
/**
 * Read-only V3D production proof.
 * Does not enable gates, invoke verify-debit, or send ACH.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumeCursorRole } from './cognito-staging-token.mjs';
import { resolveBillingDebitSource } from '../aws/functions/api/tenant-billing-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || '/usr/local/bin/aws';
const REGION = 'us-east-1';
const OUT = '/opt/cursor/artifacts/billing-verification-v3d';
const PROD_API = 'checksops-production-prep-api';
const REHEARSAL = 'checksops-staging-rehearsal-oneshot';
const ONESHOT = 'checksops-prod-v3d-inspect-2d41';
const EXPECTED_FUND = 'a02c1c81-9ca6-434d-accc-ea4471a70ef2';
const EXPECTED_COLLECT = '128977bb-5034-4e8b-89ed-b10982105aa3';
const EXPECTED_CREDIT = '7a78a544-340d-46fd-a4a4-228661374da7';
const EXPECTED_ACCT = '60922058-7eca-4889-81dd-5720d7b9de96';
const EXPECTED_DEST_ACCOUNT = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const EXPECTED_DEST_METHOD = 'c70a90f2-9bcc-4084-8263-d5a0fb5d806c';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};
const awsTry = (args) => {
  try { return { ok: true, data: awsJson(args) }; }
  catch (error) {
    return { ok: false, error: String(error.stderr || error.message || error).replace(/\s+/g, ' ').trim().slice(0, 600) };
  }
};
const waitFn = (name) => {
  try { execFileSync(AWS, ['lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { execFileSync(AWS, ['lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeCursorRole('billing-v3d-prod-proof');
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', PROD_API]);
  const vars = cfg.Environment?.Variables || {};
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', REHEARSAL]);
  const adminSecretArn = rehearsal.Environment?.Variables?.PROD_ADMIN_SECRET_ARN;
  const rdsHost = rehearsal.Environment?.Variables?.PROD_RDS_HOST;
  if (!adminSecretArn || !rdsHost) throw new Error('rehearsal missing PROD_ADMIN_SECRET_ARN or PROD_RDS_HOST');

  const staging = path.join(os.tmpdir(), 'checksops-v3d-prod-inspect-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/billing-v3d-prod-inspect/index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/billing-v3d-prod-inspect/package.json'), path.join(staging, 'package.json'));
  await copyFile(path.join(ROOT, 'aws/functions/api/tenant-billing-engine.mjs'), path.join(staging, 'tenant-billing-engine.mjs'));
  await copyFile(path.join(ROOT, 'aws/functions/api/tenant-billing-destination.mjs'), path.join(staging, 'tenant-billing-destination.mjs'));
  await copyFile(path.join(ROOT, 'aws/rls/oneshot/rds-global-bundle.pem'), path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'inherit' });
  const zip = path.join(os.tmpdir(), 'checksops-v3d-prod-inspect.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rdsHost,
      DATABASE_NAME: 'checksops',
    },
  };
  const vpc = cfg.VpcConfig || rehearsal.VpcConfig || {};
  const existing = awsTry(['lambda', 'get-function', '--function-name', ONESHOT]);
  if (existing.ok) {
    awsJson(['lambda', 'update-function-code', '--function-name', ONESHOT, '--zip-file', `fileb://${zip}`]);
    waitFn(ONESHOT);
    awsJson(['lambda', 'update-function-configuration', '--function-name', ONESHOT, '--timeout', '90', '--environment', JSON.stringify(env)]);
  } else {
    awsJson([
      'lambda', 'create-function',
      '--function-name', ONESHOT,
      '--runtime', 'nodejs20.x',
      '--role', rehearsal.Role,
      '--handler', 'index.handler',
      '--timeout', '90',
      '--memory-size', '256',
      '--zip-file', `fileb://${zip}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`,
    ]);
  }
  waitFn(ONESHOT);
  const outFile = path.join(os.tmpdir(), `v3d-prod-inspect-${Date.now()}.json`);
  awsJson(['lambda', 'invoke', '--function-name', ONESHOT, '--cli-binary-format', 'raw-in-base64-out', outFile]);
  const sql = JSON.parse(fs.readFileSync(outFile, 'utf8'));

  const httpCalls = [];
  const fetchImpl = async (url) => {
    httpCalls.push(String(url));
    throw new Error(`unexpected_provider_http:${url}`);
  };
  const method = {
    id: 'prod-freedom-method',
    tenant_id: FREEDOM,
    provider_account_id: sql.freedom?.provider_account_id || EXPECTED_ACCT,
    provider_payment_method_id: sql.freedom?.stored_credit_standard || EXPECTED_CREDIT,
    rail_payment_method_ids: sql.freedom?.rails || {},
    rails_synced_at: sql.freedom?.rails_synced_at || new Date().toISOString(),
  };
  const mockClient = {
    query: async (query, params = []) => {
      const text = String(query);
      if (text.includes('FROM public.payment_provider_methods') && text.includes('provider_payment_method_id')) {
        return { rows: [method] };
      }
      if (text.includes('FROM public.payment_provider_methods') && text.includes('WHERE id')) {
        return { rows: [{ rail_payment_method_ids: method.rail_payment_method_ids }] };
      }
      return { rows: [] };
    },
  };
  const resolved = await resolveBillingDebitSource(mockClient, {
    authorization: {
      tenant_id: FREEDOM,
      provider_payment_method_id: method.provider_payment_method_id,
      provider_account_id: method.provider_account_id,
    },
    fetchImpl,
  });

  const report = {
    generatedAt: new Date().toISOString(),
    mutated: false,
    realDollarSent: false,
    verificationInvoked: false,
    liveProviderPost: false,
    httpCalls,
    lambda: {
      codeSha256: cfg.CodeSha256,
      lastModified: cfg.LastModified,
      monthlyPost: vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST || null,
      verificationPost: vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED || null,
      destination: {
        account: vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || null,
        method: vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || null,
      },
    },
    resolvedDebit: {
      ok: resolved.ok,
      sourceMethodId: resolved.sourceMethodId,
      sourceRail: resolved.sourceRail,
      sourceAccountId: resolved.sourceAccountId,
      usedCreditStandard: resolved.sourceMethodId === EXPECTED_CREDIT,
    },
    sql,
  };
  await writeFile(path.join(OUT, 'prod-proof.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const fail = (
    sql.ok !== true
    || resolved.ok !== true
    || resolved.sourceMethodId !== EXPECTED_FUND
    || resolved.sourceRail !== 'ach-debit-fund'
    || resolved.sourceAccountId !== EXPECTED_ACCT
    || resolved.sourceMethodId === EXPECTED_CREDIT
    || sql.freedom?.fallback_debit_collect !== EXPECTED_COLLECT
    || sql.destination?.matchesExpected !== true
    || vars.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST !== 'false'
    || vars.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED === 'true'
    || vars.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID !== EXPECTED_DEST_ACCOUNT
    || vars.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID !== EXPECTED_DEST_METHOD
    || sql.verificationOccurrenceCount !== 0
    || (Array.isArray(sql.septemberOccurrences) && sql.septemberOccurrences.length !== 0)
    || httpCalls.length
  );
  if (fail) process.exit(2);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
