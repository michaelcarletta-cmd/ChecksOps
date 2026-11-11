import React from "react";

interface SettingsHeroProps {
  title: string;
  description: string;
  badge: string;
  icon?: React.ReactNode;
}

export function SettingsHero({ title, description, badge, icon }: SettingsHeroProps) {
  return (
    <div className="flex flex-col gap-1 border-b border-border pb-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{badge}</span>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground max-w-2xl">{description}</p>
    </div>
  );
}
