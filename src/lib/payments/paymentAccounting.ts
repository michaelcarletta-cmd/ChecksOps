/**
 * Client for Class A tenant-payment-accounting.
 * Accounting display/type only. Never a generic financial-table write.
 */

export const PAYMENT_ACCOUNTING_FUNCTION = "tenant-payment-accounting";

export const PAYMENT_ACCOUNTING_QUERY_KEYS = [
  "payment-ledger",
  "recipient-report",
  "tax-summary",
  "revenue-summary-outgoing",
] as const;

export type PaymentAccountingClient = {
  functions: {
    invoke: (
      name: string,
      options: { body?: Record<string, unknown> },
    ) => Promise<{ data: unknown; error: { message?: string } | null }>;
  };
};

function invokeErrorMessage(error: { message?: string } | null, data: unknown): string {
  const payload = data && typeof data === "object"
    ? data as { error?: string; message?: string }
    : null;
  return String(payload?.message || payload?.error || error?.message || "request_failed");
}

export async function invokePaymentAccounting(
  client: PaymentAccountingClient,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.functions.invoke(PAYMENT_ACCOUNTING_FUNCTION, { body });
  const payload = data && typeof data === "object" ? data as Record<string, unknown> : null;
  if (error || payload?.ok === false) {
    throw new Error(invokeErrorMessage(error, data));
  }
  return payload ?? { ok: true };
}

export function updateRecipientDisplay(
  client: PaymentAccountingClient,
  input: {
    tenantId?: string | null;
    aggregateKey: string;
    displayName: string;
    displayType: string;
  },
) {
  return invokePaymentAccounting(client, {
    action: "update_recipient_display",
    tenant_id: input.tenantId || undefined,
    aggregate_key: input.aggregateKey,
    display_name: input.displayName,
    display_type: input.displayType,
  });
}

export function listRecipientOverlays(
  client: PaymentAccountingClient,
  input: { tenantId?: string | null },
) {
  return invokePaymentAccounting(client, {
    action: "list_recipient_overlays",
    tenant_id: input.tenantId || undefined,
  });
}

export function updateSplitType(
  client: PaymentAccountingClient,
  input: {
    tenantId?: string | null;
    splitId: string;
    displayType: string;
  },
) {
  return invokePaymentAccounting(client, {
    action: "update_split_type",
    tenant_id: input.tenantId || undefined,
    split_id: input.splitId,
    display_type: input.displayType,
  });
}
