import type { CheckAltAccessState } from "@/lib/checkAltOperatorAccess";

/**
 * The one line shown in place of a hidden Check Alt control: neutral while
 * the user's memberships load, a retry note if they could not be read, and
 * the role message only once they loaded and the role does not allow it.
 */
export function CheckAltAccessNote({
  state,
  action,
  onRetry,
  className = "text-[11px] text-muted-foreground",
}: {
  state: CheckAltAccessState;
  /** Completes "…of this organization can <action>." */
  action: string;
  onRetry?: () => void;
  className?: string;
}) {
  if (state === "allowed") return null;
  if (state === "loading") return <p className={className}>Checking your access…</p>;
  if (state === "error") {
    return (
      <p className={className}>
        Couldn't check your access.{" "}
        {onRetry && (
          <button type="button" className="underline" onClick={() => onRetry()}>
            Try again
          </button>
        )}
      </p>
    );
  }
  return (
    <p className={className}>
      Only members of this organization can {action}.
    </p>
  );
}
