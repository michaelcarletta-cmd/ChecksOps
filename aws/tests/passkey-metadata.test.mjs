import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  mapWebAuthnCredential,
  normalizeWebAuthnCreatedAt,
} from '../functions/api/auth-webauthn.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('normalizeWebAuthnCreatedAt converts Cognito UNIX seconds to ISO (not Jan 1970)', () => {
  const iso = normalizeWebAuthnCreatedAt(1736293876.115);
  assert.equal(iso, '2025-01-07T23:51:16.115Z');
  assert.ok(!iso.includes('1970'));
});

test('normalizeWebAuthnCreatedAt rejects missing/invalid values instead of inventing epoch', () => {
  assert.equal(normalizeWebAuthnCreatedAt(null), null);
  assert.equal(normalizeWebAuthnCreatedAt(undefined), null);
  assert.equal(normalizeWebAuthnCreatedAt(''), null);
  assert.equal(normalizeWebAuthnCreatedAt('not-a-date'), null);
  assert.equal(normalizeWebAuthnCreatedAt(Number.NaN), null);
});

test('mapWebAuthnCredential uses FriendlyCredentialName and never last-used invention', () => {
  const mapped = mapWebAuthnCredential({
    CredentialId: 'cred-example',
    FriendlyCredentialName: 'Windows Hello',
    RelyingPartyId: 'staging.checksops.com',
    AuthenticatorAttachment: 'platform',
    AuthenticatorTransports: ['internal'],
    CreatedAt: 1736293876.115,
  });
  assert.equal(mapped.friendlyName, 'Windows Hello');
  assert.equal(mapped.authenticatorAttachment, 'platform');
  assert.deepEqual(mapped.authenticatorTransports, ['internal']);
  assert.equal(mapped.createdAt, '2025-01-07T23:51:16.115Z');
  assert.equal(mapped.lastUsedAt, null);
  assert.equal(mapped.relyingPartyId, 'staging.checksops.com');
});

test('mapWebAuthnCredential leaves friendlyName null when Cognito omits FriendlyCredentialName', () => {
  const mapped = mapWebAuthnCredential({
    CredentialId: 'cred-example',
    AuthenticatorAttachment: 'platform',
    CreatedAt: 1700000000,
  });
  assert.equal(mapped.friendlyName, null);
  assert.equal(mapped.authenticatorAttachment, 'platform');
  assert.equal(mapped.createdAt, '2023-11-14T22:13:20.000Z');
});

test('passkeyDisplay helpers never show platform as the name or invent Never used / epoch', async () => {
  const {
    formatPasskeyMetaLine,
    passkeyCreatedAtIso,
    passkeyDisplayName,
  } = await import(path.join(ROOT, 'src/lib/passkeyDisplay.ts'));

  assert.equal(passkeyDisplayName({
    friendlyName: null,
    authenticatorAttachment: 'platform',
  }), 'Passkey');
  assert.equal(passkeyDisplayName({
    friendlyName: 'platform',
    authenticatorAttachment: 'platform',
  }), 'Passkey');
  assert.equal(passkeyDisplayName({
    friendlyName: 'My laptop',
    authenticatorAttachment: 'platform',
  }), 'My laptop');

  // Raw Cognito seconds must not become Jan 1970.
  assert.equal(passkeyCreatedAtIso(1736293876.115), '2025-01-07T23:51:16.115Z');
  assert.equal(passkeyCreatedAtIso(null), null);
  assert.equal(passkeyCreatedAtIso('bogus'), null);
  assert.equal(passkeyCreatedAtIso(0), null);
  assert.equal(passkeyCreatedAtIso(1736293876), '2025-01-07T23:51:16.000Z');
  // Documents the historical bug: Date(seconds) → Jan 1970.
  assert.equal(new Date(1736293876).getUTCFullYear(), 1970);

  assert.equal(
    formatPasskeyMetaLine({ createdAt: 1736293876.115, lastUsedAt: null }),
    'Added 1/7/2025',
  );
  assert.equal(formatPasskeyMetaLine({ created_at: null, last_used_at: null }), '');
  assert.ok(!formatPasskeyMetaLine({ createdAt: null, lastUsedAt: null }).includes('Never used'));
  assert.ok(!formatPasskeyMetaLine({ createdAt: 1736293876.115 }).includes('1970'));

  const card = fs.readFileSync(path.join(ROOT, 'src/components/auth/PasskeyManagerCard.tsx'), 'utf8');
  assert.match(card, /passkeyDisplayName/);
  assert.match(card, /formatPasskeyMetaLine/);
  assert.doesNotMatch(card, /Never used/);
  assert.doesNotMatch(card, /authenticatorAttachment \|\| "Passkey"/);
  assert.doesNotMatch(card, /createdAt \|\| new Date\(\)\.toISOString\(\)/);
});

test('API list mapper reads FriendlyCredentialName (not FriendlyName alone)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-webauthn.mjs'), 'utf8');
  assert.match(source, /FriendlyCredentialName/);
  assert.match(source, /mapWebAuthnCredential/);
  assert.match(source, /normalizeWebAuthnCreatedAt/);
});
