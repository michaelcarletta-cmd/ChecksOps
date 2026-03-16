import { AlertTriangle, Lock, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PositionLockStatus } from "@/types/darwinDeclaredPosition";

interface PositionGateBannerProps {
  lockStatus: PositionLockStatus;
  loading?: boolean;
  onOpenEditor?: () => void;
  onProceedProvisional?: () => void;
  allowProvisional?: boolean;
}

export function PositionGateBanner({
  lockStatus,
  loading,
  onOpenEditor,
  onProceedProvisional,
  allowProvisional = true,
}: PositionGateBannerProps) {
  if (loading) return null;
  if (lockStatus === "strategic_lock" || lockStatus === "litigation_grade") return null;

  return (
    <Alert className="border-yellow-500/50 bg-yellow-50 dark:bg-yellow-950/20">
      <AlertTriangle className="h-4 w-4 text-yellow-600" />
      <AlertDescription className="text-sm">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="space-y-1">
            <div className="font-semibold flex items-center gap-1.5">
              <ShieldAlert className="h-4 w-4" />
              Declared Position not locked
            </div>
            <p className="text-xs text-muted-foreground">
              Carrier-facing AI is blocked until the strategic position is completed and locked.
              This prevents Darwin from drifting between inconsistent causation, coverage, and remedy theories.
            </p>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="outline" className="text-xs border-yellow-500 text-yellow-700">Draft only</Badge>
              <Badge variant="outline" className="text-xs border-destructive text-destructive">No strategic lock</Badge>
              <Badge variant="outline" className="text-xs border-orange-500 text-orange-700">Drift risk elevated</Badge>
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            {onOpenEditor && (
              <Button size="sm" variant="outline" onClick={onOpenEditor} className="border-yellow-500 text-yellow-700 hover:bg-yellow-100">
                <Lock className="h-3 w-3 mr-1" />
                Complete Position
              </Button>
            )}
            {allowProvisional && onProceedProvisional && (
              <Button size="sm" variant="ghost" onClick={onProceedProvisional} className="text-muted-foreground text-xs">
                Proceed Provisional
              </Button>
            )}
          </div>
        </div>
      </AlertDescription>
    </Alert>
  );
}

// Keep named export for backwards compat
export { PositionGateBanner as default };
