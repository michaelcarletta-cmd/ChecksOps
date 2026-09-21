/**
 * Staging-safe port of supabase/functions/moov-webhook handleEvent.
 * Applies ONLY to environment='sandbox' rows (and CheckAlt isolated sandbox ops).
 * Production-environment payment_* / checkalt_* rows are never updated here.
 */
import { normalizeTransferStatus } from './parity/moov-client.mjs';
import { postTransferLedger } from './parity/moov-wallet.mjs';
import { sanitize } from './parity/db.mjs';
import { centsFromMoovAmount } from './moov-lifecycle.mjs';
import { providerSandboxExecutionEnabled } from '../sandbox-flags.mjs';
import { financialPermissionsActivated } from '../financial-flags.mjs';
import { providerExecutionEnabled } from '../provider-flags.mjs';

const FUNDING_TERMINAL = ['completed', 'failed', 'returned', 'canceled'];

export const sandboxWebhookApplyEnabled = () => (
  providerSandboxExecutionEnabled()
  && !financialPermissionsActivated()
  && !providerExecutionEnabled()
);

export const eventTypeToStatus = (eventType) => {
  const t = String(eventType || '');
  if (t.includes('completed')) return 'completed';
  if (t.includes('failed')) return 'failed';
  if (t.includes('reversed') || t.includes('returned')) return 'returned';
  if (t.includes('canceled') || t.includes('cancelled')) return 'canceled';
  return 'pending';
};

const dataOf = (payload) => payload?.data ?? payload;

