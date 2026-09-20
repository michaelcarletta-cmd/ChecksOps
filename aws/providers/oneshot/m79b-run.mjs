#!/usr/bin/env node
/**
 * M7.9B: add https://checksops.com to the EXISTING Moov sandbox API key
 * allowed origins, then install proven sandbox names onto
 * checksops/production/provider. Never prints secret values. Never copies
 * production keys. Never arms POST flags. Never creates a replacement key.
 * Never POSTs transfers.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';
import { hmacHex } from '../../functions/api/providers/hmac.mjs';
import { verifyMoovWebhookEnvironment } from '../../functions/api/providers/webhooks.mjs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const STAGING_SECRET = 'checksops/staging/providers';
const PRODUCTION_SECRET = 'checksops/production/provider';
const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const FREEDOM_MOOV = KNOWN_APPROVED_MOOV.freedom.moovAccountId;
const PRODUCTION_PLATFORM = KNOWN_APPROVED_MOOV.platform.moovAccountId;
const PRODUCTION_IDS = new Set([
  KNOWN_APPROVED_MOOV.freedom.moovAccountId,
  KNOWN_APPROVED_MOOV.freedom.walletId,
  KNOWN_APPROVED_MOOV.freedom.bankId,
  KNOWN_APPROVED_MOOV.c1c.moovAccountId,
  KNOWN_APPROVED_MOOV.platform.moovAccountId,
  KNOWN_APPROVED_MOOV.recipient.moovAccountId,
].map((id) => String(id).toLowerCase()));
const SANDBOX_KEYS = [
  'MOOV_SANDBOX_PUBLIC_KEY',
  'MOOV_SANDBOX_SECRET_KEY',
  'MOOV_SANDBOX_PLATFORM_ACCOUNT_ID',
  'MOOV_SANDBOX_ALLOWED_ORIGIN',
  'MOOV_SANDBOX_WEBHOOK_SECRET',
  'MOOV_SANDBOX_API_VERSION',
];
const PRODUCTION_PRESERVE = [
  'MOOV_PUBLIC_KEY',
  'MOOV_SECRET_KEY',
  'MOOV_PLATFORM_ACCOUNT_ID',
  'MOOV_WEBHOOK_SECRET',
  'MOOV_ENVIRONMENT',
  'MOOV_ALLOWED_ORIGIN',
];
const PROVEN_API_VERSION = PRODUCTION_MOOV_API_VERSION;
const LIVE_ORIGIN = PRODUCTION_MOOV_ORIGIN;
const STAGING_ORIGIN = 'https://staging.checksops.com';
const PREFERRED_WEBHOOK_URL = 'https://checksops.com/prep/webhooks/moov';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const SAFE_JWT_KEYS = new Set([
  'accountID', 'account_id', 'aid', 'accountId',
  'iss', 'aud', 'exp', 'iat', 'nbf', 'kid', 'typ', 'alg',
  'scope', 'scopes', 'mode', 'environment', 'accountMode',
  'origin', 'origins', 'domain', 'domains', 'allowed_origin',
  'allowedOrigin', 'allowedOrigins', 'allowed_origins', 'allowedDomains',
]);

const OPERATOR_ACTION = [
  'Moov Dashboard → Test/Sandbox mode → Developers → API keys.',
  'Open the EXISTING ChecksOps sandbox API key (do not create a new key).',
  'Add domain https://checksops.com (apex, no www).',
  'Keep https://staging.checksops.com and https://www.checksops.com.',
  'Do not rotate the secret. Do not change production keys.',
  'Then re-run M7.9B Phase 3 (live-origin GET with Origin https://checksops.com).',
].join(' ');

let sandboxWebhookSecretForInstall = null;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  ...opts,
});
const awsJson = (args) => {
  const out = run(AWS, ['--region', REGION, '--output', 'json', ...args]);
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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString()).token); }
      catch (error) { reject(error); }
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
  const creds = awsJson([
    'sts', 'assume-role-with-web-identity',
    '--role-arn', role,
    '--role-session-name', 'checksops-m79b-sandbox-origin',
    '--web-identity-token', String(token),
    '--duration-seconds', '3600',
  ]).Credentials;
  process.env.AWS_ACCESS_KEY_ID = creds.AccessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = creds.SecretAccessKey;
  process.env.AWS_SESSION_TOKEN = creds.SessionToken;
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
  return awsJson(['sts', 'get-caller-identity']);
};

const present = (value) => typeof value === 'string' && value.trim().length > 0;
const sha256 = (value) => createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
const fingerprint = (id) => {
  if (!id) return null;
  const s = String(id);
  if (s.length < 12) return '[id]';
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
};
const shortFp = (id) => {
  if (!id) return null;
  const s = String(id);
  if (s.length < 8) return '[id]';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
const originHost = (value) => {
  if (!present(value)) return null;
  try {
    const url = new URL(String(value).trim());
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'unparseable';
  }
};
const configured = (obj, key) => present(obj?.[key]) ? 'CONFIGURED' : 'MISSING';
const basicAuth = (publicKey, secretKey) => (
  `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`
);

const loadSecret = (id) => {
  const raw = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', id]);
  const parsed = JSON.parse(raw.SecretString || '{}');
  return {
    name: raw.Name,
    arnEndsWith: String(raw.ARN || '').slice(-36),
    versionId: raw.VersionId || null,
    parsed,
  };
};

const secretMeta = (secret, keys) => {
  const names = {};
  for (const key of keys) names[key] = configured(secret.parsed, key);
  return {
    secretName: secret.name,
    arnEndsWith: secret.arnEndsWith,
    keyCount: Object.keys(secret.parsed).length,
    keyNames: Object.keys(secret.parsed).sort(),
    names,
    missing: keys.filter((key) => names[key] === 'MISSING'),
  };
};

const lambdaFlags = () => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  const env = cfg.Environment?.Variables || {};
  return {
    lastModified: cfg.LastModified,
    codeSha256: cfg.CodeSha256,
    state: cfg.State,
    lastUpdateStatus: cfg.LastUpdateStatus,
    description: cfg.Description || null,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
    },
    envKeyCount: Object.keys(env).length,
    PROVIDER_SECRETS_ARN: env.PROVIDER_SECRETS_ARN,
    MOOV_WEBHOOK_SECRET_ARN: env.MOOV_WEBHOOK_SECRET_ARN,
  };
};

const waitFn = (name) => {
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-updated', '--function-name', name]); } catch { /* ok */ }
  try { run(AWS, ['--region', REGION, 'lambda', 'wait', 'function-active', '--function-name', name]); } catch { /* ok */ }
};

