/**
 * Guarded environment-variable change for a shared API Lambda.
 *
 * The overlay and rebuild paths never touch configuration. This path changes
 * only Environment.Variables, and only the keys a reviewed plan section lists
 * with their exact live and intended values. Every listed key must still hold
 * the recorded live value immediately before the write (or already hold the
 * intended value); anything else is DEPLOYMENT_COLLISION. Keys the plan does
 * not list are carried over untouched; nothing else in the configuration
 * (role, runtime, handler, memory, timeout, VPC) is ever sent.
 *
 * Pure functions only: no AWS, no network.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, GuardError, fail, ok } from './errors.mjs';

export const CONFIG_DEPLOYMENT_TYPE = 'lambda-config';
export const CONFIG_PLAN_REL = 'ops/deployment-guard/lambda-config-plan.json';
export const CONFIG_FUNCTIONS = Object.freeze({
  staging: 'checksops-staging-api',
  production: 'checksops-production-prep-api',
});
export const ENVIRONMENT_COMPONENT_PREFIX = 'environment@sha256:';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
// Values of these keys are credentials; they live in NoEcho parameters, never in a
// reviewed plan committed to git.
const SECRET_KEY_RE = /(SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|TOKEN|CREDENTIAL)/i;
const MAX_VALUE_LENGTH = 4096;

const TRANSIENT_CONFIGURATION_KEYS = new Set([
  'LastModified',
  'LastUpdateStatus',
  'LastUpdateStatusReason',
  'LastUpdateStatusReasonCode',
  'RevisionId',
  'State',
  'StateReason',
  'StateReasonCode',
  'ResponseMetadata',
  '$metadata',
]);

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

/** Hash of the whole configuration minus transient status fields. */
export function configurationSha256(configuration = {}) {
  const stable = Object.fromEntries(Object.entries(configuration).filter(([key]) => !TRANSIENT_CONFIGURATION_KEYS.has(key)));
  return sha256(stableJson(stable));
}

/** Environment.Variables as a plain string map, or a failure when the read was partial. */
export function liveVariablesOf(configuration = {}) {
  const environment = configuration.Environment || {};
  if (environment.Error) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'live Lambda environment could not be read completely', { error: environment.Error });
  }
  const variables = environment.Variables || {};
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)
    || Object.values(variables).some((value) => typeof value !== 'string')) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'live Lambda environment has an invalid shape');
  }
  return ok({ variables: { ...variables } });
}

export function isConfigKey(key) {
  return typeof key === 'string' && KEY_RE.test(key) && key.length <= 128;
}

export function isSecretLikeKey(key) {
  return SECRET_KEY_RE.test(String(key));
}

function validateValue(value, label) {
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) {
    throw new GuardError(CODES.INVALID_MANIFEST, `${label} must be a string of at most ${MAX_VALUE_LENGTH} characters`);
  }
}

function section(plan, environment) {
  const row = plan?.environments?.[environment];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'config plan has no section for this environment', { environment });
  }
  const obj = (value, label) => {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new GuardError(CODES.INVALID_MANIFEST, `config plan ${label} must be an object`, { environment });
    return value;
  };
  const set = {};
  for (const [key, entry] of Object.entries(obj(row.set, 'set'))) {
    if (!isConfigKey(key)) throw new GuardError(CODES.INVALID_MANIFEST, 'config plan key is invalid', { environment, key });
    if (isSecretLikeKey(key)) throw new GuardError(CODES.UNRELATED_MUTATION, 'config plan must not carry a credential-like key; those stay in NoEcho parameters', { environment, key });
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new GuardError(CODES.INVALID_MANIFEST, 'config plan set entry needs from and to', { environment, key });
    if (entry.from !== null) validateValue(entry.from, `config plan set.${key}.from`);
    validateValue(entry.to, `config plan set.${key}.to`);
    if (entry.from === entry.to) throw new GuardError(CODES.INVALID_MANIFEST, 'config plan set entry lists identical from and to; drop the entry', { environment, key });
    set[key] = { from: entry.from, to: entry.to };
  }
  const unset = {};
  for (const [key, from] of Object.entries(obj(row.unset, 'unset'))) {
    if (!isConfigKey(key)) throw new GuardError(CODES.INVALID_MANIFEST, 'config plan unset key is invalid', { environment, key });
    if (isSecretLikeKey(key)) throw new GuardError(CODES.UNRELATED_MUTATION, 'config plan must not carry a credential-like key', { environment, key });
    validateValue(from, `config plan unset.${key}`);
    if (set[key]) throw new GuardError(CODES.INVALID_MANIFEST, `config plan lists ${key} both in set and unset`, { environment });
    unset[key] = from;
  }
  return { function_name: row.function_name, status: row.status || null, set, unset };
}

