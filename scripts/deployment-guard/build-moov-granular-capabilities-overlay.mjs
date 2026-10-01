#!/usr/bin/env node
/**
 * Surgical overlay: replace deprecated Moov family capability IDs on a FRESH
 * live Lambda unpack. Does not copy branch-local moov-functions/onboard.
 * Does not deploy.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OWNED_MEMBERS = Object.freeze([
  'providers/parity/moov-functions.mjs',
  'providers/parity/moov-onboard.mjs',
  'providers/parity/moov-client.mjs',
]);

export const MERCHANT_CAPABILITIES = [
  'transfers',
  'collect-funds.ach',
  'send-funds.ach',
  'wallet.balance',
];

const LEGACY_ARRAY = "['transfers', 'send-funds', 'wallet', 'send-funds.ach']";
const GRANULAR_ARRAY = `['${MERCHANT_CAPABILITIES.join("', '")}']`;

export function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function walkHashes(dir, prefix = '', out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (rel === 'node_modules' || rel.startsWith('node_modules/')) continue;
      walkHashes(abs, rel, out);
      continue;
    }
    out[rel] = sha256(abs);
  }
  return out;
}

export function patchMoovFunctions(text) {
  if (!text.includes(LEGACY_ARRAY)) {
    throw new Error('live moov-functions.mjs is missing the legacy merchant capability array; refuse blind patch');
  }
  let next = text.replaceAll(LEGACY_ARRAY, GRANULAR_ARRAY);
  next = next.replace(
    "const created = await moovFetch('/accounts', {\n      method: 'POST',\n      scopes: scopes.accountsWrite(),\n      idempotencyKey,\n      fetchImpl,",
    "const created = await moovFetch('/accounts', {\n      method: 'POST',\n      scopes: scopes.accountsWrite(),\n      idempotencyKey,\n      apiVersion: 'v2025.07.00',\n      fetchImpl,",
  );
  if (!next.includes("apiVersion: 'v2025.07.00'")) {
    throw new Error('moov-functions.mjs account create was not pinned to v2025.07.00');
  }
  const needle = `    const flags = capabilityFlags(caps);
    const verification = remote?.profile?.business?.verification?.status ?? remote?.verification?.status ?? null;`;
  const insert = `    const flags = capabilityFlags(caps);
    const verification = remote?.profile?.business?.verification?.status ?? remote?.verification?.status ?? null;
    const missing = ${GRANULAR_ARRAY}.filter((id) => !(caps || []).some((c) => String(c.capability || '').toLowerCase() === id));
    if (missing.length > 0 && String(verification || '').toLowerCase() !== 'failed') {
      await moovFetch(\`/accounts/\${accountId}/capabilities\`, {
        method: 'POST', scopes: scopes.capabilitiesWrite(accountId),
        apiVersion: 'v2025.07.00', fetchImpl,
        body: { capabilities: missing },
      }).catch(() => {});
    }`;
  if (!next.includes(needle)) {
    throw new Error('live moov-functions.mjs sync block not found; refuse blind patch');
  }
  if (!next.includes('Requested required capabilities') && !next.includes('body: { capabilities: missing }')) {
    next = next.replace(needle, insert);
  }
  if (next.includes(LEGACY_ARRAY)) {
    throw new Error('legacy merchant capability array still present in moov-functions.mjs');
  }
  return next;
}

export function patchMoovOnboard(text) {
  if (!text.includes(LEGACY_ARRAY)) {
    throw new Error('live moov-onboard.mjs is missing the legacy merchant capability array; refuse blind patch');
  }
  let next = text.replaceAll(LEGACY_ARRAY, GRANULAR_ARRAY);
  next = next.replace(
    `    await moovFetch(\`/accounts/\${accountId}/capabilities\`, {
      method: 'POST', scopes: scopes.capabilitiesWrite(accountId),
      body: { capabilities: ${GRANULAR_ARRAY} }, fetchImpl,
    }).catch(() => {});`,
    `    await moovFetch(\`/accounts/\${accountId}/capabilities\`, {
      method: 'POST', scopes: scopes.capabilitiesWrite(accountId),
      apiVersion: 'v2025.07.00',
      body: { capabilities: ${GRANULAR_ARRAY} }, fetchImpl,
    }).catch(() => {});`,
  );
  next = next.replace(
    `    const invite = await moovFetch(\`/accounts/\${accountId}/onboarding-invites\`, {
      method: 'POST', scopes: scopes.accountWrite(accountId), fetchImpl,
      body: {
        returnURL: redirect,
        ...(feePlanCodes.length ? { feePlanCodes } : {}),
      },
    }).catch(async (e) => {
      const alt = await moovFetch(\`/accounts/\${platformId}/onboarding-invites\`, {
        method: 'POST', scopes: scopes.accountWrite(platformId), fetchImpl,
        body: { accountID: accountId, returnURL: redirect, ...(feePlanCodes.length ? { feePlanCodes } : {}) },
      }).catch(() => { throw e; });`,
    `    const invite = await moovFetch(\`/accounts/\${accountId}/onboarding-invites\`, {
      method: 'POST', scopes: scopes.accountWrite(accountId), fetchImpl,
      apiVersion: 'v2025.07.00',
      body: {
        returnURL: redirect,
        capabilities: ${GRANULAR_ARRAY},
        ...(feePlanCodes.length ? { feePlanCodes } : {}),
      },
    }).catch(async (e) => {
      const alt = await moovFetch(\`/accounts/\${platformId}/onboarding-invites\`, {
        method: 'POST', scopes: scopes.accountWrite(platformId), fetchImpl,
        apiVersion: 'v2025.07.00',
        body: { accountID: accountId, returnURL: redirect, capabilities: ${GRANULAR_ARRAY}, ...(feePlanCodes.length ? { feePlanCodes } : {}) },
      }).catch(() => { throw e; });`,
  );
  if (next.includes(LEGACY_ARRAY)) {
    throw new Error('legacy merchant capability array still present in moov-onboard.mjs');
  }
  return next;
}

export function patchMoovClient(text) {
  const from = `export function capabilityFlags(caps) {
  const byName = new Map((caps ?? []).map((c) => [c.capability, c.status]));
  const on = (name) => byName.get(name) === 'enabled';
  return {
    can_receive_payments: on('transfers') || on('collect-funds'),
    can_send_payments: on('transfers') || on('send-funds'),
    can_ach_debit: on('collect-funds'),
    can_ach_credit: on('send-funds'),`;
  const to = `export function capabilityFlags(caps) {
  const enabled = (wanted) => (caps ?? []).some((c) => {
    if (String(c.status || '').toLowerCase() !== 'enabled') return false;
    const name = String(c.capability || '').toLowerCase();
    const target = String(wanted).toLowerCase();
    return name === target || name.startsWith(target + '.');
  });
  return {
    can_receive_payments: enabled('transfers') || enabled('collect-funds'),
    can_send_payments: enabled('transfers') || enabled('send-funds'),
    can_ach_debit: enabled('collect-funds'),
    can_ach_credit: enabled('send-funds'),`;
  if (!text.includes(from)) {
    throw new Error('live moov-client.mjs capabilityFlags block not found; refuse blind patch');
  }
  return text.replace(from, to);
}

export function applyOverlayToUnpack(unpack) {
  const liveHashes = walkHashes(unpack);
  const files = {
    'providers/parity/moov-functions.mjs': patchMoovFunctions,
    'providers/parity/moov-onboard.mjs': patchMoovOnboard,
    'providers/parity/moov-client.mjs': patchMoovClient,
  };
  for (const [rel, patch] of Object.entries(files)) {
    const abs = path.join(unpack, rel);
    if (!fs.existsSync(abs)) throw new Error(`live package missing ${rel}`);
    fs.writeFileSync(abs, patch(fs.readFileSync(abs, 'utf8')));
  }
  const candidateHashes = walkHashes(unpack);
  const changed = Object.keys(liveHashes).filter((rel) => liveHashes[rel] !== candidateHashes[rel]).sort();
  const added = Object.keys(candidateHashes).filter((rel) => !liveHashes[rel]).sort();
  const deleted = Object.keys(liveHashes).filter((rel) => !candidateHashes[rel]).sort();
  const unexpected = [...changed, ...added, ...deleted].filter((rel) => !OWNED_MEMBERS.includes(rel));
  if (unexpected.length) {
    throw new Error(`overlay touched non-owned members: ${unexpected.join(', ')}`);
  }
  for (const rel of OWNED_MEMBERS) {
    if (liveHashes[rel] === candidateHashes[rel]) {
      throw new Error(`expected ${rel} to change`);
    }
  }
  return { liveHashes, candidateHashes, changed, added, deleted };
}

export function zipUnpack(unpack, destZip) {
  if (fs.existsSync(destZip)) fs.unlinkSync(destZip);
  execFileSync('zip', ['-qr', destZip, '.'], { cwd: unpack });
  return destZip;
}

function downloadLive(functionName, destZip, env = process.env) {
  const loc = execFileSync('aws', [
    '--region', env.AWS_REGION || 'us-east-1',
    'lambda', 'get-function',
    '--function-name', functionName,
    '--query', 'Code.Location',
    '--output', 'text',
  ], { encoding: 'utf8', env }).trim();
  execFileSync('curl', ['-fsSL', loc, '-o', destZip]);
}

export function main({
  liveZip = process.argv[2],
  outZip = process.argv[3],
  functionName = process.env.CHECKSOPS_LAMBDA_NAME || 'checksops-production-prep-api',
  env = process.env,
} = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'moov-granular-cap-'));
  const zipPath = liveZip || path.join(work, 'live.zip');
  if (!liveZip) downloadLive(functionName, zipPath, env);
  const unpack = path.join(work, 'unpack');
  fs.mkdirSync(unpack, { recursive: true });
  execFileSync('unzip', ['-q', zipPath, '-d', unpack]);
  const result = applyOverlayToUnpack(unpack);
  const dest = path.resolve(outZip || path.join(work, 'candidate.zip'));
  zipUnpack(unpack, dest);
  const summary = {
    function_name: functionName,
    out_zip: dest,
    owned_members: OWNED_MEMBERS,
    changed: result.changed,
    added: result.added,
    deleted: result.deleted,
    live_members: result.liveHashes,
    candidate_members: result.candidateHashes,
  };
  console.log(JSON.stringify({
    ok: true,
    out_zip: dest,
    changed: result.changed,
    added: result.added,
    deleted: result.deleted,
  }, null, 2));
  return summary;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) main();
