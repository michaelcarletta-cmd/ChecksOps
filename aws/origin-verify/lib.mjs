/**
 * Shared helpers for Step 3 origin-verify tooling.
 * Never print origin-verification secret material or CloudFront header values.
 */
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
