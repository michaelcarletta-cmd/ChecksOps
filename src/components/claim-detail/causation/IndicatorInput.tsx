import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { IndicatorState, IndicatorValue } from "./types";
import { CheckCircle2, XCircle, HelpCircle } from "lucide-react";

interface IndicatorInputProps {
  id: string;
  label: string;
  isPositive: boolean;
  description?: string;
  value: IndicatorValue | undefined;
  onChange: (id: string, value: IndicatorValue) => void;
}

export function IndicatorInput({
  id,
  label,
  isPositive,
  description,
  value,
  onChange,
}: IndicatorInputProps) {
  const state = value?.state || "unknown";

  const handleStateChange = (newState: IndicatorState) => {
    onChange(id, { state: newState, notes: value?.notes });
  };

  const getButtonClasses = (buttonState: IndicatorState) => {
    const isActive = state === buttonState;
    return cn(
      "h-7 px-2 text-xs gap-1",
      isActive ? "ring-2 ring-primary/30" : "opacity-85"
    );
  };

  return (
    <div className="flex items-start gap-3 p-2 rounded-lg border border-muted/50 bg-background">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{label}</span>
          <span className={cn(
            "text-xs px-1.5 py-0.5 rounded",
            isPositive
              ? "bg-green-500/10 text-green-700 dark:text-green-400"
              : "bg-red-500/10 text-red-700 dark:text-red-400"
          )}>
            {isPositive ? "Supports causation" : "Alternative cause"}
          </span>
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>

      <div className="flex gap-1 flex-shrink-0">
        <Button
          type="button"
          size="sm"
          variant={state === "present" ? "default" : "outline"}
          onClick={() => handleStateChange("present")}
          className={getButtonClasses("present")}
          title="Present: observed or documented"
        >
          <CheckCircle2 className="h-3 w-3" />
          Yes
        </Button>
        <Button
          type="button"
          size="sm"
          variant={state === "absent" ? "default" : "outline"}
          onClick={() => handleStateChange("absent")}
          className={getButtonClasses("absent")}
          title="Absent: explicitly observed not to be present"
        >
          <XCircle className="h-3 w-3" />
          No
        </Button>
        <Button
          type="button"
          size="sm"
          variant={state === "unknown" ? "default" : "outline"}
          onClick={() => handleStateChange("unknown")}
          className={getButtonClasses("unknown")}
          title="Unknown: not observed, not documented, or not evaluated"
        >
          <HelpCircle className="h-3 w-3" />
          ?
        </Button>
      </div>
    </div>
  );
}
