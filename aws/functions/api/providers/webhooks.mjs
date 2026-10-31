import { createHash } from 'node:crypto';
import pg from 'pg';
import { loadDatabaseCredentials } from '../secrets.mjs';
import { buildWriteClientConfig } from '../db-health.mjs';
import { loadProviderSecrets, webhookSecret } from '../provider-secrets.mjs';
import { providerWebhookDryRun } from '../provider-flags.mjs';
import { rawEventBody, verifyHmacBodySignature, verifyMoovSignature } from './hmac.mjs';
import { applyCheckAltWebhook, applyMoovWebhook, sandboxWebhookApplyEnabled } from './webhook-apply.mjs';
import { productionOnboardingWebhookApplyEnabled } from './onboarding/flags.mjs';
import { applyProductionOnboardingWebhook } from './onboarding/webhook-status.mjs';
import { applyCollectionV2ProviderCompletion } from '../tenant-collection-v2-settlement.mjs';
import { billingEnvironment } from '../tenant-billing-destination.mjs';
import { MoovConfirmationRetry, confirmMoovWebhookPayload } from './moov-webhook-confirm.mjs';
import {
  applyProductionMoovTransferWebhook,
  isMoovTransferEvent,
  productionTransferWebhookApplyEnabled,
} from './moov-transfer-webhook.mjs';

const { Client } = pg;

const DROP_KEYS = /account_?number|routing_?number|secret|password|token|authorization|ssn|dob|birth_?date|tax_?id|government_?id|^ein$|bank_account|iban|plaid_access/i;

export const sanitizeWebhookPayload = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeWebhookPayload(item));
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (DROP_KEYS.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (key === 'tenant_id' || key === 'tenantId') {
      out[key] = '[ignored-untrusted]';
      continue;
    }
    out[key] = sanitizeWebhookPayload(nested);
  }
  return out;
};

export const payloadSha256 = (rawBody) => createHash('sha256').update(String(rawBody || '')).digest('hex');

const parseJson = (rawBody) => {
  try {
    return { ok: true, payload: rawBody ? JSON.parse(rawBody) : {} };
  } catch {
    return { ok: false, error: 'malformed_webhook' };
  }
};

const eventTypeOf = (payload) => payload?.type || payload?.eventType || payload?.webhook_type || payload?.webhook_code || 'unknown';

/**
 * The receipt key. Moov: the signed X-Webhook-ID only (the body is not signed, so a body
 * eventID could be anything). CheckAlt signs the body, so its body id stays first.
 */
const externalIdOf = (provider, payload, verifiedId) => (
  provider === 'moov'
    ? (verifiedId || null)
    : (payload?.eventID || payload?.event_id || payload?.id || verifiedId || null)
);

const providerAccountOf = (provider, payload) => {
  if (provider === 'moov') return payload?.accountID || payload?.data?.accountID || payload?.accountId || null;
  if (provider === 'checkalt') return payload?.ssoUserId || payload?.userAccountId || null;
  return null;
};

const resourceIdOf = (provider, payload) => {
  if (provider === 'moov') return payload?.data?.transferID || payload?.data?.bankAccountID || payload?.transferID || null;
  if (provider === 'checkalt') return payload?.referenceNumber || payload?.checkalt_reference || null;
  return null;
};

export const verifyProviderWebhook = ({ provider, event, rawBody, secret, nowMs }) => {
  if (provider === 'moov') return verifyMoovSignature({ event, rawBody, secret, nowMs });
  return verifyHmacBodySignature({ event, rawBody, secret, nowMs });
};

