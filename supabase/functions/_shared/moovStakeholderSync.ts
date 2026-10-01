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

export function normalizeStakeholderEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  return email || null;
}

export function bankEventFromPayload(data: any = {}) {
  const bank = data?.bankAccount && typeof data.bankAccount === "object" ? data.bankAccount : data;
  return {
    bankAccountID: data?.bankAccountID ?? data?.bankAccountId ?? bank?.bankAccountID ?? bank?.bankAccountId ?? null,
    bankName: data?.bankName ?? bank?.bankName ?? bank?.bank_name ?? null,
    lastFour: data?.lastFourAccountNumber ?? bank?.lastFourAccountNumber ?? data?.lastFour ?? bank?.last_four ?? null,
    status: data?.status ?? bank?.status ?? null,
    verification: data?.verification ?? bank?.verification ?? null,
  };
}

export function shouldApplyBankVerificationEvent(eventType: unknown, data: any = {}): boolean {
  const type = String(eventType ?? "");
  if (!type.startsWith("bankAccount") && !type.includes("verification")) return false;
  const event = bankEventFromPayload(data);
  return Boolean(event.bankAccountID || event.status || event.verification);
}

export function resolveStakeholderVerificationTargets({
  providerAccountId,
  bankAccountID = null,
  stakeholders = [],
  recipients = [],
  methods = [],
  isTenantOperatingAccount = false,
}: {
  providerAccountId?: string | null;
  bankAccountID?: string | null;
  stakeholders?: any[];
  recipients?: any[];
  methods?: any[];
  isTenantOperatingAccount?: boolean;
} = {}) {
  const ids = new Set<string>();
  const recipientLinks: Array<{ recipientId: string; stakeholderId: string }> = [];

  for (const stake of stakeholders) {
    if (providerAccountId && stake.provider_account_id === providerAccountId) ids.add(stake.id);
  }

  const matchingRecipients = recipients.filter((row) => {
    if (providerAccountId && row.provider_account_id === providerAccountId) return true;
    if (bankAccountID && row.provider_bank_account_id === bankAccountID) return true;
    return false;
  });

  for (const recipient of matchingRecipients) {
    if (recipient.stakeholder_account_id) ids.add(recipient.stakeholder_account_id);
  }

  for (const method of methods) {
    const matches = (bankAccountID && method.provider_bank_account_id === bankAccountID)
      || (providerAccountId && method.provider_account_id === providerAccountId);
    if (!matches || !method.external_recipient_id) continue;
    const recipient = recipients.find((row) => row.id === method.external_recipient_id);
    if (recipient?.stakeholder_account_id) ids.add(recipient.stakeholder_account_id);
  }

  for (const recipient of matchingRecipients) {
    if (recipient.stakeholder_account_id || !normalizeStakeholderEmail(recipient.email)) continue;
    const email = normalizeStakeholderEmail(recipient.email);
    const candidates = stakeholders.filter((stake) => {
      if (stake.provider_account_id && stake.provider_account_id !== providerAccountId) return false;
      return normalizeStakeholderEmail(stake.verification_recipient_email) === email;
    });
    if (candidates.length === 1) {
      ids.add(candidates[0].id);
      recipientLinks.push({ recipientId: recipient.id, stakeholderId: candidates[0].id });
    }
  }

  if (isTenantOperatingAccount) {
    for (const stake of stakeholders) {
      const operating = stake.account_type === "operating" || stake.origin === "provider_connected";
      if (!operating) continue;
      if (!stake.provider_account_id || stake.provider_account_id === providerAccountId) {
        ids.add(stake.id);
      }
    }
  }

  return { stakeholderIds: [...ids], recipientLinks };
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
      .select("id, stakeholder_account_id, provider_account_id, onboarding_status, provider_last_four, provider_bank_name, environment, email")
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
      let linkedStakeholderId = recipient.stakeholder_account_id || null;
      if (!linkedStakeholderId && recipient.email) {
        const email = normalizeStakeholderEmail(recipient.email);
        const { data: matches } = await supabase
          .from("stakeholder_accounts")
          .select("id, verification_status, verified_at, provider_last_four, provider_bank_name, provider_bank_account_id, provider_account_id")
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .ilike("verification_recipient_email", email);
        const unique = (matches ?? []).filter((row: any) =>
          !row.provider_account_id || row.provider_account_id === accountId
        );
        if (unique.length === 1) {
          linkedStakeholderId = unique[0].id;
          await supabase
            .from("external_payment_recipients")
            .update({ stakeholder_account_id: linkedStakeholderId })
            .eq("id", recipient.id)
            .is("stakeholder_account_id", null);
        }
      }
      if (linkedStakeholderId && !group.stakes.some((s) => s.id === linkedStakeholderId)) {
        const { data: linked } = await supabase
          .from("stakeholder_accounts")
          .select("id, verification_status, verified_at, provider_last_four, provider_bank_name, provider_bank_account_id")
          .eq("id", linkedStakeholderId)
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

function mergeStakeholderRows(...lists: any[][]) {
  const byId = new Map<string, any>();
  for (const list of lists) {
    for (const row of list || []) {
      if (row?.id) byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

export async function applyMoovBankVerificationEvent(
  supabase: any,
  {
    environment,
    providerAccountId,
    tenantId = null,
    bank = {},
    verification = null,
  }: {
    environment: string;
    providerAccountId?: string | null;
    tenantId?: string | null;
    bank?: any;
    verification?: any;
  },
) {
  if (!supabase || !providerAccountId) return { updated: 0, recipients: 0 };

  const event = bankEventFromPayload(bank);
  const { data: recipients } = await supabase
    .from("external_payment_recipients")
    .select("id, tenant_id, stakeholder_account_id, provider_account_id, email, onboarding_status, provider_last_four, provider_bank_name, environment, provider_bank_account_id")
    .eq("provider_account_id", providerAccountId)
    .eq("environment", environment);

  const methods = event.bankAccountID
    ? ((await supabase
      .from("payment_provider_methods")
      .select("id, provider_account_id, provider_bank_account_id, external_recipient_id, environment")
      .eq("provider_bank_account_id", event.bankAccountID)
      .eq("environment", environment)).data ?? [])
    : [];

  let tenant = tenantId || recipients?.[0]?.tenant_id || null;
  let isTenantOperatingAccount = false;
  const { data: account } = await supabase
    .from("payment_provider_accounts")
    .select("id, tenant_id")
    .eq("provider", "moov")
    .eq("provider_account_id", providerAccountId)
    .eq("environment", environment)
    .maybeSingle();
  if (account) {
    tenant = tenant || account.tenant_id;
    isTenantOperatingAccount = true;
  }

  let stakeholders: any[] = [];
  if (tenant) {
    const { data } = await supabase
      .from("stakeholder_accounts")
      .select("id, tenant_id, provider_account_id, verification_status, verified_at, provider_last_four, provider_bank_name, provider_bank_account_id, account_type, origin, verification_recipient_email")
      .eq("tenant_id", tenant)
      .eq("is_active", true);
    stakeholders = data ?? [];
  } else {
    const linkedIds = (recipients ?? []).map((row: any) => row.stakeholder_account_id).filter(Boolean);
    const byLink = linkedIds.length
      ? ((await supabase
        .from("stakeholder_accounts")
        .select("id, tenant_id, provider_account_id, verification_status, verified_at, provider_last_four, provider_bank_name, provider_bank_account_id, account_type, origin, verification_recipient_email")
        .in("id", linkedIds)
        .eq("is_active", true)).data ?? [])
      : [];
    const { data: byAccount } = await supabase
      .from("stakeholder_accounts")
      .select("id, tenant_id, provider_account_id, verification_status, verified_at, provider_last_four, provider_bank_name, provider_bank_account_id, account_type, origin, verification_recipient_email")
      .eq("provider_account_id", providerAccountId)
      .eq("is_active", true);
    stakeholders = mergeStakeholderRows(byLink, byAccount ?? []);
  }

  const targets = resolveStakeholderVerificationTargets({
    providerAccountId,
    bankAccountID: event.bankAccountID,
    stakeholders,
    recipients: recipients ?? [],
    methods,
    isTenantOperatingAccount,
  });

  const lastFour = safeLastFour(event.lastFour);
  const incoming = interpretMoovBankStatus({
    status: event.status,
    lastFourAccountNumber: event.lastFour,
    bankAccountID: event.bankAccountID,
    bankName: event.bankName,
  }, verification ?? event.verification);

  for (const recipient of recipients ?? []) {
    const link = targets.recipientLinks.find((row) => row.recipientId === recipient.id);
    await supabase
      .from("external_payment_recipients")
      .update({
        onboarding_status: incoming === "verified" ? "ready" : (recipient.onboarding_status || "awaiting_bank"),
        provider_bank_name: event.bankName ?? recipient.provider_bank_name ?? null,
        provider_last_four: lastFour ?? recipient.provider_last_four ?? null,
        ...(link?.stakeholderId ? { stakeholder_account_id: link.stakeholderId } : {}),
      })
      .eq("id", recipient.id);
  }

  let updated = 0;
  for (const id of targets.stakeholderIds) {
    let current = stakeholders.find((row) => row.id === id);
    if (!current) {
      const { data } = await supabase
        .from("stakeholder_accounts")
        .select("id, verification_status, verified_at, provider_last_four, provider_bank_name, provider_bank_account_id")
        .eq("id", id)
        .maybeSingle();
      current = data;
    }
    if (!current) continue;
    const patch = stakeholderPatchFromBank(current, {
      bankAccountID: event.bankAccountID,
      bankName: event.bankName,
      lastFourAccountNumber: event.lastFour,
      status: event.status,
    }, verification ?? event.verification);
    const { error } = await supabase
      .from("stakeholder_accounts")
      .update({
        provider: "moov",
        provider_account_id: providerAccountId,
        ...patch,
      })
      .eq("id", current.id);
    if (!error) updated += 1;
  }

  return {
    updated,
    recipients: (recipients ?? []).length,
    stakeholderIds: targets.stakeholderIds,
    linked: targets.recipientLinks.length,
  };
}
