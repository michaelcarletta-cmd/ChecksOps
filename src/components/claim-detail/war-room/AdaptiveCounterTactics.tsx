import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Building2,
  Zap,
  Target,
  FileText,
  CalendarClock,
  ShieldAlert,
  ChevronRight,
  TrendingUp,
  PlayCircle,
} from "lucide-react";
import { lazy, Suspense } from "react";

const CarrierBehaviorProfile = lazy(() =>
  import("../CarrierBehaviorProfile").then((m) => ({
    default: m.CarrierBehaviorProfile,
  }))
);

interface CounterTactic {
  id?: string;
  title?: string;
  trigger_condition: string;
  current_situation?: string;

  recommended_action: string;
  action_purpose?: string;

  escalation_if_no_response?: string;
  escalation_timeline?: string;

  why_this_works?: string;

  letter_type?: string;
  success_rate_estimate?: number;

  priority?: "high" | "medium" | "low";
  confidence?: "high" | "medium" | "low";
  pressure_impact?: "high" | "medium" | "low";
  recommended_due?: string;

  action_label?: string;
  escalation_label?: string;
}

interface AdaptiveCounterTacticsProps {
  insights: any;
  claim: any;
  counterTactics: CounterTactic[] | null;

  onExecuteAction?: (tactic: CounterTactic) => void;
  onGenerateLetter?: (tactic: CounterTactic) => void;
  onAddToTimeline?: (tactic: CounterTactic) => void;
}

const priorityStyles: Record<string, string> = {
  high: "bg-destructive/10 text-destructive border-destructive/30",
  medium: "bg-warning/10 text-warning border-warning/30",
  low: "bg-muted text-muted-foreground border-border",
};

const confidenceStyles: Record<string, string> = {
  high: "bg-success/10 text-success border-success/30",
  medium: "bg-primary/10 text-primary border-primary/30",
  low: "bg-muted text-muted-foreground border-border",
};

const pressureStyles: Record<string, string> = {
  high: "bg-destructive/10 text-destructive border-destructive/30",
  medium: "bg-warning/10 text-warning border-warning/30",
  low: "bg-success/10 text-success border-success/30",
};

