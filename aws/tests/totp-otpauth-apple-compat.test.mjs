import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { otpauthUri as newOtpauthUri, generateTotpSecret } from '../functions/api/financial-totp.mjs';
import { totpQrDataUrl } from '../../src/lib/totpQr.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EMAIL = 'synthetic-user@example.com';
/** Public RFC 6238 sample key. Not a production secret. */
const COGNITO_LIKE_SECRET = 'GEZDGNBVGY3TQOJQ';
const PROPOSED_ISSUER = 'ChecksOps-Financial';

/** Replica of the working Cognito-era builder (auth-mfa.mjs at e63c4fb1). */
const oldOtpauthUri = (secret, email) => {
  const label = encodeURIComponent(email || 'ChecksOps');
  const issuer = encodeURIComponent('ChecksOps');
  return `otpauth://totp/${issuer}:${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}&digits=6&period=30`;
};

const proposedOtpauthUri = (secret, email) => {
  const label = encodeURIComponent(email || PROPOSED_ISSUER);
  const issuer = encodeURIComponent(PROPOSED_ISSUER);
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
  return {
    scheme: 'otpauth://totp/',
    pathIssuerEncoded: pathIssuer,
    pathIssuerDecoded: decodeURIComponent(pathIssuer),
    pathIssuerHasPercent20: pathIssuer.includes('%20'),
    pathIssuerHasSpace: pathIssuer.includes(' ') || decodeURIComponent(pathIssuer).includes(' '),
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

test('old working Cognito QR vs new financial QR: issuer space is the structural regression', async () => {
  const secret32 = generateTotpSecret();
  assert.match(secret32, /^[A-Z2-7]{32}$/);

  const old16 = structureOf(oldOtpauthUri(COGNITO_LIKE_SECRET, EMAIL));
  const old32 = structureOf(oldOtpauthUri(secret32, EMAIL));
  const neu = structureOf(newOtpauthUri(secret32, EMAIL));
  const proposed = structureOf(proposedOtpauthUri(secret32, EMAIL));

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

  assert.equal(neu.pathIssuerDecoded, 'ChecksOps Financial');
  assert.equal(neu.pathIssuerHasPercent20, true);
  assert.equal(neu.pathIssuerHasSpace, true);
  assert.equal(neu.queryIssuerEncoded, 'ChecksOps%20Financial');

  assert.equal(old16.secretCharCount, 16);
  assert.equal(neu.secretCharCount, 32);
  assert.equal(old32.secretCharCount, 32);
  assert.equal(old32.pathIssuerDecoded, 'ChecksOps');
  assert.equal(old32.pathIssuerHasPercent20, false);

  assert.equal(proposed.pathIssuerDecoded, PROPOSED_ISSUER);
  assert.equal(proposed.pathIssuerHasPercent20, false);
  assert.equal(proposed.pathIssuerHasSpace, false);
  assert.notEqual(proposed.pathIssuerDecoded, 'ChecksOps');
  assert.deepEqual(proposed.queryKeys, old16.queryKeys);

  const qr = fs.readFileSync(path.join(ROOT, 'src/lib/totpQr.ts'), 'utf8');
  assert.match(qr, /errorCorrectionLevel: "M"/);
  assert.match(qr, /width: 176/);
  assert.match(qr, /import\("qrcode"\)/);

  const oldQr = await totpQrDataUrl(oldOtpauthUri(secret32, EMAIL));
  const newQr = await totpQrDataUrl(newOtpauthUri(secret32, EMAIL));
  const proposedQr = await totpQrDataUrl(proposedOtpauthUri(secret32, EMAIL));
  assert.match(oldQr, /^data:image\/png;base64,/);
  assert.match(newQr, /^data:image\/png;base64,/);
  assert.match(proposedQr, /^data:image\/png;base64,/);
  assert.notEqual(oldQr, newQr);
  assert.notEqual(newQr, proposedQr);

  const financial = fs.readFileSync(path.join(ROOT, 'aws/functions/api/financial-totp.mjs'), 'utf8');
  assert.match(financial, /FINANCIAL_TOTP_ISSUER = 'ChecksOps Financial'/);
  assert.match(financial, /toBase32\(randomBytes\(20\)\)/);
});

test('frontend uses server otpauth_uri unchanged so issuer comes from Lambda', () => {
  const totpQr = fs.readFileSync(path.join(ROOT, 'src/lib/totpQr.ts'), 'utf8');
  const card = fs.readFileSync(path.join(ROOT, 'src/components/auth/TotpManagerCard.tsx'), 'utf8');
  assert.match(totpQr, /if \(provided\.startsWith\("otpauth:\/\/"\)\) return provided;/);
  assert.match(card, /resolveTotpOtpauthUri/);
  assert.match(card, /associated\.otpauthUri/);
});
