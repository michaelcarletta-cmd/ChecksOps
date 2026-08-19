import React from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";

interface SectionCardProps {
  title: string;
  icon: React.ReactNode;
  accent: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  collapsible?: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  };
}

export function SectionCard({
  title,
  icon,
  accent,
  description,
  children,
  className,
  collapsible,
}: SectionCardProps) {
  const HeaderContent = (
    <div className="flex items-center justify-between w-full">
      <div className="flex flex-col gap-1">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          {icon}
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </div>
      {collapsible && (
        <ChevronDown 
          className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${
            collapsible.open ? 'rotate-180' : ''
          }`} 
        />
      )}
    </div>
  );

  return (
    <Card className={`overflow-hidden border-border/60 shadow-sm ${className || ""}`}>
      <div className={`h-1.5 ${accent}`} />
      <CardHeader className={`p-4 pb-2 ${collapsible ? 'cursor-pointer hover:bg-muted/50 transition-colors' : ''}`}>
        {collapsible ? (
          <CollapsibleTrigger asChild>
            {HeaderContent}
          </CollapsibleTrigger>
        ) : (
          HeaderContent
        )}
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-2">{children}</CardContent>
    </Card>
  );
}
