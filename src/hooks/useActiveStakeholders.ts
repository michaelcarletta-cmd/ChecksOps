import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  ACTIVE_STAKEHOLDER_COLUMNS,
  activeStakeholders,
  type ActiveStakeholderRecord,
} from "@/lib/payments/activeStakeholders";

/**
 * The Active Stakeholders from Settings. One query key for Settings, Payroll and
 * the recipient report, so adding or removing a stakeholder in Settings
 * (which invalidates ["stakeholder-accounts"]) refreshes all of them.
 */
export const activeStakeholdersQuery = (tenantId: string | undefined, enabled = true) => ({
  queryKey: ["stakeholder-accounts", tenantId] as const,
  enabled: !!tenantId && enabled,
  queryFn: async (): Promise<ActiveStakeholderRecord[]> => {
    const { data, error } = await supabase
      .from("stakeholder_accounts")
      .select(ACTIVE_STAKEHOLDER_COLUMNS)
      .eq("tenant_id", tenantId!)
      .eq("is_active", true)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true });
    if (error) throw error;
    // Tenant's own bank account (operating, or a provider-connected payment
    // account like the Moov-linked "payment account") is shown separately at
    // the top of the Settings page in TenantBankAccountSettings. Exclude both
    // so stakeholders are strictly third parties identified by their account_type.
    return activeStakeholders((data ?? []) as unknown as ActiveStakeholderRecord[]);
  },
});

export function useActiveStakeholders(tenantId: string | undefined, enabled = true) {
  return useQuery(activeStakeholdersQuery(tenantId, enabled));
}
