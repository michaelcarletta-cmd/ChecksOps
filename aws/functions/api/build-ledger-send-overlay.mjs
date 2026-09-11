import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const ROLE = process.env.CURSOR_AWS_ASSUME_IAM_ROLE_ARN;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EXPECTED_SHA = 'X2Q5z8dEgoyoucGZhRO70vGCy8eLuTqDIamQJA+X4C8=';
const PREP_SHA = 'l9nHBQHn+cwwroKO9+czOXi2WMjoeChOpgVFtR0Tj7A=';
const WORK = '/tmp/ledger-send-overlay';
const APPLY = process.argv.includes('--apply');

if (!ROLE) throw new Error('CURSOR_AWS_ASSUME_IAM_ROLE_ARN missing');

const oidcToken = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: '/run/cursor/api.sock', path: '/v1/tokens/oidc', method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString()).token));
  });
  req.on('error', reject);
  req.write(JSON.stringify({ aud: 'sts.amazonaws.com' }));
  req.end();
});

const token = await oidcToken();
const creds = JSON.parse(execFileSync(AWS, [
  'sts', 'assume-role-with-web-identity',
  '--role-arn', ROLE,
  '--role-session-name', 'checksops-ledger-send-overlay',
  '--web-identity-token', String(token),
  '--duration-seconds', '3600',
  '--output', 'json',
], { encoding: 'utf8' })).Credentials;

const env = {
  ...process.env,
  AWS_ACCESS_KEY_ID: creds.AccessKeyId,
  AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
  AWS_SESSION_TOKEN: creds.SessionToken,
  AWS_REGION: 'us-east-1',
  AWS_DEFAULT_REGION: 'us-east-1',
};
writeFileSync('/tmp/aws-env.sh', [
  `export AWS_ACCESS_KEY_ID=${creds.AccessKeyId}`,
  `export AWS_SECRET_ACCESS_KEY=${creds.SecretAccessKey}`,
  `export AWS_SESSION_TOKEN=${creds.SessionToken}`,
  'export AWS_REGION=us-east-1',
  'export AWS_DEFAULT_REGION=us-east-1',
].join('\n') + '\n', { mode: 0o600 });

const aws = (args) => execFileSync(AWS, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });

const staging = JSON.parse(aws([
  'lambda', 'get-function-configuration',
  '--function-name', 'checksops-staging-api',
  '--output', 'json',
]));
const prep = JSON.parse(aws([
  'lambda', 'get-function-configuration',
  '--function-name', 'checksops-production-prep-api',
  '--query', '{sha:CodeSha256,mod:LastModified}',
  '--output', 'json',
]));
if (staging.CodeSha256 !== EXPECTED_SHA) {
  throw new Error(`staging SHA ${staging.CodeSha256} != expected ${EXPECTED_SHA}`);
}
if (prep.sha !== PREP_SHA) {
  throw new Error(`production-prep SHA changed: ${prep.sha}`);
}

const loc = JSON.parse(aws([
  'lambda', 'get-function',
  '--function-name', 'checksops-staging-api',
  '--query', 'Code.Location',
  '--output', 'json',
]));
rmSync(WORK, { recursive: true, force: true });
mkdirSync(`${WORK}/pkg`, { recursive: true });
execFileSync('curl', ['-fsSL', loc, '-o', `${WORK}/live.zip`], { maxBuffer: 64 * 1024 * 1024 });
const liveZipSha = createHash('sha256').update(readFileSync(`${WORK}/live.zip`)).digest('base64');
if (liveZipSha !== EXPECTED_SHA) throw new Error('downloaded zip SHA mismatch');
execFileSync('unzip', ['-o', '-q', `${WORK}/live.zip`, '-d', `${WORK}/pkg`]);

const mustExist = [
  'homeowner.mjs', 'email.mjs', 'email-policy.mjs', 'email-branding.mjs',
  'homeowner-ledger-public.mjs', 'tenant-email-domain.mjs', 'email-templates.mjs',
];
for (const name of mustExist) {
  if (!existsSync(`${WORK}/pkg/${name}`)) throw new Error(`live zip missing ${name}`);
}
const tenantDomain = readFileSync(`${WORK}/pkg/tenant-email-domain.mjs`, 'utf8');
if (!tenantDomain.includes('export const normalizeReplyTo')) {
  throw new Error('live tenant-email-domain.mjs missing normalizeReplyTo');
}
const liveEmail = readFileSync(`${WORK}/pkg/email.mjs`, 'utf8');
if (liveEmail.includes('export const deliverAuditedEmail')) {
  throw new Error('live email.mjs unexpectedly already exports deliverAuditedEmail');
}
if (!liveEmail.includes('export const sendViaSesOrSink')) {
  throw new Error('live email.mjs missing sendViaSesOrSink');
}

copyFileSync(
  path.join(ROOT, 'aws/functions/api/email-policy.mjs'),
  `${WORK}/pkg/email-policy.mjs`,
);
copyFileSync(
  path.join(ROOT, 'aws/functions/api/email-audited.mjs'),
  `${WORK}/pkg/email-audited.mjs`,
);

