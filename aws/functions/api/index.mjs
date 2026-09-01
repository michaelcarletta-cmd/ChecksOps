import { databaseSecretConfigured } from './secrets.mjs';

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

export const handler = async (event) => {
  const method = (event?.requestContext?.http?.method || event?.httpMethod || 'GET').toUpperCase();
  const path = requestPath(event);

  if (method === 'GET' && (path === '/' || path === '/health')) {
    return json(200, {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      status: 'ok',
      database: 'not-connected',
      databaseSecretConfigured: databaseSecretConfigured(),
      productionSupabaseChanged: false,
    });
  }

  return json(404, {
    error: 'not_found',
    message: 'AWS migration API route is not implemented yet.',
  });
};
