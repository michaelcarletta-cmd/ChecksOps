const PRODUCTION_ENVS = new Set(['production-prep', 'production']);
export const PRODUCTION_CORS_ORIGINS = [
  'https://checksops.com',
  'https://www.checksops.com',
];

const ALLOW_HEADERS = 'authorization,content-type,x-request-id,x-user-id,x-tenant-id,x-role,x-cognito-sub,x-bridge-secret,x-signature,x-timestamp,x-nonce,x-webhook-id,webhook-id,webhook-timestamp,webhook-signature,x-moov-signature,x-moov-timestamp,x-moov-webhook-id';
const ALLOW_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';

const headerOf = (event, name) => {
  const headers = event?.headers || {};
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1] || '').trim() : '';
};

export const isProductionCorsEnv = (env = process.env.CHECKSOPS_ENV) => PRODUCTION_ENVS.has(String(env || ''));

export const corsAllowOrigin = (event, env = process.env.CHECKSOPS_ENV) => {
  if (!isProductionCorsEnv(env)) return '*';
  const origin = headerOf(event, 'origin');
  if (PRODUCTION_CORS_ORIGINS.includes(origin)) return origin;
  return PRODUCTION_CORS_ORIGINS[0];
};

export const corsHeaders = (event, env = process.env.CHECKSOPS_ENV) => ({
  'access-control-allow-origin': corsAllowOrigin(event, env),
  'access-control-allow-headers': ALLOW_HEADERS,
  'access-control-allow-methods': ALLOW_METHODS,
  vary: 'Origin',
});