export async function applyMoovWebhook(client, payload, { mappedTenantId = null } = {}) {
  const eventType = String(payload?.type ?? payload?.eventType ?? 'unknown');
  const providerAccountId = payload?.accountID ?? payload?.data?.accountID ?? payload?.accountId ?? null;
  const data = dataOf(payload);
  const mutations = [];

  await client.query("SELECT set_config('request.provider_webhook_apply', '1', true)");
  await client.query("SELECT set_config('request.aws_financial_permissions_activated', '0', true)");

  let tenantId = mappedTenantId;
  let sandboxAccount = null;
  if (providerAccountId) {
    sandboxAccount = (await client.query(
      `SELECT id, tenant_id, environment, onboarding_status
       FROM public.payment_provider_accounts
       WHERE provider = 'moov' AND provider_account_id = $1 AND environment = 'sandbox'
       LIMIT 1`,
      [String(providerAccountId)],
    )).rows[0];
    if (!sandboxAccount) {
      const prod = (await client.query(
        `SELECT id, environment FROM public.payment_provider_accounts
         WHERE provider = 'moov' AND provider_account_id = $1 AND environment = 'production'
         LIMIT 1`,
        [String(providerAccountId)],
      )).rows[0];
      if (prod) {
        return {
          applied: false,
          skipped: 'production_environment_row',
          financialTablesMutated: false,
          mutations,
        };
      }
    } else {
      tenantId = sandboxAccount.tenant_id;
      if (
        eventType.startsWith('account')
        || eventType.startsWith('capability')
        || eventType.startsWith('bankAccount')
        || eventType.includes('verification')
      ) {
        await client.query(
          `UPDATE public.payment_provider_accounts
           SET last_webhook_event_at = now(), last_webhook_event_type = $2
           WHERE id = $1::uuid AND environment = 'sandbox'`,
          [sandboxAccount.id, eventType],
        );
        mutations.push('payment_provider_accounts');
      }
    }
  }

  if (
    eventType.startsWith('account')
    || eventType.startsWith('capability')
    || eventType.startsWith('bankAccount')
    || eventType.includes('verification')
    || eventType.includes('representative')
  ) {
    if (eventType.startsWith('bankAccount') && data?.bankAccountID) {
      const status = String(data.status ?? 'pending').toLowerCase();
      const method = (await client.query(
        `UPDATE public.payment_provider_methods
         SET verification_status = $2,
             connection_status = $3
         WHERE provider_bank_account_id = $1 AND environment = 'sandbox'
         RETURNING id`,
        [
          data.bankAccountID,
          status,
          status === 'verified' ? 'connected' : (status === 'errored' ? 'failed' : 'pending'),
        ],
      )).rows[0];
      if (method) mutations.push('payment_provider_methods');
      if (providerAccountId) {
        await client.query(
          `UPDATE public.external_payment_recipients
           SET onboarding_status = $2
           WHERE provider_account_id = $1 AND environment = 'sandbox'`,
          [providerAccountId, status === 'verified' ? 'ready' : 'awaiting_bank'],
        );
        mutations.push('external_payment_recipients');
        await client.query(
          `UPDATE public.stakeholder_accounts sa
           SET provider_bank_account_id = $2,
               provider_bank_name = $3,
               provider_last_four = $4,
               verification_status = $5,
               verified_at = CASE WHEN $5 = 'verified' THEN now() ELSE sa.verified_at END
           FROM public.payment_provider_accounts ppa
           WHERE sa.provider_account_id = $1
             AND sa.provider = 'moov'
             AND ppa.provider_account_id = sa.provider_account_id
             AND ppa.provider = 'moov'
             AND ppa.environment = 'sandbox'`,
          [
            providerAccountId,
            data.bankAccountID,
            data.bankName ?? data.bankAccount?.bankName ?? null,
            data.lastFourAccountNumber ?? data.bankAccount?.lastFourAccountNumber ?? null,
            status === 'verified' ? 'verified' : 'pending',
          ],
        );
        mutations.push('stakeholder_accounts');
      }
    }
    await client.query(
      `INSERT INTO public.payment_event_log
        (provider, environment, tenant_id, event_type, new_status, provider_metadata)
       VALUES ('moov', 'sandbox', $1::uuid, $2, $3, $4::jsonb)`,
      [tenantId, eventType, data?.status ?? null, JSON.stringify(sanitize({
        account_id: providerAccountId,
        resource: data?.bankAccountID ?? null,
      }))],
    ).catch(() => {});
    mutations.push('payment_event_log');
    return { applied: true, environment: 'sandbox', financialTablesMutated: mutations.length > 0, mutations };
  }

  const walletId = data?.walletID ?? data?.walletId ?? null;
  const availableCents = centsFromMoovAmount(data?.availableBalance ?? data?.available);
  const pendingCents = centsFromMoovAmount(data?.pendingBalance ?? data?.pending);
  if (walletId && (availableCents != null || pendingCents != null)) {
    const wallet = (await client.query(
      `UPDATE public.payment_wallets
          SET available_cents = COALESCE($2, available_cents),
              pending_cents = COALESCE($3, pending_cents),
              last_synced_at = now()
        WHERE provider = 'moov'
          AND provider_wallet_id = $1
          AND environment = 'sandbox'
        RETURNING id, environment, available_cents, pending_cents`,
      [String(walletId), availableCents, pendingCents],
    )).rows[0];
    if (wallet) mutations.push('payment_wallets');
  }

  const transferId = data?.transferID ?? data?.transferId ?? null;
  const disputeId = data?.disputeID ?? data?.disputeId ?? null;
  if (!transferId && !disputeId) {
    return { applied: true, environment: 'sandbox', financialTablesMutated: mutations.length > 0, mutations };
  }

  if (disputeId) {
    await client.query(
      `INSERT INTO public.payment_event_log
        (provider, environment, tenant_id, event_type, provider_metadata)
       VALUES ('moov', 'sandbox', $1::uuid, $2, $3::jsonb)`,
      [tenantId, eventType, JSON.stringify(sanitize({
        dispute_id: disputeId, transfer_id: transferId, amount: data?.amount, phase: data?.phase, status: data?.status,
      }))],
    ).catch(() => {});
    if (transferId) {
      await client.query(
        `UPDATE public.payment_transfers
         SET failure_reason = $2
         WHERE provider_transfer_id = $1 AND environment = 'sandbox'`,
        [transferId, `Dispute ${disputeId}: ${data?.phase || eventType}`],
      );
      mutations.push('payment_transfers');
    }
    return { applied: true, environment: 'sandbox', financialTablesMutated: true, mutations };
  }

  const transfer = (await client.query(
    `SELECT id, tenant_id, status, destination_recipient_id, amount_cents, wallet_id, leg_role,
            transfer_group_id, claim_id, check_id, description
     FROM public.payment_transfers
     WHERE provider_transfer_id = $1 AND environment = 'sandbox'
     LIMIT 1`,
    [transferId],
  )).rows[0];

  const providerStatus = data?.status ?? eventTypeToStatus(eventType);
  const newStatus = normalizeTransferStatus(providerStatus);

  if (!transfer) {
    await client.query(
      `INSERT INTO public.payment_event_log
        (provider, environment, tenant_id, provider_transfer_id, event_type, new_status, provider_metadata)
       VALUES ('moov', 'sandbox', $1::uuid, $2, $3, $4, $5::jsonb)`,
      [tenantId, transferId, eventType, newStatus, JSON.stringify(sanitize({ provider_status: providerStatus }))],
    ).catch(() => {});
    return { applied: true, environment: 'sandbox', financialTablesMutated: false, mutations, note: 'unknown_sandbox_transfer' };
  }

  const previous = transfer.status;
  const completedAt = newStatus === 'completed'
    ? (data?.completedOn || data?.completedAt || data?.source?.achDetails?.completedOn || null)
    : null;
  const failureReason = (newStatus === 'failed' || newStatus === 'returned')
    ? (data?.failureReason ?? data?.reason ?? eventType)
    : null;
  await client.query(
    `UPDATE public.payment_transfers
     SET status = $2,
         provider_status = $3,
         completed_at = COALESCE($4::timestamptz, completed_at),
         failure_reason = CASE
           WHEN $2 = 'completed' THEN NULL
           WHEN $5 IS NOT NULL THEN $5
           ELSE failure_reason
         END
     WHERE id = $1::uuid AND environment = 'sandbox'`,
    [transfer.id, newStatus, providerStatus, completedAt, failureReason],
  );
  mutations.push('payment_transfers');
  await postTransferLedger(client, transfer, newStatus, transferId);

  if (transfer.transfer_group_id) {
    const legs = (await client.query(
      `SELECT status, leg_role FROM public.payment_transfers
       WHERE transfer_group_id = $1::uuid AND environment = 'sandbox'`,
      [transfer.transfer_group_id],
    )).rows;
    const children = legs.filter((l) => l.leg_role !== 'parent');
    const failed = children.filter((l) => ['failed', 'returned', 'canceled', 'cancelled'].includes(l.status)).length;
    const done = children.filter((l) => l.status === 'completed').length;
    const groupStatus = children.length === 0
      ? 'submitted'
      : done === children.length
        ? 'completed'
        : failed === children.length
          ? 'failed'
          : failed > 0
            ? 'partially_failed'
            : 'processing';
    await client.query(
      `UPDATE public.payment_transfer_groups
       SET status = $2, completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END
       WHERE id = $1::uuid`,
      [transfer.transfer_group_id, groupStatus],
    );
    mutations.push('payment_transfer_groups');
  }

  await syncFundingRequest(client, transferId, newStatus, failureReason);
  await client.query(
    `INSERT INTO public.payment_event_log
      (provider, environment, tenant_id, recipient_id, transfer_id, provider_transfer_id,
       event_type, previous_status, new_status, provider_metadata)
     VALUES ('moov', 'sandbox', $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb)`,
    [
      transfer.tenant_id, transfer.destination_recipient_id, transfer.id, transferId,
      eventType, previous, newStatus, JSON.stringify(sanitize({ provider_status: providerStatus })),
    ],
  ).catch(() => {});
  mutations.push('payment_event_log');
  return { applied: true, environment: 'sandbox', financialTablesMutated: true, mutations };
}

