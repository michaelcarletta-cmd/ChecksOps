import { Fragment, useState } from "react";
import { localTodayDateValue, toDateInputValue } from "@/lib/issueDate";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertTriangle, Building2, Clock, FileWarning, RefreshCw, Landmark, ArrowLeft } from "lucide-react";
import { LossDraftDetailPanel } from "./LossDraftDetailPanel";
import { LossDraftFilterBar, type LossDraftFilter } from "./LossDraftDashboardCards";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { extractInsuredName, matchesAmountQuery } from "@/features/check-command/status";
import {
  COMPACT_LIST_SCROLL_CLASS,
  CompactCheckListBody,
  CompactCheckRow,
  CompactClaimGroupHeader,
  formatCompactAmount,
} from "@/components/check-review/CompactCheckList";
import { displayCase } from "@/lib/displayCase";
import { groupLossDraftsByClaim, lossDraftGroupDetails } from "@/lib/lossDraftGroups";
import { useMortgageDeskReturnAlerts } from "@/hooks/useMortgageDeskReturnAlert";
import { compareLossDraftReturnPriority } from "@/lib/mortgageDeskReturn";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface LossDraftRow {
  id: string;
  claim_id: string | null;
  claim_number: string | null;
  policyholder_name: string | null;
  insurance_company: string | null;
  mortgage_servicer: string;
  escrow_status: string;
  total_escrowed: number;
  draw_amount_released: number;
  holdback_amount: number;
  unreleased_amount: number;
  draw_stage: number;
  follow_up_date: string | null;
  follow_up_count: number;
  last_contact_at: string | null;
  check_sent_date: string | null;
  check_received_date: string | null;
  created_at: string;
  updated_at: string;
  missing_docs_count: number;
  is_stale: boolean;
  monitoring_type?: string | null;
  check_status?: string | null;
  check_intake_item_id?: string | null;
  check_number?: string | null;
  check_amount?: number | null;
  payee_line?: string | null;
  carrier_name?: string | null;
}

const escrowStatusConfig: Record<string, { label: string; color: string }> = {
  pending_send: { label: "Pending Send", color: "bg-muted text-muted-foreground" },
  sent_to_lender: { label: "Sent to Lender", color: "bg-blue-500/20 text-blue-400" },
  received_by_lender: { label: "Received", color: "bg-blue-500/20 text-blue-400" },
  check_received_back: { label: "Received Back", color: "bg-emerald-500/20 text-emerald-400" },
  endorsing: { label: "Endorsing", color: "bg-orange-500/20 text-orange-400" },
  escrowed: { label: "Escrowed", color: "bg-amber-500/20 text-amber-400" },
  first_draw_requested: { label: "Draw Requested", color: "bg-orange-500/20 text-orange-400" },
  partial_release: { label: "Partial Release", color: "bg-emerald-500/20 text-emerald-300" },
  final_release_complete: { label: "Fully Released", color: "bg-primary/20 text-primary" },
  disputed: { label: "Disputed", color: "bg-destructive/20 text-destructive" },
};

export { escrowStatusConfig };

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface LossDraftDashboardProps {
  searchQuery?: string;
}

