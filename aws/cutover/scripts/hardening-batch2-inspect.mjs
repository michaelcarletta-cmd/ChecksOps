#!/usr/bin/env node
/**
 * Read-only Batch 2 inspect: CloudFront WAF/logging, API throttle/CORS/logs.
 */
import { execFileSync } from 'node:child_process';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const DIST = 'E1B0ZWWO5559U5';
const PREP = 'checksops-production-prep-api';
const STAGING = 'checksops-staging-api';

if (process.argv.some((a) => ['--apply', '--activate', '--fix'].includes(a))) {
  console.error(JSON.stringify({ error: 'refusing_mutation_from_batch2_inspect' }));
  process.exit(2);
}

const run = (args, extra = {}) => {
  try {
    return JSON.parse(execFileSync(AWS, ['--region', extra.region || REGION, '--output', 'json', ...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }) || '{}');
  } catch (error) {
    return { _denied: true, message: String(error.stderr || error.message || error).slice(0, 360) };
  }
};

const cf = run(['cloudfront', 'get-distribution', '--id', DIST]);
const cfg = cf.Distribution?.DistributionConfig || {};
const prep = run(['lambda', 'get-function-configuration', '--function-name', PREP]);
const staging = run(['lambda', 'get-function-configuration', '--function-name', STAGING]);
const apis = run(['apigatewayv2', 'get-apis']);
const wafCf = run(['wafv2', 'list-web-acls', '--scope', 'CLOUDFRONT']);
const wafReg = run(['wafv2', 'list-web-acls', '--scope', 'REGIONAL']);
const flagOff = (vars, key) => String(vars?.[key] || 'false').toLowerCase() !== 'true';
const prepVars = prep.Environment?.Variables || {};
const stagingVars = staging.Environment?.Variables || {};

const report = {
  generatedAt: new Date().toISOString(),
  mutated: false,
  cloudfront: {
    id: DIST,
    status: cf.Distribution?.Status || null,
    webAclId: cfg.WebACLId || null,
    logging: cfg.Logging || null,
    aliases: cfg.Aliases?.Items || [],
    denied: Boolean(cf._denied),
  },
  waf: {
    cloudfront: wafCf._denied ? { denied: true, message: wafCf.message } : { names: (wafCf.WebACLs || []).map((w) => w.Name) },
    regional: wafReg._denied ? { denied: true, message: wafReg.message } : { names: (wafReg.WebACLs || []).map((w) => w.Name) },
  },
  apis: apis._denied ? { denied: true, message: apis.message } : {
    items: (apis.Items || []).map((api) => ({ id: api.ApiId, name: api.Name, cors: api.CorsConfiguration || null })),
  },
  lambda: {
    prepRole: prep.Role || null,
    stagingRole: staging.Role || null,
    prepFlags: {
      AWS_MOOV_ENABLED: prepVars.AWS_MOOV_ENABLED || null,
      AWS_CHECKALT_ENABLED: prepVars.AWS_CHECKALT_ENABLED || null,
      AWS_PROVIDER_EXECUTION_ENABLED: prepVars.AWS_PROVIDER_EXECUTION_ENABLED || null,
      AWS_FINANCIAL_PERMISSIONS_ACTIVATED: prepVars.AWS_FINANCIAL_PERMISSIONS_ACTIVATED || null,
    },
    moovOff: flagOff(prepVars, 'AWS_MOOV_ENABLED'),
    stagingSandbox: stagingVars.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED || null,
  },
};
console.log(JSON.stringify(report, null, 2));
