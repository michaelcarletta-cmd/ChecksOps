import { CODES, fail, ok } from './errors.mjs';
import {
  SQL53_CONFIG_WRITER_FUNCTION_ARN,
  SQL53_CONFIG_WRITER_OIDC_STATEMENT,
  SQL53_CONFIG_WRITER_REQUIRED_ACTIONS,
  SQL53_CONFIG_WRITER_ROLE,
  compareSql53ConfigWriterTrust,
  isApprovedCursorOidcStatement,
  isIdentityCenterAdministratorIdentity,
  permissionsRemainSql53Only,
  removeSql53ConfigWriterOidcTrust,
} from './sql53-config-writer-trust-merge.mjs';

function normalize(value) {
  return value?.ok === true ? (value.details || value) : value;
}

function asPolicyDocument(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(decodeURIComponent(value));
    } catch {
      return JSON.parse(value);
    }
  }
  return value;
}

function sameStatements(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sanitizeTrust(document) {
  const statements = Array.isArray(document?.Statement) ? document.Statement : [];
  return {
    Version: document?.Version || null,
    statement_count: statements.length,
    statements: statements.map((statement) => ({
      Sid: statement?.Sid || null,
      Effect: statement?.Effect || null,
      Action: statement?.Action || null,
      principal_kind: statement?.Principal?.Federated
        ? 'Federated'
        : (statement?.Principal?.AWS ? 'AWS' : Object.keys(statement?.Principal || {})[0] || null),
      federated: statement?.Principal?.Federated || null,
      aws_principal_class: statement?.Principal?.AWS
        ? (String(statement.Principal.AWS).includes('AWSReservedSSO_AdministratorAccess')
          ? 'AWSReservedSSO_AdministratorAccess'
          : (String(statement.Principal.AWS).includes('sso.amazonaws.com')
            ? 'sso.amazonaws.com'
            : 'other'))
        : null,
      oidc_sub: statement?.Condition?.StringEquals?.['api.cursor.com:sub'] || null,
      approved_cursor_oidc: isApprovedCursorOidcStatement(statement),
    })),
  };
}

export async function applySql53ConfigWriterOidcTrustCleanup(input = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const aws = ctx.aws;
  if (input.apply !== true || env.CHECKSOPS_SQL53_OIDC_TRUST_CLEANUP !== '1') {
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      'SQL53 OIDC trust cleanup requires explicit apply:true and CHECKSOPS_SQL53_OIDC_TRUST_CLEANUP=1',
    );
  }
  if (!aws?.getCallerIdentity || !aws?.getRole || !aws?.listRolePolicies
    || !aws?.listAttachedRolePolicies || !aws?.getRolePolicy || !aws?.updateAssumeRolePolicy) {
    return fail(CODES.INVALID_MANIFEST, 'SQL53 OIDC trust cleanup requires a complete IAM adapter');
  }

  let identity;
  try {
    identity = normalize(await aws.getCallerIdentity());
  } catch {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL53 OIDC trust cleanup could not verify the Identity Center administrator');
  }
  if (!isIdentityCenterAdministratorIdentity(identity)) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL53 OIDC trust cleanup requires the IAM Identity Center AdministratorAccess role', {
      account: identity?.Account || null,
      arn_class: String(identity?.Arn || '').includes('ChecksOpsCursorCloudStaging')
        ? 'ChecksOpsCursorCloudStaging'
        : (String(identity?.Arn || '').includes('ChecksOpsProductionSql53ConfigWriter')
          ? 'ChecksOpsProductionSql53ConfigWriter'
          : (String(identity?.Arn || '').includes('AWSReservedSSO_AdministratorAccess')
            ? 'AWSReservedSSO_AdministratorAccess'
            : 'other')),
    });
  }

  let role;
  try {
    role = normalize(await aws.getRole({ roleName: SQL53_CONFIG_WRITER_ROLE }));
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to fresh-read ChecksOpsProductionSql53ConfigWriter; stop without changes');
  }
  const currentTrust = asPolicyDocument(role?.Role?.AssumeRolePolicyDocument || role?.AssumeRolePolicyDocument);
  const removed = removeSql53ConfigWriterOidcTrust(currentTrust);
  if (!removed.ok) return removed;
  if (removed.details.changed !== true) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'approved Cursor OIDC statement is not present for one-statement removal; stop without changes');
  }
  const comparison = compareSql53ConfigWriterTrust(currentTrust, removed.details.document);
  if (!comparison.ok || comparison.details.only_approved_cursor_oidc_removed !== true) {
    return fail(CODES.UNRELATED_MUTATION, 'cleanup comparison is not limited to the approved Cursor OIDC statement; stop without changes');
  }

  let attached;
  let inlineNames;
  try {
    attached = normalize(await aws.listAttachedRolePolicies({ roleName: SQL53_CONFIG_WRITER_ROLE }));
    inlineNames = normalize(await aws.listRolePolicies({ roleName: SQL53_CONFIG_WRITER_ROLE }));
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to list ChecksOpsProductionSql53ConfigWriter policies; stop without changes');
  }
  const attachedPolicies = attached?.AttachedPolicies || attached?.attachedPolicies || [];
  const policyNames = inlineNames?.PolicyNames || inlineNames?.policyNames || [];
  if (attachedPolicies.length) {
    return fail(CODES.UNRELATED_MUTATION, 'writer role has attached managed policies; refuse to continue');
  }
  if (policyNames.length !== 1) {
    return fail(CODES.UNRELATED_MUTATION, 'writer role must have exactly one inline policy');
  }

  let inline;
  try {
    inline = normalize(await aws.getRolePolicy({
      roleName: SQL53_CONFIG_WRITER_ROLE,
      policyName: policyNames[0],
    }));
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to fresh-read the writer inline permission policy; stop without changes');
  }
  const permissionDocument = asPolicyDocument(inline?.PolicyDocument || inline?.policyDocument);
  if (!permissionsRemainSql53Only(permissionDocument)) {
    return fail(CODES.UNRELATED_MUTATION, 'writer permissions are not exactly the three approved Lambda actions', {
      required_actions: SQL53_CONFIG_WRITER_REQUIRED_ACTIONS,
      required_resource: SQL53_CONFIG_WRITER_FUNCTION_ARN,
    });
  }

  try {
    await aws.updateAssumeRolePolicy({
      roleName: SQL53_CONFIG_WRITER_ROLE,
      policyDocument: removed.details.document,
    });
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'update-assume-role-policy failed; existing trust was not replaced by this writer');
  }

  let verified;
  try {
    verified = normalize(await aws.getRole({ roleName: SQL53_CONFIG_WRITER_ROLE }));
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'could not independently re-read writer trust after cleanup');
  }
  const verifiedTrust = asPolicyDocument(verified?.Role?.AssumeRolePolicyDocument || verified?.AssumeRolePolicyDocument);
  if (!sameStatements(verifiedTrust?.Statement, removed.details.document.Statement)) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'post-cleanup trust does not match the one-statement removal');
  }
  const verifiedComparison = compareSql53ConfigWriterTrust(currentTrust, verifiedTrust);
  if (!verifiedComparison.ok || verifiedComparison.details.only_approved_cursor_oidc_removed !== true) {
    return fail(CODES.UNRELATED_MUTATION, 'independent read-back is not limited to the approved Cursor OIDC statement');
  }

  let verifiedInline;
  try {
    verifiedInline = normalize(await aws.getRolePolicy({
      roleName: SQL53_CONFIG_WRITER_ROLE,
      policyName: policyNames[0],
    }));
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'could not independently re-read writer permissions after cleanup');
  }
  if (!permissionsRemainSql53Only(asPolicyDocument(verifiedInline?.PolicyDocument || verifiedInline?.policyDocument))) {
    return fail(CODES.UNRELATED_MUTATION, 'writer permissions changed during trust cleanup');
  }

  return ok({
    applied: true,
    role_name: SQL53_CONFIG_WRITER_ROLE,
    iam_cleanup_verified: true,
    removed_statement: SQL53_CONFIG_WRITER_OIDC_STATEMENT,
    identity_center_statement_preserved: true,
    permissions_verified: true,
    before: sanitizeTrust(currentTrust),
    after: sanitizeTrust(verifiedTrust),
    comparison: verifiedComparison.details,
  });
}
