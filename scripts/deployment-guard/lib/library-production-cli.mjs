/**
 * Shared command line of the SQL 29 and SQL 30 production tools
 * (sql29-mortgage-ops-library-parity-production-apply.mjs,
 * sql30-tenant-documents-doc-type-production-apply.mjs). Same flow as the SQL 89 tool:
 *
 *   --inspect                 read-only (BEGIN READ ONLY ... ROLLBACK), aggregate counts only
 *   --input <file>            evaluate the manifest against the pin (no connection)
 *   --apply --input <file>    receipt-gated apply: CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1, a
 *                             preflight receipt owning the pinned file, execute true, an
 *                             owner-approved authorization, a recorded pre-state, the staging
 *                             acceptance reference, the phrase and a single-use id
 *
 * Database credentials come only from the pinned production admin secret; credential
 * flags and arbitrary SQL are refused.
 */
import { parseArgs, printResult, readInput } from './cli.mjs';
import { consumeReceiptOnce as defaultConsumeReceiptOnce } from './consumed-receipts.mjs';
import { CODES, fail } from './errors.mjs';
import {
  LIBRARY_PRODUCTION,
  LIBRARY_PRODUCTION_COMPONENT,
  LIBRARY_PRODUCTION_DEPLOYMENT_TYPE,
  createProductionDatabaseConnect,
  evaluateLibraryProductionApply,
  executeLibraryProductionApply,
  inspectLibraryProduction,
  loadLibraryProductionPin,
  precheckLibraryProductionApply,
  resolveLibraryDatabaseUrl,
} from './sql29-sql30-library-production-apply.mjs';

const CREDENTIAL_FLAG_RE = /pass|pwd|secret|database|db-?url|connection|dsn|host|user|port|token/i;

async function connectFactory(pin, root, deps) {
  if (typeof deps.connect === 'function') return { ok: true, connect: deps.connect };
  const url = await (deps.resolveUrl || resolveLibraryDatabaseUrl)({ pin, getSecretValue: deps.getSecretValue });
  if (!url.ok) return url;
  return { ok: true, connect: createProductionDatabaseConnect(url.details.url, { root }) };
}

export async function runLibraryProductionTool({ key, scriptUrl, enforceScriptGuard }, argv, env, deps = {}) {
  const tool = LIBRARY_PRODUCTION[key];
  const root = deps.root;
  const { flags, opts } = parseArgs(argv);
  const credentialFlags = Object.keys(opts).filter((name) => CREDENTIAL_FLAG_RE.test(name));
  if (credentialFlags.length) {
    return printResult(fail(CODES.INVALID_MANIFEST, `${tool.label} production credentials come only from the pinned admin secret; credential flags are refused`, { flags: credentialFlags }));
  }
  const pin = deps.pin || loadLibraryProductionPin(key, root);

  if (flags.has('inspect')) {
    const factory = await connectFactory(pin, root, deps);
    if (!factory.ok) return printResult(factory);
    return printResult(await inspectLibraryProduction(key, { connect: factory.connect, pin, root }));
  }

  const input = readInput(opts, {});
  if (input.sql_text || input.sql || input.statement || input.arbitrary_sql) {
    return printResult(fail(CODES.UNRELATED_MUTATION, `arbitrary SQL text is forbidden; only the pinned ${tool.label} file may be applied`));
  }
  const payload = {
    ...input,
    target_environment: 'production',
    target_component: LIBRARY_PRODUCTION_COMPONENT,
    deployment_type: LIBRARY_PRODUCTION_DEPLOYMENT_TYPE,
  };
  const evaluation = await evaluateLibraryProductionApply(key, payload, { root, pin });
  if (!evaluation.ok) return printResult(evaluation);
  if (!flags.has('apply')) return printResult(evaluation);

  const authorized = (deps.enforceScriptGuard || enforceScriptGuard)({
    script: scriptUrl,
    workstream_id: payload.workstream_id,
    commit: payload.commit,
    target_environment: 'production',
    target_component: LIBRARY_PRODUCTION_COMPONENT,
    deployment_type: LIBRARY_PRODUCTION_DEPLOYMENT_TYPE,
    preflight_live_fingerprint: payload.preflight_live_fingerprint,
    receipt_path: opts.receipt || env.CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT || payload.receipt_path,
  }, { root, env });
  if (authorized?.ok === false) return printResult(authorized);
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return printResult(fail(CODES.GUARD_APPLY_FORBIDDEN, `${tool.label} production apply is blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1`));
  }
  const receipt = authorized?.details?.receipt;
  if (!receipt || !(receipt.owned_components || []).includes(pin.filename)) {
    return printResult(fail(CODES.RECEIPT_MISMATCH, `receipt does not own the pinned ${tool.label} migration`, { required_component: pin.filename }));
  }
  // Spend the single-use receipt only after the execute, phrase, one_use_id and replay checks pass.
  const precheck = await precheckLibraryProductionApply(key, payload, { root, pin, consumedPath: deps.consumedPath });
  if (!precheck.ok) return printResult(precheck);
  const factory = await connectFactory(pin, root, deps);
  if (!factory.ok) return printResult(factory);
  const consumed = (deps.consumeReceiptOnce || defaultConsumeReceiptOnce)(root, receipt, {
    actor: payload.operator || null,
    script: tool.script,
  });
  if (!consumed.ok) return printResult(consumed);

  return printResult(await executeLibraryProductionApply(key, payload, {
    root,
    pin,
    connect: factory.connect,
    consumedPath: deps.consumedPath,
  }));
}