const probe = async (pathName, method = 'GET', body = null, headers = {}) => {
  const started = Date.now();
  const res = await fetch(`https://checksops.com/prep${pathName}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 180) }; }
  return {
    path: pathName,
    status: res.status,
    ms: Date.now() - started,
    error: json?.error || null,
    challenge: json?.challenge || json?.preferredChallenge || null,
    service: json?.service || null,
    environment: json?.environment || null,
    secretsSandboxPublic: json?.secrets?.MOOV_SANDBOX_PUBLIC_KEY_configured ?? null,
    secretsSandboxSecret: json?.secrets?.MOOV_SANDBOX_SECRET_KEY_configured ?? null,
    secretsSandboxPlatform: json?.secrets?.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID_configured ?? null,
    secretsSandboxOrigin: json?.secrets?.MOOV_SANDBOX_ALLOWED_ORIGIN_configured ?? null,
    createdPaymentTransfer: json?.createdPaymentTransfer === true,
    liveProviderPosted: json?.liveProviderPosted === true,
    applied: json?.applied === true,
    webhookEnvironment: json?.environment || json?.secretEnvironment || null,
    mappedEnvironment: json?.mapped_environment || null,
  };
};

const decodeJwt = (token) => {
  if (!token || String(token).split('.').length !== 3) return { keys: [], safe: {} };
  try {
    const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    const keys = Object.keys(claims).sort();
    const safe = {};
    for (const key of keys) {
      if (!SAFE_JWT_KEYS.has(key)) continue;
      const value = claims[key];
      if (typeof value === 'string' && /secret|password|key|token/i.test(key)) continue;
      if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)) {
        safe[key] = fingerprint(value);
      } else if (Array.isArray(value)) {
        safe[key] = value.map((item) => {
          if (typeof item === 'string' && /^https?:\/\//i.test(item)) return originHost(item) || item;
          if (typeof item === 'string' && item.length > 24 && /^[0-9a-f-]{36}$/i.test(item)) return fingerprint(item);
          return item;
        }).slice(0, 12);
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        safe[key] = value;
      }
    }
    return {
      keys,
      safe,
      accountId: claims.accountID || claims.account_id || claims.aid || claims.accountId || null,
    };
  } catch {
    return { keys: [], safe: {} };
  }
};

const moovOauth = async ({ publicKey, secretKey, origin, scopes }) => {
  const started = Date.now();
  const res = await fetch('https://api.moov.io/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuth(publicKey, secretKey),
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: scopes.join(' '),
    }),
  });
  const json = await res.json().catch(() => null);
  const token = json?.access_token || null;
  const jwt = decodeJwt(token);
  return {
    ok: res.ok && Boolean(token),
    status: res.status,
    ms: Date.now() - started,
    token,
    tokenType: json?.token_type || null,
    scope: json?.scope || null,
    accountId: jwt.accountId || null,
    accountFp: fingerprint(jwt.accountId),
    origin,
    scopes,
    jwtKeys: jwt.keys,
    jwtSafe: jwt.safe,
  };
};

const moovCall = async ({
  publicKey,
  secretKey,
  token,
  origin,
  apiVersion,
  path,
  method = 'GET',
  body,
  extraHeaders = {},
}) => {
  if (!['GET', 'PATCH', 'PUT'].includes(method)) {
    throw new Error(`refused_method_${method}`);
  }
  const headers = {
    Accept: 'application/json',
    Origin: origin,
    'x-moov-version': apiVersion,
    ...extraHeaders,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  else headers.Authorization = basicAuth(publicKey, secretKey);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  else headers['Content-Type'] = 'application/json';
  const res = await fetch(`https://api.moov.io${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return {
    ok: res.ok,
    status: res.status,
    path,
    method,
    versionEcho: res.headers.get('x-moov-version') || null,
    error: json?.error || json?.message || json?.errorCode || null,
    json,
    bodyLen: text.length,
  };
};

const accountSafe = (json) => {
  if (!json || typeof json !== 'object') return null;
  const id = json.accountID || json.accountId || json.account_id || null;
  return {
    accountFp: fingerprint(id),
    accountType: json.accountType || json.account_type || null,
    displayName: json.displayName || json.display_name || null,
    mode: json.mode || json.accountMode || null,
    verification: json.verification?.status || json.verificationStatus || null,
    foreignID: json.foreignID || json.foreignId || null,
    isProductionId: id ? PRODUCTION_IDS.has(String(id).toLowerCase()) : false,
    looksLikeChecksOps: /checksops|check ops|pipeline test/i.test(JSON.stringify({
      displayName: json.displayName || json.display_name || '',
      foreignID: json.foreignID || json.foreignId || '',
    })),
  };
};

const invokeOneshot = (payload) => {
  const outFile = `/tmp/m79b-oneshot-${payload.step}.json`;
  try {
    run(AWS, [
      '--region', REGION, 'lambda', 'invoke',
      '--function-name', ONESHOT_FN,
      '--cli-binary-format', 'raw-in-base64-out',
      '--payload', JSON.stringify(payload),
      outFile,
    ]);
    const raw = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (raw.statusCode && raw.body) {
      try { return JSON.parse(raw.body); } catch { return raw; }
    }
    return raw;
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 240) };
  }
};

const inspectPhase = (staging, production, webhookSecret) => {
  const stagingMeta = secretMeta(staging, SANDBOX_KEYS);
  const productionMeta = secretMeta(production, [...PRODUCTION_PRESERVE, ...SANDBOX_KEYS]);
  const webhookMeta = webhookSecret
    ? secretMeta(webhookSecret, ['MOOV_WEBHOOK_SECRET', 'MOOV_SANDBOX_WEBHOOK_SECRET'])
    : null;
  const stagingParsed = staging.parsed;
  const productionParsed = production.parsed;
  const platformId = stagingParsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID || null;
  const equalsProduction = {
    publicKey: present(stagingParsed.MOOV_SANDBOX_PUBLIC_KEY)
      && present(productionParsed.MOOV_PUBLIC_KEY)
      && stagingParsed.MOOV_SANDBOX_PUBLIC_KEY === productionParsed.MOOV_PUBLIC_KEY,
    secretKey: present(stagingParsed.MOOV_SANDBOX_SECRET_KEY)
      && present(productionParsed.MOOV_SECRET_KEY)
      && stagingParsed.MOOV_SANDBOX_SECRET_KEY === productionParsed.MOOV_SECRET_KEY,
    platformAccount: present(platformId)
      && PRODUCTION_IDS.has(String(platformId).toLowerCase()),
    webhookSecret: present(stagingParsed.MOOV_SANDBOX_WEBHOOK_SECRET)
      && present(productionParsed.MOOV_WEBHOOK_SECRET)
      && stagingParsed.MOOV_SANDBOX_WEBHOOK_SECRET === productionParsed.MOOV_WEBHOOK_SECRET,
  };
  const intended = !equalsProduction.publicKey
    && !equalsProduction.secretKey
    && !equalsProduction.platformAccount
    && stagingMeta.names.MOOV_SANDBOX_PUBLIC_KEY === 'CONFIGURED'
    && stagingMeta.names.MOOV_SANDBOX_SECRET_KEY === 'CONFIGURED'
    && stagingMeta.names.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID === 'CONFIGURED';
  return {
    staging: {
      ...stagingMeta,
      originHost: originHost(stagingParsed.MOOV_SANDBOX_ALLOWED_ORIGIN),
      platformFp: fingerprint(platformId),
      publicKeyFp: shortFp(stagingParsed.MOOV_SANDBOX_PUBLIC_KEY),
      platformIsProductionId: equalsProduction.platformAccount,
    },
    productionPrep: productionMeta,
    webhookSecret: webhookMeta,
    equalsProduction,
    intendedSandboxCandidate: intended,
    copiedFromProduction: Object.values(equalsProduction).some(Boolean),
  };
};

const collectOrigins = (value, into = new Set()) => {
  if (!value) return into;
  if (typeof value === 'string') {
    const host = originHost(value);
    if (host && host !== 'unparseable') into.add(host);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOrigins(item, into);
    return into;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (/origin|domain/i.test(key)) collectOrigins(nested, into);
    }
  }
  return into;
};

