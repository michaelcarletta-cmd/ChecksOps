import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CheckCircle2, XCircle } from "lucide-react";

interface Factor {
  met: boolean;
  detail: string;
}

interface LitigationReadinessProps {
  score: number | null;
  factors: Record<string, Factor> | null;
  children: React.ReactNode;
}

const labels: Record<string, string> = {
  expert_reports_present: "Expert Reports Present",
  damages_quantified: "Damages Fully Quantified",
  causation_documented: "Causation Documented",
  statutory_violations_logged: "Statutory Violations Logged",
  pre_suit_demand_drafted: "Pre-Suit Demand Drafted",
  evidence_gaps_remaining: "Evidence Gaps Closed",
};

export const LitigationReadiness = ({ score, factors, children }: LitigationReadinessProps) => {
  if (!factors) return <>{children}</>;

  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Litigation Readiness — {score ?? "--"}/100</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-2">
          {Object.entries(factors).map(([key, factor]) => (
            <div key={key} className="flex items-start gap-3 text-sm">
              {factor.met ? (
                <CheckCircle2 className="h-5 w-5 text-success shrink-0 mt-0.5" />
              ) : (
                <XCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              )}
              <div>
                <div className="font-medium">{labels[key] || key}</div>
                <div className="text-xs text-muted-foreground">{factor.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};
