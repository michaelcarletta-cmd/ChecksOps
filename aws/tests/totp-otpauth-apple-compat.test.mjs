import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  FINANCIAL_TOTP_ISSUER,
  otpauthUri as financialOtpauthUri,
  generateTotpSecret,
} from '../functions/api/financial-totp.mjs';
import { buildTotpOtpauthUri, totpQrDataUrl } from '../../src/lib/totpQr.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EMAIL = 'synthetic-user@example.com';
/** Public RFC 6238 sample key. Not a production secret. */
const COGNITO_LIKE_SECRET = 'GEZDGNBVGY3TQOJQ';
const PATCHED_ISSUER = 'ChecksOps-Financial';

/** Replica of the working Cognito-era builder (auth-mfa.mjs at e63c4fb1). */
const oldOtpauthUri = (secret, email) => {
  const label = encodeURIComponent(email || 'ChecksOps');
  const issuer = encodeURIComponent('ChecksOps');
  return `otpauth://totp/${issuer}:${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}&digits=6&period=30`;
};

const structureOf = (uri) => {
  assert.match(uri, /^otpauth:\/\/totp\//);
  const q = uri.indexOf('?');
  const pathPart = uri.slice('otpauth://totp/'.length, q);
  const rawQuery = uri.slice(q + 1);
  const pairs = rawQuery.split('&').map((p) => p.split('='));
  const keys = pairs.map(([k]) => k);
  const raw = Object.fromEntries(pairs);
  const colon = pathPart.indexOf(':');
  const pathIssuer = pathPart.slice(0, colon);
  const pathLabel = pathPart.slice(colon + 1);
  const issuerPathAndQuery = `${pathIssuer}&issuer=${raw.issuer || ''}`;
  return {
    scheme: 'otpauth://totp/',
    pathIssuerEncoded: pathIssuer,
    pathIssuerDecoded: decodeURIComponent(pathIssuer),
    pathIssuerHasPercent20: pathIssuer.includes('%20'),
    pathIssuerHasSpace: pathIssuer.includes(' ') || decodeURIComponent(pathIssuer).includes(' '),
    issuerPathOrQueryHasPercent20: issuerPathAndQuery.includes('%20'),
    labelEncoded: pathLabel,
    labelDecoded: decodeURIComponent(pathLabel),
    queryKeys: keys,
    queryIssuerEncoded: raw.issuer,
    digitsPresent: keys.includes('digits'),
    periodPresent: keys.includes('period'),
    algorithmPresent: keys.includes('algorithm'),
    secretCharCount: decodeURIComponent(raw.secret || '').length,
    secretBase32: /^[A-Z2-7]+$/.test(decodeURIComponent(raw.secret || '')),
    uriHasUnencodedSpace: uri.includes(' '),
  };
};

test('financial otpauth issuer has no whitespace or %20; QR structure otherwise matches old ChecksOps', async () => {
  const secret32 = generateTotpSecret();
  assert.match(secret32, /^[A-Z2-7]{32}$/);

  assert.equal(FINANCIAL_TOTP_ISSUER, PATCHED_ISSUER);
  assert.equal(/\s/.test(FINANCIAL_TOTP_ISSUER), false);
  assert.doesNotMatch(FINANCIAL_TOTP_ISSUER, /%20/);
  assert.doesNotMatch(encodeURIComponent(FINANCIAL_TOTP_ISSUER), /%20/);

  const old16 = structureOf(oldOtpauthUri(COGNITO_LIKE_SECRET, EMAIL));
  const old32 = structureOf(oldOtpauthUri(secret32, EMAIL));
  const neu = structureOf(financialOtpauthUri(secret32, EMAIL));
  const fallback = structureOf(buildTotpOtpauthUri(secret32, EMAIL));

  assert.equal(old16.scheme, neu.scheme);
  assert.deepEqual(old16.queryKeys, ['secret', 'issuer', 'digits', 'period']);
  assert.deepEqual(neu.queryKeys, old16.queryKeys);
  assert.equal(old16.algorithmPresent, false);
  assert.equal(neu.algorithmPresent, false);
  assert.equal(old16.digitsPresent, true);
  assert.equal(neu.digitsPresent, true);
  assert.equal(old16.periodPresent, true);
  assert.equal(neu.periodPresent, true);
  assert.equal(old16.labelDecoded, EMAIL);
  assert.equal(neu.labelDecoded, EMAIL);
  assert.equal(old16.uriHasUnencodedSpace, false);
  assert.equal(neu.uriHasUnencodedSpace, false);

  assert.equal(old16.pathIssuerDecoded, 'ChecksOps');
  assert.equal(old16.pathIssuerHasPercent20, false);
  assert.equal(old16.pathIssuerHasSpace, false);

  assert.equal(neu.pathIssuerDecoded, PATCHED_ISSUER);
  assert.equal(neu.pathIssuerHasPercent20, false);
  assert.equal(neu.pathIssuerHasSpace, false);
  assert.equal(neu.issuerPathOrQueryHasPercent20, false);
  assert.equal(neu.queryIssuerEncoded, PATCHED_ISSUER);
  assert.notEqual(neu.pathIssuerDecoded, 'ChecksOps');
  assert.notEqual(neu.pathIssuerDecoded, 'ChecksOps Financial');

  assert.equal(old16.secretCharCount, 16);
  assert.equal(neu.secretCharCount, 32);
  assert.equal(old32.secretCharCount, 32);
  assert.equal(old32.pathIssuerDecoded, 'ChecksOps');
  assert.equal(old32.pathIssuerHasPercent20, false);

  assert.deepEqual(fallback.queryKeys, old16.queryKeys);
  assert.equal(fallback.pathIssuerDecoded, PATCHED_ISSUER);
  assert.equal(fallback.pathIssuerHasPercent20, false);
  assert.equal(fallback.issuerPathOrQueryHasPercent20, false);
  assert.equal(fallback.algorithmPresent, false);

  const qr = fs.readFileSync(path.join(ROOT, 'src/lib/totpQr.ts'), 'utf8');
  assert.match(qr, /errorCorrectionLevel: "M"/);
  assert.match(qr, /width: 176/);
  assert.match(qr, /import\("qrcode"\)/);
  assert.match(qr, /const ISSUER = "ChecksOps-Financial"/);

  const oldQr = await totpQrDataUrl(oldOtpauthUri(secret32, EMAIL));
  const newQr = await totpQrDataUrl(financialOtpauthUri(secret32, EMAIL));
  assert.match(oldQr, /^data:image\/png;base64,/);
  assert.match(newQr, /^data:image\/png;base64,/);
  assert.notEqual(oldQr, newQr);

  const financial = fs.readFileSync(path.join(ROOT, 'aws/functions/api/financial-totp.mjs'), 'utf8');
  assert.match(financial, /FINANCIAL_TOTP_ISSUER = 'ChecksOps-Financial'/);
  assert.doesNotMatch(financial, /FINANCIAL_TOTP_ISSUER = 'ChecksOps Financial'/);
  assert.match(financial, /toBase32\(randomBytes\(20\)\)/);
  assert.match(financial, /FINANCIAL_TOTP_DIGITS = 6/);
  assert.match(financial, /FINANCIAL_TOTP_PERIOD_SECONDS = 30/);
  assert.match(financial, /FINANCIAL_TOTP_ALGORITHM = 'SHA1'/);
});

test('frontend uses server otpauth_uri unchanged so issuer comes from Lambda', () => {
  const totpQr = fs.readFileSync(path.join(ROOT, 'src/lib/totpQr.ts'), 'utf8');
  const card = fs.readFileSync(path.join(ROOT, 'src/components/auth/TotpManagerCard.tsx'), 'utf8');
  assert.match(totpQr, /if \(provided\.startsWith\("otpauth:\/\/"\)\) return provided;/);
  assert.match(card, /resolveTotpOtpauthUri/);
  assert.match(card, /associated\.otpauthUri/);
});

test('English UI copy stays ChecksOps Financial authenticator', () => {
  const card = fs.readFileSync(path.join(ROOT, 'src/components/auth/TotpManagerCard.tsx'), 'utf8');
  const dialog = fs.readFileSync(path.join(ROOT, 'src/components/auth/StepUpDialog.tsx'), 'utf8');
  const display = fs.readFileSync(path.join(ROOT, 'src/components/auth/TotpQrDisplay.tsx'), 'utf8');
  assert.match(card, /ChecksOps Financial authenticator/);
  assert.match(card, /Set up ChecksOps Financial authenticator/);
  assert.match(dialog, /ChecksOps Financial authenticator/);
  assert.match(display, /ChecksOps Financial authenticator setup QR code/);
  assert.doesNotMatch(card, /Authenticator \(TOTP\)/);
  assert.doesNotMatch(card, /Optional at login/);
});
