#!/usr/bin/env node
/**
 * Official production entry for ledger migration 20261007193200.
 *
 *   --inspect                 read-only catalog (BEGIN READ ONLY ... ROLLBACK)
 *   --apply --input <file>    receipt-gated replace; requires
 *                             CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1, a preflight receipt,
 *                             the authorization phrase and a single-use id
 *
 * Run only on a host with private reachability into the production VPC
 * (see ops/production-ledger-apply.md). Never from GitHub-hosted runners or Lambda.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { consumeReceiptOnce } from './lib/consumed-receipts.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { enforceScriptGuard } from './require-guard.mjs';
import {
  LEDGER_PRODUCTION_COMPONENT,
  LEDGER_PRODUCTION_DEPLOYMENT_TYPE,
  createProductionDatabaseConnect,
  evaluateLedgerProductionApply,
  executeLedgerProductionApply,
  inspectLedgerProduction,
  loadLedgerProductionPin,
  resolveLedgerDatabaseUrl,
} from './lib/ledger-production-apply.mjs';

async function connectFactory(pin, root, deps) {
  if (typeof deps.connect === 'function') return { ok: true, connect: deps.connect };
  const url = await (deps.resolveUrl || resolveLedgerDatabaseUrl)({ pin, getSecretValue: deps.getSecretValue });
  if (!url.ok) return url;
  return { ok: true, connect: createProductionDatabaseConnect(url.details.url, { root }) };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const root = deps.root || repoRootFrom(import.meta.url);
  const pin = deps.pin || loadLedgerProductionPin(root);
  const { flags, opts } = parseArgs(argv);

  if (flags.has('inspect')) {
    const factory = await connectFactory(pin, root, deps);
    if (!factory.ok) return printResult(factory);
    return printResult(await inspectLedgerProduction({ connect: factory.connect, pin }));
  }

  const input = readInput(opts, {});
  if (input.sql_text || input.sql || input.statement || input.arbitrary_sql) {
    return printResult(fail(CODES.UNRELATED_MUTATION, 'arbitrary SQL text is forbidden; only the pinned ledger file may be applied'));
  }
  const payload = {
    ...input,
    target_environment: 'production',
    target_component: LEDGER_PRODUCTION_COMPONENT,
    deployment_type: LEDGER_PRODUCTION_DEPLOYMENT_TYPE,
  };
  const evaluation = evaluateLedgerProductionApply(payload, { root, pin });
  if (!evaluation.ok) return printResult(evaluation);
  if (!flags.has('apply')) return printResult(evaluation);

  const authorized = (deps.enforceScriptGuard || enforceScriptGuard)({
    script: import.meta.url,
    workstream_id: payload.workstream_id,
    commit: payload.commit,
    target_environment: 'production',
    target_component: LEDGER_PRODUCTION_COMPONENT,
    deployment_type: LEDGER_PRODUCTION_DEPLOYMENT_TYPE,
    preflight_live_fingerprint: payload.preflight_live_fingerprint,
    receipt_path: opts.receipt || env.CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT || payload.receipt_path,
  }, { root, env });
  if (authorized?.ok === false) return printResult(authorized);
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return printResult(fail(CODES.GUARD_APPLY_FORBIDDEN, 'ledger production apply is blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1'));
  }
  if (authorized?.details?.receipt) {
    const consumed = (deps.consumeReceiptOnce || consumeReceiptOnce)(root, authorized.details.receipt, {
      actor: payload.operator || null,
      script: 'ledger-production-apply',
    });
    if (!consumed.ok) return printResult(consumed);
  }

  const factory = await connectFactory(pin, root, deps);
  if (!factory.ok) return printResult(factory);
  return printResult(await executeLedgerProductionApply(payload, {
    root,
    pin,
    connect: factory.connect,
    consumedPath: deps.consumedPath,
  }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const code = await main();
  process.exitCode = typeof code === 'number' ? code : (code ? 0 : 1);
}
