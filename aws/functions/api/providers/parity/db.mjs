import { isPlatformAdmin } from './caller.mjs';

const SENSITIVE = /accountnumber|routingnumber|ssn|taxid|password|secret|token|accesstoken|cardnumber|cvv/i;

export const sanitize = (value) => {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE.test(k.replace(/[_-]/g, '')) ? '[redacted]' : sanitize(v);
    }
    return out;
  }
  return value;
};

export const loadMoovAccount = async (client, tenantId, environment = 'sandbox') => {
  const row = (await client.query(
    `SELECT * FROM public.payment_provider_accounts
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [tenantId, environment],
  )).rows[0] || null;
  return row;
};

export const logPaymentEvent = async (client, row) => {
  try {
    await client.query(
      `INSERT INTO public.payment_event_log
        (provider, environment, tenant_id, event_type, new_status, previous_status,
         transfer_id, provider_transfer_id, recipient_id, provider_metadata)
       VALUES ('moov', $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        row.environment || 'sandbox',
        row.tenant_id,
        row.event_type,
        row.new_status || null,
        row.previous_status || null,
        row.transfer_id || null,
        row.provider_transfer_id || null,
        row.recipient_id || null,
        JSON.stringify(sanitize(row.provider_metadata || {})),
      ],
    );
  } catch { /* event log must not fail the provider call */ }
};

export const membershipRole = (memberships, tenantId) =>
  String(memberships.find((m) => m.tenant_id === tenantId)?.role ?? '');

export const canSendPayments = async (client, userId, tenantId, memberships) => {
  if (await isPlatformAdmin(client, userId)) return true;
  return ['owner', 'admin', 'manager'].includes(membershipRole(memberships, tenantId));
};

export const loadConnectedMethod = async (client, { tenantId, providerAccountId, externalRecipientId = null }) => {
  if (externalRecipientId) {
    return (await client.query(
      `SELECT * FROM public.payment_provider_methods
       WHERE external_recipient_id = $1::uuid AND connection_status = 'connected'
       LIMIT 1`,
      [externalRecipientId],
    )).rows[0] || null;
  }
  return (await client.query(
    `SELECT * FROM public.payment_provider_methods
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = 'sandbox'
       AND provider_account_id = $2 AND connection_status = 'connected'
     ORDER BY is_default DESC NULLS LAST, created_at DESC NULLS LAST
     LIMIT 1`,
    [tenantId, providerAccountId],
  )).rows[0] || null;
};

export const insertTransferDraft = async (client, row) => {
  const saved = (await client.query(
    `INSERT INTO public.payment_transfers
      (tenant_id, provider, environment, status, idempotency_key, amount_cents,
       platform_fee_cents, net_amount_cents, speed, requested_speed, selected_rail,
       rail_downgrade_reason, description, source_tenant_account_id, source_payment_method_id,
       destination_tenant_id, destination_recipient_id, destination_payment_method_id,
       claim_id, check_id, wallet_id, leg_role, created_by)
     VALUES ($1::uuid, 'moov', 'sandbox', 'ready', $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::uuid)
     RETURNING *`,
    [
      row.tenant_id, row.idempotency_key, row.amount_cents,
      row.platform_fee_cents ?? 0, row.net_amount_cents ?? row.amount_cents,
      row.speed ?? 'standard', row.requested_speed ?? null, row.selected_rail ?? null,
      row.rail_downgrade_reason ?? null, row.description ?? null,
      row.source_tenant_account_id ?? null, row.source_payment_method_id ?? null,
      row.destination_tenant_id ?? null, row.destination_recipient_id ?? null,
      row.destination_payment_method_id ?? null, row.claim_id ?? null, row.check_id ?? null,
      row.wallet_id ?? null, row.leg_role ?? null, row.created_by ?? null,
    ],
  )).rows[0];
  return saved;
};

export const updateTransferAfterMoov = async (client, id, patch) => {
  const saved = (await client.query(
    `UPDATE public.payment_transfers SET
       provider_transfer_id = $2, provider_status = $3, status = $4,
       provider_fee_cents = $5, submitted_at = now(), provider_metadata = $6::jsonb,
       failure_reason = $7
     WHERE id = $1::uuid
     RETURNING *`,
    [
      id, patch.provider_transfer_id ?? null, patch.provider_status ?? null,
      patch.status, patch.provider_fee_cents ?? null,
      JSON.stringify(patch.provider_metadata || {}), patch.failure_reason ?? null,
    ],
  )).rows[0];
  return saved;
};

export const existingTransferByKey = async (client, tenantId, key) => {
  return (await client.query(
    `SELECT * FROM public.payment_transfers
     WHERE tenant_id = $1::uuid AND idempotency_key = $2 LIMIT 1`,
    [tenantId, key],
  )).rows[0] || null;
};

export const secureToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};
