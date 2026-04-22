import { useState } from "react";
import { AlertTriangle, Shield, Gavel, Wrench, X, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ReferralAlert, ReferralAlertType } from "@/hooks/useReferralAlerts";
import { GuidedReferralRecommendations } from "./GuidedReferralRecommendations";

interface Props {
  alerts: ReferralAlert[];
  claimState: string | null;
  onDismiss: (alertId: string) => void;
  onActioned: (alertId: string) => void;
}

const ALERT_CONFIG: Record<ReferralAlertType, {
  icon: React.ElementType;
  title: string;
  bgClass: string;
  borderClass: string;
  textClass: string;
  badgeLabel: string;
}> = {
  needs_contractor: {
    icon: Wrench,
    title: "A Contractor May Be Needed",
    bgClass: "bg-amber-50 dark:bg-amber-950/20",
    borderClass: "border-amber-300 dark:border-amber-700",
    textClass: "text-amber-800 dark:text-amber-300",
    badgeLabel: "Contractor",
  },
  needs_public_adjuster: {
    icon: Shield,
    title: "Consider Hiring a Public Adjuster",
    bgClass: "bg-blue-50 dark:bg-blue-950/20",
    borderClass: "border-blue-300 dark:border-blue-700",
    textClass: "text-blue-800 dark:text-blue-300",
    badgeLabel: "Public Adjuster",
  },
  needs_attorney: {
    icon: Gavel,
    title: "Legal Representation May Be Necessary",
    bgClass: "bg-red-50 dark:bg-red-950/20",
    borderClass: "border-red-300 dark:border-red-700",
    textClass: "text-red-800 dark:text-red-300",
    badgeLabel: "Attorney",
  },
};

export function GuidedReferralAlert({ alerts, claimState, onDismiss, onActioned }: Props) {
  const [expandedAlert, setExpandedAlert] = useState<string | null>(null);

  if (!alerts.length) return null;

  return (
    <div className="space-y-3">
      {alerts.map((alert) => {
        const config = ALERT_CONFIG[alert.alert_type];
        const Icon = config.icon;
        const isExpanded = expandedAlert === alert.id;

        return (
          <div key={alert.id}>
            <div className={`border ${config.borderClass} ${config.bgClass} rounded-lg p-4`}>
              <div className="flex items-start gap-3">
                <Icon className={`h-5 w-5 ${config.textClass} shrink-0 mt-0.5`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className={`font-semibold text-sm ${config.textClass}`}>{config.title}</p>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {config.badgeLabel}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {alert.message || alert.trigger_reason}
                  </p>
                  <div className="flex items-center gap-2 mt-3">
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7 text-xs"
                      onClick={() => {
                        setExpandedAlert(isExpanded ? null : alert.id);
                        onActioned(alert.id);
                      }}
                    >
                      View Recommendations
                      <ChevronRight className="h-3 w-3 ml-1" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground"
                      onClick={() => onDismiss(alert.id)}
                    >
                      <X className="h-3 w-3 mr-1" />
                      Dismiss
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            {isExpanded && (
              <div className="mt-2">
                <GuidedReferralRecommendations
                  claimId={alert.claim_id}
                  alertType={alert.alert_type}
                  claimState={claimState}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
