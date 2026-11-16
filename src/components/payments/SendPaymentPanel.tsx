import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2 } from "lucide-react";

interface Props {
  checkIntakeItemId: string;
  checkAmount: number;
  checkNumber?: string;
  carrierName?: string;
  // The contractor tenant who is the recipient
  contractorTenantId: string;
  contractorName: string;
}

/**
 * Status of a payment sent from this check through the retired legacy rail.
 *
 * Sending happens in Disburse funds (the server-side partner send). This panel no longer
 * reads the partner's bank accounts: those belong to another organization, the browser
 * cannot read them, and the empty read falsely said the partner had no primary bank
 * (owner report 2026-11-16). It shows only a legacy payment that was
 * already sent, and nothing otherwise.
 */
export function SendPaymentPanel({ checkIntakeItemId, contractorTenantId, contractorName }: Props) {
  const { data: existingPayment } = useQuery({
    queryKey: ["claim-check-payment", checkIntakeItemId, contractorTenantId],
    enabled: !!checkIntakeItemId && !!contractorTenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("claim_check_payments")
        .select("*")
        .eq("check_intake_item_id", checkIntakeItemId)
        .eq("recipient_tenant_id", contractorTenantId)
        .order("created_at", { ascending: false })
        .limit(1);
      return data?.[0] ?? null;
    },
  });

  if (!existingPayment || existingPayment.status === "pending") return null;

  const money = (v: unknown) => Number(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          Payment {existingPayment.status === "settled" ? "Settled" : existingPayment.status}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md bg-muted/50 p-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Sent to</span>
            <span className="font-medium">{contractorName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Check amount</span>
            <span>${money(existingPayment.check_amount)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Your fee</span>
            <span className="text-amber-600">− ${money(existingPayment.pa_fee_amount)}</span>
          </div>
          <div className="flex justify-between border-t pt-2">
            <span className="font-medium">Amount sent</span>
            <span className="font-semibold text-emerald-600">${money(existingPayment.payment_amount)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-xs ${
            existingPayment.status === "settled" ? "text-emerald-600 border-emerald-500/30 bg-emerald-500/10" :
            existingPayment.status === "returned" ? "text-red-600 border-red-500/30 bg-red-500/10" :
            "text-blue-600 border-blue-500/30 bg-blue-500/10"
          }`}>
            {existingPayment.status}
            {existingPayment.return_code && ` · ${existingPayment.return_code}`}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
