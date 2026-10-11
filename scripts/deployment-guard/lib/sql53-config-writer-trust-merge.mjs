import { CODES, fail, ok } from './errors.mjs';

export const SQL53_CONFIG_WRITER_ROLE = 'ChecksOpsProductionSql53ConfigWriter';
export const SQL53_CONFIG_WRITER_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api';
export const SQL53_CONFIG_WRITER_OIDC_PROVIDER = 'arn:aws:iam::806168576068:oidc-provider/api.cursor.com';
export const SQL53_CONFIG_WRITER_OIDC_SUB = 'user:325724407';
export const SQL53_CONFIG_WRITER_OIDC_AUD = 'sts.amazonaws.com';
export const SQL53_CONFIG_WRITER_OIDC_SID = 'AllowOwnerCursorCloudOidcFingerprintOnly';

export const SQL53_CONFIG_WRITER_REQUIRED_ACTIONS = Object.freeze([
  'lambda:GetFunctionConfiguration',
  'lambda:UpdateFunctionConfiguration',
  'lambda:InvokeFunction',
]);

export const SQL53_CONFIG_WRITER_OIDC_STATEMENT = Object.freeze({
  Sid: SQL53_CONFIG_WRITER_OIDC_SID,
  Effect: 'Allow',
  Principal: {
    Federated: SQL53_CONFIG_WRITER_OIDC_PROVIDER,
  },
  Action: 'sts:AssumeRoleWithWebIdentity',
  Condition: {
    StringEquals: {
      'api.cursor.com:aud': SQL53_CONFIG_WRITER_OIDC_AUD,
      'api.cursor.com:sub': SQL53_CONFIG_WRITER_OIDC_SUB,
    },
  },
});

const REJECTED_TRUST_MARKERS = Object.freeze([
  'ChecksOpsCursorCloudStaging',
  'ChecksOpsGitHubProductionReadOnlyInspect',
  'ChecksOpsGitHubStaging',
  'token.actions.githubusercontent.com',
  'oidc.cursor.sh',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  const canonicalize = (input) => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonicalize(input[key])]));
    }
    return input;
  };
  return JSON.stringify(canonicalize(value));
}

function statementText(statement) {
  return JSON.stringify(statement);
}

function hasIdentityCenterAdministratorAccess(statements) {
  return statements.some((statement) => {
    if (statement?.Effect !== 'Allow') return false;
    const text = statementText(statement);
    const action = statement.Action;
    const actions = Array.isArray(action) ? action : [action];
    return actions.includes('sts:AssumeRole')
      && /sso\.amazonaws\.com|AWSReservedSSO_AdministratorAccess/.test(text);
  });
}

function existingOidcStatement(statements) {
  return statements.find((statement) => {
    const federated = statement?.Principal?.Federated;
    return federated === SQL53_CONFIG_WRITER_OIDC_PROVIDER
      || (Array.isArray(federated) && federated.includes(SQL53_CONFIG_WRITER_OIDC_PROVIDER));
  });
}

function rejectedTrust(statements) {
  const text = statements.map(statementText).join('\n');
  return REJECTED_TRUST_MARKERS.filter((marker) => text.includes(marker));
}

export function isIdentityCenterAdministratorIdentity(identity) {
  return identity?.Account === '806168576068'
    && /^arn:aws:sts::806168576068:assumed-role\/AWSReservedSSO_AdministratorAccess_[A-Za-z0-9]+\/[^/]+$/.test(String(identity?.Arn || ''));
}

export function permissionsRemainSql53Only(policy) {
  const statements = policy?.Statement;
  if (!Array.isArray(statements) || statements.length !== 1) return false;
  const statement = statements[0];
  if (statement.Effect !== 'Allow' || statement.Resource !== SQL53_CONFIG_WRITER_FUNCTION_ARN) return false;
  const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  return stableJson(actions) === stableJson(SQL53_CONFIG_WRITER_REQUIRED_ACTIONS);
}

export function isApprovedCursorOidcStatement(statement) {
  if (!statement) return false;
  return stableJson(statement) === stableJson(SQL53_CONFIG_WRITER_OIDC_STATEMENT)
    || stableJson({ ...statement, Sid: SQL53_CONFIG_WRITER_OIDC_SID }) === stableJson(SQL53_CONFIG_WRITER_OIDC_STATEMENT);
}

