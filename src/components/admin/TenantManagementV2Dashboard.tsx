import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { awsApiBaseUrl, isAwsStaging } from "@/lib/awsStaging";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type TenantManagementSnapshot = {
  readOnly: boolean;
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string | null;
    plan: string | null;
    environment: string;
    createdAt: string;
    userCount: number;
  };
  period: { start: string; end: string };
  usage: {
    checksReceived: number;
    monthlyAllowance: number | null;
    remainingAllowance: number | null;
    perCheckBillingEnabled: boolean;
    configuredPerCheckRateCents: number | null;
  };
  integrity: {
    status: string;
    processedChecks: number;
    nonBillableLifecycleChecks: number;
    matchedChecks: number;
    missingUsageEvents: number;
    orphanBillingEvents: number;
    duplicateBillingEvents: number;
    suspiciousBillingEvents: number;
  };
  billing: {
    feeEvents: number;
    checkAndDisbursementFeesCents: number;
    mortgageFeesCents: number;
    chargesCents: number;
    failedFeeEvents: number;
    recordedPaymentsCents: number;
    collectedPaymentsCents: number;
    outstandingCents: number | null;
    outstandingStatus: string;
    autoDebit: { enabled: boolean; verificationStatus: string; authorizedAt: string | null } | null;
    paymentHistory: Array<{
      id: string;
      amountCents: number;
      status: string;
      periodStart: string;
      periodEnd: string;
      receivedAt: string;
    }>;
  };
  providers: {
    moov: Array<{
      environment: string;
      onboardingStatus: string;
      verificationStatus: string;
      capabilities: {
        receivePayments: boolean;
        sendPayments: boolean;
        achDebit: boolean;
        achCredit: boolean;
      };
      restricted: boolean;
      disabled: boolean;
      requirementsCount: number;
      lastSyncedAt: string | null;
      readiness: string;
    }>;
    moovBankConnections: { total: number; connected: number; pending: number; disconnected: number };
    checkAlt: { enabled: boolean; registeredAt: string | null; readiness: string } | null;
    providerErrors: { status: string };
  };
  operations: {
    checksTotal: number;
    files: { count: number; bytes: number | null; unknownSizeCount: number };
    ocr: { completed: number; failed: number; pending: number };
    signatures: { total: number; open: number };
    mortgageOps: { total: number; open: number };
    deposits: { total: number; open: number };
    disbursements: { total: number; open: number };
    recentActivity: Array<{ at: string; action: string; actorId: string | null }>;
  };
  auditHistory: Array<{
    at: string;
    actorId: string | null;
    action: string;
    recordType: string;
  }>;
};

const currency = (cents: number | null) => (
  cents === null
    ? "Unavailable"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
);

const dateTime = (value: string | null | undefined) => (
  value ? new Date(value).toLocaleString() : "—"
);

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

