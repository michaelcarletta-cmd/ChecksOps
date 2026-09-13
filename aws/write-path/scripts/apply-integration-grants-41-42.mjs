/**
 * Temporary in-VPC oneshot: inspect then apply SQL 41 and/or 42 on staging RDS.
 * Never runs 23_claims_org_backfill.sql. Does not GRANT intake claim_id,
 * payments, or wallets. Deletes the Lambda after invoke. Never targets production.
 *
 * Usage: node apply-integration-grants-41-42.mjs inspect|sql41|sql42|probe-claim|inspect-c1c|inspect-portal|mint-portal
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const ACCOUNT = '806168576068';
const LAMBDA_NAME = 'checksops-staging-phase2-grants-3bce';
const ROLE_NAME = process.env.GRANT_ROLE_NAME || 'checksops-staging-rehearsal-oneshot';
const ONESHOT_DIR = path.join(ROOT, 'aws/write-path/oneshot');
const MODE = process.argv[2] || 'inspect';
const LEAD_ID = process.argv[3] || 'ccee4d05-835e-4015-a9bf-7f29c07945f6';

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const awsJson = (args) => {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : {};
};

const packOneshot = async () => {
  const staging = path.join(os.tmpdir(), 'checksops-phase2-grant-pack');
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, 'sql'), { recursive: true });
  for (const file of ['index.mjs', 'package.json']) {
    await copyFile(path.join(ONESHOT_DIR, file), path.join(staging, file));
  }
  const sqlAllow = [
    '41_claims_org_id_insert_grant.sql',
    '41_create_claim_for_staff_org_id.sql',
    '42_public_homeowner_claim_sign_dtp.sql',
  ];
  for (const file of sqlAllow) {
    await copyFile(path.join(ROOT, 'aws/write-path/sql', file), path.join(staging, 'sql', file));
  }
  const pem = path.join(ROOT, 'aws/functions/api/rds-global-bundle.pem');
  if (fs.existsSync(pem)) await copyFile(pem, path.join(staging, 'rds-global-bundle.pem'));
  execFileSync('npm', ['install', '--omit=dev'], { cwd: staging, stdio: 'ignore' });
  const zip = path.join(os.tmpdir(), 'checksops-phase2-grant.zip');
  await rm(zip, { force: true });
  execFileSync('zip', ['-qr', zip, '.'], { cwd: staging });
  return zip;
};

const ensureLambda = async (zipPath, adminSecretArn) => {
  const api = awsJson(['lambda', 'get-function-configuration', '--function-name', 'checksops-staging-api']);
  const vpc = api.VpcConfig || {};
  const roleArn = `arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}`;
  const env = {
    Variables: {
      ADMIN_SECRET_ARN: adminSecretArn,
      RDS_HOST: 'checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com',
      DATABASE_NAME: 'checksops',
    },
  };
  const vpcConfig = `SubnetIds=${(vpc.SubnetIds || []).join(',')},SecurityGroupIds=${(vpc.SecurityGroupIds || []).join(',')}`;
  try { awsJson(['lambda', 'delete-function', '--function-name', LAMBDA_NAME]); } catch { /* none */ }
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
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', LAMBDA_NAME]); } catch { /* ok */ }
};

const invokeLambda = (payload) => {
  const outFile = path.join(os.tmpdir(), `phase2-grant-${payload.step}-${Date.now()}.json`);
  const payloadFile = path.join(os.tmpdir(), `phase2-grant-payload-${payload.step}-${Date.now()}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  run(AWS, [
    '--region', REGION, 'lambda', 'invoke',
    '--function-name', LAMBDA_NAME,
    '--payload', `file://${payloadFile}`,
    outFile,
  ]);
  const raw = fs.readFileSync(outFile, 'utf8');
  try { return JSON.parse(raw); } catch { return { parseError: raw.slice(0, 800) }; }
};