async function syncFundingRequest(client, providerTransferId, newStatus, failureReason) {
  const request = (await client.query(
    `SELECT wfr.id, wfr.tenant_id, wfr.status, wfr.related_payment_id
     FROM public.wallet_funding_requests wfr
     JOIN public.payment_transfers pt
       ON pt.provider_transfer_id = wfr.moov_transfer_id AND pt.environment = 'sandbox'
     WHERE wfr.moov_transfer_id = $1
     LIMIT 1`,
    [providerTransferId],
  )).rows[0];
  if (!request) return;
  if (FUNDING_TERMINAL.includes(String(request.status))) return;
  const map = {
    completed: 'completed', failed: 'failed', returned: 'returned',
    reversed: 'returned', canceled: 'canceled', cancelled: 'canceled',
  };
  const fundingStatus = map[newStatus] ?? 'pending';
  await client.query(
    `UPDATE public.wallet_funding_requests
     SET status = $2,
         failure_code = CASE WHEN $2 IN ('failed','returned') THEN $3 ELSE failure_code END,
         failure_reason = CASE WHEN $2 IN ('failed','returned') THEN $4 ELSE failure_reason END,
         funds_available_at = CASE WHEN $2 = 'completed' THEN now() ELSE funds_available_at END,
         completed_at = CASE WHEN $2 = ANY($5::text[]) THEN now() ELSE completed_at END
     WHERE id = $1::uuid`,
    [request.id, fundingStatus, newStatus, failureReason ?? null, FUNDING_TERMINAL],
  );
  if (['failed', 'returned'].includes(fundingStatus) && request.related_payment_id) {
    await client.query(
      `UPDATE public.disbursement_batches
       SET funding_status = $2, amount_reserved_cents = 0, auto_send_after_funding = false
       WHERE id = $1::uuid`,
      [request.related_payment_id, fundingStatus === 'returned' ? 'action_required' : 'funding_failed'],
    );
  }
}

export async function applyCheckAltWebhook(client, payload) {
  const reference = payload?.referenceNumber ?? payload?.checkalt_reference ?? payload?.reference ?? null;
  if (!reference) {
    return { applied: false, skipped: 'no_reference', financialTablesMutated: false };
  }
  await client.query("SELECT set_config('request.provider_webhook_apply', '1', true)");
  await client.query("SELECT set_config('request.aws_financial_permissions_activated', '0', true)");
  const op = (await client.query(
    `UPDATE public.aws_provider_sandbox_operations
     SET status = COALESCE($2, status),
         metadata = metadata || $3::jsonb,
         updated_at = now()
     WHERE provider = 'checkalt' AND provider_reference = $1
     RETURNING id, tenant_id, status`,
    [
      String(reference),
      payload?.status ? String(payload.status) : null,
      JSON.stringify({ last_webhook: { status: payload?.status ?? null, event: payload?.type ?? payload?.eventType ?? null } }),
    ],
  )).rows[0];
  if (!op) {
    return { applied: false, skipped: 'no_sandbox_operation', financialTablesMutated: false };
  }
  return {
    applied: true,
    environment: 'sandbox',
    financialTablesMutated: false,
    productionRecordsMutated: false,
    sandboxOperationId: op.id,
    mutations: ['aws_provider_sandbox_operations'],
  };
}
