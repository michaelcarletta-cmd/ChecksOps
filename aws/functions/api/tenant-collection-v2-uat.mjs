/**
 * TEMPORARY staging-only Collection V2 UAT harness.
 *
 * Test infrastructure, not a product feature. Remove after UAT by deleting
 * this file and the POST /uat/collection-v2 hook in index.mjs.
 *
 * Invokes the same applyBillingProviderEvent() used by production settlement.
 * Does not create payment_transfers, bank, Moov, ACH, wallet, or ledger rows.
 * Does not change webhook flags, RLS, grants, or financial permissions.
 */
import { randomUUID } from 'node:crypto';
import { parseBody, withIdentityWrite } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';
import { COLLECTION_CONTRACT_ID } from './tenant-collection-v2.mjs';
import { applyBillingProviderEvent } from './tenant-collection-v2-settlement.mjs';

export const UAT_SETTLEMENT_FN = applyBillingProviderEvent;

export const SYNTHETIC_UAT_MARKER = 'SYNTHETIC_UAT_COLLECTION_V2';
export const UAT_AMOUNT_CENTS = 1;
export const UAT_PROVIDER_ENVIRONMENT = 'sandbox';
export const UAT_COMPLETED_AT = '2026-10-05T14:00:00.000Z';
export const UAT_RETURN_REASON = 'synthetic_uat_return';
export const UAT_ACTIONS = Object.freeze([
  'create',
  'complete',
  'complete_again',
  'unrelated',
  'return',
  'inspect',
  'cleanup',
]);

export const FORBIDDEN_OBLIGATION_ID = '72b622f9-b68f-4032-a971-a854dbcfbf57';
export const FORBIDDEN_TRANSFER_ID = 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb';
export const FREEDOM_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALLER_ID_KEYS = Object.freeze([
  'obligation_id',
  'payment_id',
  'tmp_id',
  'tenant_maintenance_payment_id',
  'provider_transfer_id',
  'transfer_id',
  'existing_id',
]);

const denied = (error, extra = {}) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  error,
  harness: 'collection_v2_uat',
  temporary: true,
  liveProviderTransactions: false,
  moovCalled: false,
  achCreated: false,
  walletMoved: false,
  ledgerMoved: false,
  ...extra,
});

const ok = (extra = {}) => ({
  ok: true,
  statusCode: 200,
  harness: 'collection_v2_uat',
  temporary: true,
  liveProviderTransactions: false,
  moovCalled: false,
  achCreated: false,
  walletMoved: false,
  ledgerMoved: false,
  settlement_fn: 'applyBillingProviderEvent',
  ...extra,
});

const asText = (value) => String(value || '').trim();

const callerSuppliedIds = (body = {}) => CALLER_ID_KEYS
  .map((key) => ({ key, value: asText(body[key]) }))
  .filter((entry) => entry.value);

export const assertStagingOnly = (env) => {
  if (String(env || '') !== 'staging') {
    return denied('production_uat_forbidden', {
      statusCode: 403,
      environment: env || 'unknown',
    });
  }
  return null;
};

export const assertSyntheticMarker = (body = {}) => {
  const marker = asText(body.marker || body.synthetic_marker);
  if (marker !== SYNTHETIC_UAT_MARKER) {
    return denied('synthetic_marker_required', { statusCode: 403 });
  }
  return null;
};

export const assertUatAmountAndEnvironment = (body = {}) => {
  if (body.amount_cents != null && Number(body.amount_cents) !== UAT_AMOUNT_CENTS) {
    return denied('amount_not_one_cent', {
      statusCode: 403,
      amount_cents: Number(body.amount_cents),
    });
  }
  const environment = asText(body.provider_environment || body.environment);
  if (environment && environment !== UAT_PROVIDER_ENVIRONMENT) {
    return denied('sandbox_required', {
      statusCode: 403,
      provider_environment: environment,
    });
  }
  return null;
};

export const refuseForbiddenOrCallerIds = (body = {}) => {
  const supplied = callerSuppliedIds(body);
  if (supplied.length) {
    const forbidden = supplied.find((entry) => (
      entry.value === FORBIDDEN_OBLIGATION_ID || entry.value === FORBIDDEN_TRANSFER_ID
    ));
    if (forbidden?.value === FORBIDDEN_OBLIGATION_ID) {
      return denied('freedom_obligation_forbidden', { statusCode: 403 });
    }
    if (forbidden?.value === FORBIDDEN_TRANSFER_ID) {
      return denied('real_transfer_forbidden', { statusCode: 403 });
    }
    return denied('caller_ids_refused', {
      statusCode: 403,
      refused_keys: supplied.map((entry) => entry.key),
    });
  }
  const extras = [body.harness_id, body.obligation_id, body.provider_transfer_id, body.transfer_id]
    .map(asText)
    .filter(Boolean);
  if (extras.includes(FORBIDDEN_OBLIGATION_ID)) {
    return denied('freedom_obligation_forbidden', { statusCode: 403 });
  }
  if (extras.includes(FORBIDDEN_TRANSFER_ID)) {
    return denied('real_transfer_forbidden', { statusCode: 403 });
  }
  return null;
};

