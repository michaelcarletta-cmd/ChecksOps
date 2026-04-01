import { useState, useMemo, useCallback } from "react";

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";
import { FunctionsHttpError, FunctionsRelayError, FunctionsFetchError } from "@supabase/supabase-js";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Upload, FileCheck, Clock, AlertTriangle, CheckCircle2,
  Send, Eye, Users, Building2, Shield, ChevronRight,
  RefreshCw, Banknote, ClipboardCheck, RotateCcw, Printer, Landmark, Trash2, Search,
  Download, FileImage, Undo2,
} from "lucide-react";
import { Pencil, Check as CheckIcon, X, Plus } from "lucide-react";
import { format } from "date-fns";
import { CheckReviewQueue, ReviewDecisionPanel } from "@/components/check-review/CheckReviewConsole";
import { EndorsementChecklist } from "@/components/check-review/EndorsementChecklist";
import { DepositPacketGenerator } from "@/components/check-review/DepositPacketGenerator";
import { CheckDashboardCards } from "@/components/check-review/CheckDashboardCards";
import { LossDraftDashboard } from "@/components/loss-draft/LossDraftDashboard";
import { EndorsementAdjuster } from "@/components/checks/EndorsementAdjuster";
import { DepositImageViewer } from "@/components/checks/DepositImageViewer";
import { EndorsementOverride } from "@/lib/endorsementLayout";
import { LossDraftDetailPanel } from "@/components/loss-draft/LossDraftDetailPanel";
import { DepositOperationsConsole, BranchDepositManifest } from "@/components/deposit-ops/DepositOperationsConsole";
import { ReconciliationDashboard } from "@/components/deposit-ops/ReconciliationDashboard";
import { ExceptionResolutionPanel } from "@/components/deposit-ops/ExceptionResolutionPanel";
import { DepositAgingDashboard } from "@/components/deposit-ops/DepositAgingDashboard";
import { DepositReports } from "@/components/deposit-ops/DepositReports";
import { DepositKPIDashboard, DepositOwnerQueue } from "@/components/deposit-ops/DepositOwnerQueue";
import { DepositManagerCommandCenter } from "@/components/deposit-ops/DepositManagerCommandCenter";
import { ArrowDownToLine, Scale, Timer, FileBarChart, Shield as ShieldIcon, BarChart3, Users as UsersIcon, Command } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CheckPayee {
  id: string;
  check_id: string;
  payee_name: string;
  payee_type: string;
  endorsement_status: string;
  contact_email: string | null;
  contact_phone: string | null;
  notification_sent_via: string | null;
  notification_sent_at: string | null;
  endorsed_at: string | null;
}

interface CheckItem {
  id: string;
  claim_id: string | null;
  front_image_path: string;
  back_image_path: string | null;
  carrier_name: string | null;
  check_number: string | null;
  amount: number | null;
  issue_date: string | null;
  detected_claim_number: string | null;
  payee_line: string | null;
  is_multi_payee: boolean;
  ocr_status: string;
  deposit_recommendation: string | null;
  deposit_recommendation_reasons: string[] | null;
  status: string;
  created_at: string;
  uploaded_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  endorsement_packet_path: string | null;
  endorsement_override: Record<string, unknown> | null;
  check_payees?: CheckPayee[];
}

interface AuditEntry {
  id: string;
  event_type: string;
  event_description: string | null;
  event_data: Record<string, unknown> | null;
  created_at: string;
  actor_id: string | null;
}

interface ClaimOption {
  id: string;
  claim_number: string | null;
  policyholder_name: string | null;
}

/* ------------------------------------------------------------------ */
/*  Config maps                                                        */
/* ------------------------------------------------------------------ */

const statusColors: Record<string, string> = {
  uploaded: "bg-muted text-muted-foreground",
  processing: "bg-blue-500/20 text-blue-400",
  ocr_complete: "bg-blue-500/20 text-blue-400",
  endorsements_in_progress: "bg-amber-500/20 text-amber-400",
  endorsements_complete: "bg-emerald-500/20 text-emerald-300",
  manual_review_required: "bg-orange-500/20 text-orange-400",
  needs_review: "bg-red-500/20 text-red-400",
  approved_for_deposit: "bg-emerald-500/20 text-emerald-400",
  branch_deposit_required: "bg-blue-500/20 text-blue-400",
  loss_draft_required: "bg-purple-500/20 text-purple-400",
  reissue_requested: "bg-orange-500/20 text-orange-400",
  deposited: "bg-primary/20 text-primary",
  voided: "bg-destructive/20 text-destructive",
  ready: "bg-emerald-500/20 text-emerald-400",
};

const recommendationConfig: Record<string, { label: string; icon: typeof CheckCircle2; color: string }> = {
  ready_for_deposit: { label: "Ready for Deposit", icon: CheckCircle2, color: "text-emerald-400" },
  endorsements_pending: { label: "Endorsements Pending", icon: Clock, color: "text-amber-400" },
  manual_review_required: { label: "Manual Review Required", icon: AlertTriangle, color: "text-orange-400" },
  branch_deposit_recommended: { label: "Branch Deposit", icon: Building2, color: "text-blue-400" },
  request_reissue: { label: "Request Reissue", icon: RotateCcw, color: "text-red-400" },
};

const payeeTypeIcons: Record<string, typeof Users> = {
  insured: Users,
  mortgage_company: Building2,
  contractor: Shield,
  public_adjuster: FileCheck,
  unknown: AlertTriangle,
};

