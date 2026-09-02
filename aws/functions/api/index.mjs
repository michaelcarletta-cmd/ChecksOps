import { databaseSecretConfigured } from './secrets.mjs';
import { probeDatabase, probeIsHealthy } from './db-health.mjs';
import { validateReadonlyCoreTables } from './db-readonly-validate.mjs';
import { handleIdentityMe } from './identity.mjs';
import { handleAuthorizationProbe, handleJwksCheck } from './authorization.mjs';
import { handleTenantSecurityCompliance } from './tenant-security-compliance.mjs';

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

const READ_ONLY_PATHS = new Set([
  '/db-health',
  '/db-readonly-validate',
  '/identity/me',
  '/identity/session',
]);

const tenantComplianceMatch = (path) => path.match(/^\/tenants\/([^/]+)\/security-compliance$/);

export const handler = async (event) => {
  const method = (event?.requestContext?.http?.method || event?.httpMethod || 'GET').toUpperCase();
  const path = requestPath(event);
  const complianceRoute = tenantComplianceMatch(path);

  if ((READ_ONLY_PATHS.has(path) || complianceRoute) && method !== 'GET') {
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

  if (method === 'GET' && (path === '/identity/me' || path === '/identity/session')) {
    const identity = await handleIdentityMe(event);
    return json(identity.statusCode || (identity.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...identity,
    });
  }

  if (method === 'GET' && complianceRoute) {
    const result = await handleTenantSecurityCompliance(event, decodeURIComponent(complianceRoute[1]));
    if (!result.ok) {
      return json(result.statusCode || 500, {
        error: result.error || 'tenant_compliance_read_failed',
        message: result.message || null,
      });
    }
    return json(200, result.snapshot);
  }

  if ((method === 'GET' || method === 'POST') && path === '/authorization/probe') {
    const probe = await handleAuthorizationProbe(event);
    return json(probe.statusCode || (probe.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...probe,
    });
  }

  if ((method === 'GET' || method === 'POST') && path === '/authorization/isolation') {
    const probe = await handleAuthorizationProbe(event);
    return json(probe.statusCode || (probe.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...probe,
    });
  }

  if (method === 'GET' && path === '/authorization/jwks-check') {
    const jwks = await handleJwksCheck(event);
    return json(jwks.statusCode || (jwks.ok ? 200 : 503), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...jwks,
    });
  }

  return json(404, {
    error: 'not_found',
    message: 'AWS migration API route is not implemented yet.',
  });
};
