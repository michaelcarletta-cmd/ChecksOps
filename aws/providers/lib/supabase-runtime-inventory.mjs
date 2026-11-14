/**
 * Read-only scanner for remaining Supabase runtime dependencies.
 * Does not mutate files, call networks, or deploy.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CLASS = {
  LIVE_RUNTIME: 'live_runtime',
  COMPATIBILITY_ALIAS: 'compatibility_alias',
  TEST: 'test',
  DEAD_CODE: 'dead_code',
  DOCUMENTATION: 'documentation',
};

export const PRODUCTION_PROJECT_REF = 'nbcqwpysqgyxrrbgtmkw';
export const PRODUCTION_SUPABASE_HOST = `${PRODUCTION_PROJECT_REF}.supabase.co`;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.lovable',
  'darwin-estimate-builder',
]);

const SKIP_FILES = new Set([
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
]);

const SKIP_RELS = new Set([
  'aws/providers/results/supabase_remaining_live_inventory.json',
]);

const INCLUDE_DOT = new Set([
  '.github',
  '.env',
  '.env.example',
  '.env.production',
  '.env.aws.example',
  '.env.production.aws.example',
]);

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx',
  '.json', '.yml', '.yaml', '.toml', '.md', '.sql',
  '.example', '.production', '.env', '.txt', '.html',
]);

const SRC_CLIENT_IMPORT = /from\s+['"]@\/integrations\/supabase\/(?:client|mortgageClient)['"]/;
const CREATE_CLIENT = /createClient\s*(?:<[^>]+>)?\s*\(/;
const SUPABASE_JS = /@supabase\/supabase-js/;
const GET_SESSION = /\.auth\.getSession\s*\(/;
const FUNCTIONS_INVOKE = /\.functions\.invoke\s*\(/;
const STORAGE_FROM = /\.storage\.from\s*\(/;
const TABLE_FROM = /\.from\s*\(\s*['"][a-z0-9_]+['"]/;
const RPC = /\.rpc\s*\(\s*['"]/;
const CHANNEL = /\.channel\s*\(/;
const ENV_VITE = /VITE_SUPABASE_(?:URL|PUBLISHABLE_KEY|PROJECT_ID|ANON_KEY)/;
const ENV_SERVER = /\bSUPABASE_(?:URL|ANON_KEY|SERVICE_ROLE_KEY|PUBLISHABLE_KEY|ACCESS_TOKEN)\b/;
const HOST_RE = /([a-z0-9-]+)\.supabase\.co/gi;
const FETCH_VITE_URL = /fetch\s*\(\s*[`'"]\$\{(?:import\.meta\.env\.)?VITE_SUPABASE_URL\}/;
const FETCH_SUPABASE_URL_VAR = /fetch\s*\(\s*(?:[\s\S]{0,80})?[`'"]\$\{supabaseUrl\}\/functions\/v1/;
const XHR_VITE_URL = /VITE_SUPABASE_URL\}\/functions\/v1/;
const HARDCODED_HOST = new RegExp(PRODUCTION_SUPABASE_HOST.replace(/\./g, '\\.'));

export const DIRECT_BROWSER_SUPABASE_FETCH_FILES = Object.freeze([
  'src/pages/Unsubscribe.tsx',
  'src/lib/payments/verificationFiles.ts',
  'src/lib/publicWorkflowApi.ts',
]);

export const SDK_INIT_FILES = Object.freeze([
  'src/integrations/supabase/client.ts',
  'src/integrations/supabase/mortgageClient.ts',
]);

export const AWS_COMPAT_FILES = Object.freeze([
  'src/integrations/aws/client.ts',
  'src/integrations/aws/storage.ts',
  'src/lib/awsStaging.ts',
  'src/lib/backendMode.ts',
  'src/lib/awsApiBase.ts',
]);

function isTextFile(rel) {
  const base = path.basename(rel);
  if (base.startsWith('.env')) return true;
  const ext = path.extname(base);
  if (TEXT_EXT.has(ext)) return true;
  if (base === 'Dockerfile' || base.endsWith('.Dockerfile')) return true;
  return false;
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && !INCLUDE_DOT.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, abs, out);
      continue;
    }
    if (SKIP_FILES.has(entry.name) || SKIP_RELS.has(rel)) continue;
    if (!isTextFile(rel)) continue;
    out.push(rel);
  }
}

function isTestPath(rel) {
  if (/\.test\.[cm]?[jt]sx?$/.test(rel)) return true;
  if (/(^|\/)tests?\//.test(rel)) return true;
  if (rel.startsWith('scripts/test-')) return true;
  if (rel.startsWith('aws/tests/')) return true;
  if (rel.startsWith('supabase/security/') && rel.endsWith('.test.mjs')) return true;
  return false;
}

function isDocPath(rel) {
  return rel.endsWith('.md') || rel.endsWith('.MD');
}

function removalWave(row) {
  if (row.classification_staging === CLASS.COMPATIBILITY_ALIAS || AWS_COMPAT_FILES.includes(row.rel) || SDK_INIT_FILES.includes(row.rel)) {
    return 0;
  }
  if (row.classification_production === CLASS.DOCUMENTATION || row.classification_production === CLASS.TEST) return 1;
  if (row.classification_production === CLASS.DEAD_CODE && row.classification_staging === CLASS.DEAD_CODE) return 2;
  if (row.classification_staging === CLASS.DEAD_CODE && row.rel.startsWith('supabase/')) return 3;
  return 4;
}

function ownerFor(rel) {
  if (rel.startsWith('src/integrations/aws/') || rel === 'src/lib/awsStaging.ts' || rel === 'src/lib/backendMode.ts') {
    return 'identity-cognito';
  }
  if (rel.startsWith('src/lib/payments/') || rel.includes('moov') || rel.includes('checkalt') || rel.includes('financial')) {
    return 'financial-ledger';
  }
  if (rel.startsWith('supabase/functions/aws-staging-') || rel.startsWith('aws/db-copy/') || rel.startsWith('aws/storage/')) {
    return 'migration-bridges';
  }
  if (rel.startsWith('supabase/functions/')) return 'lovable-edge';
  if (rel.startsWith('supabase/migrations/') || rel.startsWith('supabase/security/')) return 'hosted-schema';
  if (rel.startsWith('src/')) return 'frontend-compat';
  if (isTestPath(rel)) return 'aws-migration-ci';
  if (rel.startsWith('aws/')) return 'aws-migration';
  if (rel.startsWith('.github/')) return 'production-release';
  return 'platform';
}

function riskFor(file) {
  if (file.signals.includes('hardcoded_supabase_host') && file.classification_production === CLASS.LIVE_RUNTIME) {
    return 'high';
  }
  if (file.signals.includes('direct_browser_fetch') && file.classification_production === CLASS.LIVE_RUNTIME) {
    return 'high';
  }
  if (file.signals.includes('sdk_init') && file.classification_production === CLASS.LIVE_RUNTIME) {
    return 'high';
  }
  if (file.rel.startsWith('supabase/functions/') && /moov-|checkalt-|plaid-|tenant-checkout|homeowner-deductible/.test(file.rel)) {
    return 'critical';
  }
  if (file.rel.startsWith('supabase/functions/aws-staging-')) return 'high';
  if (file.signals.includes('getSession')) return 'medium';
  if (file.classification_production === CLASS.LIVE_RUNTIME) return 'medium';
  if (file.classification_staging === CLASS.COMPATIBILITY_ALIAS) return 'low';
  if (file.classification_production === CLASS.TEST) return 'none';
  if (file.classification_production === CLASS.DOCUMENTATION) return 'none';
  return 'low';
}

function classify(rel, source, signals) {
  if (isTestPath(rel)) {
    return {
      production: CLASS.TEST,
      staging: CLASS.TEST,
    };
  }
  if (isDocPath(rel)) {
    return {
      production: CLASS.DOCUMENTATION,
      staging: CLASS.DOCUMENTATION,
    };
  }

  if (AWS_COMPAT_FILES.includes(rel) || rel.startsWith('src/integrations/aws/')) {
    return {
      production: CLASS.COMPATIBILITY_ALIAS,
      staging: CLASS.COMPATIBILITY_ALIAS,
    };
  }

  if (SDK_INIT_FILES.includes(rel)) {
    return {
      production: CLASS.LIVE_RUNTIME,
      staging: CLASS.COMPATIBILITY_ALIAS,
    };
  }

  if (rel === 'src/lib/publicWorkflowApi.ts') {
    return {
      production: CLASS.LIVE_RUNTIME,
      staging: CLASS.COMPATIBILITY_ALIAS,
    };
  }

  if (rel === 'src/lib/storagePath.ts') {
    return {
      production: CLASS.DEAD_CODE,
      staging: CLASS.DEAD_CODE,
    };
  }

  if (rel === '.env.production' || rel === 'vite.config.ts') {
    return {
      production: CLASS.LIVE_RUNTIME,
      staging: CLASS.DEAD_CODE,
    };
  }

  if (rel === '.env.aws.example' || rel === '.env.production.aws.example') {
    return {
      production: CLASS.DEAD_CODE,
      staging: CLASS.COMPATIBILITY_ALIAS,
    };
  }

  if (rel === '.env.example' || rel === 'supabase.json' || rel === 'supabase-beta.json') {
    return {
      production: CLASS.DEAD_CODE,
      staging: CLASS.DEAD_CODE,
    };
  }

  if (rel.startsWith('supabase/functions/aws-staging-')) {
    return {
      production: CLASS.LIVE_RUNTIME,
      staging: CLASS.LIVE_RUNTIME,
    };
  }

  if (rel.startsWith('supabase/functions/') || rel.startsWith('supabase/migrations/') || rel.startsWith('supabase/config')) {
    return {
      production: CLASS.LIVE_RUNTIME,
      staging: CLASS.DEAD_CODE,
    };
  }

  if (rel.startsWith('aws/cutover/') || rel.startsWith('aws/db-copy/') || rel.startsWith('aws/storage/copy-from-supabase')) {
    const staging = /bridge|supabase/i.test(rel) ? CLASS.LIVE_RUNTIME : CLASS.TEST;
    return {
      production: CLASS.TEST,
      staging,
    };
  }

  if (rel.startsWith('src/') && SRC_CLIENT_IMPORT.test(source) && !CREATE_CLIENT.test(source)) {
    return {
      production: CLASS.LIVE_RUNTIME,
      staging: CLASS.COMPATIBILITY_ALIAS,
    };
  }

  if (signals.includes('direct_browser_fetch')) {
    return {
      production: CLASS.LIVE_RUNTIME,
      staging: CLASS.DEAD_CODE,
    };
  }

  if (signals.includes('hardcoded_supabase_host') || signals.includes('env_read') || signals.includes('sdk_init')) {
    return {
      production: CLASS.LIVE_RUNTIME,
      staging: CLASS.DEAD_CODE,
    };
  }

  return {
    production: CLASS.LIVE_RUNTIME,
    staging: CLASS.DEAD_CODE,
  };
}

function collectSignals(rel, source) {
  const signals = [];
  if (SDK_INIT_FILES.includes(rel) && CREATE_CLIENT.test(source)) signals.push('sdk_init');
  if (SRC_CLIENT_IMPORT.test(source)) signals.push('compat_import');
  if (CREATE_CLIENT.test(source) && SUPABASE_JS.test(source)) signals.push('createClient');
  if (GET_SESSION.test(source) || (rel === 'src/integrations/aws/client.ts' && /getSession:\s*async/.test(source))) {
    signals.push('getSession');
  }
  if (FUNCTIONS_INVOKE.test(source)) signals.push('functions.invoke');
  if (STORAGE_FROM.test(source)) signals.push('storage.from');
  if (TABLE_FROM.test(source)) signals.push('from_table');
  if (RPC.test(source)) signals.push('rpc');
  if (CHANNEL.test(source)) signals.push('realtime');
  if (ENV_VITE.test(source) || ENV_SERVER.test(source)) signals.push('env_read');
  if (HARDCODED_HOST.test(source)) signals.push('hardcoded_supabase_host');
  if (
    rel.startsWith('src/')
    && (
      FETCH_VITE_URL.test(source)
      || FETCH_SUPABASE_URL_VAR.test(source)
      || XHR_VITE_URL.test(source)
      || (rel === 'src/lib/publicWorkflowApi.ts' && HARDCODED_HOST.test(source))
    )
  ) {
    signals.push('direct_browser_fetch');
  }
  const hosts = [...source.matchAll(HOST_RE)].map((m) => m[0].toLowerCase());
  if (hosts.length) signals.push('supabase_host');
  return { signals: [...new Set(signals)], hosts: [...new Set(hosts)] };
}

function relevant(source, rel) {
  if (isDocPath(rel) && /supabase/i.test(source)) return /supabase\.co|VITE_SUPABASE|createClient|functions\.invoke/.test(source);
  return /supabase|VITE_SUPABASE|SUPABASE_URL|SUPABASE_ANON|SUPABASE_SERVICE|SUPABASE_PUBLISHABLE/i.test(source);
}

export function scanSupabaseRuntimeInventory(root) {
  const files = [];
  walk(root, root, files);
  const rows = [];
  for (const rel of files) {
    let source = '';
    try {
      const abs = path.join(root, rel);
      const stat = fs.statSync(abs);
      if (stat.size > 2_000_000) continue;
      source = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (!relevant(source, rel)) continue;
    const { signals, hosts } = collectSignals(rel, source);
    if (signals.length === 0 && !/supabase/i.test(source) && !hosts.length) continue;
    const classification = classify(rel, source, signals);
    const row = {
      rel,
      signals,
      hosts,
      classification_production: classification.production,
      classification_staging: classification.staging,
      owner: ownerFor(rel),
      getSession_backend_production: signals.includes('getSession') ? 'supabase_auth' : null,
      getSession_backend_staging: signals.includes('getSession') ? 'cognito_via_aws_adapter' : null,
    };
    row.risk = riskFor(row);
    row.removal_wave = removalWave(row);
    rows.push(row);
  }
  rows.sort((a, b) => a.rel.localeCompare(b.rel));

  const countBy = (key, env) => {
    const map = {};
    for (const row of rows) {
      const value = env === 'production' ? row.classification_production : row.classification_staging;
      if (!map[value]) map[value] = 0;
      map[value] += 1;
    }
    return map;
  };

  const getSessionFiles = rows.filter((row) => row.signals.includes('getSession')).map((row) => row.rel);
  const sdkInit = rows.filter((row) => row.signals.includes('sdk_init')).map((row) => row.rel);
  const directFetch = rows.filter((row) => row.signals.includes('direct_browser_fetch')).map((row) => row.rel);
  const hardcoded = rows.filter((row) => row.signals.includes('hardcoded_supabase_host')).map((row) => row.rel);
  const envReads = rows.filter((row) => row.signals.includes('env_read')).map((row) => row.rel);
  const edgeFunctions = fs.readdirSync(path.join(root, 'supabase/functions'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
    .map((entry) => entry.name)
    .sort();

  return {
    generated_for: 'issue-811',
    removal_authorized: false,
    compatibility_interface_must_remain: true,
    production_project_ref: PRODUCTION_PROJECT_REF,
    summary: {
      files: rows.length,
      production: countBy('classification', 'production'),
      staging: countBy('classification', 'staging'),
      getSession_files: getSessionFiles.length,
      sdk_init_files: sdkInit.length,
      direct_browser_fetch_files: directFetch.length,
      hardcoded_host_files: hardcoded.length,
      edge_functions: edgeFunctions.length,
    },
    getSession_files: getSessionFiles,
    sdk_init_files: sdkInit,
    direct_browser_fetch_files: directFetch,
    hardcoded_host_files: hardcoded,
    env_read_files: envReads,
    edge_functions: edgeFunctions,
    files: rows,
  };
}

export function assertInventoryInvariants(inventory, root) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const client = read('src/integrations/supabase/client.ts');
  const mortgage = read('src/integrations/supabase/mortgageClient.ts');
  const adapter = read('src/integrations/aws/client.ts');
  const workflow = read('src/lib/publicWorkflowApi.ts');
  const vite = read('vite.config.ts');
  const prodEnv = read('.env.production');
  const awsEnv = read('.env.aws.example');

  if (!client.includes('createAwsStagingClient') || !client.includes('createClient')) {
    throw new Error('supabase client lost dual AWS/Supabase init');
  }
  if (!mortgage.includes('createAwsStagingClient') || !mortgage.includes('createClient')) {
    throw new Error('mortgage client lost dual AWS/Supabase init');
  }
  if (adapter.includes('supabase.co') || adapter.includes('VITE_SUPABASE_URL')) {
    throw new Error('AWS adapter must not target Supabase hosts');
  }
  if (!adapter.includes('getSession:') || !adapter.includes('/auth/refresh') || !adapter.includes('/identity/me')) {
    throw new Error('AWS getSession is not Cognito-backed');
  }
  if (!workflow.includes('if (!AWS_BUILD)') || !workflow.includes(PRODUCTION_SUPABASE_HOST)) {
    throw new Error('publicWorkflowApi production host gate missing');
  }
  if (!vite.includes('must be unset in aws mode')) {
    throw new Error('vite aws mode no longer forbids Supabase env');
  }
  if (!prodEnv.includes(`VITE_SUPABASE_URL=https://${PRODUCTION_SUPABASE_HOST}`)) {
    throw new Error('.env.production is not the live Supabase URL');
  }
  if (/VITE_AUTH_PROVIDER\s*=\s*cognito/.test(prodEnv)) {
    throw new Error('.env.production must not enable Cognito');
  }
  if (awsEnv.includes('VITE_SUPABASE_URL')) {
    throw new Error('.env.aws.example must not set VITE_SUPABASE_URL');
  }
  const direct = [...inventory.direct_browser_fetch_files].sort();
  const expected = [...DIRECT_BROWSER_SUPABASE_FETCH_FILES].sort();
  if (JSON.stringify(direct) !== JSON.stringify(expected)) {
    throw new Error(`direct browser Supabase fetch files drifted: ${direct.join(',')}`);
  }
  for (const rel of SDK_INIT_FILES) {
    const row = inventory.files.find((file) => file.rel === rel);
    if (!row || row.classification_production !== CLASS.LIVE_RUNTIME || row.classification_staging !== CLASS.COMPATIBILITY_ALIAS) {
      throw new Error(`${rel} classification drifted`);
    }
  }
  const adapterRow = inventory.files.find((file) => file.rel === 'src/integrations/aws/client.ts');
  if (!adapterRow || adapterRow.classification_staging !== CLASS.COMPATIBILITY_ALIAS) {
    throw new Error('AWS client is not classified as compatibility alias');
  }
  if (inventory.removal_authorized !== false) {
    throw new Error('inventory must not authorize removal');
  }
}
