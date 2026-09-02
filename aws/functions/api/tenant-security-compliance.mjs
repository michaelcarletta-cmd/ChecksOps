import { resolveCognitoClaims } from './authorization.mjs';
import { resolveIdentitySession } from './identity.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isValidTenantId = (tenantId) => UUID_RE.test(String(tenantId || ''));

export const buildPendingComplianceSnapshot = ({ tenantId, tenantName = null }) => ({
  overview: {
    securityStatus: 'Pending',
    usersAndAccess: 'Pending',
    mfaEnrollment: 'Pending',
    agreementsAndPolicies: 'Pending',
    complianceIssues: 'Pending',
    nextReview: 'Pending',
    actionItems: [
      'AWS tenant authorization is connected. Detailed compliance data sources are not enabled yet.',
    ],
  },
  accessRecords: [],
  financialPermissions: [],
  securityReadiness: [],
  agreementAcceptances: [],
  auditEvents: [],
  complianceReviews: [],
  complianceIssues: [],
  complianceDocuments: [],
  complianceTimelineEvents: [],
  meta: {
    tenantId,
    tenantName,
    source: 'checksops-aws-staging',
    authorization: 'cognito_sub_to_identity_accounts_to_tenant_users',
    readOnly: true,
    dataState: 'authorization-connected-detail-sources-pending',
  },
});

export const tenantAllowedForIdentity = (identity, tenantId) => {
  if (!identity?.ok || !Array.isArray(identity.tenants)) return false;
  return identity.tenants.some((tenant) => tenant?.tenant_id === tenantId);
};

export const handleTenantSecurityCompliance = async (
  event,
  tenantId,
  {
    resolveClaims = resolveCognitoClaims,
    resolveIdentity = resolveIdentitySession,
  } = {},
) => {
  if (!isValidTenantId(tenantId)) {
    return { ok: false, statusCode: 400, error: 'invalid_tenant_id' };
  }

  const claimsResult = await resolveClaims(event);
  if (!claimsResult.ok) return claimsResult;

  const identity = await resolveIdentity({
    cognitoSub: claimsResult.claims.sub,
    email: claimsResult.claims.email,
  });
  if (!identity.ok) return identity;

  if (!tenantAllowedForIdentity(identity, tenantId)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'tenant_access_denied',
    };
  }

  const membership = identity.tenants.find((tenant) => tenant.tenant_id === tenantId);
  return {
    ok: true,
    statusCode: 200,
    snapshot: buildPendingComplianceSnapshot({
      tenantId,
      tenantName: membership?.tenant_name || null,
    }),
  };
};
