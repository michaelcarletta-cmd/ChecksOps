import { supabase } from "@/integrations/supabase/client";

export const PARTNER_CHECK_ENDORSEMENTS = "aws_partner_check_endorsements";
export const PARTNER_CHECK_PAYEES = "aws_partner_check_payees";
export const PARTNER_SIGNATURE_SIGNERS = "aws_partner_signature_signers";

type QueryResult<T> = { data: T; error: any };

const fromTable = (table: string) => (supabase as any).from(table);

const isEmpty = (data: unknown) => (
  data == null || (Array.isArray(data) && data.length === 0)
);

/**
 * Owner/base-table first. If RLS returns no rows (partner / empty owner set),
 * retry the same query against the partner-safe projection.
 */
export async function selectOwnerThenPartner<T>(
  ownerTable: string,
  partnerView: string,
  run: (from: ReturnType<typeof fromTable>) => Promise<QueryResult<T>>,
): Promise<QueryResult<T>> {
  const owner = await run(fromTable(ownerTable));
  if (owner.error) return owner;
  if (!isEmpty(owner.data)) return owner;
  return run(fromTable(partnerView));
}

export async function attachPartnerPayees<T extends {
  id: string;
  tenant_id?: string | null;
  check_payees?: unknown[] | null;
}>(
  check: T | null,
  currentTenantId?: string | null,
): Promise<T | null> {
  if (!check) return check;
  if (currentTenantId && check.tenant_id === currentTenantId) return check;
  if (Array.isArray(check.check_payees) && check.check_payees.length > 0) return check;
  const { data } = await fromTable(PARTNER_CHECK_PAYEES)
    .select("*")
    .eq("check_id", check.id);
  if (Array.isArray(data) && data.length > 0) {
    return { ...check, check_payees: data };
  }
  return check;
}

export async function fillPartnerSigners<T extends {
  id: string;
  signature_signers?: unknown[] | null;
}>(requests: T[] | null | undefined): Promise<T[]> {
  const rows = requests ?? [];
  if (!rows.length) return rows;
  if (rows.every((row) => Array.isArray(row.signature_signers) && row.signature_signers.length > 0)) {
    return rows;
  }
  const { data, error } = await fromTable(PARTNER_SIGNATURE_SIGNERS)
    .select("*")
    .in("signature_request_id", rows.map((row) => row.id));
  if (error || !Array.isArray(data) || data.length === 0) return rows;
  const byRequest = new Map<string, unknown[]>();
  for (const signer of data) {
    const key = String(signer.signature_request_id);
    if (!byRequest.has(key)) byRequest.set(key, []);
    byRequest.get(key)!.push(signer);
  }
  return rows.map((row) => (
    Array.isArray(row.signature_signers) && row.signature_signers.length > 0
      ? row
      : { ...row, signature_signers: byRequest.get(String(row.id)) ?? [] }
  ));
}
