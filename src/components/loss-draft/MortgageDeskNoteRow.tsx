import { useState } from "react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  MORTGAGE_DESK_NOTE_LABEL,
  mortgageDeskNoteIsLong,
  mortgageDeskNoteText,
} from "@/lib/mortgageDeskNoteDisplay";

/**
 * One Mortgage Desk note, compact: an amber left border and dot, the "Mortgage Desk" label,
 * the time and a "New" marker on one small line, then the text clamped to two lines with a
 * "Show more" toggle (the full text is always reachable).
 */
export function MortgageDeskNoteRow({
  body,
  createdAt,
  isNew = false,
  className,
}: {
  body: string;
  createdAt?: string | null;
  isNew?: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = mortgageDeskNoteText(body);
  const long = mortgageDeskNoteIsLong(text);
  const clamped = long && !expanded;

  return (
    <div
      className={cn("border-l-2 border-amber-400 py-0.5 pl-2 text-[11px] leading-snug", className)}
      data-testid="mortgage-desk-note"
      data-new={isNew ? "true" : undefined}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
        <span
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", isNew ? "bg-amber-400" : "bg-amber-400/40")}
          aria-hidden="true"
        />
        <span className="font-medium text-amber-500 dark:text-amber-400">{MORTGAGE_DESK_NOTE_LABEL}</span>
        {createdAt && (
          <time dateTime={createdAt} className="truncate">
            {format(new Date(createdAt), "MMM d, h:mm a")}
          </time>
        )}
        {isNew && (
          <span className="shrink-0 rounded bg-amber-500/20 px-1 text-[9px] font-semibold uppercase text-amber-500 dark:text-amber-400">
            New
          </span>
        )}
      </div>
      <p
        className={cn("whitespace-pre-wrap break-words text-foreground", clamped && "line-clamp-2")}
        title={clamped ? text : undefined}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          className="text-[10px] font-medium text-primary hover:underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
