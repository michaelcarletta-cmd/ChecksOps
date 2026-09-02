import {
  AlertTriangle,
  CalendarClock,
  FileCheck2,
  KeyRound,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type ComplianceStatus =
  | "Compliant"
  | "Action Required"
  | "Review Due"
  | "Restricted"
  | "Pending";

export interface TenantComplianceOverview {
  securityStatus: ComplianceStatus;
  usersAndAccess: ComplianceStatus;
  mfaEnrollment: ComplianceStatus;
  agreementsAndPolicies: ComplianceStatus;
  complianceIssues: ComplianceStatus;
  nextReview: ComplianceStatus;
  actionItems: string[];
}

interface TenantSecurityComplianceProps {
  tenantId: string;
  tenantName: string;
  overview?: TenantComplianceOverview;
}

const placeholderOverview: TenantComplianceOverview = {
  securityStatus: "Pending",
  usersAndAccess: "Pending",
  mfaEnrollment: "Pending",
  agreementsAndPolicies: "Pending",
  complianceIssues: "Pending",
  nextReview: "Pending",
  actionItems: [
    "Compliance data will populate when the AWS compliance API is connected.",
  ],
};

const statusClasses: Record<ComplianceStatus, string> = {
  Compliant: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "Action Required": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  "Review Due": "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  Restricted: "border-destructive/30 bg-destructive/10 text-destructive",
  Pending: "border-border bg-muted text-muted-foreground",
};

export function TenantSecurityCompliance({
  tenantId,
  tenantName,
  overview = placeholderOverview,
}: TenantSecurityComplianceProps) {
  const cards = [
    { label: "Security Status", status: overview.securityStatus, icon: ShieldCheck },
    { label: "Users & Access", status: overview.usersAndAccess, icon: Users },
    { label: "MFA Enrollment", status: overview.mfaEnrollment, icon: KeyRound },
    { label: "Agreements & Policies", status: overview.agreementsAndPolicies, icon: FileCheck2 },
    { label: "Compliance Issues", status: overview.complianceIssues, icon: AlertTriangle },
    { label: "Next Review", status: overview.nextReview, icon: CalendarClock },
  ];

  return (
    <div className="space-y-6" data-tenant-id={tenantId}>
      <div>
        <h3 className="text-lg font-semibold">Security & Compliance</h3>
        <p className="text-sm text-muted-foreground">
          Tenant-specific security, access, agreements, and compliance readiness for {tenantName}.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ label, status, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="flex items-center justify-between gap-4 p-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="rounded-lg border border-border bg-muted/40 p-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
                  <p className="mt-1 text-sm font-semibold">{status}</p>
                </div>
              </div>
              <Badge variant="outline" className={statusClasses[status]}>
                {status}
              </Badge>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4" />
            Compliance Health
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {overview.actionItems.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm">
              <ShieldCheck className="h-4 w-4" />
              No outstanding tenant compliance actions.
            </div>
          ) : (
            overview.actionItems.map((item, index) => (
              <div key={`${item}-${index}`} className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div>
                  <p className="text-sm font-medium">Action Required</p>
                  <p className="text-sm text-muted-foreground">{item}</p>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Read-only placeholder interface. Security enforcement, authorization, audit authority, and sensitive data remain backend responsibilities and will be supplied by AWS services.
      </p>
    </div>
  );
}
