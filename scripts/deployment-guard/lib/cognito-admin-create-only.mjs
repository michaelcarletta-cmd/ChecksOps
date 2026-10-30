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

// DescribeUserPool fields UpdateUserPool cannot set (fixed at creation or computed).
export const NOT_UPDATABLE = Object.freeze([
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
  // aws:* tags belong to AWS (CloudFormation) and cannot be written.
  const tags = Object.fromEntries(Object.entries(userPool.UserPoolTags || {}).filter(([key]) => !key.startsWith('aws:')));
  if (Object.keys(tags).length) request.UserPoolTags = tags;
  // UnusedAccountValidityDays is superseded by Policies.PasswordPolicy.TemporaryPasswordValidityDays,
  // and Cognito refuses a request that sets both.
  const { UnusedAccountValidityDays, ...adminCreate } = clone(userPool.AdminCreateUserConfig || {});
  if (UnusedAccountValidityDays !== undefined && request.Policies?.PasswordPolicy?.TemporaryPasswordValidityDays === undefined) {
    throw new Error('UnusedAccountValidityDays without PasswordPolicy.TemporaryPasswordValidityDays: review by hand');
  }
  request.AdminCreateUserConfig = { ...adminCreate, AllowAdminCreateUserOnly: true };
  return request;
};
