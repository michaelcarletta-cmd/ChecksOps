import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Send, Building2, ArrowRightLeft, DollarSign, CheckCircle2,
  FileText, Clock, AlertTriangle, History, Landmark,
} from "lucide-react";
import { format } from "date-fns";
import { escrowStatusConfig } from "./LossDraftDashboard";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Release {
  id: string;
  draw_number: number;
  amount_requested: number;
  amount_released: number;
  holdback_amount: number;
  status: string;
  release_date: string | null;
  requested_at: string;
  released_at: string | null;
  notes: string | null;
}

interface DocItem {
  id: string;
  document_type: string;
  document_label: string;
  is_required: boolean;
  is_submitted: boolean;
  submitted_at: string | null;
  notes: string | null;
}

interface AuditEntry {
  id: string;
  action: string;
  actor_id: string | null;
  amount: number | null;
  notes: string | null;
  created_at: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
}

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

const ACTION_BUTTONS: { action: string; label: string; icon: typeof Send; color: string; needsAmount?: boolean; fromStatuses: string[] }[] = [
  { action: "mark_sent", label: "Mark Sent to Mortgage", icon: Send, color: "text-blue-400", fromStatuses: ["pending_send"] },
  { action: "mark_escrowed", label: "Mark Escrowed", icon: Building2, color: "text-amber-400", needsAmount: true, fromStatuses: ["sent_to_lender", "received_by_lender"] },
  { action: "request_draw", label: "Request Draw", icon: ArrowRightLeft, color: "text-orange-400", needsAmount: true, fromStatuses: ["escrowed", "first_draw_requested", "partial_release"] },
  { action: "record_release", label: "Record Release", icon: DollarSign, color: "text-emerald-400", needsAmount: true, fromStatuses: ["first_draw_requested", "partial_release", "escrowed"] },
  { action: "record_holdback", label: "Record Holdback", icon: AlertTriangle, color: "text-red-400", needsAmount: true, fromStatuses: ["escrowed", "first_draw_requested", "partial_release"] },
  { action: "mark_final_release", label: "Mark Final Release", icon: CheckCircle2, color: "text-primary", fromStatuses: ["partial_release", "escrowed", "first_draw_requested"] },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function LossDraftDetailPanel({
  lossDraftId,
  onUpdate,
}: {
  lossDraftId: string;
  onUpdate: () => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [actionAmount, setActionAmount] = useState("");
  const [actionNotes, setActionNotes] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Fetch loss draft detail
  const { data: draft } = useQuery({
    queryKey: ["loss-draft-detail", lossDraftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_tracking")
        .select("*")
        .eq("id", lossDraftId)
        .single();
      if (error) throw error;
      return data;
    },
  });

  // Releases
  const { data: releases = [] } = useQuery({
    queryKey: ["loss-draft-releases", lossDraftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_releases")
        .select("*")
        .eq("loss_draft_id", lossDraftId)
        .order("draw_number", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Release[];
    },
  });

  // Documents
  const { data: docs = [] } = useQuery({
    queryKey: ["loss-draft-docs", lossDraftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_documents")
        .select("*")
        .eq("loss_draft_id", lossDraftId)
        .order("is_required", { ascending: false });
      if (error) throw error;
      return (data ?? []) as DocItem[];
    },
  });

  // Audit
  const { data: audit = [] } = useQuery({
    queryKey: ["loss-draft-audit", lossDraftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_audit_log")
        .select("*")
        .eq("loss_draft_id", lossDraftId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as AuditEntry[];
    },
  });

  const executeAction = async (action: string) => {
    if (!user?.id || !draft) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.rpc("loss_draft_action", {
        p_loss_draft_id: lossDraftId,
        p_action: action,
        p_actor_id: user.id,
        p_amount: actionAmount ? parseFloat(actionAmount) : null,
        p_notes: actionNotes || null,
        p_extra: JSON.stringify({}),
      });
      if (error) throw error;
      toast({ title: "Action completed", description: `${action.replace(/_/g, " ")} applied successfully.` });
      setPendingAction(null);
      setActionAmount("");
      setActionNotes("");
      qc.invalidateQueries({ queryKey: ["loss-draft-detail", lossDraftId] });
      qc.invalidateQueries({ queryKey: ["loss-draft-releases", lossDraftId] });
      qc.invalidateQueries({ queryKey: ["loss-draft-audit", lossDraftId] });
      onUpdate();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const toggleDoc = async (docId: string, isSubmitted: boolean) => {
    await supabase
      .from("loss_draft_documents")
      .update({
        is_submitted: isSubmitted,
        submitted_at: isSubmitted ? new Date().toISOString() : null,
        submitted_by: isSubmitted ? user?.id : null,
      })
      .eq("id", docId);
    // Audit
    if (user?.id) {
      await supabase.from("loss_draft_audit_log").insert({
        loss_draft_id: lossDraftId,
        action: isSubmitted ? "document_submitted" : "document_unsubmitted",
        actor_id: user.id,
        notes: `Document ${docId} marked as ${isSubmitted ? "submitted" : "not submitted"}`,
      });
    }
    qc.invalidateQueries({ queryKey: ["loss-draft-docs", lossDraftId] });
    qc.invalidateQueries({ queryKey: ["loss-draft-audit", lossDraftId] });
    onUpdate();
  };

  if (!draft) return null;

  const sc = escrowStatusConfig[draft.escrow_status as string] ?? { label: draft.escrow_status, color: "" };
  const availableActions = ACTION_BUTTONS.filter(a => a.fromStatuses.includes(draft.escrow_status as string));

  return (
    <Card className="h-[calc(100vh-480px)] flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Landmark className="h-4 w-4 text-amber-400" />
            {(draft as any).mortgage_servicer}
          </CardTitle>
          <Badge className={`text-[10px] ${sc.color}`}>{sc.label}</Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          Draw #{(draft as any).draw_stage} · Holdback ${((draft as any).holdback_amount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
        </div>
      </CardHeader>
      <Separator />
      <Tabs defaultValue="actions" className="flex-1 flex flex-col">
        <TabsList className="w-full rounded-none shrink-0">
          <TabsTrigger value="actions" className="flex-1 text-xs">Actions</TabsTrigger>
          <TabsTrigger value="docs" className="flex-1 text-xs">Docs ({docs.filter(d => d.is_required && !d.is_submitted).length})</TabsTrigger>
          <TabsTrigger value="releases" className="flex-1 text-xs">Draws ({releases.length})</TabsTrigger>
          <TabsTrigger value="audit" className="flex-1 text-xs">Audit</TabsTrigger>
        </TabsList>

        {/* Actions tab */}
        <TabsContent value="actions" className="mt-0 flex-1 overflow-auto">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-3">
              {/* Cash flow summary */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-accent/30 rounded-lg p-2">
                  <p className="text-[10px] text-muted-foreground">Total Escrowed</p>
                  <p className="text-sm font-bold">
                    ${((draft as any).total_escrowed ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </p>
                </div>
                <div className="bg-accent/30 rounded-lg p-2">
                  <p className="text-[10px] text-muted-foreground">Released</p>
                  <p className="text-sm font-bold text-emerald-400">
                    ${((draft as any).draw_amount_released ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </p>
                </div>
                <div className="bg-accent/30 rounded-lg p-2">
                  <p className="text-[10px] text-muted-foreground">Holdback</p>
                  <p className="text-sm font-bold text-red-400">
                    ${((draft as any).holdback_amount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </p>
                </div>
                <div className="bg-accent/30 rounded-lg p-2">
                  <p className="text-[10px] text-muted-foreground">Unreleased</p>
                  <p className="text-sm font-bold text-amber-400">
                    ${(((draft as any).total_escrowed ?? 0) - ((draft as any).draw_amount_released ?? 0)).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </p>
                </div>
              </div>

              <Separator />

              {/* Action buttons */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Available Actions</p>
                {availableActions.length === 0 && (
                  <p className="text-xs text-muted-foreground italic">No actions available for current status</p>
                )}
                {availableActions.map(a => (
                  <div key={a.action}>
                    {pendingAction === a.action ? (
                      <div className="border rounded-lg p-3 space-y-2">
                        <p className="text-xs font-medium">{a.label}</p>
                        {a.needsAmount && (
                          <div>
                            <Label className="text-xs">Amount</Label>
                            <Input
                              type="number"
                              step="0.01"
                              placeholder="0.00"
                              value={actionAmount}
                              onChange={e => setActionAmount(e.target.value)}
                              className="h-8"
                            />
                          </div>
                        )}
                        <div>
                          <Label className="text-xs">Notes</Label>
                          <Textarea
                            rows={2}
                            value={actionNotes}
                            onChange={e => setActionNotes(e.target.value)}
                            placeholder="Optional notes..."
                            className="text-xs"
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" className="text-xs" disabled={submitting} onClick={() => executeAction(a.action)}>
                            {submitting ? "Saving..." : "Confirm"}
                          </Button>
                          <Button size="sm" variant="ghost" className="text-xs" onClick={() => setPendingAction(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full justify-start text-xs"
                        onClick={() => setPendingAction(a.action)}
                      >
                        <a.icon className={`h-3.5 w-3.5 mr-2 ${a.color}`} />
                        {a.label}
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              {/* Follow-up info */}
              {(draft as any).follow_up_date && (
                <div className="bg-accent/30 rounded-lg p-2 mt-2">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    Next follow-up: {format(new Date((draft as any).follow_up_date), "MMM d, yyyy")}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {(draft as any).follow_up_count} contacts · Last: {(draft as any).last_contact_at ? format(new Date((draft as any).last_contact_at), "MMM d 'at' h:mm a") : "Never"}
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Documents tab */}
        <TabsContent value="docs" className="mt-0 flex-1 overflow-auto">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-2">
              {docs.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No document checklist generated yet.</p>
              ) : (
                docs.map(d => (
                  <div key={d.id} className="flex items-center gap-2 py-1">
                    <Checkbox
                      checked={d.is_submitted}
                      onCheckedChange={(checked) => toggleDoc(d.id, !!checked)}
                    />
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs ${d.is_submitted ? "line-through text-muted-foreground" : ""}`}>
                        {d.document_label}
                      </p>
                      {d.is_required && !d.is_submitted && (
                        <Badge variant="destructive" className="text-[9px] px-1">Required</Badge>
                      )}
                    </div>
                    {d.submitted_at && (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {format(new Date(d.submitted_at), "M/d")}
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Releases tab */}
        <TabsContent value="releases" className="mt-0 flex-1 overflow-auto">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-3">
              {releases.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No draws requested yet.</p>
              ) : (
                releases.map(r => (
                  <div key={r.id} className="border rounded-lg p-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium">Draw #{r.draw_number}</p>
                      <Badge variant="outline" className="text-[10px]">{r.status}</Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[10px]">
                      <div>
                        <span className="text-muted-foreground">Requested: </span>
                        ${r.amount_requested.toLocaleString()}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Released: </span>
                        <span className="text-emerald-400">${(r.amount_released ?? 0).toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Holdback: </span>
                        <span className="text-red-400">${(r.holdback_amount ?? 0).toLocaleString()}</span>
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
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Audit tab */}
        <TabsContent value="audit" className="mt-0 flex-1 overflow-auto">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-2">
              {audit.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No audit events yet.</p>
              ) : (
                audit.map(a => (
                  <div key={a.id} className="border-l-2 border-accent pl-3 py-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[9px]">{a.action.replace(/_/g, " ")}</Badge>
                      {a.amount != null && (
                        <span className="text-[10px] font-medium">${a.amount.toLocaleString()}</span>
                      )}
                    </div>
                    {a.notes && <p className="text-[10px] text-muted-foreground">{a.notes}</p>}
                    <p className="text-[10px] text-muted-foreground">
                      {format(new Date(a.created_at), "MMM d 'at' h:mm a")}
                    </p>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </Card>
  );
}
