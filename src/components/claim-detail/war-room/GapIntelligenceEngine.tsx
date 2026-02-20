import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, XCircle, AlertTriangle, FileSearch } from "lucide-react";
import { lazy, Suspense } from "react";

const EvidenceArsenal = lazy(() => import("../EvidenceArsenal").then(m => ({ default: m.EvidenceArsenal })));

interface EvidenceAssessment {
  strong_evidence: string[];
  weak_missing_evidence: string[];
  recommendations: string[];
  required_by_loss_type?: string[];
  missing_evidence_risk_score?: number;
  per_denial_defensive_evidence?: Array<{
    denial_reason: string;
    required_evidence: string[];
    have: string[];
    missing: string[];
  }>;
}

interface GapIntelligenceEngineProps {
  claimId: string;
  insights: any;
  evidenceAssessment: EvidenceAssessment | null;
}

export const GapIntelligenceEngine = ({ claimId, insights, evidenceAssessment }: GapIntelligenceEngineProps) => {
  const riskScore = evidenceAssessment?.missing_evidence_risk_score ?? null;
  const riskColor = riskScore !== null ? (riskScore >= 60 ? "bg-destructive" : riskScore >= 30 ? "bg-warning" : "bg-success") : "bg-muted";

  return (
    <div className="space-y-4">
      <Suspense fallback={<div className="text-xs text-muted-foreground">Loading evidence...</div>}>
        <EvidenceArsenal claimId={claimId} insights={insights} />
      </Suspense>

      {riskScore !== null && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              Missing Evidence Risk
            </span>
            <span className="font-semibold">{riskScore}/100</span>
          </div>
          <Progress value={riskScore} className={`h-2 ${riskColor}`} />
        </div>
      )}

      {evidenceAssessment?.required_by_loss_type && evidenceAssessment.required_by_loss_type.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold mb-1.5 flex items-center gap-1">
            <FileSearch className="h-3 w-3" />
            Required for Loss Type
          </h4>
          <div className="space-y-1">
            {evidenceAssessment.required_by_loss_type.map((item, i) => {
              const isMissing = evidenceAssessment.weak_missing_evidence?.some(
                w => w.toLowerCase().includes(item.toLowerCase())
              );
              return (
                <div key={i} className="flex items-center gap-2 text-xs">
                  {isMissing ? (
                    <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                  )}
                  <span className={isMissing ? "text-destructive" : "text-foreground"}>{item}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {evidenceAssessment?.per_denial_defensive_evidence && evidenceAssessment.per_denial_defensive_evidence.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold mb-1.5">Per-Denial Defensive Evidence</h4>
          <div className="space-y-2">
            {evidenceAssessment.per_denial_defensive_evidence.map((d, i) => (
              <Card key={i} className="border-border">
                <CardContent className="p-2 space-y-1">
                  <div className="text-xs font-medium">"{d.denial_reason}"</div>
                  {d.missing.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {d.missing.map((m, j) => (
                        <Badge key={j} variant="destructive" className="text-[10px]">{m}</Badge>
                      ))}
                    </div>
                  )}
                  {d.have.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {d.have.map((h, j) => (
                        <Badge key={j} variant="outline" className="text-[10px] border-success/50 text-success">{h}</Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
