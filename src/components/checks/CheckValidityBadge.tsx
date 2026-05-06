import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertTriangle, Clock, CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import {
  assessCheckValidity,
  CHECK_VALIDITY_BADGE_CLASS,
  type CheckValidityRisk,
} from "@/lib/checkValidity";

const ICONS: Record<CheckValidityRisk, typeof Clock> = {
  unknown: HelpCircle,
  ok: CheckCircle2,
  warning: Clock,
  stale: AlertTriangle,
  expired: XCircle,
};

interface CheckValidityBadgeProps {
  issueDate: string | null | undefined;
  /** Hide when risk is "ok" or "unknown" — useful in dense lists. */
  hideWhenSafe?: boolean;
  className?: string;
  size?: "xs" | "sm";
}

export function CheckValidityBadge({
  issueDate,
  hideWhenSafe = false,
  className = "",
  size = "xs",
}: CheckValidityBadgeProps) {
  const assessment = assessCheckValidity(issueDate);

  if (hideWhenSafe && (assessment.risk === "ok" || assessment.risk === "unknown")) {
    return null;
  }

  const Icon = ICONS[assessment.risk];
  const badgeClass = CHECK_VALIDITY_BADGE_CLASS[assessment.risk];
  const sizeClass =
    size === "xs"
      ? "text-[10px] px-1.5 py-0 h-5 gap-1"
      : "text-xs px-2 py-0.5 gap-1";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className={`${sizeClass} ${badgeClass} ${className} font-medium`}
          >
            <Icon className="h-3 w-3 shrink-0" />
            {assessment.label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <p className="text-xs">{assessment.detail}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
