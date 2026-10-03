import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PRODUCTION_RECIPIENT_BRIDGE_PROJECT_REF,
  PRODUCTION_RECIPIENT_BRIDGE_URL,
  recipientSessionResolveBridgeBody,
  recipientSessionTokenShape,
  resolveProductionRecipientByToken,
} from '../functions/api/production-recipient-token.mjs';

const BRIDGE = readFileSync(new URL('../../supabase/functions/aws-staging-db-bridge/index.ts', import.meta.url), 'utf8');
const RECIPIENT_ID = '62a858ff-ee6a-49d7-9898-1c8e4a44227b';
const HEX_TOKEN = 'a'.repeat(64);

test('bridge URL is production project nbcqwpysqgyxrrbgtmkw', () => {
  assert.equal(PRODUCTION_RECIPIENT_BRIDGE_PROJECT_REF, 'nbcqwpysqgyxrrbgtmkw');
  assert.match(PRODUCTION_RECIPIENT_BRIDGE_URL, /nbcqwpysqgyxrrbgtmkw\.supabase\.co/);
});

test('token shape accepts UUID and hex, rejects operators', () => {
  assert.equal(recipientSessionTokenShape('62a858ff-ee6a-49d7-9898-1c8e4a44227b'), '62a858ff-ee6a-49d7-9898-1c8e4a44227b');
  assert.equal(recipientSessionTokenShape(HEX_TOKEN), HEX_TOKEN);
  assert.equal(recipientSessionTokenShape('x'), '');
  assert.equal(recipientSessionTokenShape('*,id=eq.1'), '');
  assert.equal(recipientSessionTokenShape('or=(id.eq.1)'), '');
});

test('bridge body sends secure_token for live recipient_session_resolve', () => {
  const body = recipientSessionResolveBridgeBody(HEX_TOKEN);
  assert.equal(body.action, 'recipient_session_resolve');
  assert.equal(body.secure_token, HEX_TOKEN);
  assert.equal(body.token, HEX_TOKEN);
});

test('malformed tokens never call the bridge', async () => {
  const calls = [];
  const result = await resolveProductionRecipientByToken({
    token: 'x',
    bridgeToken: 'migration-token',
    fetchImpl: async (...args) => {
      calls.push(args);
      throw new Error('must_not_fetch');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  assert.equal(calls.length, 0);
});

test('resolve posts secure_token and never returns the raw token', async () => {
  const calls = [];
  const result = await resolveProductionRecipientByToken({
    token: HEX_TOKEN,
    bridgeToken: 'migration-token',
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          resolved: true,
          recipient: {
            id: RECIPIENT_ID,
            display_name: 'Recipient',
            secure_token: 'must-not-leak',
            token: 'must-not-leak',
          },
        }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recipient.id, RECIPIENT_ID);
  assert.equal(result.recipient.secure_token, undefined);
  assert.equal(result.recipient.token, undefined);
  assert.equal(calls[0].body.action, 'recipient_session_resolve');
  assert.equal(calls[0].body.secure_token, HEX_TOKEN);
});

test('bridge invalid_token reason maps to 404', async () => {
  const result = await resolveProductionRecipientByToken({
    token: HEX_TOKEN,
    bridgeToken: 'migration-token',
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ ok: false, resolved: false, reason: 'invalid_token' }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.error, 'This link is not valid.');
});

test('live db-bridge resolve accepts token or secure_token and is read-only', () => {
  const action = BRIDGE.slice(BRIDGE.indexOf('if (action === "recipient_session_resolve")'));
  assert.match(action, /body\.secure_token/);
  assert.match(action, /body\.token/);
  assert.match(action, /params\.set\("secure_token"/);
  assert.match(action, /\/rest\/v1\/external_payment_recipients/);
  assert.doesNotMatch(action, /method:\s*"POST"/);
  assert.doesNotMatch(action, /INSERT/);
  assert.doesNotMatch(action, /UPDATE/);
  assert.doesNotMatch(action, /DELETE/);
  assert.doesNotMatch(action, /select=.*secure_token/);
});
