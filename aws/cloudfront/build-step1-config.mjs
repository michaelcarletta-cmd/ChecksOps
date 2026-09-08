#!/usr/bin/env node
/**
 * Build the Step 1 CloudFront DistributionConfig locally.
 * READ-ONLY / DRY-RUN. Does not call AWS. Does not deploy.
 *
 * Usage:
 *   node aws/cloudfront/build-step1-config.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPLY = String(process.env.CHECKSOPS_APPLY_CF_STEP1 || '').trim();

if (APPLY) {
  console.error('DO_NOT_DEPLOY: this builder refuses AWS writes. Unset CHECKSOPS_APPLY_CF_STEP1.');
  process.exit(2);
}

const constants = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'aws/cloudfront/step1-constants.json'), 'utf8'),
);
const baselineDoc = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'aws/cloudfront/E1B0ZWWO5559U5.live-baseline.json'), 'utf8'),
);

const apiBehavior = (pathPattern) => ({
  PathPattern: pathPattern,
  TargetOriginId: constants.apiOriginId,
  TrustedSigners: { Enabled: false, Quantity: 0 },
  TrustedKeyGroups: { Enabled: false, Quantity: 0 },
  ViewerProtocolPolicy: 'https-only',
  AllowedMethods: {
    Quantity: constants.allowedMethods.length,
    Items: constants.allowedMethods,
    CachedMethods: {
      Quantity: constants.cachedMethods.length,
      Items: constants.cachedMethods,
    },
  },
  SmoothStreaming: false,
  Compress: true,
  LambdaFunctionAssociations: { Quantity: 0 },
  FunctionAssociations: { Quantity: 0 },
  FieldLevelEncryptionId: '',
  CachePolicyId: constants.cachePolicyIdCachingDisabled,
  OriginRequestPolicyId: constants.originRequestPolicyIdAllViewerExceptHostHeader,
  GrpcConfig: { Enabled: false },
});

export function buildStep1Config(baselineConfig, functionArn = constants.functionArn) {
  const cfg = structuredClone(baselineConfig);

  if (cfg.WebACLId !== 'arn:aws:wafv2:us-east-1:806168576068:global/webacl/checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7') {
    throw new Error('refusing_to_drop_waf');
  }
  if (cfg.Origins?.Items?.[0]?.Id !== 'ProductionSpaS3') {
    throw new Error('refusing_to_drop_s3_origin');
  }
  if (cfg.Origins.Items[0].OriginAccessControlId !== 'E35N26NNHZAG11') {
    throw new Error('refusing_to_drop_oac');
  }

  const apiOrigin = {
    Id: constants.apiOriginId,
    DomainName: constants.apiOriginDomain,
    OriginPath: constants.originPath,
    CustomHeaders: { Quantity: 0 },
    CustomOriginConfig: {
      HTTPPort: 80,
      HTTPSPort: 443,
      OriginProtocolPolicy: 'https-only',
      OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] },
      OriginReadTimeout: 30,
      OriginKeepaliveTimeout: 5,
    },
    ConnectionAttempts: 3,
    ConnectionTimeout: 10,
    OriginShield: { Enabled: false },
  };

  const origins = cfg.Origins.Items.filter((o) => o.Id !== constants.apiOriginId);
  origins.push(apiOrigin);
  cfg.Origins = { Quantity: origins.length, Items: origins };

  cfg.DefaultCacheBehavior.FunctionAssociations = {
    Quantity: 1,
    Items: [
      {
        FunctionARN: functionArn,
        EventType: 'viewer-request',
      },
    ],
  };

  cfg.CacheBehaviors = {
    Quantity: 2,
    Items: [apiBehavior('/prep'), apiBehavior('/prep/*')],
  };

  cfg.CustomErrorResponses = { Quantity: 0 };

  return cfg;
}

const proposed = buildStep1Config(baselineDoc.DistributionConfig);
const outPath = path.join(ROOT, 'aws/cloudfront/E1B0ZWWO5559U5.step1.proposed.json');
fs.writeFileSync(outPath, `${JSON.stringify({
  doNotDeploy: true,
  distributionId: constants.distributionId,
  functionName: constants.functionName,
  note: 'Pass this DistributionConfig to UpdateDistribution with a fresh IfMatch ETag. DO NOT DEPLOY FROM THIS PR.',
  DistributionConfig: proposed,
}, null, 2)}\n`);
console.log(JSON.stringify({ wrote: path.relative(ROOT, outPath), doNotDeploy: true }));
