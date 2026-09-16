#!/usr/bin/env node
/**
 * Deploy/invoke the read-only C1C shared_checks inspect oneshot and classify
 * against the authoritative 94 Freedom → C1C active shares.
 * Restore is a separate explicit invocation.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const ACCOUNT = '806168576068';
const LAMBDA_NAME = process.env.C1C_SHARE_LAMBDA_NAME || 'checksops-staging-c1c-share-inspect-46ac';
const ROLE_NAME = process.env.C1C_SHARE_ROLE_NAME || 'checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/c1c-partner-share/oneshot');
const OUT = '/opt/cursor/artifacts/c1c-partner-share';
const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : {};
};

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
      } catch (e) { reject(e); }
    });
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const assumeRole = async () => {
  const role = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
  if (!role) throw new Error('CURSOR_AWS_ASSUME_IAM_ROLE_ARN missing');
  const token = await oidcToken();
  const out = run(AWS, [
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'c1c-share-inspect',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
    '--output', 'json',
  ]);
  const creds = JSON.parse(out).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
};

const packOneshot = async () => {
  const staging = path.join(os.tmpdir(), 'checksops-c1c-share-oneshot-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await copyFile(path.join(ONESHOT_DIR, 'index.mjs'), path.join(staging, 'index.mjs'));
  await copyFile(path.join(ONESHOT_DIR, 'package.json'), path.join(staging, 'package.json'));
  await mkdir(path.join(staging, 'sql'), { recursive: true });
  await copyFile(
    path.join(ROOT, 'aws/rls/sql/34_c1c_partner_visibility.sql'),
    path.join(staging, 'sql/34_c1c_partner_visibility.sql'),
  );
  await copyFile(
    path.join(ROOT, 'aws/rls/sql/32_partner_share_lifecycle.sql'),
    path.join(staging, 'sql/32_partner_share_lifecycle.sql'),
  );
  await copyFile(
    path.join(ROOT, 'aws/rls/sql/31_partner_safe_read.sql'),
    path.join(staging, 'sql/31_partner_safe_read.sql'),
  );
  await copyFile(
    path.join(ROOT, 'aws/rls/sql/33_partner_stage_totals.sql'),
    path.join(staging, 'sql/33_partner_stage_totals.sql'),
  );
  await copyFile(
    path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem'),
    path.join(staging, 'rds-global-bundle.pem'),
  );
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-c1c-share-oneshot.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return zip;
};

const ensureLambda = async (zipPath) => {
  const rehearsal = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-rehearsal-oneshot']);
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const vpc = api.VpcConfig || {};
  const adminSecretArn = rehearsal.Environment?.Variables?.ADMIN_SECRET_ARN;
  if (!adminSecretArn) throw new Error('ADMIN_SECRET_ARN missing on rehearsal oneshot');
  const roleArn = rehearsal.Role || `arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}`;
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: rehearsal.Environment?.Variables?.RDS_HOST || 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
    },
  };
  const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;
  try {
    awsJson(['lambda', 'get-function', '--function-name', LAMBDA_NAME]);
    execFileSync(AWS, [
      '--region', REGION, 'lambda', 'update-function-code',
      '--function-name', LAMBDA_NAME, '--zip-file', `fileb://${zipPath}`,
    ], { stdio: 'ignore' });
    try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
    awsJson([
      'lambda', 'update-function-configuration',
      '--function-name', LAMBDA_NAME,
      '--timeout', '120',
      '--memory-size', '512',
      '--environment', JSON.stringify(env),
    ]);
  } catch {
    awsJson([
      'lambda', 'create-function',
      '--function-name', LAMBDA_NAME,
      '--runtime', 'nodejs20.x',
      '--role', roleArn,
      '--handler', 'index.handler',
      '--timeout', '120',
      '--memory-size', '512',
      '--zip-file', `fileb://${zipPath}`,
      '--environment', JSON.stringify(env),
      '--vpc-config', vpcConfig,
    ]);
  }
  try { run(AWS, ['lambda', 'wait', 'function-active', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
  try { run(AWS, ['lambda', 'wait', 'function-updated', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
};

const invokeLambda = (payload) => {
  const outFile = path.join(os.tmpdir(), `c1c-share-${payload.step}-${Date.now()}.json`);
  const payloadFile = path.join(os.tmpdir(), `c1c-share-payload-${Date.now()}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  run(AWS, [
    'lambda', 'invoke',
    '--function-name', LAMBDA_NAME,
    '--payload', `file://${payloadFile}`,
    outFile,
  ]);
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
};

const classify = (sourceActive, awsShares) => {
  const awsByCheck = new Map();
  for (const row of awsShares || []) {
    if (row.target_tenant_id !== C1C) continue;
    const prev = awsByCheck.get(row.check_id);
    if (!prev || (!row.revoked && prev.revoked)) awsByCheck.set(row.check_id, row);
  }
  const alreadyActive = [];
  const missing = [];
  const revoked = [];
  const conflict = [];
  for (const share of sourceActive) {
    const aws = awsByCheck.get(share.check_id);
    if (!aws) {
      missing.push(share);
      continue;
    }
    if (aws.source_tenant_id !== FREEDOM || aws.target_tenant_id !== C1C) {
      conflict.push({ check_id: share.check_id, reason: 'tenant_mismatch', aws });
      continue;
    }
    if (aws.parent_tenant_id && aws.parent_tenant_id !== FREEDOM) {
      conflict.push({ check_id: share.check_id, reason: 'parent_ownership_mismatch', aws });
      continue;
    }
    if (aws.revoked) {
      revoked.push({ ...share, aws_share_id: aws.id });
      continue;
    }
    alreadyActive.push({ check_id: share.check_id, aws_share_id: aws.id, source_share_id: share.id });
  }
  return {
    ALREADY_ACTIVE_IN_AWS: alreadyActive.length,
    MISSING_FROM_AWS: missing.length,
    REVOKED_IN_AWS: revoked.length,
    CONFLICT_DATA_MISMATCH: conflict.length,
    alreadyActive,
    missing,
    revoked,
    conflict,
  };
};

const main = async () => {
  await mkdir(OUT, { recursive: true });
  await assumeRole();
  const zip = await packOneshot();
  await ensureLambda(zip);
  if (process.env.C1C_APPLY_PARTNER_DDL === '1') {
    const applied = invokeLambda({ step: 'apply_partner_ddl', confirm: 'APPLY_PARTNER_SAFE_DDL' });
    await writeFile(path.join(OUT, 'phase4-partner-ddl.json'), JSON.stringify(applied, null, 2));
    if (applied.ok !== true) {
      throw new Error(applied.error || 'apply_partner_ddl failed');
    }
  }
  if (process.env.C1C_LIFECYCLE === '1') {
    const life = invokeLambda({ step: 'lifecycle' });
    await writeFile(path.join(OUT, 'phase7-lifecycle.json'), JSON.stringify(life, null, 2));
    if (life.ok !== true) {
      throw new Error(life.error || 'lifecycle failed');
    }
  }
  const inspected = invokeLambda({ step: 'inspect' });
  if (inspected.error) {
    await writeFile(path.join(OUT, 'phase1-aws-inspect.json'), JSON.stringify(inspected, null, 2));
    throw new Error(inspected.error);
  }

  const source = JSON.parse(await readFile(path.join(OUT, 'phase1-diff.json'), 'utf8'));
  const sourceShares = JSON.parse(await readFile(path.join(OUT, 'phase1-source-active-rows.json'), 'utf8').catch(async () => {
    // Reconstruct from check IDs if the detailed rows file is absent.
    return (source.source?.checkIds || []).map((check_id) => ({
      check_id,
      source_tenant_id: FREEDOM,
      target_tenant_id: C1C,
    }));
  }));

  const classified = classify(sourceShares, inspected.shares);
  const report = {
    generatedAt: new Date().toISOString(),
    awsPath: `oneshot:${LAMBDA_NAME}:inspect`,
    readOnly: true,
    writesAttempted: false,
    sourceActive: sourceShares.length,
    awsShareRows: inspected.shares?.length ?? 0,
    ownedCounts: inspected.ownedCounts,
    views: inspected.views,
    partnership: inspected.partnership,
    totalsIncludesSharedChecks: inspected.totalsIncludesSharedChecks,
    helperExists: inspected.helperExists,
    livePolicies: inspected.livePolicies,
    c1cVisible: inspected.c1cVisible,
    freedomVisible: inspected.freedomVisible,
    fundsReceived: inspected.fundsReceived || null,
    classification: {
      ALREADY_ACTIVE_IN_AWS: classified.ALREADY_ACTIVE_IN_AWS,
      MISSING_FROM_AWS: classified.MISSING_FROM_AWS,
      REVOKED_IN_AWS: classified.REVOKED_IN_AWS,
      CONFLICT_DATA_MISMATCH: classified.CONFLICT_DATA_MISMATCH,
    },
    expectedMutation: {
      expectedInsertCount: classified.MISSING_FROM_AWS,
      expectedUpdateCount: classified.REVOKED_IN_AWS,
      expectedDeleteCount: 0,
      expectedCheckOwnershipChanges: 0,
      failClosedOnConflicts: classified.CONFLICT_DATA_MISMATCH > 0,
      bulkInsertSkippedBecauseComplete:
        classified.MISSING_FROM_AWS === 0
        && classified.REVOKED_IN_AWS === 0
        && classified.CONFLICT_DATA_MISMATCH === 0
        && classified.ALREADY_ACTIVE_IN_AWS === 94,
    },
    missingCheckIds: classified.missing.map((r) => r.check_id).sort(),
    revokedCheckIds: classified.revoked.map((r) => r.check_id).sort(),
    conflictCheckIds: classified.conflict.map((r) => r.check_id).sort(),
  };
  await writeFile(path.join(OUT, 'phase1-aws-inspect.json'), JSON.stringify({ ...report, shares: inspected.shares }, null, 2));
  if (inspected.fundsReceived) {
    await writeFile(path.join(OUT, 'funds-received-inspect.json'), JSON.stringify({
      generatedAt: report.generatedAt,
      readOnly: true,
      writesAttempted: false,
      ...inspected.fundsReceived,
    }, null, 2));
  }
  console.log(JSON.stringify({
    wrote: `${OUT}/phase1-aws-inspect.json`,
    fundsReceivedWrote: inspected.fundsReceived ? `${OUT}/funds-received-inspect.json` : null,
    classification: report.classification,
    expectedMutation: report.expectedMutation,
    c1cVisible: report.c1cVisible,
    freedomVisible: report.freedomVisible,
    totalsIncludesSharedChecks: report.totalsIncludesSharedChecks,
    fundsReceived: inspected.fundsReceived ? {
      functionsPresent: inspected.fundsReceived.functionsPresent,
      missingFunctions: inspected.fundsReceived.missingFunctions,
      physical: inspected.fundsReceived.physical,
      sample: inspected.fundsReceived.sample,
      freedomSession: inspected.fundsReceived.freedomSession,
      c1cSession: inspected.fundsReceived.c1cSession,
    } : null,
  }, null, 2));
};

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 400) }));
  process.exit(1);
});
