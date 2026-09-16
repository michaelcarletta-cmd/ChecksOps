/**
 * Locked production Cognito mappings repaired 2026-09-14T10:07:27.787Z.
 * Staging/rehearsal/test writers must not change these rows.
 * Authorized production identity repair requires
 * current_setting('request.production_identity_write') = '1'.
 */
export const PRODUCTION_IDENTITY_WRITE_GUC = 'request.production_identity_write';

export const PRODUCTION_COGNITO_LOCKS = Object.freeze([
  { application_user_id: '0160a5f3-30a4-4aba-8e54-6529f1ceb0d4', cognito_sub: 'd418a4f8-80f1-70d6-36c9-fe490220bf4a' },
  { application_user_id: '30d0505c-bcfa-4732-81fd-869dc46da5dd', cognito_sub: '34388468-a021-7036-c34d-2ff14a20ed40' },
  { application_user_id: '3af0234c-de1b-4819-938d-fa4f9390811b', cognito_sub: '24d874d8-80d1-7092-7f34-48b8704702f8' },
  { application_user_id: '7dbb3009-f059-4767-b5dc-1c5c72379330', cognito_sub: 'a45884b8-d051-70b3-b19d-ca704964c6e8' },
  { application_user_id: 'abd3c2a0-6dc0-4680-92dd-a013e1141c91', cognito_sub: 'f468b438-4081-7004-d865-a1b86eb19beb' },
  { application_user_id: 'b100f05d-9e81-4a7b-b9cc-9baf173131d9', cognito_sub: '34c8a478-e0d1-70f3-3c49-02225e7404b6' },
  { application_user_id: 'e2ad0849-c6b6-4f4a-a68a-8c52f563c6fd', cognito_sub: '647894c8-2011-70d4-e874-efd4b080700e' },
  { application_user_id: 'fd857564-9534-4b0f-95ac-624ed1273725', cognito_sub: '74286478-c0c1-7068-9fea-9deea6f61627' },
]);

export const PRODUCTION_LOCKED_IDS = Object.freeze(
  PRODUCTION_COGNITO_LOCKS.map((row) => row.application_user_id),
);

export const PRODUCTION_LOCKED_SUBS = Object.freeze(
  PRODUCTION_COGNITO_LOCKS.map((row) => row.cognito_sub),
);

export const lockedCognitoSub = (applicationUserId) => (
  PRODUCTION_COGNITO_LOCKS.find((row) => row.application_user_id === applicationUserId)?.cognito_sub || null
);

export const lockedApplicationUserId = (cognitoSub) => (
  PRODUCTION_COGNITO_LOCKS.find((row) => row.cognito_sub === cognitoSub)?.application_user_id || null
);

export const isLockedApplicationUserId = (applicationUserId) => (
  PRODUCTION_LOCKED_IDS.includes(String(applicationUserId || ''))
);

export const refusesStagingOverwrite = ({ applicationUserId, cognitoSub } = {}) => {
  const locked = lockedCognitoSub(applicationUserId);
  if (locked) {
    if (!cognitoSub) return true;
    if (String(cognitoSub) !== String(locked)) return true;
  }
  const lockedUser = lockedApplicationUserId(cognitoSub);
  if (lockedUser && String(applicationUserId) !== String(lockedUser)) return true;
  return false;
};

export const isStagingLikeIdentityEnv = (env = process.env.CHECKSOPS_ENV) => {
  const value = String(env || '').trim().toLowerCase();
  if (!value) return true;
  return value === 'staging'
    || value.includes('rehearsal')
    || value.includes('test')
    || value === 'development'
    || value === 'onboard';
};

const lockedError = () => {
  const error = new Error('production_cognito_mapping_locked');
  error.code = 'production_cognito_mapping_locked';
  error.statusCode = 403;
  return error;
};

/** Staging/rehearsal/test/onboarding oneshots must never write locked rows. */
export const assertOneshotCognitoWriteAllowed = (applicationUserId) => {
  if (isLockedApplicationUserId(applicationUserId)) throw lockedError();
};

/**
 * Tenant-admin / API writers: staging-like envs cannot touch locked users.
 * Any env cannot replace a locked sub or steal a locked sub onto another user.
 */
export const assertProductionCognitoWriteAllowed = ({
  applicationUserId,
  cognitoSub,
  env = process.env.CHECKSOPS_ENV,
} = {}) => {
  if (isStagingLikeIdentityEnv(env) && isLockedApplicationUserId(applicationUserId)) {
    throw lockedError();
  }
  if (refusesStagingOverwrite({ applicationUserId, cognitoSub })) {
    throw lockedError();
  }
};

export const PRODUCTION_COGNITO_POOL_ID = 'us-east-1_h00WorYMT';
export const PRODUCTION_COGNITO_CLIENT_ID = '3ja9fqaq2fjkv3i6up2varcqpe';
export const STAGING_COGNITO_POOL_ID = 'us-east-1_vPmQ7cL1F';
export const STAGING_COGNITO_CLIENT_ID = '71bb7a192cbl6o6s8m259tl589';
export const STAGING_API_ID = 'psr19uhop4';
export const PRODUCTION_PREP_API_ID = 'kiqojucc02';
export const PRODUCTION_API_TARGET = '/prep';