let homeowner = readFileSync(`${WORK}/pkg/homeowner.mjs`, 'utf8');
if (!homeowner.includes("import { sendViaSesOrSink } from './email.mjs';")) {
  throw new Error('live homeowner.mjs missing sendViaSesOrSink import');
}
if (homeowner.includes("from './email-audited.mjs'")) {
  throw new Error('live homeowner.mjs already imports email-audited');
}
homeowner = homeowner.replace(
  "import { sendViaSesOrSink } from './email.mjs';\n",
  `import { sendViaSesOrSink } from './email.mjs';
import {
  deliverAuditedEmail,
  stableEmailIdempotencyKey,
  validatedMailReplyTo,
} from './email-audited.mjs';
`,
);
if (!homeowner.includes('ledgerUploadInsertValues')) {
  throw new Error('live homeowner.mjs missing public helper import');
}
if (!homeowner.includes('homeownerLedgerTrackingUrl')) {
  homeowner = homeowner.replace(
    `import {
  ledgerUploadInsertValues,`,
    `import {
  homeownerLedgerTrackingUrl,
  ledgerUploadInsertValues,`,
  );
}
const gitHomeowner = readFileSync(path.join(ROOT, 'aws/functions/api/homeowner.mjs'), 'utf8');
const start = gitHomeowner.indexOf('export const runHomeownerLedgerSend');
const end = gitHomeowner.indexOf('export const runSendFileToHomeowner');
if (start < 0 || end < 0) throw new Error('git homeowner send function bounds missing');
const gitSend = gitHomeowner.slice(start, end);
const liveStart = homeowner.indexOf('export const runHomeownerLedgerSend');
const liveEnd = homeowner.indexOf('export const runSendFileToHomeowner');
if (liveStart < 0 || liveEnd < 0) throw new Error('live homeowner send function bounds missing');
homeowner = `${homeowner.slice(0, liveStart)}${gitSend}${homeowner.slice(liveEnd)}`;
writeFileSync(`${WORK}/pkg/homeowner.mjs`, homeowner);

