import fs from 'node:fs';
import path from 'node:path';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { receiptDir, leaseKey } from './paths.mjs';
import { inspectLease } from './lease.mjs';

export const RECEIPT_KIND = 'deployment-guard-receipt';
export const DEFAULT_RECEIPT_TTL_MS = 15 * 60 * 1000;
export const MAX_RECEIPT_TTL_MS = 60 * 60 * 1000;

export function receiptFile(root, environment, component) {
  const safe = leaseKey(environment, component).replace(/[^a-zA-Z0-9._:-]/g, '_');
  return path.join(receiptDir(root), `${safe}.json`);
}

export function buildReceipt(input = {}, { now = Date.now(), ttlMs = DEFAULT_RECEIPT_TTL_MS } = {}) {
  const issuedAt = new Date(now).toISOString();
  const expiry = new Date(now + Math.min(ttlMs, MAX_RECEIPT_TTL_MS)).toISOString();
  return {
    schema_version: 1,
    kind: RECEIPT_KIND,
    issued_at: issuedAt,
    expiry,
    workstream_id: input.workstream_id,
    branch: input.branch,
    commit: input.commit,
    operator: input.operator || null,
    target_environment: input.target_environment,
    target_component: input.target_component,
    deployment_type: input.deployment_type,
    owned_components: input.owned_components || input.owned_members || [],
    preflight_live_fingerprint: input.preflight_live_fingerprint || input.preflight || null,
    lease: input.lease || null,
  };
}

export function issueReceipt(root, input, opts = {}) {
  const receipt = buildReceipt(input, opts);
  const check = validateReceiptShape(receipt);
  if (!check.ok) return check;
  const file = receiptFile(root, receipt.target_environment, receipt.target_component);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return ok({ receipt, file });
}

export function readReceiptFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { corrupt: true, path: file };
  }
}

export function loadReceipt(root, spec = {}, env = process.env) {
  const fromEnv = spec.receipt_path || env.CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT;
  if (fromEnv) {
    const abs = path.isAbsolute(fromEnv) ? fromEnv : path.resolve(root, fromEnv);
    return { file: abs, receipt: readReceiptFile(abs) };
  }
  if (spec.receipt && typeof spec.receipt === 'object') {
    return { file: spec.receipt_file || null, receipt: spec.receipt };
  }
  if (spec.target_environment && spec.target_component) {
    const file = receiptFile(root, spec.target_environment, spec.target_component);
    return { file, receipt: readReceiptFile(file) };
  }
  return { file: null, receipt: null };
}

function validateReceiptShape(receipt) {
  const errors = [];
  if (!receipt || receipt.corrupt) {
    errors.push(errorEntry(CODES.DEPLOYMENT_GUARD_REQUIRED, 'deployment guard receipt is missing or corrupt'));
    return failMany(errors, CODES.DEPLOYMENT_GUARD_REQUIRED);
  }
  if (receipt.kind !== RECEIPT_KIND) {
    errors.push(errorEntry(CODES.DEPLOYMENT_GUARD_REQUIRED, 'file is not a deployment-guard receipt'));
  }
  if (!receipt.workstream_id) errors.push(errorEntry(CODES.ANONYMOUS_DEPLOYMENT, 'receipt missing workstream_id'));
  if (!/^[0-9a-f]{40}$/.test(String(receipt.commit || ''))) {
    errors.push(errorEntry(CODES.ANONYMOUS_DEPLOYMENT, 'receipt missing commit SHA'));
  }
  if (!receipt.target_environment) errors.push(errorEntry(CODES.INVALID_MANIFEST, 'receipt missing target_environment'));
  if (!receipt.target_component) errors.push(errorEntry(CODES.INVALID_MANIFEST, 'receipt missing target_component'));
  if (!receipt.deployment_type) errors.push(errorEntry(CODES.INVALID_MANIFEST, 'receipt missing deployment_type'));
  if (!receipt.preflight_live_fingerprint || typeof receipt.preflight_live_fingerprint !== 'object') {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'receipt missing preflight live fingerprint'));
  }
  if (!Array.isArray(receipt.owned_components) || receipt.owned_components.length === 0) {
    errors.push(errorEntry(CODES.INVALID_MANIFEST, 'receipt missing owned_components'));
  }
  if (!receipt.lease || typeof receipt.lease !== 'object') {
    errors.push(errorEntry(CODES.DEPLOYMENT_GUARD_REQUIRED, 'receipt missing lease; mutating deploys require a short-lived lease'));
  }
  if (!receipt.expiry) errors.push(errorEntry(CODES.RECEIPT_EXPIRED, 'receipt missing expiry'));
  if (errors.length) return failMany(errors, errors[0].code);
  return ok({ receipt });
}

