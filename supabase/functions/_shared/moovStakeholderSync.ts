/**
 * Mirror live Moov bank metadata onto stakeholder_accounts.
 * Does not create transfers or change money movement.
 */

const ZERO_ACCOUNT = /^0+$/;

export function digitsOnly(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function safeLastFour(value: unknown): string | null {
  const digits = digitsOnly(value);
  if (!digits || ZERO_ACCOUNT.test(digits)) return null;
  return digits.slice(-4);
}

export function interpretMoovBankStatus(bank: any = {}, verification: any = null): string {
  const bankStatus = String(bank?.status ?? "").toLowerCase();
  const verifStatus = String(verification?.status ?? "").toLowerCase();
  const verifSucceeded = ["successful", "completed", "verified"].includes(verifStatus);
  if (bankStatus === "verified" || verifSucceeded) return "verified";
  if (
    bankStatus === "errored"
    || bankStatus === "verificationfailed"
    || ["failed", "expired", "max-attempts-exceeded"].includes(verifStatus)
  ) {
    return "failed";
  }
  return bankStatus || verifStatus || "pending";
}

export function nextStakeholderVerification(current: unknown, incoming: unknown): string {
  const now = String(current ?? "unverified").toLowerCase();
  if (now === "admin_override" || now === "verified") return now;
  if (incoming === "verified") return "verified";
  return now || String(incoming || "unverified");
}

export function pickPreferredBank(banks: any[] = []): any | null {
  const list = Array.isArray(banks) ? banks : [];
  return list.find((bank) => interpretMoovBankStatus(bank) === "verified")
    ?? list.find((bank) => safeLastFour(bank?.lastFourAccountNumber ?? bank?.last_four))
    ?? list[0]
    ?? null;
}

export function stakeholderPatchFromBank(current: any = {}, bank: any = {}, verification: any = null) {
  const incoming = interpretMoovBankStatus(bank, verification);
  const lastFour = safeLastFour(
    bank?.lastFourAccountNumber ?? bank?.last_four ?? current?.provider_last_four,
  );
  const verificationStatus = nextStakeholderVerification(current?.verification_status, incoming);
  return {
    provider_bank_account_id: bank?.bankAccountID ?? bank?.bankAccountId ?? current?.provider_bank_account_id ?? null,
    provider_bank_name: bank?.bankName ?? bank?.bank_name ?? current?.provider_bank_name ?? null,
    provider_last_four: lastFour,
    verification_status: verificationStatus,
    verified_at: verificationStatus === "verified"
      ? (current?.verified_at || new Date().toISOString())
      : current?.verified_at ?? null,
  };
}

export async function applyTenantBanksToOperatingStakeholders(
  supabase: any,
  {
    tenantId,
    providerAccountId,
    banks = [],
    verification = null,
  }: {
    tenantId: string;
    providerAccountId: string;
    banks?: any[];
    verification?: any;
  },
) {
  const bank = pickPreferredBank(banks);
  if (!bank || !tenantId || !providerAccountId) return { updated: 0 };
  const { data: rows } = await supabase
    .from("stakeholder_accounts")
    .select("id, verification_status, verified_at, provider_last_four, provider_bank_name, provider_bank_account_id, provider_account_id, account_type, origin")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .or("account_type.eq.operating,origin.eq.provider_connected");
  let updated = 0;
  for (const row of rows ?? []) {
    const matchesAccount = !row.provider_account_id || row.provider_account_id === providerAccountId;
    if (!matchesAccount && row.provider_account_id) continue;
    const patch = stakeholderPatchFromBank(row, bank, verification);
    const { error } = await supabase
      .from("stakeholder_accounts")
      .update({
        provider: "moov",
        provider_account_id: providerAccountId,
        ...patch,
      })
      .eq("id", row.id);
    if (!error) updated += 1;
  }
  return { updated };
}

export async function syncLinkedStakeholderBanks(
  supabase: any,
  {
    tenantId,
    environment,
    skipAccountIds = [],
    fetchBanks,
  }: {
    tenantId: string;
    environment: string;
    skipAccountIds?: string[];
    fetchBanks: (accountId: string) => Promise<any[]>;
  },
) {
  if (!tenantId || typeof fetchBanks !== "function") return { accounts: 0, updated: 0 };
  const skip = new Set((skipAccountIds || []).filter(Boolean));
  const [{ data: stakes }, { data: recipients }] = await Promise.all([
    supabase
      .from("stakeholder_accounts")
      .select("id, provider_account_id, verification_status, verified_at, provider_last_four, provider_bank_name, provider_bank_account_id")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .not("provider_account_id", "is", null),
    supabase
      .from("external_payment_recipients")
      .select("id, stakeholder_account_id, provider_account_id, onboarding_status, provider_last_four, provider_bank_name, environment")
      .eq("tenant_id", tenantId)
      .eq("environment", environment)
      .not("provider_account_id", "is", null),
  ]);

  const byAccount = new Map<string, { stakes: any[]; recipients: any[] }>();
  for (const row of stakes ?? []) {
    if (!row.provider_account_id || skip.has(row.provider_account_id)) continue;
    const list = byAccount.get(row.provider_account_id) || { stakes: [], recipients: [] };
    list.stakes.push(row);
    byAccount.set(row.provider_account_id, list);
  }
  for (const row of recipients ?? []) {
    if (!row.provider_account_id || skip.has(row.provider_account_id)) continue;
    const list = byAccount.get(row.provider_account_id) || { stakes: [], recipients: [] };
    list.recipients.push(row);
    byAccount.set(row.provider_account_id, list);
  }

  let updated = 0;
  for (const [accountId, group] of byAccount.entries()) {
    const banks = await fetchBanks(accountId).catch(() => []);
    const bank = pickPreferredBank(banks);
    if (!bank) continue;
    const incoming = interpretMoovBankStatus(bank);
    for (const stake of group.stakes) {
      const patch = stakeholderPatchFromBank(stake, bank);
      const { error } = await supabase.from("stakeholder_accounts").update(patch).eq("id", stake.id);
      if (!error) updated += 1;
    }
    for (const recipient of group.recipients) {
      await supabase
        .from("external_payment_recipients")
        .update({
          onboarding_status: incoming === "verified" ? "ready" : (recipient.onboarding_status || "awaiting_bank"),
          provider_bank_name: bank.bankName ?? bank.bank_name ?? recipient.provider_bank_name ?? null,
          provider_last_four: safeLastFour(bank.lastFourAccountNumber ?? bank.last_four) ?? recipient.provider_last_four ?? null,
        })
        .eq("id", recipient.id);
      if (recipient.stakeholder_account_id && !group.stakes.some((s) => s.id === recipient.stakeholder_account_id)) {
        const { data: linked } = await supabase
          .from("stakeholder_accounts")
          .select("id, verification_status, verified_at, provider_last_four, provider_bank_name, provider_bank_account_id")
          .eq("id", recipient.stakeholder_account_id)
          .maybeSingle();
        if (linked) {
          const patch = stakeholderPatchFromBank(linked, bank);
          const { error } = await supabase
            .from("stakeholder_accounts")
            .update({
              provider: "moov",
              provider_account_id: accountId,
              ...patch,
            })
            .eq("id", linked.id);
          if (!error) updated += 1;
        }
      }
    }
  }
  return { accounts: byAccount.size, updated };
}
