import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { functionRefusalMessage } from "@/lib/tenantProfile";

import {
  starterPackageFromRow,
  type StarterPackage,
  type StarterPackageInput,
} from "@/lib/billing/starterPackageModel";

export {
  STARTER_PACKAGE_DEFAULT_CHECKS,
  defaultMaintenanceEndsOn,
  starterPackageFromRow,
  starterPackageSummary,
  type StarterPackage,
  type StarterPackageInput,
} from "@/lib/billing/starterPackageModel";

type Row = Parameters<typeof starterPackageFromRow>[0];

const PACKAGE_COLUMNS =
  "starter_package_enabled, starter_package_starts_on, starter_package_maintenance_ends_on, starter_package_included_checks";

/** The tenant's Starter Package (tenants columns plus its included checks used); null before SQL 151. */
export async function fetchStarterPackage(tenantId: string): Promise<StarterPackage | null> {
  const { data, error } = await supabase
    .from("tenants")
    .select(PACKAGE_COLUMNS as never)
    .eq("id", tenantId)
    .maybeSingle();
  if (error || !data) return null;
  const { data: used, count } = await supabase
    .from("check_billing_events")
    .select("id", { count: "exact" })
    .eq("tenant_id", tenantId)
    .eq("package_included" as never, true as never)
    .neq("status", "voided");
  return starterPackageFromRow(data as unknown as Row, count ?? used?.length ?? 0);
}

export function useStarterPackage(tenantId: string | null | undefined) {
  return useQuery({
    queryKey: ["tenant-starter-package", tenantId],
    queryFn: () => fetchStarterPackage(tenantId as string),
    enabled: !!tenantId,
    staleTime: 30_000,
  });
}

/** Platform owner only: tenant-billing-admin update (SQL 151 setter, audited). */
export async function saveStarterPackage(tenantId: string, input: StarterPackageInput): Promise<void> {
  const { data, error } = await supabase.functions.invoke("tenant-billing-admin", {
    body: { action: "update", tenant_id: tenantId, starter_package: input },
  });
  const refusal = functionRefusalMessage(data, error, "Starter Package was not saved");
  if (refusal) throw new Error(refusal);
}
