import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PRODUCTION_RECIPIENT_BRIDGE_PROJECT_REF,
  PRODUCTION_RECIPIENT_BRIDGE_URL,
  recipientSessionTokenShape,
  resolveProductionRecipientByToken,
} from '../functions/api/production-recipient-token.mjs';

const BRIDGE = readFileSync(new URL('../../supabase/functions/aws-staging-db-bridge/index.ts', import.meta.url), 'utf8');
const CONFIG = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
const DEPLOY = readFileSync(new URL('../../scripts/m63a-deploy-db-bridge.sh', import.meta.url), 'utf8');
const WORKFLOW = readFileSync(new URL('../../.github/workflows/moov-m63a-db-bridge-deploy.yml', import.meta.url), 'utf8');

const RECIPIENT_ID = '62a858ff-ee6a-49d7-9898-1c8e4a44227b';
const HEX_TOKEN = 'a'.repeat(64);

test('bridge URL is production project nbcqwpysqgyxrrbgtmkw', () => {
  assert.equal(PRODUCTION_RECIPIENT_BRIDGE_PROJECT_REF, 'nbcqwpysqgyxrrbgtmkw');
  assert.match(PRODUCTION_RECIPIENT_BRIDGE_URL, /nbcqwpysqgyxrrbgtmkw\.supabase\.co/);
  assert.doesNotMatch(PRODUCTION_RECIPIENT_BRIDGE_URL, /sqyyvpaymashtdwjjmku/);
});

test('token shape accepts UUID and hex, rejects operators', () => {
  assert.equal(recipientSessionTokenShape('62a858ff-ee6a-49d7-9898-1c8e4a44227b'), '62a858ff-ee6a-49d7-9898-1c8e4a44227b');
  assert.equal(recipientSessionTokenShape(HEX_TOKEN), HEX_TOKEN);
  assert.equal(recipientSessionTokenShape('x'), '');
  assert.equal(recipientSessionTokenShape('*,id=eq.1'), '');
  assert.equal(recipientSessionTokenShape('or=(id.eq.1)'), '');
  assert.equal(recipientSessionTokenShape(''), '');
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

test('resolve posts only the submitted token and never returns secure_token', async () => {
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
          recipient: {
            id: RECIPIENT_ID,
            display_name: 'Recipient',
            secure_token: 'must-not-leak',
            token: 'must-not-leak',
          },
          tenant: { name: 'Freedom Adjustment' },
        }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.recipient.id, RECIPIENT_ID);
  assert.equal(result.recipient.secure_token, undefined);
  assert.equal(result.recipient.token, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.action, 'recipient_session_resolve');
  assert.equal(calls[0].body.token, HEX_TOKEN);
  assert.equal(Object.keys(calls[0].body).sort().join(','), 'action,token');
});

test('unknown token is 404', async () => {
  const result = await resolveProductionRecipientByToken({
    token: HEX_TOKEN,
    bridgeToken: 'migration-token',
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'This link is not valid.', ok: false }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.error, 'This link is not valid.');
});

test('live db-bridge resolve action is GET-only, token-only, and omits raw secure_token', () => {
  const action = BRIDGE.slice(BRIDGE.indexOf('if (action === "recipient_session_resolve")'));
  assert.match(action, /method: "GET"/);
  assert.match(action, /SESSION_TOKEN_RE/);
  assert.match(action, /params\.set\("secure_token"/);
  assert.match(action, /limit", "1"/);
  assert.doesNotMatch(action, /INSERT/);
  assert.doesNotMatch(action, /UPDATE/);
  assert.doesNotMatch(action, /DELETE/);
  assert.doesNotMatch(action, /UPSERT/);
  assert.doesNotMatch(action, /rpc\//);
  assert.doesNotMatch(action, /select=.*secure_token/);
  assert.match(action, /delete recipient\.secure_token/);
  assert.doesNotMatch(action, /console\.(log|info|debug|error)\([^)]*token/);
  assert.match(BRIDGE, /writes: false/);
  assert.match(BRIDGE, /deletes: false/);
  assert.match(BRIDGE, /rpc: false/);
  assert.match(BRIDGE, /rawSql: false/);
});

test('db-bridge JWT is off and deploy script targets only this production function', () => {
  assert.match(CONFIG, /\[functions\.aws-staging-db-bridge\][\s\S]*?verify_jwt = false/);
  assert.match(DEPLOY, /aws-staging-db-bridge/);
  assert.match(DEPLOY, /nbcqwpysqgyxrrbgtmkw/);
  assert.doesNotMatch(DEPLOY, /moov-recipient-kyc-update/);
  assert.doesNotMatch(DEPLOY, /moov-recipient-tos-accept/);
  assert.doesNotMatch(DEPLOY, /functions deploy$/m);
  assert.match(WORKFLOW, /aws-staging-db-bridge/);
  assert.match(WORKFLOW, /environment: Production/);
  assert.doesNotMatch(WORKFLOW, /moov-recipient-kyc-update/);
});
