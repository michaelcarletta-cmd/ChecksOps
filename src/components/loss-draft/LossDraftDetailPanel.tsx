import { useState } from "react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCircle2, Landmark, Pencil, Share2, MessageSquare } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { escrowStatusConfig } from "./LossDraftDashboard";
import {
  useLossDraftAudit,
  useLossDraftDetail,
  useLossDraftDocs,
  useLossDraftReleases,
  useInvalidateLossDraft,
  useRelatedLossDrafts,
} from "@/hooks/queries/useLossDraft";
import { LossDraftActionsTab } from "./detail/LossDraftActionsTab";
import { LossDraftDocsTab } from "./detail/LossDraftDocsTab";
import { LossDraftReleasesTab } from "./detail/LossDraftReleasesTab";
import { LossDraftAuditTab } from "./detail/LossDraftAuditTab";
import { ViewCheckImageButton } from "@/components/checks/ViewCheckImageButton";
import { AdminDeleteCheckButton } from "@/components/checks/AdminDeleteCheckButton";
import { ReuploadCheckImageButton } from "@/components/checks/ReuploadCheckImageButton";
import { ShareCheckDialog } from "@/components/check-review/ShareCheckDialog";
import { CheckMessageThread } from "@/components/check-messages/CheckMessageThread";
import { ScrollArea } from "@/components/ui/scroll-area";

const isUnknownServicer = (value?: string | null) =>
  !value || value.trim().toLowerCase().includes("unknown");

/**
 * Thin orchestrator for the Loss Draft detail panel.
 *
 * Responsibilities:
 * - Fetches the 4 data slices via shared query hooks (single source of truth in queryKeys.ts)
 * - Renders the panel header + tab shell
 * - Delegates each tab's logic to a focused subcomponent
 *
 * No business logic lives here on purpose — keeps re-renders cheap and
 * makes each tab independently testable.
 */