const looksLikeKeyRecord = (row, publicKey) => {
  if (!row || typeof row !== 'object') return false;
  const publicish = row.publicKey || row.public_key || row.clientID || row.client_id || row.keyID || row.key_id || row.id;
  if (publicish && publicKey && String(publicish) === String(publicKey)) return true;
  const domains = collectOrigins(row);
  return domains.size > 0 && (
    Boolean(row.name) || Boolean(row.publicKey) || Boolean(row.domains) || Boolean(row.allowedOrigins)
  );
};

const summarizeKeyRecord = (row, publicKey) => {
  const id = row?.keyID || row?.keyId || row?.id || row?.clientID || null;
  const domains = [...collectOrigins(row)];
  const publicish = row?.publicKey || row?.public_key || row?.clientID || row?.client_id || null;
  return {
    id,
    idFp: fingerprint(id),
    name: row?.name || row?.description || row?.note || null,
    publicKeyMatch: publicish ? String(publicish) === String(publicKey) : null,
    publicKeyFp: publicish ? shortFp(publicish) : null,
    domains,
    hasStaging: domains.includes(STAGING_ORIGIN),
    hasLive: domains.includes(LIVE_ORIGIN),
    mode: row?.mode || row?.environment || null,
    domainField: row?.domains ? 'domains'
      : row?.allowedOrigins ? 'allowedOrigins'
        : row?.allowed_origins ? 'allowed_origins'
          : row?.allowedDomains ? 'allowedDomains'
            : null,
  };
};

const identifyKey = async (staging) => {
  const s = staging.parsed;
  const platformId = s.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID;
  const oauthLive = await moovOauth({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: LIVE_ORIGIN,
    scopes: ['/accounts.read'],
  });
  const oauthStaging = await moovOauth({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: STAGING_ORIGIN,
    scopes: ['/accounts.read'],
  });
  const profileOauth = await moovOauth({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: STAGING_ORIGIN,
    scopes: [`/accounts/${platformId}/profile.read`],
  });
  const platformGetStaging = profileOauth.ok ? await moovCall({
    token: profileOauth.token,
    origin: STAGING_ORIGIN,
    apiVersion: PROVEN_API_VERSION,
    path: `/accounts/${platformId}`,
  }) : { ok: false, status: profileOauth.status, json: null };
  const profileOauthLive = await moovOauth({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: LIVE_ORIGIN,
    scopes: [`/accounts/${platformId}/profile.read`],
  });
  const platformGetLive = profileOauthLive.ok ? await moovCall({
    token: profileOauthLive.token,
    origin: LIVE_ORIGIN,
    apiVersion: PROVEN_API_VERSION,
    path: `/accounts/${platformId}`,
  }) : { ok: false, status: profileOauthLive.status, json: null };
  const profileOauthWww = await moovOauth({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: 'https://www.checksops.com',
    scopes: [`/accounts/${platformId}/profile.read`],
  });
  const platformGetWww = profileOauthWww.ok ? await moovCall({
    token: profileOauthWww.token,
    origin: 'https://www.checksops.com',
    apiVersion: PROVEN_API_VERSION,
    path: `/accounts/${platformId}`,
  }) : { ok: false, status: profileOauthWww.status, json: null };
  const pingOauth = await moovOauth({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: STAGING_ORIGIN,
    scopes: ['/ping.read'],
  });
  const ping = {};
  if (pingOauth.ok) {
    for (const origin of [LIVE_ORIGIN, STAGING_ORIGIN, 'https://www.checksops.com']) {
      const row = await moovCall({
        token: pingOauth.token,
        origin,
        apiVersion: PROVEN_API_VERSION,
        path: '/ping',
      });
      ping[origin] = { status: row.status, ok: row.ok };
    }
  }

  const applications = await moovCall({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: STAGING_ORIGIN,
    apiVersion: PROVEN_API_VERSION,
    path: '/applications',
  });
  const applicationRows = Array.isArray(applications.json) ? applications.json : [];
  const applicationMeta = applicationRows.map((row) => ({
    applicationFp: fingerprint(row.applicationID || row.applicationId || row.id),
    accountFp: fingerprint(row.accountID || row.accountId),
    name: row.name || row.description || null,
    accountMode: row.accountMode ?? row.mode ?? null,
    domainFields: Object.keys(row || {}).filter((key) => /origin|domain/i.test(key)),
    fieldNames: Object.keys(row || {}).sort(),
    matchesPlatform: String(row.accountID || row.accountId || '').toLowerCase() === String(platformId).toLowerCase(),
  }));

  return {
    publicKeyFp: shortFp(s.MOOV_SANDBOX_PUBLIC_KEY),
    platformFp: fingerprint(platformId),
    jwtAccountFp: fingerprint(oauthStaging.accountId || oauthLive.accountId),
    jwtKeys: [...new Set([...(oauthLive.jwtKeys || []), ...(oauthStaging.jwtKeys || [])])],
    jwtSafe: { ...(oauthStaging.jwtSafe || {}), ...(oauthLive.jwtSafe || {}) },
    oauthLive: { ok: oauthLive.ok, status: oauthLive.status },
    oauthStaging: { ok: oauthStaging.ok, status: oauthStaging.status },
    platformGetStaging: {
      status: platformGetStaging.status,
      account: accountSafe(platformGetStaging.json),
    },
    platformGetLiveBefore: {
      status: platformGetLive.status,
      account: accountSafe(platformGetLive.json),
    },
    platformGetWww: {
      status: platformGetWww.status,
      account: accountSafe(platformGetWww.json),
    },
    ping,
    applications: {
      status: applications.status,
      count: applicationMeta.length,
      rows: applicationMeta,
    },
    originBefore: {
      stagingAccepted: platformGetStaging.status === 200,
      liveAccepted: platformGetLive.status === 200,
      stagingOriginOnSecret: originHost(s.MOOV_SANDBOX_ALLOWED_ORIGIN),
      liveOriginCurrentlyWorking: platformGetLive.status === 200 && ping[LIVE_ORIGIN]?.status === 200,
    },
    matchesExpectedPlatform: fingerprint(platformId) === '36b79957…47bb'
      || String(platformId).toLowerCase().startsWith('36b79957'),
  };
};

