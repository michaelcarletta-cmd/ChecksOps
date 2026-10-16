#!/usr/bin/env node
/**
 * Official production entry for SQL 89
 * (aws/workflows/sql/89_check_intake_items_column_update.sql): REVOKE UPDATE ON TABLE
 * public.check_intake_items FROM checksops, then GRANT UPDATE on exactly the 43
 * columns the API writes (SQL89_COLUMNS).
 *
 *   --inspect
 *       read-only catalog (BEGIN READ ONLY ... ROLLBACK), no table rows: the login, the
 *       table owner and ACL, checksops' table privileges, any table-level UPDATE, every
 *       column checksops can UPDATE, the columns SQL 89 would grant and the columns that
 *       would lose UPDATE, the functions that UPDATE the table, SQL 70's ingest function,
 *       the live fingerprint, the post-state the apply must leave, the failed production
 *       preconditions and apply_preconditions_met
 *   --apply --input <file>
 *       receipt-gated apply; requires CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1, a
 *       preflight receipt owning the pinned file, a pin with execute: true, an
 *       owner-approved authorization and a recorded pre-apply live hash, the pin's
 *       staging acceptance reference, its authorization phrase and a single-use id
 *
 * The database credentials come only from the pinned production admin secret
 * (Secrets Manager, through the VPC endpoint); no password is ever a flag or a file.
 * Run only on a host with private reachability into the production VPC
 * (see ops/production-sql-89-apply.md). Never from GitHub-hosted runners or Lambda.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, printResult, readInput } from './lib/cli.mjs';
import { consumeReceiptOnce } from './lib/consumed-receipts.mjs';
import { CODES, fail } from './lib/errors.mjs';
import { repoRootFrom } from './lib/paths.mjs';
import { enforceScriptGuard } from './require-guard.mjs';
import {
  SQL89_PRODUCTION_COMPONENT,
  SQL89_PRODUCTION_DEPLOYMENT_TYPE,
  createProductionDatabaseConnect,
  evaluateSql89ProductionApply,
  executeSql89ProductionApply,
  inspectSql89Production,
  loadSql89ProductionPin,
  precheckSql89ProductionApply,
  resolveSql89DatabaseUrl,
} from './lib/sql89-check-intake-column-update-production-apply.mjs';

// Credentials never come from the command line.
const CREDENTIAL_FLAG_RE = /pass|pwd|secret|database|db-?url|connection|dsn|host|user|port|token/i;

async function connectFactory(pin, root, deps) {
  if (typeof deps.connect === 'function') return { ok: true, connect: deps.connect };
  const url = await (deps.resolveUrl || resolveSql89DatabaseUrl)({ pin, getSecretValue: deps.getSecretValue });
  if (!url.ok) return url;
  return { ok: true, connect: createProductionDatabaseConnect(url.details.url, { root }) };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const root = deps.root || repoRootFrom(import.meta.url);
  const { flags, opts } = parseArgs(argv);
  const credentialFlags = Object.keys(opts).filter((key) => CREDENTIAL_FLAG_RE.test(key));
  if (credentialFlags.length) {
    return printResult(fail(CODES.INVALID_MANIFEST, 'SQL 89 production credentials come only from the pinned admin secret; credential flags are refused', { flags: credentialFlags }));
  }
  const pin = deps.pin || loadSql89ProductionPin(root);

  if (flags.has('inspect')) {
    const factory = await connectFactory(pin, root, deps);
    if (!factory.ok) return printResult(factory);
    return printResult(await inspectSql89Production({ connect: factory.connect, pin, root }));
  }

  const input = readInput(opts, {});
  if (input.sql_text || input.sql || input.statement || input.arbitrary_sql) {
    return printResult(fail(CODES.UNRELATED_MUTATION, 'arbitrary SQL text is forbidden; only the pinned SQL 89 file may be applied'));
  }
  const payload = {
    ...input,
    target_environment: 'production',
    target_component: SQL89_PRODUCTION_COMPONENT,
    deployment_type: SQL89_PRODUCTION_DEPLOYMENT_TYPE,
  };
  const evaluation = await evaluateSql89ProductionApply(payload, { root, pin });
  if (!evaluation.ok) return printResult(evaluation);
  if (!flags.has('apply')) return printResult(evaluation);

  const authorized = (deps.enforceScriptGuard || enforceScriptGuard)({
    script: import.meta.url,
    workstream_id: payload.workstream_id,
    commit: payload.commit,
    target_environment: 'production',
    target_component: SQL89_PRODUCTION_COMPONENT,
    deployment_type: SQL89_PRODUCTION_DEPLOYMENT_TYPE,
    preflight_live_fingerprint: payload.preflight_live_fingerprint,
    receipt_path: opts.receipt || env.CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT || payload.receipt_path,
  }, { root, env });
  if (authorized?.ok === false) return printResult(authorized);
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return printResult(fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL 89 production apply is blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1'));
  }
  const receipt = authorized?.details?.receipt;
  if (!receipt || !(receipt.owned_components || []).includes(pin.filename)) {
    return printResult(fail(CODES.RECEIPT_MISMATCH, 'receipt does not own the pinned SQL 89 migration', { required_component: pin.filename }));
  }
  // Spend the single-use receipt only after the execute, phrase, one_use_id and replay checks pass.
  const precheck = await precheckSql89ProductionApply(payload, { root, pin, consumedPath: deps.consumedPath });
  if (!precheck.ok) return printResult(precheck);
  // Resolve the secret and prove the production host before spending the receipt (no DB connection yet).
  const factory = await connectFactory(pin, root, deps);
  if (!factory.ok) return printResult(factory);
  const consumed = (deps.consumeReceiptOnce || consumeReceiptOnce)(root, receipt, {
    actor: payload.operator || null,
    script: 'sql89-check-intake-column-update-production-apply',
  });
  if (!consumed.ok) return printResult(consumed);

  return printResult(await executeSql89ProductionApply(payload, {
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
