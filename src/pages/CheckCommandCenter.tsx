import { Fragment, lazy, Suspense, useState, useMemo, useCallback, useEffect } from "react";

import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";
import { FunctionsHttpError, FunctionsRelayError, FunctionsFetchError } from "@supabase/supabase-js";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useTenantFilter } from "@/hooks/useTenantFilter";
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
  Download, FileImage, Undo2, HelpCircle, X as XIcon, Loader2 as Loader2Icon,
  Sparkles, MessageSquare, ArrowLeft,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { toast as sonnerToast } from "sonner";
import { Pencil, Check as CheckIcon, X, Plus } from "lucide-react";
import { format } from "date-fns";

// Eager: default tab and inline panels
import { CheckReviewQueue, ReviewDecisionPanel } from "@/components/check-review/CheckReviewConsole";
import { CheckDashboardCards } from "@/components/check-review/CheckDashboardCards"; // kept for potential future use
import { AdminCheckTracker } from "@/components/check-review/AdminCheckTracker";
import { usePermissions } from "@/hooks/usePermissions";
import { DepositImageViewer } from "@/components/checks/DepositImageViewer";
import { ViewCheckImageButton } from "@/components/checks/ViewCheckImageButton";
import { toStorageObjectPath } from "@/lib/storagePath";
import { AdminDeleteCheckButton } from "@/components/checks/AdminDeleteCheckButton";
import { EndorsementOverride } from "@/lib/endorsementLayout";
import { LossDraftDetailPanel } from "@/components/loss-draft/LossDraftDetailPanel";
import { ArrowDownToLine, FileBarChart } from "lucide-react";
import { CheckCenterHelpButton } from "@/components/check-review/CheckCenterHelp";
import { ShareCheckDialog } from "@/components/check-review/ShareCheckDialog";
import { SharedChecksBadge } from "@/components/check-review/SharedChecksBadge";
import { DepositStatusPanel } from "@/components/check-review/DepositStatusPanel";
import { SignatureStatusPanel } from "@/components/check-review/SignatureStatusPanel";
import { Share2 } from "lucide-react";
import { ShieldCheck } from "lucide-react";
import { CheckValidityBadge } from "@/components/checks/CheckValidityBadge";
import { assessCheckValidity } from "@/lib/checkValidity";
import { SendPaymentPanel } from "@/components/payments/SendPaymentPanel";
import { FundsTab as IncomingFundsTab } from "@/components/payments/FundsTab";



// Lazy-loaded: heavy tab-only / dialog-only modules (each becomes its own JS chunk)
const LossDraftDashboard = lazy(() =>
  import("@/components/loss-draft/LossDraftDashboard").then(m => ({ default: m.LossDraftDashboard }))
);
const EndorsementAdjuster = lazy(() =>
  import("@/components/checks/EndorsementAdjuster").then(m => ({ default: m.EndorsementAdjuster }))
);
const EndorsementChecklist = lazy(() =>
  import("@/components/check-review/EndorsementChecklist").then(m => ({ default: m.EndorsementChecklist }))
);
const DepositPacketGenerator = lazy(() =>
  import("@/components/check-review/DepositPacketGenerator").then(m => ({ default: m.DepositPacketGenerator }))
);
const DepositOperationsConsole = lazy(() =>
  import("@/components/deposit-ops/DepositOperationsConsole").then(m => ({ default: m.DepositOperationsConsole }))
);
const DepositReports = lazy(() =>
  import("@/components/deposit-ops/DepositReports").then(m => ({ default: m.DepositReports }))
);
const TenantPartnerManager = lazy(() =>
  import("@/components/white-label/TenantPartnerManager").then(m => ({ default: m.TenantPartnerManager }))
);
const MortgageCompaniesDirectory = lazy(() =>
  import("@/components/checks/MortgageCompaniesDirectory").then(m => ({ default: m.MortgageCompaniesDirectory }))
);
const LossPreventionPanel = lazy(() =>
  import("@/components/check-review/LossPreventionPanel").then(m => ({ default: m.LossPreventionPanel }))
);
const CheckMessagesPanel = lazy(() =>
  import("@/components/check-messages/CheckMessagesPanel").then(m => ({ default: m.CheckMessagesPanel }))
);
const CheckMessageThread = lazy(() =>
  import("@/components/check-messages/CheckMessageThread").then(m => ({ default: m.CheckMessageThread }))
);
const SharedCheckThread = lazy(() =>
  import("@/components/check-review/SharedCheckThread").then(m => ({ default: m.SharedCheckThread }))
);

/** Spinner shown while a lazy tab/section loads. */
const TabLoader = () => (
  <div className="flex items-center justify-center py-12">
    <Loader2Icon className="h-5 w-5 animate-spin text-muted-foreground" />
  </div>
);



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
  funds_type?: string | null;
  property_address?: string | null;
  payment_classification?: string | null;
  payee_address?: string | null;
  deposited_at?: string | null;
  deposited_by_tenant_id?: string | null;
  updated_at?: string | null;
  check_payees?: CheckPayee[];
  partner_status?: string | null;
  partner_status_label?: string | null;
  partner_status_updated_at?: string | null;
  external_origin?: Record<string, unknown> | null;
  check_source?: string | null;
  cash_job_id?: string | null;
  cash_job_payment_class?: string | null;
}

/**
 * For checks mirrored from a partner app (e.g. FreedomClaims), the local `status`
 * column stays at `uploaded` because ChecksOps has not processed them internally.
 * The partner's authoritative workflow state is mirrored into `partner_status`
 * by the receive-check-status edge function. Use that value to bucket and label
 * mirrored checks so users see the real Freedom-side state.
 */
const isMirroredCheck = (c: CheckItem) =>
  !!c.external_origin && typeof c.external_origin === "object" &&
  (c.external_origin as any).source_app === "freedom_crm";

const getEffectiveStatus = (c: CheckItem): string =>
  isMirroredCheck(c) && c.partner_status ? c.partner_status : c.status;

const getEffectiveStatusLabel = (c: CheckItem): string => {
  if (isMirroredCheck(c) && c.partner_status) {
    return (c.partner_status_label || c.partner_status).replace(/_/g, " ");
  }
  return c.status.replace(/_/g, " ");
};

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

interface CheckGroup {
  key: string;
  claimNumber: string;
  policyholderName: string;
  checks: CheckItem[];
  totalAmount: number;
  latestCreatedAt: string;
}

/**
 * Extract a clean insured/policyholder name from a raw check payee_line.
 * Filters out banks, mortgage companies, public adjusters, and trailing addresses.
 */
