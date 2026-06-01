import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { FileSignature, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface DTPStatusIndicatorProps {
  checkIntakeItemId: string;
  className?: string;
}

type DerivedStatus = "not_requested" | "pending" | "signed" | "expired" | "syncing";

const STATUS_STYLES: Record<DerivedStatus, { label: (extra?: string) => string; className: string; pulse?: boolean }> = {
  not_requested: {
    label: () => "DTP: Not Requested",
    className: "bg-muted text-muted-foreground border-border",
  },
  syncing: {
    label: () => "DTP: Syncing…",
    className: "bg-muted text-muted-foreground border-border animate-pulse",
  },
  pending: {
    label: () => "DTP: Pending",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    pulse: true,
  },
  signed: {
    label: (extra) => (extra ? `DTP: Signed (${extra})` : "DTP: Signed"),
    className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  },
  expired: {
    label: () => "DTP: Expired",
    className: "bg-destructive/15 text-destructive border-destructive/30",
  },
};

/**
 * Live DTP status pill driven by signature_requests + signature_signers
 * scoped to a single check_intake_item. Polls every 30s while pending.
 */
export function DTPStatusIndicator({ checkIntakeItemId, className }: DTPStatusIndicatorProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["dtp-status", checkIntakeItemId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signature_requests")
        .select("id, status, created_at, signature_signers(signer_name, signer_email, status, signed_at)")
        .eq("check_intake_item_id", checkIntakeItemId)
        .ilike("document_name", "Direction to Pay%")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    refetchInterval: (q) => {
      const row: any = q.state.data;
      const signer = row?.signature_signers?.[0];
      return signer?.status === "pending" ? 30_000 : false;
    },
  });

  if (isLoading) {
    const style = STATUS_STYLES.syncing;
    return (
      <Badge variant="outline" className={cn("gap-1.5", style.className, className)}>
        <Loader2 className="h-3 w-3 animate-spin" />
        {style.label()}
      </Badge>
    );
  }

  const signer = data?.signature_signers?.[0] as
    | { signer_name?: string; signer_email?: string; status?: string; signed_at?: string }
    | undefined;

  let derived: DerivedStatus = "not_requested";
  if (data) {
    if (signer?.status === "signed") derived = "signed";
    else if (data.status === "failed") derived = "expired";
    else derived = "pending";
  }

  const style = STATUS_STYLES[derived];
  const badge = (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-medium",
        style.className,
        style.pulse && "animate-pulse",
        className,
      )}
    >
      <FileSignature className="h-3 w-3" />
      <span className="truncate max-w-[180px]">{style.label(signer?.signer_name)}</span>
    </Badge>
  );

  if (derived === "not_requested") return badge;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{badge}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs space-y-1">
          {data?.created_at && (
            <div>
              <span className="text-muted-foreground">Sent:</span>{" "}
              {new Date(data.created_at).toLocaleString()}
            </div>
          )}
          {signer?.signer_email && (
            <div>
              <span className="text-muted-foreground">Recipient:</span> {signer.signer_email}
            </div>
          )}
          {signer?.signed_at && (
            <div>
              <span className="text-muted-foreground">Signed:</span>{" "}
              {new Date(signer.signed_at).toLocaleString()}
              {signer.signer_name ? ` by ${signer.signer_name}` : ""}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
