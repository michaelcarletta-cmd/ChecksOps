#!/usr/bin/env node
/**
 * Attach checksops.com / www.checksops.com and the issued ACM cert to the
 * unused production CloudFront distribution. Does not change DNS.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const REGION = 'us-east-1';
const DIST = 'E1B0ZWWO5559U5';
const ACM = 'arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3';
const ALIASES = ['checksops.com', 'www.checksops.com'];

if (!process.argv.includes('--confirm-cf-aliases')) {
  console.error(JSON.stringify({ error: 'refusing_cloudfront_alias_update' }));
  process.exit(2);
}

const awsJson = (args, extra = {}) => JSON.parse(execFileSync(AWS, [
  '--region', extra.region || REGION,
  '--output', 'json',
  ...args,
], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) || '{}');

const stripReadonly = (cfg) => {
  const out = JSON.parse(JSON.stringify(cfg));
  delete out.ETag;
  return out;
};

const applyAliases = (cfg) => {
  cfg.Aliases = { Quantity: ALIASES.length, Items: ALIASES };
  cfg.ViewerCertificate = {
    CloudFrontDefaultCertificate: false,
    ACMCertificateArn: ACM,
    SSLSupportMethod: 'sni-only',
    MinimumProtocolVersion: 'TLSv1.2_2021',
    Certificate: ACM,
    CertificateSource: 'acm',
  };
  return cfg;
};

const current = awsJson(['cloudfront', 'get-distribution', '--id', DIST], { region: 'us-east-1' });
let etag = current.ETag;
let cfg = current.Distribution?.DistributionConfig;
if (!cfg || !etag) {
  try {
    const alt = awsJson(['cloudfront', 'get-distribution-config', '--id', DIST]);
    etag = alt.ETag;
    cfg = alt.DistributionConfig;
  } catch (error) {
    throw new Error(`cannot load distribution config: ${String(error.message || error).slice(0, 240)}`);
  }
}

cfg = applyAliases(stripReadonly(cfg));
mkdirSync('/tmp/t0', { recursive: true });
const cfgPath = '/tmp/t0/cf-prod-aliases.json';
writeFileSync(cfgPath, JSON.stringify(cfg));

let updated;
try {
  updated = awsJson([
    'cloudfront', 'update-distribution',
    '--id', DIST,
    '--if-match', etag,
    '--distribution-config', `file://${cfgPath}`,
  ]);
} catch (error) {
  const message = String(error.message || error);
  console.error(JSON.stringify({
    error: 'update_distribution_failed',
    message: message.slice(0, 400),
  }));
  process.exit(1);
}

const dist = updated.Distribution || {};
const report = {
  ok: true,
  dnsChanged: false,
  route53Touched: false,
  cloudflareTouched: false,
  id: DIST,
  domain: dist.DomainName,
  status: dist.Status,
  aliases: dist.DistributionConfig?.Aliases?.Items || [],
  certificate: dist.DistributionConfig?.ViewerCertificate?.ACMCertificateArn || null,
  sslMethod: dist.DistributionConfig?.ViewerCertificate?.SSLSupportMethod || null,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.aliases.includes('checksops.com') && report.aliases.includes('www.checksops.com') && report.certificate === ACM ? 0 : 1);
