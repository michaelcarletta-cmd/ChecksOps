import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, AlertTriangle, ShieldAlert, X, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useUrgentAlerts, UrgentAlert } from "@/hooks/useUrgentAlerts";

const REASON_CONFIG: Record<UrgentAlert["reason"], { icon: typeof AlertTriangle; color: string; bg: string }> = {
  escalation: { icon: AlertTriangle, color: "text-red-500", bg: "bg-red-500/10" },
  high_pressure: { icon: ShieldAlert, color: "text-amber-500", bg: "bg-amber-500/10" },
};

export function UrgentAlertsBell() {
  const { alerts, totalCount, dismiss, dismissAll } = useUrgentAlerts();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {totalCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white px-1 animate-pulse">
              {totalCount > 99 ? "99+" : totalCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <span className="font-semibold text-sm">Urgent Alerts</span>
          {totalCount > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={dismissAll}>
              <CheckCheck className="h-3 w-3" /> Clear all
            </Button>
          )}
        </div>
        <ScrollArea className="max-h-80">
          {alerts.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No urgent alerts right now
            </div>
          ) : (
            <div className="divide-y">
              {alerts.slice(0, 20).map((alert) => {
                const config = REASON_CONFIG[alert.reason];
                const Icon = config.icon;
                return (
                  <div
                    key={alert.id}
                    className={`flex items-start gap-3 px-4 py-3 hover:bg-muted/50 cursor-pointer transition-colors ${config.bg}`}
                    onClick={() => {
                      navigate(`/claims/${alert.claim_id}`);
                      setOpen(false);
                    }}
                  >
                    <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${config.color}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{alert.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {alert.claim_number ? `#${alert.claim_number}` : ""}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        dismiss(alert.id);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
        {totalCount > 0 && (
          <div className="border-t px-4 py-2">
            <Button
              variant="link"
              size="sm"
              className="w-full text-xs"
              onClick={() => {
                navigate("/tasks");
                setOpen(false);
              }}
            >
              View Tasks →
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
