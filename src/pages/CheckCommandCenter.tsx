import { useState, useMemo, useCallback } from "react";
import { watermarkCheckImage } from "@/utils/watermarkCheck";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
  Download, FileImage,
} from "lucide-react";
import { format } from "date-fns";
import { CheckReviewQueue, ReviewDecisionPanel } from "@/components/check-review/CheckReviewConsole";
import { EndorsementChecklist } from "@/components/check-review/EndorsementChecklist";
import { DepositPacketGenerator } from "@/components/check-review/DepositPacketGenerator";
import { CheckDashboardCards } from "@/components/check-review/CheckDashboardCards";
import { LossDraftDashboard } from "@/components/loss-draft/LossDraftDashboard";
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

  const DELETABLE_STATUSES = ["uploaded", "ocr_complete", "needs_review", "manual_review_required"];

  const deleteCheckMutation = useMutation({
    mutationFn: async (checkId: string) => {
      // Delete related records first, then the check
      await supabase.from("check_eligibility_results").delete().eq("check_id", checkId);
      await supabase.from("check_audit_log").delete().eq("check_id", checkId);
      await supabase.from("check_payees").delete().eq("check_id", checkId);
      const { error } = await supabase.from("check_intake_items").delete().eq("id", checkId);
      if (error) throw error;
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
                          const canDelete = DELETABLE_STATUSES.includes(check.status);
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

      // Watermark check images with VOID before storing — prevents fraudulent printing
      const watermarkedFront = await watermarkCheckImage(frontFile);
      const watermarkedBack = backFile ? await watermarkCheckImage(backFile) : null;

      const ts = Date.now();
      const claimDir = claimId || "unclaimed";
      const prefix = `checks/${user.id}/${claimDir}`;
      const frontPath = `${prefix}/${ts}_front_${frontFile.name}`;

      const { error: fErr } = await supabase.storage
        .from("claim-files")
        .upload(frontPath, watermarkedFront);
      if (fErr) throw new Error(`Front upload failed: ${fErr.message}`);

      let backPath: string | null = null;
      if (watermarkedBack) {
        backPath = `${prefix}/${ts}_back_${backFile!.name}`;
        const { error: bErr } = await supabase.storage
          .from("claim-files")
          .upload(backPath, watermarkedBack);
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

  if (!check) return null;

  const rec = check.deposit_recommendation
    ? recommendationConfig[check.deposit_recommendation]
    : null;

  // Fetch endorsements for blocking banner
  const { data: endorsements = [] } = useQuery({
    queryKey: ["check-endorsements-summary", checkId],
    queryFn: async () => {
      const { data } = await supabase
        .from("check_endorsements")
        .select("id, payee_name, payee_type, status")
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
    enabled: check?.status === "loss_draft_required" || check?.status === "needs_review",
    queryFn: async () => {
      const { data } = await supabase
        .from("loss_draft_tracking")
        .select("id")
        .eq("check_intake_item_id", checkId)
        .maybeSingle();
      return data;
    },
  });

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

  return (
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
          <p className="text-xl font-bold tabular-nums">
            ${check.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </p>
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
              {check.claim_id && (
                <DetailRow label="Linked Claim" value={check.claim_id.slice(0, 8) + "..."} />
              )}
            </TabsContent>

            <TabsContent value="endorsements" className="p-4 mt-0">
              <EndorsementChecklist
                checkId={checkId}
                onRefresh={onRefresh}
              />
            </TabsContent>

            <TabsContent value="payees" className="p-4 space-y-3 mt-0">
              {check.check_payees?.map((payee) => (
                <PayeeCard key={payee.id} payee={payee} checkId={checkId} onRefresh={onRefresh} />
              ))}
              {(!check.check_payees || check.check_payees.length === 0) && (
                <p className="text-sm text-muted-foreground text-center py-4">No payees detected yet</p>
              )}
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
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-right max-w-[60%] truncate">{value ?? "—"}</span>
    </div>
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
      await supabase.from("check_payees").update({
        contact_email: email || null,
        contact_phone: phone || null,
      }).eq("id", payee.id);

      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Not authenticated");

      const { error } = await supabase.functions.invoke("check-endorsement", {
        body: { action: "send_endorsement_request", payeeId: payee.id, method },
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
