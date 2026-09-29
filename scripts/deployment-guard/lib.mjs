/**
 * Shared deployment-guard helpers.
 *
 * Never calls AWS. Never applies SQL. Never uploads SPA objects.
 * All live I/O is injected by the caller; the default adapter refuses both
 * reads and writes so tests and CI stay fail-closed.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, fail, ok } from './codes.mjs';

export { CODES, fail, ok };

export const DEFAULT_PATHS = Object.freeze({
  targets: 'ops/deployment-guard/protected-targets.json',
  contracts: 'ops/deployment-guard/accepted-contracts.json',
  inventory: 'ops/deployment-guard/bypass-inventory.json',
  leases: 'ops/deployment-guard/.leases',
  receipts: 'ops/deployment-guard/.receipts',
});

export const GIT_SHA_RE = /^[0-9a-f]{40}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export const STALE_PACKAGE_SOURCES = Object.freeze([
  'saved_live_zip',
  'tmp_cache',
  'stale_dist',
  'previously_built_spa',
  'branch_local_full_lambda_package',
  'reused_old_package',
]);

export const FORBIDDEN_RECLAIM_ACTIONS = Object.freeze([
  'reclaim',
  'reclaim_staging',
  'reclaim_production',
  'restore_previous_dist',
  'restore_old_index',
  'put_old_index_back',
  'redeploy_old_baseline',
  'reuse_old_lambda_zip',
]);

export function repoRootFrom(metaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..', '..');
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256Text(text) {
  return sha256Buffer(Buffer.from(String(text), 'utf8'));
}

export function memberHash(content) {
  if (content == null) return null;
  if (typeof content === 'string') return sha256Text(content);
  if (Buffer.isBuffer(content)) return sha256Buffer(content);
  if (typeof content === 'object' && content.hash) return content.hash;
  return sha256Text(JSON.stringify(content));
}

export function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function loadGuardConfig(root = repoRootFrom(import.meta.url)) {
  const targetsPath = path.join(root, DEFAULT_PATHS.targets);
  const contractsPath = path.join(root, DEFAULT_PATHS.contracts);
  const inventoryPath = path.join(root, DEFAULT_PATHS.inventory);
  if (!fs.existsSync(targetsPath) || !fs.existsSync(contractsPath) || !fs.existsSync(inventoryPath)) {
    throw new Error('deployment-guard config is missing (fail closed)');
  }
  const targets = loadJson(targetsPath);
  const contracts = loadJson(contractsPath);
  const inventory = loadJson(inventoryPath);
  const errors = [];
  if (targets.fail_closed !== true) errors.push('protected-targets.json: fail_closed must be true');
  if (contracts.fail_closed !== true) errors.push('accepted-contracts.json: fail_closed must be true');
  if (inventory.fail_closed !== true) errors.push('bypass-inventory.json: fail_closed must be true');
  if (errors.length) {
    throw new Error(errors.join('\n'));
  }
  return { root, targets, contracts, inventory };
}

export function nowIso(clock = () => new Date()) {
  return clock().toISOString();
}

export function parseIso(value) {
  if (!ISO_TIMESTAMP_RE.test(String(value || ''))) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function createDisabledAws(log = []) {
  const wrap = (name, write) => (...args) => {
    log.push({ name, write, args });
    const error = new Error(write ? CODES.AWS_WRITE_FORBIDDEN : CODES.AWS_DISABLED);
    error.code = write ? CODES.AWS_WRITE_FORBIDDEN : CODES.AWS_DISABLED;
    throw error;
  };
  return {
    log,
    writes: () => log.filter((row) => row.write),
    reads: () => log.filter((row) => !row.write),
    getFunction: wrap('getFunction', false),
    getFunctionConfiguration: wrap('getFunctionConfiguration', false),
    updateFunctionCode: wrap('updateFunctionCode', true),
    updateFunctionConfiguration: wrap('updateFunctionConfiguration', true),
    putObject: wrap('putObject', true),
    deleteObject: wrap('deleteObject', true),
    syncBucket: wrap('syncBucket', true),
    createInvalidation: wrap('createInvalidation', true),
    applySql: wrap('applySql', true),
    replaceRpc: wrap('replaceRpc', true),
  };
}

export function assertNoReclaim(intent = {}) {
  const action = String(intent.action || intent.mode || '').trim();
  if (FORBIDDEN_RECLAIM_ACTIONS.includes(action)) {
    return fail(CODES.DEPLOYMENT_COLLISION, `reclaim/restore is forbidden: ${action}`, { intent });
  }
  if (intent.reclaim === true || intent.restore_previous_dist === true || intent.put_old_index_back === true) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'reclaim/restore flags are forbidden', { intent });
  }
  return ok({ intent });
}

export function assertFreshPackage(provenance = {}) {
  if (!provenance || typeof provenance !== 'object') {
    return fail(CODES.STALE_PACKAGE_REJECTED, 'package provenance is missing');
  }
  if (STALE_PACKAGE_SOURCES.includes(provenance.source)) {
    return fail(CODES.STALE_PACKAGE_REJECTED, `old package source rejected: ${provenance.source}`, { provenance });
  }
  if (provenance.from_tmp_cache === true || provenance.saved_live_zip === true
    || provenance.stale_dist === true || provenance.branch_local_full_lambda_package === true
    || provenance.previously_built_spa === true) {
    return fail(CODES.STALE_PACKAGE_REJECTED, 'cached or previously built package rejected', { provenance });
  }
  if (provenance.source !== 'live_download' && provenance.source !== 'fresh_clean_build') {
    return fail(CODES.STALE_PACKAGE_REJECTED, `deployment must begin from current live state or a fresh clean build (got ${provenance.source || 'unknown'})`, { provenance });
  }
  return ok({ provenance });
}

export function fingerprintsEqual(left, right, keys) {
  if (!left || !right) return false;
  return keys.every((key) => left[key] === right[key]);
}

export function lambdaFingerprint(row = {}) {
  return {
    codeSha256: row.CodeSha256 || row.codeSha256 || null,
    revisionId: row.RevisionId || row.revisionId || null,
    lastModified: row.LastModified || row.lastModified || null,
  };
}

export function writeReceipt(root, receipt, fsImpl = fs) {
  const dir = path.join(root, DEFAULT_PATHS.receipts);
  fsImpl.mkdirSync(dir, { recursive: true });
  const name = `${receipt.workstream_id || 'unknown'}-${receipt.build_timestamp || Date.now()}.json`
    .replace(/[^A-Za-z0-9._-]/g, '_');
  const file = path.join(dir, name);
  fsImpl.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return file;
}

export function applyEnvForbidden(env = process.env) {
  return env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY === '1'
    || env.CHECKSOPS_DEPLOYMENT_GUARD_AWS === '1';
}
