import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useSelectedPartners } from "@/lib/payments/selectedPartners";
import {
  buildCheckStakeholderRows,
  releasedCentsByKey,
  removedPartnerIds as computeRemovedPartnerIds,
  type CheckStakeholderRecord,
  type PartnerRef,
  type PartnerRemovalRecord,
  type SendTransferRecord,
  type DisbursementBatchRecord,
} from "@/lib/payments/checkStakeholderList";

type DataError = { message: string; code?: string } | null;
type DataResult = PromiseLike<{ data: unknown; error: DataError }>;
interface FilterChain extends DataResult {
  eq(column: string, value: string): FilterChain;
}
/** check_partner_stakeholder_removals is newer than the generated types. */
interface PartnerRemovalsTable {
  select(columns: string): FilterChain;
  insert(values: { check_intake_item_id: string; partner_tenant_id: string }): DataResult;
  delete(): FilterChain;
}
export const partnerRemovalsTable = () =>
  (supabase as unknown as { from(table: "check_partner_stakeholder_removals"): PartnerRemovalsTable })
    .from("check_partner_stakeholder_removals");

type TransferRow = SendTransferRecord & { id: string; leg_role: string; created_at: string };

/**
 * Shared query definitions for a check's payees. The stakeholder list and the
 * payment screen use the same keys and loaders, so a write in one refreshes both.
 */
export const checkStakeholderQueryKeys = {
  stakeholders: (checkId: string) => ["check-stakeholders", checkId] as const,
  sharedPartners: (checkId: string, tenantId: string | undefined) => ["partner-recipients", checkId, tenantId] as const,
  removals: (checkId: string) => ["check-partner-stakeholder-removals", checkId] as const,
  sends: (checkId: string) => ["check-sends", checkId] as const,
  batchHistory: (checkOrDepositId: string | undefined) => ["disbursement-batch-history", checkOrDepositId] as const,
};

export const checkStakeholdersQuery = (checkId: string) => ({
  queryKey: checkStakeholderQueryKeys.stakeholders(checkId),
  enabled: !!checkId,
  queryFn: async () => {
    const { data, error } = await supabase
      .from("check_stakeholders")
      .select(`
        id, added_via, partner_tenant_id, stakeholder_account_id,
        stakeholder_accounts:stakeholder_account_id (id, nickname, account_type, chk_acct, is_active, verification_status, verification_source, plaid_account_id, custname, homeowner_name, authentecheck_bank_name, provider, provider_account_id, provider_bank_name, provider_last_four),
        partner:partner_tenant_id (id, name)
      `)
      .eq("check_intake_item_id", checkId);
    if (error) throw error;
    return (data ?? []) as unknown as CheckStakeholderRecord[];
  },
});

// Partners this check is shared with (live shares only), named from the tenant directory.
export const sharedPartnersQuery = (checkId: string | undefined, tenantId: string | undefined) => ({
  queryKey: checkStakeholderQueryKeys.sharedPartners(checkId ?? "", tenantId),
  enabled: !!checkId && !!tenantId,
  queryFn: async (): Promise<PartnerRef[]> => {
    const { data, error } = await supabase
      .from("shared_checks")
      .select("target_tenant_id, revoked_at")
      .eq("check_id", checkId!)
      .eq("source_tenant_id", tenantId!)
      .is("revoked_at", null);
    if (error) throw error;
    const ids = [...new Set((data ?? []).map((row: { target_tenant_id: string | null }) => row.target_tenant_id).filter(Boolean))] as string[];
    if (ids.length === 0) return [];
    const { data: names } = await supabase.from("tenants_public").select("id, name").in("id", ids);
    const nameOf = new Map((names ?? []).map((t: { id: string; name: string | null }) => [t.id, t.name] as const));
    return ids.map((id) => ({ partner_tenant_id: id, partner_name: (nameOf.get(id) as string) || "Partner organization" }));
  },
});

export const partnerRemovalsQuery = (checkId: string | undefined) => ({
  queryKey: checkStakeholderQueryKeys.removals(checkId ?? ""),
  enabled: !!checkId,
  queryFn: async (): Promise<PartnerRemovalRecord[]> => {
    const { data, error } = await partnerRemovalsTable()
      .select("id, partner_tenant_id, created_at")
      .eq("check_intake_item_id", checkId!);
    if (error) throw error;
    return (data ?? []) as PartnerRemovalRecord[];
  },
});

// Sends recorded by the payment server for this check (one row per transfer).
export const checkSendsQuery = (checkId: string | undefined) => ({
  queryKey: checkStakeholderQueryKeys.sends(checkId ?? ""),
  enabled: !!checkId,
  queryFn: async () => {
    const { data, error } = await supabase
      .from("payment_transfers")
      .select("id, amount_cents, status, leg_role, created_at, destination_tenant_id, provider_metadata")
      .eq("check_id", checkId!)
      .in("leg_role", ["send_wallet", "send_bank"])
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as unknown as TransferRow[];
  },
});

// All past batches and splits for this check (or deposit).
export const batchHistoryQuery = (checkIntakeItemId: string | undefined, depositItemId?: string) => ({
  queryKey: checkStakeholderQueryKeys.batchHistory(checkIntakeItemId ?? depositItemId),
  enabled: !!(checkIntakeItemId || depositItemId),
  queryFn: async () => {
    const query = supabase
      .from("disbursement_batches")
      .select(`id, status, created_at, delivery_speed, disbursement_splits(id, amount, status, return_code, stakeholder_account_id, stakeholder_accounts(nickname, account_type), actum_transactions(auth_code, response_reason))`)
      .order("created_at", { ascending: false });
    if (checkIntakeItemId) query.eq("check_intake_item_id", checkIntakeItemId);
    else if (depositItemId) query.eq("deposit_item_id", depositItemId);
    const { data } = await query;
    return (data ?? []) as unknown as Array<DisbursementBatchRecord & Record<string, unknown>>;
  },
});

/** The one list of payees for a check, with removal status and amounts sent so far. */
export function useCheckStakeholderList(checkId: string | undefined, tenantId: string | undefined) {
  const id = checkId ?? "";
  const stakeholders = useQuery(checkStakeholdersQuery(id));
  const shared = useQuery(sharedPartnersQuery(checkId, tenantId));
  const removals = useQuery(partnerRemovalsQuery(checkId));
  const sends = useQuery(checkSendsQuery(checkId));
  const batches = useQuery(batchHistoryQuery(checkId));
  const { partners: selectedPartners } = useSelectedPartners(checkId);

  const sharedPartners = useMemo(() => shared.data ?? [], [shared.data]);
  const removalRows = useMemo(() => removals.data ?? [], [removals.data]);

  const rows = useMemo(
    () =>
      buildCheckStakeholderRows({
        checkStakeholders: stakeholders.data ?? [],
        sharedPartners,
        removals: removalRows,
        selectedPartners,
      }),
    [stakeholders.data, sharedPartners, removalRows, selectedPartners],
  );
  const removedPartnerIds = useMemo(() => computeRemovedPartnerIds(sharedPartners, removalRows), [sharedPartners, removalRows]);
  const released = useMemo(
    () => releasedCentsByKey({ transfers: sends.data ?? [], batches: batches.data ?? [] }),
    [sends.data, batches.data],
  );

  return {
    rows,
    released,
    sharedPartners,
    removedPartnerIds,
    selectedPartners,
    isLoading: stakeholders.isLoading,
  };
}
