import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Copy,
  HelpCircle,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { CausationResult, CausationFormData } from "./types";
import { PERILS } from "./indicators";

interface CausationResultsProps {
  result: CausationResult;
  formData: CausationFormData;
  claimNumber?: string;
}

export function CausationResults({
  result,
  formData,
  claimNumber,
}: CausationResultsProps) {
  const perilLabel =
    PERILS.find((p) => p.value === formData.perilTested)?.label || formData.perilTested;

  const getDecisionColor = (decision: string) => {
    switch (decision) {
      case "supported":
        return "bg-green-500/10 text-green-700 border-green-500/30";
      case "not_supported":
        return "bg-red-500/10 text-red-700 border-red-500/30";
      default:
        return "bg-yellow-500/10 text-yellow-700 border-yellow-500/30";
    }
  };

  const getDecisionIcon = (decision: string) => {
    switch (decision) {
      case "supported":
        return <CheckCircle2 className="h-5 w-5 text-green-600" />;
      case "not_supported":
        return <XCircle className="h-5 w-5 text-red-600" />;
      default:
        return <AlertTriangle className="h-5 w-5 text-yellow-600" />;
    }
  };

  const handleCopyReport = () => {
    let report = `COUNTERFACTUAL CAUSATION ANALYSIS\n`;
    report += `${"=".repeat(60)}\n\n`;
    report += `Claim: ${claimNumber || "N/A"}\n`;
    report += `Peril Tested: ${perilLabel}\n`;
    report += `Damage Type(s): ${formData.damageTypes.join(", ")}\n`;
    report += `Event Date: ${formData.eventDate || "Not specified"}\n\n`;

    report += `COUNTERFACTUAL QUESTION:\n${result.counterfactualQuestion}\n\n`;
    report += `DIRECT ANSWER:\n${result.directAnswer}\n\n`;
    report += `CONCLUSION:\n${result.conclusion}\n\n`;
    report += `REASONING SUMMARY:\n${result.reasoningSummary}\n\n`;

    if (result.baselineContext) {
      report += `BASELINE CONTEXT:\n${result.baselineContext}\n\n`;
    }

    if (result.supportingObservations.length > 0) {
      report += `SUPPORTING OBSERVATIONS:\n`;
      result.supportingObservations.forEach((item) => {
        report += `• ${item.label}\n`;
      });
      report += `\n`;
    }

    if (result.opposingObservations.length > 0) {
      report += `ALTERNATIVE-CAUSE OBSERVATIONS:\n`;
      result.opposingObservations.forEach((item) => {
        report += `• ${item.label}\n`;
      });
      report += `\n`;
    }

    if (result.evidenceGaps.length > 0) {
      report += `EVIDENCE GAPS:\n`;
      result.evidenceGaps.forEach((gap) => {
        report += `• ${gap}\n`;
      });
      report += `\n`;
    }

    report += `CARRIER BURDEN:\n${result.carrierBurdenStatement}\n\n`;
    report += `${"=".repeat(60)}\n`;
    report += `Analysis Date: ${new Date().toLocaleDateString()}\n`;
    report += `Note: Unknown indicators are not treated as evidence against causation.\n`;

    navigator.clipboard.writeText(report);
    toast.success("Causation report copied to clipboard");
  };

  return (
    <div className="space-y-4">
      {/* Decision Header */}
      <Card className={cn("border", getDecisionColor(result.decision))}>
        <CardContent className="pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 space-y-3">
              <div className="flex items-center gap-2">
                {getDecisionIcon(result.decision)}
                <span className="font-semibold text-lg">{result.decisionLabel}</span>
              </div>

              <p className="text-sm font-medium italic">
                {result.counterfactualQuestion}
              </p>

              <p className="text-sm">{result.directAnswer}</p>
            </div>

            <Button variant="outline" size="sm" onClick={handleCopyReport} className="flex-shrink-0">
              <Copy className="h-4 w-4 mr-1" />
              Copy Report
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Conclusion & Reasoning */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Conclusion</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm">{result.conclusion}</p>
          <p className="text-sm text-muted-foreground">{result.reasoningSummary}</p>
          {result.baselineContext && (
            <p className="text-sm text-muted-foreground italic">{result.baselineContext}</p>
          )}
        </CardContent>
      </Card>

      {/* Carrier Burden */}
      <Card className="border-primary/20">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-primary" />
            Carrier Burden
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{result.carrierBurdenStatement}</p>
        </CardContent>
      </Card>

      {/* Observations */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Supporting Observations
            </CardTitle>
          </CardHeader>
          <CardContent>
            {result.supportingObservations.length > 0 ? (
              <ul className="space-y-2">
                {result.supportingObservations.map((item) => (
                  <li key={item.id} className="text-sm flex items-start gap-2">
                    <CheckCircle2 className="h-3 w-3 mt-1 text-green-600 flex-shrink-0" />
                    {item.label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No supporting observations have been affirmatively documented yet.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <XCircle className="h-4 w-4 text-red-600" />
              Alternative-Cause Observations
            </CardTitle>
          </CardHeader>
          <CardContent>
            {result.opposingObservations.length > 0 ? (
              <ul className="space-y-2">
                {result.opposingObservations.map((item) => (
                  <li key={item.id} className="text-sm flex items-start gap-2">
                    <XCircle className="h-3 w-3 mt-1 text-red-600 flex-shrink-0" />
                    {item.label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No affirmative alternative-cause observations have been documented.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Evidence Gaps */}
      {result.evidenceGaps.length > 0 && (
        <Card className="border-yellow-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <HelpCircle className="h-4 w-4 text-yellow-600" />
              Evidence Gaps
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-2">
              Unknown items are not treated as evidence against causation. They are simply not yet documented.
            </p>
            <ScrollArea className="max-h-32">
              <ul className="space-y-1">
                {result.evidenceGaps.map((gap, index) => (
                  <li key={index} className="text-sm text-yellow-700 dark:text-yellow-400 flex items-start gap-2">
                    <AlertTriangle className="h-3 w-3 mt-1 flex-shrink-0" />
                    {gap}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
