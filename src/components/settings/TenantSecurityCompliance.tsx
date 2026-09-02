import { TenantSecurityComplianceAws } from "./TenantSecurityComplianceAws";

export type {
  ComplianceStatus,
  FinancialPermissionKey,
  TenantAccessRecord,
  TenantComplianceOverview,
  TenantFinancialPermissions,
  TenantSecurityReadiness,
} from "./TenantSecurityComplianceView";

interface TenantSecurityComplianceProps {
  tenantId: string;
  tenantName: string;
}

export function TenantSecurityCompliance({ tenantId, tenantName }: TenantSecurityComplianceProps) {
  return <TenantSecurityComplianceAws tenantId={tenantId} tenantName={tenantName} />;
}
