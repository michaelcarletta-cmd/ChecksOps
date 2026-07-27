import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ShieldAlert } from "lucide-react";
import { ONBOARDING_STATUS_LABEL, type AccountOnboardingStatus } from "@/lib/payments/types";

/**
 * Internal-only rollout view: which organizations are enabled for the platform
 * payment rail, where each one is in onboarding, and their capability state.
 * Read-only — no money movement happens from here.
 */
export function PaymentProviderAdmin() {
  const { data, isLoading } = useQuery({
    queryKey: ["payment-provider-admin"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_provider_accounts")
        .select(
          "id, tenant_id, provider, environment, onboarding_status, can_send_payments, can_receive_payments, restricted, disabled, last_synced_at, tenants(name)",
        )
        .order("last_synced_at", { ascending: false, nullsFirst: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-primary" />
          Rollout Status (internal)
        </CardTitle>
        <CardDescription className="text-xs">
          Organizations enabled for the platform payment rail and their current onboarding state.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-xs text-muted-foreground py-4">Loading…</p>
        ) : !data?.length ? (
          <p className="text-xs text-muted-foreground py-4">No organizations enabled yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Organization</TableHead>
                  <TableHead className="text-xs">Env</TableHead>
                  <TableHead className="text-xs">Status</TableHead>
                  <TableHead className="text-xs">Send</TableHead>
                  <TableHead className="text-xs">Receive</TableHead>
                  <TableHead className="text-xs">Last sync</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((row: any) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs">{row.tenants?.name ?? row.tenant_id}</TableCell>
                    <TableCell className="text-xs capitalize">{row.environment}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline" className="text-[10px]">
                        {ONBOARDING_STATUS_LABEL[
                          (row.onboarding_status ?? "not_started") as AccountOnboardingStatus
                        ] ?? row.onboarding_status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{row.can_send_payments ? "Yes" : "No"}</TableCell>
                    <TableCell className="text-xs">{row.can_receive_payments ? "Yes" : "No"}</TableCell>
                    <TableCell className="text-xs">
                      {row.last_synced_at ? new Date(row.last_synced_at).toLocaleString() : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
