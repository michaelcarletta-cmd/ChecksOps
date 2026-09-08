/**
 * Gate 3D shared helpers. Read-only collectors plus env merge.
 * Never prints origin-verification secret material or CloudFront HeaderValue.
 */
import {
  API_ID,
  AUTHORIZER_NAME,
  DISTRIBUTION_ID,
  HEADER_NAME,
  INTEGRATION_ID,
  LAMBDA_NAME,
  PREP_LAMBDA,
  WAF_ARN,
  awsJson,
  parseObserveLogLine,
} from './lib.mjs';

export const REQUIRE_KEY = 'ORIGIN_VERIFY_REQUIRE';
export const FABRICATED_HEADER = 'fabricated-origin-verify-not-secret';
export const CF_APEX = 'https://checksops.com';
export const CF_WWW = 'https://www.checksops.com';
export const RAW_API = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com';

const FLAG_RE =
  /MOOV|CHECKALT|PLAID|ACTUM|QUICKBOOKS|PROVIDER_EXECUTION|PROVIDER_LIVE|FINANCIAL_PERMISSIONS|FINANCIAL_SANDBOX|SANDBOX_EXECUTION|FINANCIAL_EXECUTION/;

export function requireFlagValue(cfg) {
  return cfg?.Environment?.Variables?.[REQUIRE_KEY];
}

export function requireIsFalse(cfg) {
  const value = requireFlagValue(cfg);
  return value !== 'true';
}

export function mergeOriginVerifyRequire(existingVars, value) {
  if (value !== 'true' && value !== 'false') {
    throw new Error('require_flag_must_be_true_or_false');
  }
  const existing = { ...(existingVars || {}) };
  const preservedKeys = Object.keys(existing).sort();
  const next = { ...existing, [REQUIRE_KEY]: value };
  return {
    next,
    preservedKeys,
    changedKeys: preservedKeys.includes(REQUIRE_KEY) && existing[REQUIRE_KEY] === value
      ? []
      : [REQUIRE_KEY],
    extraKeysAdded: Object.keys(next).filter((k) => !preservedKeys.includes(k) && k !== REQUIRE_KEY),
  };
}

export function headerStripConfigured(integration) {
  const params = integration?.RequestParameters || {};
  return params[`overwrite:header.${HEADER_NAME}`] === '""'
    || Object.prototype.hasOwnProperty.call(params, `remove:header.${HEADER_NAME}`);
}

export function originHeaderInventory(dist) {
  const origin = (dist?.Distribution?.DistributionConfig?.Origins?.Items || [])
    .find((item) => item.Id === 'ProductionPrepHttpApi');
  const items = origin?.CustomHeaders?.Items || [];
  return {
    quantity: origin?.CustomHeaders?.Quantity ?? items.length,
    headerNames: items.map((item) => item.HeaderName),
    originVerifyPresent: items.some((item) => item.HeaderName === HEADER_NAME),
    exactlyOneOriginVerify: items.length === 1 && items[0]?.HeaderName === HEADER_NAME,
  };
}

export function providerFinancialFlagsFalse(flags = {}) {
  return Object.entries(flags)
    .filter(([key]) => FLAG_RE.test(key))
    .every(([, value]) => value === false);
}

export function isGatewayUnauthorized(status) {
  return status === 401 || status === 403;
}

export function reachedPrepLambda(json) {
  return json?.service === 'checksops-api' || json?.status === 'ok' || json?.error || json?.holds;
}

export async function probe(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...headers },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return {
    url,
    method,
    status: res.status,
    cfId: Boolean(res.headers.get('x-amz-cf-id')),
    gatewayUnauthorized: isGatewayUnauthorized(res.status) && !reachedPrepLambda(json),
    reachedPrep: reachedPrepLambda(json),
    bodyStatus: json?.status ?? null,
    error: json?.error ?? json?.message ?? null,
    holdsOk: json?.holds?.ok ?? null,
    productionExecution: json?.productionExecution ?? null,
    financialActivationSqlApplied: json?.financialActivationSqlApplied ?? null,
    flags: json?.flags
      ? Object.fromEntries(Object.entries(json.flags).filter(([key]) => FLAG_RE.test(key)))
      : undefined,
  };
}

export function collectAuthorizerSamples(logs) {
  const states = [];
  for (const ev of logs?.events || []) {
    const parsed = parseObserveLogLine(ev.message);
    if (parsed) states.push(parsed);
  }
  const cloudfront = states.find((s) => s.originHeaderPresent && s.originHeaderValid)
    || { originHeaderPresent: false, originHeaderValid: false };
  const executeApiDirect = states.find((s) => !s.originHeaderPresent)
    || { originHeaderPresent: true, originHeaderValid: true };
  return { cloudfront, executeApiDirect, sampleCount: states.length };
}

