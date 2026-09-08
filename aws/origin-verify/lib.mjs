/**
 * Shared helpers for Step 3 origin-verify tooling.
 * Never print origin-verification secret material or CloudFront header values.
 */
import { spawnSync } from 'node:child_process';
export const HEADER_NAME = 'x-checksops-origin-verify';
export const SECRET_NAME = 'checksops/production/cloudfront-origin-verify';
export const AUTHORIZER_NAME = 'checksops-production-origin-verify';
export const LAMBDA_NAME = 'checksops-production-origin-verify';
export const EXECUTION_ROLE_NAME = 'checksops-production-origin-verify';
export const API_ID = 'kiqojucc02';
export const INTEGRATION_ID = 'jci10de';
export const DISTRIBUTION_ID = 'E1B0ZWWO5559U5';
export const PREP_LAMBDA = 'checksops-production-prep-api';
export const WAF_ARN =
  'arn:aws:wafv2:us-east-1:806168576068:global/webacl/checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7';
export const PREP_LAMBDA_ARN =
  'arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api';

const SECRETISH =
  /HeaderValue|SecretString|SecretBinary|current|next|x-checksops-origin-verify["']?\s*[:=]/i;

export function redactDeep(value) {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(HeaderValue|SecretString|SecretBinary)$/i.test(key)) {
        out[key] = '[REDACTED]';
      } else if (key === 'CustomHeaders' || key === 'Items') {
        out[key] = redactDeep(item);
      } else {
        out[key] = redactDeep(item);
      }
    }
    return out;
  }
  return value;
}

export function assertNoSecretLeak(text) {
  const raw = String(text || '');
  if (SECRETISH.test(raw) && /HeaderValue|SecretString/.test(raw) && !raw.includes('[REDACTED]')) {
    throw new Error('refusing to emit secret-bearing output');
  }
}

export function publicVerifyLine(state) {
  return {
    originHeaderPresent: Boolean(state.originHeaderPresent),
    originHeaderValid: Boolean(state.originHeaderValid),
  };
}

/** Parse CloudWatch-prefixed authorizer lines into public booleans only. */
export function parseObserveLogLine(line) {
  const raw = String(line || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    const obj = JSON.parse(raw.slice(start));
    if (obj && typeof obj === 'object' && 'originHeaderPresent' in obj) {
      return publicVerifyLine(obj);
    }
  } catch {
    return null;
  }
  return null;
}

export function requireGate(name, expected = 'I_UNDERSTAND_PRODUCTION') {
  if (String(process.env[name] || '') !== expected) {
    console.error(`DO_NOT_DEPLOY ${name} is unset. Step 3 must not run.`);
    process.exit(2);
  }
}

export function refuseRequireMode() {
  if (String(process.env.ORIGIN_VERIFY_REQUIRE || '') === 'true') {
    console.error('DO_NOT_DEPLOY Gate 3D / ORIGIN_VERIFY_REQUIRE=true is not part of this package.');
    process.exit(2);
  }
}

export function shouldExecute() {
  return String(process.env.CHECKSOPS_STEP3_EXECUTE || '') === '1';
}

export const AWS_BIN = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;

export function awsJson(args, { input, allowFail = false } = {}) {
  const r = spawnSync(AWS_BIN, ['--region', 'us-east-1', '--output', 'json', ...args], {
    encoding: 'utf8',
    input,
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  });
  if (r.status !== 0) {
    const err = redactCli((r.stderr || r.stdout || '').slice(0, 1500));
    if (allowFail) return { __error: err, __status: r.status };
    throw new Error(`${args[0]} ${args[1] || ''} failed: ${err}`);
  }
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

export function awsText(args) {
  const r = spawnSync(AWS_BIN, ['--region', 'us-east-1', '--output', 'text', ...args], {
    encoding: 'utf8',
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(`${args[0]} ${args[1] || ''} failed: ${redactCli((r.stderr || r.stdout || '').slice(0, 1500))}`);
  }
  return String(r.stdout || '').trim();
}

export function redactCli(text) {
  return String(text || '')
    .replace(/"HeaderValue"\s*:\s*"[^"]*"/g, '"HeaderValue":"[REDACTED]"')
    .replace(/"SecretString"\s*:\s*"[^"]*"/g, '"SecretString":"[REDACTED]"')
    .replace(/"current"\s*:\s*"[^"]*"/g, '"current":"[REDACTED]"')
    .replace(/"next"\s*:\s*"[^"]*"/g, '"next":"[REDACTED]"')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
}

export function requireStep3Temp() {
  const ident = awsJson(['sts', 'get-caller-identity']);
  const arn = String(ident.Arn || '');
  if (!arn.includes('ChecksOpsCursorApiPerimeterStep3Temp')) {
    throw new Error(`refusing_wrong_identity ${arn}`);
  }
  return arn;
}
