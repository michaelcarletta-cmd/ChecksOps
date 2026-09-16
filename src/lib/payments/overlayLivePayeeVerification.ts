export type LivePayeeSnapshot = {
  moov_account_id?: string | null;
  recipient_id?: string | null;
  stakeholder_account_ids?: string[];
  verification_status?: string | null;
  identity_verified?: boolean;
  bank_verified?: boolean;
  bank_name?: string | null;
  last_four?: string | null;
};

export function overlayLivePayeeVerification<T extends {
  id: string;
  provider_account_id?: string | null;
  verification_status?: string | null;
  verified_at?: string | null;
}>(accounts: T[], payees: LivePayeeSnapshot[] | null | undefined): T[] {
  if (!payees?.length) return accounts;
  const byStakeholder = new Map<string, LivePayeeSnapshot>();
  const byMoov = new Map<string, LivePayeeSnapshot>();
  for (const payee of payees) {
    if (payee.moov_account_id) byMoov.set(String(payee.moov_account_id), payee);
    for (const id of payee.stakeholder_account_ids ?? []) {
      byStakeholder.set(id, payee);
    }
  }
  return accounts.map((account) => {
    const live = byStakeholder.get(account.id)
      || (account.provider_account_id ? byMoov.get(String(account.provider_account_id)) : null);
    const liveVerified = live?.verification_status === "verified"
      || (live?.identity_verified === true && live?.bank_verified === true);
    if (!liveVerified) return account;
    if (account.verification_status === "verified" || account.verification_status === "admin_override") {
      return account;
    }
    return {
      ...account,
      verification_status: "verified",
      verified_at: account.verified_at || new Date().toISOString(),
    };
  });
}