export const AdaptiveCounterTactics = ({
  insights,
  claim,
  counterTactics,
  onExecuteAction,
  onGenerateLetter,
  onAddToTimeline,
}: AdaptiveCounterTacticsProps) => {
  return (
    <div className="space-y-4">

      {Array.isArray(insights?.matched_playbooks) &&
        insights.matched_playbooks.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold mb-2 flex items-center gap-1">
              <Building2 className="h-3 w-3 text-warning" />
              Carrier Tactics ({claim?.insurance_company})
            </h4>

            <div className="space-y-2">
              {insights.matched_playbooks.slice(0, 3).map((pb: any, i: number) => (
                <div key={i} className="text-xs p-2 bg-warning/10 rounded border border-warning/30">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold capitalize text-foreground">
                      {pb.action_type}
                    </span>
                    {pb.success_rate && (
                      <span className="text-[10px] bg-success/20 text-success px-1.5 rounded">
                        {pb.success_rate}% success
                      </span>
                    )}
                  </div>

                  <p className="text-muted-foreground">
                    {pb.recommended_action}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

      {counterTactics && counterTactics.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold mb-2 flex items-center gap-1">
            <Target className="h-3 w-3 text-primary" />
            Strategic Response Paths
          </h4>

          <div className="space-y-3">
            {counterTactics.map((ct, i) => (
              <Card key={ct.id || i} className="border-border">
                <CardContent className="p-3 space-y-3">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-foreground">
                        {ct.title || `Response Strategy ${i + 1}`}
                      </div>

                      {ct.current_situation && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {ct.current_situation}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-1 shrink-0">
                      {ct.priority && (
                        <Badge variant="outline" className={`text-[10px] ${priorityStyles[ct.priority]}`}>
                          {ct.priority} priority
                        </Badge>
                      )}

                      {ct.confidence && (
                        <Badge variant="outline" className={`text-[10px] ${confidenceStyles[ct.confidence]}`}>
                          {ct.confidence} confidence
                        </Badge>
                      )}

                      {ct.pressure_impact && (
                        <Badge variant="outline" className={`text-[10px] ${pressureStyles[ct.pressure_impact]}`}>
                          <TrendingUp className="h-2.5 w-2.5 mr-0.5" />
                          {ct.pressure_impact} pressure impact
                        </Badge>
                      )}

                      {ct.letter_type && (
                        <Badge variant="outline" className="text-[10px]">
                          <FileText className="h-2.5 w-2.5 mr-0.5" />
                          {ct.letter_type}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Sections */}
                  <div className="space-y-2 text-xs">
                    <div className="p-2 rounded bg-warning/5 border border-warning/20">
                      <div className="font-medium text-warning mb-0.5">
                        Trigger
                      </div>
                      <div className="text-foreground">
                        {ct.trigger_condition}
                      </div>
                    </div>

                    <div className="p-2 rounded bg-success/5 border border-success/20">
                      <div className="font-medium text-success mb-0.5">
                        Recommended Move Now
                      </div>

                      <div className="text-foreground">
                        {ct.recommended_action}
                      </div>

                      {ct.action_purpose && (
                        <div className="text-muted-foreground mt-1 italic">
                          Purpose: {ct.action_purpose}
                        </div>
                      )}
                    </div>

                    {ct.escalation_if_no_response && (
                      <div className="p-2 rounded bg-destructive/5 border border-destructive/20">
                        <div className="font-medium text-destructive mb-0.5">
                          Escalate If No Response
                        </div>

                        <div className="text-foreground">
                          {ct.escalation_if_no_response}
                        </div>

                        {ct.escalation_timeline && (
                          <div className="text-muted-foreground mt-1 italic">
                            Timeline: {ct.escalation_timeline}
                          </div>
                        )}
                      </div>
                    )}

                    {ct.why_this_works && (
                      <div className="p-2 rounded bg-primary/5 border border-primary/20">
                        <div className="font-medium text-primary mb-0.5">
                          Why This Works
                        </div>
                        <div className="text-foreground">
                          {ct.why_this_works}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Meta badges */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {typeof ct.success_rate_estimate === "number" && (
                      <Badge variant="outline" className="text-[10px]">
                        ~{ct.success_rate_estimate}% success rate
                      </Badge>
                    )}

                    {ct.recommended_due && (
                      <Badge variant="outline" className="text-[10px]">
                        <CalendarClock className="h-2.5 w-2.5 mr-0.5" />
                        due {ct.recommended_due}
                      </Badge>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border">
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => onExecuteAction?.(ct)}
                      >
                        <PlayCircle className="h-3 w-3" />
                        {ct.action_label || "Execute Action"}
                      </Button>
                      {ct.letter_type && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          onClick={() => onGenerateLetter?.(ct)}
                        >
                          <FileText className="h-3 w-3" />
                          Generate Letter
                        </Button>
                      )}

                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1"
                        onClick={() => onAddToTimeline?.(ct)}
                      >
                        <CalendarClock className="h-3 w-3" />
                        Add to Timeline
                      </Button>

                      {ct.escalation_if_no_response && (
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 text-xs gap-1"
                          onClick={() =>
                            onExecuteAction?.({
                              ...ct,
                              recommended_action:
                                ct.escalation_if_no_response || ct.recommended_action,
                              action_label: ct.escalation_label || "Escalate",
                            })
                          }
                        >
                          <ShieldAlert className="h-3 w-3" />
                          {ct.escalation_label || "Escalate"}
                          <ChevronRight className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(insights?.recommended_next_moves) &&
        insights.recommended_next_moves.length > 0 && (
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

                  <span>
                    {typeof move === "string"
                      ? move
                      : move.action || move.title || move.description}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

      {(!insights?.matched_playbooks ||
        insights.matched_playbooks.length === 0) && (
        <Suspense fallback={null}>
          <CarrierBehaviorProfile carrierName={claim?.insurance_company} compact />
        </Suspense>
      )}
    </div>
  );
};