const endorsementColors: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  viewed: "bg-blue-500/20 text-blue-400",
  signed: "bg-emerald-500/20 text-emerald-400",
  rejected: "bg-red-500/20 text-red-400",
  expired: "bg-muted text-muted-foreground line-through",
};

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export default function CheckCommandCenter() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("all");
  const [selectedCheck, setSelectedCheck] = useState<string | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [reviewCheckId, setReviewCheckId] = useState<string | null>(null);

  // Admin: allow delete at any stage
  const canDeleteAnyCheck = true;

  const deleteCheckMutation = useMutation({
    mutationFn: async (checkId: string) => {
      // Delete all related records first (order matters for FK constraints)
      const tables = [
        "check_endorsement_events",
        "check_endorsements",
        "check_review_decisions",
        "check_reissue_requests",
        "check_eligibility_results",
        "check_audit_log",
        "check_payees",
      ] as const;

      for (const table of tables) {
        const { error } = await supabase.from(table).delete().eq("check_id", checkId);
        if (error) {
          console.error(`[DELETE] Failed to delete from ${table}:`, error);
          throw new Error(`Failed to clear ${table}: ${error.message}`);
        }
      }

      // Remove any accounting rows and unlink any active loss draft before deleting the check
      const { error: ccErr } = await supabase.from("claim_checks").delete().eq("check_intake_item_id", checkId);
      if (ccErr) console.warn("[DELETE] claim_checks cleanup:", ccErr.message);

      const { error: lossDraftErr } = await supabase
        .from("loss_draft_tracking")
        .update({ check_intake_item_id: null })
        .eq("check_intake_item_id", checkId);
      if (lossDraftErr) {
        console.error("[DELETE] loss_draft_tracking unlink:", lossDraftErr);
        throw new Error(`Failed to unlink loss draft: ${lossDraftErr.message}`);
      }

      const { error } = await supabase.from("check_intake_items").delete().eq("id", checkId);
      if (error) throw new Error(`Failed to delete check: ${error.message}`);
    },
    onSuccess: () => {
      toast({ title: "Check deleted" });
      setSelectedCheck(null);
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["check-dashboard-counts"] });
    },
    onError: (e) => {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    },
  });

  const { data: checks = [], isLoading } = useQuery({
    queryKey: ["check-intake-items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("*, check_payees(*)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CheckItem[];
    },
  });

  const newChecks = checks.filter((c) => c.status === "uploaded" || c.ocr_status === "pending");
  const awaitingEndorsement = checks.filter(
    (c) =>
      c.deposit_recommendation === "endorsements_pending" ||
      c.status === "endorsements_in_progress",
  );
  const readyForDeposit = checks.filter(
    (c) => c.status === "approved_for_deposit" || (c.deposit_recommendation === "ready_for_deposit" && c.status !== "deposited"),
  );
  const needsReview = checks.filter(
    (c) =>
      c.status === "needs_review" ||
      c.status === "manual_review_required" ||
      c.status === "endorsements_complete" ||
      c.deposit_recommendation === "branch_deposit_recommended" ||
      c.ocr_status === "failed",
  );
  const reissueRequested = checks.filter((c) => c.status === "reissue_requested");
  const branchDeposit = checks.filter((c) => c.status === "branch_deposit_required");

  const filteredChecks =
    activeTab === "new" ? newChecks
    : activeTab === "endorsements" ? awaitingEndorsement
    : activeTab === "ready" ? readyForDeposit
    : activeTab === "review" ? needsReview
    : activeTab === "reissue" ? reissueRequested
    : activeTab === "branch" ? branchDeposit
    : checks;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Check Command Center</h1>
          <p className="text-sm text-muted-foreground">
            Insurance check intake, review & deposit readiness
          </p>
        </div>
        <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
          <DialogTrigger asChild>
            <Button><Upload className="h-4 w-4 mr-2" />Upload Check</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Upload Insurance Check</DialogTitle></DialogHeader>
            <CheckUploadForm
              onSuccess={() => {
                setUploadDialogOpen(false);
                qc.invalidateQueries({ queryKey: ["check-intake-items"] });
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Phase 2 Dashboard Cards */}
      <CheckDashboardCards />

      <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); setSelectedCheck(null); setReviewCheckId(null); }}>
        <TabsList className="w-full flex-wrap h-auto gap-1 p-1">
          <TabsTrigger value="all" className="text-xs">All ({checks.length})</TabsTrigger>
          <TabsTrigger value="new" className="text-xs">New ({newChecks.length})</TabsTrigger>
          <TabsTrigger value="endorsements" className="text-xs">Endorsing ({awaitingEndorsement.length})</TabsTrigger>
          <TabsTrigger value="review" className="text-xs flex items-center gap-1">
            <ClipboardCheck className="h-3 w-3" />Review ({needsReview.length})
          </TabsTrigger>
          <TabsTrigger value="ready" className="text-xs">Ready ({readyForDeposit.length})</TabsTrigger>
          <TabsTrigger value="branch" className="text-xs">Branch ({branchDeposit.length})</TabsTrigger>
          <TabsTrigger value="reissue" className="text-xs">Reissue ({reissueRequested.length})</TabsTrigger>
          <TabsTrigger value="deposit_ops" className="text-xs flex items-center gap-1">
            <ArrowDownToLine className="h-3 w-3" />Deposit Ops
          </TabsTrigger>
          <TabsTrigger value="reconciliation" className="text-xs flex items-center gap-1">
            <Scale className="h-3 w-3" />Reconciliation
          </TabsTrigger>
          <TabsTrigger value="exceptions" className="text-xs flex items-center gap-1">
            <ShieldIcon className="h-3 w-3" />Exceptions
          </TabsTrigger>
          <TabsTrigger value="aging" className="text-xs flex items-center gap-1">
            <Timer className="h-3 w-3" />Aging/SLA
          </TabsTrigger>
          <TabsTrigger value="reports" className="text-xs flex items-center gap-1">
            <FileBarChart className="h-3 w-3" />Reports
          </TabsTrigger>
          <TabsTrigger value="lossdraft" className="text-xs flex items-center gap-1">
            <Landmark className="h-3 w-3" />Loss Draft
          </TabsTrigger>
          <TabsTrigger value="kpis" className="text-xs flex items-center gap-1">
            <BarChart3 className="h-3 w-3" />KPIs
          </TabsTrigger>
          <TabsTrigger value="workqueue" className="text-xs flex items-center gap-1">
            <UsersIcon className="h-3 w-3" />Work Queue
          </TabsTrigger>
          <TabsTrigger value="manager" className="text-xs flex items-center gap-1">
            <Command className="h-3 w-3" />Manager
          </TabsTrigger>
        </TabsList>

        {/* Deposit Operations Tab */}
        {activeTab === "deposit_ops" && (
          <div className="mt-3 space-y-4">
            <DepositOperationsConsole />
            <BranchDepositManifest />
          </div>
        )}

        {/* Reconciliation Tab */}
        {activeTab === "reconciliation" && (
          <div className="mt-3">
            <ReconciliationDashboard />
          </div>
        )}

        {/* Exceptions Tab */}
        {activeTab === "exceptions" && (
          <div className="mt-3">
            <ExceptionResolutionPanel />
          </div>
        )}

        {/* Aging/SLA Tab */}
        {activeTab === "aging" && (
          <div className="mt-3">
            <DepositAgingDashboard />
          </div>
        )}

        {/* Reports Tab */}
        {activeTab === "reports" && (
          <div className="mt-3">
            <DepositReports />
          </div>
        )}

        {/* KPIs Tab */}
        {activeTab === "kpis" && (
          <div className="mt-3">
            <DepositKPIDashboard />
          </div>
        )}

        {/* Work Queue Tab */}
        {activeTab === "workqueue" && (
          <div className="mt-3">
            <DepositOwnerQueue />
          </div>
        )}

        {/* Manager Command Center Tab */}
        {activeTab === "manager" && (
          <div className="mt-3">
            <DepositManagerCommandCenter />
          </div>
        )}

        {/* Loss Draft Tab */}
        {activeTab === "lossdraft" && (
          <div className="mt-3">
            <LossDraftDashboard />
          </div>
        )}

        {/* Review Tab — only renders when active */}
        {activeTab === "review" && (
          <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_28rem]">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ClipboardCheck className="h-4 w-4 text-orange-400" />
                  Manual Review Queue
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <CheckReviewQueue
                  onSelectCheck={(id) => setReviewCheckId(id)}
                  selectedCheckId={reviewCheckId}
                />
              </CardContent>
            </Card>

            {reviewCheckId ? (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Review & Decision</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Tabs defaultValue="review">
                    <TabsList className="w-full rounded-none">
                      <TabsTrigger value="review" className="flex-1 text-xs">Review</TabsTrigger>
                      <TabsTrigger value="packet" className="flex-1 text-xs">Deposit Packet</TabsTrigger>
                    </TabsList>
                    <TabsContent value="review" className="mt-0">
                      <ReviewDecisionPanel
                        checkId={reviewCheckId}
                        onComplete={() => {
                          qc.invalidateQueries({ queryKey: ["check-intake-items"] });
                          qc.invalidateQueries({ queryKey: ["check-dashboard-counts"] });
                          setReviewCheckId(null);
                        }}
                      />
                    </TabsContent>
                    <TabsContent value="packet" className="mt-0 p-4">
                      <DepositPacketGenerator checkId={reviewCheckId} />
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            ) : (
              <Card className="flex items-center justify-center h-[calc(100vh-400px)]">
                <div className="text-center text-muted-foreground">
                  <ClipboardCheck className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">Select a check to review</p>
                </div>
              </Card>
            )}
          </div>
        )}

        {/* All other tabs — only render the active one */}
        {activeTab !== "review" && activeTab !== "lossdraft" && activeTab !== "deposit_ops" && activeTab !== "reconciliation" && activeTab !== "exceptions" && activeTab !== "aging" && activeTab !== "reports" && activeTab !== "kpis" && activeTab !== "workqueue" && activeTab !== "manager" && (
          <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_26rem]">
            <Card>
              <CardContent className="p-0">
                <ScrollArea className="h-[calc(100vh-400px)]">
                  {isLoading ? (
                    <div className="p-8 text-center text-muted-foreground">Loading checks...</div>
                  ) : filteredChecks.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">No checks in this category</div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Check</TableHead>
                          <TableHead>Carrier</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Payees</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Deposit</TableHead>
                          <TableHead className="w-10"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredChecks.map((check) => {
                          const rec = check.deposit_recommendation
                            ? recommendationConfig[check.deposit_recommendation]
                            : null;
                          const RecIcon = rec?.icon ?? null;
                          const canDelete = canDeleteAnyCheck;
                          return (
                            <TableRow
                              key={check.id}
                              className={`cursor-pointer transition-colors ${selectedCheck === check.id ? "bg-accent/50" : ""}`}
                              onClick={() => setSelectedCheck(check.id)}
                            >
                              <TableCell className="font-mono text-sm">
                                #{check.check_number || "—"}
                              </TableCell>
                              <TableCell className="text-sm max-w-[120px] truncate">
                                {check.carrier_name || "Pending OCR"}
                              </TableCell>
                              <TableCell className="text-right font-semibold tabular-nums">
                                {check.amount != null
                                  ? `$${check.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                                  : "—"}
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  <span className="text-xs">{check.check_payees?.length ?? 0}</span>
                                  {check.is_multi_payee && (
                                    <Badge variant="outline" className="text-[10px] px-1">Multi</Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge className={`text-[10px] ${statusColors[check.status] ?? ""}`}>
                                  {check.status.replace(/_/g, " ")}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                {RecIcon && (
                                  <RecIcon className={`h-4 w-4 ${rec!.color}`} />
                                )}
                              </TableCell>
                              <TableCell>
                                {canDelete && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (confirm("Delete this check? This cannot be undone.")) {
                                        deleteCheckMutation.mutate(check.id);
                                      }
                                    }}
                                    disabled={deleteCheckMutation.isPending}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
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

            {selectedCheck ? (
              <CheckDetailPanel
                checkId={selectedCheck}
                onRefresh={() => qc.invalidateQueries({ queryKey: ["check-intake-items"] })}
              />
            ) : (
              <Card className="flex items-center justify-center h-[calc(100vh-400px)]">
                <div className="text-center text-muted-foreground">
                  <Banknote className="h-12 w-12 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">Select a check to view details</p>
                </div>
              </Card>
            )}
          </div>
        )}
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Summary card (kept for Phase 1 compat)                             */
/* ------------------------------------------------------------------ */

function SummaryCard({
  label,
  count,
  icon: Icon,
  color,
}: {
  label: string;
  count: number;
  icon: typeof Upload;
  color: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`p-2 rounded-lg bg-accent/50 ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-2xl font-bold">{count}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Upload form                                                        */
/* ------------------------------------------------------------------ */

function CheckUploadForm({ onSuccess }: { onSuccess: () => void }) {
  const { toast } = useToast();
  const [frontFile, setFrontFile] = useState<File | null>(null);
  const [backFile, setBackFile] = useState<File | null>(null);
  const [claimId, setClaimId] = useState<string>("");
  const [claimSearch, setClaimSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [claimDropdownOpen, setClaimDropdownOpen] = useState(false);

  const { data: claims = [] } = useQuery({
    queryKey: ["claims-for-check-link", claimSearch],
    queryFn: async () => {
      let q = supabase
        .from("claims")
        .select("id, claim_number, policyholder_name")
        .order("created_at", { ascending: false })
        .limit(50);
      if (claimSearch.trim()) {
        q = q.or(`claim_number.ilike.%${claimSearch.trim()}%,policyholder_name.ilike.%${claimSearch.trim()}%`);
      }
      const { data } = await q;
      return (data ?? []) as ClaimOption[];
    },
  });

  const selectedClaim = useMemo(
    () => claims.find((c) => c.id === claimId) ?? null,
    [claims, claimId],
  );

  const handleUpload = async () => {
    if (!frontFile) {
      toast({ title: "Front image required", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Store clean originals — VOID watermark is rendered as CSS overlay in UI
      const ts = Date.now();
      const claimDir = claimId || "unclaimed";
      const prefix = `checks/${user.id}/${claimDir}`;
      const frontPath = `${prefix}/${ts}_front_${frontFile.name}`;

      const { error: fErr } = await supabase.storage
        .from("claim-files")
        .upload(frontPath, frontFile);
      if (fErr) throw new Error(`Front upload failed: ${fErr.message}`);

      let backPath: string | null = null;
      if (backFile) {
        backPath = `${prefix}/${ts}_back_${backFile.name}`;
        const { error: bErr } = await supabase.storage
          .from("claim-files")
          .upload(backPath, backFile);
        if (bErr) throw new Error(`Back upload failed: ${bErr.message}`);
      }

      const { data: check, error: insErr } = await supabase
        .from("check_intake_items")
        .insert({
          front_image_path: frontPath,
          back_image_path: backPath,
          claim_id: claimId || null,
          uploaded_by: user.id,
        })
        .select()
        .single();

      if (insErr || !check) throw new Error(insErr?.message ?? "Insert failed");

      const { data: session } = await supabase.auth.getSession();
      const { error: fnErr } = await supabase.functions.invoke("check-ocr-intake", {
        body: { checkId: check.id },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });

      if (fnErr) {
        console.error("OCR invoke error:", fnErr);
        toast({ title: "Check uploaded but OCR may have failed", description: fnErr.message });
      } else {
        toast({ title: "Check uploaded & OCR started" });
      }
      onSuccess();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Label>Front of Check *</Label>
        <Input type="file" accept="image/*" onChange={(e) => setFrontFile(e.target.files?.[0] ?? null)} />
      </div>
      <div>
        <Label>Back of Check</Label>
        <Input type="file" accept="image/*" onChange={(e) => setBackFile(e.target.files?.[0] ?? null)} />
      </div>
      <div>
        <Label>Link to Claim (optional)</Label>
        <div className="relative">
          <div className="flex items-center border rounded-md bg-background">
            <Search className="h-4 w-4 ml-2 text-muted-foreground shrink-0" />
            <Input
              placeholder="Search by claim # or policyholder name..."
              value={claimDropdownOpen ? claimSearch : (selectedClaim ? `${selectedClaim.claim_number ?? "—"} — ${selectedClaim.policyholder_name ?? "Unknown"}` : claimSearch)}
              onChange={(e) => {
                setClaimSearch(e.target.value);
                setClaimDropdownOpen(true);
                if (!e.target.value) setClaimId("");
              }}
              onFocus={() => setClaimDropdownOpen(true)}
              onBlur={() => setTimeout(() => setClaimDropdownOpen(false), 200)}
              className="border-0 focus-visible:ring-0 shadow-none"
            />
            {claimId && (
              <Button variant="ghost" size="icon" className="h-7 w-7 mr-1 shrink-0" onClick={() => { setClaimId(""); setClaimSearch(""); }}>
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
          {claimDropdownOpen && claims.length > 0 && (
            <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md">
              {claims.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors cursor-pointer"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setClaimId(c.id);
                    setClaimSearch("");
                    setClaimDropdownOpen(false);
                  }}
                >
                  <span className="font-mono">{c.claim_number ?? "—"}</span>
                  <span className="text-muted-foreground"> — {c.policyholder_name ?? "Unknown"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <Button onClick={handleUpload} disabled={uploading || !frontFile} className="w-full">
        {uploading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
        {uploading ? "Processing..." : "Upload & Analyze"}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Re-run OCR button                                                   */
/* ------------------------------------------------------------------ */

function RerunOcrButton({ checkId, onSuccess }: { checkId: string; onSuccess: () => void }) {
  const [running, setRunning] = useState(false);
  const { toast } = useToast();

  const handleRerun = async () => {
    setRunning(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const { error } = await supabase.functions.invoke("check-ocr-intake", {
        body: { checkId },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });
      if (error) throw new Error(error.message);
      toast({ title: "OCR re-run complete" });
      onSuccess();
    } catch (e: unknown) {
      toast({ title: "OCR re-run failed", description: e instanceof Error ? e.message : "Unknown error", variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Button variant="outline" size="sm" className="w-full text-xs h-7" onClick={handleRerun} disabled={running}>
      <RefreshCw className={`h-3 w-3 mr-1 ${running ? "animate-spin" : ""}`} />
      {running ? "Re-analyzing..." : "Re-run OCR"}
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/*  Detail panel                                                       */
/* ------------------------------------------------------------------ */

function CheckDetailPanel({
  checkId,
  onRefresh,
}: {
  checkId: string;
  onRefresh: () => void;
}) {
  const [detailTab, setDetailTab] = useState("overview");
  const [undoing, setUndoing] = useState(false);
  const [reuploadingBack, setReuploadingBack] = useState(false);
  const [preparingDepositPrint, setPreparingDepositPrint] = useState(false);
  const [showEndorsementAdjuster, setShowEndorsementAdjuster] = useState(false);
  const [depositViewerOpen, setDepositViewerOpen] = useState(false);
  const [depositViewerUrl, setDepositViewerUrl] = useState<string | null>(null);
  const [openingDepositView, setOpeningDepositView] = useState(false);
  const [frontImageDimensions, setFrontImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [backImageDimensions, setBackImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

   const { data: check } = useQuery({
    queryKey: ["check-detail", checkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("*, check_payees(*)")
        .eq("id", checkId)
        .single();
      if (error) throw error;
      return data as CheckItem;
    },
  });

  const { data: frontImageUrl } = useQuery({
    queryKey: ["check-front-img", check?.front_image_path],
    enabled: !!check?.front_image_path,
    queryFn: async () => {
      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(check!.front_image_path, 3600);
      return data?.signedUrl ?? null;
    },
  });

  const { data: backImageUrl } = useQuery({
    queryKey: ["check-back-img", check?.back_image_path],
    enabled: !!check?.back_image_path,
    queryFn: async () => {
      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(check!.back_image_path!, 3600);
      return data?.signedUrl ?? null;
    },
  });

   // Fetch reviewer profile for name display
  const { data: reviewerProfile } = useQuery({
    queryKey: ["reviewer-profile", check?.reviewed_by],
    enabled: !!check?.reviewed_by,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("full_name, email")
        .eq("id", check!.reviewed_by!)
        .single();
      return data;
    },
  });

  const { data: auditLog = [] } = useQuery({
    queryKey: ["check-audit", checkId],
    queryFn: async () => {
      const { data } = await supabase
        .from("check_audit_log")
        .select("*")
        .eq("check_id", checkId)
        .order("created_at", { ascending: false });
      return (data ?? []) as AuditEntry[];
    },
  });

  // Fetch endorsements for blocking banner (moved above early return to fix hooks order)
  const { data: endorsements = [] } = useQuery({
    queryKey: ["check-endorsements-summary", checkId],
    queryFn: async () => {
      const { data } = await supabase
        .from("check_endorsements")
        .select("id, payee_name, payee_type, status, signature_image_url, signature_method, signed_at")
        .eq("check_id", checkId);
      return data ?? [];
    },
  });

  // Fetch linked accounting entry
  const { data: accountingEntry } = useQuery({
    queryKey: ["check-accounting-link", checkId],
    queryFn: async () => {
      const { data } = await supabase
        .from("claim_checks")
        .select("id, deposit_status, eligibility_status, mortgage_flag, source")
        .eq("check_intake_item_id", checkId)
        .maybeSingle();
      return data;
    },
  });

  // Fetch loss draft tracking record if required
  const { data: lossDraftRecord } = useQuery({
    queryKey: ["check-loss-draft-link", checkId],
    enabled: !!check && (check.status === "loss_draft_required" || check.status === "needs_review"),
    queryFn: async () => {
      const { data } = await supabase
        .from("loss_draft_tracking")
        .select("id")
        .eq("check_intake_item_id", checkId)
        .maybeSingle();
      return data;
    },
  });

  const loadImageDimensions = useCallback((url: string) => {
    return new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error(`Failed to load image dimensions for ${url}`));
      img.src = url;
    });
  }, []);

  const escPrint = useCallback((value: unknown) => {
    if (value == null) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }, []);

  const canUndo = check && ['branch_deposit_required', 'approved_for_deposit', 'loss_draft_required', 'reissue_requested'].includes(check.status) && check.status !== 'deposited';

  const handleUndoDecision = async () => {
    if (!user?.id || !check) return;
    setUndoing(true);
    try {
      const { data, error } = await supabase.rpc("submit_check_review_decision", {
        p_check_id: checkId,
        p_reviewer_id: user.id,
        p_deposit_path: "revert_to_review",
        p_reviewer_notes: `Reverted from ${check.status} back to review`,
      });
      if (error) throw error;
      toast({ title: "Decision reverted", description: "Check returned to review queue." });
      qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-audit", checkId] });
      onRefresh();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setUndoing(false);
    }
  };

  const ensureDepositReadyBackImage = async () => {
    if (!check?.id || !check.back_image_path) return backImageUrl ?? null;

    setPreparingDepositPrint(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const { data, error } = await supabase.functions.invoke("composite-endorsement-signatures", {
        body: { checkId: check.id },
        headers: session.session?.access_token
          ? { Authorization: `Bearer ${session.session.access_token}` }
          : undefined,
      });

      if (error) {
        console.error("[CHECK-EXPORT] Edge function error:", error);

        // Parse structured error from FunctionsHttpError
        if (error instanceof FunctionsHttpError) {
          let body: any = null;
          try {
            body = await error.context.json();
          } catch {
            try { body = await error.context.text(); } catch { body = null; }
          }
          const e = new Error(body?.error || "Edge function returned non-2xx response.");
          (e as any).context = { body };
          throw e;
        }
        if (error instanceof FunctionsRelayError) {
          const e = new Error("Relay error while generating deposit image.");
          (e as any).context = { body: { code: "FUNCTIONS_RELAY_ERROR" } };
          throw e;
        }
        if (error instanceof FunctionsFetchError) {
          const e = new Error("Network error while calling deposit image function.");
          (e as any).context = { body: { code: "FUNCTIONS_FETCH_ERROR" } };
          throw e;
        }
        throw error;
      }

      const payload = (data ?? {}) as {
        success?: boolean;
        error?: string;
        code?: string;
        details?: Record<string, unknown>;
        skipped?: boolean;
        reason?: string;
        composited_path?: string;
        composited_back_path?: string;
        original_back_image_path?: string;
        endorsed_back_image_path?: string;
        output_format?: string;
        db_path_update_committed?: boolean;
      };
      if (payload.success === false) {
        const e = new Error(payload.error ?? "Final deposit image could not be generated");
        (e as any).context = { body: payload };
        throw e;
      }

      let compositedPath =
        payload.endorsed_back_image_path ??
        payload.composited_path ??
        payload.composited_back_path ??
        null;

      let originalPath = payload.original_back_image_path ?? check.back_image_path ?? null;
      let renderMode = payload.output_format ?? null;
      let dbPathUpdateCommitted = payload.db_path_update_committed ?? null;

      if (!compositedPath || !originalPath || !renderMode) {
        const { data: latestCompositeAudit } = await supabase
          .from("check_audit_log")
          .select("event_data")
          .eq("check_id", check.id)
          .eq("event_type", "endorsement_signatures_composited")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const auditData = (latestCompositeAudit?.event_data ?? null) as {
          original_back_image_path?: string;
          original_back_path?: string;
          endorsed_back_image_path?: string;
          composited_path?: string;
          composited_back_path?: string;
          output_format?: string;
          db_path_update_committed?: boolean;
        } | null;

        originalPath =
          originalPath ??
          auditData?.original_back_image_path ??
          auditData?.original_back_path ??
          null;

        compositedPath =
          compositedPath ??
          auditData?.endorsed_back_image_path ??
          auditData?.composited_path ??
          auditData?.composited_back_path ??
          null;

        renderMode = renderMode ?? auditData?.output_format ?? null;
        dbPathUpdateCommitted = dbPathUpdateCommitted ?? auditData?.db_path_update_committed ?? null;
      }

      if (!compositedPath) {
        throw new Error("Endorsement composite was not produced for this check");
      }

      console.log("[CHECK-EXPORT] original image path:", originalPath);
      console.log("[CHECK-EXPORT] generated output path:", compositedPath);
      console.log("[CHECK-EXPORT] rasterized vs svg-fallback mode:", renderMode);
      console.log("[CHECK-EXPORT] DB path update committed:", dbPathUpdateCommitted);

      const { data: signedData, error: signedErr } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(compositedPath, 3600);

      if (signedErr) throw signedErr;

      qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-audit", checkId] });
      qc.invalidateQueries({ queryKey: ["check-back-img"] });
      onRefresh();

      return signedData?.signedUrl ?? null;
    } catch (e: any) {
      toast({
        title: "Could not generate final deposit image",
        description: e?.message ?? "Final deposit image could not be generated",
        variant: "destructive",
      });
      return null;
    } finally {
      setPreparingDepositPrint(false);
    }
  };

  if (!check) return null;

  const rec = check.deposit_recommendation
    ? recommendationConfig[check.deposit_recommendation]
    : null;

  const pendingEndorsements = endorsements.filter(
    (e) => e.status === "pending" || e.status === "sent",
  );
  const rejectedEndorsements = endorsements.filter((e) => e.status === "rejected");
  const mortgageEndorsements = endorsements.filter(
    (e) => e.payee_type === "mortgage_company" && e.status === "manual_required",
  );
  const allEndorsementsComplete = endorsements.length > 0 && endorsements.every(
    (e) => e.status === "signed" || e.status === "waived" ||
      (e.payee_type === "mortgage_company" && e.status === "manual_required"),
  );

  // Build blocking reasons
  const blockingReasons: string[] = [];
  if (pendingEndorsements.length > 0) {
    blockingReasons.push(
      `${pendingEndorsements.length} unsigned endorsement(s): ${pendingEndorsements.map((e) => e.payee_name).join(", ")}`,
    );
  }
  if (rejectedEndorsements.length > 0) {
    blockingReasons.push(
      `${rejectedEndorsements.length} rejected endorsement(s): ${rejectedEndorsements.map((e) => e.payee_name).join(", ")} — requires resolution`,
    );
  }
  if (check.status === "loss_draft_required") {
    blockingReasons.push("Check is in Loss Draft workflow. Deposit is blocked until final release.");
  } else if (mortgageEndorsements.length > 0) {
    blockingReasons.push(
      `${mortgageEndorsements.length} mortgage payee(s) routed to loss draft workflow`,
    );
  }
  const isDepositBlocked = (endorsements.length > 0 && !allEndorsementsComplete) || check.status === "loss_draft_required";

  // Only include true captured signatures (exclude "marked signed" internal acknowledgements)
  const endorsementRows = endorsements.filter(
    (e) =>
      e.status === "signed" &&
      typeof e.signature_image_url === "string" &&
      e.signature_image_url.trim().length > 0 &&
      (e.signature_method ?? "").toLowerCase() !== "internal",
  );
  const endorsementText = endorsementRows.length > 0
    ? "Pay to the Order of\nFreedom Adjustment\nFor Mobile Deposit Only\nFreedom Adjustment"
    : "";
  const signatures = endorsementRows
    .map((e) => e.signature_image_url)
    .filter((signature): signature is string => Boolean(signature));

  const hasEndorsement =
    !!endorsementText ||
    (Array.isArray(signatures) && signatures.length > 0);

  const isFinalDepositImage =
    check.status === "approved_for_deposit" ||
    check.status === "deposit_ready" ||
    check.status === "endorsements_complete";

  const showWatermark = !isFinalDepositImage;
  // Proportional overlay coordinates — use saved override if available
  const savedOverride = (check?.endorsement_override as unknown as EndorsementOverride | null) ?? null;
  const overlayCoordinates = {
    topPercent: (savedOverride?.yPct ?? 0.5) * 100,
    leftPercent: (savedOverride?.xPct ?? 0.38) * 100,
    widthPercent: 22 * (savedOverride?.scale ?? 1),
  };
  const endorsementStyle = {
    position: "absolute" as const,
    top: `${overlayCoordinates.topPercent}%`,
    left: `${overlayCoordinates.leftPercent}%`,
    width: `${overlayCoordinates.widthPercent}%`,
    zIndex: 20,
    color: "#111111",
    pointerEvents: "none" as const,
    transform: savedOverride?.rotationDeg ? `rotate(${savedOverride.rotationDeg}deg)` : undefined,
    transformOrigin: "top left" as const,
  };

  console.log("[CHECK-RENDER] check.status:", check.status);
  console.log("[CHECK-RENDER] endorsementData:", endorsementRows);
  console.log("[CHECK-RENDER] hasEndorsement:", hasEndorsement);
  console.log("[CHECK-RENDER] showWatermark:", showWatermark);
  console.log("[CHECK-RENDER] endorsementText:", endorsementText);
  console.log("[CHECK-RENDER] signatures:", signatures);
  console.log("[CHECK-RENDER] overlay coordinates:", overlayCoordinates);
  console.log("[CHECK-RENDER] image width/height:", {
    width: backImageDimensions?.width ?? null,
    height: backImageDimensions?.height ?? null,
  });
  console.log("[CHECK-RENDER] final export mode:", isFinalDepositImage ? "deposit-ready" : "preview");

  return (
    <>
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Check #{check.check_number ?? "Pending"}</CardTitle>
          <Badge className={statusColors[check.status] ?? ""}>
            {check.status.replace(/_/g, " ")}
          </Badge>
        </div>
        {check.carrier_name && (
          <p className="text-sm text-muted-foreground">{check.carrier_name}</p>
        )}
        {check.amount != null && (
          <EditableAmount checkId={checkId} currentAmount={check.amount} onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }} />
        )}
        {check.amount == null && (
          <EditableAmount checkId={checkId} currentAmount={null} onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }} />
        )}

        {/* Single Source of Truth Blocking Banner */}
        {isDepositBlocked && (
          <div className="mt-2 border border-amber-500/30 bg-amber-500/10 rounded-lg p-3 space-y-1.5">
            <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Deposit Blocked
            </div>
            {blockingReasons.map((reason, i) => (
              <p key={i} className="text-xs text-amber-300/80 pl-6">• {reason}</p>
            ))}
          </div>
        )}

        {/* Loss Draft Banner & Action */}
        {check.status === "loss_draft_required" && lossDraftRecord?.id && (
          <div className="mt-2 border border-blue-500/30 bg-blue-500/10 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-blue-500 font-semibold text-sm">
                <Landmark className="h-4 w-4 shrink-0" />
                Loss Draft Active
              </div>
              <p className="text-xs text-blue-400/80">
                This check is being processed by the mortgage servicer. Deposit is blocked until the final release is completed.
              </p>
            </div>
            <Dialog>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline" className="shrink-0 bg-blue-500/20 text-blue-400 border-blue-500/30 hover:bg-blue-500/30 hover:text-blue-300">
                  <Landmark className="h-4 w-4 mr-2" />
                  View Loss Draft
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-4xl max-h-[85vh] p-0 overflow-hidden border-border bg-card">
                <div className="p-4 bg-muted/30 border-b flex items-center justify-between">
                  <DialogTitle className="text-lg flex items-center gap-2">
                    <Landmark className="h-5 w-5 text-amber-400" />
                    Loss Draft Tracking
                  </DialogTitle>
                </div>
                <div className="p-0 bg-card">
                  <LossDraftDetailPanel 
                    lossDraftId={lossDraftRecord.id} 
                    onUpdate={() => onRefresh()} 
                  />
                </div>
              </DialogContent>
            </Dialog>
          </div>
        )}

        {/* Accounting Link */}
        {accountingEntry && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded px-2.5 py-1.5">
            <FileCheck className="h-3 w-3 shrink-0 text-primary" />
            <span>Accounting entry auto-posted</span>
            <Badge variant="outline" className="text-[9px] px-1 ml-auto">
              {accountingEntry.source === "uploaded_check_ocr" ? "OCR" : "Manual"}
            </Badge>
            {accountingEntry.mortgage_flag && (
              <Badge className="bg-blue-500/20 text-blue-400 text-[9px] px-1">Mortgage</Badge>
            )}
          </div>
        )}

        {/* Endorsement Packet */}
        {check.endorsement_packet_path && (
          <EndorsementPacketCard checkId={checkId} packetPath={check.endorsement_packet_path} />
        )}
      </CardHeader>
      <CardContent className="p-0">
        <Tabs value={detailTab} onValueChange={setDetailTab}>
          <TabsList className="w-full rounded-none">
            <TabsTrigger value="overview" className="flex-1 text-xs">Overview</TabsTrigger>
            <TabsTrigger value="endorsements" className="flex-1 text-xs">
              Endorsements
              {pendingEndorsements.length > 0 && (
                <span className="ml-1 bg-amber-500/30 text-amber-400 rounded-full text-[9px] px-1.5">
                  {pendingEndorsements.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="payees" className="flex-1 text-xs">
              Payees ({check.check_payees?.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="eligibility" className="flex-1 text-xs">Eligibility</TabsTrigger>
            <TabsTrigger value="audit" className="flex-1 text-xs">Audit</TabsTrigger>
          </TabsList>

          <ScrollArea className="h-[calc(100vh-520px)]">
            <TabsContent value="overview" className="p-4 space-y-3 mt-0">
              <DetailRow label="Check #" value={check.check_number} />
              <DetailRow label="Carrier" value={check.carrier_name} />
              <DetailRow
                label="Issue Date"
                value={check.issue_date ? format(new Date(check.issue_date), "MMM d, yyyy") : null}
              />
              <DetailRow label="Detected Claim #" value={check.detected_claim_number} />
              <DetailRow label="Payee Line" value={check.payee_line} />
              <DetailRow label="Multi-Payee" value={check.is_multi_payee ? "Yes" : "No"} />
              <DetailRow label="OCR Status" value={check.ocr_status} />
              <RerunOcrButton checkId={checkId} onSuccess={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }} />
              <Separator />
              {/* Check Images */}
              {(frontImageUrl || backImageUrl) && (
                <div className="space-y-2">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium flex items-center gap-1">
                    <FileImage className="h-3 w-3" /> Check Images
                  </p>
                  {frontImageUrl && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] text-muted-foreground">Front</p>
                        <a href={frontImageUrl} download={`check-${check.check_number ?? check.id}-front`} target="_blank" rel="noopener noreferrer">
                          <Button variant="ghost" size="icon" className="h-5 w-5"><Download className="h-3 w-3" /></Button>
                        </a>
                      </div>
                      <div className="relative overflow-hidden rounded border border-border">
                        <img
                          src={frontImageUrl}
                          alt="Check front"
                          className="w-full object-contain"
                          onLoad={(event) => {
                            setFrontImageDimensions({
                              width: event.currentTarget.naturalWidth,
                              height: event.currentTarget.naturalHeight,
                            });
                          }}
                        />
                        {showWatermark && (
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none" style={{ transform: "rotate(-30deg)" }}>
                            <div className="grid grid-cols-2 gap-x-8 gap-y-6 opacity-[0.07]">
                              {Array.from({ length: 4 }).map((_, i) => (
                                <span key={i} className="text-destructive font-bold text-3xl tracking-widest">VOID</span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {backImageUrl && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] text-muted-foreground">Back</p>
                        <a href={backImageUrl} download={`check-${check.check_number ?? check.id}-back`} target="_blank" rel="noopener noreferrer">
                          <Button variant="ghost" size="icon" className="h-5 w-5"><Download className="h-3 w-3" /></Button>
                        </a>
                      </div>
                      <div className="check-back-wrap relative inline-block max-w-full rounded border border-border" style={{ overflow: "visible", containerType: "inline-size" as any }}>
                        <img
                          src={backImageUrl}
                          alt="Check back"
                          className="check-back-image block w-full"
                          style={{ objectFit: "contain", height: "auto" }}
                          onLoad={(event) => {
                            setBackImageDimensions({
                              width: event.currentTarget.naturalWidth,
                              height: event.currentTarget.naturalHeight,
                            });
                          }}
                        />

                        {hasEndorsement && backImageDimensions && (() => {
                          // Scale all sizes from image height so endorsement looks like a real check
                          const ovScale = savedOverride?.scale ?? 1;
                          const ar = backImageDimensions.height / backImageDimensions.width;
                          // Font sizes as % of container width (since height = width * ar)
                          // naturalHeight * ratio → cw-based: (ratio * ar * 100)cqw
                          const f = (ratio: number) => `${(ratio * ovScale * ar * 100).toFixed(3)}cqw`;
                          const g = (ratio: number) => `${(ratio * ovScale * ar * 100).toFixed(3)}cqw`; // gap
                          return (
                            <div className="endorsement-overlay absolute select-none" style={endorsementStyle}>
                              <div className="leading-tight font-semibold" style={{ lineHeight: 1.15 }}>
                                {/* Header */}
                                <p style={{ fontSize: f(0.022), marginBottom: g(0.008), color: "#111111", fontWeight: 600 }}>Pay to the order of</p>
                                {/* Company payee */}
                                <p style={{ fontSize: f(0.034), marginBottom: g(0.008), color: "#111111", fontWeight: 700 }}>Freedom Adjustment</p>
                                {/* Mobile deposit */}
                                <p style={{ fontSize: f(0.024), marginBottom: g(0.014), color: "#111111", fontWeight: 700 }}>For Mobile Deposit Only</p>

                                {/* Separator before signatures */}
                                <div style={{ marginTop: g(0.006), marginBottom: g(0.006), borderTop: "1px solid #111111", opacity: 0.3 }} />

                                {/* Client signatures first (non-Freedom, non-Carletta) */}
                                {endorsementRows.map((e) => {
                                  const nameLC = e.payee_name.toLowerCase();
                                  if (nameLC.includes("freedom") || nameLC.includes("carletta")) return null;
                                  return (
                                    <div key={e.id} style={{ marginTop: g(0.008) }}>
                                      {e.signature_image_url?.startsWith("typed:") ? (
                                        <p style={{ fontSize: f(0.042), fontStyle: "italic", fontFamily: '"Brush Script MT", cursive', color: "#111111" }}>{e.signature_image_url.slice(6)}</p>
                                      ) : e.signature_image_url ? (
                                        <>
                                          <p style={{ fontSize: f(0.026), fontWeight: 500, color: "#111111" }}>{e.payee_name}</p>
                                          <img src={e.signature_image_url} alt={`${e.payee_name} signature`} style={{ height: f(0.060), margin: "0 auto", display: "block", objectFit: "contain", filter: "brightness(0)" }} />
                                        </>
                                      ) : (
                                        null
                                      )}
                                    </div>
                                  );
                                })}

                                {/* Freedom Adjustment / By: Michael Carletta — only if a portal-captured signature exists */}
                                {endorsementRows.some((e) => {
                                  const n = e.payee_name.toLowerCase();
                                  return (n.includes("freedom") || n.includes("carletta")) && e.signature_image_url;
                                }) && (
                                <div style={{ marginTop: g(0.014) }}>
                                  <p style={{ fontSize: f(0.034), fontWeight: 700, color: "#111111" }}>Freedom Adjustment</p>
                                  <p style={{ fontSize: f(0.026), fontWeight: 600, color: "#111111" }}>By: Michael Carletta</p>
                                  {endorsementRows.filter((e) => {
                                    const n = e.payee_name.toLowerCase();
                                    return (n.includes("freedom") || n.includes("carletta")) && e.signature_image_url;
                                  }).slice(0, 1).map((e) => (
                                    <div key={`sig-${e.id}`} style={{ marginTop: g(0.004) }}>
                                      {e.signature_image_url?.startsWith("typed:") ? (
                                        <p style={{ fontSize: f(0.042), fontStyle: "italic", fontFamily: '"Brush Script MT", cursive', color: "#111111" }}>{e.signature_image_url.slice(6)}</p>
                                      ) : e.signature_image_url ? (
                                        <img src={e.signature_image_url} alt="Carletta signature" style={{ height: f(0.060), margin: "0 auto", display: "block", objectFit: "contain", filter: "brightness(0)" }} />
                                      ) : null}
                                    </div>
                                  ))}
                                </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {showWatermark && (
                          <div className="void-watermark absolute inset-0 flex items-center justify-center pointer-events-none select-none" style={{ transform: "rotate(-30deg)", zIndex: 30 }}>
                            <div className="grid grid-cols-2 gap-x-8 gap-y-6 opacity-[0.07]">
                              {Array.from({ length: 4 }).map((_, i) => (
                                <span key={i} className="text-destructive font-bold text-3xl tracking-widest">VOID</span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {/* Open for Mobile Deposit — only visible when all endorsements complete */}
                  {allEndorsementsComplete && !isDepositBlocked && (
                    <Button
                      size="sm"
                      className="w-full mt-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                      disabled={openingDepositView}
                      onClick={async () => {
                        setOpeningDepositView(true);
                        try {
                          const finalUrl = await ensureDepositReadyBackImage();
                          if (finalUrl) {
                            setDepositViewerUrl(finalUrl);
                            setDepositViewerOpen(true);
                          } else {
                            toast({
                              title: "No deposit image",
                              description: "Could not generate or find the final endorsed back image.",
                              variant: "destructive",
                            });
                          }
                        } catch (err: any) {
                          console.error("[OPEN-DEPOSIT-VIEW]", err);
                          toast({
                            title: "Deposit image failed",
                            description: err?.message ?? "An error occurred generating the deposit image.",
                            variant: "destructive",
                          });
                        } finally {
                          setOpeningDepositView(false);
                        }
                      }}
                    >
                      <FileImage className="h-4 w-4 mr-2" />
                      {openingDepositView ? "Preparing..." : "Open for Mobile Deposit"}
                    </Button>
                  )}
                </div>
              )}
              <Separator />
              {check.reviewed_by && (
                <>
                  <Separator />
                  <div className="bg-muted/30 rounded-md p-2.5 space-y-1">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">Reviewed By</p>
                    <p className="text-sm font-medium">{reviewerProfile?.full_name || reviewerProfile?.email || check.reviewed_by.slice(0, 8) + "..."}</p>
                    {check.reviewed_at && (
                      <p className="text-xs text-muted-foreground">{format(new Date(check.reviewed_at), "MMM d, yyyy h:mm a")}</p>
                    )}
                    {check.review_notes && (
                      <p className="text-xs text-muted-foreground mt-1 italic">"{check.review_notes}"</p>
                    )}
                  </div>
                </>
               )}
              {canUndo && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full mt-2 text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                  onClick={handleUndoDecision}
                  disabled={undoing}
                >
                  <Undo2 className="h-4 w-4 mr-2" />
                  {undoing ? "Reverting..." : `Undo Decision (${check.status.replace(/_/g, " ")})`}
                </Button>
              )}
              {check.claim_id && (
                <DetailRow label="Linked Claim" value={check.claim_id.slice(0, 8) + "..."} />
              )}
            </TabsContent>

            <TabsContent value="endorsements" className="p-4 mt-0 space-y-4">
              <EndorsementChecklist
                checkId={checkId}
                onRefresh={onRefresh}
              />

              {backImageUrl && backImageDimensions && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setShowEndorsementAdjuster((v) => !v)}
                  >
                    {showEndorsementAdjuster ? "Hide" : "Adjust"} Endorsement Position
                  </Button>

                  {showEndorsementAdjuster && (
                    <EndorsementAdjuster
                      checkId={checkId}
                      imageUrl={backImageUrl}
                      imageWidth={backImageDimensions.width}
                      imageHeight={backImageDimensions.height}
                      ownerName="Michael Carletta"
                      companyName="Freedom Adjustment"
                      initialOverride={
                        (check?.endorsement_override as unknown as EndorsementOverride | null) ?? null
                      }
                      onSave={async (ov) => {
                        console.log("[print-for-deposit] using override", ov);
                        // 1) Save override to DB first
                        const { error: saveErr } = await supabase
                          .from("check_intake_items")
                          .update({
                            endorsement_override: ov as any,
                            updated_at: new Date().toISOString(),
                          })
                          .eq("id", checkId);
                        if (saveErr) throw saveErr;
                        // 2) Then generate final deposit image
                        await ensureDepositReadyBackImage();
                        toast({ title: "Endorsement saved & deposit image generated" });
                        setShowEndorsementAdjuster(false);
                        qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
                      }}
                    />
                  )}
                </>
              )}
            </TabsContent>

            <TabsContent value="payees" className="p-4 space-y-3 mt-0">
              <PayeeManager checkId={checkId} payees={check.check_payees ?? []} onRefresh={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }} />
            </TabsContent>

            <TabsContent value="eligibility" className="p-4 space-y-3 mt-0">
              {rec ? (
                <>
                  <div className="flex items-center gap-2">
                    <rec.icon className={`h-5 w-5 ${rec.color}`} />
                    <span className={`font-semibold ${rec.color}`}>{rec.label}</span>
                  </div>
                  <Separator />
                  {Array.isArray(check.deposit_recommendation_reasons) &&
                    check.deposit_recommendation_reasons.map((r, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        <ChevronRight className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                        <span>{r}</span>
                      </div>
                    ))}
                </>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Eligibility not yet evaluated
                </p>
              )}
            </TabsContent>

            <TabsContent value="packet" className="p-4 mt-0">
              <DepositPacketGenerator checkId={checkId} />
            </TabsContent>

            <TabsContent value="audit" className="p-4 space-y-2 mt-0">
              {auditLog.map((entry) => (
                <div key={entry.id} className="flex gap-3 text-sm">
                  <div className="w-1 rounded-full bg-primary/30 shrink-0" />
                  <div>
                    <p className="font-medium">{entry.event_type.replace(/_/g, " ")}</p>
                    {entry.event_description && (
                      <p className="text-muted-foreground text-xs">{entry.event_description}</p>
                    )}
                    <p className="text-muted-foreground text-[10px]">
                      {format(new Date(entry.created_at), "MMM d, yyyy h:mm a")}
                    </p>
                  </div>
                </div>
              ))}
              {auditLog.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No audit events</p>
              )}
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </CardContent>
    </Card>

    <DepositImageViewer
      open={depositViewerOpen}
      imageUrl={depositViewerUrl}
      title={`Mobile Deposit — Check #${check?.check_number ?? checkId.slice(0, 8)}`}
      onClose={() => {
        setDepositViewerOpen(false);
        setDepositViewerUrl(null);
      }}
    />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Small sub-components                                               */
/* ------------------------------------------------------------------ */

function EndorsementPacketCard({ checkId, packetPath }: { checkId: string; packetPath: string }) {
  const { toast } = useToast();
  const [generating, setGenerating] = useState(false);

  const handleDownload = async () => {
    const { data } = await supabase.storage
      .from("endorsement-packets")
      .createSignedUrl(packetPath, 300);
    if (data?.signedUrl) {
      const a = document.createElement("a");
      a.href = data.signedUrl;
      a.download = packetPath.split("/").pop() ?? "endorsement-packet.svg";
      a.click();
    }
  };

  const handlePreview = async () => {
    const { data } = await supabase.storage
      .from("endorsement-packets")
      .createSignedUrl(packetPath, 300);
    if (data?.signedUrl) {
      window.open(data.signedUrl, "_blank");
    }
  };

  const handleRegenerate = async () => {
    setGenerating(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Not authenticated");
      const { error } = await supabase.functions.invoke("generate-endorsement-packet", {
        body: { checkId, force: true },
        headers: { Authorization: `Bearer ${session.session.access_token}` },
      });
      if (error) throw new Error(error.message);
      toast({ title: "Endorsement packet regenerated" });
    } catch (e: unknown) {
      toast({
        title: "Generation failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="mt-2 border border-emerald-500/30 bg-emerald-500/10 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2 text-emerald-400 font-semibold text-sm">
        <FileImage className="h-4 w-4 shrink-0" />
        Endorsement Packet Ready
      </div>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" className="text-xs h-7 flex-1" onClick={handlePreview}>
          <Eye className="h-3 w-3 mr-1" />Preview
        </Button>
        <Button size="sm" variant="outline" className="text-xs h-7 flex-1" onClick={handleDownload}>
          <Download className="h-3 w-3 mr-1" />Download
        </Button>
        <Button size="sm" variant="ghost" className="text-xs h-7" onClick={handleRegenerate} disabled={generating}>
          <RefreshCw className={`h-3 w-3 mr-1 ${generating ? "animate-spin" : ""}`} />
          Regen
        </Button>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-2 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-medium text-right break-words min-w-0">{value ?? "—"}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Editable Amount                                                    */
/* ------------------------------------------------------------------ */

function EditableAmount({ checkId, currentAmount, onSave }: { checkId: string; currentAmount: number | null; onSave: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentAmount?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const handleSave = async () => {
    const cleaned = value.replace(/[$,\s]/g, "");
    const num = Number(cleaned);
    if (isNaN(num) || num < 0) {
      toast({ title: "Invalid amount", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("check_intake_items")
        .update({ amount: num || null, updated_at: new Date().toISOString() })
        .eq("id", checkId);
      if (error) throw error;

      // Also update linked claim_checks if exists
      await supabase
        .from("claim_checks")
        .update({ amount: num, updated_at: new Date().toISOString() })
        .eq("check_intake_item_id", checkId);

      toast({ title: "Amount updated" });
      setEditing(false);
      onSave();
    } catch (e: any) {
      toast({ title: "Failed to update", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xl font-bold">$</span>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-8 text-lg font-bold w-32"
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setEditing(false); }}
        />
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleSave} disabled={saving}>
          <CheckIcon className="h-4 w-4 text-emerald-400" />
        </Button>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(false)}>
          <X className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 group">
      <p className="text-xl font-bold tabular-nums">
        {currentAmount != null
          ? `$${currentAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
          : <span className="text-destructive">Amount missing</span>
        }
      </p>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => { setValue(currentAmount?.toString() ?? ""); setEditing(true); }}
      >
        <Pencil className="h-3 w-3" />
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Payee Manager — add / edit / remove                                */
/* ------------------------------------------------------------------ */

function PayeeManager({ checkId, payees, onRefresh }: { checkId: string; payees: CheckPayee[]; onRefresh: () => void }) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("unknown");
  const [saving, setSaving] = useState(false);

  const addPayee = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("check_payees").insert({
        check_id: checkId,
        payee_name: newName.trim(),
        payee_type: newType,
        endorsement_token: crypto.randomUUID(),
        endorsement_token_expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      });
      if (error) throw error;
      toast({ title: "Payee added" });
      setNewName("");
      setNewType("unknown");
      setAdding(false);
      onRefresh();
    } catch (e: any) {
      toast({ title: "Failed to add payee", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const removePayee = async (payeeId: string) => {
    try {
      // Delete endorsements first
      await supabase.from("check_endorsement_events").delete().eq("payee_id", payeeId);
      await supabase.from("check_endorsements").delete().eq("payee_id", payeeId);
      const { error } = await supabase.from("check_payees").delete().eq("id", payeeId);
      if (error) throw error;
      toast({ title: "Payee removed" });
      onRefresh();
    } catch (e: any) {
      toast({ title: "Failed to remove", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-3">
      {payees.map((payee) => (
        <EditablePayeeCard key={payee.id} payee={payee} checkId={checkId} onRefresh={onRefresh} onRemove={() => removePayee(payee.id)} />
      ))}
      {payees.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground text-center py-4">No payees detected yet</p>
      )}

      {adding ? (
        <Card className="p-3 space-y-2 border-dashed border-primary/50">
          <Input placeholder="Payee name" value={newName} onChange={(e) => setNewName(e.target.value)} className="h-8 text-sm" autoFocus />
          <Select value={newType} onValueChange={setNewType}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="insured">Insured</SelectItem>
              <SelectItem value="mortgage_company">Mortgage Company</SelectItem>
              <SelectItem value="contractor">Contractor</SelectItem>
              <SelectItem value="public_adjuster">Public Adjuster</SelectItem>
              <SelectItem value="unknown">Unknown</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex gap-1">
            <Button size="sm" className="flex-1 text-xs h-7" onClick={addPayee} disabled={saving || !newName.trim()}>
              <Plus className="h-3 w-3 mr-1" />Add
            </Button>
            <Button size="sm" variant="ghost" className="text-xs h-7" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </Card>
      ) : (
        <Button size="sm" variant="outline" className="w-full text-xs" onClick={() => setAdding(true)}>
          <Plus className="h-3 w-3 mr-1" />Add Payee
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Editable Payee Card                                                */
/* ------------------------------------------------------------------ */

function EditablePayeeCard({
  payee,
  checkId,
  onRefresh,
  onRemove,
}: {
  payee: CheckPayee;
  checkId: string;
  onRefresh: () => void;
  onRemove: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(payee.payee_name);
  const [editType, setEditType] = useState(payee.payee_type);
  const [email, setEmail] = useState(payee.contact_email ?? "");
  const [phone, setPhone] = useState(payee.contact_phone ?? "");
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const PayeeIcon = payeeTypeIcons[payee.payee_type] ?? AlertTriangle;

  const handleSaveEdit = async () => {
    if (!editName.trim()) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("check_payees")
        .update({ payee_name: editName.trim(), payee_type: editType, updated_at: new Date().toISOString() })
        .eq("id", payee.id);
      if (error) throw error;
      toast({ title: "Payee updated" });
      setEditing(false);
      onRefresh();
    } catch (e: any) {
      toast({ title: "Failed to update", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const sendEndorsementRequest = async (method: "email" | "sms" | "both") => {
    setSending(true);
    try {
      const normalizedEmail = email.trim();
      const normalizedPhone = phone.trim();

      if ((method === "email" || method === "both") && !normalizedEmail) {
        throw new Error("Please enter an email address for this payee");
      }
      if ((method === "sms" || method === "both") && !normalizedPhone) {
        throw new Error("Please enter a phone number for this payee");
      }

      const { error: updateError } = await supabase
        .from("check_payees")
        .update({ contact_email: normalizedEmail || null, contact_phone: normalizedPhone || null })
        .eq("id", payee.id);
      if (updateError) throw updateError;

      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Not authenticated");

      const { error } = await supabase.functions.invoke("check-endorsement", {
        body: { action: "send_endorsement_request", payeeId: payee.id, method, email: normalizedEmail || undefined, phone: normalizedPhone || undefined },
        headers: { Authorization: `Bearer ${session.session.access_token}` },
      });
      if (error) throw new Error(error.message);
      toast({ title: `Endorsement request sent via ${method}` });
      onRefresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      toast({ title: "Failed to send", description: msg, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        {editing ? (
          <div className="flex-1 space-y-2 mr-2">
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-7 text-sm" autoFocus />
            <Select value={editType} onValueChange={setEditType}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="insured">Insured</SelectItem>
                <SelectItem value="mortgage_company">Mortgage Company</SelectItem>
                <SelectItem value="contractor">Contractor</SelectItem>
                <SelectItem value="public_adjuster">Public Adjuster</SelectItem>
                <SelectItem value="unknown">Unknown</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex gap-1">
              <Button size="sm" variant="default" className="h-6 text-xs" onClick={handleSaveEdit} disabled={saving}>
                <CheckIcon className="h-3 w-3 mr-1" />Save
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => { setEditing(false); setEditName(payee.payee_name); setEditType(payee.payee_type); }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <PayeeIcon className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-sm">{payee.payee_name}</span>
          </div>
        )}
        <div className="flex items-center gap-1">
          <Badge className={`text-[10px] ${endorsementColors[payee.endorsement_status] ?? ""}`}>
            {payee.endorsement_status}
          </Badge>
          {!editing && (
            <>
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setEditing(true)}>
                <Pencil className="h-3 w-3" />
              </Button>
              <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive hover:text-destructive" onClick={onRemove}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
      </div>
      {!editing && (
        <p className="text-xs text-muted-foreground capitalize">
          {payee.payee_type.replace(/_/g, " ")}
        </p>
      )}

      {payee.endorsement_status !== "signed" && payee.endorsement_status !== "rejected" && !editing && (
        <div className="space-y-2 pt-1">
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-8 text-xs" />
          <Input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="h-8 text-xs" />
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="flex-1 text-xs h-7" disabled={sending || !email} onClick={() => sendEndorsementRequest("email")}>
              <Send className="h-3 w-3 mr-1" />Email
            </Button>
            <Button size="sm" variant="outline" className="flex-1 text-xs h-7" disabled={sending || !phone} onClick={() => sendEndorsementRequest("sms")}>
              <Send className="h-3 w-3 mr-1" />SMS
            </Button>
          </div>
        </div>
      )}

      {payee.endorsed_at && (
        <p className="text-[10px] text-muted-foreground">
          Endorsed {format(new Date(payee.endorsed_at), "MMM d, yyyy h:mm a")}
        </p>
      )}
    </Card>
  );
}

function PayeeCard({
  payee,
  checkId,
  onRefresh,
}: {
  payee: CheckPayee;
  checkId: string;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState(payee.contact_email ?? "");
  const [phone, setPhone] = useState(payee.contact_phone ?? "");
  const [sending, setSending] = useState(false);
  const PayeeIcon = payeeTypeIcons[payee.payee_type] ?? AlertTriangle;

  const sendEndorsementRequest = async (method: "email" | "sms" | "both") => {
    setSending(true);
    try {
      const normalizedEmail = email.trim();
      const normalizedPhone = phone.trim();

      if ((method === "email" || method === "both") && !normalizedEmail) {
        throw new Error("Please enter an email address for this payee");
      }

      if ((method === "sms" || method === "both") && !normalizedPhone) {
        throw new Error("Please enter a phone number for this payee");
      }

      const { error: updateError } = await supabase
        .from("check_payees")
        .update({
          contact_email: normalizedEmail || null,
          contact_phone: normalizedPhone || null,
        })
        .eq("id", payee.id);

      if (updateError) throw updateError;

      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Not authenticated");

      const { error } = await supabase.functions.invoke("check-endorsement", {
        body: {
          action: "send_endorsement_request",
          payeeId: payee.id,
          method,
          email: normalizedEmail || undefined,
          phone: normalizedPhone || undefined,
        },
        headers: { Authorization: `Bearer ${session.session.access_token}` },
      });

      if (error) throw new Error(error.message);
      toast({ title: `Endorsement request sent via ${method}` });
      onRefresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      toast({ title: "Failed to send", description: msg, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PayeeIcon className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-sm">{payee.payee_name}</span>
        </div>
        <Badge className={`text-[10px] ${endorsementColors[payee.endorsement_status] ?? ""}`}>
          {payee.endorsement_status}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground capitalize">
        {payee.payee_type.replace(/_/g, " ")}
      </p>

      {payee.endorsement_status !== "signed" && payee.endorsement_status !== "rejected" && (
        <div className="space-y-2 pt-1">
          <Input
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-8 text-xs"
          />
          <Input
            placeholder="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="h-8 text-xs"
          />
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs h-7"
              disabled={sending || !email}
              onClick={() => sendEndorsementRequest("email")}
            >
              <Send className="h-3 w-3 mr-1" />Email
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs h-7"
              disabled={sending || !phone}
              onClick={() => sendEndorsementRequest("sms")}
            >
              <Send className="h-3 w-3 mr-1" />SMS
            </Button>
          </div>
        </div>
      )}

      {payee.endorsed_at && (
        <p className="text-[10px] text-muted-foreground">
          Endorsed {format(new Date(payee.endorsed_at), "MMM d, yyyy h:mm a")}
        </p>
      )}
    </Card>
  );
}
