/**
 * Reference HTTP API REQUEST authorizer for CloudFront origin verification.
 *
 * DO NOT DEPLOY FROM THIS PR. Review-only. Origin authenticity only —
 * not user authentication. Existing prep Lambda keeps JWT / tenant / RLS.
 *
 * Never log event, headers, or secret material. Never put the secret in
 * frontend JS, Vite env, prep Lambda env, or Git.
 */
import { timingSafeEqual } from 'node:crypto';

export const HEADER_NAME = 'x-checksops-origin-verify';
export const SECRET_NAME = 'checksops/production/cloudfront-origin-verify';
export const SECRET_CACHE_MS = 30_000;

export function headerFromEvent(event) {
  const headers = event?.headers || {};
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === HEADER_NAME) {
      return String(value || '');
    }
  }
  return '';
}

export function timingSafeMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function parseSecretString(raw) {
  const parsed = JSON.parse(String(raw || ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_secret_shape');
  }
  return {
    current: String(parsed.current || ''),
    next: String(parsed.next || ''),
  };
}

export function secretsMatch(provided, secrets) {
  return (
    timingSafeMatch(provided, secrets?.current) ||
    timingSafeMatch(provided, secrets?.next)
  );
}

export function evaluateOriginVerify({ header, secrets, require }) {
  const present = Boolean(header);
  const matched = secretsMatch(header, secrets);
  return {
    isAuthorized: require ? matched : true,
    context: {
      originVerified: matched ? '1' : '0',
      originHeaderPresent: present ? '1' : '0',
    },
  };
}

let cached = { at: 0, value: null };

export function resetSecretCacheForTests() {
  cached = { at: 0, value: null };
}

async function loadSecrets() {
  const now = Date.now();
  if (cached.value && now - cached.at < SECRET_CACHE_MS) {
    return cached.value;
  }
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({});
  const out = await client.send(
    new GetSecretValueCommand({ SecretId: process.env.ORIGIN_VERIFY_SECRET_ARN || SECRET_NAME }),
  );
  const value = parseSecretString(out.SecretString);
  cached = { at: now, value };
  return value;
}

export async function handler(event) {
  const header = headerFromEvent(event);
  const require = String(process.env.ORIGIN_VERIFY_REQUIRE || '') === 'true';
  try {
    const secrets = await loadSecrets();
    return evaluateOriginVerify({ header, secrets, require });
  } catch {
    return {
      isAuthorized: !require,
      context: {
        originVerified: '0',
        originHeaderPresent: header ? '1' : '0',
      },
    };
  }
}