const probeKeyManagement = async (staging, identify) => {
  const s = staging.parsed;
  const platformId = s.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID;
  const appId = identify.jwtSafe?.accountID
    ? null
    : null;
  const accountIds = [platformId, identify.jwtAccountFp && platformId].filter(Boolean);
  const getPaths = [
    '/keys',
    '/api-keys',
    '/applications',
    '/credentials',
    '/developer/keys',
    '/developer/api-keys',
    '/facilitator/keys',
    `/accounts/${platformId}/keys`,
    `/accounts/${platformId}/api-keys`,
    `/accounts/${platformId}/applications`,
  ];
  const probes = [];
  const found = [];
  const ingest = (path, auth, scope, payload) => {
    const rows = Array.isArray(payload) ? payload
      : Array.isArray(payload?.keys) ? payload.keys
        : Array.isArray(payload?.apiKeys) ? payload.apiKeys
          : payload && looksLikeKeyRecord(payload, s.MOOV_SANDBOX_PUBLIC_KEY) ? [payload]
            : [];
    for (const row of rows) {
      if (looksLikeKeyRecord(row, s.MOOV_SANDBOX_PUBLIC_KEY)) {
        found.push({
          path,
          auth,
          scope: scope || null,
          summary: summarizeKeyRecord(row, s.MOOV_SANDBOX_PUBLIC_KEY),
          rawKeys: Object.keys(row).sort(),
        });
      }
    }
  };
  for (const path of getPaths) {
    const basic = await moovCall({
      publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
      secretKey: s.MOOV_SANDBOX_SECRET_KEY,
      origin: STAGING_ORIGIN,
      apiVersion: PROVEN_API_VERSION,
      path,
    });
    probes.push({ auth: 'basic', path, status: basic.status, error: basic.error, bodyLen: basic.bodyLen });
    ingest(path, 'basic', null, basic.json);
  }
  const oauthTargets = [
    { scope: '/keys.read', path: '/keys' },
    { scope: '/applications.read', path: '/applications' },
    { scope: '/accounts.read', path: `/accounts/${platformId}/keys` },
  ];
  for (const target of oauthTargets) {
    const oauth = await moovOauth({
      publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
      secretKey: s.MOOV_SANDBOX_SECRET_KEY,
      origin: STAGING_ORIGIN,
      scopes: [target.scope],
    });
    if (!oauth.ok) {
      probes.push({ auth: 'oauth', scope: target.scope, path: target.path, oauthStatus: oauth.status, skipped: true });
      continue;
    }
    const row = await moovCall({
      token: oauth.token,
      origin: STAGING_ORIGIN,
      apiVersion: PROVEN_API_VERSION,
      path: target.path,
    });
    probes.push({
      auth: 'oauth',
      scope: target.scope,
      path: target.path,
      oauthStatus: oauth.status,
      status: row.status,
      error: row.error,
      bodyLen: row.bodyLen,
    });
    ingest(target.path, 'oauth', target.scope, row.json);
  }
  void appId;
  void accountIds;
  return {
    programmaticListAvailable: found.length > 0,
    found: found.map((row) => ({
      path: row.path,
      auth: row.auth,
      scope: row.scope || null,
      summary: {
        ...row.summary,
        id: undefined,
      },
      keyId: row.summary.id || null,
      rawKeys: row.rawKeys,
    })),
    probeStatuses: probes.map((row) => ({
      auth: row.auth,
      path: row.path,
      scope: row.scope || null,
      status: row.status || null,
      oauthStatus: row.oauthStatus || null,
      skipped: row.skipped || false,
      error: row.error || null,
    })),
  };
};

const tryAddLiveOrigin = async (staging, keyProbe) => {
  if (!keyProbe.programmaticListAvailable) {
    return {
      ok: false,
      mutated: false,
      stopped: 'moov_api_key_origin_requires_dashboard',
      operatorAction: OPERATOR_ACTION,
      reason: 'Moov does not expose a usable API-key list/update endpoint to this sandbox principal. Domains are dashboard-managed.',
    };
  }
  const match = keyProbe.found.find((row) => row.summary.publicKeyMatch !== false && (row.summary.hasStaging || row.summary.domains.length));
  if (!match?.keyId) {
    return {
      ok: false,
      mutated: false,
      stopped: 'sandbox_api_key_record_incomplete',
      operatorAction: OPERATOR_ACTION,
      identified: match?.summary || null,
    };
  }
  const current = (match.summary.domains || []).slice();
  if (!current.includes(STAGING_ORIGIN)) current.push(STAGING_ORIGIN);
  if (!current.includes(LIVE_ORIGIN)) current.push(LIVE_ORIGIN);
  const field = match.summary.domainField || 'domains';
  const body = { [field]: current };
  const patchPath = match.path.endsWith(String(match.keyId))
    ? match.path
    : `${match.path.replace(/\/$/, '')}/${match.keyId}`;
  const patched = await moovCall({
    publicKey: staging.parsed.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: staging.parsed.MOOV_SANDBOX_SECRET_KEY,
    origin: STAGING_ORIGIN,
    apiVersion: PROVEN_API_VERSION,
    path: patchPath,
    method: 'PATCH',
    body,
  });
  if (!patched.ok) {
    const put = await moovCall({
      publicKey: staging.parsed.MOOV_SANDBOX_PUBLIC_KEY,
      secretKey: staging.parsed.MOOV_SANDBOX_SECRET_KEY,
      origin: STAGING_ORIGIN,
      apiVersion: PROVEN_API_VERSION,
      path: patchPath,
      method: 'PUT',
      body,
    });
    if (!put.ok) {
      return {
        ok: false,
        mutated: false,
        stopped: 'moov_api_key_origin_requires_dashboard',
        operatorAction: OPERATOR_ACTION,
        patchStatus: patched.status,
        putStatus: put.status,
        patchError: patched.error,
        putError: put.error,
        path: patchPath,
      };
    }
    return {
      ok: true,
      mutated: true,
      method: 'PUT',
      path: patchPath,
      status: put.status,
      domainsAfter: [...collectOrigins(put.json)].length ? [...collectOrigins(put.json)] : current,
      stagingOriginPreserved: true,
    };
  }
  return {
    ok: true,
    mutated: true,
    method: 'PATCH',
    path: patchPath,
    status: patched.status,
    domainsAfter: [...collectOrigins(patched.json)].length ? [...collectOrigins(patched.json)] : current,
    stagingOriginPreserved: true,
  };
};

const proveLiveOrigin = async (staging) => {
  const s = staging.parsed;
  const platformId = s.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID;
  const oauth = await moovOauth({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: LIVE_ORIGIN,
    scopes: ['/accounts.read'],
  });
  const profile = await moovOauth({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: LIVE_ORIGIN,
    scopes: [`/accounts/${platformId}/profile.read`, `/accounts/${platformId}/capabilities.read`],
  });
  const platformGet = profile.ok ? await moovCall({
    token: profile.token,
    origin: LIVE_ORIGIN,
    apiVersion: PROVEN_API_VERSION,
    path: `/accounts/${platformId}`,
  }) : { ok: false, status: profile.status, json: null };
  const capsGet = profile.ok ? await moovCall({
    token: profile.token,
    origin: LIVE_ORIGIN,
    apiVersion: PROVEN_API_VERSION,
    path: `/accounts/${platformId}/capabilities`,
  }) : { ok: false, status: profile.status, json: null };
  const pingOauth = await moovOauth({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: LIVE_ORIGIN,
    scopes: ['/ping.read'],
  });
  const pingLive = pingOauth.ok ? await moovCall({
    token: pingOauth.token,
    origin: LIVE_ORIGIN,
    apiVersion: PROVEN_API_VERSION,
    path: '/ping',
  }) : { ok: false, status: pingOauth.status };
  const pingStaging = pingOauth.ok ? await moovCall({
    token: pingOauth.token,
    origin: STAGING_ORIGIN,
    apiVersion: PROVEN_API_VERSION,
    path: '/ping',
  }) : { ok: false, status: pingOauth.status };
  const freedomOauth = await moovOauth({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: LIVE_ORIGIN,
    scopes: [`/accounts/${FREEDOM_MOOV}/profile.read`],
  });
  const freedomGet = freedomOauth.ok ? await moovCall({
    token: freedomOauth.token,
    origin: LIVE_ORIGIN,
    apiVersion: PROVEN_API_VERSION,
    path: `/accounts/${FREEDOM_MOOV}`,
  }) : { ok: false, status: freedomOauth.status, json: null };
  const prodOauth = await moovOauth({
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    origin: LIVE_ORIGIN,
    scopes: [`/accounts/${PRODUCTION_PLATFORM}/profile.read`],
  });
  const prodGet = prodOauth.ok ? await moovCall({
    token: prodOauth.token,
    origin: LIVE_ORIGIN,
    apiVersion: PROVEN_API_VERSION,
    path: `/accounts/${PRODUCTION_PLATFORM}`,
  }) : { ok: false, status: prodOauth.status, json: null };
  const platformSafe = accountSafe(platformGet.json);
  const leaked = freedomGet.ok === true || prodGet.ok === true || platformSafe?.isProductionId === true;
  const ok = oauth.ok
    && platformGet.status === 200
    && platformSafe?.mode === 'sandbox'
    && platformSafe?.looksLikeChecksOps
    && !leaked
    && pingLive.status === 200;
  return {
    ok,
    oauth: { ok: oauth.ok, status: oauth.status },
    platformGet: { status: platformGet.status, account: platformSafe, capabilitiesStatus: capsGet.status },
    ping: { live: pingLive.status, staging: pingStaging.status },
    productionAccountGets: {
      freedomOauthStatus: freedomOauth.status,
      freedomGetStatus: freedomGet.status,
      productionPlatformOauthStatus: prodOauth.status,
      productionPlatformGetStatus: prodGet.status,
      visible: leaked,
    },
    productionAccountLeaked: leaked,
    transferPost: false,
    providerMutation: false,
  };
};

