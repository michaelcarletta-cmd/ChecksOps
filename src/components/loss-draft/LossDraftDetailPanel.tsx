import { useState, useRef } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Send, Building2, ArrowRightLeft, DollarSign, CheckCircle2,
  Clock, AlertTriangle, Landmark, Upload, FileText, Trash2, Download,
  PackageCheck, Eye, EyeOff,
} from "lucide-react";
import { format } from "date-fns";
import { escrowStatusConfig } from "./LossDraftDashboard";

/* ------------------------------------------------------------------ */
/*  Types (matching DB schema — no `as any`)                           */
/* ------------------------------------------------------------------ */

interface LossDraftRecord {
  id: string;
  claim_id: string;
  mortgage_servicer: string;
  loss_draft_contact: string | null;
  escrow_status: string;
  draw_stage: number;
  draw_amount_requested: number;
  draw_amount_released: number;
  holdback_amount: number;
  total_escrowed: number;
  follow_up_date: string | null;
  follow_up_count: number;
  last_contact_at: string | null;
  check_sent_date: string | null;
  check_received_date: string | null;
  check_received_back_date: string | null;
  monitoring_type: string;
  tracking_number_sent: string | null;
  notes: string | null;
}

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
  file_path: string | null;
  file_name: string | null;
}

interface AuditEntry {
  id: string;
  action: string;
  actor_id: string | null;
  amount: number | null;
  notes: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/*  Actions config                                                     */
/* ------------------------------------------------------------------ */

/* Not Monitored = mortgage endorses & releases check, no escrow/draws */
const NOT_MONITORED_ACTIONS: {
  action: string; label: string; icon: typeof Send; color: string;
  needsAmount?: boolean; needsTracking?: boolean; fromStatuses: string[];
}[] = [
  { action: "mark_sent", label: "Sent Check to Mortgage Company", icon: Send, color: "text-blue-400", needsTracking: true, fromStatuses: ["pending_send"] },
  { action: "mark_received_back", label: "Received Check from Mortgage Company", icon: PackageCheck, color: "text-emerald-400", fromStatuses: ["sent_to_lender", "received_by_lender"] },
];

/* Monitored = mortgage holds funds in escrow, draws required */
const MONITORED_ACTIONS: {
  action: string; label: string; icon: typeof Send; color: string;
  needsAmount?: boolean; needsTracking?: boolean; fromStatuses: string[];
}[] = [
  { action: "mark_sent", label: "Check Sent to Mortgage Company", icon: Send, color: "text-blue-400", needsTracking: true, fromStatuses: ["pending_send"] },
  { action: "mark_escrowed", label: "Mark Escrowed", icon: Building2, color: "text-amber-400", needsAmount: true, fromStatuses: ["sent_to_lender", "received_by_lender", "pending_send"] },
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
  const [actionTracking, setActionTracking] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingDocId, setUploadingDocId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: draft } = useQuery({
    queryKey: ["loss-draft-detail", lossDraftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_tracking")
        .select("*")
        .eq("id", lossDraftId)
        .single();
      if (error) throw error;
      return data as unknown as LossDraftRecord;
    },
  });

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

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["loss-draft-detail", lossDraftId] });
    qc.invalidateQueries({ queryKey: ["loss-draft-releases", lossDraftId] });
    qc.invalidateQueries({ queryKey: ["loss-draft-docs", lossDraftId] });
    qc.invalidateQueries({ queryKey: ["loss-draft-audit", lossDraftId] });
    onUpdate();
  };

  const executeAction = async (action: string) => {
    if (!user?.id || !draft) return;
    setSubmitting(true);
    try {
      const extra: Record<string, string> = {};
      if (actionTracking) extra.tracking_number = actionTracking;
      const { error } = await supabase.rpc("loss_draft_action", {
        p_loss_draft_id: lossDraftId,
        p_action: action,
        p_actor_id: user.id,
        p_amount: actionAmount ? parseFloat(actionAmount) : null,
        p_notes: actionNotes || null,
        p_extra: JSON.stringify(extra),
      });
      if (error) throw error;
      toast({ title: "Action completed", description: `${action.replace(/_/g, " ")} applied successfully.` });
      setPendingAction(null);
      setActionAmount("");
      setActionNotes("");
      setActionTracking("");
      invalidateAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const toggleDoc = async (docId: string, isSubmitted: boolean) => {
    if (!user?.id) return;
    try {
      const { error } = await supabase.rpc("loss_draft_toggle_document", {
        p_doc_id: docId,
        p_is_submitted: isSubmitted,
        p_actor_id: user.id,
      });
      if (error) throw error;
      invalidateAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  const handleFileUpload = async (docId: string, file: File) => {
    if (!user?.id || !draft) return;
    setUploadingDocId(docId);
    try {
      const filePath = `${draft.claim_id}/${lossDraftId}/${docId}/${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("loss-draft-documents")
        .upload(filePath, file, { upsert: true });
      if (uploadError) throw uploadError;

      const { error: updateError } = await supabase
        .from("loss_draft_documents")
        .update({
          file_path: filePath,
          file_name: file.name,
          is_submitted: true,
          submitted_at: new Date().toISOString(),
          submitted_by: user.id,
        })
        .eq("id", docId);
      if (updateError) throw updateError;

      toast({ title: "Document uploaded", description: `${file.name} uploaded successfully.` });
      invalidateAll();
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploadingDocId(null);
    }
  };

  const handleFileDownload = async (doc: DocItem) => {
    if (!doc.file_path) return;
    try {
      const { data, error } = await supabase.storage
        .from("loss-draft-documents")
        .download(doc.file_path);
      if (error) throw error;
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.file_name || "document";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast({ title: "Download failed", description: e.message, variant: "destructive" });
    }
  };

  const handleFileDelete = async (doc: DocItem) => {
    if (!doc.file_path) return;
    try {
      const { error: delError } = await supabase.storage
        .from("loss-draft-documents")
        .remove([doc.file_path]);
      if (delError) throw delError;

      const { error: updateError } = await supabase
        .from("loss_draft_documents")
        .update({ file_path: null, file_name: null })
        .eq("id", doc.id);
      if (updateError) throw updateError;

      toast({ title: "File removed" });
      invalidateAll();
    } catch (e: any) {
      toast({ title: "Delete failed", description: e.message, variant: "destructive" });
    }
  };

  if (!draft) return null;

  const sc = escrowStatusConfig[draft.escrow_status] ?? { label: draft.escrow_status, color: "" };
  const isMonitored = draft.monitoring_type !== "not_monitored";
  const actionButtons = isMonitored ? MONITORED_ACTIONS : NOT_MONITORED_ACTIONS;
  const availableActions = actionButtons.filter(a => a.fromStatuses.includes(draft.escrow_status));
  const fmtMoney = (v: number) => `$${(v ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  const toggleMonitoringType = async () => {
    if (!user?.id) return;
    const newType = isMonitored ? "not_monitored" : "monitored";
    try {
      const { error } = await supabase.rpc("loss_draft_action", {
        p_loss_draft_id: lossDraftId,
        p_action: "set_monitoring_type",
        p_actor_id: user.id,
        p_amount: null,
        p_notes: `Changed to ${newType}`,
        p_extra: JSON.stringify({ monitoring_type: newType }),
      });
      if (error) throw error;
      toast({ title: "Monitoring type updated", description: `Set to ${newType === "monitored" ? "Monitored" : "Not Monitored"}` });
      invalidateAll();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

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
        <div className="text-xs text-muted-foreground">
          Draw #{draft.draw_stage} · Holdback {fmtMoney(draft.holdback_amount)}
        </div>
      </CardHeader>
      <Separator />

      {draft.escrow_status === "final_release_complete" && (
        <div className="mx-4 my-3 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-emerald-500">Return to Deposit Flow Complete</p>
            <p className="text-xs text-emerald-400/80">
              The final release has been recorded and the check has been unblocked. 
              It is now approved for deposit in the main orchestrator.
            </p>
          </div>
        </div>
      )}

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
              {/* Monitoring Type Toggle */}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={isMonitored ? "default" : "outline"}
                  className="flex-1 text-xs"
                  onClick={() => !isMonitored && toggleMonitoringType()}
                >
                  <Eye className="h-3.5 w-3.5 mr-1" /> Monitored
                </Button>
                <Button
                  size="sm"
                  variant={!isMonitored ? "default" : "outline"}
                  className="flex-1 text-xs"
                  onClick={() => isMonitored && toggleMonitoringType()}
                >
                  <EyeOff className="h-3.5 w-3.5 mr-1" /> Not Monitored
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                {isMonitored
                  ? "Mortgage company holds funds in escrow — draws required to release."
                  : "Mortgage company will endorse and release the check — no escrow or draws."}
              </p>

              {/* Tracking info if check was sent */}
              {draft.tracking_number_sent && (
                <div className="bg-accent/30 rounded-lg p-2">
                  <p className="text-[10px] text-muted-foreground">Tracking Number</p>
                  <p className="text-xs font-medium">{draft.tracking_number_sent}</p>
                </div>
              )}

              {/* Money summary - only for monitored */}
              {isMonitored && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-accent/30 rounded-lg p-2">
                    <p className="text-[10px] text-muted-foreground">Total Escrowed</p>
                    <p className="text-sm font-bold">{fmtMoney(draft.total_escrowed)}</p>
                  </div>
                  <div className="bg-accent/30 rounded-lg p-2">
                    <p className="text-[10px] text-muted-foreground">Released</p>
                    <p className="text-sm font-bold text-emerald-400">{fmtMoney(draft.draw_amount_released)}</p>
                  </div>
                  <div className="bg-accent/30 rounded-lg p-2">
                    <p className="text-[10px] text-muted-foreground">Holdback</p>
                    <p className="text-sm font-bold text-red-400">{fmtMoney(draft.holdback_amount)}</p>
                  </div>
                  <div className="bg-accent/30 rounded-lg p-2">
                    <p className="text-[10px] text-muted-foreground">Unreleased</p>
                    <p className="text-sm font-bold text-amber-400">{fmtMoney(draft.total_escrowed - draft.draw_amount_released)}</p>
                  </div>
                </div>
              )}

              <Separator />

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
                        {a.needsTracking && (
                          <div>
                            <Label className="text-xs">Tracking Number</Label>
                            <Input
                              placeholder="Enter shipping tracking #"
                              value={actionTracking} onChange={e => setActionTracking(e.target.value)}
                              className="h-8"
                            />
                          </div>
                        )}
                        {a.needsAmount && (
                          <div>
                            <Label className="text-xs">Amount</Label>
                            <Input
                              type="number" step="0.01" placeholder="0.00"
                              value={actionAmount} onChange={e => setActionAmount(e.target.value)}
                              className="h-8"
                            />
                          </div>
                        )}
                        <div>
                          <Label className="text-xs">Notes</Label>
                          <Textarea rows={2} value={actionNotes} onChange={e => setActionNotes(e.target.value)}
                            placeholder="Optional notes..." className="text-xs" />
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" className="text-xs" disabled={submitting} onClick={() => executeAction(a.action)}>
                            {submitting ? "Saving..." : "Confirm"}
                          </Button>
                          <Button size="sm" variant="ghost" className="text-xs" onClick={() => setPendingAction(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" className="w-full justify-start text-xs"
                        onClick={() => setPendingAction(a.action)}>
                        <a.icon className={`h-3.5 w-3.5 mr-2 ${a.color}`} />{a.label}
                      </Button>
                    )}
                  </div>
                ))}
              </div>

              {draft.follow_up_date && (
                <div className="bg-accent/30 rounded-lg p-2 mt-2">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    Next follow-up: {format(new Date(draft.follow_up_date), "MMM d, yyyy")}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {draft.follow_up_count} contacts · Last:{" "}
                    {draft.last_contact_at ? format(new Date(draft.last_contact_at), "MMM d 'at' h:mm a") : "Never"}
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        </TabsContent>

        {/* Documents tab */}
        <TabsContent value="docs" className="mt-0 flex-1 overflow-auto">
          <ScrollArea className="h-full">
            <div className="p-4 space-y-3">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.xls,.xlsx"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file && uploadingDocId) {
                    handleFileUpload(uploadingDocId, file);
                  }
                  e.target.value = "";
                }}
              />
              {docs.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No document checklist generated yet.</p>
              ) : (
                docs.map(d => (
                  <div key={d.id} className="border rounded-lg p-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Checkbox checked={d.is_submitted} onCheckedChange={(checked) => toggleDoc(d.id, !!checked)} />
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs ${d.is_submitted ? "line-through text-muted-foreground" : ""}`}>{d.document_label}</p>
                        <div className="flex items-center gap-1 mt-0.5">
                          {d.is_required && !d.is_submitted && (
                            <Badge variant="destructive" className="text-[9px] px-1">Required</Badge>
                          )}
                          {d.submitted_at && (
                            <span className="text-[10px] text-muted-foreground">
                              {format(new Date(d.submitted_at), "M/d")}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* File attachment area */}
                    <div className="pl-6">
                      {d.file_path ? (
                        <div className="flex items-center gap-1.5 bg-accent/30 rounded px-2 py-1">
                          <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="text-[10px] truncate flex-1">{d.file_name}</span>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5"
                            onClick={() => handleFileDownload(d)}
                          >
                            <Download className="h-3 w-3" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-5 w-5 text-destructive"
                            onClick={() => handleFileDelete(d)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[10px] gap-1"
                          disabled={uploadingDocId === d.id}
                          onClick={() => {
                            setUploadingDocId(d.id);
                            fileInputRef.current?.click();
                          }}
                        >
                          <Upload className="h-3 w-3" />
                          {uploadingDocId === d.id ? "Uploading..." : "Upload File"}
                        </Button>
                      )}
                    </div>
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
                      <div><span className="text-muted-foreground">Requested: </span>${r.amount_requested.toLocaleString()}</div>
                      <div><span className="text-muted-foreground">Released: </span><span className="text-emerald-400">${(r.amount_released ?? 0).toLocaleString()}</span></div>
                      <div><span className="text-muted-foreground">Holdback: </span><span className="text-red-400">${(r.holdback_amount ?? 0).toLocaleString()}</span></div>
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
                      {a.amount != null && <span className="text-[10px] font-medium">${a.amount.toLocaleString()}</span>}
                    </div>
                    {a.notes && <p className="text-[10px] text-muted-foreground">{a.notes}</p>}
                    <p className="text-[10px] text-muted-foreground">{format(new Date(a.created_at), "MMM d 'at' h:mm a")}</p>
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
