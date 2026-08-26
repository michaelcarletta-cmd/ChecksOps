import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building2, Landmark, Loader2 } from "lucide-react";

/**
 * Makes the platform / tenant Moov split explicit.
 *
 * The platform (master merchant) account is a backend setting and is never
 * shown here; this card only surfaces THIS tenant's own connected Moov
 * account so it is obvious which account a payout will run against.
 */
export function TenantMoovIdentityCard({
  tenantId,
  tenantName,
}: {
  tenantId: string;
  tenantName: string;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["tenant-moov-identity", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_provider_accounts")
        .select("provider, provider_account_id, environment, status, verification_status")
        .eq("tenant_id", tenantId)
        .eq("provider", "moov")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Landmark className="h-4 w-4 text-primary" />
          Payments Identity
        </CardTitle>
        <CardDescription className="text-xs">
          {tenantName} transacts under its own connected payment account — separate from the
          ChecksOps platform (master merchant) account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        )}

        {!isLoading && (data ?? []).length === 0 && (
          <p className="text-xs text-muted-foreground">
            No connected payment account yet for this organization.
          </p>
        )}

        {(data ?? []).map((a: any) => (
          <div
            key={`${a.environment}-${a.provider_account_id}`}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
          >
            <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <code className="text-[11px] font-mono break-all">{a.provider_account_id}</code>
            <Badge variant="outline" className="text-[10px]">
              {a.environment}
            </Badge>
            {a.status && (
              <Badge variant="outline" className="text-[10px]">
                {a.status}
              </Badge>
            )}
            {a.verification_status && (
              <Badge variant="outline" className="text-[10px]">
                {a.verification_status}
              </Badge>
            )}
          </div>
        ))}

        <p className="text-[11px] text-muted-foreground">
          Platform-level Moov settings live in the platform owner login only and are never applied
          to a tenant's payouts.
        </p>
      </CardContent>
    </Card>
  );
}
