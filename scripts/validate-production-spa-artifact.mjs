#!/usr/bin/env node
/**
 * Fail-closed validation of a compiled production SPA artifact.
 * Inspects dist output, not source .env files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_COGNITO_CLIENT_ID,
  PRODUCTION_COGNITO_POOL_ID,
  PRODUCTION_PREP_API_ID,
  STAGING_API_ID,
  STAGING_COGNITO_CLIENT_ID,
  STAGING_COGNITO_POOL_ID,
} from '../aws/functions/api/production-cognito-locks.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const argDir = (() => {
  const idx = process.argv.indexOf('--dir');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return 'dist';
})();

export const REQUIRED_PRODUCTION_MARKERS = Object.freeze({
  authProvider: 'cognito',
  userPoolId: PRODUCTION_COGNITO_POOL_ID,
  clientId: PRODUCTION_COGNITO_CLIENT_ID,
  apiTarget: '/prep',
});

export const FORBIDDEN_PRODUCTION_MARKERS = Object.freeze({
  stagingPoolId: STAGING_COGNITO_POOL_ID,
  stagingClientId: STAGING_COGNITO_CLIENT_ID,
  stagingApiId: STAGING_API_ID,
  rawExecuteApi: `${PRODUCTION_PREP_API_ID}.execute-api`,
});

const walk = (dir, acc = []) => {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(js|css|html|map|json|txt)$/i.test(entry.name)) acc.push(full);
  }
  return acc;
};

export const scanProductionSpaArtifact = (distDir) => {
  const resolved = path.isAbsolute(distDir) ? distDir : path.join(ROOT, distDir);
  const files = walk(resolved);
  const text = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const missing = [];
  const forbidden = [];
  if (!text.includes(REQUIRED_PRODUCTION_MARKERS.userPoolId)) missing.push('production_cognito_pool');
  if (!text.includes(REQUIRED_PRODUCTION_MARKERS.clientId)) missing.push('production_cognito_client');
  if (!text.includes(REQUIRED_PRODUCTION_MARKERS.apiTarget)) missing.push('production_api_prep');
  if (!/(["'`])cognito\1/.test(text) && !text.includes('VITE_AUTH_PROVIDER') && !text.includes('"cognito"')) {
    if (!text.includes('cognito')) missing.push('cognito_auth_provider');
  }
  if (text.includes(FORBIDDEN_PRODUCTION_MARKERS.stagingPoolId)) forbidden.push('staging_cognito_pool');
  if (text.includes(FORBIDDEN_PRODUCTION_MARKERS.stagingClientId)) forbidden.push('staging_cognito_client');
  if (text.includes(FORBIDDEN_PRODUCTION_MARKERS.stagingApiId)) forbidden.push('staging_api');
  if (text.includes(FORBIDDEN_PRODUCTION_MARKERS.rawExecuteApi)) forbidden.push('raw_execute_api');
  if (/nbcqwpysqgyxrrbgtmkw\.supabase\.co/.test(text) || /https:\/\/[a-z0-9]+\.supabase\.co/.test(text)) {
    forbidden.push('supabase_host');
  }
  const supabaseSelected = /nbcqwpysqgyxrrbgtmkw\.supabase\.co/.test(text)
    && !text.includes(REQUIRED_PRODUCTION_MARKERS.userPoolId);
  if (supabaseSelected) missing.push('supabase_mode_selected');
  return {
    ok: missing.length === 0 && forbidden.length === 0,
    distDir: resolved,
    fileCount: files.length,
    missing,
    forbidden,
    authProvider: missing.includes('cognito_auth_provider') || missing.includes('supabase_mode_selected')
      ? 'supabase'
      : 'cognito',
    userPoolId: text.includes(REQUIRED_PRODUCTION_MARKERS.userPoolId)
      ? REQUIRED_PRODUCTION_MARKERS.userPoolId
      : null,
    clientId: text.includes(REQUIRED_PRODUCTION_MARKERS.clientId)
      ? REQUIRED_PRODUCTION_MARKERS.clientId
      : null,
    apiTarget: text.includes(REQUIRED_PRODUCTION_MARKERS.apiTarget)
      ? REQUIRED_PRODUCTION_MARKERS.apiTarget
      : null,
  };
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = scanProductionSpaArtifact(argDir);
  if (!result.ok) {
    console.error(JSON.stringify({
      error: 'production_spa_artifact_rejected',
      ...result,
    }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
