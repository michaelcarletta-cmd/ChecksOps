import { Badge } from "@/components/ui/badge";
import { ArrowUpRight } from "lucide-react";

interface PartnerPaidOutBadgeProps {
  sourceTenantName?: string;
  paidAt?: string | null;
}

/**
 * A check shared with this organization that the sharing organization paid out of by a send to
 * someone else (owner 2026-11-13: it stays in Deposited "with a note saying Freedom paid it out").
 */
export function PartnerPaidOutBadge({ sourceTenantName, paidAt }: PartnerPaidOutBadgeProps) {
  const who = sourceTenantName || "Partner";
  const when = paidAt ? new Date(paidAt) : null;
  const title = when && Number.isFinite(when.getTime())
    ? `${who} paid out of this check on ${when.toLocaleDateString()}`
    : `${who} paid out of this check`;
  return (
    <Badge variant="outline" className="text-[10px] px-1.5 gap-1 border-amber-500/30 text-amber-500 bg-amber-500/10" title={title}>
      <ArrowUpRight className="h-2.5 w-2.5" />
      {`${who} paid it out`}
    </Badge>
  );
}
