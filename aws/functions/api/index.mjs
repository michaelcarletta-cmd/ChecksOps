const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  const method = event?.requestContext?.http?.method || 'GET';
  const path = event?.rawPath || '/';

  if (method === 'GET' && (path === '/' || path === '/health')) {
    return json(200, {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      status: 'ok',
      database: 'not-connected',
      productionSupabaseChanged: false,
    });
  }

  return json(404, {
    error: 'not_found',
    message: 'AWS migration API route is not implemented yet.',
  });
};
