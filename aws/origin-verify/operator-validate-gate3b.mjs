#!/usr/bin/env node
/**
 * Privileged-operator post-3B validation only.
 * Never calls GetSecretValue. Never prints header values.
 * Does not attach the authorizer or start Gate 3C.
 */
import {
  DISTRIBUTION_ID,
  HEADER_NAME,
  WAF_ARN,
  awsJson,
} from './lib.mjs';

const CF = 'https://checksops.com';
const RAW = 'https://kiqojucc02.execute-api.us-east-1.amazonaws.com';

const get = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  let json = null;
  try { json = await res.json(); } catch { /* html */ }
  return { status: res.status, json, cfId: res.headers.get('x-amz-cf-id') };
};

const dist = awsJson(['cloudfront', 'get-distribution', '--id', DISTRIBUTION_ID]);
const cfg = dist.Distribution?.DistributionConfig || {};
const origin = (cfg.Origins?.Items || []).find((o) => o.Id === 'ProductionPrepHttpApi') || {};
const names = (origin.CustomHeaders?.Items || []).map((h) => h.HeaderName);
const cf = await get(`${CF}/prep/health`);
const raw = await get(`${RAW}/prep/health`);

const report = {
  gate: '3B-validate',
  status: dist.Distribution?.Status,
  deployed: dist.Distribution?.Status === 'Deployed',
  wafUnchanged: cfg.WebACLId === WAF_ARN,
  headerNamePresent: names.includes(HEADER_NAME),
  headerValuePrinted: false,
  cloudfrontHealth: cf.status === 200 && cf.json?.status === 'ok' && Boolean(cf.cfId),
  rawHealth: raw.status === 200 && raw.json?.status === 'ok',
  authorizerAttached: false,
  startGate3C: false,
};

console.log(JSON.stringify(report, null, 2));
const ok = report.deployed && report.wafUnchanged && report.cloudfrontHealth && report.rawHealth;
process.exit(ok ? 0 : 1);
