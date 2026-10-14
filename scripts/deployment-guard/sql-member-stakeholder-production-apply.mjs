#!/usr/bin/env node
/**
 * Official production entry for SQL 77, 78 and 79 (check stakeholder writes).
 * Apply them in that order; each refuses while its predecessor is not applied.
 *
 *   --migration sql77|sql78|sql79 --inspect
 *       read-only catalog (BEGIN READ ONLY ... ROLLBACK): dependencies,
 *       predecessors, the live fingerprint and apply_preconditions_met
 *   --migration sql77|sql78|sql79 --apply --input <file>
 *       receipt-gated apply; requires CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1, a
 *       preflight receipt owning the pinned file, a pin with execute: true,
 *       the pin's authorization phrase and a single-use id
 *
 * Run only on a host with private reachability into the production VPC
 * (see ops/production-sql-77-79-apply.md). Never from GitHub-hosted runners or Lambda.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { consumeReceiptOnce } from './lib/consumed-receipts.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { enforceScriptGuard } from './require-guard.mjs';
import {
  MEMBER_STAKEHOLDER_PRODUCTION_COMPONENT,
  MEMBER_STAKEHOLDER_PRODUCTION_DEPLOYMENT_TYPE,
  createProductionDatabaseConnect,
  evaluateMemberStakeholderProductionApply,
  executeMemberStakeholderProductionApply,
  inspectMemberStakeholderProduction,
  loadMemberStakeholderProductionPin,
  memberStakeholderMigration,
  precheckMemberStakeholderProductionApply,
  resolveMemberStakeholderDatabaseUrl,
} from './lib/sql-member-stakeholder-production-apply.mjs';

async function connectFactory(pin, root, deps) {
  if (typeof deps.connect === 'function') return { ok: true, connect: deps.connect };
  const url = await (deps.resolveUrl || resolveMemberStakeholderDatabaseUrl)({ pin, getSecretValue: deps.getSecretValue });
  if (!url.ok) return url;
  return { ok: true, connect: createProductionDatabaseConnect(url.details.url, { root }) };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const root = deps.root || repoRootFrom(import.meta.url);
  const { flags, opts } = parseArgs(argv);
  const migration = typeof opts.migration === 'string' ? opts.migration : null;
  const resolved = memberStakeholderMigration(migration);
  if (!resolved.ok) return printResult(resolved);
  const { spec } = resolved.details;
  const pin = deps.pin || loadMemberStakeholderProductionPin(migration, root);

  if (flags.has('inspect')) {
    const factory = await connectFactory(pin, root, deps);
    if (!factory.ok) return printResult(factory);
    return printResult(await inspectMemberStakeholderProduction({ connect: factory.connect, migration, pin, pins: deps.pins, root }));
  }

  const input = readInput(opts, {});
  if (input.sql_text || input.sql || input.statement || input.arbitrary_sql) {
    return printResult(fail(CODES.UNRELATED_MUTATION, `arbitrary SQL text is forbidden; only the pinned ${spec.label} file may be applied`));
  }
  const payload = {
    ...input,
    target_environment: 'production',
    target_component: MEMBER_STAKEHOLDER_PRODUCTION_COMPONENT,
    deployment_type: MEMBER_STAKEHOLDER_PRODUCTION_DEPLOYMENT_TYPE,
  };
  const evaluation = await evaluateMemberStakeholderProductionApply(payload, { root, migration, pin });
  if (!evaluation.ok) return printResult(evaluation);
  if (!flags.has('apply')) return printResult(evaluation);

  const authorized = (deps.enforceScriptGuard || enforceScriptGuard)({
    script: import.meta.url,
    workstream_id: payload.workstream_id,
    commit: payload.commit,
    target_environment: 'production',
    target_component: MEMBER_STAKEHOLDER_PRODUCTION_COMPONENT,
    deployment_type: MEMBER_STAKEHOLDER_PRODUCTION_DEPLOYMENT_TYPE,
    preflight_live_fingerprint: payload.preflight_live_fingerprint,
    receipt_path: opts.receipt || env.CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT || payload.receipt_path,
  }, { root, env });
  if (authorized?.ok === false) return printResult(authorized);
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return printResult(fail(CODES.GUARD_APPLY_FORBIDDEN, `${spec.label} production apply is blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1`));
  }
  const receipt = authorized?.details?.receipt;
  if (!receipt || !(receipt.owned_components || []).includes(pin.filename)) {
    return printResult(fail(CODES.RECEIPT_MISMATCH, `receipt does not own the pinned ${spec.label} migration`, { required_component: pin.filename }));
  }
  // Spend the single-use receipt only after the execute, phrase, one_use_id and replay checks pass.
  const precheck = await precheckMemberStakeholderProductionApply(payload, { root, migration, pin, consumedPath: deps.consumedPath });
  if (!precheck.ok) return printResult(precheck);
  // Resolve the secret and prove the production host before spending the receipt (no DB connection yet).
  const factory = await connectFactory(pin, root, deps);
  if (!factory.ok) return printResult(factory);
  const consumed = (deps.consumeReceiptOnce || consumeReceiptOnce)(root, receipt, {
    actor: payload.operator || null,
    script: `sql-member-stakeholder-production-apply:${spec.key}`,
  });
  if (!consumed.ok) return printResult(consumed);

  return printResult(await executeMemberStakeholderProductionApply(payload, {
    root,
    migration,
    pin,
    pins: deps.pins,
    connect: factory.connect,
    consumedPath: deps.consumedPath,
  }));
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const code = await main();
  process.exitCode = typeof code === 'number' ? code : (code ? 0 : 1);
}
