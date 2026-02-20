import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, FlaskConical, TrendingUp } from "lucide-react";
import { useState } from "react";

interface Scenario {
  action: string;
  label: string;
  result_wsi_delta: number;
  result_litigation_delta: number;
  result_pressure_delta: number;
  win_probability_range: string;
  explanation: string;
}

interface ScenarioSimulatorProps {
  scenarios: Scenario[] | null;
}

const DeltaBadge = ({ value, label }: { value: number; label: string }) => (
  <div className="text-center">
    <div className={`text-sm font-bold ${value > 0 ? "text-success" : value < 0 ? "text-destructive" : "text-muted-foreground"}`}>
      {value > 0 ? `+${value}` : value}
    </div>
    <div className="text-[10px] text-muted-foreground">{label}</div>
  </div>
);

export const ScenarioSimulator = ({ scenarios }: ScenarioSimulatorProps) => {
  const [open, setOpen] = useState(false);

  if (!scenarios || scenarios.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full">
        <Card className="border-primary/30 cursor-pointer hover:bg-primary/5 transition-colors">
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm flex items-center justify-between">
              <span className="flex items-center gap-2">
                <FlaskConical className="h-4 w-4 text-primary" />
                Scenario Simulation Engine
              </span>
              <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
            </CardTitle>
          </CardHeader>
        </Card>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          {scenarios.map((s, i) => (
            <Card key={i} className="border border-border">
              <CardContent className="p-3 space-y-2">
                <div className="text-xs font-semibold">{s.label}</div>
                <div className="flex items-center justify-between gap-2">
                  <DeltaBadge value={s.result_wsi_delta} label="WSI" />
                  <DeltaBadge value={s.result_litigation_delta} label="Litigation" />
                  <DeltaBadge value={s.result_pressure_delta} label="Pressure" />
                  <div className="text-center">
                    <div className="text-sm font-bold text-primary">{s.win_probability_range}</div>
                    <div className="text-[10px] text-muted-foreground">Win Prob.</div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{s.explanation}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
