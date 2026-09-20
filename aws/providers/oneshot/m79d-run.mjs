#!/usr/bin/env node
/**
 * M7.9D: resolve Pipeline Test sandbox collect-funds / ACH debit funding.
 * Never prints secret values. Never creates duplicate sandbox objects.
 * Never copies production IDs. Never arms POST flags. Never POSTs transfers.
 * Never modifies Freedom or Freedom Sweep.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_APPROVED_MOOV } from '../../functions/api/providers/production/moov-accounts.mjs';
import { PRODUCTION_MOOV_API_VERSION, PRODUCTION_MOOV_ORIGIN } from '../../functions/api/providers/production/moov-secrets.mjs';
import { assertNoCrossEnvironmentObject } from '../../functions/api/providers/moov-environment.mjs';
import { FIRST_PRODUCTION_TRANSFER_CENTS } from '../../functions/api/providers/production/moov-first-test.mjs';
import {
  orchestratePayout,
  payoutOperationIdFor,
} from '../../functions/api/providers/production/moov-payout-orchestrator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const API_FN = 'checksops-production-prep-api';
const ONESHOT_FN = 'checksops-m79-sql77-b844';
const PRODUCTION_SECRET = 'checksops/production/provider';
const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';
const SANDBOX_ACCOUNT = '1d59a6a8-3307-4687-8367-1495293ecc73';
const SANDBOX_WALLET = '58571121-67ea-4e10-abae-6c9680ac455d';
const SANDBOX_BANK = '8390f74b-706e-4d89-80b0-f96bd7c1b414';
const SANDBOX_RECIPIENT = '90050a69-84f3-41bb-aa30-490ca7e7bf34';
const SANDBOX_RECIPIENT_BANK = '92e17650-94ed-43cb-8bff-14cf506c3988';
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const FREEDOM_MOOV = KNOWN_APPROVED_MOOV.freedom.moovAccountId;
const PRODUCTION_PLATFORM = KNOWN_APPROVED_MOOV.platform.moovAccountId;
const MICHAEL = KNOWN_APPROVED_MOOV.recipient.moovAccountId;
const LIVE_ORIGIN = PRODUCTION_MOOV_ORIGIN;
const PROVEN_API_VERSION = PRODUCTION_MOOV_API_VERSION;
const PREFERRED_WEBHOOK_URL = 'https://checksops.com/prep/webhooks/moov';
const TEST_ADDRESS = {
  addressLine1: '123 Main Street',
  city: 'Boulder',
  stateOrProvince: 'CO',
  postalCode: '80301',
  country: 'US',
};
const PRODUCTION_IDS = new Set([
  KNOWN_APPROVED_MOOV.freedom.moovAccountId,
  KNOWN_APPROVED_MOOV.freedom.walletId,
  KNOWN_APPROVED_MOOV.freedom.bankId,
  KNOWN_APPROVED_MOOV.freedom.achDebitFundPm,
  KNOWN_APPROVED_MOOV.freedom.walletPm,
  KNOWN_APPROVED_MOOV.freedom.achCreditStandardPm,
  KNOWN_APPROVED_MOOV.c1c.moovAccountId,
  KNOWN_APPROVED_MOOV.platform.moovAccountId,
  KNOWN_APPROVED_MOOV.recipient.moovAccountId,
  KNOWN_APPROVED_MOOV.recipient.bankId,
  KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm,
  KNOWN_APPROVED_MOOV.recipient.walletPm,
  KNOWN_APPROVED_MOOV.recipient.recipientId,
].map((id) => String(id).toLowerCase()));

const POST_ALLOW = [
  /^\/accounts\/[0-9a-f-]+\/representatives$/,
  /^\/accounts\/[0-9a-f-]+\/underwriting$/,
  /^\/accounts\/[0-9a-f-]+\/capabilities$/,
  /^\/accounts\/[0-9a-f-]+\/capabilities\/[^/]+$/,
];
const PATCH_ALLOW = [
  /^\/accounts\/[0-9a-f-]+$/i,
  /^\/accounts\/[0-9a-f-]+\/underwriting$/i,
  /^\/accounts\/[0-9a-f-]+\/representatives\/[0-9a-f-]+$/i,
];
const PUT_ALLOW = [
  /^\/accounts\/[0-9a-f-]+\/underwriting$/i,
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    '--role-session-name', 'checksops-m79d-collect-funds',
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
const fingerprint = (id) => {
  if (!id) return null;
  const s = String(id);
  if (s.length < 12) return '[id]';
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
};
const isProdId = (id) => PRODUCTION_IDS.has(String(id || '').toLowerCase());
const asList = (json) => {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.accounts)) return json.accounts;
  if (Array.isArray(json?.wallets)) return json.wallets;
  if (Array.isArray(json?.bankAccounts)) return json.bankAccounts;
  if (Array.isArray(json?.paymentMethods)) return json.paymentMethods;
  if (Array.isArray(json?.capabilities)) return json.capabilities;
  if (Array.isArray(json?.representatives)) return json.representatives;
  if (Array.isArray(json?.webhooks)) return json.webhooks;
  if (Array.isArray(json?.files)) return json.files;
  return [];
};
const capName = (row) => String(row?.capability || row?.capabilityID || row?.id || '').toLowerCase();
const capStatus = (row) => String(row?.status || '').toLowerCase();
const pmType = (row) => String(row?.paymentMethodType || row?.type || '').toLowerCase();
const pmIdOf = (row) => row?.paymentMethodID || row?.paymentMethodId || row?.id || null;
const accountIdOf = (row) => row?.accountID || row?.accountId || row?.id || null;
const enabledish = (status) => ['enabled', 'active'].includes(String(status || '').toLowerCase());
const amountCentsOf = (amount) => {
  if (amount === undefined || amount === null) return 0;
  if (typeof amount === 'object') {
    if (amount.valueDecimal !== undefined && amount.valueDecimal !== null) {
      const dollars = Number(amount.valueDecimal);
      return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
    }
    const raw = amount.value ?? amount.amount ?? 0;
    if (typeof raw === 'string' && raw.includes('.')) {
      const dollars = Number(raw);
      return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  if (typeof amount === 'string' && amount.includes('.')) {
    const dollars = Number(amount);
    return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
  }
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const redact = (value) => {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|ssn|ein|taxid|governmentid|password/i.test(key)) {
      out[key] = present(item) || item ? '[redacted]' : item;
    } else {
      out[key] = redact(item);
    }
  }
  return out;
};

const lambdaFlags = () => {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', API_FN]);
  const env = cfg.Environment?.Variables || {};
  return {
    lastModified: cfg.LastModified,
    codeSha256: cfg.CodeSha256,
    state: cfg.State,
    lastUpdateStatus: cfg.LastUpdateStatus,
    flags: {
      AWS_MOOV_TRANSFER_POST_ENABLED: env.AWS_MOOV_TRANSFER_POST_ENABLED || null,
      AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || null,
      AWS_PROVIDER_WEBHOOK_DRY_RUN: env.AWS_PROVIDER_WEBHOOK_DRY_RUN || null,
    },
    PROVIDER_SECRETS_ARN: env.PROVIDER_SECRETS_ARN,
    MOOV_WEBHOOK_SECRET_ARN: env.MOOV_WEBHOOK_SECRET_ARN,
  };
};
const loadSecret = (id) => {
  const raw = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', id]);
  return { parsed: JSON.parse(raw.SecretString || '{}') };
};
const invokeOneshot = (payload) => {
  const outFile = `/tmp/m79d-oneshot-${payload.step}-${Date.now()}.json`;
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
};

const basicAuth = (publicKey, secretKey) => (
  `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`
);
const moovOauth = async ({ publicKey, secretKey, origin, scopes }) => {
  const res = await fetch('https://api.moov.io/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuth(publicKey, secretKey),
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }),
  });
  const json = await res.json().catch(() => null);
  return {
    ok: res.ok && Boolean(json?.access_token),
    status: res.status,
    token: json?.access_token || null,
    error: json?.error || json?.error_description || null,
  };
};
const assertSafeMoovPath = (method, apiPath) => {
  const verb = String(method || 'GET').toUpperCase();
  const p = String(apiPath || '');
  if (/\/transfers(\/|$|\?)/i.test(p)) throw new Error('refused_transfer_path');
  if (verb === 'GET') return;
  if (verb === 'PUT' && PUT_ALLOW.some((re) => re.test(p))) return;
  if (verb === 'PATCH' && PATCH_ALLOW.some((re) => re.test(p))) return;
  if (verb === 'POST' && POST_ALLOW.some((re) => re.test(p))) return;
  throw new Error(`refused_method_${verb}_${p}`);
};
const moovCall = async ({ publicKey, secretKey, token, origin, apiVersion, path: apiPath, method = 'GET', body }) => {
  assertSafeMoovPath(method, apiPath);
  const headers = {
    Accept: 'application/json',
    Origin: origin,
    'x-moov-version': apiVersion,
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  else headers.Authorization = basicAuth(publicKey, secretKey);
  const res = await fetch(`https://api.moov.io${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 240) }; }
  return {
    ok: res.ok,
    status: res.status,
    path: apiPath,
    method,
    error: json?.error || json?.message || json?.errorCode || json?.title || null,
    errorCode: json?.errorCode || json?.code || null,
    json: redact(json),
    bodyLen: text.length,
  };
};
const sandboxGet = async (creds, apiPath, scopes) => {
  const oauth = await moovOauth({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    origin: creds.origin,
    scopes,
  });
  if (!oauth.ok) return { ok: false, status: oauth.status, json: null, error: oauth.error, oauth: false, path: apiPath, method: 'GET' };
  return { ...(await moovCall({
    token: oauth.token,
    origin: creds.origin,
    apiVersion: creds.apiVersion,
    path: apiPath,
  })), oauth: true };
};
const sandboxWrite = async (creds, apiPath, method, body, scopes) => {
  const oauth = await moovOauth({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    origin: creds.origin,
    scopes,
  });
  if (!oauth.ok) return { ok: false, status: oauth.status, json: null, error: oauth.error, oauth: false, path: apiPath, method };
  return { ...(await moovCall({
    token: oauth.token,
    origin: creds.origin,
    apiVersion: creds.apiVersion,
    path: apiPath,
    method,
    body,
  })), oauth: true };
};

const summarizeCap = (row) => ({
  capability: capName(row) || null,
  status: capStatus(row) || null,
  currentlyDue: row?.requirements?.currentlyDue || row?.currentlyDue || [],
  errors: row?.requirements?.errors || row?.errors || [],
  disabledReason: row?.disabledReason || null,
});
const findCap = (rows, name) => {
  const wanted = String(name).toLowerCase();
  return (rows || []).find((row) => capName(row) === wanted)
    || (rows || []).find((row) => capName(row).startsWith(`${wanted}.`))
    || (rows || []).find((row) => wanted.startsWith(`${capName(row)}.`))
    || null;
};
const achDebitPm = (methods) => (methods || []).find((row) => {
  const type = pmType(row);
  return type === 'ach-debit-fund' || type === 'ach-debit-collect' || type.includes('ach-debit');
}) || null;
const classifyDue = (due, errors, status422) => {
  const text = [...(due || []), ...(errors || []).map((row) => row?.requirement || row?.errorCode || ''), status422 || '']
    .join(' ')
    .toLowerCase();
  if (/tos|terms/.test(text)) return 'ToS';
  if (/representative|beneficial|ownersprovided|controller/.test(text)) return 'representative';
  if (/underwriting/.test(text)) return 'capability request';
  if (/bank/.test(text)) return 'bank verification';
  if (/document|verification|ein|legalname|ssn|profile|business\.|individual\./.test(text)) return 'KYC';
  if (/account.?type|accounttype/.test(text)) return 'account type';
  if (/unsupported|not found|unknown capability|invalid capability/.test(text)) return 'unsupported sandbox behavior';
  if (/capability/.test(text) || status422) return 'capability request';
  return null;
};

const probe = async (pathName, method = 'GET', body = null) => {
  const started = Date.now();
  const res = await fetch(`https://checksops.com/prep${pathName}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 180) }; }
  return {
    path: pathName,
    status: res.status,
    ms: Date.now() - started,
    error: json?.error || null,
    environment: json?.environment || json?.secretEnvironment || null,
  };
};

const readAccountState = async (creds, accountId) => {
  const account = await sandboxGet(creds, `/accounts/${accountId}`, [`/accounts/${accountId}/profile.read`]);
  const caps = await sandboxGet(creds, `/accounts/${accountId}/capabilities`, [`/accounts/${accountId}/capabilities.read`]);
  const collectFunds = await sandboxGet(creds, `/accounts/${accountId}/capabilities/collect-funds`, [`/accounts/${accountId}/capabilities.read`]);
  const collectFundsAch = await sandboxGet(creds, `/accounts/${accountId}/capabilities/collect-funds.ach`, [`/accounts/${accountId}/capabilities.read`]);
  const reps = await sandboxGet(creds, `/accounts/${accountId}/representatives`, [`/accounts/${accountId}/representatives.read`]);
  const underwriting = await sandboxGet(creds, `/accounts/${accountId}/underwriting`, [`/accounts/${accountId}/profile.read`]);
  const wallets = await sandboxGet(creds, `/accounts/${accountId}/wallets`, [`/accounts/${accountId}/wallets.read`]);
  const banks = await sandboxGet(creds, `/accounts/${accountId}/bank-accounts`, [`/accounts/${accountId}/bank-accounts.read`]);
  const methods = await sandboxGet(creds, `/accounts/${accountId}/payment-methods`, [`/accounts/${accountId}/payment-methods.read`]);
  const listed = asList(caps.json).map(summarizeCap);
  const collect = summarizeCap(collectFunds.json && collectFunds.ok ? collectFunds.json : findCap(asList(caps.json), 'collect-funds') || {});
  const collectAch = summarizeCap(collectFundsAch.json && collectFundsAch.ok ? collectFundsAch.json : findCap(asList(caps.json), 'collect-funds.ach') || {});
  const debit = achDebitPm(asList(methods.json));
  const walletCap = findCap(listed, 'wallet') || findCap(listed, 'wallet.balance');
  const sendCap = findCap(listed, 'send-funds') || findCap(listed, 'send-funds.ach');
  const json = account.json || {};
  const representativeRows = asList(reps.json).map((row) => ({
    idFp: fingerprint(row.representativeID || row.id),
    isController: row.responsibilities?.isController === true,
    isOwner: row.responsibilities?.isOwner === true,
  }));
  return {
    accountStatus: account.status,
    accountOk: account.ok,
    displayName: json.displayName || null,
    accountType: json.accountType || json.type || null,
    mode: json.mode || json.accountMode || null,
    foreignID: json.foreignID || json.foreignId || null,
    verification: json.verification?.status || json.verificationStatus || null,
    tosAccepted: Boolean(json.termsOfService?.acceptedDate || json.termsOfService?.acceptedOn || json.profile?.termsOfService?.acceptedDate),
    tosAcceptedDate: json.termsOfService?.acceptedDate || json.termsOfService?.acceptedOn || null,
    capabilities: listed,
    collectFunds: {
      getStatus: collectFunds.status,
      ...collect,
    },
    collectFundsAch: {
      getStatus: collectFundsAch.status,
      ...collectAch,
    },
    walletCapability: walletCap,
    sendFundsCapability: sendCap,
    representativeCount: representativeRows.length,
    representatives: representativeRows,
    underwritingStatus: underwriting.status,
    underwriting: underwriting.ok ? {
      geographicReach: underwriting.json?.geographicReach || null,
      hasLegacyVolume: Boolean(underwriting.json?.averageMonthlyTransactionVolume || underwriting.json?.averageTransactionSize),
      collectFundsAchRange: underwriting.json?.collectFunds?.ach?.estimatedActivity?.monthlyVolumeRange || null,
    } : { error: underwriting.error },
    wallets: asList(wallets.json).map((row) => ({
      id: row.walletID || row.walletId || row.id,
      status: row.status || null,
      availableCents: amountCentsOf(row.availableBalance ?? row.available),
    })),
    banks: asList(banks.json).map((row) => ({
      id: row.bankAccountID || row.bankAccountId || row.id,
      status: row.status || null,
      routingNumber: row.routingNumber || null,
      lastFour: row.lastFourAccountNumber || row.lastFour || null,
      bankName: row.bankName || null,
    })),
    paymentMethods: asList(methods.json).map((row) => ({
      id: pmIdOf(row),
      type: pmType(row),
      bankAccountId: row.bankAccountID || row.bankAccount?.bankAccountID || null,
      walletId: row.walletID || row.wallet?.walletID || null,
    })),
    achDebitPm: debit ? {
      id: pmIdOf(debit),
      type: pmType(debit),
      bankAccountId: debit.bankAccountID || debit.bankAccount?.bankAccountID || null,
    } : null,
    currentlyDueAll: listed.flatMap((row) => row.currentlyDue || []),
    errorsAll: listed.flatMap((row) => row.errors || []),
  };
};

const reproduce422 = async (creds, accountId) => {
  const endpoint = `/accounts/${accountId}/capabilities`;
  const m79cBody = { capability: 'collect-funds.ach' };
  const reproduced = await sandboxWrite(
    creds,
    endpoint,
    'POST',
    m79cBody,
    [`/accounts/${accountId}/capabilities.write`],
  );
  return {
    endpoint,
    requestShape: m79cBody,
    httpStatus: reproduced.status,
    error: reproduced.error,
    errorCode: reproduced.errorCode,
    body: reproduced.json,
    ok: reproduced.ok,
  };
};

const compareWorking = async (creds, pipelineState) => {
  const listed = await sandboxGet(creds, '/accounts', ['/accounts.read']);
  const platformCaps = await sandboxGet(
    creds,
    `/accounts/${creds.platformId}/capabilities`,
    [`/accounts/${creds.platformId}/capabilities.read`],
  );
  const candidates = [];
  for (const row of asList(listed.json).slice(0, 20)) {
    const id = accountIdOf(row);
    if (!id || isProdId(id) || id === SANDBOX_ACCOUNT) continue;
    const caps = await sandboxGet(creds, `/accounts/${id}/capabilities`, [`/accounts/${id}/capabilities.read`]);
    const summarized = asList(caps.json).map(summarizeCap);
    const collect = findCap(summarized, 'collect-funds') || findCap(summarized, 'collect-funds.ach');
    if (collect && enabledish(collect.status)) {
      const banks = await sandboxGet(creds, `/accounts/${id}/bank-accounts`, [`/accounts/${id}/bank-accounts.read`]);
      const methods = await sandboxGet(creds, `/accounts/${id}/payment-methods`, [`/accounts/${id}/payment-methods.read`]);
      candidates.push({
        accountFp: fingerprint(id),
        accountType: row.accountType || row.type || null,
        displayName: row.displayName || null,
        mode: row.mode || row.accountMode || null,
        verification: row.verification?.status || null,
        tosAccepted: Boolean(row.termsOfService?.acceptedDate || row.termsOfService?.acceptedOn),
        capabilities: summarized,
        collectFunds: collect,
        bankStatuses: asList(banks.json).map((bank) => bank.status || null),
        achDebitPm: Boolean(achDebitPm(asList(methods.json))),
      });
    }
    if (candidates.length >= 2) break;
  }
  const platformSummarized = asList(platformCaps.json).map(summarizeCap);
  return {
    listedStatus: listed.status,
    workingSandboxAccount: candidates[0] || null,
    otherEnabledCount: candidates.length,
    platform: {
      idFp: fingerprint(creds.platformId),
      capabilities: platformSummarized,
      collectFunds: findCap(platformSummarized, 'collect-funds') || findCap(platformSummarized, 'collect-funds.ach'),
    },
    pipelineVsWorking: candidates[0] ? {
      sameAccountType: pipelineState.accountType === candidates[0].accountType,
      pipelineCollect: pipelineState.collectFunds.status,
      workingCollect: candidates[0].collectFunds.status,
      pipelineDue: pipelineState.collectFunds.currentlyDue,
      workingDue: candidates[0].collectFunds.currentlyDue,
      pipelineTos: pipelineState.tosAccepted,
      workingTos: candidates[0].tosAccepted,
    } : { workingAccountFound: false },
  };
};

const acceptTos = async (creds, accountId) => {
  const tokenGet = await sandboxGet(creds, '/tos-token', [`/accounts/${accountId}/profile.write`]);
  const token = tokenGet.json?.token || tokenGet.json?.tosToken || null;
  if (present(token)) {
    const patched = await sandboxWrite(creds, `/accounts/${accountId}`, 'PATCH', {
      termsOfService: { token },
    }, [`/accounts/${accountId}/profile.write`]);
    return { ok: patched.ok, method: 'token', status: patched.status, error: patched.error };
  }
  const manual = await sandboxWrite(creds, `/accounts/${accountId}`, 'PATCH', {
    termsOfService: {
      manual: {
        acceptedDate: new Date().toISOString(),
        acceptedIP: '127.0.0.1',
        acceptedUserAgent: 'ChecksOps-M79D/1.0',
        acceptedDomain: 'checksops.com',
      },
    },
  }, [`/accounts/${accountId}/profile.write`]);
  return { ok: manual.ok, method: 'manual', status: manual.status, error: manual.error };
};

const COLLECT_FUNDS_UNDERWRITING = {
  geographicReach: 'us-only',
  collectFunds: {
    ach: {
      estimatedActivity: {
        monthlyVolumeRange: 'under-10k',
      },
    },
  },
};
const LEGACY_UNDERWRITING = {
  averageTransactionSize: 10000,
  maxTransactionSize: 50000,
  averageMonthlyTransactionVolume: 100000,
  volumeByCustomerType: {
    businessToBusinessPercentage: 50,
    consumerToBusinessPercentage: 50,
  },
  fulfillment: {
    hasPhysicalGoods: false,
    isShippingProduct: false,
    shipmentDurationDays: 0,
    returnPolicy: 'none',
  },
};

const submitUnderwriting = async (creds, accountId) => {
  const attempts = [];
  for (const [label, body] of [
    ['collect_funds_ach', COLLECT_FUNDS_UNDERWRITING],
    ['legacy_v2024', LEGACY_UNDERWRITING],
  ]) {
    for (const method of ['POST', 'PUT']) {
      const row = await sandboxWrite(
        creds,
        `/accounts/${accountId}/underwriting`,
        method,
        body,
        [`/accounts/${accountId}/profile.write`],
      );
      attempts.push({ label, method, status: row.status, ok: row.ok, error: row.error });
      if (row.ok) return { ok: true, label, method, status: row.status, attempts };
    }
  }
  return { ok: false, attempts };
};

const requestCollectFunds = async (creds, accountId) => {
  const documented = { capabilities: ['collect-funds.ach'] };
  const family = { capabilities: ['collect-funds'] };
  const results = [];
  for (const body of [documented, family]) {
    const row = await sandboxWrite(
      creds,
      `/accounts/${accountId}/capabilities`,
      'POST',
      body,
      [`/accounts/${accountId}/capabilities.write`],
    );
    results.push({
      requestShape: body,
      status: row.status,
      ok: row.ok,
      error: row.error,
      errorCode: row.errorCode,
      body: row.json,
    });
    if (row.ok) break;
  }
  return results;
};

const completeRequired = async (creds, accountId, before, created) => {
  const due = [
    ...(before.currentlyDueAll || []),
    ...(before.collectFunds?.currentlyDue || []),
    ...(before.collectFundsAch?.currentlyDue || []),
  ].map((item) => String(item));
  const dueText = due.join(' ').toLowerCase();
  const actions = [];
  let operatorAction = null;

  if (due.some((item) => /document\./i.test(item))) {
    operatorAction = `Moov Dashboard: upload required sandbox verification document(s) for account ${SANDBOX_ACCOUNT} (${due.filter((item) => /document\./i.test(item)).join(', ')}). This principal will not upload identity documents.`;
    return { actions, operatorAction, due };
  }

  if (!before.tosAccepted || /tos|terms/.test(dueText)) {
    const tos = await acceptTos(creds, accountId);
    actions.push({ kind: 'tos', ...tos });
    if (tos.ok) created.push('sandbox_tos');
  }

  if (/representative|beneficial|ownersprovided|controller/.test(dueText) && before.representativeCount === 0) {
    const write = await sandboxWrite(creds, `/accounts/${accountId}/representatives`, 'POST', {
      name: { firstName: 'Pat', lastName: 'Pipeline' },
      email: 'pat.pipeline-sandbox@checksops.com',
      phone: { number: '8185551212', countryCode: '1' },
      address: TEST_ADDRESS,
      birthDate: { year: 1988, month: 6, day: 15 },
      governmentID: { ssn: { full: '123456789' } },
      responsibilities: {
        isController: true,
        isOwner: true,
        ownershipPercentage: 100,
        jobTitle: 'Owner',
      },
    }, [`/accounts/${accountId}/representatives.write`]);
    actions.push({ kind: 'representative', status: write.status, ok: write.ok, error: write.error });
    if (write.ok) created.push('sandbox_representative');
  }

  if (/business\.|individual\.|legalname|ein|profile/.test(dueText)) {
    const profile = await sandboxWrite(creds, `/accounts/${accountId}`, 'PATCH', {
      profile: {
        business: {
          legalBusinessName: 'ChecksOps Pipeline Test',
          doingBusinessAs: 'Pipeline Test',
          businessType: 'llc',
          email: 'pipeline-test-sandbox@checksops.com',
          website: 'https://checksops.com',
          description: 'Sandbox-only ChecksOps pipeline payout test tenant. No live money.',
          phone: { number: '8185551212', countryCode: '1' },
          address: TEST_ADDRESS,
          taxID: { ein: { number: '123456789' } },
          industryCodes: { mcc: '7372', naics: '541511', sic: '7371' },
          ownersProvided: true,
        },
      },
    }, [`/accounts/${accountId}/profile.write`]);
    actions.push({ kind: 'business_profile', status: profile.status, ok: profile.ok, error: profile.error });
    if (profile.ok) created.push('sandbox_profile_patch');
  }

  if (/underwriting/.test(dueText) || before.collectFunds.status === 'pending' || before.collectFundsAch.getStatus === 404) {
    const underwriting = await submitUnderwriting(creds, accountId);
    actions.push({ kind: 'underwriting', ...underwriting });
    if (underwriting.ok) created.push(`sandbox_underwriting:${underwriting.label}`);
  }

  const requested = await requestCollectFunds(creds, accountId);
  actions.push({ kind: 'capability_request', requested });
  if (requested.some((row) => row.ok)) created.push('capability:collect-funds');

  return { actions, operatorAction, due };
};

const waitForCollectFunds = async (creds, accountId) => {
  let state = await readAccountState(creds, accountId);
  for (let i = 0; i < 6; i += 1) {
    const collectEnabled = enabledish(state.collectFunds.status) || enabledish(state.collectFundsAch.status);
    if (collectEnabled) return { state, attempts: i + 1 };
    await sleep(2000);
    state = await readAccountState(creds, accountId);
  }
  return { state, attempts: 6 };
};

const darkFundBinding = async (creds, after) => {
  const wallet = after.wallets.find((row) => row.id === SANDBOX_WALLET) || after.wallets[0];
  const bank = after.banks.find((row) => row.id === SANDBOX_BANK) || after.banks[0];
  const debit = after.achDebitPm;
  const availableCents = wallet?.availableCents ?? 0;
  const payoutCents = FIRST_PRODUCTION_TRANSFER_CENTS;
  const labels = {
    fund: {
      sourceLabel: bank?.lastFour ? `${bank.bankName || 'Bank'} ••••${bank.lastFour}` : 'Sandbox funding bank',
      destinationLabel: 'Sandbox wallet',
      bankId: SANDBOX_BANK,
      walletId: SANDBOX_WALLET,
      sourcePaymentMethodId: debit?.id || null,
    },
    disburse: {
      sourceLabel: 'Sandbox wallet',
      destinationLabel: 'Sandbox recipient bank',
      recipientLabel: 'Pipeline Test Payee',
      recipientId: SANDBOX_RECIPIENT,
    },
  };
  const plan = await orchestratePayout({
    availableCents,
    payoutCents,
    recipientVerified: true,
    totpFundPresent: false,
    totpDisbursePresent: false,
    transferPostEnabled: false,
    persistMoneyIntents: false,
    environment: 'sandbox',
    tenantId: PIPELINE,
    labels,
  });
  const bound = plan.funding_intent || null;
  return {
    liveAvailableCents: availableCents,
    payoutCents,
    shortfallCents: plan.shortfall_cents,
    decision: plan.decision,
    funding_state: plan.funding_state,
    live_provider_posted: plan.live_provider_posted,
    persist_money_intents: plan.persist_money_intents,
    transfer_post_enabled: plan.transfer_post_enabled,
    created_payment_transfer: plan.created_payment_transfer,
    source_bank_id: bound?.source_bank_id || null,
    destination_wallet_id: bound?.destination_wallet_id || null,
    source_payment_method_id: bound?.source_payment_method_id || null,
    source_label: bound?.source_label || null,
    destination_label: bound?.destination_label || null,
    matchesKnownBank: bound?.source_bank_id === SANDBOX_BANK,
    matchesKnownWallet: bound?.destination_wallet_id === SANDBOX_WALLET,
    noFreedomIds: ![bound?.source_bank_id, bound?.destination_wallet_id, bound?.source_payment_method_id]
      .some((id) => isProdId(id)),
    ok: plan.decision === 'FUND_FIRST'
      && plan.shortfall_cents === 1
      && availableCents === 0
      && plan.live_provider_posted === false
      && plan.persist_money_intents === false
      && bound?.source_bank_id === SANDBOX_BANK
      && bound?.destination_wallet_id === SANDBOX_WALLET,
  };
};

const crossEnvLookups = async (creds) => {
  const sandboxOnFreedom = await sandboxGet(creds, `/accounts/${FREEDOM_MOOV}`, [`/accounts/${FREEDOM_MOOV}/profile.read`]);
  const sandboxOnPlatform = await sandboxGet(creds, `/accounts/${PRODUCTION_PLATFORM}`, [`/accounts/${PRODUCTION_PLATFORM}/profile.read`]);
  const sandboxOnMichael = await sandboxGet(creds, `/accounts/${MICHAEL}`, [`/accounts/${MICHAEL}/profile.read`]);
  let productionOnSandbox = { ok: false, status: null };
  if (present(creds.productionPublicKey) && present(creds.productionSecretKey)) {
    const oauth = await moovOauth({
      publicKey: creds.productionPublicKey,
      secretKey: creds.productionSecretKey,
      origin: LIVE_ORIGIN,
      scopes: [`/accounts/${SANDBOX_ACCOUNT}/profile.read`],
    });
    productionOnSandbox = oauth.ok ? await moovCall({
      token: oauth.token,
      origin: LIVE_ORIGIN,
      apiVersion: PROVEN_API_VERSION,
      path: `/accounts/${SANDBOX_ACCOUNT}`,
    }) : { ok: false, status: oauth.status };
  }
  const objectGuardSandbox = assertNoCrossEnvironmentObject({ environment: 'sandbox', accountId: FREEDOM_MOOV });
  const objectGuardProduction = assertNoCrossEnvironmentObject({ environment: 'production', accountId: SANDBOX_ACCOUNT });
  return {
    sandboxCannotReadFreedom: sandboxOnFreedom.ok !== true,
    sandboxCannotReadProductionPlatform: sandboxOnPlatform.ok !== true,
    sandboxCannotReadMichael: sandboxOnMichael.ok !== true,
    productionCannotReadSandbox: productionOnSandbox.ok !== true,
    sandboxFreedomStatus: sandboxOnFreedom.status,
    productionSandboxStatus: productionOnSandbox.status,
    objectGuardSandboxDenied: objectGuardSandbox.ok !== true,
    objectGuardProductionDenied: objectGuardProduction.ok !== true,
    fallbackUsed: false,
    ok: sandboxOnFreedom.ok !== true
      && sandboxOnPlatform.ok !== true
      && productionOnSandbox.ok !== true
      && objectGuardSandbox.ok !== true
      && objectGuardProduction.ok !== true,
  };
};

const inspectWebhooks = async (creds, production) => {
  const sandbox = await moovCall({
    publicKey: creds.publicKey,
    secretKey: creds.secretKey,
    origin: creds.origin,
    apiVersion: creds.apiVersion,
    path: '/webhooks',
  });
  const productionListed = present(production.parsed.MOOV_PUBLIC_KEY) && present(production.parsed.MOOV_SECRET_KEY)
    ? await moovCall({
      publicKey: production.parsed.MOOV_PUBLIC_KEY,
      secretKey: production.parsed.MOOV_SECRET_KEY,
      origin: LIVE_ORIGIN,
      apiVersion: PROVEN_API_VERSION,
      path: '/webhooks',
    })
    : { ok: false, status: null, json: null };
  const sandboxRows = asList(sandbox.json).map((row) => ({
    idFp: fingerprint(row.webhookID || row.id),
    url: row.url || null,
    disabled: row.disabled === true,
    events: row.events || row.eventTypes || null,
  }));
  const sandboxWebhook = sandboxRows.find((row) => String(row.url || '').replace(/\/$/, '') === PREFERRED_WEBHOOK_URL.replace(/\/$/, ''));
  return {
    sandbox: {
      listed: sandbox.ok,
      status: sandbox.status,
      webhook: sandboxWebhook || sandboxRows[0] || null,
      healthy: Boolean(sandboxWebhook && sandboxWebhook.disabled !== true),
    },
    production: {
      listed: productionListed.ok,
      status: productionListed.status,
      rows: asList(productionListed.json).map((row) => ({
        idFp: fingerprint(row.webhookID || row.id),
        url: row.url || null,
        disabled: row.disabled === true,
      })),
      healthy: productionListed.ok === true,
    },
  };
};

const collectEnabled = (state) => enabledish(state.collectFunds.status) || enabledish(state.collectFundsAch.status);
const collectUsable = (state) => collectEnabled(state) && Boolean(state.achDebitPm?.id);

const main = async () => {
  const identity = await assumeRole();
  const flags = lambdaFlags();
  if (flags.flags.AWS_MOOV_TRANSFER_POST_ENABLED === 'true' || flags.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED === 'true') {
    throw new Error('refused_armed_post_flag');
  }
  const production = loadSecret(flags.PROVIDER_SECRETS_ARN || PRODUCTION_SECRET);
  const s = production.parsed;
  const creds = {
    publicKey: s.MOOV_SANDBOX_PUBLIC_KEY,
    secretKey: s.MOOV_SANDBOX_SECRET_KEY,
    platformId: s.MOOV_SANDBOX_PLATFORM_ACCOUNT_ID,
    origin: s.MOOV_SANDBOX_ALLOWED_ORIGIN || LIVE_ORIGIN,
    apiVersion: s.MOOV_SANDBOX_API_VERSION || PROVEN_API_VERSION,
    productionPublicKey: s.MOOV_PUBLIC_KEY,
    productionSecretKey: s.MOOV_SECRET_KEY,
  };
  if (!present(creds.publicKey) || !present(creds.secretKey) || !present(creds.platformId)) {
    throw new Error('sandbox_credentials_missing');
  }
  if (creds.publicKey === creds.productionPublicKey || creds.secretKey === creds.productionSecretKey) {
    throw new Error('sandbox_equals_production');
  }

  const created = [];
  const reused = ['sandbox_account', 'sandbox_wallet', 'sandbox_bank', 'sandbox_recipient', 'sandbox_recipient_bank'];
  const before = await readAccountState(creds, SANDBOX_ACCOUNT);
  fs.writeFileSync('/opt/cursor/artifacts/m79d_before.json', JSON.stringify(before, null, 2));

  const trace422 = await reproduce422(creds, SANDBOX_ACCOUNT);
  const compared = await compareWorking(creds, before);
  const rootCause = classifyDue(
    [...(before.collectFunds.currentlyDue || []), ...(before.collectFundsAch.currentlyDue || []), ...(before.currentlyDueAll || [])],
    [...(before.collectFunds.errors || []), ...(before.collectFundsAch.errors || [])],
    `${trace422.error || ''} ${trace422.errorCode || ''} ${JSON.stringify(trace422.body || {})}`,
  ) || 'capability request';

  const completed = await completeRequired(creds, SANDBOX_ACCOUNT, before, created);
  const waited = await waitForCollectFunds(creds, SANDBOX_ACCOUNT);
  const after = waited.state;

  if (!collectEnabled(after) && !(completed.due || []).length && !completed.operatorAction) {
    completed.operatorAction = `Moov Dashboard: sandbox account ${SANDBOX_ACCOUNT} still has collect-funds=${after.collectFunds.status || 'missing'} after API underwriting/capability request. currentlyDue=${JSON.stringify(after.currentlyDueAll || [])}. Enable collect-funds / ACH debit for ChecksOps Pipeline Test. Do not create another account.`;
  }

  const rdsVerify = invokeOneshot({ step: 'verify', tenantId: PIPELINE });
  const rdsProof = invokeOneshot({ step: 'object_proof', tenantId: PIPELINE });
  const dark = await darkFundBinding(creds, after);
  const cross = await crossEnvLookups(creds);
  const webhooks = await inspectWebhooks(creds, production);
  const health = {
    login: await probe('/auth/login', 'POST', { email: 'nobody@example.com', password: 'invalid' }),
    webhookUnsigned: await probe('/webhooks/moov', 'POST', { type: 'account.updated' }),
    providersStatus: await probe('/providers/status', 'GET'),
  };
  const flagsAfter = lambdaFlags();
  const bank = (after.banks || []).find((row) => row.id === SANDBOX_BANK);
  const wallet = (after.wallets || []).find((row) => row.id === SANDBOX_WALLET);
  const collectActive = collectEnabled(after);
  const debitReady = collectUsable(after);
  const bankVerified = String(bank?.status || '').toLowerCase() === 'verified';
  const walletActive = String(wallet?.status || '').toLowerCase() === 'active';
  const safeToArm = collectActive && debitReady && bankVerified && walletActive && dark.ok && cross.ok && webhooks.sandbox.healthy
    && flagsAfter.flags.AWS_MOOV_TRANSFER_POST_ENABLED !== 'true'
    && flagsAfter.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED !== 'true'
    && !completed.operatorAction;

  const returnCard = {
    ACCOUNT_STATUS: before.accountOk ? (before.verification || 'ok') : `http_${before.accountStatus}`,
    KYC_KYB_STATUS: after.verification || before.verification,
    TOS_STATUS: after.tosAccepted || before.tosAccepted ? 'accepted' : 'missing',
    REPRESENTATIVE_STATUS: after.representativeCount > 0 ? `present:${after.representativeCount}` : 'missing',
    collect_funds_BEFORE: before.collectFunds.status || `http_${before.collectFunds.getStatus}`,
    collect_funds_ach_BEFORE: before.collectFundsAch.status || `http_${before.collectFundsAch.getStatus}`,
    ACH_DEBIT_PM_BEFORE: before.achDebitPm?.id || null,
    '422_ENDPOINT': trace422.endpoint,
    '422_ERROR_CODE': trace422.errorCode || trace422.error || trace422.httpStatus,
    '422_ROOT_CAUSE': rootCause,
    REQUIRED_SANDBOX_FIX: completed.due,
    OPERATOR_ACTION_REQUIRED: completed.operatorAction || 'none',
    collect_funds_AFTER: after.collectFunds.status || `http_${after.collectFunds.getStatus}`,
    collect_funds_ach_AFTER: after.collectFundsAch.status || `http_${after.collectFundsAch.getStatus}`,
    ACH_DEBIT_PM_AFTER: after.achDebitPm?.id || null,
    BANK_VERIFIED: bankVerified,
    WALLET_ACTIVE: walletActive,
    DARK_FUND_BINDING: dark.ok,
    SHORTFALL_DECISION: dark.decision,
    SANDBOX_WEBHOOK: webhooks.sandbox.healthy ? 'healthy' : webhooks.sandbox.webhook?.url || 'missing',
    PRODUCTION_WEBHOOK: webhooks.production.healthy ? 'healthy' : `http_${webhooks.production.status}`,
    CROSS_ENVIRONMENT_BLOCKED: cross.ok === true,
    SANDBOX_POST_FLAG: flagsAfter.flags.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED || 'false',
    PRODUCTION_POST_FLAG: flagsAfter.flags.AWS_MOOV_TRANSFER_POST_ENABLED || 'false',
    SANDBOX_MONEY_MOVED: false,
    PRODUCTION_MONEY_MOVED: false,
    FREEDOM_CHANGED: false,
    FREEDOM_REMAINS_PRODUCTION: (rdsVerify?.freedomEnvironment || rdsProof?.freedom?.moov_environment) === 'production',
    SWEEP_CHANGED: false,
    SAFE_TO_ARM_ONLY_AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED: safeToArm ? 'REVIEW' : 'NO',
    SAFE_TO_RUN_FIRST_SANDBOX_BANK_TO_WALLET: 'NO',
    GO_NO_GO: 'NO-GO — STOP FOR REVIEW',
    STOP_FOR_REVIEW: true,
  };

  const report = {
    at: new Date().toISOString(),
    identity: { arn: identity.Arn, account: identity.Account },
    flags: flagsAfter.flags,
    lambda: { state: flagsAfter.state, lastUpdateStatus: flagsAfter.lastUpdateStatus, codeSha256: flagsAfter.codeSha256 },
    before,
    trace422,
    compared,
    completed,
    after,
    dark,
    cross,
    webhooks,
    health,
    rdsVerify: {
      ok: rdsVerify?.ok === true,
      tenantEnvironment: rdsVerify?.tenant?.moov_environment || rdsVerify?.environment || null,
      freedomEnvironment: rdsVerify?.freedomEnvironment || rdsProof?.freedom?.moov_environment || null,
    },
    created,
    reused,
    duplicates: [],
    productionIdsUsed: [SANDBOX_ACCOUNT, SANDBOX_WALLET, SANDBOX_BANK, SANDBOX_RECIPIENT, SANDBOX_RECIPIENT_BANK].some((id) => isProdId(id)),
    returnCard,
  };
  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync('/opt/cursor/artifacts/m79d_run.json', JSON.stringify(report, null, 2));
  fs.writeFileSync('/opt/cursor/artifacts/m79d_after.json', JSON.stringify(after, null, 2));
  const cardLines = Object.entries(returnCard).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  fs.writeFileSync('/opt/cursor/artifacts/m79d_return_card.md', `${cardLines.join('\n')}\n`);
  console.log(JSON.stringify({ ok: true, returnCard, dark, created, operatorAction: completed.operatorAction }, null, 2));
};

main().catch((error) => {
  const stopped = { ok: false, error: error.message, STOP_FOR_REVIEW: true };
  try {
    fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
    fs.writeFileSync('/opt/cursor/artifacts/m79d_stopped.json', JSON.stringify(stopped, null, 2));
  } catch { /* ignore */ }
  console.error(JSON.stringify(stopped));
  process.exit(1);
});
