import type {
  TenantAccessRecord,
  TenantComplianceOverview,
  TenantFinancialPermissions,
  TenantSecurityReadiness,
} from "@/components/settings/TenantSecurityComplianceView";
import type { TenantAgreementAcceptance } from "@/components/settings/TenantAgreementsAcceptances";
import type { TenantAuditEvent } from "@/components/settings/TenantAuditActivity";
import type { TenantComplianceReview } from "@/components/settings/TenantComplianceReviews";
import type { TenantComplianceIssue } from "@/components/settings/TenantComplianceIssues";
import type { TenantComplianceDocument } from "@/components/settings/TenantComplianceDocuments";
import type { TenantComplianceTimelineEvent } from "@/components/settings/TenantComplianceTimeline";

export interface TenantComplianceSnapshot {
  overview: TenantComplianceOverview;
  accessRecords: TenantAccessRecord[];
  financialPermissions: TenantFinancialPermissions[];
  securityReadiness: TenantSecurityReadiness[];
  agreementAcceptances: TenantAgreementAcceptance[];
  auditEvents: TenantAuditEvent[];
  complianceReviews: TenantComplianceReview[];
  complianceIssues: TenantComplianceIssue[];
  complianceDocuments: TenantComplianceDocument[];
  complianceTimelineEvents: TenantComplianceTimelineEvent[];
}

const getApiBaseUrl = () => {
  const value = String(import.meta.env.VITE_CHECKSOPS_API_URL || "").trim();
  return value.replace(/\/$/, "");
};

export const isAwsComplianceApiConfigured = () => Boolean(getApiBaseUrl());

export async function getTenantComplianceSnapshot(
  tenantId: string,
  accessToken?: string,
  signal?: AbortSignal,
): Promise<TenantComplianceSnapshot> {
  const apiBaseUrl = getApiBaseUrl();
  if (!apiBaseUrl) {
    throw new Error("VITE_CHECKSOPS_API_URL is not configured.");
  }

  const headers: HeadersInit = { Accept: "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(
    `${apiBaseUrl}/tenants/${encodeURIComponent(tenantId)}/security-compliance`,
    { method: "GET", headers, signal, credentials: "omit" },
  );

  if (!response.ok) {
    throw new Error(`Unable to load tenant compliance data (${response.status}).`);
  }

  return (await response.json()) as TenantComplianceSnapshot;
}