const inspectWebhooks = async (staging, origin, productionWebhookSecret) => {
  const s = staging.parsed;
  const platformId = s.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID;
  const paths = [
    '/webhooks',
    `/accounts/${platformId}/webhooks`,
  ];
  const attempts = [];
  let rows = [];
  for (const path of paths) {
    const basic = await moovCall({
      publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
      secretKey: s.MOOV_SANDBOX_SECRET_KEY,
      origin,
      apiVersion: PROVEN_API_VERSION,
      path,
    });
    attempts.push({ auth: 'basic', path, status: basic.status, error: basic.error, bodyLen: basic.bodyLen });
    const listed = Array.isArray(basic.json) ? basic.json
      : Array.isArray(basic.json?.webhooks) ? basic.json.webhooks
        : [];
    if (listed.length) rows = listed;
    for (const scope of ['/webhooks.read', `/accounts/${platformId}/webhooks.read`]) {
      const oauth = await moovOauth({
        publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
        secretKey: s.MOOV_SANDBOX_SECRET_KEY,
        origin,
        scopes: [scope],
      });
      if (!oauth.ok) {
        attempts.push({ auth: 'oauth', scope, path, oauthStatus: oauth.status, skipped: true });
        continue;
      }
      const row = await moovCall({
        token: oauth.token,
        origin,
        apiVersion: PROVEN_API_VERSION,
        path,
        extraHeaders: { 'X-Account-ID': platformId },
      });
      attempts.push({
        auth: 'oauth',
        scope,
        path,
        oauthStatus: oauth.status,
        status: row.status,
        error: row.error,
        bodyLen: row.bodyLen,
      });
      const more = Array.isArray(row.json) ? row.json
        : Array.isArray(row.json?.webhooks) ? row.json.webhooks
          : [];
      if (more.length) rows = more;
    }
  }
  const checksOpsWebhook = (url) => {
    try {
      const parsed = new URL(String(url || ''));
      const host = parsed.hostname.toLowerCase();
      return ['checksops.com', 'staging.checksops.com', 'www.checksops.com'].includes(host)
        && /webhooks\/moov\/?$/i.test(parsed.pathname);
    } catch {
      return false;
    }
  };
  const parsedRows = rows.map((row) => {
    const id = row.webhookID || row.webhookId || row.id || row.foreignID || null;
    const url = row.url || row.endpoint || null;
    const disabled = row.disabled === true || String(row.status || '').toLowerCase() === 'disabled';
    return {
      id,
      idFp: fingerprint(id),
      url,
      disabled,
      status: row.status || (disabled ? 'disabled' : 'enabled'),
      events: row.events || row.eventTypes || row.subscribedEvents || null,
      description: row.description || null,
      fieldNames: Object.keys(row || {}).sort(),
      isChecksOps: checksOpsWebhook(url),
      isPrepUrl: String(url || '').replace(/\/$/, '') === PREFERRED_WEBHOOK_URL.replace(/\/$/, ''),
    };
  });
  const matching = parsedRows.filter((row) => row.isPrepUrl);
  const enabledChecksOps = parsedRows.filter((row) => row.isChecksOps && row.disabled !== true);
  const chosen = matching.find((row) => row.disabled !== true) || enabledChecksOps[0] || null;
  let secretMatch = null;
  if (chosen?.id && present(s.MOOV_SANDBOX_WEBHOOK_SECRET)) {
    const secretGet = await moovCall({
      publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
      secretKey: s.MOOV_SANDBOX_SECRET_KEY,
      origin,
      apiVersion: PROVEN_API_VERSION,
      path: `/webhooks/${chosen.id}/secret`,
    });
    const remote = secretGet.json?.secret || secretGet.json?.webhookSecret || secretGet.json?.signingSecret || null;
    if (present(remote) && present(productionWebhookSecret) && remote === productionWebhookSecret) {
      sandboxWebhookSecretForInstall = null;
      secretMatch = {
        status: secretGet.status,
        match: false,
        compared: true,
        equalsProduction: true,
        remoteLength: remote.length,
        stagingLength: String(s.MOOV_SANDBOX_WEBHOOK_SECRET || '').length,
      };
    } else {
      sandboxWebhookSecretForInstall = present(remote) ? remote : null;
      secretMatch = {
        status: secretGet.status,
        match: present(remote) ? remote === s.MOOV_SANDBOX_WEBHOOK_SECRET : null,
        compared: Boolean(present(remote)),
        equalsProduction: false,
        remoteLength: present(remote) ? remote.length : null,
        stagingLength: String(s.MOOV_SANDBOX_WEBHOOK_SECRET || '').length,
        installSource: present(remote) && remote === s.MOOV_SANDBOX_WEBHOOK_SECRET
          ? 'staging_secret'
          : (present(remote) ? 'existing_webhook_secret' : null),
      };
    }
  }
  const listed = attempts.some((row) => row.status === 200);
  const reusable = Boolean(chosen)
    && chosen.disabled !== true
    && chosen.isChecksOps
    && present(sandboxWebhookSecretForInstall)
    && secretMatch?.equalsProduction !== true;
  const summary = parsedRows.map((row) => ({
    idFp: row.idFp,
    url: row.url,
    disabled: row.disabled,
    status: row.status,
    events: row.events,
    description: row.description,
    fieldNames: row.fieldNames,
    isChecksOps: row.isChecksOps,
    isPrepUrl: row.isPrepUrl,
  }));
  return {
    listed,
    attempts,
    count: summary.length,
    rows: summary,
    matchingPrepUrl: matching.map((row) => ({ idFp: row.idFp, url: row.url, disabled: row.disabled })),
    chosen: chosen ? { idFp: chosen.idFp, url: chosen.url, disabled: chosen.disabled, events: chosen.events } : null,
    reusable,
    secretMatch,
    stopped: listed
      ? (reusable ? null : (secretMatch?.equalsProduction
        ? 'sandbox_webhook_secret_equals_production'
        : (enabledChecksOps.length && !present(sandboxWebhookSecretForInstall)
          ? 'sandbox_webhook_secret_unproven'
          : (summary.length ? 'no_enabled_checksops_sandbox_webhook' : 'no_valid_sandbox_webhook'))))
      : 'sandbox_webhook_list_failed',
  };
};