export const assertUatAdmin = async (client, mapping) => {
  const roles = (await client.query(USER_ROLES_SQL, [mapping.application_user_id])).rows
    .map((row) => String(row.role || '').toLowerCase());
  const owners = (await client.query(
    `SELECT public.is_master_owner() AS is_master, public.is_platform_owner() AS is_platform`,
  )).rows[0] || {};
  const authorized = owners.is_master === true
    || owners.is_platform === true
    || roles.includes('admin')
    || roles.includes('operator');
  if (!authorized) {
    return denied('admin_required', { statusCode: 403 });
  }
  return null;
};

const harnessNotes = ({ harnessId, obligationId, transferId }) => (
  `${SYNTHETIC_UAT_MARKER} harness=${harnessId} obligation=${obligationId} transfer=${transferId} collection_v2 ${COLLECTION_CONTRACT_ID}`
);

const looksSynthetic = (row = {}, harnessId = '') => {
  const notes = String(row.notes || '');
  return notes.includes(SYNTHETIC_UAT_MARKER)
    && (!harnessId || notes.includes(`harness=${harnessId}`))
    && Number(row.amount_cents) === UAT_AMOUNT_CENTS
    && String(row.provider_environment || '') === UAT_PROVIDER_ENVIRONMENT
    && row.id !== FORBIDDEN_OBLIGATION_ID
    && String(row.provider_transfer_id || '') !== FORBIDDEN_TRANSFER_ID;
};

const generateUniqueIds = async (client, randomId) => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const harnessId = randomId();
    const obligationId = randomId();
    const transferId = randomId();
    const forbidden = [harnessId, obligationId, transferId].some((id) => (
      id === FORBIDDEN_OBLIGATION_ID || id === FORBIDDEN_TRANSFER_ID
    ));
    if (forbidden || !UUID_RE.test(harnessId) || !UUID_RE.test(obligationId) || !UUID_RE.test(transferId)) {
      continue;
    }
    const existing = (await client.query(
      `SELECT id, provider_transfer_id
         FROM public.tenant_maintenance_payments
        WHERE id = $1::uuid
           OR provider_transfer_id = $2
        LIMIT 1`,
      [obligationId, transferId],
    )).rows[0];
    if (existing) continue;
    return { harnessId, obligationId, transferId };
  }
  return null;
};

const pickWritableTenant = async (client) => {
  const preferred = (await client.query(
    `SELECT id FROM public.tenants
      WHERE id <> $1::uuid
      ORDER BY created_at NULLS LAST, id
      LIMIT 1`,
    [FREEDOM_TENANT_ID],
  ).catch(() => ({ rows: [] }))).rows[0];
  if (preferred?.id) return preferred.id;
  const any = (await client.query(
    `SELECT id FROM public.tenants ORDER BY created_at NULLS LAST, id LIMIT 1`,
  ).catch(() => ({ rows: [] }))).rows[0];
  return any?.id || null;
};

const loadFixture = async (client, harnessId) => {
  if (!UUID_RE.test(String(harnessId || ''))) return null;
  const row = (await client.query(
    `SELECT * FROM public.tenant_maintenance_payments
      WHERE notes LIKE $1
        AND notes LIKE $2
        AND amount_cents = $3
        AND provider_environment = $4
        AND id <> $5::uuid
      LIMIT 1`,
    [
      `%${SYNTHETIC_UAT_MARKER}%`,
      `%harness=${harnessId}%`,
      UAT_AMOUNT_CENTS,
      UAT_PROVIDER_ENVIRONMENT,
      FORBIDDEN_OBLIGATION_ID,
    ],
  )).rows[0] || null;
  if (!row || !looksSynthetic(row, harnessId)) return null;
  return row;
};

