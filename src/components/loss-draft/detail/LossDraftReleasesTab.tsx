import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { DollarSign, FileText } from "lucide-react";
import { format } from "date-fns";
import { ClaimLedgerCard } from "@/components/payments/ClaimLedgerCard";
import { ClaimSettlementEditor } from "@/components/payments/ClaimSettlementEditor";
import type { LossDraftRecord, LossDraftRelease } from "@/hooks/queries/useLossDraft";

interface Props {
  releases: LossDraftRelease[];
  draft: LossDraftRecord;
  onChanged: () => void;
  /** Monitored files list their draws; a not-monitored file has none. */
  showDraws?: boolean;
}

/**
 * Draws tab: the claim ledger (moved here from the Actions tab, owner decision
 * 2026-10-30) and the draws recorded on this file (loss_draft_releases).
 */
export function LossDraftReleasesTab({ releases, draft, onChanged, showDraws = true }: Props) {
  const [ledgerEditorOpen, setLedgerEditorOpen] = useState(false);

  // Fetch settlement for the ledger editor
  const { data: settlement } = useQuery({
    queryKey: ["claim-ledger-settlement", draft.claim_id],
    enabled: !!draft.claim_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_settlements")
        .select("*")
        .eq("claim_id", draft.claim_id!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="p-4 space-y-3">
        {/* Claim Ledger */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <FileText className="h-3 w-3" /> Claim Ledger
            </p>
            {draft.claim_id && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[10px]"
                onClick={() => setLedgerEditorOpen(true)}
              >
                <DollarSign className="h-3 w-3 mr-1" /> Edit Ledger
              </Button>
            )}
          </div>
          <ClaimLedgerCard
            checkIntakeItemId={draft.check_intake_item_id!}
            claimId={draft.claim_id}
            detectedClaimNumber={draft.check_intake_items?.detected_claim_number ?? null}
            onLinked={onChanged}
          />
          {draft.claim_id && (
            <ClaimSettlementEditor
              open={ledgerEditorOpen}
              onOpenChange={setLedgerEditorOpen}
              claimId={draft.claim_id}
              settlement={settlement}
            />
          )}
        </div>

        {showDraws && (
          <>
            <Separator />
            <p className="text-xs font-medium text-muted-foreground">Draws</p>
            {releases.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No draws recorded yet.</p>
            ) : (
              releases.map(r => (
                <div key={r.id} className="border rounded-lg p-2 space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium">Draw #{r.draw_number}</p>
                    <Badge variant="outline" className="text-[10px]">
                      {r.status}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-[10px]">
                    <div>
                      <span className="text-muted-foreground">Requested: </span>
                      ${Number(r.amount_requested ?? 0).toLocaleString()}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Released: </span>
                      <span className="text-emerald-400">
                        ${Number(r.amount_released ?? 0).toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Holdback: </span>
                      <span className="text-red-400">
                        ${Number(r.holdback_amount ?? 0).toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Requested {format(new Date(r.requested_at), "MMM d")}
                    {r.released_at && ` · Released ${format(new Date(r.released_at), "MMM d")}`}
                  </p>
                  {r.notes && <p className="text-[10px] italic">{r.notes}</p>}
                </div>
              ))
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}