export function TenantManagementV2Dashboard({ tenantId }: { tenantId: string }) {
  const query = useQuery({
    queryKey: ["tenant-management-v2", tenantId],
    enabled: Boolean(tenantId),
    staleTime: 30_000,
    queryFn: async (): Promise<TenantManagementSnapshot> => {
      if (!isAwsStaging()) {
        throw new Error("Tenant operations require the AWS/Cognito admin session.");
      }
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      const token = data.session?.access_token;
      if (!token) throw new Error("Sign in again to load tenant operations.");

      const url = new URL(`${awsApiBaseUrl()}/functions/v1/tenant-management-v2`, window.location.origin);
      url.searchParams.set("tenant_id", tenantId);
      const response = await fetch(url.toString(), {
        method: "GET",
        cache: "no-store",
        headers: { authorization: "Bearer " + token },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof result.error === "string" ? result.error : "Tenant read model unavailable.");
      }
      if (result.tenant?.id !== tenantId || result.readOnly !== true) {
        throw new Error("Tenant read model returned an invalid scope.");
      }
      return result as TenantManagementSnapshot;
    },
  });

  const snapshot = query.data;
  const integrityIssueCount = snapshot
    ? snapshot.integrity.missingUsageEvents
      + snapshot.integrity.orphanBillingEvents
      + snapshot.integrity.duplicateBillingEvents
      + snapshot.integrity.suspiciousBillingEvents
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">Organization 360</h2>
          <p className="text-sm text-muted-foreground">
            Read-only overview from the platform-owner AWS read model.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {query.isLoading ? (
        <Card><CardContent className="py-8 text-sm text-muted-foreground">Loading tenant read model…</CardContent></Card>
      ) : query.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tenant overview unavailable</CardTitle>
            <CardDescription>{query.error instanceof Error ? query.error.message : "Read failed."}</CardDescription>
          </CardHeader>
        </Card>
      ) : snapshot ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {snapshot.tenant.name}
                <Badge variant="outline">{snapshot.tenant.status || "Unknown status"}</Badge>
                <Badge variant="secondary">{snapshot.tenant.plan || "Plan unavailable"}</Badge>
              </CardTitle>
              <CardDescription>
                /{snapshot.tenant.slug} · {snapshot.tenant.environment} · {snapshot.tenant.userCount} users · Period: {new Date(snapshot.period.start).toLocaleDateString()} – {new Date(snapshot.period.end).toLocaleDateString()} (end exclusive)
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3">
              <Metric label="Checks received this period" value={`${snapshot.usage.checksReceived} / ${snapshot.usage.monthlyAllowance ?? "Unavailable"}`} />
              <Metric label="Remaining allowance" value={snapshot.usage.remainingAllowance ?? "Unavailable"} />
              <Metric label="Usage integrity" value={<Badge variant={integrityIssueCount ? "destructive" : "secondary"}>{snapshot.integrity.status}</Badge>} />
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Usage Integrity</CardTitle></CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <Metric label="Processed checks" value={snapshot.integrity.processedChecks} />
                <Metric label="Other deposited lifecycle statuses (excluded)" value={snapshot.integrity.nonBillableLifecycleChecks} />
                <Metric label="Matched billing events" value={snapshot.integrity.matchedChecks} />
                <Metric label="Missing usage events" value={snapshot.integrity.missingUsageEvents} />
                <Metric label="Orphan / duplicate / suspicious" value={`${snapshot.integrity.orphanBillingEvents} / ${snapshot.integrity.duplicateBillingEvents} / ${snapshot.integrity.suspiciousBillingEvents}`} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Billing Status</CardTitle>
                <CardDescription>
                  Usage fee billing: {snapshot.usage.perCheckBillingEnabled ? "enabled" : "disabled"} · Configured per-check rate: {currency(snapshot.usage.configuredPerCheckRateCents)}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <Metric label="Recorded usage charges" value={currency(snapshot.billing.chargesCents)} />
                <Metric label="Recorded payments" value={currency(snapshot.billing.recordedPaymentsCents)} />
                <Metric label="Collected payments" value={currency(snapshot.billing.collectedPaymentsCents)} />
                <Metric label="Outstanding" value={snapshot.billing.outstandingStatus === "unavailable" ? "Unavailable" : currency(snapshot.billing.outstandingCents)} />
                <Metric label="Auto-debit" value={snapshot.billing.autoDebit ? `${snapshot.billing.autoDebit.enabled ? "Enabled" : "Disabled"} · ${snapshot.billing.autoDebit.verificationStatus}` : "Unavailable"} />
                <Metric label="ACH authorization" value={dateTime(snapshot.billing.autoDebit?.authorizedAt)} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Provider Health</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {snapshot.providers.moov.length === 0
                  ? <p className="text-sm text-muted-foreground">Moov persisted account state unavailable.</p>
                  : snapshot.providers.moov.map((account, index) => (
                    <div key={`${account.environment}-${index}`} className="rounded-md border p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">Moov · {account.environment}</Badge>
                        <Badge variant={account.readiness === "ready" ? "secondary" : "destructive"}>{account.readiness}</Badge>
                      </div>
                      <p className="mt-2 text-muted-foreground">
                        Onboarding: {account.onboardingStatus} · Verification: {account.verificationStatus}
                      </p>
                      <p className="text-muted-foreground">
                        Receive {String(account.capabilities.receivePayments)} · Send {String(account.capabilities.sendPayments)} · ACH debit {String(account.capabilities.achDebit)} · ACH credit {String(account.capabilities.achCredit)}
                      </p>
                      <p className="text-muted-foreground">
                        Restricted: {String(account.restricted)} · Disabled: {String(account.disabled)} · Requirements: {account.requirementsCount} · Last sync: {dateTime(account.lastSyncedAt)}
                      </p>
                    </div>
                  ))}
                <p className="text-sm text-muted-foreground">
                  Bank connections: {snapshot.providers.moovBankConnections.connected} connected, {snapshot.providers.moovBankConnections.pending} pending, {snapshot.providers.moovBankConnections.disconnected} disconnected.
                </p>
                <p className="text-sm text-muted-foreground">
                  CheckAlt: {snapshot.providers.checkAlt?.readiness ?? "Unavailable"} · Provider error details: unavailable.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Storage &amp; Operations</CardTitle></CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <Metric label="Checks" value={snapshot.operations.checksTotal} />
                <Metric label="Tracked files" value={snapshot.operations.files.count} />
                <Metric label="Tracked file bytes" value={snapshot.operations.files.bytes === null ? "Unavailable" : snapshot.operations.files.bytes.toLocaleString()} />
                <Metric label="OCR complete / failed / pending" value={`${snapshot.operations.ocr.completed} / ${snapshot.operations.ocr.failed} / ${snapshot.operations.ocr.pending}`} />
                <Metric label="Signature requests" value={`${snapshot.operations.signatures.total} total · ${snapshot.operations.signatures.open} open`} />
                <Metric label="MortgageOps" value={`${snapshot.operations.mortgageOps.total} total · ${snapshot.operations.mortgageOps.open} open`} />
                <Metric label="Deposits" value={`${snapshot.operations.deposits.total} total · ${snapshot.operations.deposits.open} open`} />
                <Metric label="Disbursements" value={`${snapshot.operations.disbursements.total} total · ${snapshot.operations.disbursements.open} open`} />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Recent Payment History</CardTitle></CardHeader>
            <CardContent>
              {snapshot.billing.paymentHistory.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payment records found.</p>
              ) : (
                <div className="space-y-2">
                  {snapshot.billing.paymentHistory.map((payment) => (
                    <div key={payment.id} className="flex flex-wrap justify-between gap-2 border-b pb-2 text-sm last:border-0">
                      <span>{dateTime(payment.receivedAt)} · {payment.status}</span>
                      <span>{currency(payment.amountCents)} · {payment.periodStart} – {payment.periodEnd}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Tenant Email Domain Audit History</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {snapshot.auditHistory.length === 0
                  ? <p className="text-sm text-muted-foreground">No tenant-linked audit entries found.</p>
                  : snapshot.auditHistory.map((entry, index) => (
                    <div key={`${entry.at}-${index}`} className="border-b pb-2 text-sm last:border-0">
                      <div>{dateTime(entry.at)} · {entry.action} · {entry.recordType}</div>
                      <div className="text-xs text-muted-foreground">Actor: {entry.actorId || "Unavailable"}</div>
                    </div>
                  ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Recent Operational Activity</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {snapshot.operations.recentActivity.length === 0
                  ? <p className="text-sm text-muted-foreground">No recent operational events found.</p>
                  : snapshot.operations.recentActivity.map((activity, index) => (
                    <div key={`${activity.at}-${index}`} className="flex flex-wrap justify-between gap-2 border-b pb-2 text-sm last:border-0">
                      <span>{dateTime(activity.at)} · {activity.action}</span>
                      <span className="text-xs text-muted-foreground">Actor: {activity.actorId || "Unavailable"}</span>
                    </div>
                  ))}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