export function LossDraftDetailPanel({
  lossDraftId,
  onUpdate,
  onSelectId,
}: {
  lossDraftId: string;
  onUpdate: () => void;
  onSelectId?: (id: string) => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { data: draft } = useLossDraftDetail(lossDraftId);
  const { data: releases = [] } = useLossDraftReleases(lossDraftId);
  const { data: docs = [] } = useLossDraftDocs(lossDraftId);
  const { data: audit = [] } = useLossDraftAudit(lossDraftId);
  const { data: related = [] } = useRelatedLossDrafts(lossDraftId);
  const invalidateAll = useInvalidateLossDraft(lossDraftId);

  const [editingLender, setEditingLender] = useState(false);
  const [lenderName, setLenderName] = useState("");
  const [savingLender, setSavingLender] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("actions");

  const handleChanged = () => {
    invalidateAll();
    onUpdate();
  };

  const saveLender = async () => {
    if (!user?.id || !lenderName.trim()) return;
    setSavingLender(true);
    try {
      const { error } = await supabase.rpc("loss_draft_set_lender" as any, {
        p_loss_draft_id: lossDraftId,
        p_lender_name: lenderName.trim(),
        p_actor_id: user.id,
      });
      if (error) throw error;
      toast({ title: "Servicer updated", description: "Loss Draft servicer has been corrected." });
      setEditingLender(false);
      setLenderName("");
      handleChanged();
    } catch (e: any) {
      toast({ title: "Servicer update failed", description: e.message, variant: "destructive" });
    } finally {
      setSavingLender(false);
    }
  };

  if (!draft) return null;

  const sc = escrowStatusConfig[draft.escrow_status] ?? {
    label: draft.escrow_status,
    color: "",
  };
  const isMonitored = draft.monitoring_type !== "not_monitored";
  const fmtMoney = (v: number) =>
    `$${(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  return (
    <Card className="flex h-[calc(100vh-16rem)] min-h-[22rem] max-h-[42rem] min-w-0 flex-col overflow-hidden">
      <CardHeader className="shrink-0 pb-2">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <CardTitle className="min-w-0 text-sm flex items-center gap-2 leading-snug">
            <Landmark className="h-4 w-4 text-amber-400 shrink-0" />
            <span className="min-w-0 break-words">{draft.mortgage_servicer}</span>
          </CardTitle>
          <Badge className={`shrink-0 text-[10px] ${sc.color}`}>{sc.label}</Badge>
        </div>

        <div className="pt-1">
          {editingLender ? (
            <div className="space-y-2 rounded-md border border-input p-2">
              <Label className="text-xs">Set mortgage servicer</Label>
              <Input
                value={lenderName}
                onChange={(e) => setLenderName(e.target.value)}
                placeholder="Enter mortgage servicer"
                className="h-8 min-w-0 text-xs"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={savingLender || !lenderName.trim()}
                  onClick={saveLender}
                >
                  {savingLender ? "Saving..." : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => setEditingLender(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className={`h-6 px-1 text-[10px] ${
                isUnknownServicer(draft.mortgage_servicer) ? "text-primary" : "text-muted-foreground"
              }`}
              onClick={() => {
                setLenderName(
                  isUnknownServicer(draft.mortgage_servicer) ? "" : draft.mortgage_servicer
                );
                setEditingLender(true);
              }}
            >
              <Pencil className="mr-1 h-3 w-3" />
              {isUnknownServicer(draft.mortgage_servicer) ? "Add servicer" : "Correct servicer"}
            </Button>
          )}
        </div>

        {draft.check_intake_items && (
          <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-xs space-y-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                {draft.check_intake_items.check_number
                  ? `Check #${draft.check_intake_items.check_number}`
                  : "Check"}
              </span>
              {draft.check_intake_items.amount != null && (
                <span className="tabular-nums">
                  ${Number(draft.check_intake_items.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                </span>
              )}
            </div>
            {draft.check_intake_items.payee_line && (
              <div className="text-muted-foreground truncate">{draft.check_intake_items.payee_line}</div>
            )}
            {draft.check_intake_items.carrier_name && (
              <div className="text-muted-foreground truncate">{draft.check_intake_items.carrier_name}</div>
            )}
            {!draft.claim_id && (
              <div className="text-[10px] text-amber-400 pt-0.5">No claim linked — managing from check intake</div>
            )}
          </div>
        )}

        {isMonitored ? (
          <div className="text-xs text-muted-foreground">
            Draw #{draft.draw_stage} · Holdback {fmtMoney(draft.holdback_amount)}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            Not Monitored — Mortgage endorses &amp; returns check
            {draft.check_received_back_date && " · ✅ Received back"}
          </div>
        )}

        {draft.check_intake_item_id && (
          <div className="flex flex-wrap gap-2 pt-2">
            <ViewCheckImageButton
              checkId={draft.check_intake_item_id}
              size="sm"
              variant="outline"
              className="h-7 text-xs"
            />
            <ReuploadCheckImageButton
              checkId={draft.check_intake_item_id}
              side="front"
              hasImage={!!draft.check_intake_items?.front_image_path}
              onUploaded={handleChanged}
              size="sm"
              variant="outline"
              className="h-7 text-xs"
            />
            <ReuploadCheckImageButton
              checkId={draft.check_intake_item_id}
              side="back"
              hasImage={!!draft.check_intake_items?.back_image_path}
              onUploaded={handleChanged}
              size="sm"
              variant="outline"
              className="h-7 text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => setShareDialogOpen(true)}
              title="Share with partner"
            >
              <Share2 className="h-3 w-3" /> Share
            </Button>
            <AdminDeleteCheckButton
              checkId={draft.check_intake_item_id}
              onDeleted={handleChanged}
              size="sm"
              variant="outline"
              className="h-7 text-xs"
            />

          </div>
        )}
      </CardHeader>
      
      {related.length > 0 && (
        <div className="px-4 pb-2 flex items-center gap-2 overflow-x-auto no-scrollbar">
          <Button
            size="sm"
            variant="default"
            className="h-7 text-[10px] shrink-0"
            disabled
          >
            {draft.mortgage_servicer}
          </Button>
          {related.map(r => (
            <Button
              key={r.id}
              size="sm"
              variant="outline"
              className="h-7 text-[10px] shrink-0"
              onClick={() => onSelectId?.(r.id)}
            >
              {r.mortgage_servicer}
            </Button>
          ))}
        </div>
      )}
      
      <Separator />

      {draft.escrow_status === "final_release_complete" && (
        <div className="mx-4 my-3 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg flex items-start gap-3 shrink-0">
          <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0">
            <p className="text-sm font-medium text-emerald-500">
              Return to Deposit Flow Complete
            </p>
            <p className="text-xs text-emerald-400/80">
              The final release has been recorded and the check has been unblocked.
              It is now approved for deposit in the main orchestrator.
            </p>
          </div>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TabsList className="w-full rounded-none shrink-0 overflow-hidden">
          <TabsTrigger value="actions" className="flex-1 text-xs">
            Actions
          </TabsTrigger>
          <TabsTrigger value="docs" className="flex-1 text-xs">
            Docs ({docs.filter(d => d.is_required && !d.is_submitted).length})
          </TabsTrigger>
          {isMonitored && (
            <TabsTrigger value="releases" className="flex-1 text-xs">
              Draws ({releases.length})
            </TabsTrigger>
          )}
          <TabsTrigger value="partners" className="flex-1 text-xs gap-1">
            <Share2 className="h-3 w-3" /> Partners
          </TabsTrigger>
          <TabsTrigger value="audit" className="flex-1 text-xs">
            Audit
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="actions"
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          <LossDraftActionsTab
            lossDraftId={lossDraftId}
            draft={draft}
            onChanged={handleChanged}
          />
        </TabsContent>

        <TabsContent
          value="docs"
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          <LossDraftDocsTab
            lossDraftId={lossDraftId}
            claimId={draft.claim_id}
            checkIntakeItemId={draft.check_intake_item_id}
            docs={docs}
            onChanged={handleChanged}
          />
        </TabsContent>

        <TabsContent
          value="releases"
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          <LossDraftReleasesTab releases={releases} />
        </TabsContent>

        <TabsContent
          value="partners"
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          <div className="flex h-full flex-col p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium flex items-center gap-2">
                <MessageSquare className="h-4 w-4" /> Partner Discussion
              </h3>
            </div>
            <ScrollArea className="flex-1 pr-3">
              {draft.check_intake_item_id && (
                <CheckMessageThread 
                  checkId={draft.check_intake_item_id} 
                  active={activeTab === "partners"} 
                />
              )}
            </ScrollArea>
          </div>
        </TabsContent>

        <TabsContent
          value="audit"
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          <LossDraftAuditTab audit={audit} />
        </TabsContent>
      </Tabs>

      {draft.check_intake_item_id && (
        <ShareCheckDialog
          checkId={draft.check_intake_item_id}
          open={shareDialogOpen}
          onOpenChange={setShareDialogOpen}
        />
      )}
    </Card>
  );
}
