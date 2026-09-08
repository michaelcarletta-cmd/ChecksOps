#!/usr/bin/env node
/**
 * Gate 3D post-apply validation. Prints public booleans and HTTP statuses only.
 * Never prints the origin-verification secret, hash, prefix, or HeaderValue.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  API_ID,
  DISTRIBUTION_ID,
  HEADER_NAME,
  INTEGRATION_ID,
  LAMBDA_NAME,
  PREP_LAMBDA,
  WAF_ARN,
  awsJson,
} from './lib.mjs';
import {
  CF_APEX,
  CF_WWW,
  FABRICATED_HEADER,
  RAW_API,
  headerStripConfigured,
  isGatewayUnauthorized,
  originHeaderInventory,
  probe,
  probeAuthenticatedReadOnlyQuery,
  providerFinancialFlagsFalse,
  requireIsFalse,
  requireLiveIdToken,
} from './gate3d-lib.mjs';

export async function validateGate3d({ requireMode, idToken } = {}) {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA_NAME]);
  const dist = awsJson(['cloudfront', 'get-distribution', '--id', DISTRIBUTION_ID]);
  const integration = awsJson([
    'apigatewayv2', 'get-integration', '--api-id', API_ID, '--integration-id', INTEGRATION_ID,
  ]);
  const api = awsJson(['apigatewayv2', 'get-api', '--api-id', API_ID]);
  const headers = originHeaderInventory(dist);

  const apexHealth = await probe(`${CF_APEX}/prep/health`);
  const wwwHealth = await probe(`${CF_WWW}/prep/health`);
  const options = await probe(`${CF_APEX}/prep/health`, { method: 'OPTIONS' });
  const publicSign = await probe(`${CF_APEX}/prep/public/signature-document`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'short' }),
  });
  const publicEndorse = await probe(`${CF_APEX}/prep/public/endorsement`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'short' }),
  });
  const appThroughCf = await probe(`${CF_APEX}/prep/data/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ table: 'user_roles', op: 'select', select: 'role', limit: 1 }),
  });
  const rawNoHeader = await probe(`${RAW_API}/prep/health`);
  const rawFabricated = await probe(`${RAW_API}/prep/health`, {
    headers: { [HEADER_NAME]: FABRICATED_HEADER },
  });
  const readiness = await probe(`${CF_APEX}/prep/ops/readiness`);
  const financial = await probe(`${CF_APEX}/prep/financial/status`);

  let authenticated = {
    required: Boolean(requireMode),
    skipped: !requireMode,
    status: null,
    reachedPrep: false,
  };
  if (requireMode) {
    const provided = idToken !== undefined;
    const token = provided
      ? String(idToken || '').trim()
      : requireLiveIdToken();
    const query = await probeAuthenticatedReadOnlyQuery({ idToken: token });
    authenticated = {
      required: true,
      skipped: false,
      status: query.status,
      reachedPrep: query.reachedPrep,
      cfId: query.cfId,
      readOnly: query.readOnly === true,
      table: query.table,
    };
  }

  const cfHealthOk = apexHealth.status === 200 && apexHealth.bodyStatus === 'ok' && apexHealth.cfId
    && wwwHealth.status === 200 && wwwHealth.bodyStatus === 'ok' && wwwHealth.cfId;
  const optionsOk = options.status === 204 && options.cfId;
  const publicApiOk = publicSign.cfId && publicEndorse.cfId
    && publicSign.reachedPrep && publicEndorse.reachedPrep
    && !publicSign.gatewayUnauthorized && !publicEndorse.gatewayUnauthorized;
  const appThroughCfOk = appThroughCf.cfId && appThroughCf.reachedPrep && !appThroughCf.gatewayUnauthorized;
  const authenticatedOk = requireMode
    ? authenticated.skipped === false && authenticated.status === 200 && authenticated.reachedPrep === true
    : true;
  const rawDenied = isGatewayUnauthorized(rawNoHeader.status);
  const fabricatedDenied = isGatewayUnauthorized(rawFabricated.status);

  const report = {
    gate: '3D',
    requireMode: requireMode === true,
    requireFlag: cfg.Environment?.Variables?.ORIGIN_VERIFY_REQUIRE ?? '<unset>',
    apexHealth: apexHealth.status,
    wwwHealth: wwwHealth.status,
    optionsStatus: options.status,
    publicSignReachedPrep: publicSign.reachedPrep,
    publicEndorseReachedPrep: publicEndorse.reachedPrep,
    appThroughCfReachedPrep: appThroughCf.reachedPrep,
    authenticated,
    rawNoHeaderStatus: rawNoHeader.status,
    rawFabricatedStatus: rawFabricated.status,
    wafUnchanged: dist.Distribution?.DistributionConfig?.WebACLId === WAF_ARN,
    cloudfrontDeployed: dist.Distribution?.Status === 'Deployed',
    originHeaderQuantity: headers.quantity,
    integrationStillPrep: String(integration.IntegrationUri || '').includes(PREP_LAMBDA),
    headerStripConfigured: headerStripConfigured(integration),
    executeApiEnabled: api.DisableExecuteApiEndpoint === false,
    holdsOk: readiness.holdsOk === true,
    productionExecutionFalse: financial.productionExecution === false,
    providerFinancialFlagsFalse: providerFinancialFlagsFalse({
      ...(readiness.flags || {}),
      ...(financial.flags || {}),
    }),
    financialActivationSqlAppliedFalse: readiness.financialActivationSqlApplied === false,
    secretPrinted: false,
    headerValuePrinted: false,
    idTokenPrinted: false,
  };

  const checks = {
    cfHealthOk,
    optionsOk,
    publicApiOk,
    appThroughCfOk,
    authenticatedOk,
    wafUnchanged: report.wafUnchanged,
    cloudfrontDeployed: report.cloudfrontDeployed,
    integrationStillPrep: report.integrationStillPrep,
    headerStripConfigured: report.headerStripConfigured,
    executeApiEnabled: report.executeApiEnabled,
    holdsOff: report.holdsOk
      && report.productionExecutionFalse
      && report.providerFinancialFlagsFalse
      && report.financialActivationSqlAppliedFalse,
  };
  if (requireMode) {
    checks.requireTrue = report.requireFlag === 'true';
    checks.rawDenied = rawDenied;
    checks.fabricatedDenied = fabricatedDenied;
  } else {
    checks.requireFalse = requireIsFalse(cfg);
  }

  report.checks = checks;
  report.ok = Object.values(checks).every(Boolean);
  return report;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  if (String(process.env.CHECKSOPS_GATE3D_VALIDATE || '') !== '1') {
    console.log(JSON.stringify({
      gate: '3D',
      mode: 'plan',
      validates: [
        'checksops.com/prep/health=200',
        'www.checksops.com/prep/health=200',
        'authenticated read-only /prep/data/query=200 (in-process token or CHECKSOPS_GATE3D_ID_TOKEN; skipped is not a pass)',
        'CloudFront application requests reach prep Lambda',
        'CloudFront /prep/public/signature-document and /prep/public/endorsement reach prep',
        'OPTIONS=204',
        'raw execute-api without header → 401/403 when require-mode',
        'fabricated origin header → 401/403 when require-mode',
        'WAF and CloudFront unchanged',
        'jci10de still prep',
        'provider and financial flags false',
      ],
      note: 'Set CHECKSOPS_GATE3D_VALIDATE=1 to run live checks. Do not apply Gate 3D from this PR.',
    }));
    process.exit(2);
  }
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA_NAME]);
  const requireMode = cfg.Environment?.Variables?.ORIGIN_VERIFY_REQUIRE === 'true';
  if (!requireMode) {
    console.log(JSON.stringify({
      gate: '3D',
      mode: 'not_in_require_mode',
      ok: false,
      note: 'Authorizer REQUIRE is unset/false. Post-apply require-mode checks were not run.',
    }));
    process.exit(2);
  }
  if (!String(process.env.CHECKSOPS_GATE3D_ID_TOKEN || '').trim()) {
    console.error('CHECKSOPS_GATE3D_ID_TOKEN_required');
    process.exit(2);
  }
  const report = await validateGate3d({ requireMode: true });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
