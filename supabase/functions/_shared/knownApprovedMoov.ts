/**
 * Production Moov accounts that already completed KYB/KYC. Never re-onboard.
 * Keep in sync with aws/functions/api/providers/production/moov-accounts.mjs.
 */
export const KNOWN_APPROVED_MOOV = {
  freedom: {
    label: "Freedom Adjustment",
    tenantId: "2eff5f1a-929d-4ce3-9a8b-cd96b98df42a",
    moovAccountId: "60922058-7eca-4889-81dd-5720d7b9de96",
    walletId: "3e6286ca-a19c-45f6-aad9-f73dac5f0358",
  },
  c1c: {
    label: "Condition One Commercial",
    tenantId: "4f172140-f57a-4744-8050-95f4f07b13b4",
    moovAccountId: "817e1bf0-e1f7-4e9e-95a8-ce15bfa31708",
  },
  recipient: {
    label: "Pay-setup recipient",
    recipientId: "62a858ff-ee6a-49d7-9898-1c8e4a44227b",
    moovAccountId: "ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f",
  },
} as const;

export const DENIED_DUPLICATE_MOOV_ACCOUNT_IDS = new Set([
  "7c50c273-89ec-4651-addc-f27330fd4360",
  "7597a1f1-79c8-4c80-bbfd-fd5906c2bb73",
]);

const normalize = (id: string | null | undefined) => String(id || "").trim().toLowerCase();

export const isDeniedDuplicateMoovAccount = (accountId: string | null | undefined) =>
  DENIED_DUPLICATE_MOOV_ACCOUNT_IDS.has(normalize(accountId));

export const knownApprovedForTenant = (tenantId: string | null | undefined) => {
  const id = normalize(tenantId);
  if (id === KNOWN_APPROVED_MOOV.freedom.tenantId) return KNOWN_APPROVED_MOOV.freedom;
  if (id === KNOWN_APPROVED_MOOV.c1c.tenantId) return KNOWN_APPROVED_MOOV.c1c;
  return null;
};
