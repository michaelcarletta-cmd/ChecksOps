import { databaseSecretConfigured } from './secrets.mjs';
import { probeDatabase, probeIsHealthy } from './db-health.mjs';
import { validateReadonlyCoreTables } from './db-readonly-validate.mjs';
import { handleIdentityMe } from './identity.mjs';
import { handleAuthorizationProbe, handleJwksCheck } from './authorization.mjs';
import { AUTH_ROUTES } from './auth-cognito.mjs';
import { readinessSnapshot, stagingSafetyHolds } from './ops-readiness.mjs';
import { handleDataQuery, handleDataRpc, handleWritesDisabled, handleFunctionsDisabled } from './data.mjs';
import { handleWrite } from './write.mjs';
import { handleProviderRequest } from './providers.mjs';
import { handleTenantSecurityCompliance } from './tenant-security-compliance.mjs';
import {
  handleStorageSign,
  handleStorageSignMany,
  handleStorageList,
  handleStorageDownload,
  handleStoragePublic,
  handleStorageWritesDisabled,
  handlePublicSignatureDocument,
  handleBrandingLogo,
} from './storage.mjs';
import { handlePublicEndorsement } from './check-endorsement.mjs';
import { handlePublicSignatureSubmit } from './signature-submit.mjs';
import {
  handleStorageUploadUrl,
  handleStorageDelete,
  handleStorageMove,
} from './storage-write.mjs';
import { handleWorkflowRequest } from './workflow.mjs';
import { handleFinancialRequest } from './financial.mjs';
import { handleSandboxRequest } from './sandbox.mjs';

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization,content-type,x-request-id,x-user-id,x-tenant-id,x-role,x-cognito-sub,x-bridge-secret,x-signature,x-timestamp,x-nonce,x-webhook-id,webhook-id,webhook-timestamp,webhook-signature,x-moov-signature,x-moov-timestamp,x-moov-webhook-id',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
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
  '/ops/readiness',
  '/cutover/readiness',
]);

const tenantComplianceMatch = (path) => path.match(/^\/tenants\/([^/]+)\/security-compliance$/);

