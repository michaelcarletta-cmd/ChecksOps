#!/usr/bin/env node
/**
 * Build a production Lambda candidate from a FRESH live download.
 * Overlays only accepted Platform Finance / receivables members.
 * Does not call AWS write APIs.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'aws/functions/api');
const OWNED = [
  'providers/parity/tenant-receivables.mjs',
  'providers/parity/caller.mjs',
  'providers/parity/moov-functions.mjs',
  'providers/parity/moov-onboard.mjs',
];
const PROTECTED = [
  'providers/parity/moov-money.mjs',
  'write-allowlist.mjs',
  'write-app-metadata.mjs',
  'write.mjs',
  'workflow-rpc.mjs',
  'tenant-billing-engine.mjs',
  'tenant-billing-destination.mjs',
];

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const walkHashes = (dir, prefix = '', out = {}) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkHashes(abs, rel, out);
    else out[rel] = sha256(abs);
  }
  return out;
};

export function patchLiveCaller(text) {
  if (text.includes('isChecksOpsPlatformOwner')) return text;
  const needle = `export async function isPlatformAdmin(client, userId) {
  const row = (await client.query(
    \`SELECT 1 FROM public.user_roles WHERE user_id = $1::uuid AND role = 'admin' LIMIT 1\`,
    [userId],
  )).rows[0];
  return Boolean(row);
}`;
  if (!text.includes(needle)) {
    throw new Error('live caller.mjs isPlatformAdmin block not found; refuse wholesale replace');
  }
  return text.replace(needle, `${needle}

/** Established ChecksOps master-admin contract. Tenant user_roles.admin never qualifies. */
export async function isChecksOpsPlatformOwner(client) {
  const row = (await client.query('SELECT public.is_platform_owner() AS is_owner')).rows[0];
  return row?.is_owner === true;
}`);
}

export function patchLiveMoovFunctions(text) {
  if (text.includes('wrapPlatformOwnerRead')) return text;
  if (!text.includes("import { fail, jsonResult, moovParityContext } from './caller.mjs';")) {
    throw new Error('live moov-functions.mjs import not found; refuse wholesale replace');
  }
  let next = text.replace(
    "import { fail, jsonResult, moovParityContext } from './caller.mjs';",
    "import { fail, jsonResult, moovParityContext, isChecksOpsPlatformOwner } from './caller.mjs';",
  );
  const wrapNeedle = 'const wrap = (handler) => async (event, deps = {}) => {';
  const idx = next.indexOf(wrapNeedle);
  if (idx < 0) throw new Error('live moov-functions.mjs wrap() not found; refuse wholesale replace');
  const wrapper = `const wrapPlatformOwnerRead = (handler) => async (event, deps = {}) => {
  const { withIdentity } = await import('../../data.mjs');
  const { loadSandboxCredentials } = await import('../../sandbox-credentials.mjs');
  const loader = typeof deps.loadSandboxCredentials === 'function'
    ? deps.loadSandboxCredentials
    : loadSandboxCredentials;
  return withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
    const isOwner = await isChecksOpsPlatformOwner(client);
    if (!isOwner) {
      return fail('Platform owner access required', 403, {
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
      });
    }
    const loaded = await loader();
    const secrets = loaded.secrets || {};
    const productionRuntime = String(process.env.CHECKSOPS_ENV || '').toLowerCase().startsWith('production');
    const productionReady = Boolean(secrets.MOOV_PUBLIC_KEY && secrets.MOOV_SECRET_KEY);
    const useProduction = productionRuntime && productionReady;
    const moovContext = useProduction
      ? {
        environment: 'production',
        sandboxPublicKey: loaded.moov?.publicKey || null,
        sandboxSecretKey: loaded.moov?.secretKey || null,
        sandboxPlatformAccountId: loaded.moov?.platformAccountId || null,
        sandboxOrigin: loaded.moov?.origin || 'https://checksops.com',
        apiVersion: loaded.moov?.apiVersion || secrets.MOOV_API_VERSION || secrets.MOOV_SANDBOX_API_VERSION || 'v2024.01.00',
        productionPublicKey: secrets.MOOV_PUBLIC_KEY || null,
        productionSecretKey: secrets.MOOV_SECRET_KEY || null,
        productionPlatformAccountId: secrets.MOOV_ACCOUNT_ID
          || process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID
          || null,
      }
      : {
        environment: 'sandbox',
        sandboxPublicKey: loaded.moov?.publicKey || null,
        sandboxSecretKey: loaded.moov?.secretKey || null,
        sandboxPlatformAccountId: loaded.moov?.platformAccountId || null,
        sandboxOrigin: loaded.moov?.origin || 'https://checksops.com',
        apiVersion: loaded.moov?.apiVersion || secrets.MOOV_SANDBOX_API_VERSION || 'v2024.01.00',
        productionPublicKey: null,
        productionSecretKey: null,
        productionPlatformAccountId: null,
      };
    const ctx = {
      tenantId: null,
      isAdmin: false,
      isPlatformOwner: true,
      environment: moovContext.environment,
      userId: mapping.application_user_id,
      memberships: [],
      moovContext,
      loaded,
    };
    try {
      const fetchImpl = deps.fetchImpl || fetch;
      const result = await withMoovContext({ ...moovContext, fetchImpl }, () => handler.run({
        client, mapping, claims, body, spoof, ctx, fetchImpl, event,
      }));
      return {
        ...result,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        productionExecution: false,
        environment: moovContext.environment,
        apiVersion: moovContext.apiVersion,
      };
    } catch (error) {
      const { isProviderNetworkError, providerEgressFailure } = await import('../../sandbox-credentials.mjs');
      if (isProviderNetworkError(error)) {
        return {
          ...providerEgressFailure('moov'),
          spoofFieldsIgnored: spoof,
          applicationUserId: mapping.application_user_id,
        };
      }
      const status = error instanceof MoovError ? (error.status || 502) : 500;
      return fail(error.message, status, {
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        liveProviderCalled: true,
      });
    }
  }, deps);
};

