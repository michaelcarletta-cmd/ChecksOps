#!/usr/bin/env node
/**
 * Privileged-operator Gate 3D apply. Do not run as Step3Temp.
 * Keep Step3Temp kms:* deny. Do not broaden that role.
 *
 * Changes only checksops-production-origin-verify environment:
 * preserve every existing variable and set ORIGIN_VERIFY_REQUIRE=true.
 * Uses RevisionId.
 *
 * After REQUIRE=true, logs in the existing T0 Tester through CloudFront
 * POST /prep/auth/login, holds the Cognito ID token in process memory only,
 * uses it once for a read-only POST /prep/data/query, then discards it.
 * Does not require CHECKSOPS_GATE3D_ID_TOKEN. Does not reset Cognito.
 * Never prints the token, password, secret, hash, prefix, or HeaderValue.
 *
 * Plan (default): prints guards and exits 2.
 * Apply: CHECKSOPS_OPERATOR_GATE3D=I_UNDERSTAND_PRODUCTION
 *        CHECKSOPS_OPERATOR_EXECUTE=1
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { LAMBDA_NAME, awsJson } from './lib.mjs';
import {
  REQUIRE_KEY,
  collectObserveAndHolds,
  collectPreflight,
  evaluatePreflight,
  mintT0IdTokenViaCloudFrontLogin,
  publicLoginOutcome,
  requirePrivilegedOperator,
  rollbackOriginVerifyRequireAndConfirm,
  t0TesterCredentialPresent,
  mergeOriginVerifyRequire,
  updateOriginVerifyRequire,
  waitForLambdaReady,
  withInMemoryIdToken,
} from './gate3d-lib.mjs';
import { validateGate3d } from './validate-gate3d.mjs';

export const plan = {
  gate: '3D',
  operatorOnly: true,
  doNotUseStep3Temp: true,
  doNotBroadenStep3TempKms: true,
  expectedAccount: '806168576068',
  lambdaName: LAMBDA_NAME,
  change: `${REQUIRE_KEY}=true`,
  preserveExistingEnv: true,
  onlyAuthorizerLambdaEnv: true,
  revisionIdRequired: true,
  manualIdTokenRequired: false,
  inProcessT0Login: true,
  t0LifecycleAccount: 'tester',
  t0LoginUrl: 'https://checksops.com/prep/auth/login',
  authenticatedQueryUrl: 'https://checksops.com/prep/data/query',
  authenticatedQueryReadOnly: true,
  financialRowsProcessed: false,
  idTokenPrinted: false,
  idTokenPersisted: false,
  DisableExecuteApiEndpoint: false,
  cloudfront: 'unchanged',
  waf: 'unchanged',
  cognito: 'unchanged',
  automaticRollback: true,
  secretPrinted: false,
};

export async function executePrivilegedOperatorGate3dApply({
  identity = { Account: '806168576068', Arn: 'arn:aws:sts::806168576068:assumed-role/Privileged/x' },
  collectPreflightFn = collectPreflight,
  collectObserveFn = collectObserveAndHolds,
  evaluatePreflightFn = evaluatePreflight,
  getLambdaConfig = () => awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA_NAME]),
  updateRequire = () => updateOriginVerifyRequire('true'),
  waitReady = waitForLambdaReady,
  mintLogin = mintT0IdTokenViaCloudFrontLogin,
  validateFn = validateGate3d,
  rollbackFn = rollbackOriginVerifyRequireAndConfirm,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  credentialPresent = t0TesterCredentialPresent,
} = {}) {
  if (!credentialPresent()) {
    const err = new Error('T0_TESTER_CREDENTIAL_required');
    err.exitCode = 2;
    throw err;
  }
  requirePrivilegedOperator(identity);

  const base = collectPreflightFn();
  const observe = await collectObserveFn();
  const preflight = evaluatePreflightFn(base, observe, { requireStep3TempCaller: false });
  if (!preflight.ok) {
    return { mode: 'preflight_refused', operatorOnly: true, checks: preflight.checks, ok: false };
  }

  const before = getLambdaConfig();
  const merged = mergeOriginVerifyRequire(before.Environment?.Variables || {}, 'true');

  let applied = false;
  try {
    const updated = updateRequire();
    applied = true;
    waitReady();
    await sleep(2000);

    let loginPublic = { required: true, skipped: false, ok: false, status: null };
    const report = await withInMemoryIdToken(
      async () => {
        const minted = await mintLogin();
        loginPublic = publicLoginOutcome(minted);
        return minted;
      },
      async (idToken) => {
        if (!loginPublic.ok || !idToken) {
          return { ok: false, checks: { authenticatedOk: false, loginOk: false }, executeApiEnabled: true };
        }
        const validation = await validateFn({ requireMode: true, idToken });
        validation.checks = {
          ...validation.checks,
          loginOk: loginPublic.ok === true && loginPublic.skipped === false,
        };
        validation.ok = validation.ok === true && validation.checks.loginOk === true;
        return validation;
      },
    );

    if (!report?.ok) {
      const rollback = await rollbackFn();
      return {
        ...plan,
        mode: 'rolled_back',
        preservedKeys: merged.preservedKeys,
        login: loginPublic,
        validation: report?.checks || { authenticatedOk: false, loginOk: false },
        rollback,
        ok: false,
      };
    }
    return {
      ...plan,
      mode: 'executed',
      requireFlag: updated.requireFlag,
      preservedKeys: merged.preservedKeys,
      envKeys: updated.envKeys,
      revisionIdUsed: Boolean(updated.revisionIdUsed),
      login: loginPublic,
      validation: report.checks,
      executeApiEnabled: report.executeApiEnabled,
      ok: true,
    };
  } catch (err) {
    if (applied && !String(err?.message || '').includes('rolled_back') && !String(err?.message || '').includes('GATE3D_ROLLBACK_FATAL')) {
      await rollbackFn();
    }
    throw err;
  }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  if (String(process.env.CHECKSOPS_OPERATOR_GATE3D || '') !== 'I_UNDERSTAND_PRODUCTION'
    || String(process.env.CHECKSOPS_OPERATOR_EXECUTE || '') !== '1') {
    console.log(JSON.stringify({
      ...plan,
      mode: 'plan',
      note: 'Plan only. Privileged operator sets CHECKSOPS_OPERATOR_GATE3D=I_UNDERSTAND_PRODUCTION and CHECKSOPS_OPERATOR_EXECUTE=1. Do not use Step3Temp. Live apply uses in-process T0 Tester CloudFront login; do not set CHECKSOPS_GATE3D_ID_TOKEN.',
    }));
    process.exit(2);
  }

  if (!t0TesterCredentialPresent()) {
    console.error('T0_TESTER_CREDENTIAL_required');
    process.exit(2);
  }

  const identity = awsJson(['sts', 'get-caller-identity']);
  try {
    const result = await executePrivilegedOperatorGate3dApply({ identity });
    if (result.mode === 'preflight_refused') {
      console.log(JSON.stringify({ gate: '3D', mode: 'preflight_refused', operatorOnly: true, checks: result.checks }));
      throw new Error('gate3d_preflight_refused');
    }
    console.log(JSON.stringify(result));
    if (result.mode === 'rolled_back' || result.ok === false) {
      throw new Error('gate3d_validation_failed_rolled_back');
    }
  } catch (err) {
    if (String(err?.message || '') === 'T0_TESTER_CREDENTIAL_required') {
      console.error('T0_TESTER_CREDENTIAL_required');
      process.exit(2);
    }
    throw err;
  }
}