const installSandbox = (staging, production) => {
  const before = { ...production.parsed };
  const beforeHashes = Object.fromEntries(Object.keys(before).sort().map((key) => [key, sha256(before[key])]));
  const next = { ...before };
  const webhookSecret = sandboxWebhookSecretForInstall || staging.parsed.MOOV_SANDBOX_WEBHOOK_SECRET;
  next.MOOV_SANDBOX_PUBLIC_KEY = staging.parsed.MOOV_SANDBOX_PUBLIC_KEY;
  next.MOOV_SANDBOX_SECRET_KEY = staging.parsed.MOOV_SANDBOX_SECRET_KEY;
  next.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID = staging.parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID;
  next.MOOV_SANDBOX_WEBHOOK_SECRET = webhookSecret;
  next.MOOV_SANDBOX_ALLOWED_ORIGIN = LIVE_ORIGIN;
  next.MOOV_SANDBOX_API_VERSION = PROVEN_API_VERSION;
  for (const key of PRODUCTION_PRESERVE) {
    if (present(before[key]) && next[key] !== before[key]) {
      return { ok: false, error: `refused_overwrite_${key}` };
    }
  }
  if (next.MOOV_SANDBOX_PUBLIC_KEY === next.MOOV_PUBLIC_KEY) {
    return { ok: false, error: 'refused_copy_production_public' };
  }
  if (next.MOOV_SANDBOX_SECRET_KEY === next.MOOV_SECRET_KEY) {
    return { ok: false, error: 'refused_copy_production_secret' };
  }
  if (present(next.MOOV_WEBHOOK_SECRET) && next.MOOV_SANDBOX_WEBHOOK_SECRET === next.MOOV_WEBHOOK_SECRET) {
    return { ok: false, error: 'refused_copy_production_webhook' };
  }
  const tmp = '/tmp/m79b-production-provider.json';
  fs.writeFileSync(tmp, JSON.stringify(next));
  awsJson(['secretsmanager', 'put-secret-value', '--secret-id', PRODUCTION_SECRET, '--secret-string', `file://${tmp}`]);
  fs.rmSync(tmp, { force: true });
  const after = loadSecret(PRODUCTION_SECRET);
  const afterHashes = Object.fromEntries(Object.keys(after.parsed).sort().map((key) => [key, sha256(after.parsed[key])]));
  const preserved = PRODUCTION_PRESERVE.filter((key) => present(before[key])).every((key) => beforeHashes[key] === afterHashes[key]);
  const added = {};
  for (const key of SANDBOX_KEYS) added[key] = configured(after.parsed, key);
  return {
    ok: preserved && SANDBOX_KEYS.every((key) => added[key] === 'CONFIGURED'),
    preserved,
    added,
    productionKeyCountBefore: Object.keys(before).length,
    productionKeyCountAfter: Object.keys(after.parsed).length,
    originWritten: originHost(after.parsed.MOOV_SANDBOX_ALLOWED_ORIGIN),
    apiVersionWritten: present(after.parsed.MOOV_SANDBOX_API_VERSION) ? after.parsed.MOOV_SANDBOX_API_VERSION : null,
    webhookSecretSource: sandboxWebhookSecretForInstall
      && sandboxWebhookSecretForInstall !== staging.parsed.MOOV_SANDBOX_WEBHOOK_SECRET
      ? 'existing_webhook_secret'
      : 'staging_secret',
    webhookSecretLength: present(after.parsed.MOOV_SANDBOX_WEBHOOK_SECRET) ? after.parsed.MOOV_SANDBOX_WEBHOOK_SECRET.length : 0,
    extraKeysUnchanged: Object.keys(before).filter((key) => !SANDBOX_KEYS.includes(key)).every((key) => beforeHashes[key] === afterHashes[key]),
  };
};

const recycleLambda = () => {
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  const envBefore = JSON.stringify(before.Environment?.Variables || {});
  run(AWS, [
    '--region', REGION, 'lambda', 'update-function-configuration',
    '--function-name', API_FN,
    '--description', `m79b sandbox origin activation ${new Date().toISOString()}`,
  ]);
  waitFn(API_FN);
  const after = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  return {
    envUnchanged: JSON.stringify(after.Environment?.Variables || {}) === envBefore,
    codeShaUnchanged: after.CodeSha256 === before.CodeSha256,
    lastUpdateStatus: after.LastUpdateStatus,
    POST_FLAG: after.Environment?.Variables?.AWS_MOOV_TRANSFER_POST_ENABLED || null,
    SANDBOX_POST_FLAG: after.Environment?.Variables?.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
  };
};

const signedWebhookProbe = async (secrets, environment, accountId) => {
  const secret = environment === 'sandbox' ? secrets.MOOV_SANDBOX_WEBHOOK_SECRET : secrets.MOOV_WEBHOOK_SECRET;
  if (!present(secret)) return { environment, skipped: 'secret_missing' };
  const ts = Math.floor(Date.now() / 1000);
  const nonce = `m79b-${environment}-${Date.now()}`;
  const webhookId = `m79b-${environment}-${Math.random().toString(16).slice(2, 10)}`;
  const body = JSON.stringify({
    eventID: webhookId,
    type: 'account.updated',
    accountID: accountId,
    data: { status: 'updated' },
  });
  const signature = hmacHex(secret, `${ts}|${nonce}|${webhookId}`, 'sha512');
  return probe('/webhooks/moov', 'POST', body, {
    'content-type': 'application/json',
    'x-timestamp': String(ts),
    'x-nonce': nonce,
    'x-webhook-id': webhookId,
    'x-signature': signature,
  });
};

