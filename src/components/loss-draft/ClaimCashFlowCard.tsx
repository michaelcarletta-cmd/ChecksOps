import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { DollarSign, ArrowRightLeft, CheckCircle2 } from "lucide-react";

interface Props {
  /** The claim whose loss drafts (and, in full mode, payments and checks) are summed. */
  claimId?: string | null;
  /** The check whose loss draft is summed when it has no claim yet (check detail Funds tab). */
  checkIntakeItemId?: string | null;
  /**
   * Escrow only (check detail Funds tab): Total Escrowed, Released and Outstanding from
   * loss_draft_tracking, shown only when a loss draft exists. No payment or check reads.
   */
  escrowOnly?: boolean;
}

type DraftAmounts = {
  id: string;
  total_escrowed: number | string | null;
  draw_amount_released: number | string | null;
  holdback_amount: number | string | null;
  escrow_status: string;
};

const DRAFT_AMOUNT_COLUMNS = "id, total_escrowed, draw_amount_released, holdback_amount, escrow_status";
const money = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Escrowed, released, holdback and outstanding (escrowed - released - holdback, never negative). */
export function lossDraftEscrowTotals(drafts: Pick<DraftAmounts, "total_escrowed" | "draw_amount_released" | "holdback_amount">[]) {
  const escrowed = drafts.reduce((s, d) => s + num(d.total_escrowed), 0);
  const released = drafts.reduce((s, d) => s + num(d.draw_amount_released), 0);
  const holdback = drafts.reduce((s, d) => s + num(d.holdback_amount), 0);
  const outstanding = Math.max(0, Math.round((escrowed - released - holdback) * 100) / 100);
  return { escrowed, released, holdback, outstanding };
}

// Only these payment methods count as insurance proceeds
const INSURANCE_METHODS = ["insurance_check", "insurance_payment", "check"];
// Check statuses that should NOT count toward insurance received
const EXCLUDED_CHECK_STATUSES = ["reissue_requested", "rejected", "voided", "cancelled"];

