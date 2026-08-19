import React from "react";
import { cn } from "@/lib/utils";

interface SettingsPageShellProps {
  children?: React.ReactNode;
  className?: string;
}

/**
 * Shared layout shell for every Settings tab.
 * Owns content width, horizontal padding, vertical rhythm and bottom clearance
 * so individual settings modules never need their own wrappers.
 */
export function SettingsPageShell({ children, className }: SettingsPageShellProps) {
  return (
    <div className={cn("mx-auto w-full max-w-7xl space-y-6 pt-6 pb-12", className)}>
      {children}
    </div>
  );
}
