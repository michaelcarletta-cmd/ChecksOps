/**
 * Individual recipient ToS / KYC policy.
 *
 * The public pay-setup page must bind Moov.js Terms of Service to the existing
 * recipient connected account. Browser `accepted=true` is not authority.
 * Local RDS last4 / awaiting_bank never mark onboarding complete.
 */

export const RECIPIENT_TOS_DROP = 'moov-terms-of-service';

export const recipientTosDropScopes = (accountId) => {
  const id = String(accountId || '').trim();
  if (!id) return ['/ping.read'];
  return [
    `/accounts/${id}/profile.write`,
    `/accounts/${id}/profile.read`,
    '/ping.read',
  ];
};

export const dropTokenFromBody = (body = {}) => {
  const raw = body.terms_of_service_token ?? body.tos_token ?? '';
  const token = typeof raw === 'string' ? raw.trim() : '';
  return token.length >= 8 ? token : null;
};

export const rejectForgedRecipientTos = (body = {}) => {
  const token = dropTokenFromBody(body);
  if (body.accepted === true && !token) {
    return {
      error: 'tos_acceptance_forged',
      statusCode: 400,
      message: 'ToS acceptance requires a Moov.js-issued token. Browser accepted=true is not authority.',
    };
  }
  if (!token) {
    return {
      error: 'tos_drop_token_required',
      statusCode: 400,
      message: 'Accept the payment provider terms in the hosted component first.',
    };
  }
  return null;
};

export const tosBoundToRecipientAccount = ({
  recipientAccountId,
  requestedAccountId,
  environment,
} = {}) => {
  const expected = String(recipientAccountId || '').trim();
  const requested = requestedAccountId == null || requestedAccountId === ''
    ? null
    : String(requestedAccountId).trim();
  if (!expected) {
    return { ok: false, error: 'recipient_account_missing' };
  }
  if (requested && requested !== expected) {
    return { ok: false, error: 'tos_account_mismatch' };
  }
  const env = String(environment || '').toLowerCase();
  return {
    ok: true,
    account_id: expected,
    environment: env || null,
    production: env === 'production',
  };
};

export const liveTosAccepted = (account = {}) => Boolean(
  account?.termsOfService?.acceptedDate
  || account?.termsOfService?.acceptedOn
  || account?.termsOfService?.accepted === true,
);

export const capabilityRequirementNames = (capabilities = []) => {
  const list = Array.isArray(capabilities) ? capabilities : capabilities?.capabilities || [];
  const names = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) names.push(value.trim());
    else if (Array.isArray(value)) value.forEach(push);
    else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) push(nested);
    }
  };
  for (const row of list) {
    push(row?.requirements);
    push(row?.requirement);
  }
  return [...new Set(names)];
};

export const tosRequirementOutstanding = (capabilities = []) => (
  capabilityRequirementNames(capabilities).some((name) => /tos|terms/i.test(name))
);

export const identityRequirementsOutstanding = (capabilities = []) => (
  capabilityRequirementNames(capabilities).filter((name) => /^individual\.(address|birthdate|ssn)/i.test(name))
);

export const kycStatusFromMoov = (account = {}) => String(
  account?.profile?.individual?.verification?.status
  ?? account?.verification?.status
  ?? account?.verificationStatus
  ?? 'unverified',
).toLowerCase();

export const liveBankVerified = (banks = []) => (banks || []).some((row) => {
  const status = String(row?.verificationStatus || row?.status || '').toLowerCase();
  return status === 'verified';
});

export const tosConfirmedByMoov = ({
  account = {},
  capabilities = [],
  capabilitiesReadOk = true,
  tosOutstandingBefore = null,
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
} = {}) => {
  if (!account) return false;
  const tos = tosConfirmedByMoov({ account, capabilities, capabilitiesReadOk });
  const kyc = kycStatusFromMoov(account) === 'verified';
  const bank = liveBankVerified(banks);
  return Boolean(tos && kyc && bank);
};

export const cannotFalselyMarkComplete = (live) => !recipientOnboardingCompleteFromMoov(live);

export const resumeExistingMoovAccount = ({
  existingRecipient = null,
  createRequested = false,
} = {}) => {
  const accountId = existingRecipient?.provider_account_id || null;
  if (accountId) {
    return {
      create: false,
      duplicate: false,
      account_id: accountId,
      environment: existingRecipient.environment || null,
      resume: true,
    };
  }
  return {
    create: createRequested !== false,
    duplicate: false,
    account_id: null,
    resume: false,
  };
};

export const kybAccountCreateUnchanged = (body = {}) => ({
  accountType: 'business',
  requests_representatives: true,
  requests_send_funds: true,
  not_recipient_individual: body.accountType !== 'individual',
});

const str = (value, max = 120) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '');
const digits = (value, max = 20) => String(value ?? '').replace(/\D/g, '').slice(0, max);

/** PATCH body for individual KYC. SSN/DOB are forwarded to Moov only — never persisted locally. */
export const buildIndividualKycPatch = (input = {}) => {
  const firstName = str(input.first_name ?? input.firstName, 60);
  const lastName = str(input.last_name ?? input.lastName, 60);
  const email = str(input.email, 120);
  const phone = digits(input.phone, 10);
  const address1 = str(input.address_line1 ?? input.addressLine1, 100);
  const address2 = str(input.address_line2 ?? input.addressLine2, 100);
  const city = str(input.city, 60);
  const state = str(input.state ?? input.stateOrProvince, 2).toUpperCase();
  const postalCode = digits(input.postal_code ?? input.postalCode, 5);
  const birthDate = str(input.birth_date ?? input.birthDate, 10);
  const ssn = digits(input.ssn, 9);
  const dob = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  const missing = [];
  if (firstName.length < 1 || lastName.length < 1) missing.push('name');
  if (!email.includes('@')) missing.push('email');
  if (phone.length !== 10) missing.push('phone');
  if (!address1 || !city || state.length !== 2 || postalCode.length !== 5) missing.push('address');
  if (!dob) missing.push('birthdate');
  if (ssn.length !== 9) missing.push('ssn');
  if (missing.length) return { ok: false, error: 'kyc_fields_incomplete', missing };
  return {
    ok: true,
    body: {
      profile: {
        individual: {
          name: { firstName, lastName },
          email,
          phone: { number: phone, countryCode: '1' },
          address: {
            addressLine1: address1,
            ...(address2 ? { addressLine2: address2 } : {}),
            city,
            stateOrProvince: state,
            postalCode,
            country: 'US',
          },
          birthDate: { year: Number(dob[1]), month: Number(dob[2]), day: Number(dob[3]) },
          governmentID: { ssn: { full: ssn } },
        },
      },
    },
  };
};

export const shouldResumeExistingBank = ({ banks = [], replaceBank = false } = {}) => (
  Array.isArray(banks) && banks.length > 0 && replaceBank !== true
);

export const liveAccountReadFailed = (account) => account == null;
