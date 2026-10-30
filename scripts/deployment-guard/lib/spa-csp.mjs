/**
 * Content-Security-Policy for the ChecksOps SPA. Pure: builds the header value from the
 * directives below and hashes index.html's inline scripts; no AWS calls.
 *
 * Rollout (ops/security/SPA_CSP_ROLLOUT.md): staging report-only first, then staging enforce,
 * then production report-only, then production enforce, each on the owner's words.
 * Staging calls the API on its execute-api host; production calls the same-origin /prep.
 */
import crypto from 'node:crypto';

export const STAGING_API_ORIGIN = 'https://psr19uhop4.execute-api.us-east-1.amazonaws.com';
// Presigned file URLs (storage.mjs / storage-write.mjs sign with the regional S3 client).
export const S3_PRESIGNED_ORIGINS = Object.freeze(['https://*.s3.amazonaws.com', 'https://*.s3.us-east-1.amazonaws.com']);
// Contractor service area ZIP lookups (ContractorServiceAreaCard.tsx).
export const ZIP_LOOKUP_ORIGIN = 'https://api.zippopotam.us';

// sha256 of each inline <script> body in index.html, as CSP source expressions.
export const inlineScriptHashes = (indexHtml) => [...String(indexHtml).matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);

export const cspDirectives = ({ environment, indexHtml }) => {
  if (!['staging', 'production'].includes(environment)) throw new Error('environment must be staging or production');
  const api = environment === 'staging' ? [STAGING_API_ORIGIN] : [];
  return [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", ...inlineScriptHashes(indexHtml)]],
    // index.html's loader uses a style attribute and UI libraries inject <style>; see the runbook.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    // Tenant logos load as <img> from the API's /storage/public (src/integrations/aws/storage.ts
    // getPublicUrl, src/lib/brandingPublicUrl.ts): the execute-api host on staging, same-origin
    // /prep on production.
    ['img-src', ["'self'", 'data:', 'blob:', ...api, ...S3_PRESIGNED_ORIGINS]],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', ["'self'", ...api, ...S3_PRESIGNED_ORIGINS, ZIP_LOOKUP_ORIGIN, 'data:', 'blob:']],
    ['frame-src', ["'self'", 'blob:', 'data:', ...S3_PRESIGNED_ORIGINS]],
    // The pdf.js worker is a bundled asset of the SPA (FieldPlacementEditor.tsx).
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'self'"]],
  ];
};

export const buildCsp = (options) => cspDirectives(options).map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
