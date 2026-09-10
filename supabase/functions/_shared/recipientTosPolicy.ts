/**
 * Individual recipient ToS / KYC policy (Edge copy).
 * Keep in sync with aws/functions/api/providers/moov-recipient-tos-policy.mjs.
 */

export const recipientTosDropScopes = (accountId: string) => {
  const id = String(accountId || "").trim();
  if (!id) return ["/ping.read"];
  return [
    `/accounts/${id}/profile.write`,
    `/accounts/${id}/profile.read`,
    "/ping.read",
  ];
};

export const dropTokenFromBody = (body: Record<string, unknown> = {}) => {
  const raw = body.terms_of_service_token ?? body.tos_token ?? "";
  const token = typeof raw === "string" ? raw.trim() : "";
  return token.length >= 8 ? token : null;
};

export const rejectForgedRecipientTos = (body: Record<string, unknown> = {}) => {
  const token = dropTokenFromBody(body);
  if (body.accepted === true && !token) {
    return {
      error: "tos_acceptance_forged",
      statusCode: 400,
      message: "ToS acceptance requires a Moov.js-issued token. Browser accepted=true is not authority.",
    };
  }
  if (!token) {
    return {
      error: "tos_drop_token_required",
      statusCode: 400,
      message: "Accept the payment provider terms in the hosted component first.",
    };
  }
  return null;
};

export const tosBoundToRecipientAccount = (input: {
  recipientAccountId?: string | null;
  requestedAccountId?: string | null;
  environment?: string | null;
}) => {
  const expected = String(input.recipientAccountId || "").trim();
  const requested = input.requestedAccountId == null || input.requestedAccountId === ""
    ? null
    : String(input.requestedAccountId).trim();
  if (!expected) return { ok: false as const, error: "recipient_account_missing" };
  if (requested && requested !== expected) {
    return { ok: false as const, error: "tos_account_mismatch" };
  }
  const env = String(input.environment || "").toLowerCase();
  return { ok: true as const, account_id: expected, environment: env || null, production: env === "production" };
};

export const liveTosAccepted = (account: any = {}) => Boolean(
  account?.termsOfService?.acceptedDate
  || account?.termsOfService?.acceptedOn
  || account?.termsOfService?.accepted === true,
);

export const capabilityRequirementNames = (capabilities: any = []) => {
  const list = Array.isArray(capabilities) ? capabilities : capabilities?.capabilities || [];
  const names: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) names.push(value.trim());
    else if (Array.isArray(value)) value.forEach(push);
    else if (value && typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) push(nested);
    }
  };
  for (const row of list) {
    push(row?.requirements);
    push(row?.requirement);
  }
  return [...new Set(names)];
};

export const tosRequirementOutstanding = (capabilities: any = []) =>
  capabilityRequirementNames(capabilities).some((name) => /tos|terms/i.test(name));

export const identityRequirementsOutstanding = (capabilities: any = []) =>
  capabilityRequirementNames(capabilities).filter((name) => /^individual\.(address|birthdate|ssn)/i.test(name));

export const kycStatusFromMoov = (account: any = {}) => String(
  account?.profile?.individual?.verification?.status
  ?? account?.verification?.status
  ?? account?.verificationStatus
  ?? "unverified",
).toLowerCase();

export const liveBankVerified = (banks: any[] = []) => (banks || []).some((row) => {
  const status = String(row?.verificationStatus || row?.status || "").toLowerCase();
  return status === "verified";
});

export const tosConfirmedByMoov = ({
  account = {},
  capabilities = [],
  capabilitiesReadOk = true,
  tosOutstandingBefore = null as boolean | null,
}: {
  account?: any;
  capabilities?: any;
  capabilitiesReadOk?: boolean;
  tosOutstandingBefore?: boolean | null;
} = {}) => {
  if (liveTosAccepted(account)) return true;
  if (!capabilitiesReadOk) return false;
  const outstanding = tosRequirementOutstanding(capabilities);
  if (tosOutstandingBefore === true && outstanding === false) return true;
  return false;
};

export const recipientOnboardingCompleteFromMoov = ({
  account = null,
  banks = [],
  capabilities = [],
  capabilitiesReadOk = true,
}: {
  account?: any;
  banks?: any[];
  capabilities?: any;
  capabilitiesReadOk?: boolean;
} = {}) => {
  if (!account) return false;
  const tos = tosConfirmedByMoov({ account, capabilities, capabilitiesReadOk });
  const kyc = kycStatusFromMoov(account) === "verified";
  const bank = liveBankVerified(banks);
  return Boolean(tos && kyc && bank);
};

const listOf = (payload: any) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.capabilities)) return payload.capabilities;
  if (Array.isArray(payload?.bankAccounts)) return payload.bankAccounts;
  return [];
};

export const listMoovList = listOf;