export function ClaimCashFlowCard({ claimId = null, checkIntakeItemId = null, escrowOnly = false }: Props) {
  const { data: payments = [] } = useQuery({
    queryKey: ["claim-payments-cashflow", claimId],
    enabled: !!claimId && !escrowOnly,
    queryFn: async () => {
      const { data } = await supabase
        .from("claim_payments")
        .select("amount, direction, payment_method, check_intake_item_id")
        .eq("claim_id", claimId!)
        .eq("direction", "inbound");
      return data ?? [];
    },
  });

  // Source of truth: any check linked to this claim (covers checks that were
  // uploaded/linked after OCR and never got a claim_payments row).
  const { data: checks = [] } = useQuery({
    queryKey: ["claim-checks-cashflow", claimId],
    enabled: !!claimId && !escrowOnly,
    queryFn: async () => {
      const { data } = await supabase
        .from("check_intake_items")
        .select("id, amount, status, check_stage, check_source")
        .eq("claim_id", claimId!);
      return data ?? [];
    },
  });

  // Loss drafts of the claim, plus the check's own draft (keyed by check_intake_item_id,
  // which covers a draft whose check has no claim yet), deduped by id.
  const { data: drafts = [] } = useQuery({
    queryKey: ["claim-loss-drafts", claimId, checkIntakeItemId],
    enabled: !!claimId || !!checkIntakeItemId,
    queryFn: async () => {
      const [byClaim, byCheck] = await Promise.all([
        claimId
          ? supabase.from("loss_draft_tracking").select(DRAFT_AMOUNT_COLUMNS).eq("claim_id", claimId)
          : Promise.resolve({ data: [] as DraftAmounts[] }),
        checkIntakeItemId
          ? supabase.from("loss_draft_tracking").select(DRAFT_AMOUNT_COLUMNS).eq("check_intake_item_id", checkIntakeItemId)
          : Promise.resolve({ data: [] as DraftAmounts[] }),
      ]);
      const seen = new Map<string, DraftAmounts>();
      for (const d of [...((byClaim.data ?? []) as DraftAmounts[]), ...((byCheck.data ?? []) as DraftAmounts[])]) {
        seen.set(d.id, d);
      }
      return [...seen.values()];
    },
  });

  if (escrowOnly) {
    if (drafts.length === 0) return null;
    const totals = lossDraftEscrowTotals(drafts);
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-amber-400" />
            Loss Draft Escrow
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <p className="text-[10px] text-muted-foreground">Total Escrowed</p>
              <p className="text-sm font-bold text-amber-400">{money(totals.escrowed)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Released</p>
              <p className="text-sm font-bold text-emerald-400">{money(totals.released)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Outstanding</p>
              <p className="text-sm font-bold">{money(totals.outstanding)}</p>
            </div>
          </div>
          {totals.holdback > 0 && (
            <p className="mt-2 text-[10px] text-muted-foreground">
              Outstanding excludes a holdback of {money(totals.holdback)}.
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  // Insurance received: union of claim_payments (inbound) + linked check_intake_items,
  // deduped by check id so we don't double count.
  const insurancePayments = payments.filter(
    (p: any) => !p.payment_method || INSURANCE_METHODS.includes(p.payment_method)
  );
  const paidCheckIds = new Set(
    insurancePayments.map((p: any) => p.check_intake_item_id).filter(Boolean)
  );
  const eligibleChecks = checks.filter(
    (c: any) =>
      Number(c.amount ?? 0) > 0 &&
      !EXCLUDED_CHECK_STATUSES.includes(c.status) &&
      (c.check_source ?? "insurance") === "insurance"
  );
  const paymentsTotal = insurancePayments.reduce((s: number, p: any) => s + (p.amount ?? 0), 0);
  const extraFromChecks = eligibleChecks
    .filter((c: any) => !paidCheckIds.has(c.id))
    .reduce((s: number, c: any) => s + Number(c.amount ?? 0), 0);
  const totalReceived = paymentsTotal + extraFromChecks;

  const { escrowed: totalEscrowed, released: draftsReleased, holdback: totalHoldback } = lossDraftEscrowTotals(drafts);
  // Also count any checks manually advanced to funds_released or disbursed_externally
  const checksReleased = eligibleChecks
    .filter((c: any) => c.check_stage === "funds_released" || c.check_stage === "disbursed_externally")
    .reduce((s: number, c: any) => s + Number(c.amount ?? 0), 0);
  const totalReleased = draftsReleased + checksReleased;
  const releasePercent = totalEscrowed > 0
    ? (Math.min(totalReleased, totalEscrowed) / totalEscrowed) * 100
    : 0;

  const activeDrafts = drafts.filter(d => d.escrow_status !== "final_release_complete");
  const nextAction = activeDrafts.length === 0
    ? totalEscrowed > 0 ? "All funds released" : "No mortgage escrow"
    : activeDrafts.some(d => d.escrow_status === "pending_send") ? "Send check to lender"
    : activeDrafts.some(d => d.escrow_status === "escrowed") ? "Request first draw"
    : activeDrafts.some(d => d.escrow_status === "first_draw_requested") ? "Waiting on draw release"
    : activeDrafts.some(d => d.escrow_status === "partial_release") ? "Request next draw"
    : "Follow up with lender";

  if (totalReceived === 0 && drafts.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-emerald-400" />
          Claim Cash Flow
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <p className="text-[10px] text-muted-foreground">Insurance Received</p>
            <p className="text-sm font-bold">
              ${totalReceived.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">In Mortgage Escrow</p>
            <p className="text-sm font-bold text-amber-400">
              ${totalEscrowed.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">Funds Released</p>
            <p className="text-sm font-bold text-emerald-400">
              ${totalReleased.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground">Holdback Remaining</p>
            <p className="text-sm font-bold text-red-400">
              ${totalHoldback.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        {totalEscrowed > 0 && (
          <div>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
              <span>Release Progress</span>
              <span>{releasePercent.toFixed(0)}%</span>
            </div>
            <Progress value={releasePercent} className="h-2" />
          </div>
        )}

        <div className="flex items-center gap-2 bg-accent/30 rounded-lg p-2">
          {activeDrafts.length > 0 ? (
            <ArrowRightLeft className="h-4 w-4 text-orange-400 shrink-0" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
          )}
          <div>
            <p className="text-[10px] text-muted-foreground">Next Action</p>
            <p className="text-xs font-medium">{nextAction}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