/** Validated plan section (throws GuardError on an invalid key, value or shape). */
export function planSection(plan, environment) {
  return section(plan, environment);
}

export function loadConfigPlan(root, environment) {
  const plan = JSON.parse(fs.readFileSync(path.join(root, CONFIG_PLAN_REL), 'utf8'));
  const row = section(plan, environment);
  if (row.function_name !== CONFIG_FUNCTIONS[environment]) {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'config plan section targets a different function', { environment, function_name: row.function_name });
  }
  return row;
}

/** Canonical hash of the change a plan section describes; the receipt owns this. */
export function changeSha256(row) {
  return sha256(stableJson({ function_name: row.function_name, set: row.set, unset: row.unset }));
}

export function environmentComponent(hash) {
  if (!HEX64.test(String(hash || ''))) throw new GuardError(CODES.INVALID_MANIFEST, 'environment component needs the change SHA-256');
  return `${ENVIRONMENT_COMPONENT_PREFIX}${hash}`;
}

export function parseEnvironmentComponent(component) {
  if (typeof component !== 'string' || !component.startsWith(ENVIRONMENT_COMPONENT_PREFIX)) return null;
  const hash = component.slice(ENVIRONMENT_COMPONENT_PREFIX.length);
  return HEX64.test(hash) ? hash : null;
}

export function changeCount(row) {
  return Object.keys(row.set).length + Object.keys(row.unset).length;
}

/** The variables map the function must hold after the change. */
export function targetVariables(liveVariables, row) {
  const target = { ...liveVariables };
  for (const [key, entry] of Object.entries(row.set)) target[key] = entry.to;
  for (const key of Object.keys(row.unset)) delete target[key];
  return target;
}

/**
 * Classify every listed key against the live variables.
 * ok: { state: 'READY' | 'ALREADY_ACCEPTED', changes, target }
 * fail: DEPLOYMENT_COLLISION with the keys whose live value is neither the
 *       recorded live value nor the intended one; INVALID_MANIFEST when the
 *       section lists no change at all (the plan is still pending).
 */
export function evaluateConfigChange({ plan, environment, liveVariables }) {
  let row;
  try {
    row = planSection(plan, environment);
  } catch (error) {
    return fail(error?.code || CODES.INVALID_MANIFEST, error?.message || 'config plan is unreadable', error?.details || {});
  }
  if (!liveVariables || typeof liveVariables !== 'object') {
    return fail(CODES.DEPLOYMENT_COLLISION, 'live variables are required');
  }
  if (changeCount(row) === 0) {
    return fail(CODES.INVALID_MANIFEST, 'config plan section lists no change; fill it from an inspect run first', { environment, status: row.status });
  }
  const changes = [];
  const problems = [];
  let pending = 0;
  for (const [key, entry] of Object.entries(row.set)) {
    const present = Object.prototype.hasOwnProperty.call(liveVariables, key);
    const live = present ? liveVariables[key] : null;
    let status;
    if (present && live === entry.to) status = 'already_accepted';
    else if ((entry.from === null && !present) || (present && live === entry.from)) { status = 'ready'; pending += 1; }
    else status = 'collision';
    changes.push({ key, op: 'set', from: entry.from, to: entry.to, live, status });
    if (status === 'collision') problems.push({ code: CODES.DEPLOYMENT_COLLISION, reason: 'live_value_mismatch', key, expected_live: entry.from, live });
  }
  for (const [key, from] of Object.entries(row.unset)) {
    const present = Object.prototype.hasOwnProperty.call(liveVariables, key);
    const live = present ? liveVariables[key] : null;
    let status;
    if (!present) status = 'already_accepted';
    else if (live === from) { status = 'ready'; pending += 1; }
    else status = 'collision';
    changes.push({ key, op: 'unset', from, to: null, live, status });
    if (status === 'collision') problems.push({ code: CODES.DEPLOYMENT_COLLISION, reason: 'live_value_mismatch', key, expected_live: from, live });
  }
  if (problems.length) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'a listed key no longer holds its recorded live value; re-inspect and review the plan', { environment, problems, changes });
  }
  return ok({
    environment,
    state: pending === 0 ? 'ALREADY_ACCEPTED' : 'READY',
    change_sha256: changeSha256(row),
    changes,
    target: targetVariables(liveVariables, row),
  });
}
