/**
 * Classify repository scripts that can mutate shared staging/production.
 * Do not delete legacy scripts. They must call require-guard or remain
 * classified LEGACY/BYPASS until a follow-up migrates them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGuardConfig, repoRootFrom } from './lib.mjs';

export const SCAN_GLOBS = Object.freeze([
  'scripts/',
  'aws/',
]);

export const SCAN_EXTENSIONS = Object.freeze(['.mjs', '.js', '.sh', '.py']);

export const BYPASS_PATTERNS = Object.freeze([
  { id: 'lambda_update_function_code', re: /update-function-code|UpdateFunctionCode/ },
  { id: 's3_spa_upload', re: /s3\s+sync|s3\s+cp|putObject\(|upload.*index\.html/i },
  { id: 'index_html_replace', re: /index\.html/ },
  { id: 'cloudfront_invalidation', re: /create-invalidation|CreateInvalidation/ },
  { id: 'cloudfront_update', re: /cloudfront[\s'",.]+update-distribution|update-distribution/ },
  { id: 'production_deploy', re: /production-prep-api|CHECKSOPS_PRODUCTION_DEPLOY|sam deploy/ },
  { id: 'staging_deploy', re: /checksops-staging-api|sam deploy --config-env staging/ },
  { id: 'sql_rpc_apply', re: /CREATE OR REPLACE FUNCTION|psql\s+/ },
]);

export const SKIP_DIR_NAMES = Object.freeze(new Set([
  'node_modules',
  '.git',
  'dist',
  '.aws-sam',
]));

function walk(absDir, files = []) {
  if (!fs.existsSync(absDir)) return files;
  for (const name of fs.readdirSync(absDir)) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const abs = path.join(absDir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      walk(abs, files);
      continue;
    }
    if (SCAN_EXTENSIONS.includes(path.extname(name))) files.push(abs);
  }
  return files;
}

export function scanBypassCandidates(root = repoRootFrom(import.meta.url)) {
  const files = [];
  for (const rel of SCAN_GLOBS) {
    walk(path.join(root, rel), files);
  }
  const hits = [];
  for (const abs of files) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (rel.startsWith('scripts/deployment-guard/')) continue;
    if (rel === 'aws/tests/deployment-guard.test.mjs') continue;
    if (/\.test\.mjs$/.test(rel) || /\/tests\//.test(rel)) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const capabilities = BYPASS_PATTERNS
      .filter((row) => row.re.test(text))
      .map((row) => row.id);
    if (!capabilities.length) continue;
    if (capabilities.length === 1 && capabilities[0] === 'index_html_replace' && !/s3|cloudfront|upload|deploy/i.test(text)) {
      continue;
    }
    if (capabilities.length === 1 && capabilities[0] === 'sql_rpc_apply' && /test\.mjs$/.test(rel)) {
      continue;
    }
    hits.push({ path: rel, capabilities });
  }
  return hits.sort((a, b) => a.path.localeCompare(b.path));
}

export function classifyAgainstInventory(hits, inventory) {
  const byPath = new Map((inventory.scripts || []).map((row) => [row.path, row]));
  const missing = [];
  const unknownClass = [];
  for (const hit of hits) {
    const row = byPath.get(hit.path);
    if (!row) {
      missing.push(hit);
      continue;
    }
    if (!['SAFE', 'NEEDS_GUARD', 'LEGACY/BYPASS'].includes(row.classification)) {
      unknownClass.push({ ...hit, classification: row.classification });
    }
  }
  return { missing, unknownClass, inventoried: inventory.scripts || [] };
}

export function main(argv = process.argv.slice(2), extras = {}) {
  const root = extras.root || repoRootFrom(import.meta.url);
  const config = extras.config || loadGuardConfig(root);
  const hits = scanBypassCandidates(root);
  const classified = classifyAgainstInventory(hits, config.inventory);
  const report = {
    ok: classified.missing.length === 0 && classified.unknownClass.length === 0,
    scanned: hits.length,
    inventoried: classified.inventoried.length,
    missing: classified.missing,
    unknownClass: classified.unknownClass,
  };
  const out = JSON.stringify(report, null, 2);
  if (!report.ok) {
    console.error(out);
    return 1;
  }
  if (!argv.includes('--quiet')) console.log(out);
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  process.exitCode = main();
}
