import * as React from "react";
import { Loader2, Check } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ActionButtonProps extends Omit<ButtonProps, "onClick" | "asChild"> {
  /** Async or sync handler. While it is in flight the button is disabled and shows a spinner. */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void | Promise<unknown>;
  /** External pending flag (e.g. `mutation.isPending`). OR-ed with the internal one. */
  loading?: boolean;
  /** Text shown while pending. Defaults to the children. */
  loadingText?: React.ReactNode;
  /** Show a brief success check after a resolved handler. Default: true. */
  showSuccess?: boolean;
}

/**
 * Button with built-in immediate feedback:
 * - pressed state (scale) on active
 * - spinner + disabled while the handler is in flight
 * - guards against double submission
 * - brief success tick when the handler resolves
 * All timings sit in the 150-250ms band and inherit the global reduced-motion override.
 */
export const ActionButton = React.forwardRef<HTMLButtonElement, ActionButtonProps>(
  (
    { onClick, loading, loadingText, showSuccess = true, disabled, className, children, ...props },
    ref,
  ) => {
    const [busy, setBusy] = React.useState(false);
    const [done, setDone] = React.useState(false);
    const mounted = React.useRef(true);
    const inFlight = React.useRef(false);

    React.useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
      };
    }, []);

    const pending = busy || !!loading;

    const handleClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
      if (inFlight.current || pending || disabled) {
        event.preventDefault();
        return;
      }
      const result = onClick?.(event);
      if (!result || typeof (result as Promise<unknown>).then !== "function") return;

      inFlight.current = true;
      setBusy(true);
      try {
        await result;
        if (mounted.current && showSuccess) {
          setDone(true);
          setTimeout(() => mounted.current && setDone(false), 1200);
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    };

    return (
      <Button
        ref={ref}
        onClick={handleClick}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        className={cn(
          "min-h-[40px] transition-transform duration-150 active:scale-[0.97]",
          className,
        )}
        {...props}
      >
        {pending ? (
          <>
            <Loader2 className="animate-spin" aria-hidden="true" />
            <span className="truncate-flex">{loadingText ?? children}</span>
          </>
        ) : done ? (
          <>
            <Check aria-hidden="true" />
            <span className="truncate-flex">{children}</span>
          </>
        ) : (
          children
        )}
      </Button>
    );
  },
);
ActionButton.displayName = "ActionButton";
