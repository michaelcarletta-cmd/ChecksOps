import { CODES, fail, ok } from './errors.mjs';
import {
  SQL53_CONFIG_WRITER_FUNCTION_ARN,
  SQL53_CONFIG_WRITER_OIDC_STATEMENT,
  SQL53_CONFIG_WRITER_REQUIRED_ACTIONS,
  SQL53_CONFIG_WRITER_ROLE,
  isIdentityCenterAdministratorIdentity,
  mergeSql53ConfigWriterOidcTrust,
  permissionsRemainSql53Only,
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

export async function applySql53ConfigWriterOidcTrust(input = {}, ctx = {}) {
  const env = ctx.env || process.env;
  const aws = ctx.aws;
  if (input.apply !== true || env.CHECKSOPS_SQL53_OIDC_TRUST_APPLY !== '1') {
    return fail(CODES.GUARD_APPLY_FORBIDDEN, 'SQL53 OIDC trust apply requires explicit apply:true and CHECKSOPS_SQL53_OIDC_TRUST_APPLY=1');
  }
  if (!aws?.getCallerIdentity || !aws?.getRole || !aws?.listRolePolicies
    || !aws?.listAttachedRolePolicies || !aws?.getRolePolicy || !aws?.updateAssumeRolePolicy) {
    return fail(CODES.INVALID_MANIFEST, 'SQL53 OIDC trust apply requires a complete IAM adapter');
  }

  let identity;
  try {
    identity = normalize(await aws.getCallerIdentity());
  } catch {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL53 OIDC trust apply could not verify the Identity Center administrator');
  }
  if (!isIdentityCenterAdministratorIdentity(identity)) {
    return fail(CODES.PRODUCTION_APPROVAL_REQUIRED, 'SQL53 OIDC trust apply requires the IAM Identity Center AdministratorAccess role');
  }

  let role;
  try {
    role = normalize(await aws.getRole({ roleName: SQL53_CONFIG_WRITER_ROLE }));
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to fresh-read ChecksOpsProductionSql53ConfigWriter');
  }
  const currentTrust = asPolicyDocument(role?.Role?.AssumeRolePolicyDocument || role?.AssumeRolePolicyDocument);
  const merged = mergeSql53ConfigWriterOidcTrust(currentTrust);
  if (!merged.ok) return merged;

  let attached;
  let inlineNames;
  try {
    attached = normalize(await aws.listAttachedRolePolicies({ roleName: SQL53_CONFIG_WRITER_ROLE }));
    inlineNames = normalize(await aws.listRolePolicies({ roleName: SQL53_CONFIG_WRITER_ROLE }));
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to list ChecksOpsProductionSql53ConfigWriter policies');
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
    return fail(CODES.DEPLOYMENT_COLLISION, 'failed to fresh-read the writer inline permission policy');
  }
  const permissionDocument = asPolicyDocument(inline?.PolicyDocument || inline?.policyDocument);
  if (!permissionsRemainSql53Only(permissionDocument)) {
    return fail(CODES.UNRELATED_MUTATION, 'writer permissions are not exactly the three approved Lambda actions', {
      required_actions: SQL53_CONFIG_WRITER_REQUIRED_ACTIONS,
      required_resource: SQL53_CONFIG_WRITER_FUNCTION_ARN,
    });
  }

  if (merged.details.changed !== true) {
    return ok({
      applied: false,
      already_present: true,
      role_name: SQL53_CONFIG_WRITER_ROLE,
      trust: merged.details.document,
      permissions_verified: true,
      writer_assumed: false,
    });
  }

  try {
    await aws.updateAssumeRolePolicy({
      roleName: SQL53_CONFIG_WRITER_ROLE,
      policyDocument: merged.details.document,
    });
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'update-assume-role-policy failed; existing trust was not replaced by this writer');
  }

  let verified;
  try {
    verified = normalize(await aws.getRole({ roleName: SQL53_CONFIG_WRITER_ROLE }));
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'could not independently re-read writer trust after apply');
  }
  const verifiedTrust = asPolicyDocument(verified?.Role?.AssumeRolePolicyDocument || verified?.AssumeRolePolicyDocument);
  if (!sameStatements(verifiedTrust?.Statement, merged.details.document.Statement)) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'post-apply trust does not match the additive merge');
  }
  const remerged = mergeSql53ConfigWriterOidcTrust(verifiedTrust);
  if (!remerged.ok || remerged.details.changed !== false) {
    return fail(CODES.DEPLOYMENT_COLLISION, 'post-apply trust is missing the approved Cursor OIDC statement');
  }

  let verifiedInline;
  try {
    verifiedInline = normalize(await aws.getRolePolicy({
      roleName: SQL53_CONFIG_WRITER_ROLE,
      policyName: policyNames[0],
    }));
  } catch {
    return fail(CODES.DEPLOYMENT_COLLISION, 'could not independently re-read writer permissions after apply');
  }
  if (!permissionsRemainSql53Only(asPolicyDocument(verifiedInline?.PolicyDocument || verifiedInline?.policyDocument))) {
    return fail(CODES.UNRELATED_MUTATION, 'writer permissions changed during trust apply');
  }

  return ok({
    applied: true,
    role_name: SQL53_CONFIG_WRITER_ROLE,
    additive_statement: SQL53_CONFIG_WRITER_OIDC_STATEMENT,
    identity_center_statement_preserved: true,
    permissions_verified: true,
    writer_assumed: false,
    fingerprint_only_executed: false,
  });
}
