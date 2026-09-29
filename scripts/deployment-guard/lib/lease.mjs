import fs from 'node:fs';
import path from 'node:path';
import { CODES, errorEntry, failMany, ok } from './errors.mjs';
import { leaseFile, leaseKey } from './paths.mjs';

export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;
export const MAX_LEASE_TTL_MS = 60 * 60 * 1000;

export function nowMs(now) {
  if (typeof now === 'number') return now;
  if (now) return Date.parse(now);
  return Date.now();
}

export function isExpired(lease, now = Date.now()) {
  if (!lease?.expiry) return true;
  return Date.parse(lease.expiry) <= nowMs(now);
}

export function readLease(root, environment, component) {
  const file = leaseFile(root, environment, component);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { corrupt: true, path: file };
  }
}

export function writeLease(root, lease) {
  const file = leaseFile(root, lease.environment, lease.component);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(lease, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

export function deleteLease(root, environment, component) {
  const file = leaseFile(root, environment, component);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function inspectLease(root, environment, component, now = Date.now()) {
  const lease = readLease(root, environment, component);
  if (!lease) {
    return ok({ present: false, expired: false, lease: null, key: leaseKey(environment, component) });
  }
  if (lease.corrupt) {
    return failMany([errorEntry(CODES.LEASE_EXPIRED, 'lease file is corrupt and must be treated as stale/expired', lease)], CODES.LEASE_EXPIRED);
  }
  const expired = isExpired(lease, now);
  return ok({
    present: true,
    expired,
    lease,
    key: leaseKey(environment, component),
    status: expired ? 'expired' : 'active',
  });
}

export function acquireLease(root, input = {}, now = Date.now()) {
  const workstreamId = String(input.workstream_id || '').trim();
  const component = String(input.component || '').trim();
  const environment = String(input.target_environment || input.environment || '').trim();
  const commit = String(input.commit || '').trim();
  const ttl = Math.min(Number(input.ttl_ms || DEFAULT_LEASE_TTL_MS), MAX_LEASE_TTL_MS);
  if (!workstreamId || !component || !environment || !/^[0-9a-f]{40}$/.test(commit)) {
    return failMany([errorEntry(CODES.ANONYMOUS_DEPLOYMENT, 'lease acquire requires workstream_id, component, environment, and commit SHA')], CODES.ANONYMOUS_DEPLOYMENT);
  }

  const current = inspectLease(root, environment, component, now);
  if (!current.ok) return current;
  if (current.details.present && !current.details.expired) {
    const holder = current.details.lease;
    if (holder.workstream_id !== workstreamId) {
      return failMany([errorEntry(
        CODES.LEASE_HELD,
        `active deployment lease is held by ${holder.workstream_id}; concurrent deploy of ${environment}/${component} is blocked. Source work may continue.`,
        {
          holder: holder.workstream_id,
          component,
          environment,
          acquired_at: holder.acquired_at,
          expiry: holder.expiry,
          commit: holder.commit,
        },
      )], CODES.LEASE_HELD);
    }
  }

  const acquiredAt = new Date(nowMs(now)).toISOString();
  const expiry = new Date(nowMs(now) + ttl).toISOString();
  const lease = {
    workstream_id: workstreamId,
    component,
    environment,
    acquired_at: acquiredAt,
    expiry,
    commit,
    operator: input.operator || null,
    replaced_expired: Boolean(current.details.present && current.details.expired),
    previous_workstream: current.details.present && current.details.expired ? current.details.lease.workstream_id : null,
  };
  const file = writeLease(root, lease);
  return ok({ lease, file, acquired: true });
}

export function releaseLease(root, input = {}, now = Date.now()) {
  const environment = input.target_environment || input.environment;
  const component = input.component;
  const current = inspectLease(root, environment, component, now);
  if (!current.ok) return current;
  if (!current.details.present) return ok({ released: false, reason: 'not_present' });
  const holder = current.details.lease;
  if (!current.details.expired && holder.workstream_id !== input.workstream_id) {
    return failMany([errorEntry(CODES.LEASE_HELD, 'cannot release another workstream’s active lease', {
      holder: holder.workstream_id,
    })], CODES.LEASE_HELD);
  }
  deleteLease(root, environment, component);
  return ok({ released: true, expired: current.details.expired, lease: holder });
}
