import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Brain, Clock } from "lucide-react";

interface PredictedCarrierMoveProps {
  prediction: {
    prediction: string;
    confidence: number;
    timeline: string;
    basis: string[];
  } | null;
}

export const PredictedCarrierMove = ({ prediction }: PredictedCarrierMoveProps) => {
  if (!prediction) return null;

  const confidenceColor =
    prediction.confidence >= 75 ? "bg-success/20 text-success" :
    prediction.confidence >= 50 ? "bg-warning/20 text-warning" :
    "bg-muted text-muted-foreground";

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <Brain className="h-3.5 w-3.5 text-warning" />
          Predicted Carrier Next Move
        </div>
        <p className="text-sm">{prediction.prediction}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge className={confidenceColor}>{prediction.confidence}% confidence</Badge>
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
