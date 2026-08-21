import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Info } from "lucide-react";

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  suffix?: string;
  step?: number;
  max?: number;
  hint?: string;
}

/** Validated numeric input — never emits negative or non-finite values. */
export function NumberField({ label, value, onChange, prefix, suffix, step = 1, max, hint }: NumberFieldProps) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="flex items-center gap-1 text-xs text-muted-foreground">
        <span className="truncate-flex">{label}</span>
        {hint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3 w-3 shrink-0 opacity-60" aria-label={`About ${label}`} />
            </TooltipTrigger>
            <TooltipContent className="max-w-[240px] text-xs">{hint}</TooltipContent>
          </Tooltip>
        )}
      </Label>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {prefix}
          </span>
        )}
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          max={max}
          step={step}
          className={`h-9 ${prefix ? "pl-6" : ""} ${suffix ? "pr-8" : ""}`}
          value={Number.isFinite(value) ? String(value) : "0"}
          onChange={(e) => {
            const raw = Number(e.target.value);
            if (!Number.isFinite(raw)) return onChange(0);
            let next = Math.max(0, raw);
            if (typeof max === "number") next = Math.min(max, next);
            onChange(next);
          }}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "positive" | "negative";
}) {
  const toneClass =
    tone === "positive" ? "text-emerald-500" : tone === "negative" ? "text-destructive" : "text-foreground";
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card/50 p-3">
      <p className="truncate-flex text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-fluid-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {sub && <p className="truncate-flex text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
