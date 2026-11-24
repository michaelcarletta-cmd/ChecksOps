#!/usr/bin/env node
/**
 * Official read-only production inspect of one check whose endorsements are signed but which did
 * not advance to ready for deposit (lib/check-endorsement-state-inspect.mjs; runbook
 * ops/production-check-endorsement-state-inspect.md).
 *
 *   --inspect --check-id <uuid>
 *                the only accepted arguments: BEGIN READ ONLY ... ROLLBACK of fixed SELECTs
 *                (the check's status and image columns, its endorsements, CheckAlt deposits,
 *                composite audit rows and recent audit events) and the Lambda's own pure
 *                decisions on them. Labels and booleans only: no ids, names, amounts, paths,
 *                tokens or signature data; no writes; no S3 call.
 *
 * There is no apply, no --input and no SQL argument: any other argument, a repeated flag or a
 * check id that is not a uuid is refused before a secret is read or a connection is made.
 * Credentials come only from the pinned production checksops_admin secret (Secrets Manager,
 * through the VPC endpoint); no password is ever a flag, a file or an SSM command parameter.
 * Run only on the SQL53 runner with private reachability into the production VPC.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printResult } from './lib/cli.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { UUID_RE, inspectCheckEndorsementState, loadInspectConfig, safeErrorCode } from './lib/check-endorsement-state-inspect.mjs';
import { resolveLedgerDatabaseUrl } from './lib/ledger-production-apply.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { createProductionDatabaseConnect } from './lib/sql53-production-apply.mjs';

const USAGE = 'check endorsement state inspect accepts exactly: --inspect --check-id <uuid> (read-only; there is no apply, input, credential or SQL argument)';

/** The only output an unexpected error produces: structured JSON with the error's code. */
export function unexpectedErrorResult(error) {
  return fail(CODES.UNRELATED_MUTATION, 'check endorsement state inspect failed', { read_only: true, stage: 'entry', error_code: safeErrorCode(error) });
}

/**
 * Exactly `--inspect --check-id <uuid>` or `--check-id <uuid> --inspect`. Returns
 * { checkId } (lower case), { error: 'usage' } or { error: 'check_id_invalid' }.
 */
export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 3 || !argv.every((a) => typeof a === 'string')) return { error: 'usage' };
  let value;
  if (argv[0] === '--inspect' && argv[1] === '--check-id') value = argv[2];
  else if (argv[0] === '--check-id' && argv[2] === '--inspect') value = argv[1];
  else return { error: 'usage' };
  if (!UUID_RE.test(value)) return { error: 'check_id_invalid' };
  return { checkId: value.toLowerCase() };
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
  const args = parseArgs(argv);
  if (args.error === 'usage') {
    return printResult(fail(CODES.INVALID_MANIFEST, USAGE, { argument_count: Array.isArray(argv) ? argv.length : 0 }));
  }
  if (args.error) {
    // The value is not echoed.
    return printResult(fail(CODES.INVALID_MANIFEST, 'check endorsement state inspect: --check-id must be a uuid'));
  }
  const bypass = Object.keys(env || {}).filter((k) => k === 'CHECKSOPS_SKIP_DEPLOYMENT_GUARD' || k.startsWith('CHECKSOPS_DEPLOYMENT_GUARD_'));
  if (bypass.length) {
    return printResult(fail(CODES.INVALID_MANIFEST, 'check endorsement state inspect refuses to run with deployment-guard environment variables set', {
      variable_count: bypass.length,
    }));
  }
  const root = deps.root || repoRootFrom(import.meta.url);
  const config = deps.config || loadInspectConfig(root);
  if (config.read_only !== true || config.apply !== false || config.target_environment !== 'production') {
    return printResult(fail(CODES.INVALID_MANIFEST, 'check endorsement state inspect configuration must be read_only true, apply false, production'));
  }
  let connect = deps.connect;
  if (typeof connect !== 'function') {
    const url = await (deps.resolveUrl || resolveLedgerDatabaseUrl)({ pin: config, getSecretValue: deps.getSecretValue });
    if (!url.ok) return printResult({ ok: false, code: url.code, message: url.message, details: {} });
    connect = createProductionDatabaseConnect(url.details.url, { root });
  }
  return printResult(await inspectCheckEndorsementState({ connect, checkId: args.checkId }));
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
