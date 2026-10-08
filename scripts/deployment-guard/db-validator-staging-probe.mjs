#!/usr/bin/env node
/**
 * Read-only CORS and public-body evaluator for GET /db-readonly-validate.
 * Never mutates AWS, never sends credentials, never applies a SPA.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_ORIGIN,
  evaluatePreflight,
} from './cors-staging-live-probe.mjs';
import {
  DB_VALIDATOR_ROUTE,
  DB_VALIDATOR_STAGING_API,
  DB_VALIDATOR_STAGING_ORIGIN,
  DB_VALIDATOR_UI_PATH,
  publicBodyIsRedacted,
} from './lib/db-validator-auth-contract.mjs';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { ok, fail, CODES } from './lib/errors.mjs';

export const STAGING_PAGE_URL = `${DB_VALIDATOR_STAGING_ORIGIN}${DB_VALIDATOR_UI_PATH}`;
export const STAGING_VALIDATE_URL = `${DB_VALIDATOR_STAGING_API}${DB_VALIDATOR_ROUTE}`;

export function evaluateDbValidatorCors(observations = {}) {
  const origin = observations.origin || ALLOWED_ORIGIN || DB_VALIDATOR_STAGING_ORIGIN;
  const preflight = observations.preflight
    ? evaluatePreflight(observations.preflight, origin)
    : null;
  const publicGet = observations.publicGet || null;
  const redacted = publicGet ? publicBodyIsRedacted(publicGet.body) : false;
  const publicStatusOk = publicGet
    ? publicGet.status === 200 || publicGet.status === 503
    : false;
  const authorizationRequested = Boolean(observations.preflightRequestHeaders?.includes('authorization'));

  return {
    origin,
    route: DB_VALIDATOR_ROUTE,
    preflight,
    cors_get_and_origin_ok: Boolean(preflight?.reachable && preflight?.originAllowed && preflight?.getAllowed),
    public_get_redacted: redacted && publicStatusOk,
    authorization_requested: authorizationRequested,
    authenticated_details_not_probed: true,
    writes_attempted: false,
  };
}

export function evaluateLivePageBundle({ html = '', javascript = '' } = {}) {
  const entry = String(html || '').match(/\/assets\/index-[^"'\\\s]+/)?.[0] || null;
  const sources = `${html}\n${javascript}`;
  const hasRoute = sources.includes(DB_VALIDATOR_UI_PATH) || sources.includes('AdminDbValidator');
  return {
    entry_bundle: entry,
    has_db_validator_route: hasRoute,
    blocker: hasRoute ? null : 'live_spa_missing_db_validator_route',
    writes_attempted: false,
  };
}

export async function probeLive({ fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      Origin: DB_VALIDATOR_STAGING_ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    };
    const preflightRes = await fetchImpl(STAGING_VALIDATE_URL, {
      method: 'OPTIONS',
      redirect: 'manual',
      headers,
      signal: controller.signal,
    });
    const publicRes = await fetchImpl(STAGING_VALIDATE_URL, {
      method: 'GET',
      redirect: 'manual',
      headers: { Origin: DB_VALIDATOR_STAGING_ORIGIN, accept: 'application/json' },
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await publicRes.json();
    } catch {
      body = null;
    }
    return {
      ok: true,
      observations: {
        origin: DB_VALIDATOR_STAGING_ORIGIN,
        preflightRequestHeaders: 'authorization',
        preflight: { status: preflightRes.status, headers: preflightRes.headers },
        publicGet: { status: publicRes.status, body },
      },
    };
  } catch (error) {
    return {
      ok: false,
      blocker: 'staging_hosts_unreachable',
      error: String(error?.message || error).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function evaluateProbeCommand(opts = {}) {
  if (opts.live === true || opts.live === 'true') {
    return fail(
      CODES.GUARD_NO_AWS,
      'live HTTP probe is operator-only; this command evaluates fixtures and never reaches AWS by default',
    );
  }
  const evaluated = evaluateDbValidatorCors(readInput(opts, {
    origin: DB_VALIDATOR_STAGING_ORIGIN,
    preflightRequestHeaders: 'authorization',
  }));
  return ok({
    ...evaluated,
    apply_forbidden: true,
    authenticated_details_not_probed: true,
  });
}

export function main(argv = process.argv.slice(2)) {
  return printResult(evaluateProbeCommand(parseArgs(argv).opts));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
