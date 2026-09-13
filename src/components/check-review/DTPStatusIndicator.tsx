import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fillPartnerSigners } from "@/lib/partnerSafeReads";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { FileSignature, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface DTPStatusIndicatorProps {
  checkIntakeItemId: string;
  className?: string;
}

type DerivedStatus = "not_requested" | "pending" | "signed" | "expired" | "syncing";

const STATUS_STYLES: Record<DerivedStatus, { label: string; className: string; pulse?: boolean }> = {
  not_requested: {
    label: "Not Requested",
    className: "bg-muted text-muted-foreground border-border",
  },
  syncing: {
    label: "Syncing…",
    className: "bg-muted text-muted-foreground border-border animate-pulse",
  },
  pending: {
    label: "Pending",
    className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    pulse: true,
  },
  signed: {
    label: "Signed",
    className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  },
  expired: {
    label: "Expired",
    className: "bg-destructive/15 text-destructive border-destructive/30",
  },
};

interface DTPRecord {
  id: string;
  status: string | null;
  created_at: string | null;
  signature_signers: Array<{
    signer_name?: string;
    signer_email?: string;
    status?: string;
    signed_at?: string;
  }> | null;
}

function deriveStatus(row: DTPRecord): DerivedStatus {
  const signer = row.signature_signers?.[0];
  if (signer?.status === "signed") return "signed";
  if (row.status === "failed" || row.status === "expired") return "expired";
  return "pending";
}

/**
 * Live DTP status pills driven by signature_requests + signature_signers
 * scoped to a single check_intake_item. Renders one pill per DTP request
 * with the recipient name and individual status.
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
        .order("created_at", { ascending: false });
      if (error) throw error;
      return fillPartnerSigners((data ?? []) as DTPRecord[]);
    },
    refetchInterval: (q) => {
      const rows = (q.state.data ?? []) as DTPRecord[];
      const anyPending = rows.some((r) => deriveStatus(r) === "pending");
      return anyPending ? 30_000 : false;
    },
  });

  if (isLoading) {
    const style = STATUS_STYLES.syncing;
    return (
      <Badge variant="outline" className={cn("gap-1.5", style.className, className)}>
        <Loader2 className="h-3 w-3 animate-spin" />
        DTP: {style.label}
      </Badge>
    );
  }

  if (!data || data.length === 0) {
    const style = STATUS_STYLES.not_requested;
    return (
      <Badge variant="outline" className={cn("gap-1.5 font-medium", style.className, className)}>
        <FileSignature className="h-3 w-3" />
        DTP: {style.label}
      </Badge>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
        {data.map((row) => {
          const derived = deriveStatus(row);
          const style = STATUS_STYLES[derived];
          const signer = row.signature_signers?.[0];
          const recipient = signer?.signer_name || signer?.signer_email || "Recipient";
          return (
            <Tooltip key={row.id}>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className={cn(
                    "gap-1.5 font-medium",
                    style.className,
                    style.pulse && "animate-pulse",
                  )}
                >
                  <FileSignature className="h-3 w-3" />
                  <span className="truncate max-w-[160px]">{recipient}</span>
                  <span className="text-[10px] uppercase tracking-wide opacity-80">
                    {style.label}
                  </span>
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs space-y-1">
                {row.created_at && (
                  <div>
                    <span className="text-muted-foreground">Sent:</span>{" "}
                    {new Date(row.created_at).toLocaleString()}
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
          );
        })}
      </div>
    </TooltipProvider>
  );
}
