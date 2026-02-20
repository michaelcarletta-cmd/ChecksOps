import type { DarwinMode } from "@/components/darwin/types";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export function DarwinModeToggle({
  value,
  onChange,
  className,
}: {
  value: DarwinMode;
  onChange: (next: DarwinMode) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-2 text-sm font-medium">Mode</div>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v) => {
          if (!v) return;
          onChange(v as DarwinMode);
        }}
        variant="outline"
        size="sm"
        className="flex-wrap justify-start"
      >
        <ToggleGroupItem value="rebuttal" aria-label="Rebuttal mode">
          Rebuttal
        </ToggleGroupItem>
        <ToggleGroupItem value="steelman" aria-label="Steelman mode">
          Steelman
        </ToggleGroupItem>
        <ToggleGroupItem value="evidence" aria-label="Evidence mode">
          Evidence
        </ToggleGroupItem>
        <ToggleGroupItem value="scripts" aria-label="Scripts mode">
          Scripts
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
