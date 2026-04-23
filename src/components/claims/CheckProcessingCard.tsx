import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { MortgageMonitoringSection } from "./MortgageMonitoringSection";

type Props = {
  claimId: string;
  checkId: string;
};

export function CheckProcessingCard({ claimId, checkId }: Props) {
  const [check, setCheck] = useState<any>(null);
  const [paymentDirection, setPaymentDirection] = useState<any>(null);
  const [disbursement, setDisbursement] = useState<any>(null);
  const [draws, setDraws] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);

    const [{ data: checkData }, { data: directionData }, { data: disbursementData }, { data: drawData }] =
      await Promise.all([
        supabase
          .from("claim_checks")
          .select("*")
          .eq("id", checkId)
          .single(),
        supabase
          .from("check_payment_directions")
          .select("*")
          .eq("check_id", checkId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("claim_disbursements")
          .select("*")
          .eq("check_id", checkId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("claim_check_mortgage_draws" as any)
          .select("*")
          .eq("check_id", checkId)
          .order("draw_number", { ascending: true }),
      ]);

    setCheck(checkData ?? null);
    setPaymentDirection(directionData ?? null);
    setDisbursement(disbursementData ?? null);
    setDraws((drawData as any[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [checkId]);

  async function markDeposited() {
    await supabase
      .from("claim_checks")
      .update({ deposit_status: "deposited" })
      .eq("id", checkId);

    await supabase.from("claim_events").insert({
      claim_id: claimId,
      event_type: "check_deposited",
      occurred_at: new Date().toISOString(),
      date_source: "system",
      summary: "Check marked as deposited.",
      metadata_json: { check_id: checkId },
    });

    load();
  }

  async function markCleared() {
    await supabase
      .from("claim_checks")
      .update({ cleared_status: "cleared" })
      .eq("id", checkId);

    await supabase.from("claim_events").insert({
      claim_id: claimId,
      event_type: "check_cleared",
      occurred_at: new Date().toISOString(),
      date_source: "system",
      summary: "Check marked as cleared.",
      metadata_json: { check_id: checkId },
    });

    load();
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading check workflow...</span>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Check Processing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <StatusRow label="Endorsement" value={check?.endorsement_status ?? "pending"} />
          <StatusRow label="Payment Direction" value={check?.payment_direction_status ?? "not_requested"} />
          <StatusRow label="Deposit" value={check?.deposit_status ?? "pending"} />
          <StatusRow label="Cleared" value={check?.cleared_status ?? "pending"} />
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={markDeposited}
            disabled={check?.deposit_status === "deposited"}
          >
            Mark Deposited
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={markCleared}
            disabled={check?.cleared_status === "cleared"}
          >
            Mark Cleared
          </Button>
        </div>

        {paymentDirection?.decision === "pay_contractor" && (
          <Badge variant="default">
            Client authorized direct contractor payment
          </Badge>
        )}

        {paymentDirection?.decision === "pay_insured" && (
          <Badge variant="secondary">
            Client requested funds be sent to insured
          </Badge>
        )}

        {/* Mortgage / Loss Draft section */}
        <MortgageMonitoringSection
          claimId={claimId}
          checkId={checkId}
          check={check}
          draws={draws}
          onRefresh={load}
        />
      </CardContent>
    </Card>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant="outline" className="capitalize text-xs">
        {value.replace(/_/g, " ")}
      </Badge>
    </div>
  );
}
