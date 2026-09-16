#!/usr/bin/env node
/**
 * Fail-closed validation of a compiled production SPA artifact.
 * Inspects dist output, not source .env files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const argDir = (() => {
  const idx = process.argv.indexOf('--dir');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return 'dist';
})();

export const REQUIRED_PRODUCTION_MARKERS = Object.freeze({
  authProvider: 'cognito',
  userPoolId: 'us-east-1_h00WorYMT',
  clientId: '3ja9fqaq2fjkv3i6up2varcqpe',
  apiTarget: '/prep',
});

export const FORBIDDEN_PRODUCTION_MARKERS = Object.freeze({
  stagingPoolId: 'us-east-1_vPmQ7cL1F',
  stagingClientId: '71bb7a192cbl6o6s8m259tl589',
  rawExecuteApi: 'kiqojucc02.execute-api',
});

export const LOGIN_BOOT_MARKERS = Object.freeze([
  'Email me a verification code',
  'Sign in with a passkey',
]);

export const BLANK_SUPABASE_CLIENT_MARKERS = Object.freeze([
  'createClient("", "")',
  'createClient("","")',
  "createClient('', '')",
  "createClient('','')",
]);

export const MONEY_UI_MARKERS = Object.freeze({
  fundFn: 'moov-wallet-fund',
  disburseFn: 'moov-disburse',
  fundTotp: 'wallet.fund',
  disburseTotp: 'wallet.disburse',
  authorizeHeld: 'Authorize held $0.01 fund',
  forbiddenLiveFn: 'moov-transfer-create',
});

const walk = (dir, acc = []) => {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(js|css|html)$/i.test(entry.name)) acc.push(full);
  }
  return acc;
};

const countNeedle = (hay, needle) => {
  let n = 0;
  let i = 0;
  while (true) {
    const found = hay.indexOf(needle, i);
    if (found === -1) return n;
    n += 1;
    i = found + needle.length;
  }
};

export const scanProductionSpaArtifact = (distDir, options = {}) => {
  const requireHardenedAuth = options.requireHardenedAuth !== false;
  const resolved = path.isAbsolute(distDir) ? distDir : path.join(ROOT, distDir);
  const files = walk(resolved);
  const text = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const missing = [];
  const forbidden = [];
  if (!text.includes(REQUIRED_PRODUCTION_MARKERS.apiTarget)) missing.push('production_api_prep');
  if (!text.includes('cognito')) missing.push('cognito_auth_provider');
  if (requireHardenedAuth && !text.includes(REQUIRED_PRODUCTION_MARKERS.userPoolId)) {
    missing.push('production_cognito_pool');
  }
  if (requireHardenedAuth && !text.includes(REQUIRED_PRODUCTION_MARKERS.clientId)) {
    missing.push('production_cognito_client');
  }
  if (requireHardenedAuth && !LOGIN_BOOT_MARKERS.some((marker) => text.includes(marker))) {
    missing.push('bootable_freedom_login');
  }
  if (text.includes(FORBIDDEN_PRODUCTION_MARKERS.stagingPoolId)) forbidden.push('staging_cognito_pool');
  if (text.includes(FORBIDDEN_PRODUCTION_MARKERS.stagingClientId)) forbidden.push('staging_cognito_client');
  if (text.includes(FORBIDDEN_PRODUCTION_MARKERS.rawExecuteApi)) forbidden.push('raw_execute_api');
  if (countNeedle(text, 'supabase.co/functions') > 0) forbidden.push('supabase_functions_host');
  if (BLANK_SUPABASE_CLIENT_MARKERS.some((marker) => text.includes(marker))) {
    forbidden.push('blank_supabase_client');
  }

  const moneyCounts = {
    'moov-wallet-fund': countNeedle(text, MONEY_UI_MARKERS.fundFn),
    'moov-disburse': countNeedle(text, MONEY_UI_MARKERS.disburseFn),
    'wallet.fund': countNeedle(text, MONEY_UI_MARKERS.fundTotp),
    'wallet.disburse': countNeedle(text, MONEY_UI_MARKERS.disburseTotp),
    'Authorize held $0.01 fund': countNeedle(text, MONEY_UI_MARKERS.authorizeHeld),
    'moov-transfer-create': countNeedle(text, MONEY_UI_MARKERS.forbiddenLiveFn),
    'supabase.co/functions': countNeedle(text, 'supabase.co/functions'),
  };
  if (moneyCounts['moov-wallet-fund'] < 1) missing.push('moov-wallet-fund');
  if (moneyCounts['moov-disburse'] < 1) missing.push('moov-disburse');
  if (moneyCounts['wallet.fund'] < 1) missing.push('wallet.fund');
  if (moneyCounts['wallet.disburse'] < 1) missing.push('wallet.disburse');
  if (moneyCounts['Authorize held $0.01 fund'] < 1) missing.push('Authorize held $0.01 fund');
  if (moneyCounts['moov-transfer-create'] > 0) forbidden.push('moov-transfer-create');
  if (moneyCounts['supabase.co/functions'] > 0) forbidden.push('supabase_functions_host');

  return {
    ok: missing.length === 0 && forbidden.length === 0,
    distDir: resolved,
    fileCount: files.length,
    missing,
    forbidden,
    moneyCounts,
    authProvider: missing.includes('cognito_auth_provider') ? 'unknown' : 'cognito',
    userPoolId: text.includes(REQUIRED_PRODUCTION_MARKERS.userPoolId)
      ? REQUIRED_PRODUCTION_MARKERS.userPoolId
      : null,
    clientId: text.includes(REQUIRED_PRODUCTION_MARKERS.clientId)
      ? REQUIRED_PRODUCTION_MARKERS.clientId
      : null,
    apiTarget: text.includes(REQUIRED_PRODUCTION_MARKERS.apiTarget)
      ? REQUIRED_PRODUCTION_MARKERS.apiTarget
      : null,
    hardenedAuth: requireHardenedAuth,
    bootableLogin: LOGIN_BOOT_MARKERS.some((marker) => text.includes(marker)),
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