export function validateReceipt(receipt, expected = {}, { now = Date.now(), root = null } = {}) {
  const shape = validateReceiptShape(receipt);
  if (!shape.ok) return shape;
  const errors = [];
  if (Date.parse(receipt.expiry) <= now) {
    errors.push(errorEntry(CODES.RECEIPT_EXPIRED, 'deployment guard receipt has expired', {
      expiry: receipt.expiry,
    }));
  }
  if (expected.workstream_id && expected.workstream_id !== receipt.workstream_id) {
    errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt belongs to another workstream', {
      receipt_workstream: receipt.workstream_id,
      requested_workstream: expected.workstream_id,
    }));
  }
  if (expected.commit && expected.commit !== receipt.commit) {
    errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt commit does not match this workstream commit', {
      receipt_commit: receipt.commit,
      requested_commit: expected.commit,
    }));
  }
  if (expected.target_environment && expected.target_environment !== receipt.target_environment) {
    errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt environment does not authorize this target', {
      receipt_environment: receipt.target_environment,
      requested_environment: expected.target_environment,
    }));
  }
  if (expected.target_component && expected.target_component !== receipt.target_component) {
    errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt component does not authorize this target (a Lambda receipt cannot authorize SPA)', {
      receipt_component: receipt.target_component,
      requested_component: expected.target_component,
    }));
  }
  if (expected.deployment_type && expected.deployment_type !== receipt.deployment_type) {
    errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt deployment_type does not authorize this mutation', {
      receipt_deployment_type: receipt.deployment_type,
      requested_deployment_type: expected.deployment_type,
    }));
  }
  if (receipt.target_environment === 'staging' && expected.target_environment === 'production') {
    errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'a staging receipt must not authorize production'));
  }
  if (expected.preflight_live_fingerprint) {
    const a = JSON.stringify(receipt.preflight_live_fingerprint);
    const b = JSON.stringify(expected.preflight_live_fingerprint);
    if (a !== b) {
      errors.push(errorEntry(CODES.DEPLOYMENT_COLLISION, 'receipt preflight fingerprint is stale versus current live fingerprint', {
        receipt_fingerprint: receipt.preflight_live_fingerprint,
        live_fingerprint: expected.preflight_live_fingerprint,
      }));
    }
  }
  if (receipt.lease) {
    if (receipt.lease.workstream_id !== receipt.workstream_id
      || receipt.lease.environment !== receipt.target_environment
      || receipt.lease.component !== receipt.target_component
      || receipt.lease.commit !== receipt.commit) {
      errors.push(errorEntry(CODES.RECEIPT_MISMATCH, 'receipt lease does not match receipt identity'));
    }
    if (root) {
      const liveLease = inspectLease(root, receipt.target_environment, receipt.target_component, now);
      if (!liveLease.ok) return liveLease;
      if (!liveLease.details.present || liveLease.details.expired) {
        errors.push(errorEntry(CODES.LEASE_EXPIRED, 'receipt lease is no longer active'));
      } else if (liveLease.details.lease.workstream_id !== receipt.workstream_id) {
        errors.push(errorEntry(CODES.LEASE_HELD, 'active lease belongs to another workstream'));
      }
    }
  }
  if (errors.length) {
    const code = errors.some((row) => row.code === CODES.DEPLOYMENT_COLLISION)
      ? CODES.DEPLOYMENT_COLLISION
      : errors[0].code;
    return failMany(errors, code);
  }
  return ok({ receipt });
}