const wrap = (handler) => {
  if (handler.platformOwnerOnly === true) return wrapPlatformOwnerRead(handler);
  return wrapTenantParity(handler);
};

const wrapTenantParity = (handler) => async (event, deps = {}) => {`;
  next = next.slice(0, idx) + wrapper + next.slice(idx + wrapNeedle.length);
  return next;
}

export function patchLiveMoovOnboard(text) {
  if (text.includes('loadTenantReceivables')) return text;
  if (!text.includes("import { fail, jsonResult } from './caller.mjs';")) {
    throw new Error('live moov-onboard.mjs import not found; refuse wholesale replace');
  }
  let next = text.replace(
    "import { fail, jsonResult } from './caller.mjs';",
    `import { fail, jsonResult } from './caller.mjs';
import {
  enrichWalletTransactions,
  loadTenantReceivables,
} from './tenant-receivables.mjs';`,
  );
  const bankStart = next.indexOf('export const platformBank = {');
  const bankEnd = next.indexOf('export const feeScheduleUpsert');
  const treasStart = next.indexOf('export const platformTreasury = {');
  const treasEnd = next.indexOf('export const homeownerDeductiblePay');
  if (bankStart < 0 || bankEnd < 0 || treasStart < 0 || treasEnd < 0) {
    throw new Error('live moov-onboard.mjs platformBank/platformTreasury anchors missing; refuse wholesale replace');
  }
  const composedBank = fs.readFileSync(path.join(SRC, 'providers/parity/moov-onboard.mjs'), 'utf8');
  const srcBankStart = composedBank.indexOf('export const platformBank = {');
  const srcBankEnd = composedBank.indexOf('export const feeScheduleUpsert');
  const srcTreasHelpers = composedBank.indexOf('const centsFromBalance = (balance) => {');
  const srcTreasEnd = composedBank.indexOf('export const homeownerDeductiblePay');
  next = next.slice(0, bankStart) + composedBank.slice(srcBankStart, srcBankEnd) + next.slice(bankEnd);
  const treasStart2 = next.indexOf('export const platformTreasury = {');
  const treasEnd2 = next.indexOf('export const homeownerDeductiblePay');
  next = next.slice(0, treasStart2) + composedBank.slice(srcTreasHelpers, srcTreasEnd) + next.slice(treasEnd2);
  return next;
}

export function applyOverlayToUnpack(unpack) {
  const liveHashes = walkHashes(unpack);
  fs.mkdirSync(path.join(unpack, 'providers/parity'), { recursive: true });
  fs.copyFileSync(
    path.join(SRC, 'providers/parity/tenant-receivables.mjs'),
    path.join(unpack, 'providers/parity/tenant-receivables.mjs'),
  );
  const callerPath = path.join(unpack, 'providers/parity/caller.mjs');
  const fnsPath = path.join(unpack, 'providers/parity/moov-functions.mjs');
  const onboardPath = path.join(unpack, 'providers/parity/moov-onboard.mjs');
  fs.writeFileSync(callerPath, patchLiveCaller(fs.readFileSync(callerPath, 'utf8')));
  fs.writeFileSync(fnsPath, patchLiveMoovFunctions(fs.readFileSync(fnsPath, 'utf8')));
  fs.writeFileSync(onboardPath, patchLiveMoovOnboard(fs.readFileSync(onboardPath, 'utf8')));
  const candidateHashes = walkHashes(unpack);
  const protectedProof = {};
  for (const rel of PROTECTED) {
    if (!liveHashes[rel]) {
      protectedProof[rel] = { live: null, candidate: candidateHashes[rel] || null, identical: !candidateHashes[rel] };
      continue;
    }
    protectedProof[rel] = {
      live: liveHashes[rel],
      candidate: candidateHashes[rel],
      identical: liveHashes[rel] === candidateHashes[rel],
    };
  }
  const unexpectedChanged = Object.keys(liveHashes).filter((rel) => (
    !OWNED.includes(rel) && liveHashes[rel] !== candidateHashes[rel]
  ));
  const added = Object.keys(candidateHashes).filter((rel) => !liveHashes[rel]);
  return { liveHashes, candidateHashes, protectedProof, unexpectedChanged, added };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const unpack = process.argv[2];
  if (!unpack) {
    console.error('usage: build-production-receivables-overlay.mjs <unpack-dir>');
    process.exit(2);
  }
  const result = applyOverlayToUnpack(unpack);
  console.log(JSON.stringify({
    unexpectedChanged: result.unexpectedChanged,
    added: result.added,
    protectedProof: result.protectedProof,
    owned: Object.fromEntries(OWNED.map((rel) => [rel, {
      live: result.liveHashes[rel] || null,
      candidate: result.candidateHashes[rel] || null,
    }])),
  }, null, 2));
  if (result.unexpectedChanged.length) process.exit(1);
  if (!result.protectedProof['providers/parity/moov-money.mjs']?.identical) process.exit(1);
}
