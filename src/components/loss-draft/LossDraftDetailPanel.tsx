import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCircle2, Landmark } from "lucide-react";
import { escrowStatusConfig } from "./LossDraftDashboard";
import {
  useLossDraftAudit,
  useLossDraftDetail,
  useLossDraftDocs,
  useLossDraftReleases,
  useInvalidateLossDraft,
} from "@/hooks/queries/useLossDraft";
import { LossDraftActionsTab } from "./detail/LossDraftActionsTab";
import { LossDraftDocsTab } from "./detail/LossDraftDocsTab";
import { LossDraftReleasesTab } from "./detail/LossDraftReleasesTab";
import { LossDraftAuditTab } from "./detail/LossDraftAuditTab";

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
}: {
  lossDraftId: string;
  onUpdate: () => void;
}) {
  const { data: draft } = useLossDraftDetail(lossDraftId);
  const { data: releases = [] } = useLossDraftReleases(lossDraftId);
  const { data: docs = [] } = useLossDraftDocs(lossDraftId);
  const { data: audit = [] } = useLossDraftAudit(lossDraftId);
  const invalidateAll = useInvalidateLossDraft(lossDraftId);

  const handleChanged = () => {
    invalidateAll();
    onUpdate();
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
    <Card className="h-[calc(100vh-480px)] flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Landmark className="h-4 w-4 text-amber-400" />
            {draft.mortgage_servicer}
          </CardTitle>
          <Badge className={`text-[10px] ${sc.color}`}>{sc.label}</Badge>
        </div>
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
      </CardHeader>
      <Separator />

      {draft.escrow_status === "final_release_complete" && (
        <div className="mx-4 my-3 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
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

      <Tabs defaultValue="actions" className="flex-1 flex flex-col">
        <TabsList className="w-full rounded-none shrink-0">
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
          <TabsTrigger value="audit" className="flex-1 text-xs">
            Audit
          </TabsTrigger>
        </TabsList>

        <TabsContent value="actions" className="mt-0 flex-1 overflow-auto">
          <LossDraftActionsTab
            lossDraftId={lossDraftId}
            draft={draft}
            onChanged={handleChanged}
          />
        </TabsContent>

        <TabsContent value="docs" className="mt-0 flex-1 overflow-auto">
          <LossDraftDocsTab
            lossDraftId={lossDraftId}
            claimId={draft.claim_id}
            docs={docs}
            onChanged={handleChanged}
          />
        </TabsContent>

        <TabsContent value="releases" className="mt-0 flex-1 overflow-auto">
          <LossDraftReleasesTab releases={releases} />
        </TabsContent>

        <TabsContent value="audit" className="mt-0 flex-1 overflow-auto">
          <LossDraftAuditTab audit={audit} />
        </TabsContent>
      </Tabs>
    </Card>
  );
}
