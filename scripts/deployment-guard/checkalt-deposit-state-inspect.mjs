#!/usr/bin/env node
/**
 * Official read-only production inspect of CheckAlt deposit state: which checkalt_deposits rows
 * are stranded (provider_http_attempted_at set, checkalt_reference NULL, status queued, pending,
 * submitting or error), so every later Deposit press on their check answers
 * reconciliation_required (lib/checkalt-deposit-state-inspect.mjs; runbook
 * ops/production-checkalt-deposit-state-inspect.md).
 *
 *   --inspect    the only accepted argument: BEGIN READ ONLY ... ROLLBACK of fixed SELECTs
 *                (deposits by status, reference and HTTP attempt; one entry per stranded row with
 *                minute timestamps, code labels and its check's state; stranded rows by created
 *                date; the rows created in the last 2 days). No ids, names, amounts, references,
 *                error text or payload values; no writes.
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
import { inspectCheckAltDepositState, loadInspectConfig, safeErrorCode } from './lib/checkalt-deposit-state-inspect.mjs';
import { resolveLedgerDatabaseUrl } from './lib/ledger-production-apply.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { createProductionDatabaseConnect } from './lib/sql53-production-apply.mjs';

/** The only output an unexpected error produces: structured JSON with the error's code. */
export function unexpectedErrorResult(error) {
  return fail(CODES.UNRELATED_MUTATION, 'checkalt deposit state inspect failed', { read_only: true, stage: 'entry', error_code: safeErrorCode(error) });
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
    return printResult(fail(CODES.INVALID_MANIFEST, 'checkalt deposit state inspect accepts exactly one argument: --inspect (read-only; there is no apply, input, credential or SQL argument)', {
      argument_count: argv.length,
    }));
  }
  const bypass = Object.keys(env || {}).filter((k) => k === 'CHECKSOPS_SKIP_DEPLOYMENT_GUARD' || k.startsWith('CHECKSOPS_DEPLOYMENT_GUARD_'));
  if (bypass.length) {
    return printResult(fail(CODES.INVALID_MANIFEST, 'checkalt deposit state inspect refuses to run with deployment-guard environment variables set', {
      variable_count: bypass.length,
    }));
  }
  const root = deps.root || repoRootFrom(import.meta.url);
  const config = deps.config || loadInspectConfig(root);
  if (config.read_only !== true || config.apply !== false || config.target_environment !== 'production') {
    return printResult(fail(CODES.INVALID_MANIFEST, 'checkalt deposit state inspect configuration must be read_only true, apply false, production'));
  }
  let connect = deps.connect;
  if (typeof connect !== 'function') {
    const url = await (deps.resolveUrl || resolveLedgerDatabaseUrl)({ pin: config, getSecretValue: deps.getSecretValue });
    if (!url.ok) return printResult({ ok: false, code: url.code, message: url.message, details: {} });
    connect = createProductionDatabaseConnect(url.details.url, { root });
  }
  return printResult(await inspectCheckAltDepositState({ connect }));
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
