import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

interface PressureFactor {
  present: boolean;
  detail: string;
}

interface PressureIndexProps {
  score: number | null;
  level: string | null;
  factors: Record<string, PressureFactor> | null;
  children: React.ReactNode;
}

const labels: Record<string, string> = {
  statutory_violations: "Statutory Violations",
  missed_deadlines: "Missed Deadlines",
  bad_faith_indicators: "Bad Faith Indicators",
  complaint_exposure: "Complaint Exposure",
  litigation_cost_risk: "Litigation Cost Risk",
};

export const PressureIndex = ({ score, level, factors, children }: PressureIndexProps) => {
  const badgeVariant = level === "high" ? "destructive" : level === "moderate" ? "secondary" : "outline";
  const badgeColor =
    level === "high" ? "bg-destructive text-destructive-foreground" :
    level === "moderate" ? "bg-warning text-warning-foreground" :
    "bg-success/20 text-success";

  if (!factors) return <>{children}</>;

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
