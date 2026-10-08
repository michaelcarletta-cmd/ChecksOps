#!/usr/bin/env node
/**
 * Read-only staging evidence for the DB validator 503 / admin UI.
 * Fetches public HTTPS only. Never sends a token, never deploys, never writes AWS.
 */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { evaluatePreflight } from './cors-staging-live-probe.mjs';

export const STAGING_SPA_URL = 'https://staging.checksops.com/';
export const STAGING_API_URL = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging';
export const DB_VALIDATOR_PATH = '/db-readonly-validate';
export const ADMIN_ROUTE = '/admin/db-validator';
export const ALLOWED_ORIGIN = 'https://staging.checksops.com';
export const PUBLIC_VALIDATOR_FIELDS = Object.freeze(['service', 'status', 'readOnly']);

export function entryFromHtml(html) {
  const match = String(html || '').match(/\/assets\/index-[^"'\\\s]+\.js/);
  return match ? match[0] : null;
}

export function sha256Text(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export function evaluateSpaFingerprint({ html = '', bundleText = '', headers = {} } = {}) {
  const haystack = `${html}\n${bundleText}`;
  return {
    index_html_sha256: sha256Text(html),
    entry_bundle: entryFromHtml(html),
    admin_route_present: haystack.includes(ADMIN_ROUTE),
    validator_path_present: haystack.includes('/db-readonly-validate'),
    etag: headers.etag || headers.ETag || null,
    lastModified: headers['last-modified'] || headers.LastModified || null,
  };
}

export function evaluatePublicValidator({ status, body } = {}) {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const keys = Object.keys(record);
  return {
    status: status ?? null,
    reachable: Number(status) >= 200 && Number(status) < 500,
    redacted: keys.length > 0 && keys.every((key) => PUBLIC_VALIDATOR_FIELDS.includes(key)),
    publicUnhealthy: Number(status) === 503 && record.status === 'unhealthy',
    publicOk: Number(status) === 200 && record.status === 'ok',
  };
}

export function evaluateValidatorPreflight(response, origin = ALLOWED_ORIGIN) {
  const headers = response?.headers;
  const get = typeof headers?.get === 'function'
    ? (name) => headers.get(name)
    : (name) => headers?.[name] || headers?.[String(name).toLowerCase()] || null;
  const preflight = evaluatePreflight({
    status: response?.status,
    headers: { get },
  }, origin);
  const allowHeaders = String(get('access-control-allow-headers') || '').toLowerCase();
  const listed = allowHeaders.split(',').map((item) => item.trim()).filter(Boolean);
  return {
    ...preflight,
    authorizationAllowed: listed.includes('*') || listed.includes('authorization'),
  };
}

const headerMap = (headers) => {
  if (!headers) return {};
  if (typeof headers.entries === 'function') {
    return Object.fromEntries([...headers.entries()].map(([key, value]) => [String(key).toLowerCase(), value]));
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]));
};

async function fetchSafe(url, init, fetchImpl) {
  try {
    const response = await fetchImpl(url, { redirect: 'manual', ...init });
    const headers = headerMap(response.headers);
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      bodyText = '';
    }
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = null;
    }
    return { ok: true, status: response.status, headers, body, bodyText };
  } catch (error) {
    return {
      ok: false,
      status: null,
      headers: {},
      body: null,
      bodyText: '',
      error: error?.name === 'URLError' || error?.code ? String(error.code || error.name) : 'fetch_failed',
    };
  }
}

export async function collectReadonlyStatus({ fetchImpl = fetch } = {}) {
  const spa = await fetchSafe(STAGING_SPA_URL, { method: 'GET' }, fetchImpl);
  const entry = entryFromHtml(spa.bodyText);
  const bundle = entry
    ? await fetchSafe(new URL(entry, STAGING_SPA_URL).href, { method: 'GET' }, fetchImpl)
    : { ok: false, bodyText: '', headers: {} };
  const spaFingerprint = evaluateSpaFingerprint({
    html: spa.bodyText,
    bundleText: bundle.bodyText,
    headers: spa.headers,
  });
  const health = await fetchSafe(`${STAGING_API_URL}/health`, { method: 'GET' }, fetchImpl);
  const dbHealth = await fetchSafe(`${STAGING_API_URL}/db-health`, { method: 'GET' }, fetchImpl);
  const validator = await fetchSafe(`${STAGING_API_URL}${DB_VALIDATOR_PATH}`, { method: 'GET' }, fetchImpl);
  const preflightRaw = await fetchSafe(`${STAGING_API_URL}${DB_VALIDATOR_PATH}`, {
    method: 'OPTIONS',
    headers: {
      Origin: ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  }, fetchImpl);
  const publicValidator = evaluatePublicValidator({ status: validator.status, body: validator.body });
  const cors = evaluateValidatorPreflight({
    status: preflightRaw.status,
    headers: { get: (name) => preflightRaw.headers[String(name).toLowerCase()] || null },
  }, ALLOWED_ORIGIN);

  return {
    schema_version: 1,
    kind: 'staging-db-validator-readonly-status',
    writesAttempted: false,
    tokenSent: false,
    spa_reachable: spa.ok === true && Number(spa.status) >= 200 && Number(spa.status) < 400,
    spa_error: spa.ok ? null : (spa.error || 'unreachable'),
    spa: spaFingerprint,
    api_health_status: health.status,
    api_db_health_status: dbHealth.status,
    public_validator: publicValidator,
    cors: {
      reachable: cors.reachable,
      originAllowed: cors.originAllowed,
      getAllowed: cors.getAllowed,
      authorizationAllowed: cors.authorizationAllowed,
      status: cors.status,
    },
    live_admin_ui_proven: Boolean(spaFingerprint.admin_route_present),
    live_authenticated_diagnosis: 'blocked_until_approved_admin_get',
  };
}

export async function main({ fetchImpl = fetch, writeOutput = console.log } = {}) {
  const evidence = await collectReadonlyStatus({ fetchImpl });
  writeOutput(JSON.stringify(evidence, null, 2));
  if (!evidence.spa_reachable && evidence.spa_error) return 2;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