const patched = readFileSync(`${WORK}/pkg/homeowner.mjs`, 'utf8');
const checks = {
  stillImportsSendViaSesOrSink: patched.includes("from './email.mjs'"),
  importsAudited: patched.includes("from './email-audited.mjs'"),
  usesHelper: patched.includes('homeownerLedgerTrackingUrl(origin, tokenRow.token, claimId)'),
  noPrimaryHLedger: !/const url = `\$\{origin\}\/h\/ledger\//.test(patched.slice(
    patched.indexOf('export const runHomeownerLedgerSend'),
    patched.indexOf('export const runSendFileToHomeowner'),
  )),
  noChecksopsOverrideInSend: !/senderOverride:\s*'checksops'/.test(patched.slice(
    patched.indexOf('export const runHomeownerLedgerSend'),
    patched.indexOf('export const handleHomeownerLedgerSend'),
  )),
  emailMatchReuse: patched.includes('lower(trim(homeowner_email))'),
  viewUntouched: patched.includes('export const handleHomeownerLedgerView'),
  publicViewImport: patched.includes('runHomeownerLedgerView'),
};
for (const [name, ok] of Object.entries(checks)) {
  if (!ok) throw new Error(`overlay check failed: ${name}`);
}

process.chdir(`${WORK}/pkg`);
const importProbe = execFileSync(process.execPath, ['--input-type=module', '-e', `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const policy = await import('./email-policy.mjs');
const audited = await import('./email-audited.mjs');
const publicLedger = await import('./homeowner-ledger-public.mjs');
const homeowner = await import('./homeowner.mjs');
const email = await import('./email.mjs');
if (typeof email.sendViaSesOrSink !== 'function') throw new Error('live email sendViaSesOrSink missing');
if (typeof email.deliverAuditedEmail === 'function') throw new Error('live email.mjs unexpectedly exports deliverAuditedEmail');
if (typeof audited.deliverAuditedEmail !== 'function') throw new Error('email-audited missing deliverAuditedEmail');
if (typeof policy.stagingSesLockRecipient !== 'function') throw new Error('policy missing lock');
if (typeof publicLedger.homeownerLedgerTrackingUrl !== 'function') throw new Error('helper missing');
if (typeof homeowner.runHomeownerLedgerSend !== 'function') throw new Error('send missing');
if (typeof homeowner.handleHomeownerLedgerView !== 'function') throw new Error('view missing');
process.env.AWS_EMAIL_MODE = 'ses-identity';
process.env.CHECKSOPS_ENV = 'staging';
process.env.AWS_EMAIL_SES_LOCK_RECIPIENT = 'mcarletta@freedomadj.com';
if (policy.emailMode() !== 'ses-identity') throw new Error('ses-identity not recognized');
if (policy.stagingSesLockRecipient() !== 'mcarletta@freedomadj.com') throw new Error('lock not recognized');
const locked = policy.applyRecipientPolicy(['mcarletta@freedomadj.com'])[0];
if (locked.delivery !== 'sink' || locked.policy !== 'staging_ses_identity') throw new Error('ses-identity not sink');
const mismatch = policy.applyRecipientPolicy(['checksops-tester@freedomadj.com'])[0];
if (mismatch.delivery !== 'sink') throw new Error('mismatch must sink in ses-identity');
const claimUrl = publicLedger.homeownerLedgerTrackingUrl('https://staging.checksops.com', 'abc', 'claim-id');
if (claimUrl !== 'https://staging.checksops.com/ledger/abc') throw new Error(claimUrl);
const preUrl = publicLedger.homeownerLedgerTrackingUrl('https://staging.checksops.com', 'abc', null);
if (preUrl !== 'https://staging.checksops.com/start-claim/abc') throw new Error(preUrl);
console.log(JSON.stringify({
  policyLock: policy.stagingSesLockRecipient(),
  emailMode: policy.emailMode(),
  claimUrl,
  preUrl,
  homeownerExports: ['runHomeownerLedgerSend','handleHomeownerLedgerView','handleHomeownerLedgerSignLink'].every((k) => typeof homeowner[k] === 'function'),
}));
`], { encoding: 'utf8', env: { ...process.env, NODE_PATH: `${WORK}/pkg/node_modules` } });

execFileSync('zip', ['-qr', `${WORK}/overlay.zip`, '.'], { cwd: `${WORK}/pkg` });
const overlayShaLocal = createHash('sha256').update(readFileSync(`${WORK}/overlay.zip`)).digest('base64');

const vars = staging.Environment?.Variables || {};
const envSnapshot = {
  AWS_EMAIL_MODE: vars.AWS_EMAIL_MODE ?? null,
  AWS_EMAIL_SES_LOCK_RECIPIENT: vars.AWS_EMAIL_SES_LOCK_RECIPIENT ?? null,
  AWS_TENANT_EMAIL_DOMAIN_ENABLED: vars.AWS_TENANT_EMAIL_DOMAIN_ENABLED ?? null,
};
if (envSnapshot.AWS_EMAIL_MODE !== 'ses-identity') throw new Error('refusing to overlay: email mode is not ses-identity');
if (envSnapshot.AWS_EMAIL_SES_LOCK_RECIPIENT !== 'mcarletta@freedomadj.com') {
  throw new Error('refusing to overlay: lock recipient mismatch');
}

const report = {
  apply: APPLY,
  rollbackSha: staging.CodeSha256,
  rollbackRevision: staging.RevisionId,
  rollbackLastModified: staging.LastModified,
  overlayZipSha256Base64: overlayShaLocal,
  filesOverlaid: ['email-policy.mjs', 'email-audited.mjs', 'homeowner.mjs (send path only)'],
  filesNotOverlaid: ['email.mjs', 'email-branding.mjs', 'homeowner-ledger-public.mjs'],
  importProbe: JSON.parse(importProbe.trim().split('\n').at(-1)),
  envSnapshot,
  prep,
  checks,
};

if (!APPLY) {
  writeFileSync(`${WORK}/preflight.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, note: 'pass --apply to UpdateFunctionCode' }, null, 2));
  process.exit(0);
}

aws([
  'lambda', 'update-function-code',
  '--function-name', 'checksops-staging-api',
  '--zip-file', `fileb://${WORK}/overlay.zip`,
  '--output', 'json',
]);
let updated = null;
for (let i = 0; i < 20; i += 1) {
  updated = JSON.parse(aws([
    'lambda', 'get-function-configuration',
    '--function-name', 'checksops-staging-api',
    '--output', 'json',
  ]));
  if (updated.LastUpdateStatus === 'Successful' || updated.State === 'Active' && updated.LastUpdateStatus !== 'InProgress') {
    if (updated.LastUpdateStatus === 'Failed') throw new Error('Lambda update failed');
    if (updated.LastUpdateStatus === 'Successful') break;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
}
const afterVars = updated.Environment?.Variables || {};
const envUnchanged = afterVars.AWS_EMAIL_MODE === 'ses-identity'
  && afterVars.AWS_EMAIL_SES_LOCK_RECIPIENT === 'mcarletta@freedomadj.com'
  && afterVars.AWS_TENANT_EMAIL_DOMAIN_ENABLED === 'true';
if (!envUnchanged) throw new Error('email env changed after code overlay');
const prepAfter = JSON.parse(aws([
  'lambda', 'get-function-configuration',
  '--function-name', 'checksops-production-prep-api',
  '--query', '{sha:CodeSha256,mod:LastModified}',
  '--output', 'json',
]));
report.deployed = {
  CodeSha256: updated.CodeSha256,
  LastModified: updated.LastModified,
  RevisionId: updated.RevisionId,
  LastUpdateStatus: updated.LastUpdateStatus,
  envUnchanged,
  prepAfter,
};
writeFileSync(`${WORK}/deploy.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  rollbackSha: report.rollbackSha,
  deployedSha: updated.CodeSha256,
  lastModified: updated.LastModified,
  envUnchanged,
  prepSha: prepAfter.sha,
}, null, 2));
