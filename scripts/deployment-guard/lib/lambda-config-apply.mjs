/**
 * Receipt-gated environment-variable writer for a shared API Lambda.
 *
 * Same discipline as the overlay and rebuild writers: a signed receipt whose
 * only owned component is the plan change's SHA-256, RevisionId CAS before the
 * write (RevisionId moves on any code or configuration change, so it pins
 * both), the plan re-evaluated against the live variables immediately before
 * mutation, the production gate, one-shot receipt consumption, and a post-update
 * read that must equal the intended variables exactly with every other
 * configuration field unchanged. Sends only FunctionName, Environment.Variables
 * and RevisionId; never code, never role/runtime/handler/memory/timeout/VPC,
 * never a restore.
 */
import { consumeReceiptOnce } from './consumed-receipts.mjs';
import { CODES, fail, ok } from './errors.mjs';
import { configFingerprint } from './lambda-overlay-apply.mjs';
import { evaluateApplyFingerprintCas, requireLambdaApplyFingerprint } from './lambda-overlay.mjs';
import {
  CONFIG_DEPLOYMENT_TYPE,
  changeSha256,
  configurationSha256,
  evaluateConfigChange,
  liveVariablesOf,
  loadConfigPlan,
  parseEnvironmentComponent,
  planSection,
  stableJson,
} from './lambda-config.mjs';
import { evaluateProductionGate } from './production.mjs';
import { refuseUnguardedDeploy } from '../require-guard.mjs';
import { lookupSharedLambda } from './shared-targets.mjs';

const iso = (now) => new Date(now).toISOString();

function nonEnvironmentFingerprint(configuration) {
  const fp = configFingerprint(configuration);
  delete fp.Environment;
  return fp;
}