export function compareSql53ConfigWriterTrust(before = {}, after = {}) {
  const beforeStatements = Array.isArray(before.Statement) ? before.Statement : [];
  const afterStatements = Array.isArray(after.Statement) ? after.Statement : [];
  const afterKeys = new Set(afterStatements.map(stableJson));
  const beforeKeys = new Set(beforeStatements.map(stableJson));
  const removed = beforeStatements.filter((statement) => !afterKeys.has(stableJson(statement)));
  const added = afterStatements.filter((statement) => !beforeKeys.has(stableJson(statement)));
  const unchanged = beforeStatements.filter((statement) => afterKeys.has(stableJson(statement)));
  return ok({
    removed,
    added,
    unchanged,
    identity_center_preserved: hasIdentityCenterAdministratorAccess(afterStatements),
    only_approved_cursor_oidc_removed: added.length === 0
      && removed.length === 1
      && isApprovedCursorOidcStatement(removed[0]),
    permissions_document_untouched: true,
  });
}

export function removeSql53ConfigWriterOidcTrust(current = {}) {
  const statements = current.Statement;
  if (current.Version !== '2012-10-17' || !Array.isArray(statements) || statements.length < 1) {
    return fail(CODES.INVALID_MANIFEST, 'current SQL53 writer trust is missing or empty; refuse to replace it');
  }
  if (!hasIdentityCenterAdministratorAccess(statements)) {
    return fail(CODES.UNRELATED_MUTATION, 'current trust does not preserve the Identity Center AdministratorAccess allow');
  }
  const rejected = rejectedTrust(statements);
  if (rejected.length) {
    return fail(CODES.UNRELATED_MUTATION, 'current trust already names a rejected principal', { rejected });
  }

  const index = statements.findIndex((statement) => {
    const federated = statement?.Principal?.Federated;
    return federated === SQL53_CONFIG_WRITER_OIDC_PROVIDER
      || (Array.isArray(federated) && federated.includes(SQL53_CONFIG_WRITER_OIDC_PROVIDER));
  });
  if (index < 0) {
    return ok({
      changed: false,
      document: {
        Version: '2012-10-17',
        Statement: clone(statements),
      },
    });
  }

  const existing = statements[index];
  if (!isApprovedCursorOidcStatement(existing)) {
    return fail(CODES.UNRELATED_MUTATION, 'current trust has a different Cursor OIDC statement; refuse to remove it');
  }

  const remaining = statements.filter((_, statementIndex) => statementIndex !== index);
  if (!hasIdentityCenterAdministratorAccess(remaining)) {
    return fail(CODES.UNRELATED_MUTATION, 'removing the Cursor OIDC statement would drop Identity Center AdministratorAccess');
  }
  if (existingOidcStatement(remaining)) {
    return fail(CODES.UNRELATED_MUTATION, 'another Cursor OIDC statement would remain after cleanup');
  }

  const document = {
    Version: '2012-10-17',
    Statement: clone(remaining),
  };
  const comparison = compareSql53ConfigWriterTrust({ Version: '2012-10-17', Statement: statements }, document);
  if (!comparison.ok || comparison.details.only_approved_cursor_oidc_removed !== true) {
    return fail(CODES.UNRELATED_MUTATION, 'cleanup comparison is not limited to the approved Cursor OIDC statement');
  }

  return ok({
    changed: true,
    removed_statement: clone(SQL53_CONFIG_WRITER_OIDC_STATEMENT),
    document,
    comparison: comparison.details,
  });
}

export function mergeSql53ConfigWriterOidcTrust(current = {}) {
  const statements = current.Statement;
  if (current.Version !== '2012-10-17' || !Array.isArray(statements) || statements.length < 1) {
    return fail(CODES.INVALID_MANIFEST, 'current SQL53 writer trust is missing or empty; refuse to replace it');
  }
  if (!hasIdentityCenterAdministratorAccess(statements)) {
    return fail(CODES.UNRELATED_MUTATION, 'current trust does not preserve the Identity Center AdministratorAccess allow');
  }
  const rejected = rejectedTrust(statements);
  if (rejected.length) {
    return fail(CODES.UNRELATED_MUTATION, 'current trust already names a rejected principal', { rejected });
  }

  const existing = existingOidcStatement(statements);
  if (existing) {
    if (stableJson(existing) !== stableJson(SQL53_CONFIG_WRITER_OIDC_STATEMENT)
      && stableJson({ ...existing, Sid: SQL53_CONFIG_WRITER_OIDC_SID }) !== stableJson(SQL53_CONFIG_WRITER_OIDC_STATEMENT)) {
      return fail(CODES.UNRELATED_MUTATION, 'current trust already has a different Cursor OIDC statement');
    }
    return ok({
      changed: false,
      document: {
        Version: '2012-10-17',
        Statement: clone(statements),
      },
    });
  }

  return ok({
    changed: true,
    additive_statement: clone(SQL53_CONFIG_WRITER_OIDC_STATEMENT),
    document: {
      Version: '2012-10-17',
      Statement: [...clone(statements), clone(SQL53_CONFIG_WRITER_OIDC_STATEMENT)],
    },
  });
}
