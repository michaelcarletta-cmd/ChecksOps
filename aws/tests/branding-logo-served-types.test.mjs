import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleBrandingLogo, servableBrandingLogoType } from '../functions/api/storage.mjs';

// GET /branding/logo/<tenant> is public and served from the app origin (checksops.com/prep): it
// serves a stored tenant logo only as PNG, JPEG, WebP or GIF whose bytes are that type, so an
// uploaded SVG (or HTML) logo never runs on checksops.com.

process.env.FILES_BUCKET = 'checksops-staging-privatefilesbucket-erzqsolpucjp';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const LOGO_URL = `/storage/public?bucket=tenant-logos&path=${TENANT}/logo.img`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

const depsFor = ({ contentType, bytes, logoUrl = LOGO_URL }) => {
  const s3Calls = [];
  return {
    s3Calls,
    deps: {
      loadDatabaseCredentials: async () => ({ host: 'h', port: 5432, username: 'u', password: 'p', dbname: 'd' }),
      createClient: () => ({
        connect: async () => {},
        end: async () => {},
        query: async (sql) => {
          assert.match(sql, /FROM tenants_public WHERE id = \$1::uuid/);
          return { rows: [{ id: TENANT, logo_url: logoUrl }] };
        },
      }),
      s3: {
        send: async (command) => {
          s3Calls.push(command.constructor.name);
          if (command.constructor.name === 'HeadObjectCommand') return {};
          if (command.constructor.name === 'GetObjectCommand') return { Body: bytes, ContentType: contentType };
          throw new Error(`unexpected ${command.constructor.name}`);
        },
      },
    },
  };
};

const logoEvent = { rawPath: `/branding/logo/${TENANT}`, requestContext: { http: { method: 'GET', path: `/branding/logo/${TENANT}` } } };

test('a PNG, JPEG, WebP or GIF tenant logo is still served with its own type', async () => {
  for (const [contentType, bytes] of [['image/png', PNG], ['image/jpeg', JPEG], ['image/jpg', JPEG], ['image/webp', WEBP], ['image/gif', GIF]]) {
    const { deps } = depsFor({ contentType, bytes });
    const result = await handleBrandingLogo(logoEvent, deps);
    assert.equal(result.statusCode, 200, contentType);
    assert.equal(result.binary, true, contentType);
    assert.equal(result.contentType, contentType === 'image/jpg' ? 'image/jpeg' : contentType);
    assert.ok(Buffer.from(result.body).equals(bytes), contentType);
  }
});

test('an SVG, HTML or untyped tenant logo is not served: 404 and no body, never relabelled', async () => {
  for (const [contentType, bytes] of [
    ['image/svg+xml', SVG],
    ['image/svg+xml; charset=utf-8', SVG],
    ['text/html', HTML],
    ['application/octet-stream', PNG],
    ['image/heic', JPEG],
  ]) {
    const { deps } = depsFor({ contentType, bytes });
    const result = await handleBrandingLogo(logoEvent, deps);
    assert.equal(result.statusCode, 404, contentType);
    assert.equal(result.error, 'logo_type_not_served', contentType);
    assert.equal(result.binary, undefined, contentType);
    assert.equal(result.body, undefined, contentType);
    assert.equal(result.contentType, undefined, contentType);
  }
});

test('a stored raster type whose bytes are another type (an SVG saved as image/png) is not served', async () => {
  for (const [contentType, bytes] of [['image/png', SVG], ['image/jpeg', HTML], ['image/gif', PNG], ['image/webp', Buffer.alloc(0)]]) {
    const { deps } = depsFor({ contentType, bytes });
    const result = await handleBrandingLogo(logoEvent, deps);
    assert.equal(result.statusCode, 404, contentType);
    assert.equal(result.error, 'logo_type_not_served', contentType);
  }
  assert.equal(servableBrandingLogoType(undefined, PNG), null);
  assert.equal(servableBrandingLogoType('IMAGE/PNG', PNG), 'image/png');
});
