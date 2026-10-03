#!/usr/bin/env node
/**
 * Invoke the dedicated staging SQL 47 oneshot. Refuses production and
 * shared function names. Does not send caller SQL.
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
  const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  if (FORBIDDEN_FUNCTIONS.includes(FUNCTION_NAME)) {
    throw new Error('refusing shared function invoke');
  }
  const payload = {
    action,
    function_name: FUNCTION_NAME,
    target_environment: 'staging',
    workstream_id: extra.workstream_id || 'mortgage-agent-compensation-ad99',
    one_use_id: extra.one_use_id || `${action}-${Date.now()}`,
    expected_live_definition_sha256: extra.expected_live_definition_sha256 || null,
  };
  const payloadFile = path.join(os.tmpdir(), `macomp47-payload-${process.pid}.json`);
  const outFile = path.join(os.tmpdir(), `macomp47-out-${process.pid}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  awsJson([
    'lambda', 'invoke',
    '--function-name', FUNCTION_NAME,
    '--cli-binary-format', 'raw-in-base64-out',
    '--payload', `file://${payloadFile}`,
    outFile,
  ]);
  const result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const dest = extra.out || `/opt/cursor/artifacts/macomp47_${action}.json`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) main();