const localWebhookIsolation = (staging, production, webhookBundle) => {
  const sandboxSecret = staging.parsed.MOOV_SANDBOX_WEBHOOK_SECRET;
  const productionSecret = webhookBundle?.parsed?.MOOV_WEBHOOK_SECRET || production.parsed.MOOV_WEBHOOK_SECRET;
  if (!present(sandboxSecret) || !present(productionSecret)) {
    return { ok: false, skipped: 'secret_missing' };
  }
  if (sandboxSecret === productionSecret) {
    return { ok: false, skipped: 'sandbox_and_production_webhook_secrets_equal' };
  }
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = (secret, id) => hmacHex(secret, `${ts}|nonce|${id}`, 'sha512');
  const eventFor = (id, signature) => ({
    headers: {
      'x-timestamp': ts,
      'x-nonce': 'nonce',
      'x-webhook-id': id,
      'x-signature': signature,
    },
  });
  const secrets = {
    MOOV_WEBHOOK_SECRET: productionSecret,
    MOOV_SANDBOX_WEBHOOK_SECRET: sandboxSecret,
  };
  const sandboxOnSandbox = verifyMoovWebhookEnvironment({
    event: eventFor('evt-s', sign(sandboxSecret, 'evt-s')),
    rawBody: JSON.stringify({ eventID: 'evt-s', accountID: staging.parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID }),
    secrets,
  });
  const productionOnFreedom = verifyMoovWebhookEnvironment({
    event: eventFor('evt-p', sign(productionSecret, 'evt-p')),
    rawBody: JSON.stringify({ eventID: 'evt-p', accountID: FREEDOM_MOOV }),
    secrets,
  });
  const sandboxSignedFreedomId = verifyMoovWebhookEnvironment({
    event: eventFor('evt-x', sign(sandboxSecret, 'evt-x')),
    rawBody: JSON.stringify({ eventID: 'evt-x', accountID: FREEDOM_MOOV }),
    secrets,
  });
  const productionSignedSandboxId = verifyMoovWebhookEnvironment({
    event: eventFor('evt-y', sign(productionSecret, 'evt-y')),
    rawBody: JSON.stringify({ eventID: 'evt-y', accountID: staging.parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID }),
    secrets,
  });
  return {
    ok: sandboxOnSandbox.ok
      && sandboxOnSandbox.environment === 'sandbox'
      && productionOnFreedom.ok
      && productionOnFreedom.environment === 'production'
      && sandboxSignedFreedomId.ok
      && sandboxSignedFreedomId.environment === 'sandbox'
      && productionSignedSandboxId.ok
      && productionSignedSandboxId.environment === 'production',
    sandboxSigned: { ok: sandboxOnSandbox.ok, environment: sandboxOnSandbox.environment },
    productionSigned: { ok: productionOnFreedom.ok, environment: productionOnFreedom.environment },
    sandboxSignedProductionAccountId: {
      ok: sandboxSignedFreedomId.ok,
      environment: sandboxSignedFreedomId.environment,
      note: 'signature environment is sandbox even if payload account id is production',
    },
    productionSignedSandboxAccountId: {
      ok: productionSignedSandboxId.ok,
      environment: productionSignedSandboxId.environment,
    },
    secretsDistinct: true,
  };
};

const health = async () => ({
  login: await probe('/auth/login', 'POST', { email: 'nobody@example.com', password: 'invalid' }),
  emailOtp: await probe('/auth/passwordless/start', 'POST', { email: 'nobody@example.com' }),
  passkey: await probe('/auth/passkey/authenticate/start', 'POST', { email: 'nobody@example.com' }),
  financialTotp: await probe('/auth/mfa/status', 'POST', {}),
  webhookUnsigned: await probe('/webhooks/moov', 'POST', { type: 'transfer.updated' }),
  providersStatus: await probe('/providers/status', 'GET'),
});

const liveReadsFromSecret = async (production) => {
  const s = production.parsed;
  const out = {
    sandboxPlatform: null,
    sandboxCannotReadFreedom: null,
    freedomProduction: null,
    productionCannotReadSandboxPlatform: null,
  };
  if (present(s.MOOV_SANDBOX_PUBLIC_KEY) && present(s.MOOV_SANDBOX_SECRET_KEY)) {
    const profile = await moovOauth({
      publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
      secretKey: s.MOOV_SANDBOX_SECRET_KEY,
      origin: LIVE_ORIGIN,
      scopes: [`/accounts/${s.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID}/profile.read`],
    });
    const get = profile.ok ? await moovCall({
      token: profile.token,
      origin: LIVE_ORIGIN,
      apiVersion: s.MOOV_SANDBOX_API_VERSION || PROVEN_API_VERSION,
      path: `/accounts/${s.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID}`,
    }) : { ok: false, status: profile.status, json: null };
    const freedomOauth = await moovOauth({
      publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
      secretKey: s.MOOV_SANDBOX_SECRET_KEY,
      origin: LIVE_ORIGIN,
      scopes: [`/accounts/${FREEDOM_MOOV}/profile.read`],
    });
    const freedom = freedomOauth.ok ? await moovCall({
      token: freedomOauth.token,
      origin: LIVE_ORIGIN,
      apiVersion: s.MOOV_SANDBOX_API_VERSION || PROVEN_API_VERSION,
      path: `/accounts/${FREEDOM_MOOV}`,
    }) : { ok: false, status: freedomOauth.status, json: null };
    out.sandboxPlatform = { status: get.status, account: accountSafe(get.json) };
    out.sandboxCannotReadFreedom = freedom.ok !== true;
  }
  if (present(s.MOOV_PUBLIC_KEY) && present(s.MOOV_SECRET_KEY)) {
    const prod = await moovOauth({
      publicKey: s.MOOV_PUBLIC_KEY,
      secretKey: s.MOOV_SECRET_KEY,
      origin: LIVE_ORIGIN,
      scopes: [`/accounts/${FREEDOM_MOOV}/profile.read`],
    });
    const freedom = prod.ok ? await moovCall({
      token: prod.token,
      origin: LIVE_ORIGIN,
      apiVersion: PROVEN_API_VERSION,
      path: `/accounts/${FREEDOM_MOOV}`,
    }) : { ok: false, status: prod.status, json: null };
    const sand = await moovOauth({
      publicKey: s.MOOV_PUBLIC_KEY,
      secretKey: s.MOOV_SECRET_KEY,
      origin: LIVE_ORIGIN,
      scopes: [`/accounts/${s.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID}/profile.read`],
    });
    const sandGet = sand.ok ? await moovCall({
      token: sand.token,
      origin: LIVE_ORIGIN,
      apiVersion: PROVEN_API_VERSION,
      path: `/accounts/${s.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID}`,
    }) : { ok: false, status: sand.status, json: null };
    out.freedomProduction = { status: freedom.status, account: accountSafe(freedom.json) };
    out.productionCannotReadSandboxPlatform = sandGet.ok !== true;
  }
  return out;
};

