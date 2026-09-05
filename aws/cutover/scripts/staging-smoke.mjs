#!/usr/bin/env node
/**
 * Staging-safe smoke. Hits /health and optionally /ops/readiness.
 * Does not change DNS, auth, webhooks, or flags.
 * Live /ops/readiness 404 means this revision is not on the staging Lambda yet.
 */
import { readinessSnapshot, stagingSafetyHolds } from '../../functions/api/ops-readiness.mjs';

const base = (process.env.CHECKSOPS_API_URL || 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging').replace(/\/$/, '');

const get = async (path) => {
  const response = await fetch(`${base}${path}`, { method: 'GET' });
  let body = {};
  try { body = await response.json(); } catch { body = {}; }
  return { path, status: response.status, body };
};

const local = readinessSnapshot();
const localHolds = stagingSafetyHolds(local);
const health = await get('/health');
const readiness = await get('/ops/readiness');
const liveReadinessDeployed = readiness.status === 200 && readiness.body?.flags;
const liveHolds = liveReadinessDeployed
  ? (readiness.body.holds || stagingSafetyHolds(readiness.body))
  : null;

const report = {
  ok: health.status === 200 && localHolds.ok === true && health.body?.productionSupabaseChanged === false,
  apiBase: base,
  healthStatus: health.status,
  readinessStatus: readiness.status,
  liveReadinessDeployed: Boolean(liveReadinessDeployed),
  environment: health.body?.environment || local.environment,
  productionCutoverForbidden: local.productionCutoverForbidden,
  plaidRequired: local.plaidRequired,
  localFlags: local.flags,
  localHolds,
  liveHolds,
  productionSupabaseChanged: health.body?.productionSupabaseChanged === true,
};

console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
