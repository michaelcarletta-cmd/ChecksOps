/**
 * Read-only fetch helpers for tenant Payments accuracy.
 * Never writes financial state. Incoming rows come from get_tenant_funds_received
 * (same split id as the payer), not a copied Tenant B transaction.
 */

import { listRecipientOverlays } from "./paymentAccounting";
import {
  buildTenantPaymentLedgerRows,
  type LedgerPaymentRow,
  type TenantPaymentSources,
} from "./tenantPaymentAccuracy";

const OUTGOING_SPLIT_SELECT = `
  id, amount, status, submitted_at, settled_at, returned_at,
  return_code, return_desc, actum_order_id, created_at,
  method, recipient_name, recipient_type, recipient_tenant_id,
  external_check_number, moov_transfer_id, plaid_transfer_id,
  stakeholder_accounts (
    id, nickname, custname, account_type, chk_acct, tenant_id
  ),
  disbursement_batches (
    id, check_amount, check_intake_item_id,
    check_intake_items:check_intake_item_id (
      check_number, carrier_name, amount,
      claim_id
    )
  )
`;

const PAYER_TRANSFER_SELECT = `
  id, tenant_id, destination_tenant_id, amount_cents, status, provider_status,
  created_at, submitted_at, completed_at, description, provider_transfer_id,
  leg_role, is_facilitator_fee, selected_rail, provider, check_id, claim_id
`;

type QueryClient = {
  from: (table: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
  functions?: {
    invoke: (
      name: string,
      options: { body?: Record<string, unknown> },
    ) => Promise<{ data: unknown; error: { message?: string } | null }>;
  };
};

async function readOutgoingSplits(client: QueryClient, tenantId: string): Promise<unknown[]> {
  const { data, error } = await client
    .from("disbursement_splits")
    .select(OUTGOING_SPLIT_SELECT)
    .eq("tenant_id", tenantId)
    .neq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

async function readIncomingFundsReceived(client: QueryClient, tenantId: string): Promise<unknown[]> {
  const { data, error } = await client.rpc("get_tenant_funds_received", {
    _tenant_id: tenantId,
  });
  if (error) return [];
  return Array.isArray(data) ? data : [];
}

async function readPayerTransfers(client: QueryClient, tenantId: string): Promise<unknown[]> {
  const { data, error } = await client
    .from("payment_transfers")
    .select(PAYER_TRANSFER_SELECT)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) return [];
  return data ?? [];
}

async function readRecipientOverlays(client: QueryClient, tenantId: string): Promise<unknown[]> {
  if (!client.functions?.invoke) return [];
  try {
    const payload = await listRecipientOverlays(client, { tenantId });
    return Array.isArray(payload.overlays) ? payload.overlays : [];
  } catch {
    return [];
  }
}

export async function fetchTenantPaymentSources(
  client: QueryClient,
  tenantId: string,
): Promise<TenantPaymentSources> {
  const [outgoingSplits, incomingReceived, payerTransfers, recipientOverlays] = await Promise.all([
    readOutgoingSplits(client, tenantId),
    readIncomingFundsReceived(client, tenantId),
    readPayerTransfers(client, tenantId),
    readRecipientOverlays(client, tenantId),
  ]);
  return { outgoingSplits, incomingReceived, payerTransfers, recipientOverlays };
}

export async function fetchTenantPaymentLedgerRows(
  client: QueryClient,
  tenantId: string,
): Promise<LedgerPaymentRow[]> {
  const sources = await fetchTenantPaymentSources(client, tenantId);
  return buildTenantPaymentLedgerRows(sources, tenantId);
}
