/**
 * Partner/recipient-safe Funds Received helpers.
 *
 * Authorization stays in get_tenant_funds_received. These helpers only
 * preserve the RPC array and associate authorized rows with one check.
 * They never add rows the RPC did not return.
 */

export type FundsReceivedRpcRow = {
  id: string;
  amount?: number | string | null;
  settled_at?: string | null;
  created_at?: string | null;
  recipient_name?: string | null;
  method?: string | null;
  external_check_number?: string | null;
  sender_name?: string | null;
  check_intake_item_id?: string | null;
  tenant_id?: string | null;
  check_number?: string | null;
  carrier_name?: string | null;
  property_address?: string | null;
  funds_type?: string | null;
  check_amount?: number | string | null;
  claim_id?: string | null;
  detected_claim_number?: string | null;
  payee_line?: string | null;
  claim_number?: string | null;
  policyholder_name?: string | null;
};

export function asFundsReceivedRows(data: unknown): FundsReceivedRpcRow[] {
  return Array.isArray(data) ? (data as FundsReceivedRpcRow[]) : [];
}

export function incomingSplitsForCheck(data: unknown, checkId: string) {
  return asFundsReceivedRows(data)
    .filter((row) => row.check_intake_item_id === checkId)
    .map((row) => ({
      id: row.id,
      amount: row.amount,
      status: "settled" as const,
      created_at: row.created_at,
      settled_at: row.settled_at,
      method: row.method,
      external_check_number: row.external_check_number,
      recipient_name: row.recipient_name,
      sender_name: row.sender_name,
    }));
}

export function mapLaneFundsReceived(data: unknown) {
  return asFundsReceivedRows(data).map((row) => ({
    id: row.id,
    amount: row.amount,
    settled_at: row.settled_at,
    created_at: row.created_at,
    recipient_name: row.recipient_name,
    method: row.method,
    external_check_number: row.external_check_number,
    tenant_id: row.tenant_id,
    sender: { name: row.sender_name },
    disbursement_batches: {
      check_intake_item_id: row.check_intake_item_id,
      check_intake_items: {
        id: row.check_intake_item_id,
        check_number: row.check_number,
        carrier_name: row.carrier_name,
        property_address: row.property_address,
        funds_type: row.funds_type,
        amount: row.check_amount,
        claim_id: row.claim_id,
        detected_claim_number: row.detected_claim_number,
        payee_line: row.payee_line,
        claims: {
          claim_number: row.claim_number,
          policyholder_name: row.policyholder_name,
        },
      },
    },
  }));
}
