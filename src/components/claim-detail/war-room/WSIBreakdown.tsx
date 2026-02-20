import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import { Info } from "lucide-react";

interface WSIComponent {
  score: number;
  weight: number;
  explanation: string;
}

interface WSIBreakdownProps {
  wsiScore: number | null;
  components: Record<string, WSIComponent> | null;
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

export const WSIBreakdown = ({ wsiScore, components, children }: WSIBreakdownProps) => {
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