export const handler = async (event) => {
  const method = (event?.requestContext?.http?.method || event?.httpMethod || 'GET').toUpperCase();
  const path = requestPath(event);

  if (method === 'OPTIONS') {
    return json(204, {});
  }
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

  if (method === 'GET' && (path === '/ops/readiness' || path === '/cutover/readiness')) {
    const snapshot = readinessSnapshot();
    const holds = stagingSafetyHolds(snapshot);
    return json(200, {
      ...snapshot,
      holds,
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

  if (method === 'POST' && AUTH_ROUTES[path]) {
    const result = await AUTH_ROUTES[path](event);
    return json(result.statusCode || (result.ok ? 200 : 400), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/data/query') {
    const result = await handleDataQuery(event);
    return json(result.statusCode || (result.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/data/rpc') {
    const result = await handleDataRpc(event);
    return json(result.statusCode || (result.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/data/write') {
    const result = await handleWrite(event);
    return json(result.statusCode || (result.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && path.startsWith('/data/')) {
    const result = await handleWritesDisabled(event);
    return json(403, {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  const brandingLogoPath = path.replace(/^\/prep(?=\/|$)/, '') || '/';
  if (method === 'GET' && (brandingLogoPath === '/branding/logo' || /^\/branding\/logo\/[0-9a-fA-F-]{36}$/.test(brandingLogoPath))) {
    const result = await handleBrandingLogo({ ...event, rawPath: brandingLogoPath });
    if (result.binary && result.body) {
      return {
        statusCode: 200,
        headers: {
          'content-type': result.contentType || 'image/png',
          'cache-control': 'public, max-age=3600',
          'access-control-allow-origin': '*',
        },
        isBase64Encoded: true,
        body: Buffer.from(result.body).toString('base64'),
      };
    }
    return json(result.statusCode || 404, {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'GET' && path === '/storage/public') {
    const result = await handleStoragePublic(event);
    if (result.redirect && result.location) {
      return {
        statusCode: 302,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          location: result.location,
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization,content-type,x-request-id,x-user-id,x-tenant-id,x-role,x-cognito-sub,x-bridge-secret,x-signature,x-timestamp,x-nonce,x-webhook-id,webhook-id,webhook-timestamp,webhook-signature,x-moov-signature,x-moov-timestamp,x-moov-webhook-id',
          'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        },
        body: JSON.stringify({
          service: 'checksops-api',
          environment: process.env.CHECKSOPS_ENV || 'unknown',
          productionSupabaseChanged: false,
          signedUrl: result.signedUrl,
          bucket: result.bucket,
          path: result.path,
        }),
      };
    }
    return json(result.statusCode || 403, {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/storage/sign') {
    const result = await handleStorageSign(event);
    return json(result.statusCode || (result.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/storage/sign-many') {
    const result = await handleStorageSignMany(event);
    return json(result.statusCode || (result.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/storage/list') {
    const result = await handleStorageList(event);
    return json(result.statusCode || (result.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/storage/download') {
    const result = await handleStorageDownload(event);
    return json(result.statusCode || (result.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && (path === '/storage/upload-url' || path === '/storage/upload')) {
    const result = await handleStorageUploadUrl(event);
    return json(result.statusCode || (result.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/storage/delete') {
    const result = await handleStorageDelete(event);
    return json(result.statusCode || (result.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/storage/move') {
    const result = await handleStorageMove(event);
    return json(result.statusCode || (result.ok ? 200 : 401), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (path.startsWith('/storage')) {
    const result = await handleStorageWritesDisabled(event);
    return json(result.statusCode || 403, {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/public/signature-document') {
    const result = await handlePublicSignatureDocument(event);
    return json(result.statusCode || (result.ok ? 200 : 400), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/public/endorsement') {
    const result = await handlePublicEndorsement(event);
    return json(result.statusCode || (result.ok ? 200 : 400), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  if (method === 'POST' && path === '/public/signature-submit') {
    const result = await handlePublicSignatureSubmit(event);
    return json(result.statusCode || (result.ok ? 200 : 400), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  const sandbox = await handleSandboxRequest(event, path, method);
  if (sandbox) {
    return json(sandbox.statusCode || (sandbox.ok ? 200 : 403), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      productionWebhooksRedirected: false,
      productionDnsChanged: false,
      liveProviderTransactions: false,
      ...sandbox,
    });
  }

  const financial = await handleFinancialRequest(event, path, method);
  if (financial) {
    return json(financial.statusCode || (financial.ok ? 200 : 403), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      productionWebhooksRedirected: false,
      productionDnsChanged: false,
      liveProviderTransactions: false,
      ...financial,
    });
  }

  const workflow = await handleWorkflowRequest(event, path, method);
  if (workflow) {
    return json(workflow.statusCode || (workflow.ok ? 200 : 403), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      productionWebhooksRedirected: false,
      ...workflow,
    });
  }

  // Non-financial Class A scheduled jobs (EventBridge → shared secret).
  if (path.startsWith('/scheduled')) {
    const { handleScheduledRequest } = await import('./scheduled.mjs');
    const scheduled = await handleScheduledRequest(event, path);
    if (scheduled) {
      return json(scheduled.statusCode || (scheduled.ok ? 200 : 403), {
        service: 'checksops-api',
        environment: process.env.CHECKSOPS_ENV || 'unknown',
        productionSupabaseChanged: false,
        productionWebhooksRedirected: false,
        ...scheduled,
      });
    }
  }

  // Class A ordinary application services (email / OCR / HomeownerOps / public directory).
  // MUST run before handleProviderRequest — providers.mjs matches every
  // /functions/v1/* path and returns provider_disabled for unknown names,
  // which would otherwise shadow Class A routes.
  const { handleAppServiceRequest } = await import('./app-services.mjs');
  const appService = await handleAppServiceRequest(event, path, method);
  if (appService) {
    return json(appService.statusCode || (appService.ok ? 200 : 403), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      productionWebhooksRedirected: false,
      ...appService,
    });
  }

  // Provider / financial Edge Function stubs (staging: execution disabled).
  // Real Moov/CheckAlt/Plaid money movement stays off until a later controlled phase.
  const provider = await handleProviderRequest(event, path, method);
  if (provider) {
    return json(provider.statusCode || (provider.ok ? 200 : 403), {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      productionWebhooksRedirected: false,
      ...provider,
    });
  }

  if (path.startsWith('/functions')) {
    const result = await handleFunctionsDisabled(event);
    return json(403, {
      service: 'checksops-api',
      environment: process.env.CHECKSOPS_ENV || 'unknown',
      productionSupabaseChanged: false,
      ...result,
    });
  }

  return json(404, {
    error: 'not_found',
    message: 'AWS migration API route is not implemented yet.',
  });
};
