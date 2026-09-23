import { supabase } from "@/integrations/aws/client";

/**
 * ChecksOps-native case record.
 *
 * Freedom CRM owns the insurance claim. ChecksOps owns the money and the
 * operational documentation around it — a `check_case` carries only the
 * identifying fields needed to link a check, deposit, disbursement or
 * loss-draft record back to its originating claim.
 */
export interface CheckCase {
  id: string;
  tenant_id: string;
  external_system: string;
  external_claim_id: string | null;
  external_reference: string | null;
  claim_number: string | null;
  insured_name: string | null;
  insured_email: string | null;
  insured_phone: string | null;
  property_address: string | null;
  carrier_name: string | null;
  policy_number: string | null;
  mortgage_company_id: string | null;
  loan_number: string | null;
  loss_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export async function getCheckCase(caseId: string): Promise<CheckCase | null> {
  const { data, error } = await supabase
    .from("check_cases")
    .select("*")
    .eq("id", caseId)
    .maybeSingle();
  if (error) throw error;
  return (data as CheckCase) ?? null;
}

export async function getCheckCaseByExternalClaim(
  externalClaimId: string,
  externalSystem = "freedom_crm",
): Promise<CheckCase | null> {
  const { data, error } = await supabase
    .from("check_cases")
    .select("*")
    .eq("external_system", externalSystem)
    .eq("external_claim_id", externalClaimId)
    .maybeSingle();
  if (error) throw error;
  return (data as CheckCase) ?? null;
}

export async function listCheckCases(
  tenantId: string,
  opts: { search?: string; limit?: number } = {},
): Promise<CheckCase[]> {
  let query = supabase
    .from("check_cases")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 100);

  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`;
    query = query.or(
      `claim_number.ilike.${term},insured_name.ilike.${term},property_address.ilike.${term},carrier_name.ilike.${term}`,
    );
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as CheckCase[];
}

/**
 * Finds or creates the case for a check. Mirrors the database trigger, for
 * flows that need the case id before the check row is written.
 */
export async function resolveCheckCase(input: {
  tenantId: string;
  claimId?: string | null;
  externalClaimId?: string | null;
  claimNumber?: string | null;
  insuredName?: string | null;
  propertyAddress?: string | null;
  carrierName?: string | null;
}): Promise<string | null> {
  const { data, error } = await supabase.rpc("resolve_check_case", {
    _tenant_id: input.tenantId,
    _claim_id: input.claimId ?? null,
    _external_claim_id: input.externalClaimId ?? null,
    _claim_number: input.claimNumber ?? null,
    _insured_name: input.insuredName ?? null,
    _property_address: input.propertyAddress ?? null,
    _carrier_name: input.carrierName ?? null,
  });
  if (error) throw error;
  return (data as string) ?? null;
}

/** Display label used across check, deposit and mortgage surfaces. */
export function caseLabel(c: Pick<CheckCase, "claim_number" | "insured_name"> | null): string {
  if (!c) return "Unlinked check";
  return [c.claim_number, c.insured_name].filter(Boolean).join(" · ") || "Unlinked check";
}
