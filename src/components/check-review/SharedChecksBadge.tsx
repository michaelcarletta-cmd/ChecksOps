import { Badge } from "@/components/ui/badge";
import { Share2 } from "lucide-react";

interface SharedChecksBadgeProps {
  sourceTenantName?: string;
}

export function SharedChecksBadge({ sourceTenantName }: SharedChecksBadgeProps) {
  return (
    <Badge variant="outline" className="text-[10px] px-1.5 gap-1 border-blue-500/30 text-blue-400 bg-blue-500/10">
      <Share2 className="h-2.5 w-2.5" />
      {sourceTenantName ? `From ${sourceTenantName}` : "Shared"}
    </Badge>
  );
}
