import { EXPECTED_EIGHT, NINTH_ID } from './expected-mappings.mjs';

export const classifyNinthUuid = () => ({
  applicationUserId: NINTH_ID,
  classification: 'orphan_unlinked',
  cognitoInvite: false,
  inventEmail: false,
  mintCognito: false,
  addProfile: false,
  failClosed: true,
  reason: 'no email, no profile, no tenant_users; global admin+staff leftover',
});

export const identityInviteApplicationUserIds = () => EXPECTED_EIGHT.map((row) => row.applicationUserId);

export const ninthExcludedFromInvite = () => !identityInviteApplicationUserIds().includes(NINTH_ID);