async function waitForFunctionUpdated(aws, functionName, { attempts = 20, delayMs = 0 } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await aws.getFunctionConfiguration({ functionName });
    if (!last?.ok) return last || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read Lambda configuration after update');
    const status = last.details.lastUpdateStatus || last.details.configuration?.LastUpdateStatus || last.details.LastUpdateStatus;
    if (!status || status === 'Successful') return last;
    if (status === 'Failed') {
      return fail(CODES.DEPLOYMENT_COLLISION, 'Lambda configuration update failed; stopping without restore', { lastUpdateStatus: status });
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return last || fail(CODES.DEPLOYMENT_COLLISION, 'Lambda configuration update did not complete');
}

export async function applyLambdaConfig(input = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const guardRoot = ctx.guardRoot;
  const aws = ctx.aws;
  const now = ctx.now || Date.now();
  const repoRoot = ctx.repoRoot || guardRoot;

  if (!guardRoot) return fail(CODES.INVALID_MANIFEST, 'applyLambdaConfig requires guardRoot');
  if (input.apply !== true) {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'lambda config apply requires explicit apply:true confirmation');
  }
  if (env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY !== '1') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'lambda config apply is blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1');
  }
  if (input.restore === true || input.reclaim === true || input.environment_variables || input.variables || input.configuration) {
    return fail(CODES.UNRELATED_MUTATION, 'caller-supplied variables, configuration and restore/reclaim are forbidden; only the reviewed plan may change the environment');
  }
  if (!aws?.getFunctionConfiguration || !aws?.updateFunctionConfiguration) {
    return fail(CODES.INVALID_MANIFEST, 'applyLambdaConfig requires a Lambda aws adapter');
  }

  const functionName = input.function_name || input.target_component;
  const shared = lookupSharedLambda(functionName);
  if (!shared) {
    return fail(CODES.UNRELATED_MUTATION, 'lambda config may only target a registered shared Lambda', { function_name: functionName || null });
  }
  if (input.target_environment && input.target_environment !== shared.target_environment) {
    return fail(CODES.RECEIPT_MISMATCH, 'requested environment does not match the registered Lambda', {
      function_name: functionName,
      requested_environment: input.target_environment,
      registered_environment: shared.target_environment,
    });
  }
  const target_environment = shared.target_environment;
  const target_component = shared.target_component;
  const workstream_id = input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID || null;
  const commit = input.commit || env.CHECKSOPS_COMMIT || null;

  const authorized = refuseUnguardedDeploy({
    target_environment,
    target_component,
    deployment_type: CONFIG_DEPLOYMENT_TYPE,
    workstream_id,
    commit,
    receipt: input.receipt,
    receipt_path: input.receipt_path,
  }, { root: guardRoot, now, env: ctx.guardEnv || env });
  if (!authorized.ok) return authorized;
  const receipt = authorized.details.receipt;

  if (receipt.deployment_type !== CONFIG_DEPLOYMENT_TYPE) {
    return fail(CODES.RECEIPT_MISMATCH, 'receipt is not a lambda-config receipt', { deployment_type: receipt.deployment_type });
  }
  if (Object.prototype.hasOwnProperty.call(receipt, 'owned_member_ops')) {
    return fail(CODES.RECEIPT_MISMATCH, 'a config receipt must not carry owned_member_ops');
  }
  const components = Array.isArray(receipt.owned_components) ? receipt.owned_components : [];
  const expectedChangeSha256 = components.length === 1 ? parseEnvironmentComponent(components[0]) : null;
  if (!expectedChangeSha256) {
    return fail(CODES.RECEIPT_MISMATCH, 'config receipt must own exactly one environment@sha256:<change> component', { owned_components: components });
  }

  let row;
  try {
    row = input.plan || loadConfigPlan(repoRoot, target_environment);
  } catch (error) {
    return fail(error?.code || CODES.INVALID_MANIFEST, error?.message || 'config plan is unreadable', error?.details || {});
  }
  if (row.function_name !== functionName) {
    return fail(CODES.UNRELATED_MUTATION, 'config plan section targets a different function', { function_name: functionName });
  }
  const plan = { environments: { [target_environment]: row } };
  let planChangeSha256;
  try {
    // Re-validate the row the caller handed in so a hand-built input.plan cannot skip the key/value rules.
    planChangeSha256 = changeSha256(planSection(plan, target_environment));
  } catch (error) {
    return fail(error?.code || CODES.INVALID_MANIFEST, error?.message || 'config plan is invalid', error?.details || {});
  }
  if (planChangeSha256 !== expectedChangeSha256) {
    return fail(CODES.RECEIPT_MISMATCH, 'the plan change is not the change the receipt authorized', {
      receipt_change_sha256: expectedChangeSha256,
      plan_change_sha256: planChangeSha256,
    });
  }

  const receiptIdentity = requireLambdaApplyFingerprint(receipt?.preflight_live_fingerprint, 'receipt preflight');
  if (!receiptIdentity.ok) return receiptIdentity;

  const firstCfg = await aws.getFunctionConfiguration({ functionName });
  if (!firstCfg?.ok) return firstCfg || fail(CODES.DEPLOYMENT_COLLISION, 'failed to read current live Lambda configuration');
  const firstConfiguration = firstCfg.details.configuration || firstCfg.details;
  const liveIdentity = requireLambdaApplyFingerprint(firstCfg.details, 'first live');
  if (!liveIdentity.ok) return liveIdentity;
  const firstCas = evaluateApplyFingerprintCas({
    preflight: { codeSha256: receiptIdentity.details.codeSha256, revisionId: receiptIdentity.details.revisionId },
    immediatelyBefore: liveIdentity.details,
    label: 'receipt-to-first-live',
  });
  if (!firstCas.ok) return firstCas;
  const firstVariables = liveVariablesOf(firstConfiguration);
  if (!firstVariables.ok) return firstVariables;
  const configurationBefore = configurationSha256(firstConfiguration);
  const fixedBefore = nonEnvironmentFingerprint(firstConfiguration);

  const evaluation = evaluateConfigChange({ plan, environment: target_environment, liveVariables: firstVariables.details.variables });
  if (!evaluation.ok) return evaluation;
  if (evaluation.details.state === 'ALREADY_ACCEPTED') {
    return fail(CODES.UNRELATED_MUTATION, 'live environment already holds every intended value; nothing to apply');
  }

  const beforeCfg = await aws.getFunctionConfiguration({ functionName });
  if (!beforeCfg?.ok) return beforeCfg || fail(CODES.DEPLOYMENT_COLLISION, 'failed to re-read Lambda immediately before mutation');
  const immediatelyBefore = requireLambdaApplyFingerprint(beforeCfg.details, 'immediately-before');
  if (!immediatelyBefore.ok) return immediatelyBefore;
  const receiptToImmediate = evaluateApplyFingerprintCas({
    preflight: { codeSha256: receiptIdentity.details.codeSha256, revisionId: receiptIdentity.details.revisionId },
    immediatelyBefore: immediatelyBefore.details,
    label: 'receipt-to-immediately-before',
  });
  if (!receiptToImmediate.ok) return receiptToImmediate;
  const beforeConfiguration = beforeCfg.details.configuration || beforeCfg.details;
  if (configurationSha256(beforeConfiguration) !== configurationBefore) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'Lambda configuration changed between the two pre-write reads; stop');
  }

  const operator = input.operator || receipt.operator || env.CHECKSOPS_OPERATOR || env.USER || null;
  if (target_environment === 'production') {
    const gate = evaluateProductionGate({
      target_environment,
      deployment_type: CONFIG_DEPLOYMENT_TYPE,
      workstream_id: workstream_id || receipt.workstream_id,
      production_fingerprint: { codeSha256: receiptIdentity.details.codeSha256, revisionId: receiptIdentity.details.revisionId },
      immediately_before_fingerprint: immediatelyBefore.details,
      staging_acceptance: input.staging_acceptance,
      approval: input.approval,
    });
    if (!gate.ok) return gate;
  }

  const consumed = consumeReceiptOnce(guardRoot, receipt, { now, actor: operator, script: ctx.script || 'lambda-config-apply' });
  if (!consumed.ok) return consumed;
  if (typeof aws.authorizeWrites === 'function') {
    aws.authorizeWrites({ receipt_mac: receipt.mac, function_name: functionName });
  }

  const target = evaluation.details.target;
  const updated = await aws.updateFunctionConfiguration({ functionName, environment: target, revisionId: immediatelyBefore.details.revisionId });
  if (!updated?.ok) return updated || fail(CODES.DEPLOYMENT_COLLISION, 'UpdateFunctionConfiguration failed');

  const afterCfg = await waitForFunctionUpdated(aws, functionName, { attempts: ctx.waitAttempts || 20, delayMs: ctx.waitDelayMs || 0 });
  if (!afterCfg?.ok) return afterCfg;
  const afterConfiguration = afterCfg.details.configuration || afterCfg.details;
  const afterVariables = liveVariablesOf(afterConfiguration);
  if (!afterVariables.ok) return afterVariables;
  if (stableJson(afterVariables.details.variables) !== stableJson(target)) {
    const names = new Set([...Object.keys(target), ...Object.keys(afterVariables.details.variables)]);
    const mismatched = [...names].filter((key) => target[key] !== afterVariables.details.variables[key]).sort();
    return fail(CODES.DEPLOYMENT_COLLISION, 'live environment after update does not equal the intended variables', { mismatched_keys: mismatched });
  }
  const fixedAfter = nonEnvironmentFingerprint(afterConfiguration);
  if (stableJson(fixedBefore) !== stableJson(fixedAfter)) {
    return fail(CODES.UNRELATED_MUTATION, 'Lambda configuration outside Environment.Variables changed; stopping without restore', { before: fixedBefore, after: fixedAfter });
  }
  const afterCodeSha256 = afterCfg.details.codeSha256 || afterConfiguration.CodeSha256 || null;
  if (afterCodeSha256 !== immediatelyBefore.details.codeSha256) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'CodeSha256 changed during a configuration update; stop', { before: immediatelyBefore.details.codeSha256, after: afterCodeSha256 });
  }

  return ok({
    environment: target_environment,
    component: target_component,
    function_name: functionName,
    workstream_id: workstream_id || receipt.workstream_id,
    commit: commit || receipt.commit,
    change_sha256: planChangeSha256,
    changes: evaluation.details.changes.map(({ key, op, status }) => ({ key, op, status })),
    receipt: { file: authorized.details.receipt_file || null, mac: receipt.mac, consumed: consumed.details },
    before: { fingerprint: liveIdentity.details, configuration_sha256: configurationBefore },
    immediately_before: immediatelyBefore.details,
    after: {
      fingerprint: { codeSha256: afterCodeSha256, revisionId: afterCfg.details.revisionId || afterConfiguration.RevisionId || null },
      configuration_sha256: configurationSha256(afterConfiguration),
    },
    update: updated.details,
    applied_at: iso(now),
    reclaim_forbidden: true,
    restore_forbidden: true,
  });
}
