#!/usr/bin/env node
/**
 * Gate 3C: OPTIONS /{proxy+} NONE, strip origin header on jci10de,
 * attach REQUEST authorizer to $default in observe mode.
 * Does not set ORIGIN_VERIFY_REQUIRE=true.
 */
import {
  API_ID,
  AUTHORIZER_NAME,
  HEADER_NAME,
  INTEGRATION_ID,
  LAMBDA_NAME,
  PREP_LAMBDA,
  awsJson,
  refuseRequireMode,
  requireGate,
  requireStep3Temp,
  shouldExecute,
} from './lib.mjs';

refuseRequireMode();
requireGate('CHECKSOPS_APPLY_GATE3C');

if (!shouldExecute()) {
  console.log(JSON.stringify({
    gate: '3C',
    apiId: API_ID,
    optionsRoute: 'OPTIONS /{proxy+}',
    optionsAuthorization: 'NONE',
    integrationId: INTEGRATION_ID,
    headerRemoved: HEADER_NAME,
    attachMode: 'observe',
    ORIGIN_VERIFY_REQUIRE: false,
    note: 'Plan only. Set CHECKSOPS_STEP3_EXECUTE=1 to apply.',
  }));
  process.exit(2);
}

const identity = requireStep3Temp();

const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', LAMBDA_NAME]);
const requireFlag = cfg.Environment?.Variables?.ORIGIN_VERIFY_REQUIRE;
if (requireFlag === 'true') throw new Error('refusing_require_mode_already_true');

const authorizers = awsJson(['apigatewayv2', 'get-authorizers', '--api-id', API_ID]);
const authorizer = (authorizers.Items || []).find((a) => a.Name === AUTHORIZER_NAME);
if (!authorizer) throw new Error('authorizer_missing');

const routes = awsJson(['apigatewayv2', 'get-routes', '--api-id', API_ID]);
let options = (routes.Items || []).find((r) => r.RouteKey === 'OPTIONS /{proxy+}');
if (!options) {
  options = awsJson([
    'apigatewayv2',
    'create-route',
    '--api-id',
    API_ID,
    '--route-key',
    'OPTIONS /{proxy+}',
    '--authorization-type',
    'NONE',
    '--target',
    `integrations/${INTEGRATION_ID}`,
  ]);
} else if (options.AuthorizationType !== 'NONE') {
  awsJson([
    'apigatewayv2',
    'update-route',
    '--api-id',
    API_ID,
    '--route-id',
    options.RouteId,
    '--authorization-type',
    'NONE',
  ]);
}

const integration = awsJson([
  'apigatewayv2',
  'get-integration',
  '--api-id',
  API_ID,
  '--integration-id',
  INTEGRATION_ID,
]);
if (!String(integration.IntegrationUri || '').includes(PREP_LAMBDA)) {
  throw new Error('refusing_to_retarget_prep_integration');
}
const overwriteKey = `overwrite:header.${HEADER_NAME}`;
const removeKey = `remove:header.${HEADER_NAME}`;
// HTTP API drops empty remove: values via CLI and rejects combining remove+overwrite.
// overwrite to an empty-string mapping blanks the header before the prep Lambda.
const params = { ...(integration.RequestParameters || {}), [overwriteKey]: '""' };
delete params[removeKey];
const integInput = {
  ApiId: API_ID,
  IntegrationId: INTEGRATION_ID,
  RequestParameters: params,
};
awsJson([
  'apigatewayv2',
  'update-integration',
  '--cli-input-json',
  JSON.stringify(integInput),
]);
const after = awsJson([
  'apigatewayv2',
  'get-integration',
  '--api-id',
  API_ID,
  '--integration-id',
  INTEGRATION_ID,
]);
if (!String(after.IntegrationUri || '').includes(PREP_LAMBDA)) {
  throw new Error('integration_uri_changed');
}

const def = (routes.Items || []).find((r) => r.RouteKey === '$default');
if (!def) throw new Error('missing_$default');
awsJson([
  'apigatewayv2',
  'update-route',
  '--api-id',
  API_ID,
  '--route-id',
  def.RouteId,
  '--authorization-type',
  'CUSTOM',
  '--authorizer-id',
  authorizer.AuthorizerId,
]);

const routesAfter = awsJson(['apigatewayv2', 'get-routes', '--api-id', API_ID]);
const defAfter = (routesAfter.Items || []).find((r) => r.RouteKey === '$default');
const optAfter = (routesAfter.Items || []).find((r) => r.RouteKey === 'OPTIONS /{proxy+}');

console.log(JSON.stringify({
  gate: '3C',
  identity,
  optionsRoute: optAfter?.RouteKey,
  optionsAuthorization: optAfter?.AuthorizationType,
  defaultAuthorizationType: defAfter?.AuthorizationType,
  authorizerId: authorizer.AuthorizerId,
  headerStripConfigured: after.RequestParameters?.[overwriteKey] === '""'
    || after.RequestParameters?.[removeKey] === '',
  integrationStillPrep: String(after.IntegrationUri || '').includes(PREP_LAMBDA),
  ORIGIN_VERIFY_REQUIRE: requireFlag || 'false',
  attachMode: 'observe',
}));
