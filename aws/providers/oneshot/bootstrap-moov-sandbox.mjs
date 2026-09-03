#!/usr/bin/env node
/**
 * Obtain MOOV_SANDBOX_PLATFORM_ACCOUNT_ID from Moov sandbox account context.
 *
 * Safe paths:
 *   1. use an operator-provided sandbox connected account id, or
 *   2. create a dedicated sandbox connected account when /accounts.write is granted.
 * Then mint the account-specific payment-method scope and resolve
 * wallet.partnerAccountID (the facilitator), matching the production client.
 *
 * Never copies MOOV_PLATFORM_ACCOUNT_ID / production RDS provider IDs.
 * Never prints secret values.
 *
 * Usage: node aws/providers/oneshot/bootstrap-moov-sandbox.mjs
 */
import { execFileSync } from 'node:child_process';

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const SECRET_ID = process.env.PROVIDER_SECRETS_ARN || 'checksops/staging/providers';
const MOOV_HOST = 'https://api.moov.io';
const PINNED = 'v2024.01.00';
const DEFAULT_ORIGIN = 'https://checksops.com';

const awsJson = (args) => JSON.parse(execFileSync('aws', ['--region', REGION, '--output', 'json', ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}));

const redact = (value) => {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 8) return '[redacted]';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

const normalizeOrigin = (value) => {
  try {
    const url = new URL(value || DEFAULT_ORIGIN);
    return `${url.protocol}//${url.host}`;
  } catch {
    return DEFAULT_ORIGIN;
  }
};

const loadSecretObject = () => {
  const raw = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', SECRET_ID]);
  const parsed = JSON.parse(raw.SecretString || '{}');
  return { parsed, arn: raw.ARN };
};