const lookupMappedTenant = async (client, provider, payload) => {
  if (provider === 'moov') {
    const providerAccountId = providerAccountOf(provider, payload);
    if (!providerAccountId) return { mapped_tenant_id: null, mapped_internal_id: null, lookup: 'no_provider_id' };
    try {
      const row = (await client.query(
        'SELECT id, tenant_id FROM public.aws_lookup_provider_account($1, $2)',
        ['moov', String(providerAccountId)],
      )).rows[0];
      return {
        mapped_tenant_id: row?.tenant_id || null,
        mapped_internal_id: row?.id || null,
        lookup: row ? 'provider_account' : 'unmapped',
      };
    } catch {
      return { mapped_tenant_id: null, mapped_internal_id: null, lookup: 'lookup_unavailable' };
    }
  }
  if (provider === 'checkalt') {
    const reference = resourceIdOf(provider, payload);
    if (!reference) return { mapped_tenant_id: null, mapped_internal_id: null, lookup: 'no_reference' };
    try {
      const row = (await client.query(
        'SELECT id, tenant_id FROM public.aws_lookup_checkalt_deposit($1)',
        [String(reference)],
      )).rows[0];
      return {
        mapped_tenant_id: row?.tenant_id || null,
        mapped_internal_id: row?.id || null,
        lookup: row ? 'checkalt_deposit' : 'unmapped',
      };
    } catch {
      return { mapped_tenant_id: null, mapped_internal_id: null, lookup: 'lookup_unavailable' };
    }
  }
  return { mapped_tenant_id: null, mapped_internal_id: null, lookup: 'not_applicable' };
};

const insertReceipt = async (client, row) => {
  const inserted = (await client.query(
    `INSERT INTO public.aws_provider_webhook_receipts
       (provider, external_event_id, event_type, payload_sha256, mapped_tenant_id, mapped_internal_id, dry_run)
     VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7)
     ON CONFLICT (provider, external_event_id) DO NOTHING
     RETURNING id, provider, external_event_id, dry_run, received_at`,
    [
      row.provider,
      row.external_event_id,
      row.event_type,
      row.payload_sha256,
      row.mapped_tenant_id,
      row.mapped_internal_id,
      row.dry_run,
    ],
  )).rows[0];
  if (inserted) return { receipt: inserted, duplicate: false };
  const existing = (await client.query(
    `SELECT id, provider, external_event_id, dry_run, received_at
     FROM public.aws_provider_webhook_receipts
     WHERE provider = $1 AND external_event_id = $2`,
    [row.provider, row.external_event_id],
  )).rows[0];
  return { receipt: existing, duplicate: true };
};

