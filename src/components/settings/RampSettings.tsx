import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AlertCircle, CheckCircle, Loader2, RefreshCw, XCircle } from "lucide-react";

interface RampSettingsProps {
  embedded?: boolean;
}

interface RampStatusPayload {
  success: boolean;
  healthy: boolean;
  credentials: {
    clientId: boolean;
    clientSecret: boolean;
  };
  apiAuth: boolean;
  apiAuthError: string | null;
  linkTemplate: {
    configured: boolean;
    hasPlaceholders: boolean;
    mode: "missing" | "placeholders" | "query-append";
    host: string | null;
    pathname: string | null;
  };
  configuredOverrides: {
    entityId: string | null;
    sourceBankAccountId: string | null;
    vendorOwnerId: string | null;
    scopes: string | null;
  };
  resolvedDefaults: {
    entityId: string | null;
    entityName: string | null;
    sourceBankAccountId: string | null;
    sourceBankAccountName: string | null;
    vendorOwnerId: string | null;
    hasBillPayAccount: boolean;
  } | null;
  issues: string[];
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return ok ? (
    <Badge variant="default" className="bg-green-600">
      <CheckCircle className="h-3 w-3 mr-1" />
      {label}
    </Badge>
  ) : (
    <Badge variant="secondary">
      <XCircle className="h-3 w-3 mr-1" />
      {label}
    </Badge>
  );
}

function ConfigRow({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className={ok ? "font-medium" : "text-muted-foreground"}>{value}</span>
        {ok ? (
          <CheckCircle className="h-4 w-4 text-green-600" />
        ) : (
          <XCircle className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
    </div>
  );
}

export function RampSettings(_props: RampSettingsProps) {
  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["ramp-integration-status"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("ramp-payments", {
        body: { action: "get-integration-status" },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Failed to fetch Ramp integration status");
      return data as RampStatusPayload;
    },
    staleTime: 30_000,
  });

  const issues = data?.issues || [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              Ramp Payments
              {data ? (
                <StatusBadge ok={data.healthy} label={data.healthy ? "Healthy" : "Action Needed"} />
              ) : null}
            </CardTitle>
            <CardDescription>
              Visibility into Ramp credentials and payment-routing configuration for accounting.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isLoading || isFetching}>
            {isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading Ramp status...
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            Unable to load Ramp status.
          </div>
        ) : data ? (
          <>
            <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
              <p className="text-sm font-medium">Credential & Auth Checks</p>
              <ConfigRow
                label="RAMP_CLIENT_ID"
                value={data.credentials.clientId ? "Configured" : "Missing"}
                ok={data.credentials.clientId}
              />
              <ConfigRow
                label="RAMP_CLIENT_SECRET"
                value={data.credentials.clientSecret ? "Configured" : "Missing"}
                ok={data.credentials.clientSecret}
              />
              <ConfigRow
                label="Ramp API authentication"
                value={data.apiAuth ? "Working" : data.apiAuthError || "Unavailable"}
                ok={data.apiAuth}
              />
            </div>

            <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
              <p className="text-sm font-medium">Resolved Payment Routing</p>
              <ConfigRow
                label="Entity"
                value={data.resolvedDefaults?.entityName || data.resolvedDefaults?.entityId || "Not resolved"}
                ok={Boolean(data.resolvedDefaults?.entityId)}
              />
              <ConfigRow
                label="Source bank account"
                value={
                  data.resolvedDefaults?.sourceBankAccountName ||
                  data.resolvedDefaults?.sourceBankAccountId ||
                  "Not resolved"
                }
                ok={Boolean(data.resolvedDefaults?.hasBillPayAccount)}
              />
              <ConfigRow
                label="Vendor owner"
                value={data.resolvedDefaults?.vendorOwnerId || "Not resolved"}
                ok={Boolean(data.resolvedDefaults?.vendorOwnerId)}
              />
            </div>

            <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
              <p className="text-sm font-medium">Receivables Link Template</p>
              <ConfigRow
                label="Template configured"
                value={data.linkTemplate.configured ? "Yes" : "No"}
                ok={data.linkTemplate.configured}
              />
              <ConfigRow
                label="Template mode"
                value={
                  data.linkTemplate.mode === "placeholders"
                    ? "Placeholder substitution"
                    : data.linkTemplate.mode === "query-append"
                      ? "Query-string append"
                      : "Missing"
                }
                ok={data.linkTemplate.mode !== "missing"}
              />
              <ConfigRow
                label="Template host/path"
                value={
                  data.linkTemplate.host
                    ? `${data.linkTemplate.host}${data.linkTemplate.pathname || ""}`
                    : "Not parseable / hidden"
                }
                ok={Boolean(data.linkTemplate.host)}
              />
            </div>

            <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
              <p className="text-sm font-medium">Configured Overrides (optional)</p>
              <ConfigRow
                label="RAMP_ENTITY_ID"
                value={data.configuredOverrides.entityId || "Not set"}
                ok={Boolean(data.configuredOverrides.entityId)}
              />
              <ConfigRow
                label="RAMP_SOURCE_BANK_ACCOUNT_ID"
                value={data.configuredOverrides.sourceBankAccountId || "Not set"}
                ok={Boolean(data.configuredOverrides.sourceBankAccountId)}
              />
              <ConfigRow
                label="RAMP_VENDOR_OWNER_ID"
                value={data.configuredOverrides.vendorOwnerId || "Not set (auto-discovery)"}
                ok={Boolean(data.configuredOverrides.vendorOwnerId)}
              />
            </div>

            {issues.length > 0 && (
              <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-yellow-700 dark:text-yellow-300">
                  <AlertCircle className="h-4 w-4" />
                  Ramp setup issues
                </div>
                <ul className="list-disc space-y-1 pl-5 text-sm text-yellow-700 dark:text-yellow-300">
                  {issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
