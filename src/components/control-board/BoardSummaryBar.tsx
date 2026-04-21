import { Card } from "@/components/ui/card";
import { ClaimBoardEntry } from "@/services/claimOperationsService";
import { AlertTriangle, Clock, Zap, Timer } from "lucide-react";

interface BoardSummaryBarProps {
  claims: ClaimBoardEntry[];
}

export function BoardSummaryBar({ claims }: BoardSummaryBarProps) {
  const needsAction = claims.filter(
    (c) =>
      c.ops?.follow_up_status === "escalation" ||
      c.ops?.follow_up_status === "overdue" ||
      c.immediate_microtasks > 0 ||
      c.blocking_microtasks > 0
  ).length;

  const stale14 = claims.filter(
    (c) => (c.ops?.days_since_last_activity || 0) >= 14
  ).length;

  const overdueTaskCount = claims.reduce(
    (sum, c) => sum + (c.overdue_tasks || 0),
    0
  );

  const carrierWaiting20 = claims.filter((c) => {
    const status = c.status || "";
    const isCarrierWait = [
      "Carrier Review",
      "Funding from Insurance",
      "Recoverable Depreciation Requested",
      "Waiting on ACV Funds",
      "Waiting on Insurance Funds (ACV)",
    ].includes(status);
    return isCarrierWait && (c.ops?.days_since_last_activity || 0) >= 20;
  }).length;

  const stats = [
    {
      label: "Need action",
      value: needsAction,
      icon: Zap,
      color: "text-red-500",
      show: needsAction > 0,
    },
    {
      label: "14+ days inactive",
      value: stale14,
      icon: Clock,
      color: "text-amber-500",
      show: stale14 > 0,
    },
    {
      label: "Overdue tasks",
      value: overdueTaskCount,
      icon: AlertTriangle,
      color: "text-destructive",
      show: overdueTaskCount > 0,
    },
    {
      label: "Carrier 20+ days",
      value: carrierWaiting20,
      icon: Timer,
      color: "text-amber-600 dark:text-amber-400",
      show: carrierWaiting20 > 0,
    },
  ].filter((s) => s.show);

  if (stats.length === 0) {
    return (
      <Card className="p-3 border-green-500/30 bg-green-50/50 dark:bg-green-950/20">
        <p className="text-sm text-green-700 dark:text-green-400 font-medium">
          ✓ All {claims.length} claims are on track — no urgent items today
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-3 border-border">
      <div className="flex items-center gap-6 flex-wrap">
        <span className="text-sm font-semibold text-foreground">
          Today's Pulse
        </span>
        {stats.map((stat) => (
          <div key={stat.label} className="flex items-center gap-1.5">
            <stat.icon className={`h-4 w-4 ${stat.color}`} />
            <span className={`text-lg font-bold ${stat.color}`}>
              {stat.value}
            </span>
            <span className="text-xs text-muted-foreground">{stat.label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
