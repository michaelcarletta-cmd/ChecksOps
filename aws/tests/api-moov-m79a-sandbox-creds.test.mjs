import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('M7.9A runner never prints secret values or arms POST flags', () => {
  const src = sourceOf('../providers/oneshot/m79a-run.mjs');
  assert.match(src, /checksops\/staging\/providers/);
  assert.match(src, /checksops\/production\/provider/);
  assert.match(src, /3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43/);
  assert.match(src, /PRODUCTION_MOOV_ORIGIN/);
  assert.match(src, /PRODUCTION_MOOV_API_VERSION/);
  assert.match(src, /sandbox_api_key_origin_is_staging_only/);
  assert.match(src, /refused_overwrite_MOOV_PUBLIC_KEY|PRODUCTION_PRESERVE/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /console\.log\(.*SecretString/);
  assert.doesNotMatch(src, /console\.log\(.*MOOV_SANDBOX_SECRET_KEY\)/);
  assert.match(src, /method: 'GET'/);
  assert.doesNotMatch(src, /method: 'POST',\s*[\s\S]*\/transfers/);
});

test('M7.9A uses the adapter-pinned sandbox API version and production origin', () => {
  const secrets = sourceOf('../functions/api/providers/production/moov-secrets.mjs');
  const client = sourceOf('../functions/api/providers/production/moov-sandbox-client.mjs');
  assert.match(secrets, /export const PRODUCTION_MOOV_API_VERSION = 'v2024.01.00'/);
  assert.match(secrets, /export const PRODUCTION_MOOV_ORIGIN = 'https:\/\/checksops.com'/);
  assert.match(client, /x-moov-version': credentials.apiVersion \|\| 'v2024.01.00'/);
});
