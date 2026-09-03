#!/usr/bin/env node
/**
 * Invoke checksops-staging-api with GET /providers/egress.
 * Proof must come from the Lambda itself, not this host.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const FUNCTION_NAME = process.env.STAGING_API_FUNCTION || 'checksops-staging-api';

const payload = {
  rawPath: '/providers/egress',
  requestContext: { stage: 'staging', http: { method: 'GET', path: '/providers/egress' } },
};

try {
  const raw = execFileSync('aws', [
    '--region', REGION,
    'lambda', 'invoke',
    '--function-name', FUNCTION_NAME,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', JSON.stringify(payload),
    '/tmp/checksops-egress-probe.json',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const body = JSON.parse(fs.readFileSync('/tmp/checksops-egress-probe.json', 'utf8'));
  const parsed = typeof body.body === 'string' ? JSON.parse(body.body) : body;
  console.log(JSON.stringify({
    ok: parsed.ok === true && parsed.moovReachable === true && parsed.checkaltUatReachable === true,
    invoke: raw.trim().slice(0, 200),
    from: 'checksops-staging-api',
    statusCode: body.statusCode || parsed.statusCode,
    moovReachable: parsed.moovReachable,
    checkaltUatReachable: parsed.checkaltUatReachable,
    secretsUsed: parsed.secretsUsed,
    rdsMadePublic: parsed.rdsMadePublic,
    productionExecution: parsed.productionExecution,
    targets: parsed.targets,
  }, null, 2));
  process.exit(parsed.ok ? 0 : 2);
} catch (error) {
  const stderr = String(error.stderr || error.message || error);
  console.log(JSON.stringify({
    ok: false,
    classification: /ExpiredToken|expired/i.test(stderr)
      ? 'BLOCKED BY AWS CREDENTIALS / IAM'
      : 'BLOCKED BY PROVIDER TEST ENVIRONMENT',
    error: stderr.slice(0, 400),
    from: 'not_lambda',
  }, null, 2));
  process.exit(2);
}