function extractInsuredName(payeeLine: string | null | undefined): string | null {
  if (!payeeLine) return null;
  let line = payeeLine.replace(/^\s*(pay\s+to\s+the\s+order\s+of[:\s]*|pay\s+to[:\s]+|of[:\s]+)/i, "").trim();
  const digitIdx = line.search(/\d/);
  if (digitIdx > 0) line = line.slice(0, digitIdx).trim();
  const parts = line.split(/\s*(?:&|\band\b|,|\/)\s*/i).map((p) => p.trim()).filter(Boolean);
  const EXCLUDE = /freedom\s+adjust|adjuster|bank|mortgage|loan\s*depot|loandepot|isaoa|atima|its\s+successors|n\.?a\.?$|llc$|inc\.?$|corp|company|servicing|trust|holdings|public\s+adjust/i;
  const insured = parts.find((p) => !EXCLUDE.test(p)) || parts[0] || null;
  return insured ? insured.replace(/\s+/g, " ").trim() : null;
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
  const { user } = useAuth();
  const { tenantId, isWhiteLabel, applyFilter } = useTenantFilter();
  const { isAdmin } = usePermissions();
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState("endorsements");
  const [selectedCheck, setSelectedCheck] = useState<string | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [reviewCheckId, setReviewCheckId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shareCheckId, setShareCheckId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const { data: tenantMembershipRole } = useQuery({
    queryKey: ["check-command-center-tenant-role", tenantId, user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_users")
        .select("role")
        .eq("tenant_id", tenantId!)
        .eq("user_id", user!.id)
        .maybeSingle();

      if (error) throw error;
      return data?.role ?? null;
    },
    enabled: !!tenantId && !!user?.id && isWhiteLabel,
  });

  const canAccessManager = isAdmin || (isWhiteLabel && ["admin", "owner"].includes(tenantMembershipRole ?? ""));

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
    queryKey: ["check-intake-items", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("*, check_payees(*)")
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CheckItem[];
    },
    enabled: !!tenantId,
  });

  // Partner checks — ONLY checks explicitly shared via shared_checks table.
  // Partnerships enable the ability to share, but do NOT auto-share every check.
  const { data: sharedChecks = [] } = useQuery({
    queryKey: ["shared-with-me-checks", tenantId],
    queryFn: async () => {
      const { data: sharedData, error: sErr } = await supabase
        .from("shared_checks")
        .select("check_id, source_tenant_id, tenants!shared_checks_source_tenant_id_fkey(name)")
        .eq("target_tenant_id", tenantId!)
        .is("revoked_at", null);
      if (sErr) throw sErr;
      if (!sharedData || sharedData.length === 0) return [];

      const checkIds = sharedData.map((s: any) => s.check_id);
      const { data: checkData, error: checkErr } = await supabase
        .from("check_intake_items")
        .select("*, check_payees(*)")
        .in("id", checkIds)
        .order("created_at", { ascending: false });
      if (checkErr) throw checkErr;

      const shareMap = new Map(sharedData.map((s: any) => [s.check_id, s.tenants?.name ?? "Partner"]));
      return (checkData ?? []).map((c: any) => ({
        ...c,
        _shared: true,
        _sourceTenantName: shareMap.get(c.id) ?? "Partner",
      })) as (CheckItem & { _shared: true; _sourceTenantName: string })[];
    },
    enabled: !!tenantId,
  });

  // Fetch claim numbers + policyholder names for any linked claims so search works on them
  const linkedClaimIds = useMemo(() => {
    const ids = new Set<string>();
    checks.forEach((c) => { if (c.claim_id) ids.add(c.claim_id); });
    sharedChecks.forEach((c) => { if (c.claim_id) ids.add(c.claim_id); });
    return Array.from(ids);
  }, [checks, sharedChecks]);

  const allChecks = useMemo(() => [...checks, ...sharedChecks], [checks, sharedChecks]);

  const { data: linkedClaims = [] } = useQuery({
    queryKey: ["check-linked-claims", linkedClaimIds],
    queryFn: async () => {
      if (linkedClaimIds.length === 0) return [];
      const { data, error } = await supabase
        .from("claims")
        .select("id, claim_number, policyholder_name")
        .in("id", linkedClaimIds);
      if (error) throw error;
      return data ?? [];
    },
    enabled: linkedClaimIds.length > 0,
    staleTime: 60_000,
  });

  const claimLookup = useMemo(() => {
    const map = new Map<string, { claim_number: string | null; policyholder_name: string | null }>();
    linkedClaims.forEach((c: any) => map.set(c.id, { claim_number: c.claim_number, policyholder_name: c.policyholder_name }));
    return map;
  }, [linkedClaims]);

  const matchesSearch = useCallback((c: CheckItem) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const linked = c.claim_id ? claimLookup.get(c.claim_id) : null;
    const haystacks: (string | null | undefined)[] = [
      c.check_number,
      c.carrier_name,
      c.payee_line,
      c.detected_claim_number,
      linked?.claim_number,
      linked?.policyholder_name,
      ...(c.check_payees ?? []).map((p) => p.payee_name),
    ];
    return haystacks.some((v) => v && v.toString().toLowerCase().includes(q));
  }, [searchQuery, claimLookup]);

  const awaitingEndorsement = allChecks.filter(
    (c) => {
      const s = getEffectiveStatus(c);
      return (c.deposit_recommendation === "endorsements_pending" ||
        s === "endorsements_in_progress") && matchesSearch(c);
    },
  );
  const readyForDeposit = allChecks.filter(
    (c) => {
      const s = getEffectiveStatus(c);
      return (s === "approved_for_deposit" ||
        (c.deposit_recommendation === "ready_for_deposit" && s !== "deposited")) &&
        matchesSearch(c);
    },
  );
  const needsReview = allChecks.filter(
    (c) => {
      const s = getEffectiveStatus(c);
      return (s === "needs_review" ||
        s === "manual_review_required" ||
        s === "endorsements_complete" ||
        s === "uploaded" ||
        c.deposit_recommendation === "branch_deposit_recommended" ||
        c.ocr_status === "failed") && matchesSearch(c);
    },
  );
  const reissueRequested = allChecks.filter((c) => getEffectiveStatus(c) === "reissue_requested" && matchesSearch(c));
  const branchDeposit = allChecks.filter((c) => getEffectiveStatus(c) === "branch_deposit_required" && matchesSearch(c));

  const filteredChecks =
    activeTab === "endorsements" ? awaitingEndorsement
    : activeTab === "ready" ? readyForDeposit
    : activeTab === "review" ? needsReview
    : allChecks.filter(matchesSearch);

  const buildCheckGroups = useCallback((items: CheckItem[]) => {
    const groups = new Map<string, CheckGroup>();

    items.forEach((check) => {
      const linked = check.claim_id ? claimLookup.get(check.claim_id) : null;
      const claimNumber = linked?.claim_number || check.detected_claim_number || "Unlinked claim";
      const insuredPayee = check.check_payees?.find((p) => p.payee_type === "insured")?.payee_name;
      const parsedInsured = extractInsuredName(check.payee_line);
      const policyholderName = linked?.policyholder_name || insuredPayee || parsedInsured || "Unknown insured";
      const key = `${claimNumber.trim().toLowerCase()}::${policyholderName.trim().toLowerCase()}`;
      const existing = groups.get(key);

      if (existing) {
        existing.checks.push(check);
        existing.totalAmount += check.amount ?? 0;
        if (new Date(check.created_at).getTime() > new Date(existing.latestCreatedAt).getTime()) {
          existing.latestCreatedAt = check.created_at;
        }
      } else {
        groups.set(key, {
          key,
          claimNumber,
          policyholderName,
          checks: [check],
          totalAmount: check.amount ?? 0,
          latestCreatedAt: check.created_at,
        });
      }
    });

    return Array.from(groups.values()).sort(
      (a, b) => new Date(b.latestCreatedAt).getTime() - new Date(a.latestCreatedAt).getTime(),
    );
  }, [claimLookup]);

  const groupedFilteredChecks = useMemo<CheckGroup[]>(() => buildCheckGroups(filteredChecks as CheckItem[]), [buildCheckGroups, filteredChecks]);
  const groupedReissueRequested = useMemo<CheckGroup[]>(() => buildCheckGroups(reissueRequested), [buildCheckGroups, reissueRequested]);
  const groupedBranchDeposit = useMemo<CheckGroup[]>(() => buildCheckGroups(branchDeposit), [buildCheckGroups, branchDeposit]);

  const { data: lossDraftCounts = {} } = useQuery({
    queryKey: ["loss-draft-counts", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_loss_draft_dashboard_counts_for_tenant" as any, {
        _tenant_id: tenantId!,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
    enabled: !!tenantId,
    refetchInterval: 30_000,
  });

  // Total unread internal messages across all check threads (for tab badge)
  const { data: totalUnreadMessages = 0 } = useQuery({
    queryKey: ["check-unread-total"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_total_unread_check_messages");
      if (error) throw error;
      return Number(data ?? 0);
    },
    refetchInterval: 15_000,
  });

  return (
    <div className="space-y-4 max-w-full overflow-x-hidden">
      <div className="flex flex-wrap items-start sm:items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-xl md:text-2xl font-bold tracking-tight">ChecksOps</h1>
          <p className="text-sm text-muted-foreground">
            {isWhiteLabel ? "Manage checks, endorsements & deposits" : "Insurance check intake, review & deposit readiness"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1 md:gap-2 w-full sm:w-auto">
          {user?.email === "mcarletta@freedomadj.com" && (
            <a
              href="/admin/tenants"
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-gradient-to-r from-amber-500/20 to-yellow-500/10 px-3 py-1.5 text-xs font-semibold text-amber-300 shadow-sm hover:from-amber-500/30 hover:to-yellow-500/20 transition-all"
              title="Owner-only: Tenant Management"
            >
              <Shield className="h-3.5 w-3.5" />
              Tenant Admin
            </a>
          )}
          <Sheet open={helpOpen} onOpenChange={setHelpOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="h-9 w-9">
                <HelpCircle className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[320px] sm:w-[320px]">
              <SheetHeader>
                <SheetTitle>How to Use ChecksOps</SheetTitle>
              </SheetHeader>
              <div className="mt-6 space-y-6">
                <HelpStep
                  step={1}
                  title="Endorsing"
                  description="When a check arrives, all payees must sign before it can be deposited. The endorsement checklist tracks each payee's signature status. Send requests via email or SMS."
                />
                <HelpStep
                  step={2}
                  title="Review"
                  description="Verify the OCR-extracted data — amount, check number, carrier, and payees. Approve the check to move it forward or flag issues."
                />
                <HelpStep
                  step={3}
                  title="Ready for Deposit"
                  description="Fully endorsed and verified checks land here. Generate a deposit packet or batch them for electronic or branch deposit."
                />
                <HelpStep
                  step={4}
                  title="Loss Draft"
                  description="Manage mortgage company escrow holds, track disbursement schedules, and follow up on held funds until fully released."
                />
              </div>
              <div className="mt-8">
                <Button variant="outline" className="w-full" onClick={() => setHelpOpen(false)}>
                  Dismiss
                </Button>
              </div>
            </SheetContent>
          </Sheet>
          <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
            <DialogTrigger asChild>
              <Button className="whitespace-nowrap"><Upload className="h-4 w-4 mr-2" /><span className="hidden sm:inline">Upload Check</span><span className="sm:hidden">Upload</span></Button>
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
          <CheckCenterHelpButton />
        </div>
      </div>

      {/* Search bar — filter checks by name, claim #, check #, or carrier */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          placeholder="Search by policyholder name, claim #, check #, payee, or carrier..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9 h-10"
        />
        {searchQuery && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8"
            onClick={() => setSearchQuery("")}
            title="Clear search"
          >
            <XIcon className="h-4 w-4" />
          </Button>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); setSelectedCheck(null); setReviewCheckId(null); }}>
        {/* Unified gradient nav cards — all primary navigation */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-9 gap-2 md:gap-3">
          {[
            { key: "review",       label: "Review",            count: needsReview.length,         icon: ClipboardCheck, gradient: "from-blue-500/20 to-cyan-500/10",     accent: "text-blue-400",    ring: "ring-blue-500/30" },
            { key: "endorsements", label: "Endorsing",         count: awaitingEndorsement.length, icon: Send,           gradient: "from-amber-500/20 to-orange-500/10",  accent: "text-amber-400",   ring: "ring-amber-500/30" },
            { key: "ready",        label: "Ready for Deposit", count: readyForDeposit.length,     icon: CheckCircle2,   gradient: "from-emerald-500/20 to-green-500/10", accent: "text-emerald-400", ring: "ring-emerald-500/30" },
            { key: "lossdraft",    label: "Loss Draft",        count: null as number | null,      icon: Landmark,       gradient: "from-purple-500/20 to-violet-500/10", accent: "text-purple-400",  ring: "ring-purple-500/30" },
            { key: "branch",       label: "Branch",            count: branchDeposit.length,       icon: Building2,      gradient: "from-teal-500/20 to-cyan-500/10",     accent: "text-teal-400",    ring: "ring-teal-500/30" },
            { key: "reissue",      label: "Reissue",           count: reissueRequested.length,    icon: RotateCcw,      gradient: "from-red-500/20 to-rose-500/10",      accent: "text-red-400",     ring: "ring-red-500/30" },
            { key: "partners",     label: "Partners",          count: null as number | null,      icon: Users,          gradient: "from-pink-500/20 to-fuchsia-500/10",  accent: "text-pink-400",    ring: "ring-pink-500/30" },
            ...(canAccessManager ? [{ key: "manager", label: "Manager", count: null as number | null, icon: Shield, gradient: "from-indigo-500/20 to-blue-500/10", accent: "text-indigo-400", ring: "ring-indigo-500/30" }] : []),
            { key: "messages",     label: "Messages",          count: totalUnreadMessages || null, icon: MessageSquare, gradient: "from-rose-500/20 to-pink-500/10",     accent: "text-rose-400",    ring: "ring-rose-500/30" },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); setSelectedCheck(null); setReviewCheckId(null); }}
                className={`relative flex flex-col items-center gap-1.5 rounded-xl p-4 transition-all duration-200 bg-gradient-to-br ${tab.gradient} border cursor-pointer ${
                  tab.key === "messages" ? "col-span-2 sm:col-span-1" : ""
                } ${
                  isActive
                    ? `border-transparent ring-2 ${tab.ring} shadow-lg scale-[1.02]`
                    : "border-border/50 hover:border-border hover:shadow-md hover:scale-[1.01]"
                }`}
              >
                <Icon className={`h-5 w-5 ${tab.accent}`} />
                <span className={`text-xs font-semibold ${isActive ? "text-foreground" : "text-muted-foreground"}`}>{tab.label}</span>
                {tab.count !== null && (
                  <Badge className={`text-[10px] px-1.5 py-0 ${isActive ? "bg-foreground/10 text-foreground" : "bg-muted text-muted-foreground"}`}>
                    {tab.count}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>

        {/* Loss Draft Tab */}
        {activeTab === "lossdraft" && (
          <div className="mt-3">
            <Suspense fallback={<TabLoader />}>
              <LossDraftDashboard searchQuery={searchQuery} />
            </Suspense>
          </div>
        )}

        {/* Manager Hub — Deposit Ops + Reports + Mortgage Cos (admin only) */}
        {activeTab === "manager" && canAccessManager && (
          <div className="mt-3">
            <Tabs defaultValue="deposit_ops">
              <TabsList className="w-full flex-wrap h-auto gap-1 bg-muted/50">
                <TabsTrigger value="deposit_ops" className="text-xs gap-1"><ArrowDownToLine className="h-3 w-3" />Deposit Ops</TabsTrigger>
                <TabsTrigger value="reports" className="text-xs gap-1"><FileBarChart className="h-3 w-3" />Reports</TabsTrigger>
                <TabsTrigger value="mortgage_cos" className="text-xs gap-1"><Building2 className="h-3 w-3" />Mortgage Cos</TabsTrigger>
              </TabsList>
              <TabsContent value="deposit_ops" className="mt-3">
                <Suspense fallback={<TabLoader />}>
                  <DepositOperationsConsole searchQuery={searchQuery} />
                </Suspense>
              </TabsContent>
              <TabsContent value="reports" className="mt-3">
                <Suspense fallback={<TabLoader />}>
                  <DepositReports />
                </Suspense>
              </TabsContent>
              <TabsContent value="mortgage_cos" className="mt-3">
                <Suspense fallback={<TabLoader />}>
                  <MortgageCompaniesDirectory searchQuery={searchQuery} />
                </Suspense>
              </TabsContent>
            </Tabs>
          </div>
        )}

        {/* Messages Tab — top-level colored card */}
        {activeTab === "messages" && (
          <div className="mt-3">
            <Suspense fallback={<TabLoader />}>
              <CheckMessagesPanel />
            </Suspense>
          </div>
        )}

        {/* Partners Tab — Manage Partners only (shared checks now appear in their status tabs) */}
        {activeTab === "partners" && (
          <div className="mt-3">
            <Suspense fallback={<TabLoader />}>
              <TenantPartnerManager />
            </Suspense>
          </div>
        )}

        {/* Reissue Tab */}
        {activeTab === "reissue" && (
          <div className="mt-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <RotateCcw className="h-4 w-4 text-orange-400" />
                  Reissue Requested ({reissueRequested.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[calc(100vh-400px)]">
                  {reissueRequested.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">No reissue requests</div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Check #</TableHead>
                          <TableHead>Carrier</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {groupedReissueRequested.map((group) => (
                          <Fragment key={group.key}>
                            <TableRow className="bg-muted/40 hover:bg-muted/40">
                              <TableCell colSpan={4} className="py-3">
                                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                  <ClaimCheckFileHeader group={group} compact />
                                </div>
                              </TableCell>
                            </TableRow>
                            {group.checks.map((check) => (
                              <TableRow key={check.id} className="cursor-pointer" onClick={() => setSelectedCheck(check.id)}>
                                <TableCell className="font-mono text-sm">#{check.check_number || "—"}</TableCell>
                                <TableCell className="text-sm">{check.carrier_name || "—"}</TableCell>
                                <TableCell className="text-right tabular-nums">{check.amount != null ? `$${check.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}</TableCell>
                                <TableCell><Badge className={`text-[10px] ${statusColors[getEffectiveStatus(check)] ?? ""}`}>{getEffectiveStatusLabel(check)}</Badge></TableCell>
                              </TableRow>
                            ))}
                          </Fragment>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Branch Deposit Tab */}
        {activeTab === "branch" && (
          <div className="mt-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-blue-400" />
                  Branch Deposit Required ({branchDeposit.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[calc(100vh-400px)]">
                  {branchDeposit.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">No branch deposits pending</div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Check #</TableHead>
                          <TableHead>Carrier</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {groupedBranchDeposit.map((group) => (
                          <Fragment key={group.key}>
                            <TableRow className="bg-muted/40 hover:bg-muted/40">
                              <TableCell colSpan={4} className="py-3">
                                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                  <ClaimCheckFileHeader group={group} compact />
                                </div>
                              </TableCell>
                            </TableRow>
                            {group.checks.map((check) => (
                              <TableRow key={check.id} className="cursor-pointer" onClick={() => setSelectedCheck(check.id)}>
                                <TableCell className="font-mono text-sm">#{check.check_number || "—"}</TableCell>
                                <TableCell className="text-sm">{check.carrier_name || "—"}</TableCell>
                                <TableCell className="text-right tabular-nums">{check.amount != null ? `$${check.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}</TableCell>
                                <TableCell><Badge className={`text-[10px] ${statusColors[getEffectiveStatus(check)] ?? ""}`}>{getEffectiveStatusLabel(check)}</Badge></TableCell>
                              </TableRow>
                            ))}
                          </Fragment>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
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
                      <Suspense fallback={<TabLoader />}>
                        <DepositPacketGenerator checkId={reviewCheckId} />
                      </Suspense>
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
        {activeTab !== "review" && activeTab !== "lossdraft" && activeTab !== "manager" && activeTab !== "reissue" && activeTab !== "branch" && activeTab !== "messages" && activeTab !== "partners" && (
          <div className="mt-3 flex flex-col md:flex-row gap-4" style={{ minHeight: "calc(100vh - 400px)" }}>
            {/* Check list — hidden on mobile when a check is selected */}
            <Card
              className={`overflow-hidden transition-all duration-300 ease-in-out md:flex-shrink-0 w-full ${isMobile && selectedCheck ? "hidden" : ""}`}
              style={!isMobile ? { width: selectedCheck ? "40%" : "80%" } : undefined}
            >
              <CardContent className="p-0 h-full">
                <div className="overflow-x-auto h-full">
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
                          <TableHead>Carrier / Property</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Class</TableHead>
                          <TableHead>Payees</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Deposit</TableHead>
                          <TableHead className="w-20"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {groupedFilteredChecks.map((group) => (
                          <Fragment key={group.key}>
                            <TableRow key={`${group.key}-header`} className="bg-muted/40 hover:bg-muted/40">
                              <TableCell colSpan={8} className="py-3">
                                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                  <ClaimCheckFileHeader group={group} />
                                </div>
                              </TableCell>
                            </TableRow>
                            {group.checks.map((check) => {
                              const rec = check.deposit_recommendation
                                ? recommendationConfig[check.deposit_recommendation]
                                : null;
                              const RecIcon = rec?.icon ?? null;
                              const canDelete = canDeleteAnyCheck;
                              const isSelected = selectedCheck === check.id;
                              const isShared = (check as any)._shared;
                              const sourceTenantName = (check as any)._sourceTenantName;
                              return (
                                <TableRow
                                  key={check.id}
                                  className={`cursor-pointer transition-colors ${isSelected ? "bg-accent" : ""}`}
                                  onClick={() => setSelectedCheck(isSelected ? null : check.id)}
                                >
                              <TableCell className="font-mono text-sm">
                                <div className="flex items-center gap-1.5">
                                  #{check.check_number || "—"}
                                  {isShared && <SharedChecksBadge sourceTenantName={sourceTenantName} />}
                                </div>
                              </TableCell>
                              <TableCell className="text-sm md:max-w-[180px]">
                                <div className="flex flex-col gap-0.5">
                                  <span className="break-words md:truncate leading-tight">{check.carrier_name || "Pending OCR"}</span>
                                  <CheckValidityBadge issueDate={check.issue_date} hideWhenSafe />
                                  {check.property_address && (
                                    <span className="text-[10px] text-muted-foreground break-words md:truncate leading-tight" title={check.property_address}>
                                      📍 {check.property_address}
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-semibold tabular-nums">
                                {check.amount != null
                                  ? `$${check.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                                  : "—"}
                              </TableCell>
                              <TableCell>
                                {check.funds_type ? (
                                  <Badge variant="outline" className="text-[10px] uppercase">
                                    {check.funds_type === "recoverable_depreciation"
                                      ? "Rec. Dep."
                                      : check.funds_type === "overhead_and_profit"
                                      ? "O&P"
                                      : check.funds_type}
                                  </Badge>
                                ) : (
                                  <span className="text-[10px] text-muted-foreground">—</span>
                                )}
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
                                <Badge className={`text-[10px] ${statusColors[getEffectiveStatus(check)] ?? ""}`}>
                                  {getEffectiveStatusLabel(check)}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                {RecIcon && (
                                  <RecIcon className={`h-4 w-4 ${rec!.color}`} />
                                )}
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  {!isShared && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setShareCheckId(check.id);
                                      }}
                                      title="Share with partner"
                                    >
                                      <Share2 className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                  {canDelete && !isShared && (
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
                                </div>
                              </TableCell>
                                </TableRow>
                              );
                            })}
                          </Fragment>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </ScrollArea>
                </div>
              </CardContent>
            </Card>

            {/* Detail panel — hidden on mobile when no check selected */}
            <div
              className={`transition-all duration-300 ease-in-out md:flex-shrink-0 overflow-hidden w-full ${isMobile && !selectedCheck ? "hidden" : ""}`}
              style={!isMobile ? { width: selectedCheck ? "60%" : "20%" } : undefined}
            >
              {selectedCheck ? (
                <div className="space-y-2">
                  {isMobile && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1 -ml-2"
                      onClick={() => setSelectedCheck(null)}
                    >
                      <ArrowLeft className="h-4 w-4" /> Back to checks
                    </Button>
                  )}
                  <CheckDetailPanel
                    checkId={selectedCheck}
                    onRefresh={() => qc.invalidateQueries({ queryKey: ["check-intake-items"] })}
                  />
                </div>
              ) : (
                <Card className="flex flex-col items-center justify-center h-full">
                  <div className="text-center text-muted-foreground">
                    <Banknote className="h-12 w-12 mx-auto mb-3 opacity-30" />
                    <Badge variant="outline" className="mb-3">{allChecks.length} checks</Badge>
                    <p className="text-sm">Select a check to begin</p>
                  </div>
                </Card>
              )}
            </div>
          </div>
        )}
      </Tabs>

      {/* Share check dialog */}
      {shareCheckId && (
        <ShareCheckDialog
          checkId={shareCheckId}
          open={!!shareCheckId}
          onOpenChange={(open) => { if (!open) setShareCheckId(null); }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Summary card (kept for Phase 1 compat)                             */
/* ------------------------------------------------------------------ */

function ClaimCheckFileHeader({ group, compact = false }: { group: CheckGroup; compact?: boolean }) {
  const signedPayees = group.checks.reduce(
    (sum, check) => sum + (check.check_payees ?? []).filter((p) => p.endorsement_status === "signed").length,
    0,
  );
  const totalPayees = group.checks.reduce((sum, check) => sum + (check.check_payees?.length ?? 0), 0);
  const hasBlocked = group.checks.some((check) => ["loss_draft_required", "branch_deposit_required", "reissue_requested", "needs_review", "manual_review_required"].includes(check.status));
  const hasReady = group.checks.some((check) => check.status === "approved_for_deposit" || check.deposit_recommendation === "ready_for_deposit");
  const hasLossDraft = group.checks.some((check) => check.status === "loss_draft_required");

  const isCashJobGroup = group.checks.every((c) => c.check_source === "cash_job");
  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {isCashJobGroup ? (
            <Badge variant="secondary" className="text-[10px] uppercase tracking-wide border-amber-500/40 text-amber-500">Cash Job</Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">Claim Check File</Badge>
          )}
          <span className="font-semibold text-foreground break-words leading-tight">{group.policyholderName}</span>
          {!isCashJobGroup && (
            <Badge variant="outline" className="font-mono text-[10px]">Claim #{group.claimNumber}</Badge>
          )}
        </div>
        {!compact && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{group.checks.length} {group.checks.length === 1 ? "check" : "checks"}</span>
            <span>•</span>
            <span>{signedPayees}/{totalPayees || 0} endorsements signed</span>
            {hasLossDraft && <span>• Loss draft visibility active</span>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {hasBlocked && <Badge variant="outline" className="border-orange-500/30 text-orange-400 text-[10px]">Blocked / pending</Badge>}
        {hasReady && <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 text-[10px]">Ready signal</Badge>}
        <div className="text-sm font-semibold tabular-nums text-foreground">
          ${group.totalAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
        </div>
      </div>
    </div>
  );
}

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
  const { tenantId } = useTenantFilter();
  const [frontFile, setFrontFile] = useState<File | null>(null);
  const [backFile, setBackFile] = useState<File | null>(null);
  const [claimId, setClaimId] = useState<string>("");
  const [claimSearch, setClaimSearch] = useState("");
  const [uploading, setUploading] = useState(false);
  const [claimDropdownOpen, setClaimDropdownOpen] = useState(false);
  const [skipAi, setSkipAi] = useState(false);
  const [mortgagee1, setMortgagee1] = useState("");
  const [mortgagee2, setMortgagee2] = useState("");
  const [showSecondMortgagee, setShowSecondMortgagee] = useState(false);

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
          ...(tenantId ? { tenant_id: tenantId } : {}),
        })
        .select()
        .single();

      if (insErr || !check) throw new Error(insErr?.message ?? "Insert failed");

      // NOTE: Loss draft tracking rows are intentionally NOT created here.
      // They are auto-created by the DB trigger (trg_auto_create_loss_draft)
      // when the check is routed to Loss Draft during review. Creating them
      // at upload time caused duplicate rows in the Loss Draft dashboard.

      const { data: session } = await supabase.auth.getSession();
      const { data: ocrResult, error: fnErr } = await supabase.functions.invoke("check-ocr-intake", {
        body: { checkId: check.id, skipAi },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });

      const result = ocrResult as { success?: boolean; ocr_success?: boolean; skipped?: boolean; reason?: string; message?: string; error?: string } | null;

      if (fnErr) {
        // Network/edge error — check is uploaded and can still be completed manually in the review queue.
        console.error("OCR invoke error:", fnErr);
        toast({
          title: "Check uploaded — enter details manually",
          description: "AI couldn't process this check. It's been added to the review queue for manual entry.",
        });
      } else if (result?.skipped) {
        // User opted out, out of credits, or rate-limited — same downstream path.
        toast({
          title: skipAi ? "Check uploaded for manual entry" : "Check uploaded — AI unavailable",
          description: result.message ?? "Enter the check details in the review queue.",
        });
      } else if (result && ((("success" in result) && !result.success) || (("ocr_success" in result) && !result.ocr_success))) {
        toast({
          title: "Check uploaded — enter details manually",
          description: typeof result.error === "string"
            ? result.error
            : "The check is in the review queue. Please complete the details manually.",
        });
      } else {
        toast({ title: "Check uploaded & AI analysis started" });
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
      {/* AI ON/OFF toggle — prominent at the top so the user can decide
          before they even pick a file whether to spend AI credits. */}
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3">
        <div className="flex items-center gap-2 min-w-0">
          {skipAi ? (
            <Pencil className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <Sparkles className="h-4 w-4 text-primary shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-sm font-medium leading-tight">
              {skipAi ? "Manual entry mode" : "AI extraction enabled"}
            </div>
            <div className="text-[11px] text-muted-foreground leading-tight">
              {skipAi
                ? "You'll type the check details in the review queue. No AI credits used."
                : "AI will read the check and pre-fill the details."}
            </div>
          </div>
        </div>
        <Button
          type="button"
          variant={skipAi ? "outline" : "default"}
          size="sm"
          className="shrink-0 h-8"
          onClick={() => setSkipAi((v) => !v)}
        >
          {skipAi ? "Turn AI On" : "Turn AI Off"}
        </Button>
      </div>

      <div>
        <Label>Front of Check *</Label>
        <Input type="file" accept="image/*" onChange={(e) => setFrontFile(e.target.files?.[0] ?? null)} />
      </div>
      <div>
        <Label>Back of Check</Label>
        <Input type="file" accept="image/*" onChange={(e) => setBackFile(e.target.files?.[0] ?? null)} />
      </div>
      {/* Link to Claim is intentionally hidden — this product is sold as a
          standalone check operations platform. When a tenant integrates an
          external CRM, the claim-linking UI will be re-enabled here. */}

      {/* Mortgagees on the check — supports up to two mortgage companies.
          Each one creates an independent Loss Draft tracking row that
          goes through its own monitored / not-monitored process. */}
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-amber-400" />
          <Label className="text-xs font-medium">Mortgage company on check (optional)</Label>
        </div>
        <Input
          placeholder="1st mortgage company name (as listed on check)"
          value={mortgagee1}
          onChange={(e) => setMortgagee1(e.target.value)}
          className="h-9"
        />
        {showSecondMortgagee ? (
          <div className="flex items-center gap-2">
            <Input
              placeholder="2nd mortgage company name"
              value={mortgagee2}
              onChange={(e) => setMortgagee2(e.target.value)}
              className="h-9"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => { setMortgagee2(""); setShowSecondMortgagee(false); }}
              title="Remove second mortgagee"
            >
              <XIcon className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-primary hover:text-primary"
            onClick={() => setShowSecondMortgagee(true)}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add 2nd mortgage company
          </Button>
        )}
        <p className="text-[11px] text-muted-foreground">
          Each mortgagee gets its own Loss Draft entry with its own
          monitored / not-monitored workflow.
        </p>
      </div>

      <Button onClick={handleUpload} disabled={uploading || !frontFile} className="w-full">
        {uploading ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
        {uploading ? "Processing..." : skipAi ? "Upload for Manual Entry" : "Upload & Analyze"}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Admin Status Override — manually move a check between stages       */
/* ------------------------------------------------------------------ */

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "uploaded", label: "Uploaded" },
  { value: "processing", label: "Processing" },
  { value: "ocr_complete", label: "OCR Complete" },
  { value: "needs_review", label: "Needs Review" },
  { value: "manual_review_required", label: "Manual Review Required" },
  { value: "endorsements_in_progress", label: "Endorsements In Progress" },
  { value: "endorsements_complete", label: "Endorsements Complete" },
  { value: "approved_for_deposit", label: "Approved for Deposit" },
  { value: "branch_deposit_required", label: "Branch Deposit Required" },
  { value: "loss_draft_required", label: "Loss Draft Required" },
  { value: "reissue_requested", label: "Reissue Requested" },
  { value: "deposited", label: "Deposited" },
  { value: "voided", label: "Voided" },
];

function StatusOverride({
  checkId,
  currentStatus,
  onSuccess,
}: {
  checkId: string;
  currentStatus: string;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [newStatus, setNewStatus] = useState(currentStatus);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (newStatus === currentStatus) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("check_intake_items")
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq("id", checkId);
      if (error) throw error;
      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "status_manual_override",
        actor_id: user?.id ?? null,
        event_description: `Status manually changed from "${currentStatus}" to "${newStatus}"`,
        event_data: { old_status: currentStatus, new_status: newStatus },
      });
      toast({ title: "Status updated", description: `Moved to ${newStatus.replace(/_/g, " ")}` });
      setEditing(false);
      onSuccess();
    } catch (e: any) {
      toast({ title: "Failed to update status", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <Button variant="outline" size="sm" className="w-full text-xs h-7" onClick={() => { setNewStatus(currentStatus); setEditing(true); }}>
        <Pencil className="h-3 w-3 mr-1" /> Override Status (Admin)
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-2 bg-muted/30">
      <Label className="text-[10px] text-muted-foreground">Manually set check status</Label>
      <Select value={newStatus} onValueChange={setNewStatus}>
        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((s) => (
            <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex gap-1">
        <Button size="sm" className="flex-1 h-7 text-xs" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2Icon className="h-3 w-3 animate-spin mr-1" /> : <CheckIcon className="h-3 w-3 mr-1" />}
          Save
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
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
      const { data, error } = await supabase.functions.invoke("check-ocr-intake", {
        body: { checkId },
        headers: { Authorization: `Bearer ${session.session?.access_token}` },
      });
      if (error) throw new Error(error.message);
      if (data && typeof data === "object" && (("success" in data && !data.success) || ("ocr_success" in data && !data.ocr_success))) {
        throw new Error(typeof data.error === "string" ? data.error : "OCR failed");
      }
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
  const [movingToDeposited, setMovingToDeposited] = useState(false);
  const [bypassingEndorsements, setBypassingEndorsements] = useState(false);
  const [branchApprovedAt, setBranchApprovedAt] = useState<number | null>(null);
  const [showForceMove, setShowForceMove] = useState(false);
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { tenantId } = useTenantFilter();

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
  const savedOverride = (check?.endorsement_override as unknown as EndorsementOverride | null) ?? null;
  const showPayToOrder = savedOverride?.showPayToOrder ?? false;

  const { data: frontImageUrl } = useQuery({
    queryKey: ["check-front-img", check?.front_image_path],
    enabled: !!check?.front_image_path,
    queryFn: async () => {
      if (isSharedView && check?.id) {
        const { data, error } = await supabase.functions.invoke("get-check-image-urls", {
          body: { checkId: check.id },
        });
        if (error) throw error;
        return (data as any)?.frontUrl ?? null;
      }
      const path = toStorageObjectPath(check!.front_image_path);
      if (!path) return null;
      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(path, 3600);
      return data?.signedUrl ?? null;
    },
  });

  const { data: backImageUrl } = useQuery({
    queryKey: ["check-back-img", check?.back_image_path],
    enabled: !!check?.back_image_path,
    queryFn: async () => {
      if (isSharedView && check?.id) {
        const { data, error } = await supabase.functions.invoke("get-check-image-urls", {
          body: { checkId: check.id },
        });
        if (error) throw error;
        return (data as any)?.backUrl ?? null;
      }
      const path = toStorageObjectPath(check!.back_image_path);
      if (!path) return null;
      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(path, 3600);
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

  // Funds: payment count for this check (visible to either sender or recipient)
  const { data: incomingPaymentCount = 0 } = useQuery({
    queryKey: ["check-funds-count", checkId, tenantId],
    enabled: !!checkId && !!tenantId,
    queryFn: async () => {
      const { count } = await supabase
        .from("claim_check_payments")
        .select("id", { count: "exact", head: true })
        .eq("check_intake_item_id", checkId);
      return count ?? 0;
    },
  });

  // Funds: identify the contractor partner (target tenant) when PA is viewing
  const { data: contractorPartner } = useQuery({
    queryKey: ["check-contractor-partner", checkId, tenantId],
    enabled: !!checkId && !!tenantId && !!check && (check as any)?.tenant_id === tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("shared_checks")
        .select("target_tenant_id, tenants!shared_checks_target_tenant_id_fkey(id, name)")
        .eq("check_id", checkId)
        .eq("source_tenant_id", tenantId!)
        .is("revoked_at", null)
        .limit(1)
        .maybeSingle();
      if (!data) return null;
      const t: any = (data as any).tenants;
      return { id: data.target_tenant_id as string, name: t?.name as string ?? "Contractor" };
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

  // Ownership: only the tenant that uploaded the check can edit it. Partners with whom
  // the check is shared are strictly read-only (they can still upload loss-draft docs
  // elsewhere in the UI, but cannot mutate the check or its payees).
  const checkOwnerTenantId = (check as any)?.tenant_id as string | null | undefined;
  const isOwner = !!tenantId && !!checkOwnerTenantId && tenantId === checkOwnerTenantId;
  const isSharedView = !!check && !isOwner;

  const handleBypassEndorsements = async () => {
    if (!user?.id || !check) return;
    setBypassingEndorsements(true);
    try {
      const now = new Date().toISOString();

      const { error: endorsementErr } = await supabase
        .from("check_endorsements")
        .update({
          status: "signed",
          signed_at: now,
          signature_method: "physical_check",
          notes: "Physical endorsements already received on check",
          updated_at: now,
        })
        .eq("check_id", checkId)
        .not("status", "in", '("signed","waived")');
      if (endorsementErr) throw endorsementErr;

      const { error: payeeErr } = await supabase
        .from("check_payees")
        .update({
          endorsement_status: "signed",
          endorsed_at: now,
          updated_at: now,
        })
        .eq("check_id", checkId)
        .not("endorsement_status", "eq", "signed");
      if (payeeErr) throw payeeErr;

      const { error: decisionErr } = await supabase.rpc("submit_check_review_decision", {
        p_check_id: checkId,
        p_reviewer_id: user.id,
        p_deposit_path: "branch_deposit_required",
        p_reviewer_notes: "Physical endorsements already received; moved directly to branch deposit.",
      });
      if (decisionErr) throw decisionErr;

      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "endorsement_bypass",
        actor_id: user.id,
        event_description: "Physical endorsements confirmed on check. Moved directly to branch deposit.",
      });

      toast({ title: "Moved to Branch Deposit", description: "Endorsements were marked received from the physical check." });
      qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["review-check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-endorsements-summary", checkId] });
      qc.invalidateQueries({ queryKey: ["check-audit", checkId] });
      qc.invalidateQueries({ queryKey: ["check-review-queue"] });
      qc.invalidateQueries({ queryKey: ["check-dashboard-counts"] });
      onRefresh();
    } catch (e: any) {
      toast({ title: "Move failed", description: e.message, variant: "destructive" });
    } finally {
      setBypassingEndorsements(false);
    }
  };

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

  // Branch deposit → Deposited transition
  // Routes through the deposit pipeline so the check appears in Deposit Operations
  // and reconciliation reports (creates a deposit_items row).
  const handleMoveToDeposited = async (force = false) => {
    if (!user?.id || !check) return;
    setMovingToDeposited(true);
    try {
      // 1. Check if a deposit_items row already exists for this check
      const { data: existingItem } = await supabase
        .from("deposit_items")
        .select("id, status")
        .eq("check_id", checkId)
        .maybeSingle();

      let depositItemId = existingItem?.id ?? null;

      // 2. If not, we need check.status = 'approved_for_deposit' to call prepare_deposit.
      //    If we're force-moving from branch_deposit_required (or some other state),
      //    flip it to approved_for_deposit first so the RPC accepts it.
      if (!depositItemId) {
        if (check.status !== "approved_for_deposit") {
          const { error: flipErr } = await supabase
            .from("check_intake_items")
            .update({ status: "approved_for_deposit", updated_at: new Date().toISOString() })
            .eq("id", checkId);
          if (flipErr) throw flipErr;
        }

        const { data: prepData, error: prepErr } = await supabase.rpc("deposit_action", {
          p_action: "prepare_deposit",
          p_actor_id: user.id,
          p_check_id: checkId,
          p_notes: force ? "Force-moved from Check Command Center" : "Moved to deposit pipeline from Check Command Center",
        });
        if (prepErr) throw prepErr;
        depositItemId = (prepData as any)?.deposit_item_id ?? null;
        if (!depositItemId) throw new Error("prepare_deposit did not return a deposit_item_id");
      }

      // 3. Assign manual_branch provider if still pending
      const { data: itemAfterPrep } = await supabase
        .from("deposit_items")
        .select("status, provider")
        .eq("id", depositItemId)
        .single();

      if (itemAfterPrep?.status === "pending_assignment") {
        const { error: assignErr } = await supabase.rpc("deposit_action", {
          p_action: "assign_provider",
          p_actor_id: user.id,
          p_deposit_item_id: depositItemId,
          p_provider: "manual_branch",
          p_notes: "Auto-assigned manual_branch from Check Command Center",
        });
        if (assignErr) throw assignErr;
      }

      // 4. Mark as manually deposited (sets check_intake_items.status = 'deposited' too)
      if (itemAfterPrep?.status !== "succeeded" && itemAfterPrep?.status !== "reconciled") {
        const { error: markErr } = await supabase.rpc("deposit_action", {
          p_action: "mark_manual_deposit",
          p_actor_id: user.id,
          p_deposit_item_id: depositItemId,
          p_notes: force ? "Force-marked deposited from Check Command Center" : "Marked deposited from Check Command Center",
        });
        if (markErr) throw markErr;
      }

      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: force ? "force_moved_to_deposited" : "moved_to_deposited",
        actor_id: user.id,
        event_description: force
          ? "Check force-moved to deposited via deposit pipeline"
          : "Check moved to deposited via deposit pipeline",
        event_data: { deposit_item_id: depositItemId },
      });

      sonnerToast.success("Check moved to Deposited", {
        description: `Check #${check.check_number ?? checkId.slice(0, 8)} now visible in Deposit Operations.`,
      });
      setBranchApprovedAt(null);
      setShowForceMove(false);
      qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["check-dashboard-counts"] });
      qc.invalidateQueries({ queryKey: ["check-audit", checkId] });
      qc.invalidateQueries({ queryKey: ["deposit-items"] });
      qc.invalidateQueries({ queryKey: ["deposit-recon-summary"] });
      onRefresh();
    } catch (e: any) {
      toast({ title: "Failed to move check", description: e.message, variant: "destructive" });
    } finally {
      setMovingToDeposited(false);
    }
  };

  // 5-minute safeguard for branch checks
  useEffect(() => {
    if (check?.status !== "branch_deposit_required" || !branchApprovedAt) {
      setShowForceMove(false);
      return;
    }
    const timer = setTimeout(() => {
      setShowForceMove(true);
    }, 5 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [check?.status, branchApprovedAt]);

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

  const isFinalDepositImage =
    check.status === "approved_for_deposit" ||
    check.status === "deposit_ready" ||
    check.status === "endorsements_complete";

  const showWatermark = !isFinalDepositImage;

  return (
    <>
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Check #{check.check_number ?? "Pending"}</CardTitle>
          <Badge className={statusColors[check.status] ?? ""}>
            {check.status.replace(/_/g, " ")}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          <ViewCheckImageButton
            checkId={checkId}
            frontImagePath={check.front_image_path}
            checkNumber={check.check_number}
            size="sm"
            variant="outline"
            className="h-7 text-xs"
          />
          {!isSharedView && (
            <AdminDeleteCheckButton
              checkId={checkId}
              checkNumber={check.check_number}
              onDeleted={() => {
                onRefresh();
                qc.invalidateQueries({ queryKey: ["check-intake-items"] });
                qc.invalidateQueries({ queryKey: ["check-dashboard-counts"] });
              }}
              size="sm"
              variant="outline"
              className="h-7 text-xs"
            />
          )}
        </div>
        {check.carrier_name && (
          <p className="text-sm text-muted-foreground">{check.carrier_name}</p>
        )}
        {check.amount != null && (
          <EditableAmount checkId={checkId} currentAmount={check.amount} readOnly={isSharedView} onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }} />
        )}
        {check.amount == null && (
          <EditableAmount checkId={checkId} currentAmount={null} readOnly={isSharedView} onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }} />
        )}

        {/* Validity assessment — issue date age vs 180-day stale threshold */}
        {(() => {
          const v = assessCheckValidity(check.issue_date);
          if (v.risk === "ok" || v.risk === "unknown") return null;
          const tone =
            v.risk === "expired"
              ? "border-red-500/40 bg-red-500/10 text-red-400"
              : v.risk === "stale"
              ? "border-orange-500/40 bg-orange-500/10 text-orange-400"
              : "border-amber-500/40 bg-amber-500/10 text-amber-400";
          return (
            <div className={`mt-2 border rounded-lg p-3 space-y-1 ${tone}`}>
              <div className="flex items-center gap-2 font-semibold text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Check validity: {v.label}
              </div>
              <p className="text-xs opacity-80 pl-6">{v.detail}</p>
            </div>
          );
        })()}

        {/* Shared / read-only banner for non-owner tenants */}
        {isSharedView && (
          <div className="mt-2 border border-blue-500/30 bg-blue-500/10 rounded-lg p-3 space-y-1">
            <div className="flex items-center gap-2 text-blue-400 font-semibold text-sm">
              <Eye className="h-4 w-4 shrink-0" />
              Shared check — read only
            </div>
            <p className="text-xs text-blue-300/80 pl-6">
              This check was uploaded by another organization. You can view details, but only the owner can edit the check or payees. If this check is in loss draft, you can still upload supporting documents from the claim's file area.
            </p>
          </div>
        )}

        {/* Single Source of Truth Blocking Banner */}
        {isDepositBlocked && (
          <div className="mt-2 border border-amber-500/30 bg-amber-500/10 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Deposit Blocked
            </div>
            {blockingReasons.map((reason, i) => (
              <p key={i} className="text-xs text-amber-300/80 pl-6">• {reason}</p>
            ))}
            {/* Bypass endorsements — physical signatures already on check */}
            {pendingEndorsements.length > 0 && check.status !== "loss_draft_required" && !isSharedView && (
              <Button
                size="sm"
                variant="outline"
                className="w-full mt-1 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                onClick={handleBypassEndorsements}
                disabled={bypassingEndorsements}
              >
                {bypassingEndorsements ? (
                  <><Loader2Icon className="h-4 w-4 mr-2 animate-spin" />Bypassing...</>
                ) : (
                  <><CheckCircle2 className="h-4 w-4 mr-2" />Skip Endorsements — Already Signed</>
                )}
              </Button>
            )}
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
        <EndorsementPacketCard checkId={checkId} packetPath={check.endorsement_packet_path} />
      </CardHeader>
      <CardContent className="p-0">
        <Tabs value={detailTab} onValueChange={setDetailTab}>
          <div className="w-full overflow-x-auto scrollbar-hide">
            <TabsList className="w-max min-w-full rounded-none flex-nowrap justify-start">
              <TabsTrigger value="overview" className="text-xs whitespace-nowrap px-2 sm:px-3">Overview</TabsTrigger>
              <TabsTrigger value="endorsements" className="text-xs whitespace-nowrap px-2 sm:px-3">
                Endorsements
                {pendingEndorsements.length > 0 && (
                  <span className="ml-1 bg-amber-500/30 text-amber-400 rounded-full text-[9px] px-1.5">
                    {pendingEndorsements.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="payees" className="text-xs whitespace-nowrap px-2 sm:px-3">
                Payees ({check.check_payees?.length ?? 0})
              </TabsTrigger>
              
              <TabsTrigger value="funds" className="text-xs whitespace-nowrap px-2 sm:px-3 gap-1">
                Funds
                {incomingPaymentCount > 0 && (
                  <span className="ml-1 bg-emerald-500/30 text-emerald-400 rounded-full text-[9px] px-1.5">
                    {incomingPaymentCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="eligibility" className="text-xs whitespace-nowrap px-2 sm:px-3">Eligibility</TabsTrigger>

              <TabsTrigger value="partners" className="text-xs whitespace-nowrap px-2 sm:px-3 gap-1">
                <Share2 className="h-3 w-3" /> Partners
                <MessageSquare className="h-3 w-3 ml-0.5 opacity-70" />
              </TabsTrigger>
              <TabsTrigger value="audit" className="text-xs whitespace-nowrap px-2 sm:px-3">Audit</TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="h-[calc(100vh-520px)]">
            <TabsContent value="overview" className="p-4 space-y-3 mt-0">
              <DepositStatusPanel
                checkId={checkId}
                depositedAt={check.deposited_at ?? null}
                depositedByTenantId={check.deposited_by_tenant_id ?? null}
                lastUpdated={check.updated_at ?? null}
              />
              <SignatureStatusPanel checkId={checkId} />
              {check.ocr_status !== "complete" && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                  <div className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="h-3 w-3" />
                    OCR not complete — fields below are editable
                  </div>
                  <p className="mt-1 text-amber-300/70">Hover any field and click the pencil to enter or correct it manually.</p>
                </div>
              )}
              <EditableField
                label="Check #"
                checkId={checkId}
                field="check_number"
                value={check.check_number}
                readOnly={isSharedView}
                onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }}
              />
              <EditableField
                label={check.check_source === "cash_job" ? "Property" : "Carrier"}
                checkId={checkId}
                field="carrier_name"
                value={check.carrier_name}
                readOnly={isSharedView}
                onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }}
              />
              <EditableField
                label="Issue Date"
                checkId={checkId}
                field="issue_date"
                value={check.issue_date}
                inputType="date"
                readOnly={isSharedView}
                displayFormatter={(v) => (v ? format(new Date(v), "MMM d, yyyy") : null)}
                onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }}
              />
              {check.check_source === "cash_job" ? (
                <div className="flex justify-between text-sm py-1">
                  <span className="text-muted-foreground">Class</span>
                  <span className="font-medium">
                    {check.cash_job_payment_class === "initial_deposit" ? "Initial Deposit" :
                     check.cash_job_payment_class === "final_payment" ? "Final Payment" :
                     check.cash_job_payment_class === "progress_payment" ? "Progress Payment" :
                     check.cash_job_payment_class === "other" ? "Other" : "—"}
                  </span>
                </div>
              ) : (
                <EditableField
                  label="Detected Claim #"
                  checkId={checkId}
                  field="detected_claim_number"
                  value={check.detected_claim_number}
                  readOnly={isSharedView}
                  onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }}
                />
              )}
              <EditableField
                label="Payee Line"
                checkId={checkId}
                field="payee_line"
                value={check.payee_line}
                multiline
                readOnly={isSharedView}
                onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }}
              />
              <EditableField
                label="Multi-Payee"
                checkId={checkId}
                field="is_multi_payee"
                value={check.is_multi_payee ? "true" : "false"}
                inputType="boolean"
                readOnly={isSharedView}
                displayFormatter={(v) => (v === "true" ? "Yes" : "No")}
                onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }}
              />
              <FundsTypeField
                checkId={checkId}
                value={check.funds_type ?? null}
                readOnly={isSharedView}
                onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }}
              />
              <EditableField
                label="Property Address"
                checkId={checkId}
                field="property_address"
                value={check.property_address ?? null}
                multiline
                readOnly={isSharedView}
                onSave={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }}
              />
              <DetailRow label="OCR Status" value={check.ocr_status} />
              {!isSharedView && (
                <>
                  <RerunOcrButton checkId={checkId} onSuccess={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }} />
                  <StatusOverride
                    checkId={checkId}
                    currentStatus={check.status}
                    onSuccess={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); qc.invalidateQueries({ queryKey: ["check-intake-items"] }); onRefresh(); }}
                  />
                </>
              )}
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
                        <div className="flex items-center gap-1">
                          {!isSharedView && (
                          <label className="cursor-pointer">
                            <Button variant="ghost" size="icon" className="h-5 w-5" asChild disabled={reuploadingBack}>
                              <span><Upload className={`h-3 w-3 ${reuploadingBack ? "animate-spin" : ""}`} /></span>
                            </Button>
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file || !check) return;
                                setReuploadingBack(true);
                                try {
                                  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
                                  const newPath = `checks/${check.id}/back-${Date.now()}.${ext}`;
                                  const { error: uploadErr } = await supabase.storage
                                    .from("claim-files")
                                    .upload(newPath, file, { cacheControl: "31536000", upsert: false, contentType: file.type || "image/jpeg" });
                                  if (uploadErr) throw uploadErr;
                                  const { error: updateErr } = await supabase
                                    .from("check_intake_items")
                                    .update({ back_image_path: newPath })
                                    .eq("id", check.id);
                                  if (updateErr) throw updateErr;
                                  await supabase.from("check_audit_log").insert({
                                    check_id: check.id,
                                    event_type: "back_image_reuploaded",
                                    actor_id: user?.id ?? null,
                                    event_description: "Back of check re-uploaded (e.g. after mortgage signature)",
                                    event_data: { old_path: check.back_image_path, new_path: newPath },
                                  });
                                  toast({ title: "Back image updated", description: "The back of the check has been re-uploaded successfully." });
                                  qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
                                  qc.invalidateQueries({ queryKey: ["check-back-img"] });
                                  onRefresh();
                                } catch (err: any) {
                                  toast({ title: "Upload failed", description: err.message, variant: "destructive" });
                                } finally {
                                  setReuploadingBack(false);
                                  e.target.value = "";
                                }
                              }}
                            />
                          </label>
                          )}
                          <a href={backImageUrl} download={`check-${check.check_number ?? check.id}-back`} target="_blank" rel="noopener noreferrer">
                            <Button variant="ghost" size="icon" className="h-5 w-5"><Download className="h-3 w-3" /></Button>
                          </a>
                        </div>
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
                  {!backImageUrl && !isSharedView && (
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground">Back — No image uploaded</p>
                      <label className="cursor-pointer">
                        <Button variant="outline" size="sm" className="w-full text-xs" asChild disabled={reuploadingBack}>
                          <span><Upload className={`h-3 w-3 mr-1 ${reuploadingBack ? "animate-spin" : ""}`} />{reuploadingBack ? "Uploading..." : "Upload Back of Check"}</span>
                        </Button>
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file || !check) return;
                            setReuploadingBack(true);
                            try {
                              const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
                              const newPath = `checks/${check.id}/back-${Date.now()}.${ext}`;
                              const { error: uploadErr } = await supabase.storage
                                .from("claim-files")
                                .upload(newPath, file, { cacheControl: "31536000", upsert: false, contentType: file.type || "image/jpeg" });
                              if (uploadErr) throw uploadErr;
                              const { error: updateErr } = await supabase
                                .from("check_intake_items")
                                .update({ back_image_path: newPath })
                                .eq("id", check.id);
                              if (updateErr) throw updateErr;
                              await supabase.from("check_audit_log").insert({
                                check_id: check.id,
                                event_type: "back_image_uploaded",
                                actor_id: user?.id ?? null,
                                event_description: "Back of check uploaded",
                                event_data: { new_path: newPath },
                              });
                              toast({ title: "Back image uploaded", description: "You can now collect endorsement signatures." });
                              qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
                              qc.invalidateQueries({ queryKey: ["check-back-img"] });
                              onRefresh();
                            } catch (err: any) {
                              toast({ title: "Upload failed", description: err.message, variant: "destructive" });
                            } finally {
                              setReuploadingBack(false);
                              e.target.value = "";
                            }
                          }}
                        />
                      </label>
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
              {canUndo && !isSharedView && (
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
              {/* Branch → Deposited transition */}
              {check.status === "branch_deposit_required" && !isSharedView && (
                <div className="space-y-2 mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full border-border text-foreground hover:bg-primary hover:text-primary-foreground"
                    onClick={() => {
                      setBranchApprovedAt(Date.now());
                      handleMoveToDeposited(false);
                    }}
                    disabled={movingToDeposited}
                  >
                    {movingToDeposited ? (
                      <><Loader2Icon className="h-4 w-4 mr-2 animate-spin" />Moving...</>
                    ) : (
                      <><CheckCircle2 className="h-4 w-4 mr-2" />Move to Deposited</>
                    )}
                  </Button>
                  {showForceMove && (
                    <div className="border border-amber-500/30 bg-amber-500/10 rounded-lg p-3 space-y-2">
                      <p className="text-xs text-amber-400 font-medium">
                        ⚠ Check approval detected but not moved. Click below to force the transition.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full border-amber-500/30 text-amber-400 hover:bg-amber-500/20"
                        onClick={() => handleMoveToDeposited(true)}
                        disabled={movingToDeposited}
                      >
                        {movingToDeposited ? (
                          <><Loader2Icon className="h-4 w-4 mr-2 animate-spin" />Forcing...</>
                        ) : (
                          "Force Move to Deposited"
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {/* Approved → Deposited transition */}
              {check.status === "approved_for_deposit" && !isSharedView && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full mt-2 border-border text-foreground hover:bg-primary hover:text-primary-foreground"
                  onClick={() => handleMoveToDeposited(false)}
                  disabled={movingToDeposited}
                >
                  {movingToDeposited ? (
                    <><Loader2Icon className="h-4 w-4 mr-2 animate-spin" />Moving...</>
                  ) : (
                    <><CheckCircle2 className="h-4 w-4 mr-2" />Mark as Deposited</>
                  )}
                </Button>
              )}
              {check.claim_id && (
                <DetailRow label="Linked Claim" value={check.claim_id.slice(0, 8) + "..."} />
              )}
            </TabsContent>

            <TabsContent value="endorsements" className="p-4 mt-0 space-y-4">
              <Suspense fallback={<TabLoader />}>
                <EndorsementChecklist
                  checkId={checkId}
                  onRefresh={onRefresh}
                  partnerMode={isSharedView}
                />

              </Suspense>

              {check?.back_image_path && !isSharedView && (
                <>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    {backImageUrl && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => setShowEndorsementAdjuster((v) => !v)}
                      >
                        {showEndorsementAdjuster ? "Hide" : "Adjust"} Endorsement Position
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={async () => {
                        const nextShowPayToOrder = !showPayToOrder;
                        const nextOverride: EndorsementOverride = {
                          xPct: savedOverride?.xPct ?? 0.38,
                          yPct: savedOverride?.yPct ?? 0.5,
                          scale: savedOverride?.scale ?? 1,
                          rotationDeg: savedOverride?.rotationDeg ?? 0,
                          showPayToOrder: nextShowPayToOrder,
                        };

                        const { error: saveErr } = await supabase
                          .from("check_intake_items")
                          .update({
                            endorsement_override: nextOverride as any,
                            updated_at: new Date().toISOString(),
                          })
                          .eq("id", checkId);

                        if (saveErr) {
                          toast({
                            title: nextShowPayToOrder
                              ? "Failed to add pay to order text"
                              : "Failed to remove pay to order text",
                            description: saveErr.message,
                            variant: "destructive",
                          });
                          return;
                        }

                        qc.setQueryData(["check-detail", checkId], (current: CheckItem | undefined) => (
                          current
                            ? { ...current, endorsement_override: nextOverride as unknown as Record<string, unknown> }
                            : current
                        ));

                        try {
                          await ensureDepositReadyBackImage();
                        } catch (error) {
                          console.error("[CHECK-EXPORT] regenerate after pay-to-order toggle failed", error);
                        }

                        qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
                        toast({
                          title: nextShowPayToOrder
                            ? "Pay to Order text added"
                            : "Pay to Order text removed",
                        });
                      }}
                    >
                      {showPayToOrder ? "Remove Pay to Order Text" : "Add Pay to Order Text"}
                    </Button>
                  </div>

                  {showEndorsementAdjuster && backImageUrl && (
                    <Suspense fallback={<TabLoader />}>
                      <EndorsementAdjuster
                        checkId={checkId}
                        imageUrl={backImageUrl}
                        imageWidth={backImageDimensions.width}
                        imageHeight={backImageDimensions.height}
                        companyName="Freedom Adjustment"
                        initialOverride={
                          (check?.endorsement_override as unknown as EndorsementOverride | null) ?? null
                        }
                        onSave={async (ov) => {
                          console.log("[ENDORSEMENT-DEBUG] saving override", {
                            checkId,
                            override: ov,
                            userScale: ov.scale,
                            xPct: ov.xPct,
                            yPct: ov.yPct,
                            rotationDeg: ov.rotationDeg,
                          });
                          // 1) Save override to DB first
                          const { error: saveErr } = await supabase
                            .from("check_intake_items")
                            .update({
                              endorsement_override: ov as any,
                              updated_at: new Date().toISOString(),
                            })
                            .eq("id", checkId);
                          if (saveErr) throw saveErr;
                          qc.setQueryData(["check-detail", checkId], (current: CheckItem | undefined) => (
                            current
                              ? { ...current, endorsement_override: ov as unknown as Record<string, unknown> }
                              : current
                          ));
                          // 2) Then generate final deposit image (forces re-composite with latest override)
                          console.log("[ENDORSEMENT-DEBUG] triggering composite regeneration");
                          await ensureDepositReadyBackImage();
                          console.log("[ENDORSEMENT-DEBUG] composite regeneration complete, new composite generated");
                          toast({ title: "Endorsement saved & deposit image generated" });
                          setShowEndorsementAdjuster(false);
                          qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
                          qc.invalidateQueries({ queryKey: ["check-back-img"] });
                        }}
                      />
                    </Suspense>
                  )}
                </>
              )}
            </TabsContent>

            <TabsContent value="payees" className="p-4 space-y-3 mt-0">
              <PayeeManager checkId={checkId} payees={check.check_payees ?? []} readOnly={isSharedView} onRefresh={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); onRefresh(); }} />
            </TabsContent>

            <TabsContent value="funds" className="p-4 mt-0">
              {isOwner ? (
                contractorPartner ? (
                  <SendPaymentPanel
                    checkIntakeItemId={checkId}
                    checkAmount={Number(check.amount ?? 0)}
                    checkNumber={check.check_number ?? undefined}
                    carrierName={check.carrier_name ?? undefined}
                    contractorTenantId={contractorPartner.id}
                    contractorName={contractorPartner.name}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-6">
                    Share this check with a contractor partner first to send funds.
                  </p>
                )
              ) : (
                <IncomingFundsTab
                  checkIntakeItemId={checkId}
                  checkNumber={check.check_number ?? undefined}
                  carrierName={check.carrier_name ?? undefined}
                />
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
              <Suspense fallback={<TabLoader />}>
                <DepositPacketGenerator checkId={checkId} />
              </Suspense>
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

            <TabsContent value="partners" className="p-4 mt-0 space-y-4">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
                  Partner discussion
                </div>
                <Suspense fallback={<TabLoader />}>
                  <SharedCheckThread checkId={checkId} />
                </Suspense>
              </div>
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
                  Internal team notes
                </div>
                <Suspense fallback={<TabLoader />}>
                  <CheckMessageThread checkId={checkId} active={detailTab === "partners"} />
                </Suspense>
              </div>
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

function EndorsementPacketCard({ checkId, packetPath }: { checkId: string; packetPath: string | null }) {
  const { toast } = useToast();
  const [generating, setGenerating] = useState(false);
  const hasPacket = Boolean(packetPath);

  const handleDownload = async () => {
    if (!packetPath) return;
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
    if (!packetPath) return;
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
        {hasPacket ? "Endorsement Packet Ready" : "Generate Endorsement Packet"}
      </div>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" className="text-xs h-7 flex-1" onClick={handlePreview} disabled={!hasPacket || generating}>
          <Eye className="h-3 w-3 mr-1" />Preview
        </Button>
        <Button size="sm" variant="outline" className="text-xs h-7 flex-1" onClick={handleDownload} disabled={!hasPacket || generating}>
          <Download className="h-3 w-3 mr-1" />Download
        </Button>
        <Button size="sm" variant="ghost" className="text-xs h-7" onClick={handleRegenerate} disabled={generating}>
          <RefreshCw className={`h-3 w-3 mr-1 ${generating ? "animate-spin" : ""}`} />
          {hasPacket ? "Regen" : "Generate"}
        </Button>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="font-medium text-right break-words min-w-0 flex-1">{value ?? "—"}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Editable Amount                                                    */
/* ------------------------------------------------------------------ */

function EditableAmount({ checkId, currentAmount, onSave, readOnly = false }: { checkId: string; currentAmount: number | null; onSave: () => void; readOnly?: boolean }) {
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
      {!readOnly && (
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={() => { setValue(currentAmount?.toString() ?? ""); setEditing(true); }}
        >
          <Pencil className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Editable Field — generic inline editor for any check_intake_items column */
/* ------------------------------------------------------------------ */

function EditableField({
  label,
  checkId,
  field,
  value,
  inputType = "text",
  multiline = false,
  displayFormatter,
  onSave,
  readOnly = false,
}: {
  label: string;
  checkId: string;
  field: string;
  value: string | null;
  inputType?: "text" | "date" | "boolean";
  multiline?: boolean;
  displayFormatter?: (v: string | null) => string | null;
  onSave: () => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value ?? "");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  const persist = async () => {
    setSaving(true);
    try {
      let outValue: any;
      if (inputType === "boolean") {
        outValue = draft === "true";
      } else if (inputType === "date") {
        outValue = draft ? draft : null;
      } else {
        const trimmed = draft.trim();
        outValue = trimmed === "" ? null : trimmed;
      }

      const { error } = await supabase
        .from("check_intake_items")
        .update({ [field]: outValue, updated_at: new Date().toISOString() })
        .eq("id", checkId);
      if (error) throw error;

      toast({ title: `${label} updated` });
      setEditing(false);
      onSave();
    } catch (e: any) {
      toast({ title: `Failed to update ${label}`, description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const display = displayFormatter ? displayFormatter(value) : value;

  if (editing) {
    return (
      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="flex items-start gap-1.5">
          {inputType === "boolean" ? (
            <Select value={draft || "false"} onValueChange={setDraft}>
              <SelectTrigger className="h-8 text-sm flex-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="true">Yes</SelectItem>
                <SelectItem value="false">No</SelectItem>
              </SelectContent>
            </Select>
          ) : multiline ? (
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="flex-1 min-h-[60px] rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          ) : (
            <Input
              autoFocus
              type={inputType === "date" ? "date" : "text"}
              value={inputType === "date" && draft ? draft.slice(0, 10) : draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-8 text-sm flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter") persist();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          )}
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={persist} disabled={saving}>
            <CheckIcon className="h-4 w-4 text-emerald-400" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => { setDraft(value ?? ""); setEditing(false); }}>
            <X className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-between gap-2 text-sm group items-start">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <div className="flex items-start gap-1.5 min-w-0">
        <span className={`font-medium text-right break-words min-w-0 ${!display ? "text-destructive italic" : ""}`}>
          {display ?? "Missing"}
        </span>
        {!readOnly && (
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

const FUNDS_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "acv", label: "ACV (Actual Cash Value)" },
  { value: "rcv", label: "RCV (Replacement Cost Value)" },
  { value: "recoverable_depreciation", label: "Recoverable Depreciation" },
  { value: "supplement", label: "Supplement" },
  { value: "overhead_and_profit", label: "Overhead & Profit (O&P)" },
];

function FundsTypeField({
  checkId,
  value,
  readOnly = false,
  onSave,
}: {
  checkId: string;
  value: string | null;
  readOnly?: boolean;
  onSave: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const display = FUNDS_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? null;

  const persist = async (next: string | null) => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("check_intake_items")
        .update({ funds_type: next, updated_at: new Date().toISOString() })
        .eq("id", checkId);
      if (error) throw error;
      toast({ title: "Funds type updated" });
      onSave();
    } catch (e: any) {
      toast({ title: "Failed to update funds type", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (readOnly) {
    return (
      <div className="flex items-start justify-between gap-2 py-1.5 text-sm">
        <span className="text-xs text-muted-foreground shrink-0">Funds Type</span>
        <span className={`font-medium text-right ${!display ? "text-muted-foreground italic" : ""}`}>
          {display ?? "Not set"}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-2 py-1.5 text-sm">
      <span className="text-xs text-muted-foreground shrink-0 mt-2">Funds Type</span>
      <div className="min-w-0 flex-1 max-w-[60%]">
        <Select
          value={value ?? "__unset__"}
          onValueChange={(v) => persist(v === "__unset__" ? null : v)}
          disabled={saving}
        >
          <SelectTrigger className="h-8 text-sm">
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__unset__" className="text-xs text-muted-foreground">Not set</SelectItem>
            {FUNDS_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Payee Manager — add / edit / remove                                */
/* ------------------------------------------------------------------ */

function PayeeManager({ checkId, payees, onRefresh, readOnly = false }: { checkId: string; payees: CheckPayee[]; onRefresh: () => void; readOnly?: boolean }) {
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
        <EditablePayeeCard
          key={payee.id}
          payee={payee}
          checkId={checkId}
          onRefresh={onRefresh}
          onRemove={() => removePayee(payee.id)}
          readOnly={readOnly}
        />
      ))}
      {payees.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground text-center py-4">No payees detected yet</p>
      )}

      {!readOnly && (adding ? (
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
      ))}
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
  readOnly = false,
}: {
  payee: CheckPayee;
  checkId: string;
  onRefresh: () => void;
  onRemove: () => void;
  readOnly?: boolean;
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
          {!editing && !readOnly && (
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

      {payee.endorsement_status !== "signed" && payee.endorsement_status !== "rejected" && !editing && !readOnly && (
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

/* ------------------------------------------------------------------ */
/*  Help Step                                                          */
/* ------------------------------------------------------------------ */

function HelpStep({ step, title, description }: { step: number; title: string; description: string }) {
  return (
    <div className="flex gap-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold">
        {step}
      </div>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{description}</p>
      </div>
    </div>
  );
}
