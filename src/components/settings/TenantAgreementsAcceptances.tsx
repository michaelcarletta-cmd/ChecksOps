import { FileCheck2, History, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type AgreementType =
  | "Terms of Service"
  | "Privacy Policy"
  | "Payment Processing Acknowledgment"
  | "Tenant Agreement";

export interface TenantAgreementAcceptance {
  id: string;
  type: AgreementType;
  version: string;
  accepted: boolean;
  acceptedBy?: string;
  acceptedByEmail?: string;
  acceptedAt?: string;
  ipAddress?: string;
  device?: string;
}

interface TenantAgreementsAcceptancesProps {
  records?: TenantAgreementAcceptance[];
}

const requiredAgreementTypes: AgreementType[] = [
  "Terms of Service",
  "Privacy Policy",
  "Payment Processing Acknowledgment",
  "Tenant Agreement",
];

const formatDate = (value?: string) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export function TenantAgreementsAcceptances({ records = [] }: TenantAgreementsAcceptancesProps) {
  const latestByType = requiredAgreementTypes.map((type) => ({
    type,
    record: records.filter((record) => record.type === type).sort((a, b) => (b.acceptedAt || "").localeCompare(a.acceptedAt || ""))[0],
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileCheck2 className="h-4 w-4" />
          Agreements & Acceptances
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <p className="text-sm font-medium">Versioned acceptance records</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Terms and Privacy acceptance must occur before platform use. The backend record should preserve the accepted document version, user, timestamp, IP address, and device information while retaining prior versions and acceptance history.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {latestByType.map(({ type, record }) => (
            <div key={type} className="rounded-lg border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{type}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Version {record?.version || "—"}</p>
                </div>
                <Badge
                  variant="outline"
                  className={record?.accepted
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"}
                >
                  {record?.accepted ? "Accepted" : "Required"}
                </Badge>
              </div>
              {record?.accepted && (
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <p>{record.acceptedBy || record.acceptedByEmail || "Recorded user"}</p>
                  <p>{formatDate(record.acceptedAt)}</p>
                </div>
              )}
            </div>
          ))}
        </div>

        <div>
          <div className="mb-3 flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold">Acceptance History</h4>
          </div>
          {records.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-6 text-center">
              <p className="text-sm font-medium">No AWS agreement records connected yet.</p>
              <p className="mt-1 text-xs text-muted-foreground">Ready for immutable/versioned acceptance records without changing current tenant onboarding.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Agreement</th>
                    <th className="px-3 py-2">Version</th>
                    <th className="px-3 py-2">User</th>
                    <th className="px-3 py-2">Accepted</th>
                    <th className="px-3 py-2">IP Address</th>
                    <th className="px-3 py-2">Device</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {records.map((record) => (
                    <tr key={record.id}>
                      <td className="px-3 py-3 font-medium">{record.type}</td>
                      <td className="px-3 py-3">{record.version}</td>
                      <td className="px-3 py-3"><p>{record.acceptedBy || "—"}</p><p className="text-xs text-muted-foreground">{record.acceptedByEmail || ""}</p></td>
                      <td className="px-3 py-3 text-xs">{formatDate(record.acceptedAt)}</td>
                      <td className="px-3 py-3 font-mono text-xs">{record.ipAddress || "—"}</td>
                      <td className="px-3 py-3 text-xs">{record.device || "—"}</td>
                      <td className="px-3 py-3">{record.accepted ? <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"><ShieldCheck className="mr-1 h-3 w-3" />Accepted</Badge> : <Badge variant="outline">Pending</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          AWS-ready interface only. Acceptance evidence must be written and preserved by the backend; this component does not create, alter, or authorize legal acceptance records.
        </p>
      </CardContent>
    </Card>
  );
}
