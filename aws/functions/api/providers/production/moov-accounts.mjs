/** Known production Moov accounts that already completed KYB/KYC. Do not re-onboard. */

export const KNOWN_APPROVED_MOOV = Object.freeze({
  freedom: Object.freeze({
    label: 'Freedom Adjustment',
    tenantId: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
    moovAccountId: '60922058-7eca-4889-81dd-5720d7b9de96',
    walletId: '3e6286ca-a19c-45f6-aad9-f73dac5f0358',
    bankId: '61062c38-a79e-4f62-bb64-32ddecf3d37c',
    achDebitFundPm: 'a02c1c81-9ca6-434d-accc-ea4471a70ef2',
    walletPm: '744ea734-f5e3-4b31-bb92-38f85fd29b91',
    achCreditStandardPm: '7a78a544-340d-46fd-a4a4-228661374da7',
  }),
  c1c: Object.freeze({
    label: 'Condition One Commercial',
    tenantId: '4f172140-f57a-4744-8050-95f4f07b13b4',
    moovAccountId: '817e1bf0-e1f7-4e9e-95a8-ce15bfa31708',
  }),
  platform: Object.freeze({
    label: 'ChecksOps facilitator',
    moovAccountId: '41cb5d67-4911-4bef-aad5-d8ee9c582208',
    email: 'checksopsadmin@gmail.com',
  }),
  recipient: Object.freeze({
    label: 'Pay-setup recipient',
    recipientId: '62a858ff-ee6a-49d7-9898-1c8e4a44227b',
    moovAccountId: 'ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f',
    bankId: '72eb66c1-d9a9-4f85-ab50-8871db9ceeea',
    achCreditStandardPm: '15b6185b-ec16-4e9d-97b4-555a54d326b9',
    walletPm: '1c58bbea-8f55-42b2-b794-25c30eecdadc',
  }),
});

export const APPROVED_MOOV_ACCOUNT_IDS = Object.freeze(new Set([
  KNOWN_APPROVED_MOOV.freedom.moovAccountId,
  KNOWN_APPROVED_MOOV.c1c.moovAccountId,
  KNOWN_APPROVED_MOOV.platform.moovAccountId,
  KNOWN_APPROVED_MOOV.recipient.moovAccountId,
]));

/**
 * Leftover connected accounts from earlier pipelines. Verified or not, do
 * not KYC, capability-request, or send through these ids.
 */
export const DENIED_DUPLICATE_MOOV_ACCOUNT_IDS = Object.freeze(new Set([
  '7c50c273-89ec-4651-addc-f27330fd4360',
  '7597a1f1-79c8-4c80-bbfd-fd5906c2bb73',
]));

const normalizeAccountId = (accountId) => String(accountId || '').trim().toLowerCase();

export const isKnownApprovedMoovAccount = (accountId) =>
  APPROVED_MOOV_ACCOUNT_IDS.has(normalizeAccountId(accountId));

export const isDeniedDuplicateMoovAccount = (accountId) =>
  DENIED_DUPLICATE_MOOV_ACCOUNT_IDS.has(normalizeAccountId(accountId));

export const knownApprovedForTenant = (tenantId) => {
  const id = String(tenantId || '').trim().toLowerCase();
  if (id === KNOWN_APPROVED_MOOV.freedom.tenantId) return KNOWN_APPROVED_MOOV.freedom;
  if (id === KNOWN_APPROVED_MOOV.c1c.tenantId) return KNOWN_APPROVED_MOOV.c1c;
  return null;
};
