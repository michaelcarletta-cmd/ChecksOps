import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

interface PressureFactor {
  present: boolean;
  detail: string;
}

interface PressureIndexProps {
  score: number | null;
  level: string | null;
  factors: Record<string, PressureFactor> | null;
  confidenceLevel?: string | null;
  children: React.ReactNode;
}

const labels: Record<string, string> = {
  statutory_violations: "Statutory Violations",
  missed_deadlines: "Missed Deadlines",
  bad_faith_indicators: "Bad Faith Indicators",
  complaint_exposure: "Complaint Exposure",
  litigation_cost_risk: "Litigation Cost Risk",
};

const thresholdDefs: Record<string, { range: string; description: string }> = {
  low: { range: "0–39", description: "No strong carrier violations. Compliance is generally acceptable. Limited negotiation pressure available." },
  moderate: { range: "40–69", description: "Some missed deadlines or procedural concerns identified. Moderate leverage for escalation." },
  high: { range: "70–100", description: "Multiple statutory violations, clear bad faith indicators, or missed deadlines. Strong escalation leverage. Requires at least 2 triggering factors." },
};

export const PressureIndex = ({ score, level, factors, confidenceLevel, children }: PressureIndexProps) => {
  const badgeColor =
    level === "high" ? "bg-destructive text-destructive-foreground" :
    level === "moderate" ? "bg-warning text-warning-foreground" :
    "bg-success/20 text-success";

  if (!factors) return <>{children}</>;

  const activeTriggers = Object.values(factors).filter(f => f.present).length;
  const threshold = thresholdDefs[level || "low"];

  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Pressure Index — {score ?? "--"}/100
            <Badge className={badgeColor}>{level?.toUpperCase() || "--"}</Badge>
          </DialogTitle>
        </DialogHeader>

        {/* Threshold explanation */}
        {threshold && (
          <div className="flex items-start gap-2 p-2 rounded bg-muted/50 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div>
              <span className="font-medium capitalize">{level}</span> ({threshold.range}): {threshold.description}
            </div>
          </div>
        )}

        {confidenceLevel && (
          <div className="text-xs text-muted-foreground">
            Confidence: <span className="font-medium capitalize">{confidenceLevel}</span> • {activeTriggers} active trigger{activeTriggers !== 1 ? "s" : ""}
          </div>
        )}

        <div className="space-y-3 mt-2">
          {Object.entries(factors).map(([key, factor]) => (
            <div key={key} className="flex items-start gap-3 text-sm">
              {factor.present ? (
                <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
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
