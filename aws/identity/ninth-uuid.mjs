import { EXPECTED_EIGHT, NINTH_ID } from './expected-mappings.mjs';

export const classifyNinthUuid = () => ({
  applicationUserId: NINTH_ID,
  classification: 'not_found',
  liveProduction: 'not_found',
  cognitoInvite: false,
  inventEmail: false,
  mintCognito: false,
  addProfile: false,
  failClosed: true,
  reason: 'live production profiles, tenant_users, user_roles, and identity_map do not contain this UUID; earlier admin+staff leftover notes were staging overlay, not a Lovable login',
});

export const identityInviteApplicationUserIds = () => EXPECTED_EIGHT.map((row) => row.applicationUserId);

export const ninthExcludedFromInvite = () => !identityInviteApplicationUserIds().includes(NINTH_ID);
