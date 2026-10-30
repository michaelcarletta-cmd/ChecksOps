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
// pdf.js worker (FieldPlacementEditor.tsx sets workerSrc to unpkg); self-hosting it would drop this.
export const PDFJS_WORKER_ORIGIN = 'https://unpkg.com';
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
    ['script-src', ["'self'", ...inlineScriptHashes(indexHtml), PDFJS_WORKER_ORIGIN]],
    // index.html's loader uses a style attribute and UI libraries inject <style>; see the runbook.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', ...S3_PRESIGNED_ORIGINS]],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', ["'self'", ...api, ...S3_PRESIGNED_ORIGINS, ZIP_LOOKUP_ORIGIN, PDFJS_WORKER_ORIGIN, 'data:', 'blob:']],
    ['frame-src', ["'self'", 'blob:', 'data:', ...S3_PRESIGNED_ORIGINS]],
    ['worker-src', ["'self'", 'blob:', PDFJS_WORKER_ORIGIN]],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'self'"]],
  ];
};

export const buildCsp = (options) => cspDirectives(options).map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