export function LossDraftDashboard({ searchQuery = "" }: LossDraftDashboardProps = {}) {
  const qc = useQueryClient();
  const { tenantId } = useTenantFilter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<LossDraftFilter>("active");

  const { data: drafts = [], isLoading } = useQuery({
    queryKey: ["loss-draft-dashboard", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_dashboard" as any)
        .select("*")
        .eq("tenant_id", tenantId!)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as LossDraftRow[];
    },
    enabled: !!tenantId,
    refetchOnWindowFocus: false, // Prevent page jump when switching tabs
  });

  // Loss Draft tab ONLY shows checks that are actively monitored by a mortgage company
  // (we need to document mortgage releases). Non-monitored checks flow through the
  // normal Review → Endorsing → Deposit lane and never sit in Loss Draft.
  const isVisibleInLossDraft = (d: LossDraftRow) =>
    !["endorsing"].includes(d.escrow_status);
  const visibleDrafts = drafts.filter(isVisibleInLossDraft);

  const q = (searchQuery ?? "").trim().toLowerCase();
  const searched = q
    ? visibleDrafts.filter(d =>
        [d.claim_number, d.policyholder_name, d.mortgage_servicer, d.insurance_company, d.check_number, d.payee_line, d.carrier_name]
          .some(v => v && v.toString().toLowerCase().includes(q)) ||
        matchesAmountQuery(q, d.check_amount) ||
        matchesAmountQuery(q, d.unreleased_amount) ||
        matchesAmountQuery(q, d.total_escrowed)
      )
    : visibleDrafts;

  const isActiveDraft = (d: LossDraftRow) => d.escrow_status !== "final_release_complete";
  const isMonitored = (d: LossDraftRow) => (d.monitoring_type ?? "monitored") !== "not_monitored";

  const activeCount = visibleDrafts.filter(isActiveDraft).length;
  const monitoredCount = visibleDrafts.filter(d => isActiveDraft(d) && isMonitored(d)).length;
  const nonMonitoredCount = visibleDrafts.filter(d => isActiveDraft(d) && !isMonitored(d)).length;

  const filtered = searched.filter(d => {
    if (!isActiveDraft(d)) return false;
    if (filter === "monitored") return isMonitored(d);
    if (filter === "non_monitored") return !isMonitored(d);
    return true;
  });
  // Key the return-alert query on the search- and card-filter-independent set
  // of active drafts, then look up per row on the client, so typing in search
  // or switching cards never refetches (and badges never flicker).
  const returnAlerts = useMortgageDeskReturnAlerts(
    visibleDrafts
      .filter(isActiveDraft)
      .map((d) => d.check_intake_item_id)
      .filter((id): id is string => !!id),
  ).data;
  const prioritized = filtered.slice().sort((a, b) =>
    compareLossDraftReturnPriority(
      Boolean(a.check_intake_item_id && returnAlerts?.[a.check_intake_item_id]?.actionRequired),
      Boolean(b.check_intake_item_id && returnAlerts?.[b.check_intake_item_id]?.actionRequired),
    ),
  );

  const visibleUnreleased = prioritized.reduce((s, d) => s + (d.unreleased_amount ?? 0), 0);
  const isReturned = (d: LossDraftRow) =>
    Boolean(d.check_intake_item_id && returnAlerts?.[d.check_intake_item_id]?.actionRequired);
  const groups = groupLossDraftsByClaim(prioritized, extractInsuredName);

  return (
    <div
      className={
        selectedId
          ? "grid items-start gap-4 grid-cols-1"
          : "grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)]"
      }
    >
      {/* Compact list — hidden when a check is expanded */}
      {!selectedId && (
        <Card className="overflow-hidden min-w-0">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Landmark className="h-4 w-4 text-purple-400" />
                Loss Draft
              </CardTitle>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0"
                  aria-label="Refresh loss drafts"
                  title="Refresh"
                  onClick={() => qc.invalidateQueries({ queryKey: ["loss-draft-dashboard"] })}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <LossDraftFilterBar
            activeCount={activeCount}
            monitoredCount={monitoredCount}
            nonMonitoredCount={nonMonitoredCount}
            visibleCount={prioritized.length}
            visibleUnreleased={visibleUnreleased}
            activeFilter={filter}
            onFilterChange={setFilter}
          />
          <CardContent className="p-0">
            <ScrollArea className={COMPACT_LIST_SCROLL_CLASS}>
              {isLoading ? (
                <div className="p-8 text-center text-muted-foreground">Loading loss drafts...</div>
              ) : prioritized.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <Landmark className="h-10 w-10 mx-auto mb-2 opacity-30" />
                  No loss drafts in this view
                </div>
              ) : (
                <CompactCheckListBody>
                  {groups.map((group) => (
                    <Fragment key={group.key}>
                      <CompactClaimGroupHeader
                        policyholderName={group.policyholderName}
                        claimNumber={group.claimNumber}
                        count={group.drafts.length}
                        details={lossDraftGroupDetails(group.drafts, escrowStatusLabel)}
                      />
                      {group.drafts.map((d) => (
                        <LossDraftCompactRow
                          key={d.id}
                          draft={d}
                          returned={isReturned(d)}
                          onSelect={() => setSelectedId(d.id)}
                        />
                      ))}
                    </Fragment>
                  ))}
                </CompactCheckListBody>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Detail panel — full-width when a check is expanded */}
      {selectedId ? (
        <div className="space-y-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedId(null)}
            className="gap-1.5 h-8 px-2 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to list
          </Button>
          <LossDraftDetailPanel
            lossDraftId={selectedId}
            onUpdate={() => {
              qc.invalidateQueries({ queryKey: ["loss-draft-dashboard"] });
              qc.invalidateQueries({ queryKey: ["loss-draft-counts"] });
            }}
            onSelectId={setSelectedId}
          />
        </div>
      ) : (
        <Card className="hidden lg:flex self-stretch items-center justify-center min-h-[22rem]">
          <div className="text-center text-muted-foreground">
            <Landmark className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Select a loss draft to manage</p>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Compact list pieces                                                */
/* ------------------------------------------------------------------ */

function escrowStatusLabel(status: string): string {
  return escrowStatusConfig[status]?.label ?? status;
}

function LossDraftCompactRow({
  draft: d,
  returned,
  onSelect,
}: {
  draft: LossDraftRow;
  returned: boolean;
  onSelect: () => void;
}) {
  const sc = escrowStatusConfig[d.escrow_status] ?? { label: d.escrow_status, color: "" };
  const overdue = Boolean(d.follow_up_date) && toDateInputValue(d.follow_up_date) < localTodayDateValue();
  const carrier = displayCase(d.insurance_company) || displayCase(d.carrier_name) || "—";
  const notMonitored = (d.monitoring_type ?? "monitored") === "not_monitored";
  const escrowed = d.total_escrowed ?? 0;
  const released = d.draw_amount_released ?? 0;
  return (
    <CompactCheckRow
      checkNumber={d.check_number}
      amount={d.check_amount ?? d.total_escrowed}
      className={returned ? "bg-amber-500/10" : ""}
      onClick={onSelect}
      subtitle={
        <span title={carrier}>{carrier}</span>
      }
      pills={
        <>
          <Badge className={`text-[10px] ${sc.color}`}>{sc.label}</Badge>
          {returned && (
            <Badge className="text-[10px] bg-amber-500/20 text-amber-200 border-amber-400/30">
              Returned from Mortgage Desk · Action Required
            </Badge>
          )}
          <Badge
            variant="outline"
            className="text-[10px] gap-1 max-w-full min-w-0"
            title={`Mortgage company: ${d.mortgage_servicer || "—"}`}
          >
            <Building2 className="h-3 w-3 shrink-0" />
            <span className="truncate">{d.mortgage_servicer || "No mortgage company"}</span>
          </Badge>
          <Badge variant="outline" className="text-[10px] tabular-nums">
            Escrowed {formatCompactAmount(escrowed)} · <span className="text-emerald-400">&nbsp;Released {formatCompactAmount(released)}</span>
          </Badge>
          {d.holdback_amount > 0 && (
            <Badge variant="outline" className="text-[10px] tabular-nums">
              Holdback {formatCompactAmount(d.holdback_amount)}
            </Badge>
          )}
          {d.draw_stage > 0 && (
            <Badge variant="outline" className="text-[10px]">Draw {d.draw_stage}</Badge>
          )}
          {notMonitored && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">Not monitored</Badge>
          )}
          {d.is_stale && (
            <Badge variant="outline" className="text-[10px] gap-1 text-red-400 border-red-400/30" title="Stale — no contact 14+ days">
              <AlertTriangle className="h-3 w-3" />
              Stale
            </Badge>
          )}
          {d.missing_docs_count > 0 && (
            <Badge variant="outline" className="text-[10px] gap-1 text-amber-400 border-amber-400/30" title={`${d.missing_docs_count} missing docs`}>
              <FileWarning className="h-3 w-3" />
              {d.missing_docs_count} missing doc{d.missing_docs_count === 1 ? "" : "s"}
            </Badge>
          )}
          {overdue && (
            <Badge variant="outline" className="text-[10px] gap-1 text-orange-400 border-orange-400/30" title="Overdue follow-up">
              <Clock className="h-3 w-3" />
              Follow-up overdue
            </Badge>
          )}
        </>
      }
    />
  );
}
