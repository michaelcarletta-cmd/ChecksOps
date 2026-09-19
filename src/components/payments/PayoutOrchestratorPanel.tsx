import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePayoutOrchestrator } from "@/hooks/usePayoutOrchestrator";
import { useToast } from "@/hooks/use-toast";
import {
  exclusivePayoutActions,
  moneyCents,
  PAYOUT_UX_LABEL,
  PAYOUT_UX_STAGES,
  type PayoutOrchestratorPlan,
  type PayoutUxStage,
} from "@/lib/payoutOrchestrator";
import { ArrowRight, Loader2, Wallet } from "lucide-react";

const STAGE_TONE: Record<PayoutUxStage, string> = {
  funding_required: "border-amber-500/40 text-amber-500 bg-amber-500/5",
  funding_pending: "border-sky-500/40 text-sky-500 bg-sky-500/5",
  funds_available: "border-emerald-500/40 text-emerald-500 bg-emerald-500/5",
  ready_to_send: "border-emerald-500/40 text-emerald-500 bg-emerald-500/5",
  payment_pending: "border-sky-500/40 text-sky-500 bg-sky-500/5",
  payment_completed: "border-emerald-500/40 text-emerald-500 bg-emerald-500/5",
};

export function PayoutOrchestratorPanel({
  tenantId,
  plan,
}: {
  tenantId?: string | null;
  plan?: PayoutOrchestratorPlan | null;
}) {
  const { toast } = useToast();
  const orchestrate = usePayoutOrchestrator();
  const view = plan || orchestrate.data || null;
  const stage = (view?.ux?.stage || view?.ux_stage || "funding_required") as PayoutUxStage;
  const actions = view?.ux?.actions || exclusivePayoutActions(stage);
  const bothEnabled = Boolean(actions.prepare_funding && actions.prepare_payout) || actions.both_enabled;
  const canPrepareFunding = actions.prepare_funding && !actions.prepare_payout && !bothEnabled;
  const canPreparePayout = actions.prepare_payout && !actions.prepare_funding && !bothEnabled;

  async function refreshPlan() {
    if (!tenantId) return;
    try {
      await orchestrate.mutateAsync(tenantId);
    } catch (error) {
      toast({
        title: "Could not load payout plan",
        description: (error as Error).message,
        variant: "destructive",
      });
    }
  }

  return (
    <Card className="overflow-hidden border-border/60 shadow-sm">
      <div className="h-1.5 bg-primary/40" />
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Wallet className="h-4 w-4" />
          Shortfall-aware payout
        </CardTitle>
        <Badge variant="outline" className={`text-[10px] ${STAGE_TONE[stage] ?? ""}`}>
          {view?.ux?.stage_label || PAYOUT_UX_LABEL[stage]}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-2">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Payout requested</p>
            <p className="font-semibold">{moneyCents(view?.ux?.payout_requested ?? view?.payout_cents ?? 1)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Wallet available</p>
            <p className="font-semibold">{moneyCents(view?.ux?.wallet_available ?? view?.available_cents ?? 0)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Funding required</p>
            <p className="font-semibold">{moneyCents(view?.ux?.funding_required ?? view?.shortfall_cents ?? 0)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Funding source</p>
            <p className="font-semibold">{view?.ux?.funding_source || "Wells Fargo ••••4573"}</p>
          </div>
          <div className="col-span-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Recipient</p>
            <p className="font-semibold">{view?.ux?.recipient || "Chase ••••1506"}</p>
          </div>
        </div>

        <ol className="grid grid-cols-2 gap-2 text-xs md:grid-cols-3">
          {PAYOUT_UX_STAGES.map((item) => (
            <li
              key={item}
              className={`rounded-md border px-2 py-1.5 ${
                item === stage ? "border-primary/40 bg-primary/5 font-medium" : "border-border/60 text-muted-foreground"
              }`}
            >
              {PAYOUT_UX_LABEL[item]}
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!canPrepareFunding || orchestrate.isPending}
            onClick={() => {
              if (!canPrepareFunding || canPreparePayout) return;
              void refreshPlan();
            }}
          >
            {orchestrate.isPending && canPrepareFunding ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowRight className="mr-2 h-3.5 w-3.5" />
            )}
            Prepare funding
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canPreparePayout || orchestrate.isPending}
            onClick={() => {
              if (!canPreparePayout || canPrepareFunding) return;
              void refreshPlan();
            }}
          >
            Prepare payout
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Funding and payout cannot run at the same time. This view plans the next step only — it does not move money.
        </p>
      </CardContent>
    </Card>
  );
}
