import React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface SectionCardProps {
  title: string;
  icon: React.ReactNode;
  accent: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function SectionCard({
  title,
  icon,
  accent,
  description,
  children,
  className,
}: SectionCardProps) {
  return (
    <Card className={`overflow-hidden border-border/60 shadow-sm ${className || ""}`}>
      <div className={`h-1.5 ${accent}`} />
      <CardHeader className="flex flex-col gap-1 p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          {icon}
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-2">{children}</CardContent>
    </Card>
  );
}
