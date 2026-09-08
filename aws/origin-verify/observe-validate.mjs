#!/usr/bin/env node
/**
 * Observe-mode validation. Prints only public boolean states.
 * Never prints the origin-verification secret, hash, prefix, or CloudFront header value.
 */
import { spawnSync } from 'node:child_process';
import { publicVerifyLine } from './lib.mjs';

const parseLog = (line) => {
  try {
    const obj = JSON.parse(line);
    if ('originHeaderPresent' in obj || 'originHeaderValid' in obj) {
      return publicVerifyLine(obj);
    }
  } catch {
    return null;
  }
  return null;
};

const raw = process.argv.slice(2).join('\n');
if (raw.includes('HeaderValue') || raw.includes('SecretString') || /"current"\s*:\s*"[a-f0-9]{16,}"/i.test(raw)) {
  console.error('REFUSE: input looks like secret material');
  process.exit(2);
}

const events = raw
  .split('\n')
  .map((line) => parseLog(line.trim()))
  .filter(Boolean);

if (events.length === 0 && process.env.CHECKSOPS_OBSERVE_SAMPLE) {
  const sample = JSON.parse(process.env.CHECKSOPS_OBSERVE_SAMPLE);
  events.push(publicVerifyLine(sample));
}

const summary = {
  cloudfront: events.find((e) => e.originHeaderPresent) || { originHeaderPresent: false, originHeaderValid: false },
  executeApiDirect: events.find((e) => !e.originHeaderPresent) || { originHeaderPresent: false, originHeaderValid: false },
};

console.log(JSON.stringify({
  cloudfront: {
    originHeaderPresent: summary.cloudfront.originHeaderPresent,
    originHeaderValid: summary.cloudfront.originHeaderValid,
  },
  executeApiDirect: {
    originHeaderPresent: summary.executeApiDirect.originHeaderPresent,
    originHeaderValid: summary.executeApiDirect.originHeaderValid,
  },
}));

if (process.argv.includes('--aws-logs')) {
  const out = spawnSync(
    'aws',
    [
      'logs',
      'filter-log-events',
      '--log-group-name',
      '/aws/lambda/checksops-production-origin-verify',
      '--limit',
      '20',
      '--query',
      'events[].message',
      '--output',
      'text',
    ],
    { encoding: 'utf8', env: process.env },
  );
  for (const line of String(out.stdout || '').split('\n')) {
    const parsed = parseLog(line.trim());
    if (parsed) console.log(JSON.stringify(parsed));
  }
}
