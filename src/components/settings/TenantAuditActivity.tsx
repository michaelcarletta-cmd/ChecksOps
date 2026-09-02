import { Activity, AlertTriangle, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type AuditResult = "Success" | "Failed" | "Blocked" | "Pending";

export interface TenantAuditEvent {
  id: string;
  occurredAt: string;
  userName?: string;
  userEmail?: string;
  category: "Authentication" | "Security" | "Sensitive Data" | "Banking" | "Deposit" | "Disbursement" | "Moov" | "CheckAlt" | "Export" | "Admin";
  action: string;
  result: AuditResult;
  resource?: string;
  ipAddress?: string;
  device?: string;
}

interface TenantAuditActivityProps {
  events?: TenantAuditEvent[];
}

const resultClass: Record<AuditResult, string> = {
  Success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  Failed: "border-destructive/30 bg-destructive/10 text-destructive",
  Blocked: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  Pending: "border-border bg-muted text-muted-foreground",
};

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export function TenantAuditActivity({ events = [] }: TenantAuditActivityProps) {
  const failedOrBlocked = events.filter((event) => event.result === "Failed" || event.result === "Blocked").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Activity className="h-4 w-4" /> Audit Activity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Events Loaded</p><p className="mt-1 text-xl font-semibold">{events.length}</p></div>
          <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Failed / Blocked</p><p className="mt-1 text-xl font-semibold">{failedOrBlocked}</p></div>
          <div className="rounded-lg border border-border p-3"><p className="text-xs text-muted-foreground">Audit Authority</p><div className="mt-2"><Badge variant="outline">AWS / Append-only</Badge></div></div>
        </div>

        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /><div><p className="text-sm font-medium">Tamper-resistant audit trail</p><p className="mt-1 text-xs text-muted-foreground">The production backend should record authentication, account/security changes, sensitive-data access, financial activity, provider actions, exports, and admin activity. This screen only displays authoritative events supplied by AWS.</p></div></div>
        </div>

        {events.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center"><p className="text-sm font-medium">No AWS audit events connected yet.</p><p className="mt-1 text-xs text-muted-foreground">Ready for append-only audit data without changing current Supabase, Moov, CheckAlt, banking, or payment behavior.</p></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Date / Time</th><th className="px-3 py-2">User</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Resource</th><th className="px-3 py-2">IP / Device</th><th className="px-3 py-2">Result</th></tr></thead>
              <tbody className="divide-y divide-border">
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="px-3 py-3 text-xs">{formatDate(event.occurredAt)}</td>
                    <td className="px-3 py-3"><p className="font-medium">{event.userName || "System"}</p><p className="text-xs text-muted-foreground">{event.userEmail || ""}</p></td>
                    <td className="px-3 py-3"><Badge variant="outline">{event.category}</Badge></td>
                    <td className="px-3 py-3">{event.action}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">{event.resource || "—"}</td>
                    <td className="px-3 py-3 text-xs"><p className="font-mono">{event.ipAddress || "—"}</p><p className="text-muted-foreground">{event.device || ""}</p></td>
                    <td className="px-3 py-3"><Badge variant="outline" className={resultClass[event.result]}>{event.result === "Failed" || event.result === "Blocked" ? <AlertTriangle className="mr-1 h-3 w-3" /> : null}{event.result}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-muted-foreground">Filtering by user, date, event category, financial/security scope, and result should be performed against the AWS audit API when connected. Audit records must not be editable from this tenant interface.</p>
      </CardContent>
    </Card>
  );
}
