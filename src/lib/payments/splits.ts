import { supabase } from "@/integrations/supabase/client";
import type { PaymentStatus } from "./types";

/**
 * Split settlements: one call pays every party on a claim — homeowner,
 * contractor, public adjuster, subcontractor — with the ChecksOps fee taken as
 * its own leg. The whole split is tracked and reconciled as one unit.
 */

export type SplitLegRole =
  | "homeowner"
  | "contractor"
  | "public_adjuster"
  | "subcontractor"
  | "vendor"
  | "attorney"
  | "mortgage"
  | "other";

export interface SplitLeg {
  role: SplitLegRole;
  amountCents: number;
  /** Set when the recipient is another organization on the platform. */
  recipientTenantId?: string | null;
  /** Set when the recipient is an outside payee. */
  externalRecipientId?: string | null;
  description?: string | null;
}

export interface SplitInput {
  tenantId: string;
  legs: SplitLeg[];
  /** ChecksOps fee, taken on the funding leg. */
  facilitatorFeeCents?: number;
  /** Pull from the bank, or spend an existing balance. */
  sourceKind?: "bank" | "wallet";
  walletType?: "operating" | "trust";
  subLedgerId?: string | null;
  claimId?: string | null;
  checkId?: string | null;
  description?: string;
  idempotencyKey?: string;
}

export interface SplitGroup {
  id: string;
  status: string;
  total_amount_cents: number;
  facilitator_fee_cents: number;
  net_amount_cents: number;
  leg_count: number;
  claim_id: string | null;
  check_id: string | null;
  created_at: string;
}

export interface SplitResult {
  group: SplitGroup;
  transfers: Array<{
    id: string;
    status: PaymentStatus;
    amount_cents: number;
    leg_role: string | null;
    failure_reason: string | null;
  }>;
  duplicate: boolean;
}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let message = error.message ?? `${fn} failed`;
    try {
      const parsed = await (error as any).context?.json?.();
      if (parsed?.message) message = parsed.message;
      else if (parsed?.error) message = parsed.error;
    } catch {
      /* keep the original message */
    }
    throw new Error(message);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

export async function sendSplitPayment(input: SplitInput): Promise<SplitResult> {
  if (!input.legs.length) throw new Error("Add at least one recipient.");
  return invoke<SplitResult>("moov-transfer-group-create", {
    tenant_id: input.tenantId,
    legs: input.legs.map((l) => ({
      role: l.role,
      amount_cents: l.amountCents,
      recipient_tenant_id: l.recipientTenantId ?? null,
      external_recipient_id: l.externalRecipientId ?? null,
      description: l.description ?? null,
    })),
    facilitator_fee_cents: input.facilitatorFeeCents ?? 0,
    source_kind: input.sourceKind ?? "bank",
    wallet_type: input.walletType ?? "operating",
    sub_ledger_id: input.subLedgerId ?? null,
    claim_id: input.claimId ?? null,
    check_id: input.checkId ?? null,
    description: input.description ?? null,
    idempotency_key: input.idempotencyKey,
  });
}

/** Lists split settlements for an organization, newest first. */
export async function listSplitGroups(
  tenantId: string,
  opts: { checkId?: string | null; claimId?: string | null; limit?: number } = {},
): Promise<SplitGroup[]> {
  let q = supabase
    .from("payment_transfer_groups")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 25);
  if (opts.checkId) q = q.eq("check_id", opts.checkId);
  if (opts.claimId) q = q.eq("claim_id", opts.claimId);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as SplitGroup[];
}
