/**
 * Fail-closed production SPA auth/API release gate.
 *
 * Inspects the compiled artifact (JS/HTML), not source .env files.
 * A production SPA must not be uploaded or CloudFront-invalidated unless
 * the artifact proves Cognito + /prep and cannot boot a blank-Supabase
 * Loading shell on /freedom/login.
 *
 * Does not call AWS, apply SQL, or change Cognito/Moov/CheckAlt/financial data.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  PRODUCTION_COGNITO_CLIENT_ID,
  PRODUCTION_COGNITO_POOL_ID,
  PRODUCTION_EXECUTE_API_ID,
  STAGING_API_ID,
  STAGING_COGNITO_CLIENT_ID,
  STAGING_COGNITO_POOL_ID,
  assertAwsSpaBuildEnv,
  isProductionPrepApi,
} from './aws-spa-build-env.mjs';

export {
  PRODUCTION_COGNITO_CLIENT_ID,
  PRODUCTION_COGNITO_POOL_ID,
  PRODUCTION_EXECUTE_API_ID,
  STAGING_API_ID,
  STAGING_COGNITO_CLIENT_ID,
  STAGING_COGNITO_POOL_ID,
  assertAwsSpaBuildEnv,
  isProductionPrepApi,
};
export const PROOF_MARKER = 'checksops.spa.proof';
export const KNOWN_GOOD_PRODUCTION_BUNDLE = 'index-C_NPDCdc.js';
export const FAILED_WRONG_AUTH_BUNDLE = 'index-AfZ8zj4L.js';

export const LOGIN_MOUNT_MARKERS = Object.freeze([
  'Sign in with a passkey',
  'Email me a verification code',
  'Email me a sign-in link',
]);

export const MONEY_UI_MARKERS = Object.freeze({
  fundFn: 'moov-wallet-fund',
  disburseFn: 'moov-disburse',
  fundTotp: 'wallet.fund',
  disburseTotp: 'wallet.disburse',
  authorizeHeld: 'Authorize held $0.01 fund',
  forbiddenLiveFn: 'moov-transfer-create',
});

function walkTextFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTextFiles(full, acc);
    else if (/\.(js|css|html|map|json)$/i.test(entry.name)) acc.push(full);
  }
  return acc;
}

function readArtifactText(distDir) {
  const files = walkTextFiles(distDir);
  return {
    files,
    text: files.map((file) => fs.readFileSync(file, 'utf8')).join('\n'),
    names: files.map((file) => path.basename(file)),
  };
}

export function extractSpaReleaseProof(text) {
  const objectMatch = text.match(/["']checksops\.spa\.proof["']\s*:\s*1/);
  if (!objectMatch || objectMatch.index == null) return null;
  const idx = objectMatch.index;
  const window = text.slice(Math.max(0, idx - 320), idx + 480);
  const pick = (key) => {
    const match = window.match(new RegExp(`${key}\\s*:\\s*"([^"]*)"`))
      || window.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`));
    return match ? match[1] : '';
  };
  const proof = {
    auth: pick('auth').toLowerCase(),
    api: pick('api'),
    pool: pick('pool'),
    client: pick('client'),
  };
  if (!proof.auth && !proof.api && !proof.pool && !proof.client) return null;
  return proof;
}

export function detectBlankSupabaseInit(text) {
  const blankCreateClient = /createClient\(\s*(?:""|'')\s*,\s*(?:""|'')/.test(text);
  const unconfigured = /CHECKSOPS_SPA_AUTH_UNCONFIGURED/.test(text);
  const emptyAuthProof = /auth\s*:\s*""/.test(text) || /"auth"\s*:\s*""/.test(text);
  return blankCreateClient
    || (unconfigured && emptyAuthProof)
    || (text.includes(PROOF_MARKER) && emptyAuthProof && /createClient\(/.test(text));
}

export function detectActiveBrowserSupabase(text) {
  if (/nbcqwpysqgyxrrbgtmkw\.supabase\.co/.test(text)) return true;
  if (/https:\/\/[a-z0-9]+\.supabase\.co/.test(text)) return true;
  if (/supabase\.co\/functions/.test(text)) return true;
  return false;
}

export function detectLoginMount(text) {
  return LOGIN_MOUNT_MARKERS.filter((marker) => text.includes(marker));
}

export function smokeFreedomLogin(text, proof) {
  const loginMarkers = detectLoginMount(text);
  const blankSupabase = detectBlankSupabaseInit(text)
    || (proof && proof.auth !== 'cognito' && !proof.pool);
  const cognitoEnabled = proof?.auth === 'cognito'
    || (text.includes(PRODUCTION_COGNITO_POOL_ID) && text.includes(PRODUCTION_COGNITO_CLIENT_ID)
      && !text.includes(STAGING_COGNITO_POOL_ID));
  const stuckOnLoadingShell = blankSupabase || !cognitoEnabled || loginMarkers.length === 0;
  return {
    route: '/freedom/login',
    loginMarkers,
    canMount: !stuckOnLoadingShell && loginMarkers.length > 0 && cognitoEnabled,
    stuckOnLoadingShell,
    cognitoEnabled,
    blankSupabase,
  };
}

export function validateProductionSpaAuthApi(distDir, { requireProof = false } = {}) {
  const missing = [];
  const forbidden = [];
  if (!distDir || !fs.existsSync(distDir)) {
    return {
      ok: false,
      distDir,
      missing: ['compiled_artifact_dir'],
      forbidden,
      proof: null,
      smoke: { canMount: false, stuckOnLoadingShell: true, route: '/freedom/login' },
    };
  }
  const { text, files, names } = readArtifactText(distDir);
  const proof = extractSpaReleaseProof(text);
  if (requireProof && !proof) missing.push('spa_release_proof');
  const auth = proof?.auth || '';
  const api = proof?.api || '';
  const poolPresent = text.includes(PRODUCTION_COGNITO_POOL_ID);
  const clientPresent = text.includes(PRODUCTION_COGNITO_CLIENT_ID);
  if (auth && auth !== 'cognito') missing.push('cognito_auth_mode');
  if (!auth && !poolPresent) missing.push('cognito_auth_mode');
  if (!poolPresent) missing.push('production_cognito_pool');
  if (!clientPresent) missing.push('production_cognito_client');
  const rollbackApiOk = proof == null
    && poolPresent
    && clientPresent
    && text.includes('/prep');
  const apiOk = isProductionPrepApi(api) || rollbackApiOk;
  if (proof) {
    if (!isProductionPrepApi(proof.api)) missing.push('production_api_prep');
    if (proof.pool !== PRODUCTION_COGNITO_POOL_ID) missing.push('production_cognito_pool');
    if (proof.client !== PRODUCTION_COGNITO_CLIENT_ID) missing.push('production_cognito_client');
    if (proof.auth !== 'cognito') missing.push('cognito_auth_mode');
  } else if (!apiOk) {
    missing.push('production_api_prep');
  }
  if (text.includes(STAGING_COGNITO_POOL_ID)) forbidden.push('staging_cognito_pool');
  if (text.includes(STAGING_COGNITO_CLIENT_ID)) forbidden.push('staging_cognito_client');
  if (text.includes(STAGING_API_ID)) forbidden.push('staging_api');
  if (text.includes(`${PRODUCTION_EXECUTE_API_ID}.execute-api`)) forbidden.push('raw_execute_api');
  // Cognito-proven artifacts may still contain unused publicWorkflowApi fallback
  // strings. Those are not an active browser auth path. Flag supabase hosts only
  // when production Cognito is not inlined.
  if (detectActiveBrowserSupabase(text) && !poolPresent && proof?.auth !== 'cognito') {
    forbidden.push('active_browser_supabase');
  }
  if (detectBlankSupabaseInit(text) && !poolPresent) forbidden.push('blank_supabase_init');
  const smoke = smokeFreedomLogin(text, proof);
  if (smoke.stuckOnLoadingShell) missing.push('freedom_login_mount');
  if (!smoke.canMount) missing.push('application_boot_smoke');
  const missingUnique = [...new Set(missing)];
  const forbiddenUnique = [...new Set(forbidden)];
  return {
    ok: missingUnique.length === 0 && forbiddenUnique.length === 0,
    distDir,
    fileCount: files.length,
    artifactNames: names,
    failedBundle: names.includes(FAILED_WRONG_AUTH_BUNDLE),
    knownGoodBundle: names.includes(KNOWN_GOOD_PRODUCTION_BUNDLE),
    proof,
    missing: missingUnique,
    forbidden: forbiddenUnique,
    smoke,
    authProvider: auth === 'cognito' || (poolPresent && clientPresent && !missingUnique.includes('cognito_auth_mode'))
      ? 'cognito'
      : (auth || 'off'),
    userPoolId: poolPresent ? PRODUCTION_COGNITO_POOL_ID : null,
    clientId: clientPresent ? PRODUCTION_COGNITO_CLIENT_ID : null,
    apiTarget: isProductionPrepApi(proof?.api) || apiOk ? '/prep' : (proof?.api || null),
  };
}

function countNeedle(hay, needle) {
  let n = 0;
  let i = 0;
  while (true) {
    const found = hay.indexOf(needle, i);
    if (found === -1) return n;
    n += 1;
    i = found + needle.length;
  }
}

export function scanMoneyUi(text) {
  const moneyCounts = {
    'moov-wallet-fund': countNeedle(text, MONEY_UI_MARKERS.fundFn),
    'moov-disburse': countNeedle(text, MONEY_UI_MARKERS.disburseFn),
    'wallet.fund': countNeedle(text, MONEY_UI_MARKERS.fundTotp),
    'wallet.disburse': countNeedle(text, MONEY_UI_MARKERS.disburseTotp),
    'Authorize held $0.01 fund': countNeedle(text, MONEY_UI_MARKERS.authorizeHeld),
    'moov-transfer-create': countNeedle(text, MONEY_UI_MARKERS.forbiddenLiveFn),
  };
  const missing = [];
  const forbidden = [];
  if (moneyCounts['moov-wallet-fund'] < 1) missing.push('moov-wallet-fund');
  if (moneyCounts['moov-disburse'] < 1) missing.push('moov-disburse');
  if (moneyCounts['wallet.fund'] < 1) missing.push('wallet.fund');
  if (moneyCounts['wallet.disburse'] < 1) missing.push('wallet.disburse');
  if (moneyCounts['Authorize held $0.01 fund'] < 1) missing.push('Authorize held $0.01 fund');
  if (moneyCounts['moov-transfer-create'] > 0) forbidden.push('moov-transfer-create');
  return { moneyCounts, missing, forbidden };
}

export function scanProductionSpaArtifact(distDir, { requireProof = false, requireMoneyUi = true } = {}) {
  const auth = validateProductionSpaAuthApi(distDir, { requireProof });
  if (!fs.existsSync(distDir)) {
    return { ...auth, moneyCounts: {} };
  }
  const { text } = readArtifactText(distDir);
  const money = scanMoneyUi(text);
  const missing = requireMoneyUi ? [...auth.missing, ...money.missing] : [...auth.missing];
  const forbidden = [...auth.forbidden, ...money.forbidden];
  return {
    ...auth,
    missing: [...new Set(missing)],
    forbidden: [...new Set(forbidden)],
    moneyCounts: money.moneyCounts,
    ok: missing.length === 0 && forbidden.length === 0,
  };
}

export function assertProductionSpaArtifactOrThrow(distDir, options = {}) {
  const validation = scanProductionSpaArtifact(distDir, options);
  if (!validation.ok) {
    const error = new Error('production_spa_auth_api_gate_rejected');
    error.code = 'production_spa_auth_api_gate_rejected';
    error.validation = validation;
    throw error;
  }
  return validation;
}

export async function smokeArtifactHttpServer(distDir, { pathName = '/freedom/login' } = {}) {
  const index = path.join(distDir, 'index.html');
  if (!fs.existsSync(index)) {
    return { ok: false, error: 'index.html missing', pathName };
  }
  const html = fs.readFileSync(index, 'utf8');
  const jsHref = (html.match(/assets\/index-[A-Za-z0-9_-]+\.js/) || [])[0];
  if (!jsHref) return { ok: false, error: 'spa_bundle_missing_from_index', pathName };
  const server = http.createServer((req, res) => {
    const reqPath = req.url === '/' || req.url?.startsWith('/freedom')
      ? '/index.html'
      : req.url.split('?')[0];
    const file = path.join(distDir, reqPath.replace(/^\//, ''));
    if (!file.startsWith(distDir) || !fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathName}`);
    const body = await response.text();
    return {
      ok: response.ok && body.includes('index-') && /<div id="root">/.test(body),
      status: response.status,
      pathName,
      servedIndex: body.includes('id="root"'),
      bundleHref: jsHref,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

export function guardProductionSpaRelease({
  distDir,
  apply = false,
  s3Upload = async () => {
    throw new Error('s3_upload_not_wired');
  },
  cloudfrontInvalidate = async () => {
    throw new Error('cloudfront_invalidate_not_wired');
  },
  requireProof = false,
} = {}) {
  const validation = validateProductionSpaAuthApi(distDir, { requireProof });
  const mutations = { s3Uploaded: false, cloudfrontInvalidated: false };
  if (!validation.ok) {
    return {
      ok: false,
      uploaded: false,
      cloudfrontInvalidated: false,
      error: 'production_spa_auth_api_gate_rejected',
      validation,
      mutations,
    };
  }
  if (!apply) {
    return {
      ok: true,
      uploaded: false,
      cloudfrontInvalidated: false,
      error: null,
      validation,
      mutations,
    };
  }
  throw new Error('production_spa_apply_refused_in_guard: pass validation does not authorize S3/CloudFront mutation from this module');
}
