import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Info, Database } from "lucide-react";

interface WSIComponent {
  score: number;
  weight: number;
  explanation: string;
}

interface WSIBreakdownProps {
  wsiScore: number | null;
  components: Record<string, WSIComponent> | null;
  confidenceScores?: { overall?: string; data_basis_count?: number } | null;
  children: React.ReactNode;
}

const labels: Record<string, string> = {
  coverage_strength: "Coverage Strength",
  evidence_quality: "Evidence Quality",
  negotiation_leverage: "Negotiation Leverage",
  procedural_compliance: "Procedural Compliance",
  carrier_conduct_risk: "Carrier Conduct Risk",
};

const getBarColor = (score: number) => {
  if (score >= 75) return "bg-success";
  if (score >= 50) return "bg-warning";
  return "bg-destructive";
};

const getConfidenceBadge = (level?: string) => {
  if (!level) return null;
  const colors: Record<string, string> = {
    high: "bg-success/20 text-success",
    medium: "bg-warning/20 text-warning",
    low: "bg-muted text-muted-foreground",
  };
  return (
    <Badge className={`text-[10px] ${colors[level] || colors.low}`}>
      {level.charAt(0).toUpperCase() + level.slice(1)} Confidence
    </Badge>
  );
};

export const WSIBreakdown = ({ wsiScore, components, confidenceScores, children }: WSIBreakdownProps) => {
  if (!components) return <>{children}</>;

  const entries = Object.entries(components);

  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Weighted Strategic Index — {wsiScore ?? "--"}/100
          </DialogTitle>
        </DialogHeader>

        {confidenceScores && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {getConfidenceBadge(confidenceScores.overall)}
            {confidenceScores.data_basis_count != null && (
              <span className="flex items-center gap-1">
                <Database className="h-3 w-3" />
                {confidenceScores.data_basis_count} data points
              </span>
            )}
          </div>
        )}

        <div className="space-y-4 mt-2">
          {entries.map(([key, comp]) => (
            <div key={key} className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {labels[key] || key} <span className="text-xs">({comp.weight}%)</span>
                </span>
                <span className="font-semibold">{comp.score}</span>
              </div>
              <Progress value={comp.score} className={`h-2.5 ${getBarColor(comp.score)}`} />
              <p className="text-xs text-muted-foreground flex items-start gap-1">
                <Info className="h-3 w-3 mt-0.5 shrink-0" />
                {comp.explanation}
              </p>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
};