const publicFixture = (row) => (row ? {
  id: row.id,
  tenant_id: row.tenant_id,
  status: row.status,
  amount_cents: Number(row.amount_cents),
  provider_environment: row.provider_environment,
  provider_transfer_id: row.provider_transfer_id,
  settled_at: row.settled_at || null,
  returned_at: row.returned_at || null,
  return_reason: row.return_reason || null,
  occurrence_kind: row.occurrence_kind || null,
  billing_period: row.billing_period || null,
  notes: row.notes || null,
} : null);

const settlementMetadata = (harnessId) => ({
  synthetic_uat: true,
  synthetic_uat_marker: SYNTHETIC_UAT_MARKER,
  harness_id: harnessId,
});

const createFixture = async ({ client, mapping, randomId }) => {
  const ids = await generateUniqueIds(client, randomId);
  if (!ids) return denied('id_collision', { statusCode: 409 });
  const tenantId = await pickWritableTenant(client);
  if (!tenantId) return denied('no_writable_tenant', { statusCode: 409 });
  const billingPeriod = `uat-cv2-${ids.harnessId.slice(0, 8)}`;
  const notes = harnessNotes(ids);
  const inserted = (await client.query(
    `INSERT INTO public.tenant_maintenance_payments (
       id, tenant_id, amount_cents, monthly_rate_cents, discount_cents,
       period_start, period_end, billing_period, method, status,
       idempotence_key, recorded_by, notes,
       funding_source_method_id, destination_account_id, destination_payment_method_id,
       provider_environment, occurrence_kind, provider_transfer_id, settled_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $3, 0,
       DATE '2099-01-01', DATE '2099-01-31', $4, 'synthetic_uat', 'submitted',
       $5, $6::uuid, $7,
       NULL, NULL, NULL,
       $8, 'monthly_subscription', $9, NULL
     )
     RETURNING *`,
    [
      ids.obligationId,
      tenantId,
      UAT_AMOUNT_CENTS,
      billingPeriod,
      `synthetic-uat-cv2-${ids.harnessId}`,
      mapping.application_user_id,
      notes,
      UAT_PROVIDER_ENVIRONMENT,
      ids.transferId,
    ],
  )).rows[0];
  if (!inserted) return denied('fixture_insert_failed', { statusCode: 503 });
  return ok({
    action: 'create',
    harness_id: ids.harnessId,
    fixture: publicFixture(inserted),
    created: {
      payment_transfers: false,
      bank_records: false,
      moov_records: false,
      wallet_records: false,
      ledger_entries: false,
    },
  });
};

const requireFixture = async (client, body) => {
  const harnessId = asText(body.harness_id);
  if (!harnessId) return { error: denied('harness_id_required', { statusCode: 400 }) };
  const fixture = await loadFixture(client, harnessId);
  if (!fixture) return { error: denied('synthetic_fixture_not_found', { statusCode: 404, harness_id: harnessId }) };
  return { harnessId, fixture };
};

const applyCompletion = async ({
  client,
  fixture,
  harnessId,
  applyEvent,
  status,
  completedAt = null,
  reason = null,
}) => applyEvent(client, {
  providerTransferId: fixture.provider_transfer_id,
  status,
  reason,
  completedAt,
  environment: UAT_PROVIDER_ENVIRONMENT,
  metadata: settlementMetadata(harnessId),
});

const inspectEvidence = async (client, fixture) => (
  await client.query(
    `SELECT id, event_type, previous_status, new_status, provider_transfer_id,
            environment, provider_metadata, created_at
       FROM public.payment_event_log
      WHERE provider_transfer_id = $1
        AND (
          provider_metadata->>'synthetic_uat_marker' = $2
          OR provider_metadata->>'harness_id' = $3
          OR provider_metadata->>'checksops_payment_id' = $4
        )
      ORDER BY created_at`,
    [
      fixture.provider_transfer_id,
      SYNTHETIC_UAT_MARKER,
      asText(fixture.notes).match(/harness=([0-9a-f-]+)/i)?.[1] || '',
      fixture.id,
    ],
  ).catch(() => ({ rows: [] }))
).rows;

