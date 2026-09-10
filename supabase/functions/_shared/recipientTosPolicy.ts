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

const str = (value: unknown, max = 120) =>
  (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : "");
const digitsOnly = (value: unknown, max = 20) => String(value ?? "").replace(/\D/g, "").slice(0, max);

export const buildIndividualKycPatch = (input: Record<string, unknown> = {}) => {
  const firstName = str(input.first_name ?? input.firstName, 60);
  const lastName = str(input.last_name ?? input.lastName, 60);
  const email = str(input.email, 120);
  const phone = digitsOnly(input.phone, 10);
  const address1 = str(input.address_line1 ?? input.addressLine1, 100);
  const address2 = str(input.address_line2 ?? input.addressLine2, 100);
  const city = str(input.city, 60);
  const state = str(input.state ?? input.stateOrProvince, 2).toUpperCase();
  const postalCode = digitsOnly(input.postal_code ?? input.postalCode, 5);
  const birthDate = str(input.birth_date ?? input.birthDate, 10);
  const ssn = digitsOnly(input.ssn, 9);
  const dob = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  const missing: string[] = [];
  if (firstName.length < 1 || lastName.length < 1) missing.push("name");
  if (!email.includes("@")) missing.push("email");
  if (phone.length !== 10) missing.push("phone");
  if (!address1 || !city || state.length !== 2 || postalCode.length !== 5) missing.push("address");
  if (!dob) missing.push("birthdate");
  if (ssn.length !== 9) missing.push("ssn");
  if (missing.length) return { ok: false as const, error: "kyc_fields_incomplete", missing };
  return {
    ok: true as const,
    body: {
      profile: {
        individual: {
          name: { firstName, lastName },
          email,
          phone: { number: phone, countryCode: "1" },
          address: {
            addressLine1: address1,
            ...(address2 ? { addressLine2: address2 } : {}),
            city,
            stateOrProvince: state,
            postalCode,
            country: "US",
          },
          birthDate: { year: Number(dob[1]), month: Number(dob[2]), day: Number(dob[3]) },
          governmentID: { ssn: { full: ssn } },
        },
      },
    },
  };
};

export const shouldResumeExistingBank = ({
  banks = [],
  replaceBank = false,
}: { banks?: any[]; replaceBank?: boolean } = {}) =>
  Array.isArray(banks) && banks.length > 0 && replaceBank !== true;

export const liveAccountReadFailed = (account: unknown) => account == null;
