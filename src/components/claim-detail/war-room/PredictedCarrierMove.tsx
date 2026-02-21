import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Brain, Clock, Database } from "lucide-react";

interface PredictedCarrierMoveProps {
  prediction: {
    prediction: string;
    confidence: number;
    timeline: string;
    basis: string[];
  } | null;
  confidenceLevel?: string | null;
}

const getConfidenceLabel = (score: number, level?: string | null): { label: string; color: string } => {
  // Rule-based confidence: high = strong carrier pattern + sufficient data, medium = moderate, low = limited
  if (level) {
    const colors: Record<string, string> = {
      high: "bg-success/20 text-success",
      medium: "bg-warning/20 text-warning",
      low: "bg-muted text-muted-foreground",
    };
    return { label: `${level.charAt(0).toUpperCase() + level.slice(1)} Confidence`, color: colors[level] || colors.low };
  }
  // Fallback to numeric
  if (score >= 70) return { label: "High Confidence", color: "bg-success/20 text-success" };
  if (score >= 45) return { label: "Medium Confidence", color: "bg-warning/20 text-warning" };
  return { label: "Low Confidence", color: "bg-muted text-muted-foreground" };
};

export const PredictedCarrierMove = ({ prediction, confidenceLevel }: PredictedCarrierMoveProps) => {
  if (!prediction) return null;

  const conf = getConfidenceLabel(prediction.confidence, confidenceLevel);

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <Brain className="h-3.5 w-3.5 text-warning" />
          Predicted Carrier Next Move
        </div>
        <p className="text-sm">{prediction.prediction}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge className={conf.color}>{conf.label}</Badge>
          <Badge variant="outline" className="gap-1 text-xs">
            <Clock className="h-3 w-3" />
            {prediction.timeline}
          </Badge>
        </div>
        {prediction.basis?.length > 0 && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Based on:</span> {prediction.basis.join("; ")}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
