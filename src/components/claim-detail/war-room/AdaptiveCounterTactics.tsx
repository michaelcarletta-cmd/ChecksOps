import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, Building2, Zap, Target, Loader2 } from "lucide-react";
import { lazy, Suspense } from "react";

const CarrierBehaviorProfile = lazy(() => import("../CarrierBehaviorProfile").then(m => ({ default: m.CarrierBehaviorProfile })));

interface CounterTactic {
  trigger_condition: string;
  recommended_action: string;
  escalation_if_no_response: string;
  letter_type?: string;
  success_rate_estimate?: number;
}

interface AdaptiveCounterTacticsProps {
  insights: any;
  claim: any;
  counterTactics: CounterTactic[] | null;
}

export const AdaptiveCounterTactics = ({ insights, claim, counterTactics }: AdaptiveCounterTacticsProps) => {
  return (
    <div className="space-y-4">
      {/* Matched Carrier Playbooks */}
      {Array.isArray(insights?.matched_playbooks) && insights.matched_playbooks.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold mb-2 flex items-center gap-1">
            <Building2 className="h-3 w-3 text-warning" />
            Carrier Tactics ({claim?.insurance_company})
          </h4>
          <div className="space-y-2">
            {insights.matched_playbooks.slice(0, 3).map((pb: any, i: number) => (
              <div key={i} className="text-xs p-2 bg-warning/10 rounded border border-warning/30">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold capitalize text-foreground">{pb.action_type}</span>
                  {pb.success_rate && (
                    <span className="text-[10px] bg-success/20 text-success px-1.5 rounded">
                      {pb.success_rate}% success
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground">{pb.recommended_action}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Rule-based escalation chains */}
      {counterTactics && counterTactics.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold mb-2 flex items-center gap-1">
            <Target className="h-3 w-3 text-primary" />
            Escalation Chains
          </h4>
          <div className="space-y-2">
            {counterTactics.map((ct, i) => (
              <Card key={i} className="border-border">
                <CardContent className="p-2 space-y-1.5">
                  <div className="text-xs">
                    <span className="font-medium text-warning">IF</span>{" "}
                    <span>{ct.trigger_condition}</span>
                  </div>
                  <div className="text-xs flex items-center gap-1">
                    <ArrowRight className="h-3 w-3 text-success" />
                    <span className="font-medium text-success">THEN</span>{" "}
                    <span>{ct.recommended_action}</span>
                  </div>
                  {ct.escalation_if_no_response && (
                    <div className="text-xs flex items-center gap-1 text-muted-foreground">
                      <ArrowRight className="h-3 w-3 text-destructive" />
                      <span className="font-medium text-destructive">ELSE</span>{" "}
                      <span>{ct.escalation_if_no_response}</span>
                    </div>
                  )}
                  {ct.success_rate_estimate && (
                    <Badge variant="outline" className="text-[10px]">
                      ~{ct.success_rate_estimate}% success rate
                    </Badge>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Recommended Moves */}
      {Array.isArray(insights?.recommended_next_moves) && insights.recommended_next_moves.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold mb-2 flex items-center gap-1">
            <Zap className="h-3 w-3 text-primary" />
            Recommended Moves
          </h4>
          <div className="space-y-2">
            {insights.recommended_next_moves.slice(0, 4).map((move: any, i: number) => (
              <div key={i} className="flex items-start gap-2 text-xs p-2 bg-primary/5 rounded border border-primary/20">
                <div className="flex items-center justify-center h-5 w-5 rounded-full bg-primary text-primary-foreground text-xs font-bold shrink-0">
                  {i + 1}
                </div>
                <span>{typeof move === "string" ? move : move.action || move.title || move.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Carrier Intelligence Fallback */}
      {(!insights?.matched_playbooks || insights.matched_playbooks.length === 0) && (
        <Suspense fallback={null}>
          <CarrierBehaviorProfile carrierName={claim?.insurance_company} compact />
        </Suspense>
      )}
    </div>
  );
};
