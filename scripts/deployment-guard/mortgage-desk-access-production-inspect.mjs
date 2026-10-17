#!/usr/bin/env node
/**
 * Official read-only production inspect of the Mortgage Desk access surface
 * (lib/mortgage-desk-access-inspect.mjs; runbook ops/production-mortgage-desk-access-inspect.md).
 *
 *   --inspect    the only accepted argument: BEGIN READ ONLY ... ROLLBACK of fixed catalog
 *                SELECTs (RLS, policies, grants, helper function hashes, triggers, SQL 99
 *                ownership). No table rows, no row counts, no writes.
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
import { resolveLedgerDatabaseUrl } from './lib/ledger-production-apply.mjs';
import { inspectMortgageDeskAccess, loadInspectConfig } from './lib/mortgage-desk-access-inspect.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { createProductionDatabaseConnect } from './lib/sql53-production-apply.mjs';

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  if (argv.length !== 1 || argv[0] !== '--inspect') {
    return printResult(fail(CODES.INVALID_MANIFEST, 'mortgage desk access inspect accepts exactly one argument: --inspect (read-only; there is no apply, input, credential or SQL argument)', {
      argument_count: argv.length,
    }));
  }
  const root = deps.root || repoRootFrom(import.meta.url);
  const config = deps.config || loadInspectConfig(root);
  if (config.read_only !== true || config.apply !== false || config.target_environment !== 'production') {
    return printResult(fail(CODES.INVALID_MANIFEST, 'mortgage desk access inspect configuration must be read_only true, apply false, production'));
  }
  let connect = deps.connect;
  if (typeof connect !== 'function') {
    const url = await (deps.resolveUrl || resolveLedgerDatabaseUrl)({ pin: config, getSecretValue: deps.getSecretValue });
    if (!url.ok) return printResult({ ok: false, code: url.code, message: url.message, details: {} });
    connect = createProductionDatabaseConnect(url.details.url, { root });
  }
  return printResult(await inspectMortgageDeskAccess({ connect, root, config, index: deps.index }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const code = await main();
  process.exitCode = typeof code === 'number' ? code : (code ? 0 : 1);
}
