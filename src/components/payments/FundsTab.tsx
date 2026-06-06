import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DollarSign, ArrowDownCircle, Send, Clock, CheckCircle2, AlertCircle } from "lucide-react";
import { format } from "date-fns";
import { DisbursementConsole } from "@/components/disbursement/DisbursementConsole";
import { useState } from "react";

interface Props {
  checkIntakeItemId: string;
  checkNumber?: string;
  carrierName?: string;
}

const STATUS_CONFIG: Record<string, { label: string; icon: any; className: string }> = {
  pending: { label: "Pending", icon: Clock, className: "text-amber-600 border-amber-500/30 bg-amber-500/10" },
  submitted: { label: "In Transit", icon: Send, className: "text-blue-600 border-blue-500/30 bg-blue-500/10" },
  settled: { label: "Settled", icon: CheckCircle2, className: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10" },
  returned: { label: "Returned", icon: AlertCircle, className: "text-red-600 border-red-500/30 bg-red-500/10" },
  failed: { label: "Failed", icon: AlertCircle, className: "text-red-600 border-red-500/30 bg-red-500/10" },
};

export function FundsTab({ checkIntakeItemId, checkNumber, carrierName }: Props) {
  const { tenant } = useTenant();
  const [showDisburse, setShowDisburse] = useState(false);

  const { data: incomingPayments = [], isLoading } = useQuery({
    queryKey: ["incoming-payments", checkIntakeItemId, tenant?.id],
    enabled: !!checkIntakeItemId && !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_check_payments")
        .select(`
          *,
          sender:sender_tenant_id (
            id,
            name
          )
        `)
        .eq("check_intake_item_id", checkIntakeItemId)
        .eq("recipient_tenant_id", tenant!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Disbursements this tenant sent out from this check (Actum)
  const { data: outgoingBatches = [] } = useQuery({
    queryKey: ["funds-tab-disbursements", checkIntakeItemId, tenant?.id],
    enabled: !!checkIntakeItemId && !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("disbursement_batches")
        .select(`id, created_at, status, disbursement_splits(id, amount, status, return_code, created_at, stakeholder_accounts(nickname))`)
        .eq("check_intake_item_id", checkIntakeItemId)
        .eq("tenant_id", tenant!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const outgoingSplits = outgoingBatches.flatMap((b: any) =>
    (b.disbursement_splits ?? []).map((s: any) => ({ ...s, batch_id: b.id }))
  );
  const totalDisbursed = outgoingSplits
    .filter((s: any) => s.status !== "failed" && s.status !== "cancelled" && s.status !== "returned")
    .reduce((sum: number, s: any) => sum + Number(s.amount || 0), 0);

  const totalReceived = incomingPayments
    .filter((p: any) => p.status === "settled")
    .reduce((sum: number, p: any) => sum + Number(p.payment_amount), 0);

  const totalInTransit = incomingPayments
    .filter((p: any) => p.status === "submitted")
    .reduce((sum: number, p: any) => sum + Number(p.payment_amount), 0);

  const latestSettled = incomingPayments.find((p: any) => p.status === "settled");

  if (isLoading) return <div className="text-sm text-muted-foreground p-4">Loading funds...</div>;

  if (incomingPayments.length === 0) {
    return (
      <div className="p-4 text-center space-y-2">
        <ArrowDownCircle className="h-8 w-8 text-muted-foreground mx-auto" />
        <p className="text-sm text-muted-foreground">No incoming payments yet for this check.</p>
        <p className="text-xs text-muted-foreground">The public adjuster will send funds here once the check clears.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-1">

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2">
        <Card>
          <CardContent className="pt-3 pb-3">
            <div className="flex items-center gap-1.5 mb-1">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-xs text-muted-foreground">Received</span>
            </div>
            <p className="text-lg font-semibold text-emerald-600">
              ${totalReceived.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 pb-3">
            <div className="flex items-center gap-1.5 mb-1">
              <Send className="h-3.5 w-3.5 text-blue-400" />
              <span className="text-xs text-muted-foreground">In Transit</span>
            </div>
            <p className="text-lg font-semibold text-blue-600">
              ${totalInTransit.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Payment list */}
      <div className="space-y-2">
        {incomingPayments.map((payment: any) => {
          const cfg = STATUS_CONFIG[payment.status] ?? STATUS_CONFIG.pending;
          const StatusIcon = cfg.icon;
          return (
            <Card key={payment.id}>
              <CardContent className="pt-3 pb-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <ArrowDownCircle className="h-3.5 w-3.5 text-emerald-400" />
                      <p className="text-sm font-medium">
                        ${Number(payment.payment_amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      From {payment.sender?.name ?? "Public Adjuster"}
                    </p>
                    {payment.created_at && (
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(payment.created_at), "MMM d, yyyy · h:mm a")}
                      </p>
                    )}
                  </div>
                  <Badge variant="outline" className={`text-[10px] flex-shrink-0 ${cfg.className}`}>
                    <StatusIcon className="h-2.5 w-2.5 mr-1" />
                    {cfg.label}
                  </Badge>
                </div>

                {/* Fee breakdown */}
                <div className="rounded-md bg-muted/40 p-2 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Check amount</span>
                    <span>${Number(payment.check_amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      PA fee {payment.pa_fee_pct ? `(${payment.pa_fee_pct}%)` : ""}
                    </span>
                    <span className="text-amber-600">
                      − ${Number(payment.pa_fee_amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex justify-between border-t pt-1 font-medium">
                    <span>You received</span>
                    <span className="text-emerald-600">
                      ${Number(payment.payment_amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                {payment.notes && (
                  <p className="text-xs text-muted-foreground italic">"{payment.notes}"</p>
                )}

                {payment.return_code && (
                  <div className="flex items-center gap-1.5 text-xs text-red-500">
                    <AlertCircle className="h-3 w-3" />
                    {payment.return_code} — {payment.return_desc}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Disburse button — only show when funds settled */}
      {totalReceived > 0 && (
        <div className="space-y-3">
          {!showDisburse ? (
            <Button className="w-full" onClick={() => setShowDisburse(true)}>
              <DollarSign className="h-4 w-4 mr-2" />
              Disburse ${totalReceived.toLocaleString("en-US", { minimumFractionDigits: 2 })} to subs & vendors
            </Button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Disbursement</p>
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setShowDisburse(false)}>
                  Hide
                </Button>
              </div>
              <DisbursementConsole
                checkIntakeItemId={checkIntakeItemId}
                checkAmount={totalReceived}
                checkNumber={checkNumber}
                carrierName={carrierName}
                onComplete={() => setShowDisburse(false)}
              />
            </div>
          )}
        </div>
      )}

      {/* In transit message */}
      {totalInTransit > 0 && totalReceived === 0 && (
        <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-xs text-blue-700 dark:text-blue-300">
          ${totalInTransit.toLocaleString("en-US", { minimumFractionDigits: 2 })} is in transit and should settle within 1–2 banking days. You'll be able to disburse once it settles.
        </div>
      )}

    </div>
  );
}
