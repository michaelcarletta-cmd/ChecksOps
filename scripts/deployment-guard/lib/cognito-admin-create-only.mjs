/**
 * Build the UpdateUserPool request that turns off Cognito self sign-up
 * (AdminCreateUserConfig.AllowAdminCreateUserOnly = true) and changes nothing else.
 *
 * UpdateUserPool resets every setting it is not given to its default (MFA, passkeys, email,
 * recovery, sign-in factors), so the request carries every mutable setting of the live
 * DescribeUserPool output. Only AllowAdminCreateUserOnly differs. Pure: no AWS calls.
 * Runbook: ops/deployment-guard/cognito-admin-create-only/README.md.
 */

// UpdateUserPool parameters copied as DescribeUserPool returns them.
const COPIED = Object.freeze([
  'Policies',
  'DeletionProtection',
  'LambdaConfig',
  'AutoVerifiedAttributes',
  'SmsVerificationMessage',
  'EmailVerificationMessage',
  'EmailVerificationSubject',
  'VerificationMessageTemplate',
  'SmsAuthenticationMessage',
  'UserAttributeUpdateSettings',
  'MfaConfiguration',
  'DeviceConfiguration',
  'EmailConfiguration',
  'SmsConfiguration',
  'UserPoolAddOns',
  'AccountRecoverySetting',
  'UserPoolTier',
]);

// DescribeUserPool fields UpdateUserPool cannot set (fixed at creation or computed), or that
// this request leaves alone (UserPoolTags).
export const NOT_UPDATABLE = Object.freeze([
  'UserPoolTags',
  'Arn', 'Id', 'IssuerConfiguration', 'KeyConfiguration', 'SchemaAttributes', 'UsernameAttributes',
  'AliasAttributes', 'Domain', 'CustomDomain', 'EstimatedNumberOfUsers', 'CreationDate',
  'LastModifiedDate', 'Status', 'SmsConfigurationFailure', 'EmailConfigurationFailure',
]);

const clone = (value) => JSON.parse(JSON.stringify(value));

export const buildAdminCreateOnlyUpdate = (userPool) => {
  if (!userPool || typeof userPool !== 'object' || !userPool.Id) throw new Error('userPool must be DescribeUserPool().UserPool');
  const request = { UserPoolId: userPool.Id };
  for (const key of COPIED) {
    if (userPool[key] !== undefined) request[key] = clone(userPool[key]);
  }
  if (userPool.Name !== undefined) request.PoolName = userPool.Name;
  // Tags are never sent. UserPoolTags replaces the whole tag set, so on a pool that carries aws:*
  // system tags (production: aws:cloudformation:*) Cognito refuses the call ("not allowed to mutate
  // system tags") and, on 2026-10-30, still recorded the settings without enforcing them. Tags are
  // checked after the update and any user tag missing is restored with TagResource.
  // UnusedAccountValidityDays is superseded by Policies.PasswordPolicy.TemporaryPasswordValidityDays,
  // and Cognito refuses a request that sets both.
  const { UnusedAccountValidityDays, ...adminCreate } = clone(userPool.AdminCreateUserConfig || {});
  if (UnusedAccountValidityDays !== undefined && request.Policies?.PasswordPolicy?.TemporaryPasswordValidityDays === undefined) {
    throw new Error('UnusedAccountValidityDays without PasswordPolicy.TemporaryPasswordValidityDays: review by hand');
  }
  request.AdminCreateUserConfig = { ...adminCreate, AllowAdminCreateUserOnly: true };
  return request;
};
