import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Partners chosen in a check's stakeholder picker to be paid on that check.
 * Choosing a partner writes nothing: the payment server checks the partnership
 * again when the payment is sent. Kept per check for this browser tab.
 */
export interface SelectedPartner {
  partner_tenant_id: string;
  partner_name: string;
}

const storageKey = (checkId: string) => `checksops:selected-partners:${checkId}`;
export const selectedPartnersQueryKey = (checkId: string) => ["selected-partners", checkId] as const;

function readStored(checkId: string): SelectedPartner[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(storageKey(checkId)) || "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((p) => {
      if (!p || typeof p.partner_tenant_id !== "string" || typeof p.partner_name !== "string") return false;
      if (seen.has(p.partner_tenant_id)) return false;
      seen.add(p.partner_tenant_id);
      return true;
    });
  } catch {
    return [];
  }
}

function writeStored(checkId: string, partners: SelectedPartner[]) {
  try {
    window.sessionStorage.setItem(storageKey(checkId), JSON.stringify(partners));
  } catch {
    /* the selection still works for this page */
  }
}

export function useSelectedPartners(checkId: string | null | undefined) {
  const qc = useQueryClient();
  const { data: partners = [] } = useQuery({
    queryKey: selectedPartnersQueryKey(checkId ?? ""),
    enabled: !!checkId,
    queryFn: () => readStored(checkId!),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const update = useCallback(
    (next: (current: SelectedPartner[]) => SelectedPartner[]) => {
      if (!checkId) return;
      const key = selectedPartnersQueryKey(checkId);
      const value = next(qc.getQueryData<SelectedPartner[]>(key) ?? readStored(checkId));
      qc.setQueryData(key, value);
      writeStored(checkId, value);
    },
    [checkId, qc],
  );

  const add = useCallback(
    (partner: SelectedPartner) =>
      update((current) =>
        current.some((p) => p.partner_tenant_id === partner.partner_tenant_id) ? current : [...current, partner],
      ),
    [update],
  );
  const remove = useCallback(
    (partnerTenantId: string) => update((current) => current.filter((p) => p.partner_tenant_id !== partnerTenantId)),
    [update],
  );

  /** Drops chosen partners that are no longer partners (e.g. the partnership ended). */
  const keepOnly = useCallback(
    (partnerTenantIds: Set<string>) =>
      update((current) => {
        const kept = current.filter((p) => partnerTenantIds.has(p.partner_tenant_id));
        return kept.length === current.length ? current : kept;
      }),
    [update],
  );

  return { partners, add, remove, keepOnly };
}
