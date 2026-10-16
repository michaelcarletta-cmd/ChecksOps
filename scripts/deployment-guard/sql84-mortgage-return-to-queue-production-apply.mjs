#!/usr/bin/env node
/**
 * Official production entry for SQL 84 (Mortgage Ops Return to Queue;
 * aws/workflows/sql/84_mortgage_return_to_queue.sql).
 *
 *   --inspect
 *       read-only catalog (BEGIN READ ONLY ... ROLLBACK): the login, the SQL 47
 *       prerequisites, return_mortgage_handling_request_to_queue (present from Cursor
 *       SQL 48 or not, arguments, owner, proacl, definition hash and label), the
 *       check_billing_events per-check unique indexes (name, predicate, valid, whether
 *       each satisfies GATE 0), duplicate non-voided per-check Mortgage Ops events
 *       (count and check ids), the mortgage_ops_request_audit table (present, columns,
 *       RLS, grants, policies, indexes), the failed production preconditions and
 *       apply_preconditions_met
 *   --apply --input <file>
 *       receipt-gated apply; requires CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1, a
 *       preflight receipt owning the pinned file, a pin with execute: true and a
 *       recorded pre-apply live hash, the pin's staging acceptance reference, its
 *       authorization phrase and a single-use id
 *
 * The database credentials come only from the pinned production admin secret
 * (Secrets Manager, through the VPC endpoint); no password is ever a flag or a file.
 * Run only on a host with private reachability into the production VPC
 * (see ops/production-sql-84-86-apply.md). Never from GitHub-hosted runners or Lambda.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { consumeReceiptOnce } from './lib/consumed-receipts.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { enforceScriptGuard } from './require-guard.mjs';
import {
  SQL84_PRODUCTION_COMPONENT,
  SQL84_PRODUCTION_DEPLOYMENT_TYPE,
  createProductionDatabaseConnect,
  evaluateSql84ProductionApply,
  executeSql84ProductionApply,
  inspectSql84Production,
  loadSql84ProductionPin,
  precheckSql84ProductionApply,
  resolveSql84DatabaseUrl,
} from './lib/sql84-mortgage-return-to-queue-production-apply.mjs';

async function connectFactory(pin, root, deps) {
  if (typeof deps.connect === 'function') return { ok: true, connect: deps.connect };
  const url = await (deps.resolveUrl || resolveSql84DatabaseUrl)({ pin, getSecretValue: deps.getSecretValue });
  if (!url.ok) return url;
  return { ok: true, connect: createProductionDatabaseConnect(url.details.url, { root }) };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const root = deps.root || repoRootFrom(import.meta.url);
  const { flags, opts } = parseArgs(argv);
  const pin = deps.pin || loadSql84ProductionPin(root);

  if (flags.has('inspect')) {
    const factory = await connectFactory(pin, root, deps);
    if (!factory.ok) return printResult(factory);
    return printResult(await inspectSql84Production({ connect: factory.connect, pin, root }));
  }

  const input = readInput(opts, {});
  if (input.sql_text || input.sql || input.statement || input.arbitrary_sql) {
    return printResult(fail(CODES.UNRELATED_MUTATION, 'arbitrary SQL text is forbidden; only the pinned SQL 84 file may be applied'));
  }
  const payload = {
    ...input,
    target_environment: 'production',
    target_component: SQL84_PRODUCTION_COMPONENT,
    deployment_type: SQL84_PRODUCTION_DEPLOYMENT_TYPE,
  };
  const evaluation = await evaluateSql84ProductionApply(payload, { root, pin });
  if (!evaluation.ok) return printResult(evaluation);
  if (!flags.has('apply')) return printResult(evaluation);

  const authorized = (deps.enforceScriptGuard || enforceScriptGuard)({
    script: import.meta.url,
    workstream_id: payload.workstream_id,
    commit: payload.commit,
    target_environment: 'production',
    target_component: SQL84_PRODUCTION_COMPONENT,
    deployment_type: SQL84_PRODUCTION_DEPLOYMENT_TYPE,
    preflight_live_fingerprint: payload.preflight_live_fingerprint,
    receipt_path: opts.receipt || env.CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT || payload.receipt_path,
  }, { root, env });
  if (authorized?.ok === false) return printResult(authorized);
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return printResult(fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 84 production apply is blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1'));
  }
  const receipt = authorized?.details?.receipt;
  if (!receipt || !(receipt.owned_components || []).includes(pin.filename)) {
    return printResult(fail(CODES.RECEIPT_MISMATCH, 'receipt does not own the pinned SQL 84 migration', { required_component: pin.filename }));
  }
  // Spend the single-use receipt only after the execute, phrase, one_use_id and replay checks pass.
  const precheck = await precheckSql84ProductionApply(payload, { root, pin, consumedPath: deps.consumedPath });
  if (!precheck.ok) return printResult(precheck);
  // Resolve the secret and prove the production host before spending the receipt (no DB connection yet).
  const factory = await connectFactory(pin, root, deps);
  if (!factory.ok) return printResult(factory);
  const consumed = (deps.consumeReceiptOnce || consumeReceiptOnce)(root, receipt, {
    actor: payload.operator || null,
    script: 'sql84-mortgage-return-to-queue-production-apply',
  });
  if (!consumed.ok) return printResult(consumed);

  return printResult(await executeSql84ProductionApply(payload, {
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
