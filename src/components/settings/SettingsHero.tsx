import React from "react";
import { Sparkles } from "lucide-react";

interface SettingsHeroProps {
  title: string;
  description: string;
  badge: string;
  icon?: React.ReactNode;
}

export function SettingsHero({ title, description, badge, icon }: SettingsHeroProps) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/15 via-primary/5 to-background p-4 md:p-6 mb-0">
      <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
      <div className="relative flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {icon || <Sparkles className="h-4 w-4 text-primary" />}
          <span className="text-xs font-bold uppercase tracking-widest text-primary">{badge}</span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          {description}
        </p>
      </div>
    </div>
  );
}
