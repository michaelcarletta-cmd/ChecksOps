import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Info } from "lucide-react";
import { feeScheduleRows, type TenantFeeRates } from "@/lib/billing/feeSchedule";

const RATE_COLUMNS =
  "monthly_rate_cents, referral_discount_cents, per_check_billing_enabled, per_check_rate_cents, next_day_rate_cents, same_day_rate_cents, mortgage_ops_initial_rate_cents, mortgage_ops_additional_rate_cents";

/**
 * "Fees you may be charged": the tenant's own rates, read-only. The platform
 * owner sets them in Tenant Management; a blank rate shows the default.
 */
export function FeeScheduleCard({ tenantId, chargedCheckCents }: { tenantId?: string; chargedCheckCents?: number | null }) {
  const { data: rates } = useQuery({
    queryKey: ["tenant-fee-rates", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.from("tenants").select(RATE_COLUMNS).eq("id", tenantId!).maybeSingle();
      if (error) throw error;
      return (data ?? null) as TenantFeeRates | null;
    },
    enabled: !!tenantId,
  });

  const rows = feeScheduleRows(rates, chargedCheckCents);
  const money = (cents: number | null) =>
    cents === null
      ? "Set by your plan"
      : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Info className="h-4 w-4 text-primary" />
          Fees you may be charged
        </CardTitle>
        <CardDescription className="text-[10px]">
          Each fee shows up in your usage below as it happens, with the claim check it was for, and is billed on your
          monthly invoice. A payment that fails is not charged.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Fee</TableHead>
              <TableHead className="text-xs">When it applies</TableHead>
              <TableHead className="text-xs text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="text-xs font-medium">{row.fee}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{row.when}</TableCell>
                <TableCell className="text-xs text-right font-semibold tabular-nums">{money(row.amount_cents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
