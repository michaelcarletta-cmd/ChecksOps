import { Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { describeDuplicate, type DuplicateCandidate } from "@/lib/duplicateChecks";

/** Queue badge: this check's number and amount match another check in the tenant. */
export function DuplicateCheckBadge({ duplicates }: { duplicates?: DuplicateCandidate[] }) {
  if (!duplicates?.length) return null;
  return (
    <Badge
      variant="destructive"
      className="text-[10px] gap-1 px-1.5 py-0 font-sans"
      title={`Possible duplicate of:\n${duplicates.map(describeDuplicate).join("\n")}`}
      data-testid="duplicate-check-badge"
    >
      <Copy className="h-3 w-3" />
      Duplicate?
    </Badge>
  );
}

/** Detail banner: lists the matching checks so the reviewer can compare before depositing. */
export function DuplicateCheckBanner({ duplicates }: { duplicates?: DuplicateCandidate[] }) {
  if (!duplicates?.length) return null;
  return (
    <div
      role="alert"
      className="mt-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm"
      data-testid="duplicate-check-banner"
    >
      <div className="flex items-center gap-2 font-medium text-destructive">
        <Copy className="h-4 w-4" />
        Possible duplicate check
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        The same check number and amount {duplicates.length === 1 ? "is" : "are"} already in your account. Compare
        the images before depositing; delete this one if it was uploaded twice.
      </p>
      <ul className="mt-1.5 space-y-0.5 text-xs">
        {duplicates.map((d) => (
          <li key={d.id} className="font-mono">{describeDuplicate(d)}</li>
        ))}
      </ul>
    </div>
  );
}
