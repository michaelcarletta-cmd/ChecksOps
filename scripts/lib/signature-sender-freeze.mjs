/**
 * Accepted signature-request sender contract.
 *
 * Signature-request From is:
 *   {Request-Owning Tenant Company/Display Name} <support@checksops.com>
 *
 * This is signature-specific. resolveEmailBranding() remains shared and may
 * still append " via ChecksOps" for other email types.
 *
 * Historical pre-fix esign.mjs (SHA256 37c5c742…) is provenance only and
 * must never be restored automatically.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIGNATURE_SENDER_SOURCE_PIN = {
  path: 'aws/functions/api/esign.mjs',
  sha256: 'b8f707dfc724a54fb5d973a11cb26380f3381baea26324c08aa30dc93cb5656e',
};

export const SIGNATURE_SENDER_LIVE_LAMBDA_PIN = {
  name: 'esign.mjs',
  sha256: 'b8f707dfc724a54fb5d973a11cb26380f3381baea26324c08aa30dc93cb5656e',
};

export const HISTORICAL_PRE_FIX_ESIGN_SHA256 = '37c5c742f516ce750a402c53214307eee429742e8eed8d4ef9399772516209c5';

export const HISTORICAL_PRE_FIX_FIXTURE = 'aws/tests/fixtures/historical-pre-fix-esign-37c5c742.mjs';

export const PLATFORM_SUPPORT_FROM_ADDRESS = 'support@checksops.com';

export const ACCEPTED_FREEDOM_FROM = 'Freedom Adjustment <support@checksops.com>';

export const FORBIDDEN_SIGNATURE_FROM = Object.freeze([
  'Freedom Adjustment via ChecksOps <support@checksops.com>',
  'ChecksOps <support@checksops.com>',
  'Freedom Adjustment <noreply@checksops.com>',
]);

export const SIGNATURE_SENDER_MARKERS = Object.freeze([
  'export const signatureRequestFromHeader',
  'stripViaChecksOps',
  'PLATFORM_SUPPORT_EMAIL',
  'formatFromHeader(name, PLATFORM_SUPPORT_EMAIL)',
  'const mailFrom = signatureRequestFromHeader(resolved)',
  'const mailReplyTo = resolved.replyTo',
  'from: mailFrom',
  'replyTo: mailReplyTo',
]);

export const SIGNATURE_SENDER_FORBIDDEN_MARKERS = Object.freeze([
  'const mailFrom = resolved.from',
]);

const fail = (errors) => ({ ok: false, errors });
const ok = (extra = {}) => ({ ok: true, errors: [], ...extra });

export const sha256Bytes = (buf) => createHash('sha256').update(buf).digest('hex');

export const assertMarkers = (source, markers, label) => {
  const text = String(source || '');
  const missing = (markers || []).filter((marker) => !text.includes(marker));
  return missing.length
    ? fail(missing.map((marker) => `${label} missing signature-sender marker: ${marker}`))
    : ok();
};

export const assertNotHistoricalEsignHash = (hash, label = 'esign.mjs') => {
  if (hash && hash === HISTORICAL_PRE_FIX_ESIGN_SHA256) {
    return fail([
      `${label} is the historical pre-fix hash ${hash}; never restore that file. Start from the then-current live production package.`,
    ]);
  }
  return ok();
};

export const assertSignatureSenderSource = (source, extra = {}) => {
  const errors = [];
  const text = String(source || '');
  errors.push(...assertMarkers(text, SIGNATURE_SENDER_MARKERS, 'esign.mjs').errors);
  errors.push(...assertNotHistoricalEsignHash(extra.hash, 'esign.mjs').errors);
  for (const marker of SIGNATURE_SENDER_FORBIDDEN_MARKERS) {
    if (text.includes(marker)) {
      errors.push(`esign.mjs restored pre-fix sender assignment: ${marker}`);
    }
  }
  if (!text.includes('signatureRequestFromHeader')) {
    errors.push('esign.mjs lost signatureRequestFromHeader');
  }
  if (!/PLATFORM_SUPPORT_EMAIL/.test(text)) {
    errors.push('esign.mjs lost PLATFORM_SUPPORT_EMAIL binding');
  }
  if (/via ChecksOps/.test(text) && !/stripViaChecksOps/.test(text)) {
    errors.push('esign.mjs appends via ChecksOps without the signature-only strip');
  }
  return errors.length ? fail(errors) : ok();
};

export const SIGNATURE_SENDER_ENTRY_CONTRACTS = {
  'esign.mjs': assertSignatureSenderSource,
};

export const assertSignatureSenderSourcePin = (root) => {
  const rel = SIGNATURE_SENDER_SOURCE_PIN.path;
  const filePath = path.join(root, rel);
  if (!fs.existsSync(filePath)) return fail([`accepted signature-sender file missing: ${rel}`]);
  const body = fs.readFileSync(filePath);
  const hash = sha256Bytes(body);
  const errors = [];
  if (hash !== SIGNATURE_SENDER_SOURCE_PIN.sha256) {
    errors.push(`${rel} hash ${hash} != accepted ${SIGNATURE_SENDER_SOURCE_PIN.sha256}`);
  }
  errors.push(...assertSignatureSenderSource(body.toString('utf8'), { hash }).errors);
  return errors.length ? fail(errors) : ok({ hash });
};

export const assertSignatureSenderLambdaPin = (hashes) => {
  const expected = SIGNATURE_SENDER_LIVE_LAMBDA_PIN.sha256;
  const name = SIGNATURE_SENDER_LIVE_LAMBDA_PIN.name;
  if (!hashes?.[name]) return fail([`live package missing ${name}`]);
  if (hashes[name] !== expected) return fail([`${name} live hash ${hashes[name]} != accepted ${expected}`]);
  if (hashes[name] === HISTORICAL_PRE_FIX_ESIGN_SHA256) {
    return fail([`${name} silently rolled back to the pre-fix sender`]);
  }
  return ok();
};

export const assertForbiddenFromHeaders = (fromHeader) => {
  const value = String(fromHeader || '');
  const errors = [];
  for (const forbidden of FORBIDDEN_SIGNATURE_FROM) {
    if (value === forbidden) errors.push(`forbidden signature From: ${forbidden}`);
  }
  if (/\bvia ChecksOps\b/i.test(value)) {
    errors.push(`signature From must not append via ChecksOps: ${value}`);
  }
  if (!/<support@checksops\.com>$/.test(value)) {
    errors.push(`signature From must use support@checksops.com: ${value}`);
  }
  if (/noreply@checksops\.com/i.test(value)) {
    errors.push(`signature From must not use noreply@checksops.com: ${value}`);
  }
  if (/^ChecksOps\s*</.test(value)) {
    errors.push(`signature From must use the request-owning tenant name: ${value}`);
  }
  return errors.length ? fail(errors) : ok();
};

export const expectedSignatureFrom = (tenantName) => (
  `${String(tenantName || '').trim()} <${PLATFORM_SUPPORT_FROM_ADDRESS}>`
);

export const repoRootFrom = (metaUrl) => path.join(path.dirname(fileURLToPath(metaUrl)), '../..');
