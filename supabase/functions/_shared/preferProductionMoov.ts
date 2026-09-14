import { bindMoovEnvironment, moovConfigured, moovFetch, scopes } from "./moovClient.ts";
import {
  isDeniedDuplicateMoovAccount,
  knownApprovedForTenant,
  KNOWN_APPROVED_MOOV,
} from "./knownApprovedMoov.ts";

const listOf = (payload: any) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.bankAccounts)) return payload.bankAccounts;
  return [];
};

const verificationOf = (account: any) => String(
  account?.profile?.business?.verification?.status
    ?? account?.profile?.individual?.verification?.status
    ?? account?.verification?.status
    ?? "",
).toLowerCase();

export async function resolveLiveReadAccount(
  supabase: any,
  tenantId: string,
  fallbackEnv: string,
) {
  const known = knownApprovedForTenant(tenantId);
  if (moovConfigured("production")) {
    const { data: production } = await supabase
      .from("payment_provider_accounts")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("provider", "moov")
      .eq("environment", "production")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const accountId = production?.provider_account_id || known?.moovAccountId || null;
    if (accountId && !isDeniedDuplicateMoovAccount(accountId)) {
      bindMoovEnvironment("production");
      return {
        environment: "production" as const,
        account: production,
        accountId: String(accountId),
        known,
      };
    }
  }

  const { data: fallback } = await supabase
    .from("payment_provider_accounts")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("provider", "moov")
    .eq("environment", fallbackEnv)
    .maybeSingle();
  return {
    environment: fallbackEnv,
    account: fallback,
    accountId: (fallback?.provider_account_id as string | null) ?? null,
    known,
  };
}

export async function persistVerifiedPayees(
  supabase: any,
  tenantId: string,
) {
  const { data: recipients } = await supabase
    .from("external_payment_recipients")
    .select("id, stakeholder_account_id, provider_account_id")
    .eq("tenant_id", tenantId)
    .not("provider_account_id", "is", null)
    .limit(20);
  const { data: stakeholders } = await supabase
    .from("stakeholder_accounts")
    .select("id, provider_account_id, verification_status")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .not("provider_account_id", "is", null)
    .limit(20);

  const rows = [...(recipients ?? []), ...(stakeholders ?? [])];
  const accountIds = [...new Set(
    rows.map((row: any) => String(row.provider_account_id || "")).filter(Boolean),
  )];
  if (
    tenantId === KNOWN_APPROVED_MOOV.freedom.tenantId
    && KNOWN_APPROVED_MOOV.recipient.moovAccountId
    && !accountIds.includes(KNOWN_APPROVED_MOOV.recipient.moovAccountId)
  ) {
    accountIds.push(KNOWN_APPROVED_MOOV.recipient.moovAccountId);
  }

  const payees: Array<Record<string, unknown>> = [];
  for (const accountId of accountIds.slice(0, 20)) {
    if (isDeniedDuplicateMoovAccount(accountId)) continue;
    const account = await moovFetch<any>(`/accounts/${accountId}`, {
      scopes: scopes.accountRead(accountId),
    }).catch(() => null);
    if (!account) continue;
    const banks = listOf(await moovFetch<any[]>(`/accounts/${accountId}/bank-accounts`, {
      scopes: scopes.bankAccountsRead(accountId),
    }).catch(() => []));
    const verification = verificationOf(account);
    const verified = verification === "verified";
    const verifiedBank = banks.some((bank: any) => String(bank.status || "").toLowerCase() === "verified");
    const bank = banks.find((row: any) => String(row.status || "").toLowerCase() === "verified") || banks[0] || null;
    const localStatus = verified && (verifiedBank || banks.length === 0) ? "verified" : verification || "pending";
    if (localStatus === "verified") {
      await supabase
        .from("external_payment_recipients")
        .update({
          onboarding_status: "verified",
          provider_bank_name: bank?.bankName ?? undefined,
          provider_last_four: bank?.lastFourAccountNumber ?? bank?.lastFour ?? undefined,
        })
        .eq("tenant_id", tenantId)
        .eq("provider_account_id", accountId);
      await supabase
        .from("stakeholder_accounts")
        .update({
          verification_status: "verified",
          verified_at: new Date().toISOString(),
          provider_bank_name: bank?.bankName ?? undefined,
          provider_last_four: bank?.lastFourAccountNumber ?? bank?.lastFour ?? undefined,
        })
        .eq("tenant_id", tenantId)
        .eq("provider_account_id", accountId)
        .neq("verification_status", "admin_override");
    }
    const stakeholderIds = [
      ...(stakeholders ?? []).filter((row: any) => row.provider_account_id === accountId).map((row: any) => row.id),
      ...(recipients ?? []).filter((row: any) => row.provider_account_id === accountId).map((row: any) => row.stakeholder_account_id).filter(Boolean),
    ];
    payees.push({
      moov_account_id: accountId,
      recipient_id: (recipients ?? []).find((row: any) => row.provider_account_id === accountId)?.id
        || (accountId === KNOWN_APPROVED_MOOV.recipient.moovAccountId
          ? KNOWN_APPROVED_MOOV.recipient.recipientId
          : null),
      stakeholder_account_ids: [...new Set(stakeholderIds)],
      verification_status: localStatus,
      identity_verified: verified,
      bank_verified: verifiedBank,
      bank_name: bank?.bankName ?? null,
      last_four: bank?.lastFourAccountNumber ?? bank?.lastFour ?? null,
    });
  }
  return payees;
}
