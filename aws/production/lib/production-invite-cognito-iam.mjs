/**
 * Surgical merge/verify for tenant-invite Cognito on the live
 * checksops-production-api-execution role. Pure functions only.
 * Does not call AWS. Does not rewrite non-Cognito statements.
 */

export const ROLE_NAME = 'checksops-production-api-execution';
export const POLICY_NAME = 'ProductionApiLeastPrivilege';
export const PRODUCTION_POOL_ARN = 'arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_h00WorYMT';
export const STAGING_POOL_ID = 'us-east-1_vPmQ7cL1F';
export const COGNITO_SID = 'TenantInviteUserProductionCognito';

export const REQUIRED_ACTIONS = Object.freeze([
  'cognito-idp:AdminCreateUser',
  'cognito-idp:AdminGetUser',
  'cognito-idp:AdminSetUserPassword',
]);

export const FORBIDDEN_ACTIONS = Object.freeze([
  'cognito-idp:*',
  'cognito-idp:AdminDisableUser',
  'cognito-idp:AdminDeleteUser',
  'cognito-idp:AdminUpdateUserAttributes',
]);

export const INVITE_COGNITO_STATEMENT = Object.freeze({
  Sid: COGNITO_SID,
  Effect: 'Allow',
  Action: [...REQUIRED_ACTIONS],
  Resource: PRODUCTION_POOL_ARN,
});

const clone = (value) => JSON.parse(JSON.stringify(value));

const asList = (value) => {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
};

const sorted = (values) => [...values].map(String).sort();

const sameStringSet = (left, right) => (
  JSON.stringify(sorted(asList(left))) === JSON.stringify(sorted(asList(right)))
);

export const isCognitoStatement = (statement = {}) => (
  asList(statement.Action).some((action) => String(action).startsWith('cognito-idp:'))
  || String(statement.Sid || '').includes('Cognito')
);

export const collectCognitoActions = (document = {}) => {
  const actions = [];
  for (const statement of asList(document.Statement)) {
    for (const action of asList(statement.Action)) {
      if (String(action).startsWith('cognito-idp:')) actions.push(String(action));
    }
  }
  return actions;
};

export const findForbiddenCognito = (document = {}) => {
  const found = [];
  for (const statement of asList(document.Statement)) {
    const actions = asList(statement.Action).map(String);
    const resources = asList(statement.Resource).map(String);
    for (const action of actions) {
      if (FORBIDDEN_ACTIONS.includes(action) || action === 'cognito-idp:*') {
        found.push({ action, sid: statement.Sid || null, resource: resources });
      }
    }
    if (resources.some((resource) => resource.includes(STAGING_POOL_ID) || resource === '*')) {
      if (actions.some((action) => action.startsWith('cognito-idp:'))) {
        found.push({ action: actions.join(','), sid: statement.Sid || null, resource: resources });
      }
    }
  }
  return found;
};

export const nonCognitoStatements = (document = {}) => (
  asList(document.Statement).filter((statement) => !isCognitoStatement(statement))
);

export const verifyNonCognitoPreserved = (before, after) => {
  const left = nonCognitoStatements(before);
  const right = nonCognitoStatements(after);
  return JSON.stringify(left) === JSON.stringify(right);
};

export const hasExactInviteCognitoStatement = (document = {}) => (
  asList(document.Statement).some((statement) => (
    statement.Sid === COGNITO_SID
    && statement.Effect === 'Allow'
    && sameStringSet(statement.Action, REQUIRED_ACTIONS)
    && sameStringSet(statement.Resource, [PRODUCTION_POOL_ARN])
  ))
);

export const verifyInviteCognitoPolicy = (document = {}) => {
  const actions = collectCognitoActions(document);
  const forbidden = findForbiddenCognito(document);
  const missing = REQUIRED_ACTIONS.filter((action) => !actions.includes(action));
  const extra = actions.filter((action) => !REQUIRED_ACTIONS.includes(action));
  const resources = asList(document.Statement)
    .filter(isCognitoStatement)
    .flatMap((statement) => asList(statement.Resource).map(String));
  const ok = (
    missing.length === 0
    && extra.length === 0
    && forbidden.length === 0
    && hasExactInviteCognitoStatement(document)
    && resources.every((resource) => resource === PRODUCTION_POOL_ARN)
  );
  return {
    ok,
    requiredPresent: missing.length === 0,
    missing,
    extra,
    forbidden,
    resourceExact: resources.length > 0 && resources.every((resource) => resource === PRODUCTION_POOL_ARN),
    resources,
    hasWildcard: actions.includes('cognito-idp:*') || resources.includes('*'),
  };
};

export const mergeInviteCognitoStatement = (policyDocument) => {
  if (!policyDocument || typeof policyDocument !== 'object') {
    throw new Error('policy document is required');
  }
  const document = clone(policyDocument);
  document.Version = document.Version || '2012-10-17';
  document.Statement = asList(document.Statement).map((statement) => clone(statement));

  const forbidden = findForbiddenCognito(document);
  if (forbidden.length) {
    throw new Error(`live policy already contains forbidden Cognito grants: ${JSON.stringify(forbidden)}`);
  }

  const existingInvite = document.Statement.find((statement) => statement.Sid === COGNITO_SID);
  if (existingInvite) {
    const same = (
      existingInvite.Effect === 'Allow'
      && sameStringSet(existingInvite.Action, REQUIRED_ACTIONS)
      && sameStringSet(existingInvite.Resource, [PRODUCTION_POOL_ARN])
    );
    if (!same) {
      throw new Error(`existing ${COGNITO_SID} statement does not match the required invite grant`);
    }
    return { document, changed: false, reason: 'already_present' };
  }

  const otherCognito = document.Statement.filter((statement) => (
    statement.Sid !== COGNITO_SID && isCognitoStatement(statement)
  ));
  if (otherCognito.length) {
    throw new Error('live policy has unexpected Cognito statements; refusing to merge');
  }

  document.Statement.push(clone(INVITE_COGNITO_STATEMENT));
  return { document, changed: true, reason: 'appended' };
};
