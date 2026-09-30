#!/usr/bin/env node
/**
 * Fail-closed scanner for unregistered shared-target deployment writers.
 * Ignores tests, markdown, IAM YAML, and evaluator mentions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRootFrom } from './lib/paths.mjs';

export const SCAN_PATTERNS = Object.freeze([
  { id: 'lambda-update-function-code', re: /(?:^|[\s'"`])update-function-code(?:$|[\s'"`])/ },
  { id: 'lambda-sdk-update-function-code', re: /UpdateFunctionCodeCommand|\.updateFunctionCode\s*\(/ },
  { id: 'cloudfront-update-distribution', re: /(?:^|[\s'"`])update-distribution(?:$|[\s'"`])/ },
  { id: 'cloudfront-create-invalidation', re: /create-invalidation/ },
  { id: 'sam-deploy', re: /\bsam\s+deploy\b/ },
  { id: 'cloudformation-mutate', re: /(?:create-stack|update-stack|cloudformation\s+deploy)\b/ },
  { id: 's3-spa-index', re: /s3(?:api)?[\s'"` ,]+(?:sync|cp|put-object)[\s\S]{0,160}index\.html|index\.html[\s\S]{0,120}s3(?:api)?[\s'"` ,]+(?:sync|cp|put-object)/ },
  { id: 'apigateway-mutate', re: /apigatewayv2['"`\s,\[]+(?:create-route|update-route|update-integration)\b/ },
  { id: 'sql-psql-exec', re: /(?:execFileSync|spawnSync|execSync)\(\s*['"`]psql['"`]/ },
]);

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', '.aws-sam', '.deployment-guard', '.cursor']);
const SKIP_EXT = new Set(['.md', '.mdc', '.mdx', '.yml', '.yaml', '.json', '.sql', '.txt']);
const HOOK_RE = /enforceScriptGuard|enforceSharedLambdaTarget|enforceS3Target|refuseUnguardedDeploy/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
      continue;
    }
    const ext = path.extname(entry.name);
    if (SKIP_EXT.has(ext)) continue;
    if (entry.name.endsWith('.test.mjs')) continue;
    out.push(abs);
  }
  return out;
}

export function relativePosix(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

export function scanFile(text, rel) {
  const hits = [];
  if (/assert\.doesNotMatch|forbidden \(no s3 sync/.test(text) && !/execFileSync|spawnSync/.test(text)) {
    return hits;
  }
  for (const pattern of SCAN_PATTERNS) {
    if (pattern.re.test(text)) hits.push(pattern.id);
  }
  return hits;
}

export function loadInventory(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
}

export function scanRepository(root) {
  const inventory = loadInventory(root);
  const byPath = Object.fromEntries((inventory.scripts || []).map((row) => [row.path, row]));
  const files = walk(root);
  const errors = [];
  const findings = [];

  for (const abs of files) {
    const rel = relativePosix(root, abs);
    if (rel.startsWith('scripts/deployment-guard/lib/')) continue;
    if (rel === 'scripts/deployment-guard/scan-bypass.mjs') continue;
    if (rel === 'scripts/lib/production-spa-baseline.mjs') continue;
    const text = fs.readFileSync(abs, 'utf8');
    const hits = scanFile(text, rel);
    if (!hits.length) continue;
    const row = byPath[rel];
    findings.push({ path: rel, hits, classification: row?.classification || 'UNREGISTERED' });
    if (!row) {
      errors.push(`unregistered shared-target writer: ${rel} (${hits.join(', ')})`);
      continue;
    }
    if (row.scanner_allow_mention === true) continue;
    const needsHook = ['MUST_REFUSE_DIRECT', 'MUST_WRAP', 'GUARDED'].includes(row.classification);
    if (needsHook && !HOOK_RE.test(text)) {
      errors.push(`${rel} is ${row.classification} but does not call enforceScriptGuard/refuseUnguardedDeploy`);
    }
    if (row.classification === 'NON_SHARED/SAFE' && hits.includes('lambda-update-function-code') && !/enforceSharedLambdaTarget/.test(text)) {
      errors.push(`${rel} can retarget a shared Lambda and must call enforceSharedLambdaTarget`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    findings,
  };
}

export function main(argv = process.argv.slice(2), root = repoRootFrom(import.meta.url)) {
  const result = scanRepository(root);
  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, code: 'UNREGISTERED_DEPLOYMENT_WRITER', errors: result.errors }, null, 2));
    return 1;
  }
  console.log(JSON.stringify({ ok: true, findings: result.findings }, null, 2));
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
