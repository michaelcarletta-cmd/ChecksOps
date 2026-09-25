#!/usr/bin/env node
/**
 * Overlay selected files onto live checksops-staging-api via UpdateFunctionCode.
 * Does not SAM-deploy thin aws/template.yaml. Staging only.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AWS = process.env.AWS_CLI || (existsSync(`${process.env.HOME}/.local/bin/aws`)
  ? `${process.env.HOME}/.local/bin/aws`
  : 'aws');
const REGION = process.env.AWS_REGION || 'us-east-1';
const FUNCTION_NAME = process.env.STAGING_API_FUNCTION || 'checksops-staging-api';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = (process.env.OVERLAY_FILES || [
  'aws/functions/api/endorsement-material-invalidation.mjs',
  'aws/functions/api/write-check-workflow.mjs',
].join(',')).split(',').map((part) => part.trim()).filter(Boolean);

const awsJson = (args) => JSON.parse(execFileSync(AWS, ['--region', REGION, ...args], { encoding: 'utf8' }));

const waitUpdated = () => {
  for (let i = 0; i < 30; i += 1) {
    const cfg = awsJson(['lambda', 'get-function-configuration', '--function-name', FUNCTION_NAME]);
    if (cfg.LastUpdateStatus === 'Successful') return cfg;
    if (cfg.LastUpdateStatus === 'Failed') throw new Error(`Lambda update failed: ${cfg.LastUpdateStatusReason}`);
    execFileSync('sleep', ['4']);
  }
  throw new Error('Lambda update did not become Successful');
};

const findDest = (extractDir, basename) => {
  const matches = execFileSync('bash', ['-lc', `find ${JSON.stringify(extractDir)} -name ${JSON.stringify(basename)} -type f`], {
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);
  if (matches.length === 1) return matches[0];
  const preferred = matches.find((file) => !file.includes('node_modules') && (file.endsWith(`/${basename}`) || file.endsWith(`\\${basename}`)));
  if (preferred) return preferred;
  return path.join(extractDir, basename);
};

const main = async () => {
  const before = awsJson(['lambda', 'get-function', '--function-name', FUNCTION_NAME]);
  const beforeSha = before.Configuration?.CodeSha256;
  const work = path.join(os.tmpdir(), `checksops-overlay-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const zipPath = path.join(work, 'current.zip');
  execFileSync('curl', ['-fsSL', before.Code.Location, '-o', zipPath]);
  const extractDir = path.join(work, 'pkg');
  mkdirSync(extractDir);
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', extractDir]);
  const copied = [];
  for (const rel of FILES) {
    const src = path.join(ROOT, rel);
    if (!existsSync(src)) throw new Error(`missing overlay source ${rel}`);
    let dest = findDest(extractDir, path.basename(rel));
    if (!existsSync(dest)) {
      const sibling = findDest(extractDir, 'financial.mjs');
      dest = path.join(path.dirname(sibling), path.basename(rel));
    }
    copyFileSync(src, dest);
    copied.push({ src: rel, dest: dest.replace(extractDir, '') });
  }
  const outZip = path.join(work, 'updated.zip');
  execFileSync('zip', ['-qr', outZip, '.'], { cwd: extractDir });
  awsJson(['lambda', 'update-function-code', '--function-name', FUNCTION_NAME, '--zip-file', `fileb://${outZip}`]);
  const after = waitUpdated();
  const report = {
    functionName: FUNCTION_NAME,
    region: REGION,
    beforeSha,
    afterSha: after.CodeSha256,
    lastUpdateStatus: after.LastUpdateStatus,
    lastModified: after.LastModified,
    copied,
  };
  writeFileSync('/tmp/checksops-staging-overlay.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  rmSync(work, { recursive: true, force: true });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
