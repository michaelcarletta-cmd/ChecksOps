import type * as React from "react";
import { toast as sonner, type ExternalToast } from "sonner";

/**
 * One toast system: every toast is shown by Sonner (`<Sonner />` in App.tsx).
 *
 * This keeps the `toast({ title, description, variant })` / `useToast()` API the app was written
 * against, so callers need no change. It replaces the second, Radix-based toaster, which showed
 * one toast at a time (a new toast hid the one before it); Sonner stacks them, so none is lost.
 */
export interface ToastOptions {
  title?: React.ReactNode;
  description?: React.ReactNode;
  variant?: "default" | "destructive" | null;
  /** Milliseconds on screen; Infinity keeps it until dismissed. */
  duration?: number;
  action?: ExternalToast["action"];
  className?: string;
}

/** The Radix toaster's default time on screen, kept so messages stay readable as long as before. */
export const TOAST_DURATION_MS = 5000;

let count = 0;
function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return `app-toast-${count}`;
}

function show(id: string, { title, description, variant, duration, action, className }: ToastOptions) {
  const options: ExternalToast = {
    id,
    description,
    duration: duration ?? TOAST_DURATION_MS,
    action,
    className,
  };
  // A toast with only a description still shows its text as the message.
  const message = title ?? description ?? "";
  if (title === undefined || title === null) options.description = undefined;
  if (variant === "destructive") sonner.error(message, options);
  else sonner(message, options);
}

function toast(props: ToastOptions) {
  const id = genId();
  let current = props;
  show(id, current);
  return {
    id,
    dismiss: () => sonner.dismiss(id),
    update: (next: ToastOptions) => {
      current = { ...current, ...next };
      show(id, current);
    },
  };
}

function useToast() {
  return {
    toast,
    dismiss: (toastId?: string) => sonner.dismiss(toastId),
    /** Kept for API compatibility; Sonner owns the list it renders. */
    toasts: [] as never[],
  };
}

export { useToast, toast };
