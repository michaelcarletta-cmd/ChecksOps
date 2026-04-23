import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Building2, AlertTriangle, Clock, DollarSign, FileWarning,
  ChevronRight, RefreshCw, Landmark, ArrowRightLeft,
} from "lucide-react";
import { format, differenceInDays } from "date-fns";
import { LossDraftDetailPanel } from "./LossDraftDetailPanel";
import { LossDraftDashboardCards } from "./LossDraftDashboardCards";
import { NewLossDraftDialog } from "./NewLossDraftDialog";
import { useTenantFilter } from "@/hooks/useTenantFilter";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface LossDraftRow {
  id: string;
  claim_id: string;
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
  days_in_escrow: number | null;
  missing_docs_count: number;
  is_stale: boolean;
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
  const [filter, setFilter] = useState<string>("active");

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
  });

  const baseFiltered = filter === "active"
    ? drafts.filter(d => d.escrow_status !== "final_release_complete")
    : filter === "stale"
    ? drafts.filter(d => d.is_stale)
    : filter === "missing_docs"
    ? drafts.filter(d => d.missing_docs_count > 0)
    : filter === "overdue"
    ? drafts.filter(d => d.follow_up_date && new Date(d.follow_up_date) < new Date())
    : drafts;

  const q = (searchQuery ?? "").trim().toLowerCase();
  const filtered = q
    ? baseFiltered.filter(d =>
        [d.claim_number, d.policyholder_name, d.mortgage_servicer, d.insurance_company]
          .some(v => v && v.toString().toLowerCase().includes(q))
      )
    : baseFiltered;

  const totalUnreleased = drafts
    .filter(d => d.escrow_status !== "final_release_complete")
    .reduce((s, d) => s + (d.unreleased_amount ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Landmark className="h-5 w-5 text-amber-400" />
            Loss Draft Tracker
          </h2>
          <p className="text-xs text-muted-foreground">
            Mortgage-escrowed funds · {drafts.filter(d => d.escrow_status !== "final_release_complete").length} active ·{" "}
            ${totalUnreleased.toLocaleString("en-US", { minimumFractionDigits: 2 })} unreleased
          </p>
        </div>
        <div className="flex items-center gap-2">
          <NewLossDraftDialog onCreated={() => qc.invalidateQueries({ queryKey: ["loss-draft-dashboard"] })} />
          <Button size="sm" variant="ghost" onClick={() => qc.invalidateQueries({ queryKey: ["loss-draft-dashboard"] })}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <LossDraftDashboardCards />

      {/* Filter chips */}
      <div className="flex gap-2 flex-wrap">
        {[
          { key: "active", label: "Active" },
          { key: "all", label: "All" },
          { key: "stale", label: "Stale" },
          { key: "missing_docs", label: "Missing Docs" },
          { key: "overdue", label: "Overdue Follow-up" },
        ].map(f => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? "default" : "outline"}
            className="text-xs h-7"
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.key === "stale" && drafts.filter(d => d.is_stale).length > 0 && (
              <Badge variant="destructive" className="ml-1 text-[10px] px-1">
                {drafts.filter(d => d.is_stale).length}
              </Badge>
            )}
          </Button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_28rem]">
        {/* Table */}
        <Card>
          <CardContent className="p-0">
            <ScrollArea className="h-[calc(100vh-480px)]">
              {isLoading ? (
                <div className="p-8 text-center text-muted-foreground">Loading loss drafts...</div>
              ) : filtered.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <Landmark className="h-10 w-10 mx-auto mb-2 opacity-30" />
                  No loss drafts in this view
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Claim</TableHead>
                      <TableHead>Servicer</TableHead>
                      <TableHead className="text-right">Escrowed</TableHead>
                      <TableHead className="text-right">Released</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Aging</TableHead>
                      <TableHead>Alerts</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map(d => {
                      const sc = escrowStatusConfig[d.escrow_status] ?? { label: d.escrow_status, color: "" };
                      const overdue = d.follow_up_date && new Date(d.follow_up_date) < new Date();
                      return (
                        <TableRow
                          key={d.id}
                          className={`cursor-pointer transition-colors ${selectedId === d.id ? "bg-accent/50" : ""}`}
                          onClick={() => setSelectedId(d.id)}
                        >
                          <TableCell>
                            <div className="text-sm font-medium">{d.claim_number || "—"}</div>
                            <div className="text-xs text-muted-foreground truncate max-w-[120px]">
                              {d.policyholder_name}
                            </div>
                          </TableCell>
                          <TableCell className="text-sm max-w-[120px] truncate">{d.mortgage_servicer}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums text-sm">
                            ${(d.total_escrowed ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-sm text-emerald-400">
                            ${(d.draw_amount_released ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell>
                            <Badge className={`text-[10px] ${sc.color}`}>{sc.label}</Badge>
                          </TableCell>
                          <TableCell className="text-sm tabular-nums">
                            {d.days_in_escrow != null ? `${d.days_in_escrow}d` : "—"}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              {d.is_stale && <span title="Stale — no contact 14+ days"><AlertTriangle className="h-3.5 w-3.5 text-red-400" /></span>}
                              {d.missing_docs_count > 0 && <span title={`${d.missing_docs_count} missing docs`}><FileWarning className="h-3.5 w-3.5 text-amber-400" /></span>}
                              {overdue && <span title="Overdue follow-up"><Clock className="h-3.5 w-3.5 text-orange-400" /></span>}
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Detail panel */}
        {selectedId ? (
          <LossDraftDetailPanel
            lossDraftId={selectedId}
            onUpdate={() => {
              qc.invalidateQueries({ queryKey: ["loss-draft-dashboard"] });
              qc.invalidateQueries({ queryKey: ["loss-draft-counts"] });
            }}
          />
        ) : (
          <Card className="flex items-center justify-center h-[calc(100vh-480px)]">
            <div className="text-center text-muted-foreground">
              <Landmark className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Select a loss draft to manage</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
