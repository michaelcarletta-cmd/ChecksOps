/**
 * Fail-closed Vite AWS-mode env check.
 * Imported by vite.config.ts so a missing Cognito/API configuration cannot
 * emit a deployable blank-Supabase artifact.
 *
 * Keep this file shebang-free and free of CLI side effects: Vite bundles it.
 */
export const PRODUCTION_COGNITO_POOL_ID = 'us-east-1_h00WorYMT';
export const PRODUCTION_COGNITO_CLIENT_ID = '3ja9fqaq2fjkv3i6up2varcqpe';
export const STAGING_COGNITO_POOL_ID = 'us-east-1_vPmQ7cL1F';
export const STAGING_COGNITO_CLIENT_ID = '71bb7a192cbl6o6s8m259tl589';
export const STAGING_API_ID = 'psr19uhop4';
export const PRODUCTION_EXECUTE_API_ID = 'kiqojucc02';

export function isProductionPrepApi(api) {
  const value = String(api || '').trim().replace(/\/$/, '');
  return value === '/prep' || value === 'same-origin' || value === 'same-origin:/prep';
}

export function assertAwsSpaBuildEnv({ mode, env = {}, processEnv = process.env } = {}) {
  const errors = [];
  const awsMode = mode === 'aws' || mode === 'production-aws';
  if (!awsMode) return { ok: true, errors, production: false };
  const auth = String(env.VITE_AUTH_PROVIDER || '').toLowerCase();
  const api = String(env.VITE_CHECKSOPS_API_URL || '').trim();
  const pool = String(env.VITE_COGNITO_USER_POOL_ID || '');
  const client = String(env.VITE_COGNITO_USER_POOL_CLIENT_ID || '');
  if (auth !== 'cognito') {
    errors.push('vite build --mode aws requires VITE_AUTH_PROVIDER=cognito; otherwise AWS mode blanks Supabase and cannot initialize auth');
  }
  if (!api) {
    errors.push('vite build --mode aws requires VITE_CHECKSOPS_API_URL');
  }
  const production = processEnv.CHECKSOPS_PRODUCTION_SPA === '1'
    || mode === 'production-aws'
    || isProductionPrepApi(api);
  if (production) {
    if (!isProductionPrepApi(api)) {
      errors.push('production SPA requires VITE_CHECKSOPS_API_URL=/prep');
    }
    if (pool !== PRODUCTION_COGNITO_POOL_ID) {
      errors.push('production SPA requires VITE_COGNITO_USER_POOL_ID=us-east-1_h00WorYMT');
    }
    if (client !== PRODUCTION_COGNITO_CLIENT_ID) {
      errors.push('production SPA requires VITE_COGNITO_USER_POOL_CLIENT_ID=3ja9fqaq2fjkv3i6up2varcqpe');
    }
    if (pool === STAGING_COGNITO_POOL_ID || client === STAGING_COGNITO_CLIENT_ID) {
      errors.push('staging Cognito configuration is forbidden in a production SPA build');
    }
    if (api.includes(STAGING_API_ID) || api.includes(`${PRODUCTION_EXECUTE_API_ID}.execute-api`)) {
      errors.push('production SPA must use same-origin /prep, not a raw execute-api URL');
    }
  }
  if (errors.length) {
    const error = new Error(errors.join('\n'));
    error.code = 'aws_spa_build_env_rejected';
    error.errors = errors;
    throw error;
  }
  return { ok: true, errors, production };
}
