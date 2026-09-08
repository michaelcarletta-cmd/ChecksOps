#!/usr/bin/env node
/**
 * Gate 3D preflight. Read-only. Refuses unless Gate 3C observe mode is intact.
 * Does not set ORIGIN_VERIFY_REQUIRE=true. Does not mutate AWS.
 */
import { collectObserveAndHolds, collectPreflight, evaluatePreflight } from './gate3d-lib.mjs';
import { requireStep3Temp } from './lib.mjs';

const identity = requireStep3Temp();
const base = collectPreflight();
const observe = await collectObserveAndHolds();
const evaluated = evaluatePreflight(base, observe);

const report = {
  gate: '3D',
  mode: 'preflight',
  identity,
  requireFalse: base.requireFalse,
  requireFlag: base.requireFlag,
  existingEnvKeys: base.existingEnvKeys,
  cloudfrontDeployed: base.cloudfront.deployed,
  wafUnchanged: base.cloudfront.wafUnchanged,
  exactlyOneOriginVerify: base.cloudfront.exactlyOneOriginVerify,
  defaultAuthorizationType: base.defaultRoute.authorizationType,
  optionsAuthorization: base.options.authorizationType,
  integrationStillPrep: base.integration.stillPrep,
  headerStripConfigured: base.integration.headerStripConfigured,
  executeApiEnabled: base.executeApiEnabled,
  cloudfrontObserve: observe.samples.cloudfront,
  executeApiDirectObserve: observe.samples.executeApiDirect,
  holdsOk: observe.holdsOk,
  productionExecutionFalse: observe.productionExecutionFalse,
  providerFinancialFlagsFalse: observe.providerFinancialFlagsFalse,
  financialActivationSqlAppliedFalse: observe.financialActivationSqlAppliedFalse,
  checks: evaluated.checks,
  ok: evaluated.ok,
  secretPrinted: false,
  note: 'Read-only. Gate 3D apply remains blocked until human review.',
};

console.log(JSON.stringify(report, null, 2));
if (!evaluated.ok) {
  console.error('GATE3D_PREFLIGHT_REFUSE');
  process.exit(1);
}
