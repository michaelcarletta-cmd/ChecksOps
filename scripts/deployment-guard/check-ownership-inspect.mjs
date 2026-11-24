#!/usr/bin/env node
/**
 * Official read-only production inspect of check ownership: how many checks have a tenant_id,
 * uploaded_by, tenant_users membership or image path scope that keeps their own uploader from
 * writing them (lib/check-ownership-inspect.mjs; runbook ops/production-check-ownership-inspect.md).
 *
 *   --inspect    the only accepted argument: BEGIN READ ONLY ... ROLLBACK of fixed SELECTs
 *                (checks by ownership class, uploader's tenant count, deposited, created month,
 *                status and stage, claim organization and image path scope). Counts only: no
 *                ids, names, amounts or paths; no writes.
 *
 * There is no apply, no --input and no SQL argument: any other argument is refused before a
 * secret is read or a connection is made. Credentials come only from the pinned production
 * checksops_admin secret (Secrets Manager, through the VPC endpoint); no password is ever a
 * flag, a file or an SSM command parameter. Run only on the SQL53 runner with private
 * reachability into the production VPC.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printResult } from './lib/cli.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { inspectCheckOwnership, loadInspectConfig, safeErrorCode } from './lib/check-ownership-inspect.mjs';
import { resolveLedgerDatabaseUrl } from './lib/ledger-production-apply.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { createProductionDatabaseConnect } from './lib/sql53-production-apply.mjs';

/** The only output an unexpected error produces: structured JSON with the error's code. */
export function unexpectedErrorResult(error) {
  return fail(CODES.UNRELATED_MUTATION, 'check ownership inspect failed', { read_only: true, stage: 'entry', error_code: safeErrorCode(error) });
}

/** main() that never throws: any error is printed as unexpectedErrorResult only. */
export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  try {
    return await runInspect(argv, env, deps);
  } catch (error) {
    return printResult(unexpectedErrorResult(error));
  }
}

async function runInspect(argv, env, deps) {
  if (argv.length !== 1 || argv[0] !== '--inspect') {
    return printResult(fail(CODES.INVALID_MANIFEST, 'check ownership inspect accepts exactly one argument: --inspect (read-only; there is no apply, input, credential or SQL argument)', {
      argument_count: argv.length,
    }));
  }
  const bypass = Object.keys(env || {}).filter((k) => k === 'CHECKSOPS_SKIP_DEPLOYMENT_GUARD' || k.startsWith('CHECKSOPS_DEPLOYMENT_GUARD_'));
  if (bypass.length) {
    return printResult(fail(CODES.INVALID_MANIFEST, 'check ownership inspect refuses to run with deployment-guard environment variables set', {
      variable_count: bypass.length,
    }));
  }
  const root = deps.root || repoRootFrom(import.meta.url);
  const config = deps.config || loadInspectConfig(root);
  if (config.read_only !== true || config.apply !== false || config.target_environment !== 'production') {
    return printResult(fail(CODES.INVALID_MANIFEST, 'check ownership inspect configuration must be read_only true, apply false, production'));
  }
  let connect = deps.connect;
  if (typeof connect !== 'function') {
    const url = await (deps.resolveUrl || resolveLedgerDatabaseUrl)({ pin: config, getSecretValue: deps.getSecretValue });
    if (!url.ok) return printResult({ ok: false, code: url.code, message: url.message, details: {} });
    connect = createProductionDatabaseConnect(url.details.url, { root });
  }
  return printResult(await inspectCheckOwnership({ connect }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  // Nothing but the structured JSON error may reach the terminal: no stack, host or message,
  // including for an error a socket emits after main() has settled.
  const report = (error) => {
    try { process.stderr.write(`${JSON.stringify(unexpectedErrorResult(error))}\n`); } catch { /* nothing else may be printed */ }
    process.exitCode = 1;
  };
  process.on('uncaughtException', report);
  process.on('unhandledRejection', report);
  let code = 1;
  try {
    code = await main();
  } catch (error) {
    report(error);
  }
  process.exitCode = process.exitCode === 1 ? 1 : (typeof code === 'number' ? code : (code ? 0 : 1));
}