export const handleProviderWebhook = async (event, provider, deps = {}) => {
  const rawBody = rawEventBody(event);
  const parsed = parseJson(rawBody);
  if (!parsed.ok) {
    return { ok: false, statusCode: 400, error: 'malformed_webhook', message: 'Webhook body is not valid JSON' };
  }

  const secrets = await (deps.loadProviderSecrets || loadProviderSecrets)();
  const secret = webhookSecret(secrets, provider);
  const verified = verifyProviderWebhook({
    provider,
    event,
    rawBody,
    secret,
    nowMs: deps.nowMs,
  });
  if (!verified.ok) {
    return {
      ok: false,
      statusCode: 401,
      error: verified.reason === 'missing_signature_headers' || verified.reason === 'malformed_webhook'
        ? verified.reason
        : 'invalid_signature',
      message: 'Webhook rejected',
      provider,
    };
  }

  const dryRun = providerWebhookDryRun();
  const externalEventId = externalIdOf(provider, parsed.payload, verified.eventId);
  if (!externalEventId) {
    return { ok: false, statusCode: 400, error: 'malformed_webhook', message: 'Webhook is missing an event id' };
  }

  const sanitized = sanitizeWebhookPayload(parsed.payload);
  const createClient = deps.createClient || ((config) => new Client(config));
  const loadCredentials = deps.loadDatabaseCredentials || loadDatabaseCredentials;
  let client;
  let didCommit = false;
  try {
    const credentials = await loadCredentials();
    client = createClient(buildWriteClientConfig(credentials, { queryTimeoutMillis: 12000 }));
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ WRITE');
    await client.query("SELECT set_config('request.provider_webhook', '1', true)");

    const mapped = await lookupMappedTenant(client, provider, parsed.payload);
    const stored = await insertReceipt(client, {
      provider,
      external_event_id: String(externalEventId),
      event_type: String(eventTypeOf(parsed.payload)).slice(0, 120),
      payload_sha256: payloadSha256(rawBody),
      mapped_tenant_id: mapped.mapped_tenant_id,
      mapped_internal_id: mapped.mapped_internal_id,
      dry_run: dryRun,
    });

    let applyResult = {
      applied: false,
      financialTablesMutated: false,
      skipped: 'sandbox_apply_disabled',
    };
    let collectionV2Settlement = { applied: false, skipped: 'not_attempted' };
    let confirmation = null;
    const moovApplyWanted = provider === 'moov' && (
      sandboxWebhookApplyEnabled() || !dryRun || productionOnboardingWebhookApplyEnabled()
    );
    if (stored.duplicate) {
      applyResult = { applied: false, skipped: 'duplicate', financialTablesMutated: false };
      if (provider === 'moov') collectionV2Settlement = { applied: false, skipped: 'duplicate' };
    } else if (provider === 'checkalt' && sandboxWebhookApplyEnabled()) {
      applyResult = await applyCheckAltWebhook(client, parsed.payload);
    } else if (moovApplyWanted) {
      // Never write from the body: read the named transfer / account back from Moov and
      // apply only what Moov returned (moov-webhook-confirm.mjs).
      confirmation = await (deps.confirmMoovWebhook || confirmMoovWebhookPayload)(parsed.payload, {
        environment: sandboxWebhookApplyEnabled() ? 'sandbox' : billingEnvironment(),
        secrets,
        fetchImpl: deps.fetchImpl || fetch,
        loadSandbox: deps.loadSandboxCredentials || null,
      });
      if (!confirmation.ok) {
        applyResult = { applied: false, skipped: confirmation.skipped, financialTablesMutated: false };
        collectionV2Settlement = { applied: false, skipped: confirmation.skipped };
      } else {
        const trusted = confirmation.payload;
        if (sandboxWebhookApplyEnabled()) {
          applyResult = await applyMoovWebhook(client, trusted, {
            mappedTenantId: mapped.mapped_tenant_id,
          });
        } else if (isMoovTransferEvent(eventTypeOf(trusted)) && productionTransferWebhookApplyEnabled()) {
          // Production: status, ACH return and NOC of a funding or send leg (SQL 109 writer).
          // Records only; never moves money.
          applyResult = await applyProductionMoovTransferWebhook(client, trusted, {
            eventId: String(externalEventId),
          });
        } else if (productionOnboardingWebhookApplyEnabled()) {
          // Production: onboarding status only (account / capability / verification),
          // behind AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED. Money movement is never applied here.
          applyResult = await applyProductionOnboardingWebhook(client, trusted);
        }
        if (!dryRun) {
          collectionV2Settlement = await applyCollectionV2ProviderCompletion(client, trusted, { dryRun });
        }
      }
    }
    if (provider === 'moov' && dryRun && collectionV2Settlement.skipped === 'not_attempted') {
      collectionV2Settlement = { applied: false, skipped: 'dry_run' };
    }

    await client.query('COMMIT');
    didCommit = true;

    return {
      ok: true,
      statusCode: 200,
      accepted: true,
      duplicate: stored.duplicate,
      dry_run: dryRun,
      applied: Boolean(applyResult.applied),
      apply_skipped: applyResult.skipped || null,
      apply_mutations: applyResult.mutations || [],
      apply_environment: applyResult.environment || null,
      provider,
      event_type: eventTypeOf(parsed.payload),
      receipt_id: stored.receipt?.id || null,
      mapped_tenant_id: mapped.mapped_tenant_id,
      lookup: mapped.lookup,
      payload: sanitized,
      financialTablesMutated: Boolean(applyResult.financialTablesMutated || collectionV2Settlement.applied),
      productionRecordsMutated: Boolean(collectionV2Settlement.productionRecordsMutated),
      liveProviderCalled: Boolean(confirmation?.liveProviderCalled),
      provider_confirmation: confirmation ? { ok: confirmation.ok, resource: confirmation.resource || null, skipped: confirmation.skipped || null } : null,
      collection_v2_settlement: collectionV2Settlement,
    };
  } catch (error) {
    if (client && !didCommit) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    if (error instanceof MoovConfirmationRetry) {
      // Nothing was kept (the receipt rolled back); Moov delivers the webhook again.
      return {
        ok: false,
        statusCode: 503,
        error: error.code,
        message: 'Moov could not be read to confirm the webhook; it will be retried',
        provider,
        financialTablesMutated: false,
      };
    }
    return {
      ok: false,
      statusCode: 500,
      error: 'webhook_persist_failed',
      message: String(error?.message || error).slice(0, 200),
      provider,
      financialTablesMutated: false,
    };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};
