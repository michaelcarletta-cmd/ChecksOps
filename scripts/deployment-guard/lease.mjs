/**
 * Short-lived shared-environment deployment leases.
 *
 * Source work may proceed concurrently. Deployment to a shared target may not.
 * Leases are local repository files, never AWS locks. Expired leases are
 * detectable and replaceable so staging cannot stay locked forever.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODES,
  DEFAULT_PATHS,
  fail,
  ok,
  ISO_TIMESTAMP_RE,
  GIT_SHA_RE,
  nowIso,
  parseIso,
  repoRootFrom,
  sha256Text,
} from './lib.mjs';

export const DEFAULT_TTL_MS = 20 * 60 * 1000;
export const MAX_TTL_MS = 2 * 60 * 60 * 1000;

export function leaseKey({ environment, component }) {
  return `${environment}__${component}.json`;
}

export function leasePath(storeDir, spec) {
  return path.join(storeDir, leaseKey(spec));
}

export function defaultStoreDir(root = repoRootFrom(import.meta.url)) {
  return path.join(root, DEFAULT_PATHS.leases);
}

export function isExpired(lease, nowMs = Date.now()) {
  if (!lease) return true;
  const expiry = parseIso(lease.expires_at);
  if (expiry == null) return true;
  return expiry <= nowMs;
}

export function validateLeaseSpec(spec) {
  if (!spec?.workstream_id || String(spec.workstream_id).trim().length < 3) {
    return fail(CODES.ANONYMOUS_DEPLOYMENT, 'lease requires workstream_id');
  }
  if (!spec.component) return fail(CODES.INVALID_TARGET, 'lease requires component');
  if (!['staging', 'production'].includes(spec.environment)) {
    return fail(CODES.INVALID_TARGET, 'lease environment must be staging or production');
  }
  if (!GIT_SHA_RE.test(String(spec.commit || ''))) {
    return fail(CODES.ANONYMOUS_DEPLOYMENT, 'lease requires commit SHA');
  }
  return ok();
}

export function buildLease(spec, { clock = () => new Date(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const checked = validateLeaseSpec(spec);
  if (!checked.ok) return checked;
  const boundedTtl = Math.min(Math.max(1, Number(ttlMs) || DEFAULT_TTL_MS), MAX_TTL_MS);
  const acquired = clock();
  const expires = new Date(acquired.getTime() + boundedTtl);
  const lease = {
    workstream_id: spec.workstream_id,
    component: spec.component,
    environment: spec.environment,
    acquired_at: acquired.toISOString(),
    expires_at: expires.toISOString(),
    commit: spec.commit,
    operator: spec.operator || null,
    ttl_ms: boundedTtl,
  };
  if (!ISO_TIMESTAMP_RE.test(lease.acquired_at) || !ISO_TIMESTAMP_RE.test(lease.expires_at)) {
    return fail(CODES.INVALID_MANIFEST, 'lease timestamps are invalid');
  }
  lease.lease_id = sha256Text(`${lease.environment}:${lease.component}:${lease.workstream_id}:${lease.acquired_at}:${lease.commit}`);
  return ok({ lease });
}

export function readLease(storeDir, spec, fsImpl = fs) {
  const file = leasePath(storeDir, spec);
  if (!fsImpl.existsSync(file)) return null;
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    return { unreadable: true, path: file };
  }
}

export function reapExpired(storeDir, { nowMs = Date.now(), fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(storeDir)) return [];
  const reaped = [];
  for (const name of fsImpl.readdirSync(storeDir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(storeDir, name);
    let lease;
    try {
      lease = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    } catch {
      fsImpl.unlinkSync(file);
      reaped.push({ path: file, reason: 'unreadable' });
      continue;
    }
    if (isExpired(lease, nowMs)) {
      fsImpl.unlinkSync(file);
      reaped.push({ path: file, lease, reason: CODES.LEASE_EXPIRED });
    }
  }
  return reaped;
}

export function acquireLease(storeDir, spec, extras = {}) {
  const built = buildLease(spec, extras);
  if (!built.ok) return built;
  const fsImpl = extras.fsImpl || fs;
  fsImpl.mkdirSync(storeDir, { recursive: true });
  reapExpired(storeDir, { nowMs: extras.nowMs ?? Date.now(), fsImpl });
  const file = leasePath(storeDir, spec);
  const existing = readLease(storeDir, spec, fsImpl);
  if (existing && !existing.unreadable && !isExpired(existing, extras.nowMs ?? Date.now())) {
    if (existing.workstream_id === spec.workstream_id && existing.commit === spec.commit) {
      return ok({ lease: existing, renewed: false, same_holder: true });
    }
    return fail(CODES.LEASE_HELD, `active lease held by ${existing.workstream_id} for ${spec.environment}/${spec.component}`, {
      existing,
      requested: spec,
    });
  }
  if (existing) {
    try { fsImpl.unlinkSync(file); } catch { /* replace below */ }
  }
  try {
    fsImpl.writeFileSync(file, `${JSON.stringify(built.lease, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      const raced = readLease(storeDir, spec, fsImpl);
      return fail(CODES.LEASE_HELD, 'lease acquire lost the compare-and-swap', { existing: raced });
    }
    throw error;
  }
  return ok({ lease: built.lease, file });
}

export function releaseLease(storeDir, spec, extras = {}) {
  const fsImpl = extras.fsImpl || fs;
  const existing = readLease(storeDir, spec, fsImpl);
  if (!existing) return ok({ released: false, reason: 'missing' });
  if (existing.unreadable) {
    fsImpl.unlinkSync(existing.path);
    return ok({ released: true, reason: 'unreadable' });
  }
  if (spec.workstream_id && existing.workstream_id !== spec.workstream_id && !isExpired(existing, extras.nowMs ?? Date.now())) {
    return fail(CODES.LEASE_HELD, 'cannot release another workstream\'s active lease', { existing });
  }
  fsImpl.unlinkSync(leasePath(storeDir, spec));
  return ok({ released: true, previous: existing });
}

export function inspectLease(storeDir, spec, extras = {}) {
  const existing = readLease(storeDir, spec, extras.fsImpl || fs);
  if (!existing) return ok({ held: false, expired: false });
  if (existing.unreadable || isExpired(existing, extras.nowMs ?? Date.now())) {
    return ok({
      held: false,
      expired: true,
      code: CODES.LEASE_EXPIRED,
      existing,
    });
  }
  return ok({ held: true, expired: false, existing });
}

export function main(argv = process.argv.slice(2), extras = {}) {
  const root = extras.root || repoRootFrom(import.meta.url);
  const storeDir = extras.storeDir || defaultStoreDir(root);
  const action = argv[0] || 'status';
  const spec = {
    workstream_id: extras.workstream_id,
    component: extras.component,
    environment: extras.environment,
    commit: extras.commit,
    operator: extras.operator,
  };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('--') && argv[i + 1]) {
      spec[argv[i].slice(2).replace(/-/g, '_')] = argv[i + 1];
      i += 1;
    }
  }
  let result;
  if (action === 'acquire') result = acquireLease(storeDir, spec, extras);
  else if (action === 'release') result = releaseLease(storeDir, spec, extras);
  else if (action === 'reap') result = ok({ reaped: reapExpired(storeDir, extras) });
  else result = inspectLease(storeDir, spec, extras);
  const out = JSON.stringify(result, null, 2);
  if (!result.ok) {
    console.error(out);
    return 1;
  }
  console.log(out);
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