export function collectPreflight() {
  const identity = awsJson(['sts', 'get-caller-identity']);
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA_NAME]);
  const routes = awsJson(['apigatewayv2', 'get-routes', '--api-id', API_ID]);
  const authorizers = awsJson(['apigatewayv2', 'get-authorizers', '--api-id', API_ID]);
  const integration = awsJson([
    'apigatewayv2', 'get-integration', '--api-id', API_ID, '--integration-id', INTEGRATION_ID,
  ]);
  const api = awsJson(['apigatewayv2', 'get-api', '--api-id', API_ID]);
  const dist = awsJson(['cloudfront', 'get-distribution', '--id', DISTRIBUTION_ID]);
  const options = (routes.Items || []).find((r) => r.RouteKey === 'OPTIONS /{proxy+}');
  const def = (routes.Items || []).find((r) => r.RouteKey === '$default');
  const authorizer = (authorizers.Items || []).find((a) => a.Name === AUTHORIZER_NAME);
  const headers = originHeaderInventory(dist);

  return {
    identityArn: identity.Arn || null,
    step3Temp: String(identity.Arn || '').includes('assumed-role/ChecksOpsCursorApiPerimeterStep3Temp/'),
    lambdaName: LAMBDA_NAME,
    requireFlag: requireFlagValue(cfg) ?? '<unset>',
    requireFalse: requireIsFalse(cfg),
    existingEnvKeys: Object.keys(cfg.Environment?.Variables || {}).sort(),
    cloudfront: {
      id: DISTRIBUTION_ID,
      status: dist.Distribution?.Status || null,
      deployed: dist.Distribution?.Status === 'Deployed',
      wafUnchanged: dist.Distribution?.DistributionConfig?.WebACLId === WAF_ARN,
      ...headers,
    },
    options: {
      routeKey: options?.RouteKey || null,
      authorizationType: options?.AuthorizationType || null,
      target: options?.Target || null,
    },
    defaultRoute: {
      routeKey: def?.RouteKey || null,
      authorizationType: def?.AuthorizationType || null,
      authorizerId: def?.AuthorizerId || null,
    },
    authorizer: {
      id: authorizer?.AuthorizerId || null,
      type: authorizer?.AuthorizerType || null,
    },
    integration: {
      id: INTEGRATION_ID,
      stillPrep: String(integration.IntegrationUri || '').includes(PREP_LAMBDA),
      uriContainsPrep: String(integration.IntegrationUri || '').includes(PREP_LAMBDA),
      headerStripConfigured: headerStripConfigured(integration),
    },
    executeApiEnabled: api.DisableExecuteApiEndpoint === false,
  };
}

export async function collectObserveAndHolds() {
  const cfHealth = await probe(`${CF_APEX}/prep/health`);
  const rawHealth = await probe(`${RAW_API}/prep/health`);
  await probe(`${CF_APEX}/prep/health`);
  await probe(`${RAW_API}/prep/health`);
  await new Promise((r) => setTimeout(r, 8000));
  const logs = awsJson([
    'logs',
    'filter-log-events',
    '--log-group-name',
    `/aws/lambda/${LAMBDA_NAME}`,
    '--start-time',
    String(Date.now() - 30 * 60 * 1000),
    '--limit',
    '40',
  ], { allowFail: true });
  const samples = collectAuthorizerSamples(logs);
  const readiness = await probe(`${CF_APEX}/prep/ops/readiness`);
  const financial = await probe(`${CF_APEX}/prep/financial/status`);
  const flags = {
    ...(readiness.flags || {}),
    ...(financial.flags || {}),
  };
  return {
    cfHealth,
    rawHealth,
    samples,
    holdsOk: readiness.holdsOk === true,
    productionExecutionFalse: financial.productionExecution === false,
    providerFinancialFlagsFalse: providerFinancialFlagsFalse(flags),
    financialActivationSqlAppliedFalse: readiness.financialActivationSqlApplied === false,
  };
}

export function evaluatePreflight(base, observe) {
  const checks = {
    step3Temp: base.step3Temp === true,
    cloudfrontDeployed: base.cloudfront.deployed === true,
    wafUnchanged: base.cloudfront.wafUnchanged === true,
    exactlyOneOriginVerify: base.cloudfront.exactlyOneOriginVerify === true,
    defaultCustomAuthorizer: base.defaultRoute.authorizationType === 'CUSTOM'
      && Boolean(base.defaultRoute.authorizerId)
      && base.defaultRoute.authorizerId === base.authorizer.id,
    optionsNone: base.options.authorizationType === 'NONE'
      && base.options.target === `integrations/${INTEGRATION_ID}`,
    integrationStillPrep: base.integration.stillPrep === true,
    headerStripConfigured: base.integration.headerStripConfigured === true,
    requireFalse: base.requireFalse === true,
    executeApiEnabled: base.executeApiEnabled === true,
    cloudfrontObserveValid: observe.samples.cloudfront.originHeaderPresent === true
      && observe.samples.cloudfront.originHeaderValid === true,
    rawObserveInvalid: observe.samples.executeApiDirect.originHeaderPresent === false
      && observe.samples.executeApiDirect.originHeaderValid === false,
    holdsOk: observe.holdsOk === true,
    productionExecutionFalse: observe.productionExecutionFalse === true,
    providerFinancialFlagsFalse: observe.providerFinancialFlagsFalse === true,
    financialActivationSqlAppliedFalse: observe.financialActivationSqlAppliedFalse === true,
  };
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
  };
}

export function updateOriginVerifyRequire(value) {
  const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA_NAME]);
  const merged = mergeOriginVerifyRequire(cfg.Environment?.Variables || {}, value);
  if (merged.extraKeysAdded.length) {
    throw new Error('refusing_to_add_non_require_env_keys');
  }
  const updated = awsJson([
    'lambda',
    'update-function-configuration',
    '--function-name',
    LAMBDA_NAME,
    '--environment',
    JSON.stringify({ Variables: merged.next }),
  ]);
  return {
    requireFlag: updated.Environment?.Variables?.[REQUIRE_KEY] ?? '<unset>',
    envKeys: Object.keys(updated.Environment?.Variables || {}).sort(),
    preservedKeys: merged.preservedKeys,
  };
}

export function waitForLambdaReady() {
  for (let i = 0; i < 20; i += 1) {
    const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA_NAME], { allowFail: true });
    if (!cfg.__error && (cfg.State === 'Active' || cfg.LastUpdateStatus === 'Successful')) {
      return cfg;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  }
  throw new Error('origin_verify_lambda_not_ready');
}
