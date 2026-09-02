import {
  AlertTriangle,
  CalendarClock,
  FileCheck2,
  KeyRound,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export interface TenantAccessRecord {
  id: string;
  name: string;
  email: string;
  role: string;
  accountStatus: string;
  accessLevel: string;
  financialAccess: boolean;
  totpEnrolled: boolean;
  passkeyEnrolled: boolean;
  accessGrantedAt?: string;
  lastLoginAt?: string;
  lastAccessReviewAt?: string;
  accessRevokedAt?: string;
}

interface TenantSecurityComplianceProps {
  tenantId: string;
  tenantName: string;
  overview?: TenantComplianceOverview;
  accessRecords?: TenantAccessRecord[];
  onViewAccess?: (record: TenantAccessRecord) => void;
  onEditPermissions?: (record: TenantAccessRecord) => void;
  onRestrictFinancialAccess?: (record: TenantAccessRecord) => void;
  onRevokeAccess?: (record: TenantAccessRecord) => void;
  onRequireSecuritySetup?: (record: TenantAccessRecord) => void;
}

const placeholderOverview: TenantComplianceOverview = {
  securityStatus: "Pending",
  usersAndAccess: "Pending",
  mfaEnrollment: "Pending",
  agreementsAndPolicies: "Pending",
  complianceIssues: "Pending",
  nextReview: "Pending",
  actionItems: ["Compliance data will populate when the AWS compliance API is connected."],
};

const statusClasses: Record<ComplianceStatus, string> = {
  Compliant: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "Action Required": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  "Review Due": "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  Restricted: "border-destructive/30 bg-destructive/10 text-destructive",
  Pending: "border-border bg-muted text-muted-foreground",
};

const formatDate = (value?: string) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export function TenantSecurityCompliance({
  tenantId,
  tenantName,
  overview = placeholderOverview,
  accessRecords = [],
  onViewAccess,
  onEditPermissions,
  onRestrictFinancialAccess,
  onRevokeAccess,
  onRequireSecuritySetup,
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
              <Badge variant="outline" className={statusClasses[status]}>{status}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4" /> Compliance Health
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {overview.actionItems.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm">
              <ShieldCheck className="h-4 w-4" /> No outstanding tenant compliance actions.
            </div>
          ) : overview.actionItems.map((item, index) => (
            <div key={`${item}-${index}`} className="flex items-start gap-3 rounded-lg border border-border bg-muted/20 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              <div><p className="text-sm font-medium">Action Required</p><p className="text-sm text-muted-foreground">{item}</p></div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><Users className="h-4 w-4" /> Users & Access / ACL</CardTitle>
        </CardHeader>
        <CardContent>
          {accessRecords.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <p className="text-sm font-medium">No AWS access-control records connected yet.</p>
              <p className="mt-1 text-xs text-muted-foreground">This table is ready for the tenant ACL API. Existing Supabase authorization is not modified.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">User</th><th className="px-3 py-2 font-medium">Role</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Access</th><th className="px-3 py-2 font-medium">Financial</th><th className="px-3 py-2 font-medium">TOTP</th><th className="px-3 py-2 font-medium">Passkey</th><th className="px-3 py-2 font-medium">Granted</th><th className="px-3 py-2 font-medium">Last Login</th><th className="px-3 py-2 font-medium">Last Review</th><th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {accessRecords.map((record) => (
                    <tr key={record.id} className="align-top">
                      <td className="px-3 py-3"><p className="font-medium">{record.name}</p><p className="text-xs text-muted-foreground">{record.email}</p></td>
                      <td className="px-3 py-3">{record.role}</td><td className="px-3 py-3"><Badge variant="outline">{record.accountStatus}</Badge></td><td className="px-3 py-3">{record.accessLevel}</td><td className="px-3 py-3">{record.financialAccess ? "Enabled" : "Restricted"}</td><td className="px-3 py-3">{record.totpEnrolled ? "Enrolled" : "Required"}</td><td className="px-3 py-3">{record.passkeyEnrolled ? "Enrolled" : "Not enrolled"}</td><td className="px-3 py-3 text-xs">{formatDate(record.accessGrantedAt)}</td><td className="px-3 py-3 text-xs">{formatDate(record.lastLoginAt)}</td><td className="px-3 py-3 text-xs">{formatDate(record.lastAccessReviewAt)}</td>
                      <td className="px-3 py-3"><div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" onClick={() => onViewAccess?.(record)} disabled={!onViewAccess}>View</Button><Button size="sm" variant="outline" onClick={() => onEditPermissions?.(record)} disabled={!onEditPermissions}>Permissions</Button><Button size="sm" variant="outline" onClick={() => onRestrictFinancialAccess?.(record)} disabled={!onRestrictFinancialAccess}>Restrict Financial</Button><Button size="sm" variant="outline" onClick={() => onRequireSecuritySetup?.(record)} disabled={!onRequireSecuritySetup}>Require Security</Button><Button size="sm" variant="destructive" onClick={() => onRevokeAccess?.(record)} disabled={!onRevokeAccess}>Revoke</Button></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        AWS-ready interface only. Security enforcement, authorization, audit authority, and sensitive data remain backend responsibilities. No frontend control grants financial authority.
      </p>
    </div>
  );
}
