#!/usr/bin/env node
/**
 * Batch 3 apply: OPTIONAL software MFA on the production pool only,
 * keep WebAuthn RP checksops.com / SINGLE_FACTOR, overlay privileged-auth
 * Lambda files. Does not enable preferred MFA at login or money flags.
 * Does not modify the staging pool.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const POOL = 'us-east-1_h00WorYMT';
const STAGING_POOL = 'us-east-1_vPmQ7cL1F';
const PREP = 'checksops-production-prep-api';

if (!process.argv.includes('--confirm-batch3')) {
  console.error(JSON.stringify({ error: 'refusing_batch3_apply' }));
  process.exit(2);
}

const run = (args) => {
  try {
    const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const trimmed = String(out || '').trim();
    if (!trimmed) return { ok: true, data: {} };
    try { return { ok: true, data: JSON.parse(trimmed) }; } catch { return { ok: true, data: { raw: trimmed.slice(0, 240) } }; }
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    return {
      ok: false,
      denied: /AccessDenied|not authorized/i.test(text),
      message: text.slice(0, 700),
    };
  }
};

const attempts = [];
const record = (step, result) => {
  attempts.push({ step, ok: result.ok, denied: result.denied || false, message: result.ok ? null : result.message });
  return result;
};

const before = run(['cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', POOL]);
record('getMfaConfig', before);

mkdirSync('/tmp/security', { recursive: true });
const mfaInput = '/tmp/security/batch3-mfa-config.json';
writeFileSync(mfaInput, `${JSON.stringify({
  UserPoolId: POOL,
  MfaConfiguration: 'OPTIONAL',
  SoftwareTokenMfaConfiguration: { Enabled: true },
  WebAuthnConfiguration: {
    RelyingPartyId: 'checksops.com',
    UserVerification: 'preferred',
    FactorConfiguration: 'SINGLE_FACTOR',
  },
}, null, 2)}\n`);
record('setOptionalSoftwareMfa', run([
  'cognito-idp', 'set-user-pool-mfa-config',
  '--cli-input-json', `file://${mfaInput}`,
]));

const riskInput = '/tmp/security/batch3-risk-config.json';
writeFileSync(riskInput, `${JSON.stringify({
  UserPoolId: POOL,
  CompromisedCredentialsRiskConfiguration: {
    EventFilter: ['SIGN_IN', 'PASSWORD_CHANGE', 'SIGN_UP'],
    Actions: { EventAction: 'NO_ACTION' },
  },
  AccountTakeoverRiskConfiguration: {
    Actions: {
      LowAction: { EventAction: 'NO_ACTION', Notify: false },
      MediumAction: { EventAction: 'MFA_IF_CONFIGURED', Notify: false },
      HighAction: { EventAction: 'MFA_IF_CONFIGURED', Notify: false },
    },
  },
}, null, 2)}\n`);
record('setRiskAudit', run([
  'cognito-idp', 'set-risk-configuration',
  '--cli-input-json', `file://${riskInput}`,
]));

const stagingMfa = run(['cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', STAGING_POOL]);
record('confirmStagingMfaUnchanged', {
  ok: (stagingMfa.data.MfaConfiguration || 'OFF') === 'OFF',
  message: stagingMfa.message || null,
});

const codeUrl = run(['lambda', 'get-function', '--function-name', PREP]);
if (codeUrl.ok && codeUrl.data.Code?.Location) {
  try {
    const work = '/tmp/security/prep-lambda-b3';
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    execFileSync('curl', ['-fsSL', codeUrl.data.Code.Location, '-o', '/tmp/security/prep-b3-current.zip'], { encoding: 'utf8' });
    execFileSync('unzip', ['-o', '-q', '/tmp/security/prep-b3-current.zip', '-d', work], { encoding: 'utf8' });
    for (const file of [
      'privileged-auth.mjs',
      'identity.mjs',
      'financial.mjs',
      'auth-mfa.mjs',
    ]) {
      cpSync(`/workspace/aws/functions/api/${file}`, join(work, file));
    }
    execFileSync('bash', ['-lc', `cd ${work} && zip -qr /tmp/security/prep-b3-updated.zip .`], { encoding: 'utf8' });
    record('updatePrepLambdaCode', run([
      'lambda', 'update-function-code',
      '--function-name', PREP,
      '--zip-file', 'fileb:///tmp/security/prep-b3-updated.zip',
    ]));
    try {
      execFileSync(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', PREP], { encoding: 'utf8' });
    } catch { /* describe below */ }
  } catch (error) {
    record('updatePrepLambdaCode', { ok: false, message: String(error.message || error).slice(0, 400) });
  }
} else {
  record('updatePrepLambdaCode', { ok: false, message: codeUrl.message || 'missing_code_location' });
}

const afterMfa = run(['cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', POOL]);
const afterPool = run(['cognito-idp', 'describe-user-pool', '--user-pool-id', POOL]);
const afterRisk = run(['cognito-idp', 'describe-risk-configuration', '--user-pool-id', POOL]);
const afterPrep = run(['lambda', 'get-function-configuration', '--function-name', PREP]);
const vars = afterPrep.data.Environment?.Variables || {};
const stagingAfter = run(['cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', STAGING_POOL]);

const report = {
  ok: Boolean(afterMfa.data.MfaConfiguration === 'OPTIONAL'
    && afterMfa.data.SoftwareTokenMfaConfiguration?.Enabled
    && afterMfa.data.WebAuthnConfiguration?.RelyingPartyId === 'checksops.com'
    && (stagingAfter.data.MfaConfiguration || 'OFF') === 'OFF'
    && String(vars.AWS_COGNITO_MFA_PREFERRED || 'false') !== 'true'
    && String(vars.AWS_MOOV_ENABLED || 'false') !== 'true'
    && String(vars.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || 'false') !== 'true'),
  mutated: true,
  financialActivated: false,
  preferredMfaAtLogin: false,
  productionMfa: afterMfa.data,
  stagingMfa: stagingAfter.data.MfaConfiguration || stagingAfter.message || null,
  passwordPolicy: afterPool.data.UserPool?.Policies?.PasswordPolicy || null,
  recovery: afterPool.data.UserPool?.AccountRecoverySetting || null,
  firstFactors: afterPool.data.UserPool?.SignInPolicy || afterPool.data.UserPool?.UsernameAttributes || null,
  risk: afterRisk.ok ? afterRisk.data : { applied: false, message: afterRisk.message || null },
  lambda: {
    role: afterPrep.data.Role || null,
    mfaPreferred: vars.AWS_COGNITO_MFA_PREFERRED || null,
    moov: vars.AWS_MOOV_ENABLED || null,
    financial: vars.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || null,
  },
  attempts,
};
mkdirSync('/tmp/security', { recursive: true });
writeFileSync('/tmp/security/batch3-apply.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
