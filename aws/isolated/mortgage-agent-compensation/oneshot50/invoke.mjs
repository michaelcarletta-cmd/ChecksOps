#!/usr/bin/env node
/**
 * Inspect-only invoke helper. Apply is refused here on purpose.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUNCTION_NAME, FORBIDDEN_FUNCTIONS } from './constants.mjs';

const AWS = process.env.AWS_CLI || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';

function awsJson(args) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : {};
}

function main() {
  const action = process.argv[2] || 'inspect';
  if (FORBIDDEN_FUNCTIONS.includes(FUNCTION_NAME) || FUNCTION_NAME !== 'checksops-staging-macomp50-oneshot') {
    throw new Error('refusing shared or production function invoke');
  }
  if (action !== 'inspect') {
    throw new Error('this helper is inspect-only; apply is a later authorization');
  }
  const payload = {
    action: 'inspect',
    function_name: FUNCTION_NAME,
    target_environment: 'staging',
    period: '2026-10',
  };
  const payloadFile = path.join(os.tmpdir(), `macomp50-payload-${process.pid}.json`);
  const outFile = path.join(os.tmpdir(), `macomp50-out-${process.pid}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  awsJson([
    'lambda', 'invoke',
    '--function-name', FUNCTION_NAME,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', `file://${payloadFile}`,
    outFile,
  ]);
  const result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const dest = '/opt/cursor/artifacts/macomp50_inspect.json';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) main();
