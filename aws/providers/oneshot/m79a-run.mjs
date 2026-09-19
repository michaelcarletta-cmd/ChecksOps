#!/usr/bin/env node
/**
 * M7.9A: prove the staging Moov sandbox credential set, then install those
 * names onto checksops/production/provider. Never prints secret values.
 * Never copies production keys. Never arms POST flags. Never mutates Moov.
 */
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';

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
const PROVEN_ORIGIN = PRODUCTION_MOOV_ORIGIN;
const ONESHOT_FN = 'checksops-m79-sql77-b844';

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
    '--role-session-name', 'checksops-m79a-sandbox-creds',
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
    createdPaymentTransfer: json?.createdPaymentTransfer === true,
    liveProviderPosted: json?.liveProviderPosted === true,
    applied: json?.applied === true,
  };
};

const moovOauth = async ({ publicKey, secretKey, origin, scopes }) => {
  const started = Date.now();
  const res = await fetch('https://api.moov.io/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
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
  let claims = null;
  if (token && String(token).split('.').length === 3) {
    try {
      claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    } catch {
      claims = null;
    }
  }
  return {
    ok: res.ok && Boolean(token),
    status: res.status,
    ms: Date.now() - started,
    tokenType: json?.token_type || null,
    scope: json?.scope || (Array.isArray(claims?.scope) ? claims.scope.join(' ') : claims?.scope) || null,
    accountFp: fingerprint(claims?.accountID || claims?.account_id || claims?.aid),
    origin,
    scopes,
  };
};

const moovGet = async ({ token, origin, apiVersion, path }) => {
  const res = await fetch(`https://api.moov.io${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      Origin: origin,
      'x-moov-version': apiVersion,
    },
  });
  const json = await res.json().catch(() => null);
  return {
    ok: res.ok,
    status: res.status,
    path,
    versionEcho: res.headers.get('x-moov-version') || res.headers.get('X-Moov-Version') || null,
    json,
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
      email: json.profile?.email || json.email || '',
    })),
  };
};

const hmacHex = (secret, payload) => createHmac('sha512', secret).update(payload).digest('hex');

const invokeOneshot = (payload) => {
  const outFile = `/tmp/m79a-oneshot-${payload.step}.json`;
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
  const webhookMeta = webhookSecret ? secretMeta(webhookSecret, ['MOOV_WEBHOOK_SECRET', 'MOOV_SANDBOX_WEBHOOK_SECRET']) : null;
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
      platformIsProductionId: equalsProduction.platformAccount,
    },
    productionPrep: productionMeta,
    webhookSecret: webhookMeta,
    equalsProduction,
    intendedSandboxCandidate: intended,
    copiedFromProduction: Object.values(equalsProduction).some(Boolean),
  };
};

const proveSandbox = async (staging, production) => {
  const s = staging.parsed;
  const p = production.parsed;
  const originCandidates = [...new Set([
    PROVEN_ORIGIN,
    originHost(s.MOOV_SANDBOX_ALLOWED_ORIGIN),
  ].filter(Boolean))];
  const oauthByOrigin = [];
  for (const origin of originCandidates) {
    oauthByOrigin.push(await moovOauth({
      publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
      secretKey: s.MOOV_SANDBOX_SECRET_KEY,
      origin,
      scopes: ['/accounts.read'],
    }));
  }
  const oauth = oauthByOrigin.find((row) => row.ok) || oauthByOrigin[0];
  const checksopsOriginOauth = oauthByOrigin.find((row) => row.origin === PROVEN_ORIGIN) || null;
  if (!oauth?.ok) {
    return {
      ok: false,
      stopped: 'sandbox_oauth_failed',
      oauthByOrigin,
      transferPost: false,
      providerMutation: false,
    };
  }
  const tokenRes = await fetch('https://api.moov.io/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${s.MOOV_SANDBOX_PUBLIC_KEY}:${s.MOOV_SANDBOX_SECRET_KEY}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: oauth.origin,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: '/accounts.read /webhooks.read' }),
  });
  const tokenJson = await tokenRes.json().catch(() => null);
  const token = tokenJson?.access_token;
  const webhookOauthOk = tokenRes.ok && Boolean(token);
  const getToken = webhookOauthOk ? token : (await fetch('https://api.moov.io/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${s.MOOV_SANDBOX_PUBLIC_KEY}:${s.MOOV_SANDBOX_SECRET_KEY}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: oauth.origin,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: '/accounts.read' }),
  }).then((res) => res.json())).access_token;

  const platformGet = await moovGet({
    token: getToken,
    origin: oauth.origin,
    apiVersion: PROVEN_API_VERSION,
    path: `/accounts/${s.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID}`,
  });
  const freedomGet = await moovGet({
    token: getToken,
    origin: oauth.origin,
    apiVersion: PROVEN_API_VERSION,
    path: `/accounts/${FREEDOM_MOOV}`,
  });
  const productionPlatformGet = await moovGet({
    token: getToken,
    origin: oauth.origin,
    apiVersion: PROVEN_API_VERSION,
    path: `/accounts/${PRODUCTION_PLATFORM}`,
  });
  const listGet = await moovGet({
    token: getToken,
    origin: oauth.origin,
    apiVersion: PROVEN_API_VERSION,
    path: '/accounts',
  });
  const listed = Array.isArray(listGet.json) ? listGet.json
    : Array.isArray(listGet.json?.accounts) ? listGet.json.accounts
      : [];
  const listedIds = listed.map((row) => String(row.accountID || row.accountId || '').toLowerCase()).filter(Boolean);
  const productionLeak = listedIds.some((id) => PRODUCTION_IDS.has(id))
    || (freedomGet.ok === true)
    || (productionPlatformGet.ok === true)
    || (accountSafe(platformGet.json)?.isProductionId === true);

  const webhooks = await moovGet({
    token: getToken,
    origin: oauth.origin,
    apiVersion: PROVEN_API_VERSION,
    path: '/webhooks',
  });
  const webhookRows = Array.isArray(webhooks.json) ? webhooks.json
    : Array.isArray(webhooks.json?.webhooks) ? webhooks.json.webhooks
      : [];
  const webhookSummary = webhookRows.map((row) => ({
    idFp: fingerprint(row.webhookID || row.webhookId || row.id),
    url: row.url || row.endpoint || null,
    disabled: row.disabled === true || String(row.status || '').toLowerCase() === 'disabled',
    events: row.events || row.eventTypes || row.subscribedEvents || null,
  }));
  const preferredUrl = 'https://checksops.com/prep/webhooks/moov';
  const matching = webhookSummary.filter((row) => String(row.url || '').replace(/\/$/, '') === preferredUrl.replace(/\/$/, ''));
  let secretMatch = null;
  if (matching[0]?.idFp && present(s.MOOV_SANDBOX_WEBHOOK_SECRET)) {
    const full = webhookRows.find((row) => fingerprint(row.webhookID || row.webhookId || row.id) === matching[0].idFp);
    const webhookId = full?.webhookID || full?.webhookId || full?.id;
    if (webhookId) {
      const secretGet = await moovGet({
        token: getToken,
        origin: oauth.origin,
        apiVersion: PROVEN_API_VERSION,
        path: `/webhooks/${webhookId}/secret`,
      });
      const remote = secretGet.json?.secret || secretGet.json?.webhookSecret || secretGet.json?.signingSecret || null;
      secretMatch = {
        status: secretGet.status,
        match: present(remote) ? remote === s.MOOV_SANDBOX_WEBHOOK_SECRET : null,
      };
    }
  }

  const platformSafe = accountSafe(platformGet.json);
  const intended = oauth.ok
    && platformGet.ok
    && platformSafe
    && !platformSafe.isProductionId
    && !productionLeak
    && checksopsOriginOauth?.ok === true;

  return {
    ok: intended,
    oauthByOrigin,
    checksopsOriginWorks: checksopsOriginOauth?.ok === true,
    chosenOrigin: oauth.origin,
    apiVersionUsed: PROVEN_API_VERSION,
    platformGet: {
      status: platformGet.status,
      versionEcho: platformGet.versionEcho,
      account: platformSafe,
    },
    productionAccountGets: {
      freedomStatus: freedomGet.status,
      productionPlatformStatus: productionPlatformGet.status,
      visible: freedomGet.ok || productionPlatformGet.ok,
    },
    listedAccountCount: listedIds.length,
    listedProductionIds: listedIds.filter((id) => PRODUCTION_IDS.has(id)).length,
    productionAccountLeaked: productionLeak,
    webhooks: {
      listStatus: webhooks.status,
      count: webhookSummary.length,
      rows: webhookSummary,
      matchingPrepUrl: matching,
      secretMatch,
    },
    transferPost: false,
    providerMutation: false,
    stopped: intended ? null : (productionLeak ? 'production_account_leaked_into_sandbox' : 'sandbox_identity_not_proven'),
  };
};

const installSandbox = (staging, production, prove) => {
  if (!prove.ok) return { ok: false, skipped: prove.stopped || 'prove_failed' };
  const before = { ...production.parsed };
  const beforeHashes = Object.fromEntries(Object.keys(before).sort().map((key) => [key, sha256(before[key])]));
  const next = { ...before };
  next.MOOV_SANDBOX_PUBLIC_KEY = staging.parsed.MOOV_SANDBOX_PUBLIC_KEY;
  next.MOOV_SANDBOX_SECRET_KEY = staging.parsed.MOOV_SANDBOX_SECRET_KEY;
  next.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID = staging.parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID;
  next.MOOV_SANDBOX_WEBHOOK_SECRET = staging.parsed.MOOV_SANDBOX_WEBHOOK_SECRET;
  next.MOOV_SANDBOX_ALLOWED_ORIGIN = PROVEN_ORIGIN;
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
  const tmp = '/tmp/m79a-production-provider.json';
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
    extraKeysUnchanged: Object.keys(before).filter((key) => !SANDBOX_KEYS.includes(key)).every((key) => beforeHashes[key] === afterHashes[key]),
  };
};

const recycleLambda = () => {
  const before = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  const envBefore = JSON.stringify(before.Environment?.Variables || {});
  run(AWS, [
    '--region', REGION, 'lambda', 'update-function-configuration',
    '--function-name', API_FN,
    '--description', `m79a sandbox credential activation ${new Date().toISOString()}`,
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

const signedWebhookProbe = async (secrets, environment) => {
  const secret = environment === 'sandbox' ? secrets.MOOV_SANDBOX_WEBHOOK_SECRET : secrets.MOOV_WEBHOOK_SECRET;
  if (!present(secret)) return { environment, skipped: 'secret_missing' };
  const ts = Math.floor(Date.now() / 1000);
  const nonce = `m79a-${environment}`;
  const webhookId = `m79a-${environment}-unknown`;
  const body = JSON.stringify({
    eventID: webhookId,
    type: 'transfer.updated',
    data: { transferID: `00000000-0000-4000-8000-${environment === 'sandbox' ? 'aaaaaaaaaaa1' : 'bbbbbbbbbbb2'}`, status: 'pending' },
  });
  const signature = hmacHex(secret, `${ts}|${nonce}|${webhookId}`);
  return probe('/webhooks/moov', 'POST', body, {
    'content-type': 'application/json',
    'x-timestamp': String(ts),
    'x-nonce': nonce,
    'x-webhook-id': webhookId,
    'x-signature': signature,
  });
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
  fs.writeFileSync('/opt/cursor/artifacts/m79a_inspect.json', JSON.stringify(report, null, 2));
  if (step === 'inspect') {
    console.log(JSON.stringify({ ok: inspect.intendedSandboxCandidate, inspect }, null, 2));
    return;
  }
  if (inspect.copiedFromProduction) {
    report.stopped = 'staging_sandbox_equals_production';
    fs.writeFileSync('/opt/cursor/artifacts/m79a_prove.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: false, stopped: report.stopped, inspect }, null, 2));
    process.exit(2);
  }
  const prove = await proveSandbox(staging, production);
  report.prove = prove;
  fs.writeFileSync('/opt/cursor/artifacts/m79a_prove.json', JSON.stringify(report, null, 2));
  if (step === 'prove' || !prove.ok) {
    console.log(JSON.stringify({
      ok: prove.ok,
      stopped: prove.stopped,
      inspect: {
        staging: inspect.staging,
        intendedSandboxCandidate: inspect.intendedSandboxCandidate,
        copiedFromProduction: inspect.copiedFromProduction,
      },
      prove: {
        oauthByOrigin: prove.oauthByOrigin,
        checksopsOriginWorks: prove.checksopsOriginWorks,
        platformGet: prove.platformGet,
        productionAccountLeaked: prove.productionAccountLeaked,
        productionAccountGets: prove.productionAccountGets,
        webhooks: prove.webhooks,
        apiVersionUsed: prove.apiVersionUsed,
        chosenOrigin: prove.chosenOrigin,
        transferPost: false,
        providerMutation: false,
      },
    }, null, 2));
    if (!prove.ok) process.exit(2);
    return;
  }
  if (step === 'all' || step === 'install') {
    report.install = installSandbox(staging, production, prove);
    if (!report.install.ok) {
      report.stopped = report.install.error || report.install.skipped;
      fs.writeFileSync('/opt/cursor/artifacts/m79a_install.json', JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ ok: false, stopped: report.stopped, install: report.install }, null, 2));
      process.exit(2);
    }
    report.recycle = recycleLambda();
    const after = loadSecret(flags.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
    report.liveReads = {
      sandboxPlatform: null,
      freedomProduction: null,
      sandboxCannotReadFreedom: null,
      productionCannotReadSandboxPlatform: null,
    };
    const sandboxOauth = await moovOauth({
      publicKey: after.parsed.MOOV_SANDBOX_PUBLIC_KEY,
      secretKey: after.parsed.MOOV_SANDBOX_SECRET_KEY,
      origin: PROVEN_ORIGIN,
      scopes: ['/accounts.read'],
    });
    const sandboxToken = sandboxOauth.ok ? (await fetch('https://api.moov.io/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${after.parsed.MOOV_SANDBOX_PUBLIC_KEY}:${after.parsed.MOOV_SANDBOX_SECRET_KEY}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: PROVEN_ORIGIN,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: '/accounts.read' }),
    }).then((res) => res.json())).access_token : null;
    if (sandboxToken) {
      const sandboxGet = await moovGet({
        token: sandboxToken,
        origin: PROVEN_ORIGIN,
        apiVersion: after.parsed.MOOV_SANDBOX_API_VERSION,
        path: `/accounts/${after.parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID}`,
      });
      const sandboxFreedom = await moovGet({
        token: sandboxToken,
        origin: PROVEN_ORIGIN,
        apiVersion: after.parsed.MOOV_SANDBOX_API_VERSION,
        path: `/accounts/${FREEDOM_MOOV}`,
      });
      report.liveReads.sandboxPlatform = { status: sandboxGet.status, account: accountSafe(sandboxGet.json) };
      report.liveReads.sandboxCannotReadFreedom = sandboxFreedom.ok !== true;
    }
    if (present(after.parsed.MOOV_PUBLIC_KEY) && present(after.parsed.MOOV_SECRET_KEY)) {
      const prodOauth = await moovOauth({
        publicKey: after.parsed.MOOV_PUBLIC_KEY,
        secretKey: after.parsed.MOOV_SECRET_KEY,
        origin: PROVEN_ORIGIN,
        scopes: ['/accounts.read'],
      });
      if (prodOauth.ok) {
        const prodToken = (await fetch('https://api.moov.io/oauth2/token', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${after.parsed.MOOV_PUBLIC_KEY}:${after.parsed.MOOV_SECRET_KEY}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: PROVEN_ORIGIN,
          },
          body: new URLSearchParams({ grant_type: 'client_credentials', scope: '/accounts.read' }),
        }).then((res) => res.json())).access_token;
        const freedomGet = await moovGet({
          token: prodToken,
          origin: PROVEN_ORIGIN,
          apiVersion: PROVEN_API_VERSION,
          path: `/accounts/${FREEDOM_MOOV}`,
        });
        const prodSandbox = await moovGet({
          token: prodToken,
          origin: PROVEN_ORIGIN,
          apiVersion: PROVEN_API_VERSION,
          path: `/accounts/${after.parsed.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID}`,
        });
        report.liveReads.freedomProduction = { status: freedomGet.status, account: accountSafe(freedomGet.json) };
        report.liveReads.productionCannotReadSandboxPlatform = prodSandbox.ok !== true;
      }
    }
    report.tenant = invokeOneshot({ step: 'verify', tenantId: PIPELINE });
    report.health = {
      login: await probe('/auth/login', 'POST', { email: 'nobody@example.com', password: 'invalid' }),
      emailOtp: await probe('/auth/passwordless/start', 'POST', { email: 'nobody@example.com' }),
      passkey: await probe('/auth/passkey/authenticate/start', 'POST', { email: 'nobody@example.com' }),
      financialTotp: await probe('/auth/mfa/status', 'POST', {}),
      webhookUnsigned: await probe('/webhooks/moov', 'POST', { type: 'transfer.updated' }),
      providersStatus: await probe('/providers/status', 'GET'),
      moovWalletStatusUnauthed: await probe('/functions/moov-wallet-status', 'POST', { tenant_id: PIPELINE }),
    };
    report.signedWebhooks = {
      sandbox: await signedWebhookProbe(after.parsed, 'sandbox'),
      production: await signedWebhookProbe({
        ...after.parsed,
        MOOV_WEBHOOK_SECRET: webhookBundle?.parsed?.MOOV_WEBHOOK_SECRET || after.parsed.MOOV_WEBHOOK_SECRET,
      }, 'production'),
    };
    fs.writeFileSync('/opt/cursor/artifacts/m79a_install.json', JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({
    ok: report.install?.ok === true
      && report.health?.login?.status !== 500
      && report.liveReads?.sandboxCannotReadFreedom === true,
    inspect: {
      staging: inspect.staging,
      intendedSandboxCandidate: inspect.intendedSandboxCandidate,
      copiedFromProduction: inspect.copiedFromProduction,
    },
    prove: {
      checksopsOriginWorks: prove.checksopsOriginWorks,
      platformGet: prove.platformGet,
      productionAccountLeaked: prove.productionAccountLeaked,
      webhooks: prove.webhooks,
      apiVersionUsed: prove.apiVersionUsed,
      chosenOrigin: prove.chosenOrigin,
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
    signedWebhooks: report.signedWebhooks,
    POST_ARMED: report.POST_ARMED,
    SANDBOX_POST_ARMED: report.SANDBOX_POST_ARMED,
  }, null, 2));
};

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 500) }, null, 2));
  process.exit(1);
});