const putSecretObject = (parsed) => {
  execFileSync('aws', ['--region', REGION, 'secretsmanager', 'put-secret-value', '--secret-id', SECRET_ID, '--secret-string', JSON.stringify(parsed)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

const moovToken = async (publicKey, secretKey, scopes, origin, fetchImpl) => {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: scopes.join(' '),
  });
  const resp = await fetchImpl(`${MOOV_HOST}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
    },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error(`moov_oauth_failed_${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const json = JSON.parse(text);
  return json.access_token;
};

const moovJson = async (token, path, { method = 'GET', body, origin, fetchImpl }) => {
  const resp = await fetchImpl(`${MOOV_HOST}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: origin,
      'x-moov-version': PINNED,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  return { ok: resp.ok, status: resp.status, json };
};

export async function bootstrapMoovSandbox({ fetchImpl = fetch, writeSecret = true, loadSecret = loadSecretObject } = {}) {
  let secrets;
  try {
    secrets = loadSecret();
  } catch (error) {
    return {
      ok: false,
      classification: 'BLOCKED BY AWS CREDENTIALS / IAM',
      error: String(error?.message || error).slice(0, 200),
      usedProductionPlatformId: false,
    };
  }

  const parsed = secrets.parsed || {};
  const origin = normalizeOrigin(parsed.MOOV_SANDBOX_ALLOWED_ORIGIN || DEFAULT_ORIGIN);

  if (parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID) {
    if (parsed.MOOV_PLATFORM_ACCOUNT_ID
      && parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID === parsed.MOOV_PLATFORM_ACCOUNT_ID) {
      return {
        ok: false,
        classification: 'BLOCKED BY PROVIDER TEST CONFIGURATION',
        error: 'refused_production_platform_account_id',
        usedProductionPlatformId: true,
        copiedFromProduction: false,
      };
    }
    return {
      ok: true,
      alreadyConfigured: true,
      platformAccountId: parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID,
      platformAccountIdRedacted: redact(parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID),
      connectedAccountId: parsed.MOOV_SANDBOX_CONNECTED_ACCOUNT_ID || null,
      connectedAccountIdRedacted: redact(parsed.MOOV_SANDBOX_CONNECTED_ACCOUNT_ID),
      usedProductionPlatformId: false,
      copiedFromProduction: false,
      source: 'secrets_manager',
      originConfigured: Boolean(parsed.MOOV_SANDBOX_ALLOWED_ORIGIN),
    };
  }

  if (!parsed.MOOV_SANDBOX_PUBLIC_KEY || !parsed.MOOV_SANDBOX_SECRET_KEY) {
    return {
      ok: false,
      classification: 'BLOCKED BY PROVIDER TEST CONFIGURATION',
      error: 'MOOV_SANDBOX_PUBLIC_KEY / MOOV_SANDBOX_SECRET_KEY missing',
      usedProductionPlatformId: false,
    };
  }

  let connectedAccountId = parsed.MOOV_SANDBOX_CONNECTED_ACCOUNT_ID || null;
  let createdConnectedAccount = false;

  if (!connectedAccountId) {
    let createToken;
    try {
      createToken = await moovToken(
        parsed.MOOV_SANDBOX_PUBLIC_KEY,
        parsed.MOOV_SANDBOX_SECRET_KEY,
        ['/accounts.write'],
        origin,
        fetchImpl,
      );
    } catch (error) {
      return {
        ok: false,
        classification: error.status === 401 ? 'BLOCKED BY PROVIDER TEST CONFIGURATION' : 'BLOCKED BY PROVIDER TEST ENVIRONMENT',
        error: String(error.message || error).slice(0, 120),
        oauth: false,
        usedProductionPlatformId: false,
        required: 'Moov sandbox /accounts.write OR MOOV_SANDBOX_CONNECTED_ACCOUNT_ID',
      };
    }

    const displayName = `ChecksOps AWS sandbox ${new Date().toISOString().slice(0, 10)}`;
    const created = await moovJson(createToken, '/accounts', {
      method: 'POST',
      origin,
      fetchImpl,
      body: {
        accountType: 'business',
        displayName,
        profile: {
          business: {
            legalBusinessName: displayName,
            businessType: 'llc',
          },
        },
      },
    });
    if (!created.ok) {
      return {
        ok: false,
        classification: 'BLOCKED BY PROVIDER TEST CONFIGURATION',
        error: `moov_account_create_${created.status}`,
        oauth: true,
        usedProductionPlatformId: false,
        required: 'Moov sandbox /accounts.write OR MOOV_SANDBOX_CONNECTED_ACCOUNT_ID',
        note: 'Do not guess a sandbox account id and do not copy production.',
      };
    }
    connectedAccountId = created.json?.accountID || created.json?.accountId || created.json?.account?.accountID;
    createdConnectedAccount = true;
  }

  if (!connectedAccountId) {
    return {
      ok: false,
      classification: 'BLOCKED BY PROVIDER TEST CONFIGURATION',
      error: 'moov_sandbox_connected_account_missing',
      usedProductionPlatformId: false,
    };
  }

  if (parsed.MOOV_ACCOUNT_ID && connectedAccountId === parsed.MOOV_ACCOUNT_ID) {
    return {
      ok: false,
      classification: 'BLOCKED BY PROVIDER TEST CONFIGURATION',
      error: 'refused_production_connected_account_id',
      usedProductionPlatformId: false,
      copiedFromProduction: false,
    };
  }

  let methodsToken;
  try {
    methodsToken = await moovToken(
      parsed.MOOV_SANDBOX_PUBLIC_KEY,
      parsed.MOOV_SANDBOX_SECRET_KEY,
      [`/accounts/${connectedAccountId}/payment-methods.read`],
      origin,
      fetchImpl,
    );
  } catch (error) {
    return {
      ok: false,
      classification: error.status === 401 ? 'BLOCKED BY PROVIDER TEST CONFIGURATION' : 'BLOCKED BY PROVIDER TEST ENVIRONMENT',
      error: String(error.message || error).slice(0, 120),
      oauth: false,
      connectedAccountId,
      connectedAccountIdRedacted: redact(connectedAccountId),
      usedProductionPlatformId: false,
      required: `/accounts/${redact(connectedAccountId)}/payment-methods.read`,
    };
  }

  const methods = await moovJson(methodsToken, `/accounts/${connectedAccountId}/payment-methods`, {
    origin,
    fetchImpl,
  });
  if (!methods.ok) {
    return {
      ok: false,
      classification: 'BLOCKED BY PROVIDER TEST CONFIGURATION',
      error: `moov_payment_methods_${methods.status}`,
      connectedAccountId,
      connectedAccountIdRedacted: redact(connectedAccountId),
      usedProductionPlatformId: false,
    };
  }

  const partner = (methods.json || [])
    .map((m) => m?.wallet?.partnerAccountID || m?.wallet?.partnerAccountId)
    .find(Boolean);
  const platformAccountId = partner || null;
  if (!platformAccountId) {
    return {
      ok: false,
      classification: 'BLOCKED BY PROVIDER TEST CONFIGURATION',
      error: 'wallet_partner_account_id_unavailable',
      connectedAccountId,
      connectedAccountIdRedacted: redact(connectedAccountId),
      usedProductionPlatformId: false,
      note: 'Sandbox connected account payment-methods did not expose wallet.partnerAccountID. Do not guess the facilitator id.',
    };
  }

  if (parsed.MOOV_PLATFORM_ACCOUNT_ID && platformAccountId === parsed.MOOV_PLATFORM_ACCOUNT_ID) {
    return {
      ok: false,
      classification: 'BLOCKED BY PROVIDER TEST CONFIGURATION',
      error: 'refused_production_platform_account_id',
      usedProductionPlatformId: true,
      copiedFromProduction: false,
    };
  }

  if (writeSecret) {
    putSecretObject({
      ...parsed,
      MOOV_SANDBOX_CONNECTED_ACCOUNT_ID: connectedAccountId,
      MOOV_SANDBOX_PLATFORM_ACCOUNT_ID: platformAccountId,
    });
  }

  return {
    ok: true,
    alreadyConfigured: false,
    oauth: true,
    connectedAccountId,
    connectedAccountIdRedacted: redact(connectedAccountId),
    connectedAccountSource: createdConnectedAccount ? 'created_sandbox_account' : 'secrets_manager',
    platformAccountId,
    platformAccountIdRedacted: redact(platformAccountId),
    source: 'wallet.partnerAccountID',
    usedProductionPlatformId: false,
    copiedFromProduction: false,
    environment: 'sandbox',
    apiVersion: PINNED,
    originConfigured: Boolean(parsed.MOOV_SANDBOX_ALLOWED_ORIGIN),
    secretWritten: Boolean(writeSecret),
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  bootstrapMoovSandbox()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 2);
    })
    .catch((error) => {
      console.log(JSON.stringify({
        ok: false,
        classification: 'BLOCKED BY AWS CREDENTIALS / IAM',
        error: String(error.message || error).slice(0, 200),
      }, null, 2));
      process.exit(2);
    });
}
