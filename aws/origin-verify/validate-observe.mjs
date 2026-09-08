#!/usr/bin/env node
/**
 * Observe-mode validation. Prints only public booleans and PASS/FAIL checks.
 * Never prints the origin-verification secret or CloudFront header values.
 */
import {
  API_ID,
  DISTRIBUTION_ID,
  HEADER_NAME,
  LAMBDA_NAME,
  SECRET_NAME,
  WAF_ARN,
  awsJson,
  parseObserveLogLine,
} from './lib.mjs';

const CF = 'https://checksops.com';
const RAW = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com';

const get = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, cfId: res.headers.get('x-amz-cf-id') };
};

const cfHealth = await get(`${CF}/prep/health`);
const rawHealth = await get(`${RAW}/prep/health`);
const readiness = await get(`${CF}/prep/ops/readiness`);
const financial = await get(`${CF}/prep/financial/status`);

await fetch(`${CF}/prep/health`);
await fetch(`${RAW}/prep/health`);
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

const states = [];
for (const ev of logs.events || []) {
  const parsed = parseObserveLogLine(ev.message);
  if (parsed) states.push(parsed);
}

const cfState = states.find((s) => s.originHeaderPresent) || { originHeaderPresent: false, originHeaderValid: false };
const rawState = states.find((s) => !s.originHeaderPresent) || { originHeaderPresent: false, originHeaderValid: false };

let secretInLogs = false;
try {
  const secret = awsJson(['secretsmanager', 'get-secret-value', '--secret-id', SECRET_NAME]);
  const value = JSON.parse(secret.SecretString || '{}').current || '';
  if (value) {
    for (const ev of logs.events || []) {
      if (String(ev.message || '').includes(value)) secretInLogs = true;
    }
    const apiLogs = awsJson([
      'logs',
      'filter-log-events',
      '--log-group-name',
      '/aws/apigateway/checksops-production-prep-http',
      '--limit',
      '20',
    ], { allowFail: true });
    for (const ev of apiLogs.events || []) {
      if (String(ev.message || '').includes(value)) secretInLogs = true;
    }
  }
} catch {
  /* cannot read secret — report scan skipped */
}

const dist = awsJson(['cloudfront', 'get-distribution', '--id', DISTRIBUTION_ID]);
const waf = dist.Distribution?.DistributionConfig?.WebACLId === WAF_ARN;
const headerNamePresent = Boolean(
  (dist.Distribution?.DistributionConfig?.Origins?.Items || [])
    .find((o) => o.Id === 'ProductionPrepHttpApi')
    ?.CustomHeaders?.Items
    ?.some((h) => h.HeaderName === HEADER_NAME),
);

const integration = awsJson(['apigatewayv2', 'get-integration', '--api-id', API_ID, '--integration-id', 'jci10de']);
const headerStripped = integration.RequestParameters?.[`overwrite:header.${HEADER_NAME}`] === '""'
  || Object.prototype.hasOwnProperty.call(
    integration.RequestParameters || {},
    `remove:header.${HEADER_NAME}`,
  );

const flags = financial.json?.flags || {};
const report = {
  cloudfrontHealth: cfHealth.status === 200 && cfHealth.json?.status === 'ok' && Boolean(cfHealth.cfId),
  rawHealthObserve: rawHealth.status === 200 && rawHealth.json?.status === 'ok',
  cloudfront: cfState,
  executeApiDirect: rawState,
  headerStrippedOnIntegration: headerStripped,
  headerNamePresent,
  headerValuePrinted: false,
  secretInAccessOrAuthorizerLogs: secretInLogs,
  wafAttached: waf,
  holdsOk: readiness.json?.holds?.ok === true,
  productionExecution: financial.json?.productionExecution === false,
  providerFinancialFlagsFalse: Object.entries(flags)
    .filter(([k]) => /MOOV|CHECKALT|PLAID|ACTUM|QUICKBOOKS|PROVIDER_EXECUTION|PROVIDER_LIVE|FINANCIAL_PERMISSIONS|FINANCIAL_SANDBOX|SANDBOX_EXECUTION|FINANCIAL_EXECUTION/.test(k))
    .every(([, v]) => v === false),
  financialActivationSqlApplied: readiness.json?.financialActivationSqlApplied === false,
};

console.log(JSON.stringify(report, null, 2));
const ok = report.cloudfrontHealth
  && report.rawHealthObserve
  && report.cloudfront.originHeaderPresent === true
  && report.cloudfront.originHeaderValid === true
  && report.executeApiDirect.originHeaderPresent === false
  && report.executeApiDirect.originHeaderValid === false
  && report.headerStrippedOnIntegration
  && report.wafAttached
  && report.holdsOk
  && report.productionExecution
  && report.providerFinancialFlagsFalse
  && report.financialActivationSqlApplied
  && !report.secretInAccessOrAuthorizerLogs;
process.exit(ok ? 0 : 1);
