import { Card, CardContent } from "@/components/ui/card";
import { Landmark, Eye, EyeOff, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";

export type LossDraftFilter = "active" | "monitored" | "non_monitored";

interface Props {
  activeCount: number;
  monitoredCount: number;
  nonMonitoredCount: number;
  totalUnreleased: number;
  activeFilter: LossDraftFilter;
  onFilterChange: (f: LossDraftFilter) => void;
}

export function LossDraftDashboardCards({
  activeCount,
  monitoredCount,
  nonMonitoredCount,
  totalUnreleased,
  activeFilter,
  onFilterChange,
}: Props) {
  const cards: Array<{
    key: LossDraftFilter | "total";
    label: string;
    value: string | number;
    icon: any;
    color: string;
    clickable: boolean;
    isText?: boolean;
  }> = [
    { key: "active",         label: "Active Files",         value: activeCount,        icon: Landmark,   color: "text-amber-400",    clickable: true },
    { key: "monitored",      label: "Monitored Claims",     value: monitoredCount,     icon: Eye,        color: "text-blue-400",     clickable: true },
    { key: "non_monitored",  label: "Non-Monitored Claims", value: nonMonitoredCount,  icon: EyeOff,     color: "text-muted-foreground", clickable: true },
    {
      key: "total",
      label: "Total Unreleased",
      value: `$${totalUnreleased.toLocaleString("en-US", { minimumFractionDigits: 0 })}`,
      icon: DollarSign,
      color: "text-amber-400",
      clickable: false,
      isText: true,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
      {cards.map(c => {
        const isActive = c.clickable && activeFilter === c.key;
        return (
          <Card
            key={c.label}
            onClick={c.clickable ? () => onFilterChange(c.key as LossDraftFilter) : undefined}
            className={cn(
              "transition-colors",
              c.clickable && "cursor-pointer hover:bg-accent/40",
              isActive && "border-primary bg-accent/30",
            )}
          >
            <CardContent className="p-3 flex items-center gap-2">
              <c.icon className={`h-4 w-4 ${c.color} shrink-0`} />
              <div className="min-w-0 flex-1">
                <p className={`font-bold ${c.isText ? "text-sm" : "text-lg"} leading-tight`}>
                  {c.value}
                </p>
                <p className="text-[10px] text-muted-foreground leading-tight break-words">{c.label}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
