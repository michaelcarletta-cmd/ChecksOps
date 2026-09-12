import { parseBody } from '../../data.mjs';
import { loadDatabaseCredentials } from '../../secrets.mjs';
import { buildClientConfig } from '../../db-health.mjs';
import pg from 'pg';
import {
  denyProductionOnboardingWrites,
  productionMoovOnboardingWritesAllowed,
  productionMoovReadsAllowed,
} from './moov-holds.mjs';
import {
  classifyRecipientInvite,
  hashRecipientInviteToken,
  noteRecipientTokenFailure,
  recipientTokenRateLimited,
} from './moov-recipient-token.mjs';
import { evaluateRecipientReady } from './moov-recipient-readiness.mjs';
import { fingerprintMoovId, productionMoovFetch } from './moov-client.mjs';
import { loadProductionMoovReadSecrets } from './moov-secrets.mjs';

const { Client } = pg;

const clientIp = (event) => {
  const forwarded = String(event?.headers?.['x-forwarded-for'] || event?.headers?.['X-Forwarded-For'] || '')
    .split(',')[0].trim();
  return forwarded || event?.requestContext?.http?.sourceIp || 'unknown';
};

const withPublicRead = async (event, fn, deps = {}) => {
  const body = parseBody(event);
  const createClient = deps.createClient || ((config) => new Client(config));
  let client;
  try {
    if (deps.createClient) {
      client = createClient({});
    } else {
      const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
      const credentials = await loadCredentials();
      client = createClient(buildClientConfig(credentials, { queryTimeoutMillis: 12000 }));
    }
    await client.connect();
    await client.query('BEGIN');
    const result = await fn({ client, body, event });
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    throw error;
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

const lookupRecipientByToken = async (client, token) => {
  const hash = hashRecipientInviteToken(token);
  const row = (await client.query(
    `SELECT id, tenant_id, display_name, provider_account_id, token_expires_at, onboarding_status,
            environment, bank_linked_at, provider_bank_name, provider_last_four, disconnected_at,
            secure_token
     FROM public.external_payment_recipients
     WHERE provider = 'moov'
       AND environment = 'production'
       AND (secure_token = $1 OR secure_token = $2 OR secure_token = $3)
     LIMIT 1`,
    [token, hash, `sha256:${hash}`],
  )).rows[0];
  return row || null;
};

export async function handlePublicRecipientFunction(name, event, deps = {}) {
  const ip = clientIp(event);
  const nowMs = deps.nowMs || Date.now();
  if (recipientTokenRateLimited({ ip, nowMs })) {
    return {
      ok: false,
      statusCode: 429,
      error: 'recipient_token_rate_limited',
      provider: 'moov',
      liveProviderCalled: false,
      message: 'Too many attempts. Try again later.',
    };
  }

  return withPublicRead(event, async ({ client, body }) => {
    const token = body.token;
    if (!token || typeof token !== 'string') {
      return { ok: false, statusCode: 400, error: 'token_required', provider: 'moov', liveProviderCalled: false };
    }

    const recipient = await lookupRecipientByToken(client, token);
    const classified = classifyRecipientInvite({ recipient, presentedToken: token, nowMs });
    if (!classified.ok) {
      noteRecipientTokenFailure({ ip, nowMs });
      return { ...classified, provider: 'moov', liveProviderCalled: false, tenant_enumerated: false };
    }

    const mutation = name !== 'moov-recipient-session';
    if (mutation && !productionMoovOnboardingWritesAllowed()) {
      return denyProductionOnboardingWrites(name, {
        public_recipient: true,
        cognito_required: false,
        financial_execution: false,
        recipient_id: classified.recipient_id,
        lovable_function: name,
      });
    }

    if (name !== 'moov-recipient-session') {
      return denyProductionOnboardingWrites(name, {
        message: 'M5 public recipient mutations remain dark even if the onboarding flag is on.',
      });
    }

    if (!productionMoovReadsAllowed()) {
      return {
        ok: true,
        statusCode: 200,
        provider: 'moov',
        liveProviderCalled: false,
        productionRead: false,
        public_recipient: true,
        cognito_required: false,
        financial_execution: false,
        recipient: {
          id: recipient.id,
          name: recipient.display_name,
          status: recipient.onboarding_status,
        },
        onboarding: { terms_accepted: null, verification_status: null, live: false },
        payer: { name: 'ChecksOps' },
        message: 'Live recipient Moov GET requires AWS_PROVIDER_LIVE_READS_ENABLED.',
      };
    }

    if (!recipient.provider_account_id) {
      return {
        ok: false,
        statusCode: 409,
        error: 'recipient_account_missing',
        provider: 'moov',
        liveProviderCalled: false,
      };
    }

    const secrets = await (deps.loadProductionReadSecrets || loadProductionMoovReadSecrets)(deps.getSecrets);
    if (!secrets.ok) return { ...secrets, public_recipient: true };

    const accountId = recipient.provider_account_id;
    const accountGet = await productionMoovFetch({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}`,
      mode: 'read',
      scopes: [`/accounts/${accountId}/profile.read`],
      fetchImpl: deps.fetchImpl || fetch,
    });
    const banksGet = await productionMoovFetch({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}/bank-accounts`,
      mode: 'read',
      scopes: [`/accounts/${accountId}/bank-accounts.read`],
      fetchImpl: deps.fetchImpl || fetch,
    });
    const methodsGet = await productionMoovFetch({
      credentials: secrets.credentials,
      path: `/accounts/${accountId}/payment-methods`,
      mode: 'read',
      scopes: [`/accounts/${accountId}/payment-methods.read`],
      fetchImpl: deps.fetchImpl || fetch,
    });
    const listOf = (json) => (Array.isArray(json) ? json : []);
    const readiness = evaluateRecipientReady({
      account: accountGet.json,
      banks: listOf(banksGet.json),
      paymentMethods: listOf(methodsGet.json),
      capabilities: [],
    });

    return {
      ok: true,
      statusCode: 200,
      provider: 'moov',
      liveProviderCalled: true,
      productionExecution: false,
      public_recipient: true,
      cognito_required: false,
      financial_execution: false,
      recipient: {
        id: recipient.id,
        name: recipient.display_name,
        status: recipient.onboarding_status,
      },
      account_id_fp: fingerprintMoovId(accountId),
      readiness,
      payer: { name: 'ChecksOps' },
    };
  }, deps);
}
