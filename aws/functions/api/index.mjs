import { databaseSecretConfigured } from './secrets.mjs';
import { probeDatabase, probeIsHealthy } from './db-health.mjs';
import { validateReadonlyCoreTables } from './db-readonly-validate.mjs';

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(body),
});

export const requestPath = (event) => {
  const rawPath = event?.rawPath || event?.requestContext?.http?.path || '/';
  const stage = event?.requestContext?.stage;
  let path = String(rawPath).split('?')[0] || '/';

  if (stage && stage !== '$default') {
    const prefix = `/${stage}`;
    if (path === prefix) {
      path = '/';
    } else if (path.startsWith(`${prefix}/`)) {
      path = path.slice(prefix.length);
    }
  }

  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }

  return path;
};

const READ_ONLY_PATHS = new Set(['/db-health', '/db-readonly-validate']);

export const handler = async (event) => {
  const method = (event?.requestContext?.http?.method || event?.httpMethod || 'GET').toUpperCase();
  const path = requestPath(event);

  if (READ_ONLY_PATHS.has(path) && method !== 'GET') {
    return json(405, {
      error: 'method_not_allowed',
      message: 'This staging validation route is GET-only. No writes.',
    });
  }

  if (method === 'GET' && (path === '/' || path === '/health')) {
    return json(200, {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      status: 'ok',
      database: 'not-connected',
      databaseSecretConfigured: databaseSecretConfigured(),
      databaseName: process.env.DATABASE_NAME || null,
      productionSupabaseChanged: false,
    });
  }

  if (method === 'GET' && path === '/db-health') {
    const probe = await probeDatabase();
    return json(probeIsHealthy(probe) ? 200 : 503, {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...probe,
    });
  }

  if (method === 'GET' && path === '/db-readonly-validate') {
    const validation = await validateReadonlyCoreTables();
    return json(validation.ok ? 200 : 503, {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...validation,
    });
  }

  return json(404, {
    error: 'not_found',
    message: 'AWS migration API route is not implemented yet.',
  });
};
