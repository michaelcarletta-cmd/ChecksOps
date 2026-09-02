import { AlertTriangle, Ban, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type ComplianceIssueType = "KYB" | "MFA" | "Bank Verification" | "Moov" | "CheckAlt" | "Agreement" | "Overdue Review" | "Suspicious Activity" | "Other";
export type ComplianceIssueSeverity = "Low" | "Medium" | "High" | "Critical";
export type ComplianceIssueStatus = "Open" | "Investigating" | "Restricted" | "Resolved";

export interface TenantComplianceIssue {
  id: string;
  type: ComplianceIssueType;
  severity: ComplianceIssueSeverity;
  status: ComplianceIssueStatus;
  title: string;
  owner?: string;
  requiredAction?: string;
  restriction?: string;
  openedAt?: string;
  resolvedAt?: string;
  resolution?: string;
}

interface TenantComplianceIssuesProps { issues?: TenantComplianceIssue[]; }

const severityClass: Record<ComplianceIssueSeverity, string> = {
  Low: "border-border bg-muted text-muted-foreground",
  Medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  High: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  Critical: "border-destructive/30 bg-destructive/10 text-destructive",
};
const statusClass: Record<ComplianceIssueStatus, string> = {
  Open: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  Investigating: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  Restricted: "border-destructive/30 bg-destructive/10 text-destructive",
  Resolved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};
const formatDate = (value?: string) => { if (!value) return "—"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); };

export function TenantComplianceIssues({ issues = [] }: TenantComplianceIssuesProps) {
  const active = issues.filter(issue => issue.status !== "Resolved");
  const restricted = issues.filter(issue => issue.status === "Restricted").length;
  const critical = active.filter(issue => issue.severity === "Critical").length;

  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="h-4 w-4" /> Compliance Issues & Restrictions</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Active Issues</p><p className="mt-1 text-xl font-semibold">{active.length}</p></div>
        <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Restricted</p><p className="mt-1 text-xl font-semibold">{restricted}</p></div>
        <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Critical</p><p className="mt-1 text-xl font-semibold">{critical}</p></div>
      </div>

      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
        <div className="flex items-start gap-2"><Ban className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="text-sm font-medium">Restrictions must be backend enforced</p><p className="mt-1 text-xs text-muted-foreground">A restriction shown here may represent KYB, MFA, bank verification, Moov, CheckAlt, agreement, overdue-review, or suspicious-activity concerns. AWS and provider rules must determine whether deposits, disbursements, banking changes, or other financial actions are actually blocked.</p></div></div>
      </div>

      {issues.length === 0 ? <div className="rounded-lg border border-dashed border-border p-6 text-center"><p className="text-sm font-medium">No AWS compliance issues connected yet.</p><p className="mt-1 text-xs text-muted-foreground">Ready for tenant-specific issues and restrictions without changing current payment or account behavior.</p></div> : <div className="space-y-3">{issues.map(issue => <div key={issue.id} className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /><div><p className="font-medium">{issue.title}</p><p className="text-xs text-muted-foreground">{issue.type} · Opened {formatDate(issue.openedAt)}</p></div></div><div className="flex gap-2"><Badge variant="outline" className={severityClass[issue.severity]}>{issue.severity}</Badge><Badge variant="outline" className={statusClass[issue.status]}>{issue.status}</Badge></div></div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border border-border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">Owner</p><p className="mt-1 text-sm font-medium">{issue.owner || "Unassigned"}</p></div>
          <div className="rounded-md border border-border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">Required Action</p><p className="mt-1 text-sm">{issue.requiredAction || "—"}</p></div>
          <div className="rounded-md border border-border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">Restriction</p><p className="mt-1 text-sm">{issue.restriction || "None recorded"}</p></div>
          <div className="rounded-md border border-border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">Resolution</p><p className="mt-1 text-sm">{issue.resolution || "—"}</p>{issue.resolvedAt && <p className="mt-1 text-xs text-muted-foreground">{formatDate(issue.resolvedAt)}</p>}</div>
        </div>
      </div>)}</div>}

      <p className="text-xs text-muted-foreground">AWS-ready display only. Issue creation, investigation, restriction enforcement, escalation, and resolution history remain authoritative backend functions.</p>
    </CardContent>
  </Card>;
}