const main = async () => {
  const step = process.argv[2] || 'all';
  const identity = await assumeRole();
  const flags = lambdaFlags();
  const staging = loadSecret(STAGING_SECRET);
  const production = loadSecret(flags.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
  let webhookBundle = null;
  if (flags.MOOV_WEBHOOK_SECRET_ARN) {
    try { webhookBundle = loadSecret(flags.MOOV_WEBHOOK_SECRET_ARN); }
    catch { webhookBundle = null; }
  }
  const inspect = inspectPhase(staging, production, webhookBundle);
  const report = {
    at: new Date().toISOString(),
    step,
    identity: { arn: identity.Arn, account: identity.Account },
    flags,
    inspect,
    POST_ARMED: flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true',
    SANDBOX_POST_ARMED: flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true',
  };
  if (inspect.copiedFromProduction) {
    report.stopped = 'staging_sandbox_equals_production';
    fs.writeFileSync('/opt/cursor/artifacts/m79b_identify.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: false, stopped: report.stopped }, null, 2));
    process.exit(2);
  }

  const identify = await identifyKey(staging);
  report.identify = identify;
  const keyProbe = await probeKeyManagement(staging, identify);
  const publicKeyProbe = {
    programmaticListAvailable: keyProbe.programmaticListAvailable,
    found: keyProbe.found.map((row) => ({
      path: row.path,
      auth: row.auth,
      scope: row.scope || null,
      summary: row.summary,
      rawKeys: row.rawKeys,
    })),
    probeStatuses: keyProbe.probeStatuses,
  };
  report.keyProbe = publicKeyProbe;
  fs.writeFileSync('/opt/cursor/artifacts/m79b_identify.json', JSON.stringify(report, null, 2));
  if (step === 'identify') {
    console.log(JSON.stringify({
      ok: identify.originBefore.stagingAccepted && identify.matchesExpectedPlatform,
      identify,
      keyProbe: {
        programmaticListAvailable: keyProbe.programmaticListAvailable,
        found: keyProbe.found.map((row) => ({
          path: row.path,
          auth: row.auth,
          scope: row.scope,
          summary: row.summary,
          rawKeys: row.rawKeys,
        })),
        probeStatuses: keyProbe.probeStatuses.slice(0, 40),
      },
    }, null, 2));
    return;
  }

  const originUpdate = identify.originBefore.liveAccepted
    ? {
      ok: true,
      mutated: false,
      alreadyPresent: true,
      stagingOriginPreserved: identify.originBefore.stagingAccepted,
    }
    : await tryAddLiveOrigin(staging, keyProbe);
  report.originUpdate = originUpdate;
  fs.writeFileSync('/opt/cursor/artifacts/m79b_origin.json', JSON.stringify(report, null, 2));
  if (!originUpdate.ok && !identify.originBefore.liveAccepted) {
    report.stopped = originUpdate.stopped || 'moov_api_key_origin_requires_dashboard';
    report.operatorAction = originUpdate.operatorAction || OPERATOR_ACTION;
    report.health = await health();
    report.webhookIsolationLocal = localWebhookIsolation(staging, production, webhookBundle);
    fs.writeFileSync('/opt/cursor/artifacts/m79b_return_card.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      ok: false,
      stopped: report.stopped,
      operatorAction: report.operatorAction,
      identify: {
        publicKeyFp: identify.publicKeyFp,
        platformFp: identify.platformFp,
        jwtAccountFp: identify.jwtAccountFp,
        jwtSafe: identify.jwtSafe,
        applications: identify.applications,
        originBefore: identify.originBefore,
        platformGetStaging: identify.platformGetStaging,
        platformGetLiveBefore: identify.platformGetLiveBefore,
        platformGetWww: identify.platformGetWww,
      },
      keyProbe: {
        programmaticListAvailable: keyProbe.programmaticListAvailable,
        found: keyProbe.found,
        uniqueStatuses: [...new Set(keyProbe.probeStatuses.map((row) => `${row.auth}:${row.path}:${row.status || row.oauthStatus}`))],
      },
      originUpdate,
      health: report.health,
      webhookIsolationLocal: report.webhookIsolationLocal,
      POST_ARMED: report.POST_ARMED,
      SANDBOX_POST_ARMED: report.SANDBOX_POST_ARMED,
    }, null, 2));
    process.exit(2);
  }

  const prove = await proveLiveOrigin(staging);
  report.prove = prove;
  fs.writeFileSync('/opt/cursor/artifacts/m79b_prove.json', JSON.stringify(report, null, 2));
  if (!prove.ok) {
    report.stopped = prove.productionAccountLeaked
      ? 'production_account_leaked_into_sandbox'
      : 'live_origin_sandbox_get_failed';
    report.health = await health();
    fs.writeFileSync('/opt/cursor/artifacts/m79b_return_card.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: false, stopped: report.stopped, prove, health: report.health }, null, 2));
    process.exit(2);
  }

  const webhooks = await inspectWebhooks(
    staging,
    LIVE_ORIGIN,
    webhookBundle?.parsed?.MOOV_WEBHOOK_SECRET || production.parsed.MOOV_WEBHOOK_SECRET,
  );
  report.webhooks = webhooks;
  fs.writeFileSync('/opt/cursor/artifacts/m79b_webhooks.json', JSON.stringify(report, null, 2));
  if (webhooks.stopped) {
    report.stopped = webhooks.stopped;
    report.health = await health();
    report.webhookIsolationLocal = localWebhookIsolation(staging, production, webhookBundle);
    fs.writeFileSync('/opt/cursor/artifacts/m79b_return_card.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      ok: false,
      stopped: report.stopped,
      prove,
      webhooks: {
        listed: webhooks.listed,
        count: webhooks.count,
        rows: webhooks.rows,
        matchingPrepUrl: webhooks.matchingPrepUrl,
        chosen: webhooks.chosen,
        secretMatch: webhooks.secretMatch,
        attempts: webhooks.attempts,
      },
      health: report.health,
      webhookIsolationLocal: report.webhookIsolationLocal,
    }, null, 2));
    process.exit(2);
  }

  if (step === 'prove') {
    console.log(JSON.stringify({ ok: true, prove, webhooks: report.webhooks }, null, 2));
    return;
  }

  report.install = installSandbox(staging, production);
  if (!report.install.ok) {
    report.stopped = report.install.error || 'install_failed';
    fs.writeFileSync('/opt/cursor/artifacts/m79b_install.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: false, stopped: report.stopped, install: report.install }, null, 2));
    process.exit(2);
  }
  report.recycle = recycleLambda();
  const after = loadSecret(flags.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
  report.liveReads = await liveReadsFromSecret(after);
  report.tenant = invokeOneshot({ step: 'verify', tenantId: PIPELINE });
  report.health = await health();
  report.webhookIsolationLocal = localWebhookIsolation(staging, after, webhookBundle);
  report.signedWebhooks = {
    sandbox: await signedWebhookProbe(after.parsed, 'sandbox', after.parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID),
    production: await signedWebhookProbe({
      ...after.parsed,
      MOOV_WEBHOOK_SECRET: webhookBundle?.parsed?.MOOV_WEBHOOK_SECRET || after.parsed.MOOV_WEBHOOK_SECRET,
    }, 'production', FREEDOM_MOOV),
    sandboxSignedFreedom: await signedWebhookProbe(after.parsed, 'sandbox', FREEDOM_MOOV),
  };
  fs.writeFileSync('/opt/cursor/artifacts/m79b_install.json', JSON.stringify(report, null, 2));
  fs.writeFileSync('/opt/cursor/artifacts/m79b_return_card.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    ok: report.install.ok
      && report.liveReads.sandboxCannotReadFreedom === true
      && report.health?.login?.status !== 500,
    identify: {
      publicKeyFp: identify.publicKeyFp,
      platformFp: identify.platformFp,
      originBefore: identify.originBefore,
    },
    originUpdate,
    prove,
    webhooks: {
      listed: webhooks.listed,
      rows: webhooks.rows,
      matchingPrepUrl: webhooks.matchingPrepUrl,
      secretMatch: webhooks.secretMatch,
    },
    install: report.install,
    recycle: report.recycle,
    liveReads: report.liveReads,
    tenant: report.tenant && {
      ok: report.tenant.ok,
      environment: report.tenant.tenant?.moov_environment,
      freedomEnvironment: report.tenant.freedomEnvironment,
    },
    health: report.health,
    webhookIsolationLocal: report.webhookIsolationLocal,
    signedWebhooks: report.signedWebhooks,
    POST_ARMED: report.POST_ARMED,
    SANDBOX_POST_ARMED: report.SANDBOX_POST_ARMED,
  }, null, 2));
};

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 500) }, null, 2));
  process.exit(1);
});