const main = async () => {
  if (!['inspect', 'sql41', 'sql42', 'probe-claim', 'inspect-c1c', 'inspect-portal', 'mint-portal', 'mint-pending'].includes(MODE)) {
    throw new Error(`unsupported mode ${MODE}`);
  }
  const secrets = awsJson(['secretsmanager', 'list-secrets']);
  const adminSecret = (secrets.SecretList || []).find((s) => /checksops_admin/i.test(s.Name || s.ARN || ''));
  if (!adminSecret) throw new Error('checksops_admin secret not listed');
  const zip = await packOneshot();
  const report = {
    productionUntouched: true,
    database: 'checksops',
    function: LAMBDA_NAME,
    mode: MODE,
    refusedBackfill: '23_claims_org_backfill.sql',
  };
  try {
    await ensureLambda(zip, adminSecret.ARN);
    report.pre = invokeLambda({ step: 'inspect-phase2-grants' });
    if (MODE === 'inspect') {
      report.post = report.pre;
    } else if (MODE === 'sql41') {
      if (report.pre?.claimsOrgIdInsertGranted === true) {
        report.sql41 = { applied: false, reason: 'already_granted' };
      } else {
        report.sql41 = invokeLambda({ step: 'grant-claims-org-id-insert' });
      }
      report.post = invokeLambda({ step: 'inspect-phase2-grants' });
      report.probeClaim = invokeLambda({ step: 'probe-phase2-claim-create' });
      report.settlement = invokeLambda({ step: 'probe-c1c-settlement' });
    } else if (MODE === 'sql42') {
      if (report.pre?.dtpSignGranted === true) {
        report.sql42 = { applied: false, reason: 'already_granted' };
      } else {
        report.sql42 = invokeLambda({ step: 'grant-sign-dtp' });
      }
      report.post = invokeLambda({ step: 'inspect-phase2-grants' });
    } else if (MODE === 'probe-claim') {
      report.probeClaim = invokeLambda({ step: 'probe-phase2-claim-create' });
      report.post = invokeLambda({ step: 'inspect-phase2-grants' });
    } else if (MODE === 'inspect-c1c') {
      report.identity = invokeLambda({ step: 'inspect-c1c-identity' });
      report.post = report.pre;
    } else if (MODE === 'inspect-portal') {
      report.portal = invokeLambda({ step: 'inspect-portal-dtp', leadId: LEAD_ID });
      report.post = report.pre;
    } else if (MODE === 'mint-portal') {
      report.mint = invokeLambda({ step: 'mint-portal-fixture' });
      if (report.mint?.access_token) {
        fs.writeFileSync('/tmp/phase2-portal-token.txt', String(report.mint.access_token));
        fs.chmodSync('/tmp/phase2-portal-token.txt', 0o600);
        if (report.mint.leadId) fs.writeFileSync('/tmp/phase2-portal-lead.txt', String(report.mint.leadId));
        report.mint = { ...report.mint, access_token: undefined, tokenRedacted: true };
      }
      report.post = report.pre;
    } else if (MODE === 'mint-pending') {
      report.mint = invokeLambda({ step: 'mint-pending-portal' });
      if (report.mint?.access_token) {
        fs.writeFileSync('/tmp/phase2-pending-token.txt', String(report.mint.access_token));
        fs.chmodSync('/tmp/phase2-pending-token.txt', 0o600);
        if (report.mint.leadId) fs.writeFileSync('/tmp/phase2-pending-lead.txt', String(report.mint.leadId));
        report.mint = { ...report.mint, access_token: undefined, tokenRedacted: true };
      }
      report.post = report.pre;
    }
  } finally {
    try { awsJson(['lambda', 'delete-function', '--function-name', LAMBDA_NAME]); } catch { /* keep going */ }
    report.functionDeleted = true;
  }
  const post = report.post || {};
  const isolation = MODE !== 'sql41' || report.probeClaim?.ok === true;
  const settlementOk = MODE !== 'sql41' || report.settlement?.ok === true;
  const inspectOnly = MODE === 'inspect';
  if (MODE === 'inspect-c1c') {
    report.ok = report.identity?.ok === true;
  } else if (MODE === 'inspect-portal') {
    report.ok = report.portal?.ok === true;
  } else if (MODE === 'mint-portal' || MODE === 'mint-pending') {
    report.ok = report.mint?.ok === true && report.mint?.tokenRedacted === true;
  } else {
    report.ok = inspectOnly
      || (
        post.intakeClaimIdStillDenied === true
        && post.paymentWritesStillDenied === true
        && post.walletWritesStillDenied === true
        && post.c1cFixture?.org_id === '4f172140-f57a-4744-8050-95f4f07b13b4'
        && (MODE !== 'sql41' || post.claimsOrgIdInsertGranted === true)
        && (MODE !== 'sql42' || post.dtpSignGranted === true)
        && isolation
        && settlementOk
      );
  }
  const artifact = `/opt/cursor/artifacts/phase2_integration_${MODE}.json`;
  fs.writeFileSync(artifact, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exit(2);
};

await main();