const cleanupFixture = async ({ client, harnessId, fixture }) => {
  const deletedTmp = (await client.query(
    `DELETE FROM public.tenant_maintenance_payments
      WHERE id = $1::uuid
        AND notes LIKE $2
        AND notes LIKE $3
        AND amount_cents = $4
        AND provider_environment = $5
        AND id <> $6::uuid
      RETURNING id`,
    [
      fixture.id,
      `%${SYNTHETIC_UAT_MARKER}%`,
      `%harness=${harnessId}%`,
      UAT_AMOUNT_CENTS,
      UAT_PROVIDER_ENVIRONMENT,
      FORBIDDEN_OBLIGATION_ID,
    ],
  )).rows;
  let eventLogDeleted = [];
  let eventLogCleanupBlocked = false;
  try {
    eventLogDeleted = (await client.query(
      `DELETE FROM public.payment_event_log
        WHERE provider_transfer_id = $1
          AND (
            provider_metadata->>'synthetic_uat_marker' = $2
            OR provider_metadata->>'harness_id' = $3
          )
        RETURNING id`,
      [fixture.provider_transfer_id, SYNTHETIC_UAT_MARKER, harnessId],
    )).rows;
  } catch (error) {
    const blocked = error?.code === '42501' || /permission|row-level security/i.test(String(error?.message || ''));
    if (!blocked) throw error;
    eventLogCleanupBlocked = true;
  }
  return ok({
    action: 'cleanup',
    harness_id: harnessId,
    deleted: {
      tenant_maintenance_payments: deletedTmp.map((row) => row.id),
      payment_event_log: eventLogDeleted.map((row) => row.id),
    },
    event_log_cleanup_blocked: eventLogCleanupBlocked,
  });
};

export const runCollectionV2Uat = async ({
  client,
  mapping,
  body = {},
  applyEvent = applyBillingProviderEvent,
  randomId = randomUUID,
} = {}) => {
  const markerGate = assertSyntheticMarker(body);
  if (markerGate) return markerGate;
  const amountGate = assertUatAmountAndEnvironment(body);
  if (amountGate) return amountGate;
  const idGate = refuseForbiddenOrCallerIds(body);
  if (idGate) return idGate;

  const action = asText(body.action);
  if (!UAT_ACTIONS.includes(action)) {
    return denied('unknown_uat_action', { statusCode: 400, action });
  }

  const adminGate = await assertUatAdmin(client, mapping);
  if (adminGate) return adminGate;

  if (action === 'create') {
    return createFixture({ client, mapping, randomId });
  }

  const loaded = await requireFixture(client, body);
  if (loaded.error) return loaded.error;
  const { harnessId, fixture } = loaded;

  if (action === 'inspect') {
    return ok({
      action,
      harness_id: harnessId,
      fixture: publicFixture(fixture),
      events: await inspectEvidence(client, fixture),
    });
  }

  if (action === 'cleanup') {
    return cleanupFixture({ client, harnessId, fixture });
  }

  if (action === 'unrelated') {
    const before = publicFixture(fixture);
    const unrelatedId = randomId();
    const settlement = await applyEvent(client, {
      providerTransferId: unrelatedId,
      status: 'completed',
      completedAt: UAT_COMPLETED_AT,
      environment: UAT_PROVIDER_ENVIRONMENT,
      metadata: settlementMetadata(harnessId),
    });
    const after = publicFixture(await loadFixture(client, harnessId));
    return ok({
      action,
      harness_id: harnessId,
      fixture: after,
      unchanged: before?.status === after?.status && before?.settled_at === after?.settled_at,
      settlement,
    });
  }

  const settlement = action === 'return'
    ? await applyCompletion({
      client,
      fixture,
      harnessId,
      applyEvent,
      status: 'returned',
      reason: UAT_RETURN_REASON,
    })
    : await applyCompletion({
      client,
      fixture,
      harnessId,
      applyEvent,
      status: 'completed',
      completedAt: UAT_COMPLETED_AT,
    });

  return ok({
    action,
    harness_id: harnessId,
    fixture: publicFixture(settlement.occurrence || await loadFixture(client, harnessId)),
    settlement,
    used_real_settlement_fn: applyEvent === applyBillingProviderEvent,
  });
};

export const handleCollectionV2Uat = async (event, deps = {}) => {
  const env = Object.hasOwn(deps, 'env') ? deps.env : process.env.CHECKSOPS_ENV;
  const envGate = assertStagingOnly(env);
  if (envGate) return envGate;

  const identity = deps.withIdentityWrite || withIdentityWrite;
  return identity(event, async ({ client, mapping, body, spoof }) => {
    const result = await runCollectionV2Uat({
      client,
      mapping,
      body,
      applyEvent: deps.applyBillingProviderEvent || applyBillingProviderEvent,
      randomId: deps.randomUUID || randomUUID,
    });
    return { ...result, spoofFieldsIgnored: spoof };
  }, deps);
};

export const handleCollectionV2UatRequest = async (event, path, method, deps = {}) => {
  if (method !== 'POST' || path !== '/uat/collection-v2') return null;
  return handleCollectionV2Uat(event, deps);
};
