#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const AWS = process.env.AWS_CLI || `${process.env.HOME}/.local/bin/aws`;
const DIST = 'E1B0ZWWO5559U5';
const ACM = 'arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3';

console.log(JSON.stringify({ waiting: true, id: DIST }));
execFileSync(AWS, ['--region', 'us-east-1', 'cloudfront', 'wait', 'distribution-deployed', '--id', DIST], { stdio: 'inherit' });
const dist = JSON.parse(execFileSync(AWS, [
  '--region', 'us-east-1', '--output', 'json',
  'cloudfront', 'get-distribution', '--id', DIST,
], { encoding: 'utf8' }));
const cfg = dist.Distribution?.DistributionConfig || {};
const aliases = cfg.Aliases?.Items || [];
const report = {
  deployed: dist.Distribution?.Status === 'Deployed',
  status: dist.Distribution?.Status,
  enabled: cfg.Enabled === true,
  domain: dist.Distribution?.DomainName,
  aliases,
  hasApex: aliases.includes('checksops.com'),
  hasWww: aliases.includes('www.checksops.com'),
  certificate: cfg.ViewerCertificate?.ACMCertificateArn || null,
  ssl: cfg.ViewerCertificate?.SSLSupportMethod || null,
  minProtocol: cfg.ViewerCertificate?.MinimumProtocolVersion || null,
  dnsChanged: false,
};
report.ok = report.deployed && report.enabled && report.hasApex && report.hasWww && report.certificate === ACM;
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
