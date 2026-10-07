#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGION = 'us-east-1';
const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
const PRODUCTION_BUCKET = 'checksops-production-frontend-806168576068';

function awsJson(args, env) {
  const aws = env.AWS_CLI || env.AWS || 'aws';
  return execFileSync(aws, ['--region', REGION, '--output', 'json', ...args], {
    encoding: 'utf8',
    env,
  });
}

function entryFromHtml(html) {
  const match = String(html || '').match(/\/assets\/index-[^"'\\s]+\.js/);
  return match ? match[0] : null;
}

export function readStagingFingerprint({
  bucket = STAGING_BUCKET,
  env = process.env,
  runAws = awsJson,
} = {}) {
  if (bucket === PRODUCTION_BUCKET) {
    throw new Error('staging-spa-inspect must never target production');
  }
  if (bucket !== STAGING_BUCKET) {
    throw new Error('staging-spa-inspect received an unexpected target');
  }

  const head = JSON.parse(runAws([
    's3api', 'head-object', '--bucket', STAGING_BUCKET, '--key', 'index.html',
  ], env) || '{}');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-staging-spa-inspect-'));
  const indexPath = path.join(tempDir, 'index.html');
  try {
    runAws([
      's3api', 'get-object', '--bucket', STAGING_BUCKET, '--key', 'index.html', indexPath,
    ], env);
    const html = fs.readFileSync(indexPath, 'utf8');
    return {
      index_html_sha256: createHash('sha256').update(String(html || ''), 'utf8').digest('hex'),
      entry_bundle: entryFromHtml(html),
      ETag: String(head.ETag || '').replaceAll('"', ''),
      LastModified: head.LastModified || null,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function main({ bucket = STAGING_BUCKET, env = process.env, runAws = awsJson, writeOutput = console.log } = {}) {
  const fingerprint = readStagingFingerprint({ bucket, env, runAws });
  writeOutput(JSON.stringify(fingerprint, null, 2));
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
