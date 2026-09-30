/**
 * Production oneshot: recover ONE existing Freedom $5 Moov transfer into
 * payment_transfers via reconcileWalletFundingTransfer.
 *
 * Does not POST/PATCH/PUT/DELETE Moov.
 * Does not modify billing, wallets, banks, or any other transfer row.
 * Does not update checksops-production-prep-api or any SPA.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  '/var/task/rds-global-bundle.pem',
].find((p) => fs.existsSync(p));

const FIVE = '9f9df312-32a9-4999-ace9-fc2b00669c75';
const ONE_THIRTY_NINE = 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb';
const ONE_THIRTY_NINE_LOCAL = 'ab2895c9-2ba8-4c21-a818-7f83abdb068c';
const BILLING = '72b622f9-b68f-4032-a971-a854dbcfbf57';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SOURCE_ACCOUNT = '60922058-7eca-4889-81dd-5720d7b9de96';
const LOCAL_BANK = '8eb5b26e-6f66-435c-a578-880fb7fc14dd';
const BANK_PM = 'a02c1c81-9ca6-434d-accc-ea4471a70ef2';
const WALLET_PM = '744ea734-f5e3-4b31-bb92-38f85fd29b91';
const IDEMPOTENCY_KEY = `wallet-funding-recover:${FIVE}`;
const WALLET_FUNDING_LEG_ROLE = 'wallet_funding';
const CREATED_ON = '2026-09-29T15:44:36Z';

export function normalizeWalletFundingStatus(providerStatus) {
  switch (String(providerStatus ?? '').toLowerCase()) {
    case 'created':
    case 'queued':
      return 'submitted';
    case 'pending':
      return 'pending';
    case 'reversed':
      return 'returned';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return 'processing';
  }
}

export function buildWalletFundingRecoveryRow(input) {
  const amount = Math.max(0, Math.round(Number(input.amountCents || 0)));
  const status = normalizeWalletFundingStatus(input.providerStatus);
  return {
    tenant_id: input.tenantId,
    provider: 'moov',
    environment: input.environment,
    status,
    provider_status: String(input.providerStatus || status),
    amount_cents: amount,
    platform_fee_cents: 0,
    net_amount_cents: amount,
    speed: 'standard',
    description: String(input.description || 'Balance funding'),
    source_tenant_account_id: input.sourceAccountId || null,
    source_payment_method_id: input.localSourcePaymentMethodId || null,
    destination_payment_method_id: null,
    wallet_id: input.walletId || null,
    leg_role: WALLET_FUNDING_LEG_ROLE,
    provider_transfer_id: input.providerTransferId,
    provider_metadata: {
      source_payment_method_id: input.sourcePaymentMethodId || null,
      destination_payment_method_id: input.destinationPaymentMethodId || null,
      checksops_kind: 'wallet_funding',
    },
    created_by: input.createdBy || null,
  };
}

const STATUS_RECONCILE_FIELDS = [
  'status',
  'provider_status',
  'provider_metadata',
  'description',
  'amount_cents',
  'net_amount_cents',
];

export function reconcileWalletFundingTransfer(store, input) {
  const providerTransferId = String(input.providerTransferId || '').trim();
  if (!providerTransferId) throw new Error('provider_transfer_id is required');
  if (!input.tenantId) throw new Error('tenant_id is required');
  if (Number(input.amountCents) <= 0) throw new Error('amount_cents must be greater than zero');

  const next = buildWalletFundingRecoveryRow({ ...input, providerTransferId });
  const existing = store.findByProviderTransferId(providerTransferId);
  if (existing) {
    if (existing.tenant_id !== input.tenantId) {
      throw new Error('provider_transfer_id belongs to another organization');
    }
    const patch = {};
    for (const field of STATUS_RECONCILE_FIELDS) patch[field] = next[field];
    return { action: 'update', row: store.update(existing.id, patch) };
  }
  return { action: 'insert', row: store.insert(next) };
}

export function createMemoryWalletFundingStore(seed = []) {
  const rows = [...seed];
  return {
    rows,
    findByProviderTransferId(providerTransferId) {
      return rows.find((row) => row.provider_transfer_id === providerTransferId) || null;
    },
    insert(row) {
      const saved = { ...row, id: row.id || `pending-insert` };
      rows.push(saved);
      return saved;
    },
    update(id, patch) {
      const idx = rows.findIndex((row) => row.id === id);
      if (idx < 0) throw new Error('missing row');
      rows[idx] = { ...rows[idx], ...patch };
      return rows[idx];
    },
  };
}

async function persistReconcile(client, reconciled) {
  if (reconciled.action === 'insert') {
    const row = reconciled.row;
    const { rows } = await client.query(
      `INSERT INTO public.payment_transfers (
         tenant_id, provider, environment, status, provider_status,
         idempotency_key, amount_cents, platform_fee_cents, net_amount_cents,
         currency, speed, description, source_tenant_account_id,
         source_payment_method_id, destination_payment_method_id, wallet_id,
         leg_role, provider_transfer_id, provider_metadata, created_by,
         submitted_at, created_at
       ) VALUES (
         $1,$2,$3,$4,$5,
         $6,$7,$8,$9,
         'USD',$10,$11,$12,
         $13::uuid,NULL,$14::uuid,
         $15,$16,$17::jsonb,NULL,
         $18::timestamptz,$19::timestamptz
       )
       RETURNING *`,
      [
        row.tenant_id,
        row.provider,
        row.environment,
        row.status,
        row.provider_status,
        IDEMPOTENCY_KEY,
        row.amount_cents,
        row.platform_fee_cents,
        row.net_amount_cents,
        row.speed,
        row.description,
        row.source_tenant_account_id,
        row.source_payment_method_id,
        row.wallet_id,
        row.leg_role,
        row.provider_transfer_id,
        JSON.stringify(row.provider_metadata),
        CREATED_ON,
        CREATED_ON,
      ],
    );
    return rows[0];
  }
  const row = reconciled.row;
  const { rows } = await client.query(
    `UPDATE public.payment_transfers
        SET status = $3,
            provider_status = $4,
            provider_metadata = $5::jsonb,
            description = $6,
            amount_cents = $7,
            net_amount_cents = $8,
            updated_at = now()
      WHERE id = $1::uuid
        AND provider_transfer_id = $2
      RETURNING *`,
    [
      row.id,
      FIVE,
      row.status,
      row.provider_status,
      JSON.stringify(row.provider_metadata),
      row.description,
      row.amount_cents,
      row.net_amount_cents,
    ],
  );
  if (rows.length !== 1) throw new Error(`expected one updated row, got ${rows.length}`);
  return rows[0];
}

async function connect() {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be production checksops_admin');
  if (!/checksops-production/i.test(arn)) throw new Error('refusing non-production admin secret');
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) throw new Error('secret username is not checksops_admin');
  const host = parsed.host && parsed.host !== 'localhost' && parsed.host !== '127.0.0.1'
    ? parsed.host
    : process.env.RDS_HOST;
  if (!host || !/checksops-production/i.test(host)) throw new Error(`refusing host ${host}`);
  const database = process.env.DATABASE_NAME || 'checksops';
  if (database !== 'checksops') throw new Error(`refusing database ${database}`);
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database,
    ssl: CA_PATH ? { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') } : { rejectUnauthorized: true },
    connectionTimeoutMillis: 8000,
    query_timeout: 30000,
  });
  await client.connect();
  const identity = await client.query(`SELECT current_database() AS d, current_user AS u, inet_server_addr()::text AS host`);
  if (identity.rows[0].d !== 'checksops') {
    await client.end();
    throw new Error(`connected to ${identity.rows[0].d}`);
  }
  return { client, identity: identity.rows[0] };
}

async function snapshot(client) {
  const five = await client.query(
    `SELECT id, tenant_id, environment, status, provider_status, amount_cents, net_amount_cents,
            description, leg_role, provider_transfer_id, source_tenant_account_id,
            source_payment_method_id, destination_payment_method_id, wallet_id,
            idempotency_key, provider_metadata, created_at, updated_at, submitted_at
       FROM public.payment_transfers
      WHERE provider_transfer_id = $1`,
    [FIVE],
  );
  const candidates = await client.query(
    `SELECT id, tenant_id, environment, status, amount_cents, description, leg_role,
            provider_transfer_id, source_payment_method_id, destination_payment_method_id,
            wallet_id, idempotency_key, created_at
       FROM public.payment_transfers
      WHERE tenant_id = $1
        AND environment = 'production'
        AND (
          provider_transfer_id = $2
          OR idempotency_key = $3
          OR (
            amount_cents = 500
            AND (
              COALESCE(leg_role, '') = 'wallet_funding'
              OR COALESCE(description, '') ILIKE '%balance funding%'
              OR source_payment_method_id = $4::uuid
              OR provider_metadata->>'source_payment_method_id' = $5
              OR provider_metadata->>'destination_payment_method_id' = $6
            )
          )
        )
      ORDER BY created_at`,
    [FREEDOM, FIVE, IDEMPOTENCY_KEY, LOCAL_BANK, BANK_PM, WALLET_PM],
  );
  const oneThirtyNine = await client.query(
    `SELECT id, tenant_id, environment, status, amount_cents, provider_transfer_id,
            updated_at, created_at, md5(row(t.*)::text) AS row_md5
       FROM public.payment_transfers t
      WHERE id = $1::uuid OR provider_transfer_id = $2`,
    [ONE_THIRTY_NINE_LOCAL, ONE_THIRTY_NINE],
  );
  const otherTransfers = await client.query(
    `SELECT count(*)::int AS count,
            md5(string_agg(id::text || '|' || coalesce(updated_at::text,'') || '|' || coalesce(status,'') || '|' || coalesce(provider_transfer_id,''), ',' ORDER BY id)) AS hash
       FROM public.payment_transfers
      WHERE provider_transfer_id IS DISTINCT FROM $1`,
    [FIVE],
  );
  const billing = await client.query(
    `SELECT id, tenant_id, amount_cents, status, provider_transfer_id, updated_at,
            md5(row(t.*)::text) AS row_md5
       FROM public.tenant_maintenance_payments t
      WHERE id = $1::uuid`,
    [BILLING],
  );
  const wallets = await client.query(
    `SELECT id, tenant_id, environment, wallet_type, status, available_cents, pending_cents,
            provider_wallet_id, provider_payment_method_id, updated_at,
            md5(row(t.*)::text) AS row_md5
       FROM public.payment_wallets t
      WHERE tenant_id = $1
      ORDER BY environment, wallet_type`,
    [FREEDOM],
  );
  const banks = await client.query(
    `SELECT id, tenant_id, environment, last_four, bank_name, verification_status,
            connection_status, rail_payment_method_ids, updated_at,
            md5(row(t.*)::text) AS row_md5
       FROM public.payment_provider_methods t
      WHERE id = $1::uuid OR tenant_id = $2
      ORDER BY id`,
    [LOCAL_BANK, FREEDOM],
  );
  const totals = await client.query(`
    SELECT
      (SELECT count(*)::int FROM public.payment_transfers) AS payment_transfers,
      (SELECT count(*)::int FROM public.payment_transfers WHERE environment = 'production') AS production_transfers,
      (SELECT count(*)::int FROM public.payment_transfers WHERE provider_transfer_id = $1) AS five_rows,
      (SELECT count(*)::int FROM public.payment_wallets WHERE tenant_id = $2) AS wallets,
      (SELECT count(*)::int FROM public.payment_provider_methods WHERE tenant_id = $2) AS methods,
      (SELECT count(*)::int FROM public.tenant_maintenance_payments WHERE id = $3::uuid) AS billing
  `, [FIVE, FREEDOM, BILLING]);
  return {
    five: five.rows,
    five_count: five.rows.length,
    candidates: candidates.rows,
    one_thirty_nine: oneThirtyNine.rows,
    other_transfers: otherTransfers.rows[0],
    billing: billing.rows,
    wallets: wallets.rows,
    banks: banks.rows,
    totals: totals.rows[0],
  };
}

function classifyCandidates(snap) {
  const exact = snap.candidates.filter((row) => row.provider_transfer_id === FIVE);
  const withoutProvider = snap.candidates.filter((row) => row.provider_transfer_id !== FIVE);
  if (exact.length > 1) {
    return { verdict: 'AMBIGUOUS', reason: 'multiple rows share provider_transfer_id' };
  }
  if (withoutProvider.length > 0 && exact.length === 0) {
    return { verdict: 'AMBIGUOUS', reason: 'candidate without provider_transfer_id' };
  }
  if (withoutProvider.length > 0 && exact.length === 1) {
    return { verdict: 'AMBIGUOUS', reason: 'exact row plus extra candidate' };
  }
  return {
    verdict: exact.length === 1 ? 'EXISTING_EXACT' : 'ABSENT',
    reason: exact.length === 1 ? 'one exact provider_transfer_id row' : 'no local representation',
  };
}

function recoveryInput(providerStatus, walletId) {
  return {
    tenantId: FREEDOM,
    environment: 'production',
    amountCents: 500,
    providerTransferId: FIVE,
    providerStatus,
    description: 'Balance funding',
    sourceAccountId: SOURCE_ACCOUNT,
    localSourcePaymentMethodId: LOCAL_BANK,
    sourcePaymentMethodId: BANK_PM,
    destinationPaymentMethodId: WALLET_PM,
    walletId: walletId || null,
  };
}

export async function handler(event = {}) {
  const mode = String(event.mode || 'preflight');
  const providerStatus = String(event.providerStatus || '').trim();
  if (event.providerTransferId && event.providerTransferId !== FIVE) {
    return { ok: false, error: 'refusing unexpected provider_transfer_id', got: event.providerTransferId };
  }
  if (mode === 'apply' && !providerStatus) {
    return { ok: false, error: 'apply requires current providerStatus from a fresh GET' };
  }

  const { client, identity } = await connect();
  const result = {
    ok: true,
    function: 'checksops-prod-wallet-fund-recover-2d41',
    helper: 'reconcileWalletFundingTransfer',
    mode,
    identity,
    mutated: false,
    provider_financial_writes: 0,
  };
  try {
    const pre = await snapshot(client);
    result.pre = {
      five_count: pre.five_count,
      five: pre.five,
      candidates: pre.candidates,
      candidate_class: classifyCandidates(pre),
      one_thirty_nine: pre.one_thirty_nine,
      other_transfers: pre.other_transfers,
      billing: pre.billing,
      wallets: pre.wallets.map((row) => ({
        id: row.id,
        environment: row.environment,
        wallet_type: row.wallet_type,
        available_cents: row.available_cents,
        pending_cents: row.pending_cents,
        provider_wallet_id: row.provider_wallet_id,
        provider_payment_method_id: row.provider_payment_method_id,
        row_md5: row.row_md5,
        updated_at: row.updated_at,
      })),
      banks: pre.banks.map((row) => ({
        id: row.id,
        last_four: row.last_four,
        verification_status: row.verification_status,
        row_md5: row.row_md5,
        updated_at: row.updated_at,
      })),
      totals: pre.totals,
    };

    const classed = classifyCandidates(pre);
    if (classed.verdict === 'AMBIGUOUS') {
      result.ok = false;
      result.verdict = 'WALLET FUNDING RECOVERY — AMBIGUOUS LOCAL MATCH';
      result.reason = classed.reason;
      return result;
    }

    const prodWallet = pre.wallets.filter((row) => row.environment === 'production' && row.wallet_type === 'operating');
    const walletId = prodWallet.length === 1 ? prodWallet[0].id : null;
    const input = recoveryInput(providerStatus || 'pending', walletId);
    const payload = buildWalletFundingRecoveryRow(input);
    result.payload = payload;
    result.wallet_id_resolved = walletId;

    if (mode !== 'apply') {
      result.verdict = 'PREFLIGHT_ONLY';
      result.would_action = classed.verdict === 'EXISTING_EXACT' ? 'update' : 'insert';
      return result;
    }

    if (Number(payload.amount_cents) !== 500) throw new Error('payload amount mismatch');
    if (payload.provider_transfer_id !== FIVE) throw new Error('payload provider id mismatch');
    if (payload.provider_metadata.source_payment_method_id !== BANK_PM) throw new Error('payload source mismatch');
    if (payload.provider_metadata.destination_payment_method_id !== WALLET_PM) throw new Error('payload dest mismatch');

    const existingRows = await client.query(
      `SELECT * FROM public.payment_transfers WHERE provider_transfer_id = $1`,
      [FIVE],
    );
    if (existingRows.rows.length > 1) {
      result.ok = false;
      result.verdict = 'WALLET FUNDING RECOVERY — AMBIGUOUS LOCAL MATCH';
      result.reason = 'multiple exact provider_transfer_id rows';
      return result;
    }
    const store = createMemoryWalletFundingStore(existingRows.rows);
    const reconciled = reconcileWalletFundingTransfer(store, input);
    await client.query('BEGIN');
    const persisted = await persistReconcile(client, reconciled);
    await client.query('COMMIT');
    result.mutated = true;
    result.action = reconciled.action;
    result.row = persisted;

    const post = await snapshot(client);
    result.post = {
      five_count: post.five_count,
      five: post.five,
      candidates: post.candidates,
      one_thirty_nine: post.one_thirty_nine,
      other_transfers: post.other_transfers,
      billing: post.billing,
      wallets: post.wallets.map((row) => ({ id: row.id, row_md5: row.row_md5, available_cents: row.available_cents, updated_at: row.updated_at })),
      banks: post.banks.map((row) => ({ id: row.id, row_md5: row.row_md5, updated_at: row.updated_at })),
      totals: post.totals,
    };
    result.proof = {
      five_row_count_is_one: post.five_count === 1,
      one_thirty_nine_untouched: JSON.stringify(pre.one_thirty_nine) === JSON.stringify(post.one_thirty_nine),
      other_transfers_untouched: JSON.stringify(pre.other_transfers) === JSON.stringify(post.other_transfers),
      billing_untouched: JSON.stringify(pre.billing) === JSON.stringify(post.billing),
      wallets_untouched: pre.wallets.map((r) => r.row_md5).join() === post.wallets.map((r) => r.row_md5).join(),
      banks_untouched: pre.banks.map((r) => r.row_md5).join() === post.banks.map((r) => r.row_md5).join(),
    };
    result.verdict = post.five_count === 1 ? 'LOCAL_RECOVERY_APPLIED' : 'ROW_COUNT_UNEXPECTED';
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ok */ }
    return {
      ok: false,
      mode,
      error: error.message,
      verdict: error.code === 'AMBIGUOUS' ? 'WALLET FUNDING RECOVERY — AMBIGUOUS LOCAL MATCH' : 'FAILED',
      rows: error.rows || null,
    };
  } finally {
    await client.end();
  }
}
