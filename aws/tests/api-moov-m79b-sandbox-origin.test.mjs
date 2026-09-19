import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hmacHex } from '../functions/api/providers/hmac.mjs';
import { verifyMoovWebhookEnvironment } from '../functions/api/providers/webhooks.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('M7.9B runner never prints secrets, never arms POST, never creates a replacement key', () => {
  const src = sourceOf('../providers/oneshot/m79b-run.mjs');
  assert.match(src, /checksops\/staging\/providers/);
  assert.match(src, /checksops\/production\/provider/);
  assert.match(src, /3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43/);
  assert.match(src, /https:\/\/checksops.com/);
  assert.match(src, /https:\/\/www.checksops.com/);
  assert.match(src, /moov_api_key_origin_requires_dashboard/);
  assert.match(src, /PRODUCTION_PRESERVE/);
  assert.match(src, /PRODUCTION_MOOV_API_VERSION/);
  assert.match(src, /MOOV_SANDBOX_API_VERSION = PROVEN_API_VERSION/);
  assert.match(src, /do not create a new key/);
  assert.match(src, /Never creates a replacement key/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /console\.log\(.*SecretString/);
  assert.doesNotMatch(src, /console\.log\(.*MOOV_SANDBOX_SECRET_KEY\)/);
  assert.doesNotMatch(src, /method: 'POST',\s*[\s\S]{0,80}\/transfers/);
  assert.match(src, /if \(!\['GET', 'PATCH', 'PUT'\]\.includes\(method\)\)/);
});

test('M7.9B webhook isolation classifies signing secret environment independently of payload account id', () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sandboxSecret = 'sandbox-webhook-secret';
  const productionSecret = 'production-webhook-secret';
  const secrets = {
    MOOV_WEBHOOK_SECRET: productionSecret,
    MOOV_SANDBOX_WEBHOOK_SECRET: sandboxSecret,
  };
  const event = (id, secret) => ({
    headers: {
      'x-timestamp': ts,
      'x-nonce': 'nonce',
      'x-webhook-id': id,
      'x-signature': hmacHex(secret, `${ts}|nonce|${id}`, 'sha512'),
    },
  });
  const sandbox = verifyMoovWebhookEnvironment({
    event: event('evt-s', sandboxSecret),
    rawBody: JSON.stringify({ eventID: 'evt-s', accountID: '36b79957-ce7a-4ca7-a68f-30986c9e47bb' }),
    secrets,
  });
  const production = verifyMoovWebhookEnvironment({
    event: event('evt-p', productionSecret),
    rawBody: JSON.stringify({ eventID: 'evt-p', accountID: '60922058-7eca-4889-81dd-5720d7b9de96' }),
    secrets,
  });
  const cross = verifyMoovWebhookEnvironment({
    event: event('evt-x', sandboxSecret),
    rawBody: JSON.stringify({ eventID: 'evt-x', accountID: '60922058-7eca-4889-81dd-5720d7b9de96' }),
    secrets,
  });
  assert.equal(sandbox.ok, true);
  assert.equal(sandbox.environment, 'sandbox');
  assert.equal(production.ok, true);
  assert.equal(production.environment, 'production');
  assert.equal(cross.ok, true);
  assert.equal(cross.environment, 'sandbox');
});
