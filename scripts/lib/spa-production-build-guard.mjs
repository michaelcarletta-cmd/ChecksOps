/**
 * Production SPA build contract.
 *
 * Production promotions must use `vite build --mode production`, never
 * `vite --mode aws`. Staging Cognito and the staging execute-api URL are
 * rejected. Same-origin `/prep` and production Cognito are required.
 */
const PROD_POOL = 'us-east-1_h00WorYMT';
const PROD_CLIENT = '3ja9fqaq2fjkv3i6up2varcqpe';
const STAGING_POOL = 'us-east-1_vPmQ7cL1F';
const STAGING_CLIENT = '71bb7a192cbl6o6s8m259tl589';
const STAGING_API = 'psr19uhop4';

const fail = (errors) => ({ ok: false, errors });
const ok = (extra = {}) => ({ ok: true, errors: [], ...extra });

export const PRODUCTION_SPA_CONTRACT = {
  mode: 'production',
  VITE_AUTH_PROVIDER: 'cognito',
  VITE_APP_URL: 'https://checksops.com',
  VITE_CHECKSOPS_API_URL: '/prep',
  VITE_COGNITO_USER_POOL_ID: PROD_POOL,
  VITE_COGNITO_USER_POOL_CLIENT_ID: PROD_CLIENT,
};

export const parseEnvText = (text) => {
  const env = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
};

export const assertProductionSpaBuild = ({ mode, env = {}, entryJs = '', argv = [] } = {}) => {
  const errors = [];
  const tokens = argv.flatMap((item) => String(item).split(/\s+/));
  if (mode === 'aws' || tokens.includes('--mode') && tokens[tokens.indexOf('--mode') + 1] === 'aws') {
    errors.push('production SPA must not use vite --mode aws; use --mode production');
  }
  const pool = String(env.VITE_COGNITO_USER_POOL_ID || '');
  const client = String(env.VITE_COGNITO_USER_POOL_CLIENT_ID || '');
  const api = String(env.VITE_CHECKSOPS_API_URL || '');
  const app = String(env.VITE_APP_URL || '');
  const provider = String(env.VITE_AUTH_PROVIDER || '').toLowerCase();
  if (pool === STAGING_POOL || String(entryJs).includes(STAGING_POOL)) {
    errors.push('staging Cognito pool is forbidden in a production SPA build');
  }
  if (client === STAGING_CLIENT || String(entryJs).includes(STAGING_CLIENT)) {
    errors.push('staging Cognito client is forbidden in a production SPA build');
  }
  if (api.includes(STAGING_API) || String(entryJs).includes(STAGING_API)) {
    errors.push('staging execute-api URL is forbidden in a production SPA build');
  }
  if (provider && provider !== 'cognito') {
    errors.push('production SPA requires VITE_AUTH_PROVIDER=cognito');
  }
  if (mode === 'production' || !mode) {
    if (pool && pool !== PROD_POOL) errors.push(`production SPA requires ${PROD_POOL}`);
    if (client && client !== PROD_CLIENT) errors.push(`production SPA requires client ${PROD_CLIENT}`);
    if (api && api !== '/prep') errors.push('production SPA requires VITE_CHECKSOPS_API_URL=/prep');
    if (app && app !== 'https://checksops.com') errors.push('production SPA requires VITE_APP_URL=https://checksops.com');
  }
  if (mode === 'aws') {
    errors.push('staging .env.aws / --mode aws cannot be promoted to production');
  }
  return errors.length ? fail(errors) : ok({ contract: PRODUCTION_SPA_CONTRACT });
};

export const assertProductionBuilderSource = (builderSource) => {
  const text = String(builderSource || '');
  const errors = [];
  if (!text.includes("vite', 'build', '--mode', 'production'")) {
    errors.push('production builder must invoke vite build --mode production');
  }
  if (text.includes("--mode', 'aws'") || text.includes('--mode aws')) {
    errors.push('production builder must never pass --mode aws');
  }
  if (!text.includes(PROD_POOL)) errors.push('production builder must pin production Cognito pool');
  if (!text.includes(PROD_CLIENT)) errors.push('production builder must pin production Cognito client');
  if (!text.includes("VITE_CHECKSOPS_API_URL: '/prep'") && !text.includes("VITE_CHECKSOPS_API_URL=/prep")) {
    errors.push('production builder must pin VITE_CHECKSOPS_API_URL=/prep');
  }
  if (!text.includes('https://checksops.com')) {
    errors.push('production builder must pin VITE_APP_URL=https://checksops.com');
  }
  return errors.length ? fail(errors) : ok();
};
