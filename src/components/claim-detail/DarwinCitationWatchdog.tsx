import { AlertTriangle, Shield } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface CitationWatchdogData {
  wrong_state_citations_found: number;
  violations: string[];
  warning: string;
}

interface JurisdictionData {
  state_code: string | null;
  state_name?: string;
  detection_source: string;
  confidence?: string;
}

interface DarwinCitationWatchdogProps {
  watchdog?: CitationWatchdogData | null;
  jurisdiction?: JurisdictionData | null;
}

export function DarwinCitationWatchdog({ watchdog, jurisdiction }: DarwinCitationWatchdogProps) {
  if (!watchdog && !jurisdiction) return null;

  const hasViolations = watchdog && watchdog.wrong_state_citations_found > 0;
  const lowConfidence = jurisdiction?.confidence === 'low' || jurisdiction?.detection_source === 'fallback_default';

  if (!hasViolations && !lowConfidence) return null;

  return (
    <div className="space-y-2">
      {hasViolations && (
        <Alert variant="destructive" className="border-red-500 bg-red-50 dark:bg-red-950/30">
          <AlertTriangle className="h-5 w-5" />
          <AlertTitle className="font-bold">⚠️ Wrong-State Citations Detected</AlertTitle>
          <AlertDescription className="space-y-2">
            <p className="font-medium">
              Darwin found {watchdog!.wrong_state_citations_found} citation(s) from the <strong>wrong state</strong> in this output.
              Review carefully before sending to the carrier.
            </p>
            <ul className="list-disc pl-5 text-sm space-y-1">
              {watchdog!.violations.slice(0, 5).map((v, i) => (
                <li key={i}>{v}</li>
              ))}
              {watchdog!.violations.length > 5 && (
                <li className="text-muted-foreground">...and {watchdog!.violations.length - 5} more</li>
              )}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {lowConfidence && !hasViolations && (
        <Alert className="border-amber-500 bg-amber-50 dark:bg-amber-950/30">
          <Shield className="h-5 w-5 text-amber-600" />
          <AlertTitle className="font-semibold text-amber-800 dark:text-amber-300">
            Jurisdiction Not Confirmed
          </AlertTitle>
          <AlertDescription className="text-amber-700 dark:text-amber-400">
            Darwin could not confidently detect the state from the claim address
            {jurisdiction?.state_code && ` and defaulted to ${jurisdiction.state_code}`}.
            Verify that all cited state codes and regulations match the actual claim jurisdiction.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
