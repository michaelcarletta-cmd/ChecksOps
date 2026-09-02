import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TenantSecurityComplianceView } from "./TenantSecurityComplianceView";
import {
  getTenantComplianceSnapshot,
  isAwsComplianceApiConfigured,
} from "@/lib/aws/tenantCompliance";

interface TenantSecurityComplianceAwsProps {
  tenantId: string;
  tenantName: string;
}

export function TenantSecurityComplianceAws({ tenantId, tenantName }: TenantSecurityComplianceAwsProps) {
  const apiConfigured = isAwsComplianceApiConfigured();
  const query = useQuery({
    queryKey: ["aws-tenant-security-compliance", tenantId],
    queryFn: ({ signal }) => getTenantComplianceSnapshot(tenantId, undefined, signal),
    enabled: apiConfigured,
    retry: false,
    staleTime: 60_000,
  });

  if (!apiConfigured) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <p className="text-sm font-medium">AWS compliance API not connected yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Set VITE_CHECKSOPS_API_URL when the AWS read endpoint is available. Until then, the tenant compliance interface remains in its safe placeholder state.
              </p>
            </div>
          </CardContent>
        </Card>
        <TenantSecurityComplianceView tenantId={tenantId} tenantName={tenantName} />
      </div>
    );
  }

  if (query.isLoading) {
    return (
      <div className="flex min-h-[240px] items-center justify-center rounded-lg border border-border">
        <div className="text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">Loading Security & Compliance</p>
          <p className="mt-1 text-xs text-muted-foreground">Reading tenant data from the ChecksOps AWS API.</p>
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Card>
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Unable to load AWS compliance data</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {query.error instanceof Error ? query.error.message : "The compliance read request failed."}
              </p>
              <Button className="mt-3" size="sm" variant="outline" onClick={() => query.refetch()}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const snapshot = query.data;
  return (
    <TenantSecurityComplianceView
      tenantId={tenantId}
      tenantName={tenantName}
      overview={snapshot.overview}
      accessRecords={snapshot.accessRecords}
      financialPermissions={snapshot.financialPermissions}
      securityReadiness={snapshot.securityReadiness}
      agreementAcceptances={snapshot.agreementAcceptances}
      auditEvents={snapshot.auditEvents}
      complianceReviews={snapshot.complianceReviews}
      complianceIssues={snapshot.complianceIssues}
      complianceDocuments={snapshot.complianceDocuments}
      complianceTimelineEvents={snapshot.complianceTimelineEvents}
    />
  );
}
