import { Fragment, lazy, Suspense, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

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
  Sparkles, MessageSquare, ArrowLeft, ShieldAlert,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { toast as sonnerToast } from "sonner";
import { Pencil, Check as CheckIcon, X, Plus } from "lucide-react";
import { format } from "date-fns";

// Eager: default tab and inline panels
import { CheckReviewQueue, ReviewDecisionPanel } from "@/components/check-review/CheckReviewConsole";
import { CheckDashboardCards } from "@/components/check-review/CheckDashboardCards"; // kept for potential future use

import { usePermissions } from "@/hooks/usePermissions";
import { DepositImageViewer } from "@/components/checks/DepositImageViewer";
import { ViewCheckImageButton } from "@/components/checks/ViewCheckImageButton";
import { toStorageObjectPath } from "@/lib/storagePath";
import { AdminDeleteCheckButton } from "@/components/checks/AdminDeleteCheckButton";
import { ReuploadCheckImageButton } from "@/components/checks/ReuploadCheckImageButton";
import { CheckImageCropper } from "@/components/checks/CheckImageCropper";
import { EndorsementOverride } from "@/lib/endorsementLayout";
import { LossDraftDetailPanel } from "@/components/loss-draft/LossDraftDetailPanel";
import { ArrowDownToLine, FileBarChart } from "lucide-react";
// Help moved to Settings → ChecksOps Guide
import { ShareCheckDialog } from "@/components/check-review/ShareCheckDialog";
import { SharedChecksBadge } from "@/components/check-review/SharedChecksBadge";
import { DepositStatusPanel } from "@/components/check-review/DepositStatusPanel";
import { SignatureStatusPanel } from "@/components/check-review/SignatureStatusPanel";
import { ReviewSettlementTab } from "@/components/check-review/ReviewSettlementTab";
import { PostHomeownerUpdateCard } from "@/components/homeowner-ledger/PostHomeownerUpdateCard";
import { Share2 } from "lucide-react";
import { ShieldCheck } from "lucide-react";
import { CheckValidityBadge } from "@/components/checks/CheckValidityBadge";
import { assessCheckValidity } from "@/lib/checkValidity";
import { SendPaymentPanel } from "@/components/payments/SendPaymentPanel";
import { FundsTab as IncomingFundsTab } from "@/components/payments/FundsTab";
import { ClaimLedgerCard } from "@/components/payments/ClaimLedgerCard";




// Lazy-loaded: heavy tab-only / dialog-only modules (each becomes its own JS chunk)
const LossDraftDashboard = lazy(() =>
  import("@/components/loss-draft/LossDraftDashboard").then(m => ({ default: m.LossDraftDashboard }))
);
// Endorsement adjuster is a core operational action — load eagerly so the
// button responds instantly. Keeping it out of a lazy chunk avoids the
// intermittent "click does nothing" behavior when the chunk was slow to fetch.
import { EndorsementAdjuster } from "@/components/checks/EndorsementAdjuster";
import { prepareCheckAltDeposit } from "@/lib/prepareCheckAltDeposit";
import { SHOW_CHECKALT } from "@/lib/depositRails";
const preloadEndorsementAdjuster = () => Promise.resolve();
const EndorsementChecklist = lazy(() =>
  import("@/components/check-review/EndorsementChecklist").then(m => ({ default: m.EndorsementChecklist }))
);
const SharedCheckEndorsements = lazy(() =>
  import("@/components/check-review/SharedCheckEndorsements").then(m => ({ default: m.SharedCheckEndorsements }))
);
const SharedCheckPaymentDirection = lazy(() =>
  import("@/components/check-review/SharedCheckPaymentDirection").then(m => ({ default: m.SharedCheckPaymentDirection }))
);
const CheckFilesSection = lazy(() =>
  import("@/components/check-review/CheckFilesSection").then(m => ({ default: m.CheckFilesSection }))
);
// DTP status/badge moved into the Files tab — signed DTP PDFs live in check_files.
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
const HomeownerSubmittedChecksInbox = lazy(() =>
  import("@/components/homeowner-ledger/HomeownerSubmittedChecksInbox").then(m => ({ default: m.HomeownerSubmittedChecksInbox }))
);
const SendHomeownerUploadLink = lazy(() =>
  import("@/components/homeowner-ledger/SendHomeownerUploadLink").then(m => ({ default: m.SendHomeownerUploadLink }))

);
const MortgageCompaniesDirectory = lazy(() =>
  import("@/components/checks/MortgageCompaniesDirectory").then(m => ({ default: m.MortgageCompaniesDirectory }))
);
const PendingApprovalDeposits = lazy(() =>
  import("@/components/settings/CheckAltSettings").then(m => ({ default: m.PendingApprovalDeposits }))
);
const CheckAltDepositHistory = lazy(() =>
  import("@/components/settings/CheckAltSettings").then(m => ({ default: m.CheckAltDepositHistory }))
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
  contact_phone: string | null; // SMS removed from endorsements
  notification_sent_via: string | null;
  notification_sent_at: string | null;
  endorsed_at: string | null;
}

interface CheckAltDepositSummary {
  id: string;
  status: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  updated_at: string | null;
  last_status_payload?: Record<string, unknown> | null;
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
  expiration_days: number | null;
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
  check_stage?: string | null;
  updated_at?: string | null;
  check_payees?: CheckPayee[];
  checkalt_deposits?: CheckAltDepositSummary[];
  partner_status?: string | null;
  partner_status_label?: string | null;
  partner_status_updated_at?: string | null;
  external_origin?: Record<string, unknown> | null;
  check_source?: string | null;
  cash_job_id?: string | null;
  cash_job_payment_class?: string | null;
}

interface CheckEndorsementSummary {
  id: string;
  payee_name: string;
  payee_type: string;
  status: string;
  signature_image_url?: string | null;
  signature_method?: string | null;
  signed_at: string | null;
}

const normalizeEndorsementName = (value?: string | null) => (value ?? "").trim().toLowerCase();
const normalizeEndorsementType = (value?: string | null) => (value ?? "other").trim().toLowerCase();

const normalizeEndorsementStatus = (status?: string | null, signedAt?: string | null) => {
  if (signedAt) return "signed";

  const value = (status ?? "").trim().toLowerCase();
  if (["signed", "endorsed", "complete", "completed"].includes(value)) return "signed";
  if (value === "waived") return "waived";
  if (value === "manual_required") return "manual_required";
  if (["declined", "rejected"].includes(value)) return "rejected";
  if (["sent", "requested", "awaiting", "in_progress", "viewed", "opened"].includes(value)) return "sent";
  if (value === "expired") return "expired";
  return "pending";
};

function mergeEndorsementSummaryRows(
  checkId: string,
  endorsements: CheckEndorsementSummary[],
  payees: CheckPayee[],
): CheckEndorsementSummary[] {
  if (payees.length === 0) return endorsements;

  const usedEndorsementIds = new Set<string>();
  const byExactKey = new Map<string, CheckEndorsementSummary[]>();
  const byName = new Map<string, CheckEndorsementSummary[]>();

  for (const endorsement of endorsements) {
    const exactKey = `${normalizeEndorsementName(endorsement.payee_name)}::${normalizeEndorsementType(endorsement.payee_type)}`;
    const nameKey = normalizeEndorsementName(endorsement.payee_name);
    byExactKey.set(exactKey, [...(byExactKey.get(exactKey) ?? []), endorsement]);
    byName.set(nameKey, [...(byName.get(nameKey) ?? []), endorsement]);
  }

  const merged: CheckEndorsementSummary[] = [];

  payees.forEach((payee) => {
    const exactKey = `${normalizeEndorsementName(payee.payee_name)}::${normalizeEndorsementType(payee.payee_type)}`;
    const nameKey = normalizeEndorsementName(payee.payee_name);
    const match =
      byExactKey.get(exactKey)?.find((row) => !usedEndorsementIds.has(row.id)) ??
      byName.get(nameKey)?.find((row) => !usedEndorsementIds.has(row.id));

    if (match) {
      usedEndorsementIds.add(match.id);
      merged.push(match);
    } else {
      merged.push({
        id: `payee-${checkId}-${payee.id}`,
        payee_name: payee.payee_name,
        payee_type: payee.payee_type ?? "other",
        status: normalizeEndorsementStatus(payee.endorsement_status, payee.endorsed_at),
        signed_at: payee.endorsed_at,
        signature_image_url: null,
        signature_method: null,
      });
    }
  });

  for (const endorsement of endorsements) {
    if (!usedEndorsementIds.has(endorsement.id)) merged.push(endorsement);
  }

  return merged;
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

// Lifecycle rank — higher = further along. Used to prefer whichever of local
// status vs mirrored partner_status is most advanced, so a stale partner value
// can never mask completed local work (e.g. endorsements finished here but the
// origin app never pushed an update).
const lifecycleRank = (s: string | null | undefined): number => {
  switch ((s || "").toLowerCase()) {
    case "deposited":
    case "released":
      return 50;
    case "approved_for_deposit":
    case "endorsed":
      return 40;
    case "endorsements_in_progress":
    case "endorsement_pending":
      return 30;
    case "loss_draft_required":
      return 25;
    case "needs_review":
    case "in_review":
    case "ocr_complete":
      return 20;
    case "held":
      return 15;
    case "received":
    case "processing":
    case "uploaded":
      return 10;
    case "voided":
    case "returned":
      return 5;
    default:
      return 0;
  }
};

const getEffectiveStatus = (c: CheckItem): string => {
  if (isMirroredCheck(c) && c.partner_status) {
    // Prefer local on ties so completed local work (e.g. "deposited") is never
    // masked by an equivalent-rank partner value (e.g. "released").
    return lifecycleRank(c.status) >= lifecycleRank(c.partner_status)
      ? c.status
      : c.partner_status;
  }
  return c.status;
};

const prettifyStatus = (s: string | null | undefined): string => {
  if (!s) return "";
  // Unify "approved_for_deposit" and "ready_for_deposit" under one label/wording.
  if (s === "approved_for_deposit" || s === "ready_for_deposit" || s === "ready") {
    return "Ready for Deposit";
  }
  // "released" from partner systems means the check itself was deposited
  // (funds released from check to bank). Don't conflate with disbursement.
  if (s === "released" || s === "deposited") {
    return "Deposited";
  }
  return s.replace(/_/g, " ");
};

const getEffectiveStatusLabel = (c: CheckItem): string => {
  if (isMirroredCheck(c) && c.partner_status) {
    const useLocal = lifecycleRank(c.status) >= lifecycleRank(c.partner_status);
    if (useLocal) return prettifyStatus(c.status);
    return c.partner_status_label
      ? prettifyStatus(c.partner_status)
      : prettifyStatus(c.partner_status);
  }
  return prettifyStatus(c.status);
};

const getLatestCheckAltDeposit = (c: CheckItem): CheckAltDepositSummary | null => {
  const deposits = c.checkalt_deposits ?? [];
  if (deposits.length === 0) return null;
  return [...deposits].sort((a, b) => {
    const aTime = new Date(a.updated_at ?? a.approved_at ?? a.submitted_at ?? 0).getTime();
    const bTime = new Date(b.updated_at ?? b.approved_at ?? b.submitted_at ?? 0).getTime();
    return bTime - aTime;
  })[0] ?? null;
};

const getCheckAltStatus = (c: CheckItem): string | null => getLatestCheckAltDeposit(c)?.status ?? null;

// Per-tab status label overrides requested by ops:
//  - Endorsing tab: always "Endorsements in Progress"
//  - Ready for Deposit tab: always "Endorsed - Ready for Deposit"
//  - Deposited tab: "Deposit in Progress" for first 48h after deposited_at,
//    then "Ready for Release" (funds presumed cleared in the bank account).
const getTabStatusLabel = (c: CheckItem, tab: string): string => {
  if (tab === "endorsements") return "Endorsements in Progress";
  if (tab === "ready") return "Endorsed - Ready for Deposit";
  if (tab === "deposited") {
    if (getCheckAltStatus(c) === "pending_approval") return "Pending Approval";
    const depositedAt = (c as any).deposited_at as string | null | undefined;
    if (!depositedAt) return "Deposit in Progress";
    const hours = (Date.now() - new Date(depositedAt).getTime()) / 36e5;
    return hours >= 48 ? "Ready for Release" : "Deposit in Progress";
  }
  return getEffectiveStatusLabel(c);
};

const getTabStatusClass = (c: CheckItem, tab: string): string => {
  if (tab === "deposited") {
    if (getCheckAltStatus(c) === "pending_approval") return "bg-amber-500/20 text-amber-400";
    const depositedAt = c.deposited_at;
    if (depositedAt) {
      const hours = (Date.now() - new Date(depositedAt).getTime()) / 36e5;
      if (hours >= 48) return "bg-emerald-500/20 text-emerald-400";
    }
    return "bg-primary/20 text-primary";
  }
  return statusColors[getEffectiveStatus(c)] ?? "";
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
  other: AlertTriangle,
};

const endorsementColors: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  viewed: "bg-blue-500/20 text-blue-400",
  signed: "bg-emerald-500/20 text-emerald-400",
  waived: "bg-emerald-500/20 text-emerald-400",
  rejected: "bg-red-500/20 text-red-400",
  expired: "bg-muted text-muted-foreground line-through",
};

// "Waived" means the signature is physically on the check — show it as Endorsed.
const endorsementStatusLabel = (status?: string | null): string => {
  const v = (status ?? "").toLowerCase();
  if (v === "waived" || v === "signed") return "Endorsed";
  return status ?? "pending";
};

/* ------------------------------------------------------------------ */
/*  Class filter + total bar (shared)                                  */
/* ------------------------------------------------------------------ */

function ClassFilterBar<T>({
  classFilter,
  setClassFilter,
  items,
  getFundsType,
  getAmount,
  itemLabel = "check",
}: {
  classFilter: string;
  setClassFilter: (v: string) => void;
  items: T[];
  getFundsType: (item: T) => string | null | undefined;
  getAmount: (item: T) => number;
  itemLabel?: string;
}) {
  const counts = new Map<string, { count: number; total: number }>();
  items.forEach((it) => {
    const key = getFundsType(it) ?? "unclassified";
    const e = counts.get(key) ?? { count: 0, total: 0 };
    e.count += 1;
    e.total += getAmount(it) || 0;
    counts.set(key, e);
  });
  const visible = classFilter === "all"
    ? items
    : items.filter((it) => (getFundsType(it) ?? "unclassified") === classFilter);
  const visibleTotal = visible.reduce((s, it) => s + (getAmount(it) || 0), 0);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 bg-muted/30">
      <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Class</span>
      <Select value={classFilter} onValueChange={setClassFilter}>
        <SelectTrigger className="h-7 w-[220px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All classes ({items.length})</SelectItem>
          {FUNDS_TYPE_OPTIONS.map((o) => {
            const c = counts.get(o.value);
            if (!c) return null;
            return (
              <SelectItem key={o.value} value={o.value}>
                {o.label} ({c.count})
              </SelectItem>
            );
          })}
          {counts.has("unclassified") && (
            <SelectItem value="unclassified">
              Unclassified ({counts.get("unclassified")!.count})
            </SelectItem>
          )}
        </SelectContent>
      </Select>
      {classFilter !== "all" && (
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setClassFilter("all")}>
          Clear
        </Button>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">
          {visible.length} {itemLabel}{visible.length === 1 ? "" : "s"}
        </span>
        <span className="font-semibold tabular-nums text-foreground">
          Total: ${visibleTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
    </div>
  );
}

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
  const [classFilter, setClassFilter] = useState<string>("all");
  const [selectedCheck, setSelectedCheck] = useState<string | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [reviewCheckId, setReviewCheckId] = useState<string | null>(null);
  // helpOpen state removed — help moved to Settings → ChecksOps Guide
  const [shareCheckId, setShareCheckId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  // Phase 9: deposited history is fetched in its own paginated query so the
  // main active-queue query never blows past its 2,000-row cap on tenants
  // with hundreds of thousands of historical deposits. Images stay forever.
  const DEPOSITED_PAGE_SIZE = 200;
  const [depositedLimit, setDepositedLimit] = useState(DEPOSITED_PAGE_SIZE);

  const toggleBulk = useCallback((id: string) => {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const clearBulk = useCallback(() => setBulkSelected(new Set()), []);

  // Phase 3 + 5: Prefetch check detail on hover/focus so the panel opens
  // instantly. Phase 5 extends this to warm the endorsement summary, audit
  // log, and signed image URLs so images and signatures render without a
  // spinner too.
  const prefetchedDetailRef = useRef<Map<string, number>>(new Map());
  const prefetchCheckDetail = useCallback((id: string) => {
    if (!id) return;
    // Skip if we've prefetched this check in the last 20s — avoids thrashing
    // during scroll/hover flurries.
    const last = prefetchedDetailRef.current.get(id) ?? 0;
    const now = Date.now();
    if (now - last < 20_000) return;
    prefetchedDetailRef.current.set(id, now);

    // 1) Main detail row (payees + deposit status).
    const detailP = qc.prefetchQuery({
      queryKey: ["check-detail", id],
      queryFn: async () => {
        const { data, error } = await supabase
          .from("check_intake_items")
          .select("*, check_payees(*), checkalt_deposits(id, status, submitted_at, approved_at, updated_at, last_status_payload)")
          .eq("id", id)
          .single();
        if (error) throw error;
        return data;
      },
      staleTime: 15_000,
    });

    // 2) Endorsement summary — merged endorsements + payees for the banner.
    qc.prefetchQuery({
      queryKey: ["check-endorsements-summary", id],
      queryFn: async () => {
        const [{ data: endorsementData, error: endorsementError }, { data: payeeData, error: payeeError }] = await Promise.all([
          supabase
            .from("check_endorsements")
            .select("id, payee_name, payee_type, status, signature_image_url, signature_method, signed_at")
            .eq("check_id", id),
          supabase
            .from("check_payees")
            .select("id, payee_name, payee_type, endorsement_status, endorsed_at, contact_email, contact_phone, notification_sent_via, notification_sent_at")
            .eq("check_id", id),
        ]);
        if (endorsementError) throw endorsementError;
        if (payeeError) throw payeeError;
        return mergeEndorsementSummaryRows(
          id,
          (endorsementData ?? []) as CheckEndorsementSummary[],
          (payeeData ?? []) as CheckPayee[],
        );
      },
      staleTime: 15_000,
    });

    // 3) Audit history for the timeline.
    qc.prefetchQuery({
      queryKey: ["check-audit", id],
      queryFn: async () => {
        const { data } = await supabase
          .from("check_audit_log")
          .select("*")
          .eq("check_id", id)
          .order("created_at", { ascending: false });
        return (data ?? []) as AuditEntry[];
      },
      staleTime: 15_000,
    });

    // 4) Signed URLs for front/back images — once the detail row lands so we
    //    know the storage paths. Owner-only path (skip shared checks; those
    //    go through an edge function on open).
    detailP.then(() => {
      const row = qc.getQueryData<any>(["check-detail", id]);
      if (!row) return;
      const rowTenant = row.tenant_id as string | null | undefined;
      const ownerView = !!tenantId && !!rowTenant && rowTenant === tenantId;
      if (!ownerView) return;
      const front = row.front_image_path as string | null | undefined;
      const back = row.back_image_path as string | null | undefined;
      if (front) {
        qc.prefetchQuery({
          queryKey: ["check-front-img", front],
          queryFn: async () => {
            const p = toStorageObjectPath(front);
            if (!p) return null;
            const { data } = await supabase.storage.from("claim-files").createSignedUrl(p, 3600);
            return data?.signedUrl ?? null;
          },
          staleTime: 5 * 60_000,
        });
      }
      if (back) {
        qc.prefetchQuery({
          queryKey: ["check-back-img", back],
          queryFn: async () => {
            const p = toStorageObjectPath(back);
            if (!p) return null;
            const { data } = await supabase.storage.from("claim-files").createSignedUrl(p, 3600);
            return data?.signedUrl ?? null;
          },
          staleTime: 5 * 60_000,
        });
      }
    }).catch(() => { /* prefetch is best-effort */ });
  }, [qc, tenantId]);
  const runBulkDecision = useCallback(async (path: string, label: string) => {
    if (!user?.id || bulkSelected.size === 0) return;
    setBulkRunning(true);
    const ids = Array.from(bulkSelected);
    const idSet = new Set(ids);

    // Phase 3: Optimistic update — move checks to the target stage immediately
    // in the queue cache, then roll back any rows that fail server-side.
    const queueKey = ["check-intake-items", tenantId] as const;
    const previous = qc.getQueryData<any[]>(queueKey);
    if (previous) {
      qc.setQueryData<any[]>(queueKey, (curr) =>
        (curr ?? []).map((c: any) => (idSet.has(c.id) ? { ...c, check_stage: path, status: path } : c)),
      );
    }

    let ok = 0; const failed: string[] = []; const failedIds: string[] = [];
    for (const id of ids) {
      const { error } = await supabase.rpc("submit_check_review_decision_safe", {
        p_check_id: id,
        p_reviewer_id: user.id,
        p_deposit_path: path,
        p_reviewer_notes: `Bulk decision: ${label}`,
      });
      if (error) { failed.push(error.message); failedIds.push(id); } else ok++;
    }
    setBulkRunning(false);
    if (failed.length === 0) {
      sonnerToast.success(`${ok} check${ok === 1 ? "" : "s"} moved to ${label}`);
    } else {
      // Roll back failed rows to their prior state
      if (previous) {
        const prevById = new Map(previous.map((c: any) => [c.id, c]));
        qc.setQueryData<any[]>(queueKey, (curr) =>
          (curr ?? []).map((c: any) => (failedIds.includes(c.id) ? (prevById.get(c.id) ?? c) : c)),
        );
      }
      sonnerToast.error(`${ok} succeeded, ${failed.length} failed. ${failed[0] ?? ""}`);
    }
    clearBulk();
    qc.invalidateQueries({ queryKey: ["check-intake-items"] });
    qc.invalidateQueries({ queryKey: ["check-review-queue"] });
    qc.invalidateQueries({ queryKey: ["check-dashboard-counts"] });
  }, [bulkSelected, user?.id, clearBulk, qc, tenantId]);

  // On mobile, scroll to top when a check is opened or review check is opened
  useEffect(() => {
    if (isMobile && (selectedCheck || reviewCheckId)) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [selectedCheck, reviewCheckId, isMobile]);

  // Realtime: reflect check status/stage changes immediately without manual refresh.
  // Phase 6: Debounce invalidations so bursts of events (bulk decisions,
  // webhook fan-out, endorsement composites) coalesce into a single refetch
  // instead of hammering the queue query.
  useEffect(() => {
    if (!tenantId) return;

    const pending = new Set<string>();
    const pendingDetailIds = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      const keys = Array.from(pending);
      pending.clear();
      const ids = Array.from(pendingDetailIds);
      pendingDetailIds.clear();
      for (const k of keys) {
        if (k === "loss-draft-counts") {
          qc.invalidateQueries({ queryKey: ["loss-draft-counts", tenantId] });
        } else {
          qc.invalidateQueries({ queryKey: [k] });
        }
      }
      for (const id of ids) {
        qc.invalidateQueries({ queryKey: ["check-detail", id] });
      }
    };
    const schedule = (keys: string[], detailId?: string | null) => {
      for (const k of keys) pending.add(k);
      if (detailId) pendingDetailIds.add(detailId);
      if (timer) return;
      timer = setTimeout(flush, 250);
    };

    const channel = supabase
      .channel(`check-command-center-${tenantId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "check_intake_items", filter: `tenant_id=eq.${tenantId}` },
        (payload: any) => {
          const id = payload?.new?.id ?? payload?.old?.id;
          schedule(
            ["check-intake-items", "check-review-queue", "check-dashboard-counts", "loss-draft-counts"],
            id,
          );
        }
      )
      // NOTE: check_endorsements has no tenant_id, so we don't subscribe here.
      // The per-check detail view (CheckDetailPanel) subscribes scoped by check_id.
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "check_files", filter: `tenant_id=eq.${tenantId}` },
        () => {
          schedule(["check-intake-items", "check-review-queue", "check-dashboard-counts"]);
        }
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [tenantId, qc]);

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
      // Phase 7 perf: explicit slim projection. `SELECT *` on check_intake_items
      // pulls 63 columns per row including large jsonb blobs (raw_ocr_front /
      // raw_ocr_back can be 20-80KB each, plus endorsement_render_meta and
      // encrypted routing/account fields). At 100k+ checks per tenant that
      // payload is what times the queue query out. Enumerate only what the
      // queue UI actually reads; the detail panel refetches the full row.
      const t0 = performance.now();
      const queueColumns = [
        "id",
        "claim_id",
        "tenant_id",
        "front_image_path",
        "back_image_path",
        "carrier_name",
        "check_number",
        "amount",
        "issue_date",
        "expiration_days",
        "detected_claim_number",
        "payee_line",
        "is_multi_payee",
        "ocr_status",
        "deposit_recommendation",
        "deposit_recommendation_reasons",
        "status",
        "check_stage",
        "created_at",
        "updated_at",
        "uploaded_by",
        "reviewed_by",
        "reviewed_at",
        "review_notes",
        "endorsement_packet_path",
        "endorsement_override",
        "funds_type",
        "property_address",
        "payment_classification",
        "payee_address",
        "deposited_at",
        "deposited_by_tenant_id",
        "partner_status",
        "partner_status_label",
        "partner_status_updated_at",
        "external_origin",
        "check_source",
        "cash_job_id",
        "cash_job_payment_class",
      ].join(", ");
      const { data, error } = await supabase
        .from("check_intake_items")
        .select(
          `${queueColumns}, check_payees(payee_name, payee_type, endorsement_status), checkalt_deposits(id, status, submitted_at, approved_at, updated_at)`,
        )
        .eq("tenant_id", tenantId!)
        // Phase 9: exclude deposited from active queue; loaded separately below.
        .or("check_stage.is.null,check_stage.neq.deposited")
        .order("created_at", { ascending: false })
        .limit(2000);
      if (error) throw error;
      if (import.meta.env.DEV) {
        console.log(
          `[perf] check-queue fetched ${data?.length ?? 0} rows in ${(performance.now() - t0).toFixed(0)}ms`,
        );
      }
      return (data ?? []) as unknown as CheckItem[];
    },
    enabled: !!tenantId,
    refetchOnWindowFocus: false, // Prevent page jump/refresh when switching tabs
  });

  // Phase 9: paginated deposited-checks history. Loaded only when the
  // Deposited tab is active. Uses the partial index on
  // (tenant_id, deposited_at DESC) WHERE check_stage='deposited'.
  const { data: depositedRows = [], isFetching: isFetchingDeposited } = useQuery({
    queryKey: ["check-intake-items-deposited", tenantId, depositedLimit],
    enabled: !!tenantId && activeTab === "deposited",
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    queryFn: async () => {
      const queueColumns = [
        "id","claim_id","tenant_id","front_image_path","back_image_path",
        "carrier_name","check_number","amount","issue_date","expiration_days",
        "detected_claim_number","payee_line","is_multi_payee","ocr_status",
        "deposit_recommendation","deposit_recommendation_reasons","status",
        "check_stage","created_at","updated_at","uploaded_by","reviewed_by",
        "reviewed_at","review_notes","endorsement_packet_path","endorsement_override",
        "funds_type","property_address","payment_classification","payee_address",
        "deposited_at","deposited_by_tenant_id","partner_status","partner_status_label",
        "partner_status_updated_at","external_origin","check_source","cash_job_id",
        "cash_job_payment_class",
      ].join(", ");
      const { data, error } = await supabase
        .from("check_intake_items")
        .select(
          `${queueColumns}, check_payees(payee_name, payee_type, endorsement_status), checkalt_deposits(id, status, submitted_at, approved_at, updated_at)`,
        )
        .eq("tenant_id", tenantId!)
        .eq("check_stage", "deposited")
        .order("deposited_at", { ascending: false, nullsFirst: false })
        .order("updated_at", { ascending: false })
        .limit(depositedLimit);
      if (error) throw error;
      return (data ?? []) as unknown as CheckItem[];
    },
  });

  // Phase 8 (high-scale aggregates): pull true per-lane counts and totals from
  // an RPC so tab badges stay accurate even when a tenant has more than the
  // 2,000 rows the queue query loads. Falls back gracefully if the RPC errors.
  const { data: stageTotals } = useQuery({
    queryKey: ["check-stage-totals", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_check_stage_totals", {
        p_tenant_id: tenantId!,
      });
      if (error) throw error;
      const map = new Map<string, { count: number; total: number }>();
      for (const row of (data ?? []) as Array<{ stage: string; count: number; total_amount: number }>) {
        map.set(row.stage, { count: Number(row.count) || 0, total: Number(row.total_amount) || 0 });
      }
      return map;
    },
    enabled: !!tenantId,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
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
        .select(
          "*, check_payees(payee_name, payee_type, endorsement_status), checkalt_deposits(id, status, submitted_at, approved_at, updated_at)",
        )
        .in("id", checkIds)
        .order("created_at", { ascending: false });
      if (checkErr) throw checkErr;

      const shareMap = new Map(sharedData.map((s: any) => [s.check_id, s.tenants?.name ?? "Partner"]));
      return (checkData ?? []).map((c: any) => ({
        ...c,
        _shared: true,
        _sourceTenantName: shareMap.get(c.id) ?? "Partner",
      })) as unknown as (CheckItem & { _shared: true; _sourceTenantName: string })[];
    },
    enabled: !!tenantId,
    refetchOnWindowFocus: false, // Prevent page jump when switching tabs
  });

  // Realtime: when the source tenant updates a shared check (e.g. marks it
  // deposited), invalidate the partner's shared-checks list so the new status
  // shows up without a manual refresh.
  useEffect(() => {
    if (!tenantId || sharedChecks.length === 0) return;
    const ids = sharedChecks.map((c) => c.id);
    const channel = supabase
      .channel(`shared-checks-${tenantId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "check_intake_items", filter: `id=in.(${ids.join(",")})` },
        () => {
          qc.invalidateQueries({ queryKey: ["shared-with-me-checks", tenantId] });
          qc.invalidateQueries({ queryKey: ["check-detail"] });
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [tenantId, sharedChecks.map((c) => c.id).join(","), qc]);

  // Fetch claim numbers + policyholder names for any linked claims so search works on them
  const linkedClaimIds = useMemo(() => {
    const ids = new Set<string>();
    checks.forEach((c) => { if (c.claim_id) ids.add(c.claim_id); });
    sharedChecks.forEach((c) => { if (c.claim_id) ids.add(c.claim_id); });
    return Array.from(ids);
  }, [checks, sharedChecks]);

  // Always keep allChecks sorted newest-first by created_at so any list
  // derived from it (every tab, search results, ungrouped fallbacks) renders
  // the most recently uploaded check at the top.
  const allChecks = useMemo(
    () => {
      const seen = new Set<string>();
      const merged: CheckItem[] = [];
      for (const c of [...checks, ...sharedChecks, ...depositedRows]) {
        if (!c?.id || seen.has(c.id)) continue;
        seen.add(c.id);
        merged.push(c);
      }
      return merged.sort(
        (a, b) =>
          new Date(b.created_at ?? 0).getTime() -
          new Date(a.created_at ?? 0).getTime(),
      );
    },
    [checks, sharedChecks, depositedRows],
  );

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
      // Only show checks the reviewer has explicitly routed to Endorsing.
      // deposit_recommendation === "endorsements_pending" is just an AI hint
      // surfaced inside the Review console — it must NOT auto-bucket checks
      // into Endorsing before a reviewer has approved that path.
      return s === "endorsements_in_progress" && matchesSearch(c);
    },
  );
  const readyForDeposit = allChecks.filter(
    (c) => {
      const s = getEffectiveStatus(c);
      const stage = c.check_stage;
      if (stage === "deposited" || getCheckAltStatus(c) === "pending_approval") return false;
      return (s === "approved_for_deposit" ||
        (c.deposit_recommendation === "ready_for_deposit" && s !== "deposited")) &&
        matchesSearch(c);
    },
  );
  const needsReview = allChecks.filter(
    (c) => {
      const s = getEffectiveStatus(c);

      const stage = (c as any).check_stage as string | undefined;
      // Exclude checks already routed to a downstream stage (loss draft, reissue,
      // branch, deposited, endorsing) so they don't double-list in Review.
      if (
        stage === "loss_draft" ||
        stage === "reissue" ||
        stage === "branch" ||
        stage === "deposited" ||
        stage === "endorsing" ||
        s === "loss_draft_required" ||
        s === "reissue_requested" ||
        s === "branch_deposit_required" ||
        s === "deposited" ||
        s === "endorsements_in_progress" ||
        s === "approved_for_deposit"
      ) {
        return false;
      }


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
  const depositedFromAll = allChecks.filter((c) => {
    const s = getEffectiveStatus(c);
    const stage = c.check_stage;
    const checkAltStatus = getCheckAltStatus(c);
    // Once funds have been disbursed, the check belongs in the Funds Released
    // tab — do NOT show it in Deposited anymore.
    if (stage === "funds_released") return false;
    return (s === "deposited" || stage === "deposited" || checkAltStatus === "pending_approval") && matchesSearch(c);
  });
  // On the Deposited tab, merge the paginated owned deposited rows with any
  // shared/pending-approval checks so the visible list matches the badge count.
  const depositedChecks = (() => {
    if (activeTab !== "deposited") return depositedFromAll;
    // Re-check the stage when consuming the cached page. A realtime release can
    // arrive before this paginated query refetches; never let a stale deposited
    // row keep a funds-released check visible in this lane.
    const ownedFiltered = (depositedRows as CheckItem[]).filter(
      (c) => c.check_stage !== "funds_released" && matchesSearch(c),
    );
    const ownedIds = new Set(ownedFiltered.map((c) => c.id));
    const extras = depositedFromAll.filter((c) => !ownedIds.has(c.id));
    return [...ownedFiltered, ...extras];
  })();


  const lossDraftChecks = allChecks.filter((c) => {
    const s = getEffectiveStatus(c);
    const stage = (c as any).check_stage as string | undefined;
    return (stage === "loss_draft" || s === "loss_draft_required") && matchesSearch(c);
  });


  const rawFilteredChecks =
    activeTab === "endorsements" ? awaitingEndorsement
    : activeTab === "ready" ? readyForDeposit
    : activeTab === "review" ? needsReview
    : activeTab === "deposited" ? depositedChecks
    : activeTab === "reissue" ? reissueRequested
    : allChecks.filter(matchesSearch);

  const filteredChecks = classFilter === "all"
    ? rawFilteredChecks
    : rawFilteredChecks.filter((c) => (c.funds_type ?? "unclassified") === classFilter);

  const classFilterCounts = (() => {
    const counts = new Map<string, { count: number; total: number }>();
    for (const c of rawFilteredChecks) {
      const key = c.funds_type ?? "unclassified";
      const entry = counts.get(key) ?? { count: 0, total: 0 };
      entry.count += 1;
      entry.total += c.amount ?? 0;
      counts.set(key, entry);
    }
    return counts;
  })();

  const filteredCumulativeTotal = filteredChecks.reduce((s, c) => s + (c.amount ?? 0), 0);

  const buildCheckGroups = useCallback((items: CheckItem[]) => {
    const groups = new Map<string, CheckGroup>();

    items.forEach((check) => {
      const linked = check.claim_id ? claimLookup.get(check.claim_id) : null;
      const claimNumber = linked?.claim_number || check.detected_claim_number || "Unlinked claim";
      const insuredPayee = check.check_payees?.find((p) => p.payee_type === "insured")?.payee_name;
      const parsedInsured = extractInsuredName(check.payee_line);
      const policyholderName = linked?.policyholder_name || insuredPayee || parsedInsured || "Unknown insured";
      // Group strictly by claim number so every check tied to the same claim #
      // appears under one file. Unlinked checks stay separate (keyed by id).
      const hasClaim = !!(linked?.claim_number || check.detected_claim_number);
      const key = hasClaim
        ? `claim::${claimNumber.trim().toLowerCase()}`
        : `unlinked::${check.id}`;
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

    const sorted = Array.from(groups.values()).sort(
      (a, b) => new Date(b.latestCreatedAt).getTime() - new Date(a.latestCreatedAt).getTime(),
    );
    // Newest check always at the top within each group, regardless of how
    // items were iterated when building the group.
    sorted.forEach((g) => {
      g.checks.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    });
    return sorted;
  }, [claimLookup]);


  const groupedFilteredChecks = useMemo<CheckGroup[]>(() => buildCheckGroups(filteredChecks as CheckItem[]), [buildCheckGroups, filteredChecks]);

  // Phase 4: flatten grouped queue into a single item list for virtualization.
  type FlatQueueItem =
    | { kind: "header"; group: CheckGroup; key: string }
    | { kind: "row"; group: CheckGroup; check: CheckItem; key: string };
  const flatQueueItems = useMemo<FlatQueueItem[]>(() => {
    const out: FlatQueueItem[] = [];
    for (const g of groupedFilteredChecks) {
      out.push({ kind: "header", group: g, key: `${g.key}-h` });
      for (const c of g.checks) out.push({ kind: "row", group: g, check: c, key: c.id });
    }
    return out;
  }, [groupedFilteredChecks]);
  const VIRTUALIZE_THRESHOLD = 100;
  const shouldVirtualizeQueue = flatQueueItems.length > VIRTUALIZE_THRESHOLD;
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const queueVirtualizer = useVirtualizer({
    count: flatQueueItems.length,
    getScrollElement: () => queueScrollRef.current,
    estimateSize: (i) => (flatQueueItems[i]?.kind === "header" ? 64 : 68),
    overscan: 12,
    measureElement: (el) => el?.getBoundingClientRect().height ?? 68,
  });

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

  // Funds released — disbursement splits that have settled (funds delivered to recipient)
  const { data: fundsReleased = [] } = useQuery({
    queryKey: ["funds-released", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("disbursement_splits")
        .select(`
          id, amount, settled_at, recipient_name, method, external_check_number,
          stakeholder_accounts (nickname, custname),
          disbursement_batches (
            id, check_intake_item_id,
            check_intake_items:check_intake_item_id (
              check_number, carrier_name, property_address, funds_type, amount,
              claim_id, detected_claim_number, payee_line,
              claims:claim_id ( claim_number, policyholder_name )
            )
          )
        `)

        .eq("tenant_id", tenantId!)
        .eq("status", "settled")
        .order("settled_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!tenantId,
    refetchInterval: 60_000,
  });

  // Funds received — settled disbursement splits paid TO this tenant by another
  // tenant. Uses a backend helper so recipient tenants can see the same check
  // context as Funds Released even when the split was paid by name only.
  const { data: fundsReceived = [] } = useQuery({
    queryKey: ["funds-received", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_tenant_funds_received" as any, {
        _tenant_id: tenantId!,
      });

      if (error) throw error;

      return ((data ?? []) as any[]).map((row) => ({
        id: row.id,
        amount: row.amount,
        settled_at: row.settled_at,
        created_at: row.created_at,
        recipient_name: row.recipient_name,
        method: row.method,
        external_check_number: row.external_check_number,
        tenant_id: row.tenant_id,
        sender: { name: row.sender_name },
        disbursement_batches: {
          check_intake_item_id: row.check_intake_item_id,
          check_intake_items: {
            id: row.check_intake_item_id,
            check_number: row.check_number,
            carrier_name: row.carrier_name,
            property_address: row.property_address,
            funds_type: row.funds_type,
            amount: row.check_amount,
            claim_id: row.claim_id,
            detected_claim_number: row.detected_claim_number,
            payee_line: row.payee_line,
            claims: {
              claim_number: row.claim_number,
              policyholder_name: row.policyholder_name,
            },
          },
        },
      }));
    },
    enabled: !!tenantId,
    refetchInterval: 60_000,
  });

  // Search inside the Funds Released / Funds Received lanes so a searched claim
  // check also surfaces here (and the lane badge reflects the match count).
  const matchesSplitSearch = useCallback((s: any) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const item = s?.disbursement_batches?.check_intake_items;
    const haystacks: (string | null | undefined)[] = [
      item?.check_number,
      item?.carrier_name,
      item?.payee_line,
      item?.property_address,
      item?.detected_claim_number,
      item?.claims?.claim_number,
      item?.claims?.policyholder_name,
      s?.recipient_name,
      s?.external_check_number,
      s?.sender?.name,
      s?.stakeholder_accounts?.nickname,
      s?.stakeholder_accounts?.custname,
    ];
    return haystacks.some((v) => v && v.toString().toLowerCase().includes(q));
  }, [searchQuery]);

  const filteredFundsReleased = useMemo(
    () => (fundsReleased as any[]).filter(matchesSplitSearch),
    [fundsReleased, matchesSplitSearch],
  );
  const filteredFundsReceived = useMemo(
    () => (fundsReceived as any[]).filter(matchesSplitSearch),
    [fundsReceived, matchesSplitSearch],
  );

  // Auto-jump to the tab that contains matches when the user searches and
  // the current tab is empty. Prevents the "where did my check go?" issue
  // when the check sits in a different status (e.g. Loss Draft) than the
  // currently-viewed tab.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) return;
    const buckets: { tab: string; count: number }[] = [
      { tab: "review", count: needsReview.length },
      { tab: "endorsements", count: awaitingEndorsement.length },
      { tab: "ready", count: readyForDeposit.length },
      { tab: "lossdraft", count: lossDraftChecks.length },
      { tab: "branch", count: branchDeposit.length },
      { tab: "reissue", count: reissueRequested.length },
      { tab: "deposited", count: depositedChecks.length },
      { tab: "fundsreleased", count: filteredFundsReleased.length },
      { tab: "fundsreceived", count: filteredFundsReceived.length },
    ];
    const currentCount = buckets.find((b) => b.tab === activeTab)?.count ?? 0;
    if (currentCount > 0) return;
    const next = buckets.find((b) => b.count > 0);
    if (next && next.tab !== activeTab) {
      setActiveTab(next.tab);
      setSelectedCheck(null);
      setReviewCheckId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, needsReview.length, awaitingEndorsement.length, readyForDeposit.length, lossDraftChecks.length, branchDeposit.length, reissueRequested.length, depositedChecks.length, filteredFundsReleased.length, filteredFundsReceived.length]);



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

  // Realtime: when a disbursement is recorded (Actum or external check), advance
  // the check stage and move it into the Funds Released bucket without a refresh.
  useEffect(() => {
    if (!tenantId) return;
    const channel = supabase
      .channel(`checkops-realtime-${tenantId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "disbursement_splits", filter: `tenant_id=eq.${tenantId}` }, () => {
        qc.invalidateQueries({ queryKey: ["funds-released", tenantId] });
        qc.invalidateQueries({ queryKey: ["check-intake-items"] });
        qc.invalidateQueries({ queryKey: ["check-intake-items-deposited"] });
        qc.invalidateQueries({ queryKey: ["check-stage-totals"] });
        qc.invalidateQueries({ queryKey: ["check-dashboard-counts"] });
        qc.invalidateQueries({ queryKey: ["funds-tab-disbursements", tenantId] });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "check_intake_items", filter: `tenant_id=eq.${tenantId}` }, () => {
        qc.invalidateQueries({ queryKey: ["check-intake-items"] });
        qc.invalidateQueries({ queryKey: ["check-intake-items-deposited"] });
        qc.invalidateQueries({ queryKey: ["check-stage-totals"] });
        qc.invalidateQueries({ queryKey: ["check-dashboard-counts"] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [tenantId, qc]);

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
          {/* Help moved to Settings → ChecksOps Guide */}
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
          {(() => {
            // Phase 8: prefer RPC totals for tab badges when the user has no
            // active search/class filter, so counts stay accurate past the
            // 2,000-row queue cap. Fall back to in-memory counts otherwise.
            // Partner tenants (e.g. Condition One) receive checks via shared_checks
            // owned by another tenant — the per-tenant RPC misses those, so we
            // always add in-memory shared-check counts on top of the aggregate.
            const useAggregate =
              !searchQuery.trim() &&
              classFilter === "all" &&
              !!stageTotals;
            const sharedIdSet = new Set(sharedChecks.map((c) => c.id));
            const sharedInLane = (arr: CheckItem[]) =>
              arr.reduce((n, c) => (sharedIdSet.has(c.id) ? n + 1 : n), 0);
            const laneCount = (key: string, inMemory: CheckItem[]) => {
              if (!useAggregate) return inMemory.length;
              const own = stageTotals!.get(key)?.count ?? 0;
              return own + sharedInLane(inMemory);
            };
            return [
            { key: "review",       label: "Review",            count: laneCount("review", needsReview),         icon: ClipboardCheck, gradient: "from-blue-500/20 to-cyan-500/10",     accent: "text-blue-400",    ring: "ring-blue-500/30" },
            { key: "endorsements", label: "Endorsing",         count: laneCount("endorsing", awaitingEndorsement), icon: Send,           gradient: "from-amber-500/20 to-orange-500/10",  accent: "text-amber-400",   ring: "ring-amber-500/30" },
            { key: "ready",        label: "Ready for Deposit", count: laneCount("ready", readyForDeposit),     icon: CheckCircle2,   gradient: "from-emerald-500/20 to-green-500/10", accent: "text-emerald-400", ring: "ring-emerald-500/30" },
            { key: "deposited",    label: "Deposited",         count: laneCount("deposited", depositedChecks),     icon: Banknote,       gradient: "from-primary/20 to-blue-500/10",      accent: "text-primary",     ring: "ring-primary/30" },
            { key: "lossdraft",    label: "Loss Draft",        count: useAggregate ? ((lossDraftCounts as any)?.total_active ?? lossDraftChecks.length) : lossDraftChecks.length, icon: Landmark,       gradient: "from-purple-500/20 to-violet-500/10", accent: "text-purple-400",  ring: "ring-purple-500/30" },

            // Bank Deposit card intentionally removed — users are pushed to CheckAlt for RDC.
            // The branch_deposit_required status still exists in the pipeline as a fallback,
            // but is no longer surfaced as a top-level tab in the command center.

            // Reissue moved into Manager → Reissue sub-tab.
            { key: "fundsreleased", label: "Funds Released",   count: filteredFundsReleased.length,       icon: Banknote,       gradient: "from-emerald-500/20 to-teal-500/10",  accent: "text-emerald-400", ring: "ring-emerald-500/30" },
            { key: "fundsreceived", label: "Funds Received",   count: filteredFundsReceived.length,       icon: Banknote,       gradient: "from-sky-500/20 to-blue-500/10",      accent: "text-sky-400",     ring: "ring-sky-500/30" },
            // Partners moved into Manager → Partners sub-tab (2026-07-07).
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
          });
          })()}
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
                {SHOW_CHECKALT && (
                  <>
                    <TabsTrigger value="pending_approvals" className="text-xs gap-1"><ShieldAlert className="h-3 w-3" />Pending Approvals</TabsTrigger>
                    <TabsTrigger value="deposit_history" className="text-xs gap-1"><Banknote className="h-3 w-3" />Deposit History</TabsTrigger>
                  </>
                )}
                <TabsTrigger value="reports" className="text-xs gap-1"><FileBarChart className="h-3 w-3" />Reports</TabsTrigger>
                <TabsTrigger value="mortgage_cos" className="text-xs gap-1"><Building2 className="h-3 w-3" />Mortgage Cos</TabsTrigger>
                <TabsTrigger value="partners" className="text-xs gap-1"><Users className="h-3 w-3" />Partners</TabsTrigger>
                <TabsTrigger value="homeowner_uploads" className="text-xs gap-1"><ArrowDownToLine className="h-3 w-3 rotate-180" />Homeowner Uploads</TabsTrigger>
                <button
                  type="button"
                  onClick={() => { setActiveTab("reissue"); setSelectedCheck(null); }}
                  className="text-xs gap-1 inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 font-medium ring-offset-background transition-all hover:bg-background/60"
                >
                  <RotateCcw className="h-3 w-3" />Reissue{reissueRequested.length > 0 ? ` (${reissueRequested.length})` : ""}
                </button>

              </TabsList>
              <TabsContent value="deposit_ops" className="mt-3">
                <Suspense fallback={<TabLoader />}>
                  <DepositOperationsConsole searchQuery={searchQuery} />
                </Suspense>
              </TabsContent>
              {SHOW_CHECKALT && (
                <>
                  <TabsContent value="pending_approvals" className="mt-3">
                    <Suspense fallback={<TabLoader />}>
                      <PendingApprovalDeposits />
                    </Suspense>
                  </TabsContent>
                  <TabsContent value="deposit_history" className="mt-3">
                    <Suspense fallback={<TabLoader />}>
                      <CheckAltDepositHistory />
                    </Suspense>
                  </TabsContent>
                </>
              )}
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
              <TabsContent value="partners" className="mt-3">
                <Suspense fallback={<TabLoader />}>
                  <TenantPartnerManager />
                </Suspense>
              </TabsContent>
              <TabsContent value="homeowner_uploads" className="mt-3 space-y-4">
                <Suspense fallback={<TabLoader />}>
                  <SendHomeownerUploadLink />
                </Suspense>
                <Suspense fallback={<TabLoader />}>
                  <HomeownerSubmittedChecksInbox 
                    tenantId={tenantId} 
                    onCheckCreated={(id) => {
                      setActiveTab("review");
                      setReviewCheckId(id);
                      // Trigger OCR for the new check
                      supabase.functions.invoke("ingest-shared-check", {
                        body: { check_id: id, action: "ocr_only" }
                      }).catch(console.error);
                    }} 
                  />
                </Suspense>
              </TabsContent>
              {/* Reissue tab now uses the shared list+detail layout below so
                  each check opens with full details, images, and notes. */}


            </Tabs>
          </div>
        )}

        {/* Messages Tab — top-level colored card */}
        {activeTab === "messages" && (
          <div className="mt-3">
            <Suspense fallback={<TabLoader />}>
              <CheckMessagesPanel
                onOpenCheck={(id) => {
                  setActiveTab("endorsements");
                  setSelectedCheck(id);
                }}
              />

            </Suspense>
          </div>
        )}

        {/* Partners moved into Manager → Partners sub-tab (2026-07-07). */}


        {/* Reissue moved into Manager → Reissue sub-tab. */}

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
                            <TableRow className="bg-primary/20 hover:bg-primary/20 border-t-4 border-primary text-foreground font-semibold">
                              <TableCell colSpan={4} className="py-3">
                                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                  <ClaimCheckFileHeader group={group} compact />
                                </div>
                              </TableCell>
                            </TableRow>
                            {group.checks.map((check) => (
                              <TableRow key={check.id} className="cursor-pointer" onMouseEnter={() => prefetchCheckDetail(check.id)} onFocus={() => prefetchCheckDetail(check.id)} onClick={() => setSelectedCheck(check.id)}>
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

        {activeTab === "fundsreleased" && (
          <div className="mt-3 flex flex-col md:flex-row gap-4" style={{ minHeight: "calc(100vh - 400px)" }}>
            <Card
              className={`overflow-hidden transition-all duration-300 ease-in-out md:flex-shrink-0 w-full ${isMobile && selectedCheck ? "hidden" : ""}`}
              style={!isMobile ? { width: selectedCheck ? "40%" : "100%" } : undefined}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Banknote className="h-4 w-4 text-emerald-400" />
                  Funds Released ({filteredFundsReleased.length})
                </CardTitle>
              </CardHeader>
              <ClassFilterBar
                classFilter={classFilter}
                setClassFilter={setClassFilter}
                items={filteredFundsReleased}
                getFundsType={(s: any) => s?.disbursement_batches?.check_intake_items?.funds_type}
                getAmount={(s: any) => Number(s.amount) || 0}
                itemLabel="disbursement"
              />
              <CardContent className="p-0">
                <ScrollArea className="h-[calc(100vh-460px)]">
                  {(() => {
                    const visible = classFilter === "all"
                      ? filteredFundsReleased
                      : filteredFundsReleased.filter((s: any) => (s?.disbursement_batches?.check_intake_items?.funds_type ?? "unclassified") === classFilter);
                    if (visible.length === 0) {
                      return <div className="p-8 text-center text-muted-foreground">No funds released yet</div>;
                    }
                    return (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Check</TableHead>
                          <TableHead>Carrier</TableHead>
                          <TableHead>Property</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Class</TableHead>
                          <TableHead>Recipient</TableHead>
                          <TableHead>Date Settled</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(() => {
                          // Group released splits by claim # so every disbursement
                          // tied to the same claim sits under one darker file band.
                          const groups = new Map<string, { key: string; claimNumber: string; policyholderName: string; rows: any[]; total: number; latest: string }>();
                          visible.forEach((split: any) => {
                            const batch = split.disbursement_batches;
                            const check = batch?.check_intake_items;
                            const linked = check?.claim_id ? claimLookup.get(check.claim_id) : null;
                            const embeddedClaim = check?.claims ?? null;
                            const claimNumber = linked?.claim_number || embeddedClaim?.claim_number || check?.detected_claim_number || "Unlinked claim";
                            const policyholderName = linked?.policyholder_name || embeddedClaim?.policyholder_name || extractInsuredName(check?.payee_line) || "Unknown insured";
                            const hasClaim = !!(linked?.claim_number || embeddedClaim?.claim_number || check?.detected_claim_number);

                            const key = hasClaim
                              ? `claim::${String(claimNumber).trim().toLowerCase()}`
                              : `unlinked::${split.id}`;
                            const existing = groups.get(key);
                            const settledAt = split.settled_at ?? split.created_at ?? new Date().toISOString();
                            if (existing) {
                              existing.rows.push(split);
                              existing.total += Number(split.amount) || 0;
                              if (new Date(settledAt).getTime() > new Date(existing.latest).getTime()) existing.latest = settledAt;
                            } else {
                              groups.set(key, { key, claimNumber, policyholderName, rows: [split], total: Number(split.amount) || 0, latest: settledAt });
                            }
                          });
                          const sortedGroups = Array.from(groups.values()).sort(
                            (a, b) => new Date(b.latest).getTime() - new Date(a.latest).getTime(),
                          );
                          return sortedGroups.map((group) => (
                            <Fragment key={group.key}>
                              <TableRow className="bg-primary/20 hover:bg-primary/20 border-t-4 border-primary text-foreground font-semibold">
                                <TableCell colSpan={7} className="py-3">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">Claim Check File</Badge>
                                      <span className="font-semibold text-foreground">{group.policyholderName}</span>
                                      <Badge variant="outline" className="font-mono text-[10px]">Claim #{group.claimNumber}</Badge>
                                      <span className="text-xs font-normal text-muted-foreground">
                                        {group.rows.length} {group.rows.length === 1 ? "disbursement" : "disbursements"}
                                      </span>
                                    </div>
                                    <div className="text-sm font-semibold tabular-nums text-foreground">
                                      ${group.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                              {group.rows.map((split: any) => {
                                const acct = split.stakeholder_accounts;
                                const batch = split.disbursement_batches;
                                const check = batch?.check_intake_items;
                                const fundsType = check?.funds_type;
                                const checkId = batch?.check_intake_item_id;
                                const isSelected = checkId && selectedCheck === checkId;
                                return (
                                  <TableRow
                                    key={split.id}
                                    className={`${checkId ? "cursor-pointer" : ""} ${isSelected ? "bg-accent" : ""}`}
                                    onMouseEnter={() => checkId && prefetchCheckDetail(checkId)}
                                    onFocus={() => checkId && prefetchCheckDetail(checkId)}
                                    onClick={() => checkId && setSelectedCheck(isSelected ? null : checkId)}
                                  >
                                    <TableCell className="font-mono text-sm">#{check?.check_number || "—"}</TableCell>
                                    <TableCell className="text-sm">{check?.carrier_name || "—"}</TableCell>
                                    <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate" title={check?.property_address || ""}>
                                      {check?.property_address || "—"}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      ${Number(split.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                                    </TableCell>
                                    <TableCell>
                                      {fundsType ? (
                                        <Badge variant="outline" className="text-[10px] uppercase">
                                          {fundsType === "recoverable_depreciation"
                                            ? "Rec. Dep."
                                            : fundsType === "overhead_and_profit"
                                            ? "O&P"
                                            : fundsType}
                                        </Badge>
                                      ) : (
                                        <span className="text-[10px] text-muted-foreground">—</span>
                                      )}
                                    </TableCell>
                                    <TableCell className="text-sm">{split.recipient_name ?? acct?.nickname ?? acct?.custname ?? "—"}{split.external_check_number ? <span className="ml-1 text-xs text-muted-foreground font-mono">· Ck #{split.external_check_number}</span> : null}</TableCell>
                                    <TableCell className="text-sm text-muted-foreground">
                                      {split.settled_at ? format(new Date(split.settled_at), "MMM d, yyyy") : "—"}
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </Fragment>
                          ));
                        })()}
                      </TableBody>
                    </Table>
                    );
                  })()}
                </ScrollArea>
              </CardContent>
            </Card>

            {selectedCheck && (
              <div
                className={`transition-all duration-300 ease-in-out md:flex-shrink-0 overflow-hidden w-full ${isMobile && !selectedCheck ? "hidden" : ""}`}
                style={!isMobile ? { width: "60%" } : undefined}
              >
                <div className="space-y-2">
                  {isMobile && (
                    <div className="sticky top-0 z-10 bg-background border-b pb-2 mb-2 -mx-4 px-4">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 -ml-2 h-8 text-xs"
                        onClick={() => setSelectedCheck(null)}
                      >
                        <ArrowLeft className="h-4 w-4" /> Back to funds released
                      </Button>
                    </div>
                  )}
                  <CheckDetailPanel
                    checkId={selectedCheck}
                    onRefresh={() => qc.invalidateQueries({ queryKey: ["check-intake-items"] })}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "fundsreceived" && (
          <div className="mt-3 flex flex-col md:flex-row gap-4" style={{ minHeight: "calc(100vh - 400px)" }}>
            <Card
              className={`overflow-hidden transition-all duration-300 ease-in-out md:flex-shrink-0 w-full ${isMobile && selectedCheck ? "hidden" : ""}`}
              style={!isMobile ? { width: selectedCheck ? "40%" : "100%" } : undefined}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Banknote className="h-4 w-4 text-sky-400" />
                  Funds Received ({filteredFundsReceived.length})
                </CardTitle>
              </CardHeader>
              <ClassFilterBar
                classFilter={classFilter}
                setClassFilter={setClassFilter}
                items={filteredFundsReceived}
                getFundsType={(s: any) => s?.disbursement_batches?.check_intake_items?.funds_type}
                getAmount={(s: any) => Number(s.amount) || 0}
                itemLabel="receipt"
              />
              <CardContent className="p-0">
                <ScrollArea className="h-[calc(100vh-460px)]">
                  {(() => {
                    const visible = classFilter === "all"
                      ? filteredFundsReceived
                      : filteredFundsReceived.filter((s: any) => (s?.disbursement_batches?.check_intake_items?.funds_type ?? "unclassified") === classFilter);
                    if (visible.length === 0) {
                      return <div className="p-8 text-center text-muted-foreground">No funds received yet</div>;
                    }
                    return (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Check</TableHead>
                          <TableHead>Carrier</TableHead>
                          <TableHead>Property</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Class</TableHead>
                          <TableHead>From</TableHead>
                          <TableHead>Date Received</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(() => {
                          const groups = new Map<string, { key: string; claimNumber: string; policyholderName: string; rows: any[]; total: number; latest: string }>();
                          visible.forEach((split: any) => {
                            const batch = split.disbursement_batches;
                            const check = batch?.check_intake_items;
                            const embeddedClaim = check?.claims ?? null;
                            const claimNumber = embeddedClaim?.claim_number || check?.detected_claim_number || "Unlinked claim";
                            const policyholderName = embeddedClaim?.policyholder_name || extractInsuredName(check?.payee_line) || "Unknown insured";
                            const hasClaim = !!(embeddedClaim?.claim_number || check?.detected_claim_number);

                            const key = hasClaim
                              ? `claim::${String(claimNumber).trim().toLowerCase()}`
                              : `unlinked::${split.id}`;
                            const existing = groups.get(key);
                            const settledAt = split.settled_at ?? split.created_at ?? new Date().toISOString();
                            if (existing) {
                              existing.rows.push(split);
                              existing.total += Number(split.amount) || 0;
                              if (new Date(settledAt).getTime() > new Date(existing.latest).getTime()) existing.latest = settledAt;
                            } else {
                              groups.set(key, { key, claimNumber, policyholderName, rows: [split], total: Number(split.amount) || 0, latest: settledAt });
                            }
                          });
                          const sortedGroups = Array.from(groups.values()).sort(
                            (a, b) => new Date(b.latest).getTime() - new Date(a.latest).getTime(),
                          );
                          return sortedGroups.map((group) => (
                            <Fragment key={group.key}>
                              <TableRow className="bg-primary/20 hover:bg-primary/20 border-t-4 border-primary text-foreground font-semibold">
                                <TableCell colSpan={7} className="py-3">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">Claim Check File</Badge>
                                      <span className="font-semibold text-foreground">{group.policyholderName}</span>
                                      <Badge variant="outline" className="font-mono text-[10px]">Claim #{group.claimNumber}</Badge>
                                      <span className="text-xs font-normal text-muted-foreground">
                                        {group.rows.length} {group.rows.length === 1 ? "receipt" : "receipts"}
                                      </span>
                                    </div>
                                    <div className="text-sm font-semibold tabular-nums text-sky-400">
                                      ${group.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                              {group.rows.map((split: any) => {
                                const batch = split.disbursement_batches;
                                const check = batch?.check_intake_items;
                                const fundsType = check?.funds_type;
                                const checkId = batch?.check_intake_item_id;
                                const isSelected = checkId && selectedCheck === checkId;
                                const senderName = split.sender?.name ?? "Partner tenant";
                                return (
                                  <TableRow
                                    key={split.id}
                                    className={`${checkId ? "cursor-pointer" : ""} ${isSelected ? "bg-accent" : ""}`}
                                    onMouseEnter={() => checkId && prefetchCheckDetail(checkId)}
                                    onFocus={() => checkId && prefetchCheckDetail(checkId)}
                                    onClick={() => checkId && setSelectedCheck(isSelected ? null : checkId)}
                                  >
                                    <TableCell className="font-mono text-sm">#{check?.check_number || "—"}</TableCell>
                                    <TableCell className="text-sm">{check?.carrier_name || "—"}</TableCell>
                                    <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate" title={check?.property_address || ""}>
                                      {check?.property_address || "—"}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      ${Number(split.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                                    </TableCell>
                                    <TableCell>
                                      {fundsType ? (
                                        <Badge variant="outline" className="text-[10px] uppercase">
                                          {fundsType === "recoverable_depreciation"
                                            ? "Rec. Dep."
                                            : fundsType === "overhead_and_profit"
                                            ? "O&P"
                                            : fundsType}
                                        </Badge>
                                      ) : (
                                        <span className="text-[10px] text-muted-foreground">—</span>
                                      )}
                                    </TableCell>
                                    <TableCell className="text-sm">
                                      {senderName}
                                      {split.external_check_number ? <span className="ml-1 text-xs text-muted-foreground font-mono">· Ck #{split.external_check_number}</span> : null}
                                    </TableCell>
                                    <TableCell className="text-sm text-muted-foreground">
                                      {split.settled_at ? format(new Date(split.settled_at), "MMM d, yyyy") : "—"}
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </Fragment>
                          ));
                        })()}
                      </TableBody>
                    </Table>
                    );
                  })()}
                </ScrollArea>
              </CardContent>
            </Card>

            {selectedCheck && (
              <div
                className={`transition-all duration-300 ease-in-out md:flex-shrink-0 overflow-hidden w-full ${isMobile && !selectedCheck ? "hidden" : ""}`}
                style={!isMobile ? { width: "60%" } : undefined}
              >
                <div className="space-y-2">
                  {isMobile && (
                    <div className="sticky top-0 z-10 bg-background border-b pb-2 mb-2 -mx-4 px-4">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 -ml-2 h-8 text-xs"
                        onClick={() => setSelectedCheck(null)}
                      >
                        <ArrowLeft className="h-4 w-4" /> Back to funds received
                      </Button>
                    </div>
                  )}
                  <CheckDetailPanel
                    checkId={selectedCheck}
                    onRefresh={() => qc.invalidateQueries({ queryKey: ["check-intake-items"] })}
                  />
                </div>
              </div>
            )}
          </div>
        )}






        {/* Review Tab — only renders when active */}
        {activeTab === "review" && (
          <div className="mt-3 flex flex-col md:flex-row gap-4">
            <Card
              className={`overflow-hidden transition-all duration-300 ease-in-out md:flex-shrink-0 w-full ${
                isMobile && reviewCheckId ? "hidden" : ""
              }`}
              style={!isMobile ? { width: reviewCheckId ? "40%" : "80%" } : undefined}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ClipboardCheck className="h-4 w-4 text-orange-400" />
                  Manual Review Queue
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <CheckReviewQueue
                  onSelectCheck={(id) => setReviewCheckId((curr) => (curr === id ? null : id))}
                  selectedCheckId={reviewCheckId}
                  searchQuery={searchQuery}
                />
              </CardContent>
            </Card>

            <div
              className={`transition-all duration-300 ease-in-out md:flex-shrink-0 overflow-hidden w-full ${
                isMobile && !reviewCheckId ? "hidden" : ""
              }`}
              style={!isMobile ? { width: reviewCheckId ? "60%" : "20%" } : undefined}
            >
              {reviewCheckId ? (
                <Card className="animate-fade-in">
                  {isMobile && (
                    <div className="sticky top-14 z-20 bg-card/95 backdrop-blur border-b px-3 py-2 flex items-center gap-2 rounded-t-lg">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 -ml-1 h-8 text-xs"
                        onClick={() => setReviewCheckId(null)}
                      >
                        <ArrowLeft className="h-4 w-4" /> Back to queue
                      </Button>
                      <span className="text-xs font-medium ml-auto text-muted-foreground">Review & Decision</span>
                    </div>
                  )}
                  {!isMobile && (
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Review & Decision</CardTitle>
                    </CardHeader>
                  )}
                  <CardContent className="p-0">
                    <Tabs defaultValue="review">
                       <div className="sticky top-[104px] md:top-0 z-10 bg-muted w-full overflow-x-auto scrollbar-hide border-b">
                         <TabsList className="w-max min-w-full rounded-none flex-nowrap justify-start">
                           <TabsTrigger value="review" className="text-xs whitespace-nowrap px-2 sm:px-3">Review</TabsTrigger>
                           <TabsTrigger value="settlement" className="text-xs whitespace-nowrap px-2 sm:px-3">Settlement</TabsTrigger>
                           <TabsTrigger value="packet" className="text-xs whitespace-nowrap px-2 sm:px-3">Deposit Packet</TabsTrigger>
                         </TabsList>
                       </div>
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
                      <TabsContent value="settlement" className="mt-0 p-3 md:p-4">
                        <ReviewSettlementTab checkId={reviewCheckId} />
                      </TabsContent>
                      <TabsContent value="packet" className="mt-0 p-3 md:p-4">
                        <Suspense fallback={<TabLoader />}>
                          <DepositPacketGenerator checkId={reviewCheckId} />
                        </Suspense>
                      </TabsContent>
                    </Tabs>
                  </CardContent>
                </Card>
              ) : (
                <Card className="hidden md:flex items-center justify-center h-[calc(100vh-400px)]">
                  <div className="text-center text-muted-foreground p-4">
                    <ClipboardCheck className="h-12 w-12 mx-auto mb-3 opacity-30" />
                    <p className="text-xs">Select a check</p>
                  </div>
                </Card>
              )}
            </div>
          </div>
        )}


        {activeTab === "reissue" && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
            <span className="text-xs font-medium flex items-center gap-2">
              <RotateCcw className="h-3.5 w-3.5" /> Reissue requested ({reissueRequested.length})
            </span>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setActiveTab("manager"); setSelectedCheck(null); }}>
              Back to Manager
            </Button>
          </div>
        )}

        {/* All other tabs — only render the active one */}
        {activeTab !== "review" && activeTab !== "lossdraft" && activeTab !== "manager" && activeTab !== "branch" && activeTab !== "messages" && activeTab !== "partners" && activeTab !== "fundsreleased" && activeTab !== "fundsreceived" && (
          <div className="mt-3 flex flex-col md:flex-row gap-4" style={{ minHeight: "calc(100vh - 400px)" }}>
            {/* Check list — hidden on mobile when a check is selected */}
            <Card
              className={`overflow-hidden transition-all duration-300 ease-in-out md:flex-shrink-0 w-full ${isMobile && selectedCheck ? "hidden" : ""}`}
              style={!isMobile ? { width: selectedCheck ? "40%" : "80%" } : undefined}
            >
              <CardContent className="p-0 h-full">
                {bulkSelected.size > 0 && (
                  <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b bg-primary/10 backdrop-blur px-3 py-2">
                    <span className="text-xs font-semibold text-foreground">
                      {bulkSelected.size} selected
                    </span>
                    <div className="flex flex-wrap gap-1 ml-auto">
                      <Button size="sm" variant="outline" disabled={bulkRunning} onClick={() => runBulkDecision("endorsements_in_progress", "Endorsing")}>Endorsing</Button>
                      <Button size="sm" variant="outline" disabled={bulkRunning} onClick={() => runBulkDecision("needs_review", "Review")}>Review</Button>
                      <Button size="sm" variant="outline" disabled={bulkRunning} onClick={() => runBulkDecision("loss_draft_required", "Loss Draft")}>Loss Draft</Button>
                      <Button size="sm" variant="outline" disabled={bulkRunning} onClick={() => runBulkDecision("reissue_requested", "Reissue")}>Reissue</Button>
                      <Button size="sm" variant="outline" disabled={bulkRunning} className="text-destructive" onClick={() => { if (confirm(`Void ${bulkSelected.size} check(s)?`)) runBulkDecision("voided", "Void"); }}>Void</Button>
                      <Button size="sm" variant="ghost" disabled={bulkRunning} onClick={clearBulk}>Clear</Button>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 bg-muted/30">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Class</span>
                  <Select value={classFilter} onValueChange={setClassFilter}>
                    <SelectTrigger className="h-7 w-[220px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All classes ({rawFilteredChecks.length})</SelectItem>
                      {FUNDS_TYPE_OPTIONS.map((o) => {
                        const c = classFilterCounts.get(o.value);
                        if (!c) return null;
                        return (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label} ({c.count})
                          </SelectItem>
                        );
                      })}
                      {classFilterCounts.has("unclassified") && (
                        <SelectItem value="unclassified">
                          Unclassified ({classFilterCounts.get("unclassified")!.count})
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  {classFilter !== "all" && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setClassFilter("all")}>
                      Clear
                    </Button>
                  )}
                  <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="text-muted-foreground">
                      {filteredChecks.length} check{filteredChecks.length === 1 ? "" : "s"}
                    </span>
                    <span className="font-semibold tabular-nums text-foreground">
                      Total: ${filteredCumulativeTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
                <div className="overflow-x-auto h-full">
                  {isLoading ? (
                    <div className="p-8 text-center text-muted-foreground">Loading checks...</div>
                  ) : filteredChecks.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground">No checks in this category</div>
                  ) : (
                    (() => {
                      const hideDepositCol = activeTab === "endorsements" || activeTab === "ready" || activeTab === "deposited";
                      const hideReadySignal = activeTab === "ready" || activeTab === "deposited";
                      const colCount = (hideDepositCol ? 7 : 8) + 1;

                      const renderHeaderRow = (group: CheckGroup) => (
                        <TableRow key={`${group.key}-header`} className="bg-primary/20 hover:bg-primary/20 border-t-4 border-primary text-foreground font-semibold rounded-t-xl overflow-hidden [&>td:first-child]:rounded-tl-xl [&>td:last-child]:rounded-tr-xl">
                          <TableCell className="py-3 w-8">
                            {group.checks.length > 1 && (() => {
                              const groupIds = group.checks.map((c) => c.id);
                              const allChecked = groupIds.every((id) => bulkSelected.has(id));
                              const someChecked = !allChecked && groupIds.some((id) => bulkSelected.has(id));
                              return (
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 accent-primary cursor-pointer"
                                  checked={allChecked}
                                  ref={(el) => { if (el) el.indeterminate = someChecked; }}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={() => {
                                    setBulkSelected((prev) => {
                                      const next = new Set(prev);
                                      if (allChecked) groupIds.forEach((id) => next.delete(id));
                                      else groupIds.forEach((id) => next.add(id));
                                      return next;
                                    });
                                  }}
                                  title="Select all checks in this file"
                                />
                              );
                            })()}
                          </TableCell>
                          <TableCell colSpan={colCount - 1} className="py-3">
                            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                              <ClaimCheckFileHeader group={group} hideReadySignal={hideReadySignal} />
                            </div>
                          </TableCell>
                        </TableRow>
                      );

                      const renderCheckRow = (check: CheckItem) => {
                        const effStatus = getEffectiveStatus(check);
                        const suppressRec =
                          check.deposit_recommendation === "ready_for_deposit" &&
                          (effStatus === "approved_for_deposit" || effStatus === "deposited");
                        const rec = check.deposit_recommendation && !suppressRec
                          ? recommendationConfig[check.deposit_recommendation]
                          : null;
                        const RecIcon = rec?.icon ?? null;
                        const canDelete = canDeleteAnyCheck;
                        const isSelected = selectedCheck === check.id;
                        const isBulk = bulkSelected.has(check.id);
                        const isShared = (check as any)._shared;
                        const sourceTenantName = (check as any)._sourceTenantName;
                        return (
                          <TableRow
                            key={check.id}
                            className={`cursor-pointer transition-colors ${isSelected ? "bg-accent" : ""} ${isBulk ? "bg-primary/5" : ""}`}
                            onMouseEnter={() => prefetchCheckDetail(check.id)}
                            onFocus={() => prefetchCheckDetail(check.id)}
                            onClick={() => setSelectedCheck(isSelected ? null : check.id)}
                          >
                            <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-primary cursor-pointer"
                                checked={isBulk}
                                onChange={() => toggleBulk(check.id)}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              <div className="flex items-center gap-1.5">
                                #{check.check_number || "—"}
                                {isShared && <SharedChecksBadge sourceTenantName={sourceTenantName} />}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm md:max-w-[180px]">
                              <div className="flex flex-col gap-0.5">
                                <span className="break-words md:truncate leading-tight">{check.carrier_name || "Pending OCR"}</span>
                                <CheckValidityBadge issueDate={check.issue_date} expirationDays={check.expiration_days} hideWhenSafe />
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
                              <Badge className={`text-[10px] ${getTabStatusClass(check, activeTab)}`}>
                                {getTabStatusLabel(check, activeTab)}
                              </Badge>
                            </TableCell>
                            {!hideDepositCol && (
                              <TableCell>
                                {RecIcon && (
                                  <span
                                    className="inline-flex items-center gap-1"
                                    title={rec!.label}
                                  >
                                    <RecIcon className={`h-4 w-4 ${rec!.color}`} />
                                    <span className={`text-[10px] ${rec!.color} hidden md:inline`}>
                                      {rec!.label}
                                    </span>
                                  </span>
                                )}
                              </TableCell>
                            )}
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
                      };

                      const headerRow = (
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-8"></TableHead>
                            <TableHead>Check</TableHead>
                            <TableHead>Carrier / Property</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                            <TableHead>Class</TableHead>
                            <TableHead>Payees</TableHead>
                            <TableHead>Status</TableHead>
                            {!hideDepositCol && <TableHead>Deposit</TableHead>}
                            <TableHead className="w-20"></TableHead>
                          </TableRow>
                        </TableHeader>
                      );

                      if (shouldVirtualizeQueue) {
                        const virtualItems = queueVirtualizer.getVirtualItems();
                        const totalSize = queueVirtualizer.getTotalSize();
                        const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
                        const paddingBottom = virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1].end : 0;
                        return (
                          <div ref={queueScrollRef} className="overflow-auto h-[calc(100vh-460px)] min-h-[300px]">
                            <Table>
                              {headerRow}
                              <TableBody>
                                {paddingTop > 0 && (
                                  <tr aria-hidden="true"><td colSpan={colCount} style={{ height: paddingTop, padding: 0, border: 0 }} /></tr>
                                )}
                                {virtualItems.map((vi) => {
                                  const item = flatQueueItems[vi.index];
                                  if (!item) return null;
                                  const content = item.kind === "header" ? renderHeaderRow(item.group) : renderCheckRow(item.check);
                                  return (
                                    <Fragment key={item.key}>
                                      {content}
                                    </Fragment>
                                  );
                                })}
                                {paddingBottom > 0 && (
                                  <tr aria-hidden="true"><td colSpan={colCount} style={{ height: paddingBottom, padding: 0, border: 0 }} /></tr>
                                )}
                              </TableBody>
                            </Table>
                          </div>
                        );
                      }

                      return (
                        <ScrollArea className="h-[calc(100vh-460px)] min-h-[300px]">
                        <ScrollArea className="h-[calc(100vh-460px)] min-h-[300px]">
                          <Table className="border-separate border-spacing-y-0 border-spacing-x-0">
                            {headerRow}
                            <TableBody>
                              {groupedFilteredChecks.map((group) => (
                                <Fragment key={group.key}>
                                  {renderHeaderRow(group)}
                                  {group.checks.map((check, idx) => {
                                    const isLast = idx === group.checks.length - 1;
                                    const row = renderCheckRow(check);
                                    // Clone and apply the bottom rounding if it's the last row in the file
                                    return (
                                      <Fragment key={check.id}>
                                        {isLast ? (
                                          <TableRow 
                                            {...row.props} 
                                            className={`${row.props.className} rounded-b-xl overflow-hidden [&>td:first-child]:rounded-bl-xl [&>td:last-child]:rounded-br-xl`}
                                          />
                                        ) : row}
                                      </Fragment>
                                    );
                                  })}
                                  {/* Spacer row between files */}
                                  <TableRow className="h-4 bg-transparent hover:bg-transparent">
                                    <TableCell colSpan={colCount} className="p-0 border-0" />
                                  </TableRow>
                                </Fragment>
                              ))}
                            </TableBody>
                          </Table>
                        </ScrollArea>
                        </ScrollArea>
                      );
                    })()
                  )}
                  {activeTab === "deposited" && (() => {
                    const totalDeposited = stageTotals?.get("deposited")?.count ?? depositedRows.length;
                    const canLoadMore = depositedRows.length >= depositedLimit && depositedRows.length < totalDeposited;
                    if (!canLoadMore && depositedRows.length === 0) return null;
                    return (
                      <div className="flex items-center justify-center gap-3 py-4 text-xs text-muted-foreground border-t">
                        <span>
                          Showing {depositedRows.length.toLocaleString()} of {totalDeposited.toLocaleString()} deposited
                        </span>
                        {canLoadMore && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isFetchingDeposited}
                            onClick={() => setDepositedLimit((n) => n + DEPOSITED_PAGE_SIZE)}
                          >
                            {isFetchingDeposited ? "Loading…" : `Load ${DEPOSITED_PAGE_SIZE} more`}
                          </Button>
                        )}
                      </div>
                    );
                  })()}
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
                    <div className="sticky top-0 z-10 bg-background border-b pb-2 mb-2 -mx-4 px-4">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1 -ml-2 h-8 text-xs"
                        onClick={() => setSelectedCheck(null)}
                      >
                        <ArrowLeft className="h-4 w-4" /> Back to checks
                      </Button>
                    </div>
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

function ClaimCheckFileHeader({ group, compact = false, hideReadySignal = false }: { group: CheckGroup; compact?: boolean; hideReadySignal?: boolean }) {
  const settledPayees = group.checks.reduce(
    (sum, check) => sum + (check.check_payees ?? []).filter((p) => {
      const status = (p.endorsement_status ?? "").toLowerCase();
      return status === "signed" || status === "waived";
    }).length,
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
            <span>{settledPayees}/{totalPayees || 0} endorsements received</span>
            {hasLossDraft && <span>• Loss draft visibility active</span>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {hasBlocked && <Badge variant="outline" className="border-orange-500/30 text-orange-400 text-[10px]">Blocked / pending</Badge>}
        {hasReady && !hideReadySignal && <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 text-[10px]">Ready signal</Badge>}
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
  const [pendingCrop, setPendingCrop] = useState<{ file: File; side: "front" | "back" } | null>(null);
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

      // If loaded inside Freedom CRM (?embed=1&freedom_claim_id=...), tag the
      // check so Freedom can later list it via partner-checks-by-claim.
      const embedCtx = (await import("@/lib/embedContext")).getEmbedContext();

      const { data: check, error: insErr } = await supabase
        .from("check_intake_items")
        .insert({
          front_image_path: frontPath,
          back_image_path: backPath,
          claim_id: claimId || null,
          uploaded_by: user.id,
          ...(tenantId ? { tenant_id: tenantId } : {}),
          ...(embedCtx.freedomClaimId ? { freedom_claim_id: embedCtx.freedomClaimId } : {}),
          ...(embedCtx.claimNumber ? { freedom_claim_number: embedCtx.claimNumber } : {}),
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
        <Input type="file" accept="image/*" onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setPendingCrop({ file: f, side: "front" });
          e.currentTarget.value = "";
        }} />
        {frontFile && (
          <p className="text-xs text-muted-foreground mt-1 truncate">✓ {frontFile.name}</p>
        )}
      </div>
      <div>
        <Label>Back of Check</Label>
        <Input type="file" accept="image/*" onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setPendingCrop({ file: f, side: "back" });
          e.currentTarget.value = "";
        }} />
        {backFile && (
          <p className="text-xs text-muted-foreground mt-1 truncate">✓ {backFile.name}</p>
        )}
      </div>
      <CheckImageCropper
        open={!!pendingCrop}
        file={pendingCrop?.file ?? null}
        title={pendingCrop?.side === "back" ? "Crop back of check" : "Crop front of check"}
        onCancel={() => setPendingCrop(null)}
        onConfirm={(cropped) => {
          if (pendingCrop?.side === "front") setFrontFile(cropped);
          else if (pendingCrop?.side === "back") setBackFile(cropped);
          setPendingCrop(null);
        }}
      />
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
  { value: "needs_review", label: "Review" },
  { value: "endorsements_in_progress", label: "Endorsing" },
  { value: "loss_draft_required", label: "Loss Draft" },
  { value: "reissue_requested", label: "Reissue" },
  { value: "voided", label: "Void" },
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
      // Map the new status to the matching stage + recommendation so the check
      // fully moves out of its old tab (tabs filter on status AND deposit_recommendation).
      const stageMap: Record<string, string> = {
        uploaded: "review",
        processing: "review",
        ocr_complete: "review",
        needs_review: "review",
        manual_review_required: "review",
        reissue_requested: "review",
        endorsements_in_progress: "endorsing",
        endorsements_complete: "endorsing",
        approved_for_deposit: "ready_for_deposit",
        branch_deposit_required: "ready_for_deposit",
        loss_draft_required: "loss_draft",
        deposited: "deposited",
        voided: "review",
      };
      const recMap: Record<string, string | null> = {
        endorsements_in_progress: "endorsements_pending",
        endorsements_complete: "endorsements_pending",
        approved_for_deposit: "ready_for_deposit",
        branch_deposit_required: "branch_deposit_recommended",
        loss_draft_required: "loss_draft_required",
        reissue_requested: "request_reissue",
        needs_review: null,
        manual_review_required: null,
        uploaded: null,
        processing: null,
        ocr_complete: null,
        deposited: null,
        voided: null,
      };
      const newStage = (stageMap[newStatus] ?? "review") as "review" | "loss_draft" | "endorsing" | "ready_for_deposit" | "deposited";
      const newRec = recMap[newStatus] ?? null;
      const nowIso = new Date().toISOString();
      const { error } = await supabase
        .from("check_intake_items")
        .update({
          status: newStatus,
          check_stage: newStage,
          deposit_recommendation: newRec,
          updated_at: nowIso,
        })
        .eq("id", checkId);
      if (error) throw error;
      // Mirror stage to claim_checks so other views stay in sync.
      await supabase
        .from("claim_checks")
        .update({ check_stage: newStage, updated_at: nowIso })
        .eq("check_intake_item_id", checkId);
      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "status_manual_override",
        actor_id: user?.id ?? null,
        event_description: `Status manually changed from "${currentStatus}" to "${newStatus}"`,
        event_data: { old_status: currentStatus, new_status: newStatus, new_stage: newStage },
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
      <Button variant="ghost" size="sm" className="text-[10px] h-6 px-2 text-muted-foreground hover:text-foreground" onClick={() => { setNewStatus(currentStatus); setEditing(true); }}>
        <Pencil className="h-3 w-3 mr-1" /> Override status
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-2 bg-muted/30">
      <Label className="text-[10px] text-muted-foreground">Override Status (admin)</Label>
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
      if (error) throw new Error(await getFunctionErrorMessage(error, "OCR failed"));
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
  const [hasUnapprovedEndorsementDeposit, setHasUnapprovedEndorsementDeposit] = useState(false);
  const requestCloseEndorsementAdjuster = useCallback(() => {
    if (hasUnapprovedEndorsementDeposit) {
      const ok = window.confirm(
        "You generated a deposit image but haven't approved it yet. Close anyway? The unapproved image will be discarded.",
      );
      if (!ok) return;
    }
    setHasUnapprovedEndorsementDeposit(false);
    setShowEndorsementAdjuster(false);
  }, [hasUnapprovedEndorsementDeposit]);
  const [depositViewerOpen, setDepositViewerOpen] = useState(false);
  const [depositViewerUrl, setDepositViewerUrl] = useState<string | null>(null);
  const [openingDepositView, setOpeningDepositView] = useState(false);
  const [depositingWithCheckAlt, setDepositingWithCheckAlt] = useState(false);
  const [frontImageDimensions, setFrontImageDimensions] = useState<{ width: number; height: number } | null>(null);
  const [backImageDimensions, setBackImageDimensions] = useState<{ width: number; height: number } | null>(null);



  // Whether this tenant has CheckAlt RDC turned on (platform switch +
  // its own registered FinCapture account) — gates the per-check
  // "Deposit Check" button without exposing checkalt_tenant_accounts
  // or checkalt_config (both admin-only under RLS) to regular staff.
  const { tenantId: checkAltTenantId } = useTenantFilter();
  const { data: checkAltEnabledRaw = false } = useQuery({
    queryKey: ["checkalt-enabled", checkAltTenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("is_checkalt_enabled_for_tenant", {
        _tenant_id: checkAltTenantId,
      });
      if (error) throw error;
      return !!data;
    },
    enabled: !!checkAltTenantId,
  });
  // CheckAlt is hidden platform-wide for now (see src/lib/depositRails.ts).
  const checkAltEnabled = SHOW_CHECKALT && checkAltEnabledRaw;

  // Count of explicit payees on this check — used to decide whether to show
  // the fallback email-based endorsement composer.
  const { data: payeesCount = 0 } = useQuery({
    queryKey: ["check-payees-count", checkId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("check_payees")
        .select("id", { count: "exact", head: true })
        .eq("check_id", checkId);
      if (error) throw error;
      return count ?? 0;
    },
  });
  const [movingToDeposited, setMovingToDeposited] = useState(false);
  const [bypassingEndorsements, setBypassingEndorsements] = useState(false);
  const [branchApprovedAt, setBranchApprovedAt] = useState<number | null>(null);
  const [showForceMove, setShowForceMove] = useState(false);
  const [detailShareOpen, setDetailShareOpen] = useState(false);
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { tenantId } = useTenantFilter();

   const { data: check } = useQuery({
    queryKey: ["check-detail", checkId],
    queryFn: async () => {
      const t0 = performance.now();
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("*, check_payees(*), checkalt_deposits(id, status, submitted_at, approved_at, updated_at, last_status_payload)")
        .eq("id", checkId)
        .single();
      if (error) throw error;
      if (import.meta.env.DEV) {
        console.log(`[perf] check-detail ${checkId.slice(0, 8)} in ${(performance.now() - t0).toFixed(0)}ms`);
      }
      return data as CheckItem;
    },
  });

  // Realtime: refresh check detail + endorsements when any partner deposits or a payee signs.
  useEffect(() => {
    if (!checkId) return;
    const channel = supabase
      .channel(`check-detail-rt-${checkId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "check_intake_items", filter: `id=eq.${checkId}` },
        () => {
          qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "check_endorsements", filter: `check_id=eq.${checkId}` },
        () => {
          qc.invalidateQueries({ queryKey: ["check-endorsement-signatures", checkId] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [checkId, qc]);
  const savedOverride = (check?.endorsement_override as unknown as EndorsementOverride | null) ?? null;
  const showPayToOrder = savedOverride?.showPayToOrder ?? false;
  // Ownership: only the tenant that uploaded the check can edit it. Partners with whom
  // the check is shared are strictly read-only.
  const checkOwnerTenantId = (check as any)?.tenant_id as string | null | undefined;
  const isOwner = !!tenantId && !!checkOwnerTenantId && tenantId === checkOwnerTenantId;
  const isSharedView = !!check && !isOwner;

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

  const {
    data: backImageUrl,
    error: backImageUrlError,
    isFetching: backImageUrlFetching,
    refetch: refetchBackImageUrl,
  } = useQuery({
    queryKey: ["check-back-img", check?.back_image_path],
    enabled: !!check?.back_image_path,
    retry: 1,
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

  const {
    data: endorsementAdjusterImageSource,
    error: endorsementAdjusterImageUrlError,
    isFetching: endorsementAdjusterImageUrlFetching,
    refetch: refetchEndorsementAdjusterImageUrl,
  } = useQuery({
    queryKey: ["check-back-img-original-for-adjuster", check?.id, check?.back_image_path],
    // Prefetch on mount so opening the adjuster is instant — resolving the
    // original back-image path can cost 1-2 round trips (audit lookup + signed
    // URL) plus a full image download to read dimensions.
    enabled: !!check?.id && !!check?.back_image_path && !isSharedView,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      // Prefer the explicit pristine-original pointer written by the adjuster
      // on approve. This is the most reliable source and survives any future
      // renames of the composited deposit artifact.
      const looksComposited = (p: string | null) =>
        !!p && (
          /_endorsed(?:_\d+)?\.[^.]+$/i.test(p) ||
          /endorsed_deposit_[^/]+\.[^.]+$/i.test(p) ||
          /\.svg(\?|$)/i.test(p)
        );

      const currentBackPath = toStorageObjectPath(check!.back_image_path);
      const explicitOriginalRaw = toStorageObjectPath(
        ((check as any)?.back_image_original_path as string | null) ?? null,
      );
      // Only trust the pristine pointer when it is not itself a composite and
      // when the current back is either that same image or a composite derived
      // from it. If the back was re-uploaded (a brand new, non-composite file),
      // that upload is the real original — using the stale pointer would drop
      // whatever was on the new scan (e.g. a mortgage endorsement).
      const explicitOriginal =
        explicitOriginalRaw &&
        !looksComposited(explicitOriginalRaw) &&
        (looksComposited(currentBackPath) || currentBackPath === explicitOriginalRaw)
          ? explicitOriginalRaw
          : null;
      if (explicitOriginal) {
        const { data } = await supabase.storage
          .from("claim-files")
          .createSignedUrl(explicitOriginal, 3600);
        if (data?.signedUrl) return { url: data.signedUrl, path: explicitOriginal };
      }


      const currentPath = toStorageObjectPath(check!.back_image_path);
      if (!currentPath) return backImageUrl ? { url: backImageUrl, path: null } : null;

      // Detect any known "already-composited" back artifact so we don't feed
      // the composite back into the editor (which stacks endorsements).
      const isComposite =
        /_endorsed(?:_\d+)?\.[^.]+$/i.test(currentPath) ||
        /endorsed_deposit_[^/]+\.[^.]+$/i.test(currentPath) ||
        /\.svg(\?|$)/i.test(currentPath);

      let sourcePath = currentPath;
      if (isComposite) {
        const { data: compositeAudits } = await supabase
          .from("check_audit_log")
          .select("event_data")
          .eq("check_id", check!.id)
          .eq("event_type", "endorsement_signatures_composited")
          .order("created_at", { ascending: false })
          .limit(25);

        const matchingAudit = (compositeAudits ?? []).find((audit: any) => {
          const eventData = audit?.event_data ?? {};
          return eventData.endorsed_back_image_path === currentPath ||
            eventData.composited_path === currentPath ||
            eventData.composited_back_path === currentPath;
        });

        const auditData = (matchingAudit?.event_data ?? compositeAudits?.[0]?.event_data ?? null) as {
          original_back_image_path?: string;
          original_back_path?: string;
        } | null;

        sourcePath =
          toStorageObjectPath(auditData?.original_back_image_path) ??
          toStorageObjectPath(auditData?.original_back_path) ??
          currentPath;
      }

      if (sourcePath === currentPath && backImageUrl) return { url: backImageUrl, path: sourcePath };

      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(sourcePath, 3600);
      return data?.signedUrl
        ? { url: data.signedUrl, path: sourcePath }
        : backImageUrl
          ? { url: backImageUrl, path: currentPath }
          : null;
    },
  });

  const endorsementAdjusterSourceUrl =
    endorsementAdjusterImageSource?.url ?? (endorsementAdjusterImageUrlFetching ? null : backImageUrl ?? null);
  const endorsementAdjusterSourcePath =
    endorsementAdjusterImageSource?.path ?? toStorageObjectPath(check?.back_image_path ?? null);

  const [backImageDimError, setBackImageDimError] = useState<string | null>(null);
  const [backImageDimReloadKey, setBackImageDimReloadKey] = useState(0);
  useEffect(() => {
    setBackImageDimensions(null);
    setBackImageDimError(null);
    if (!endorsementAdjusterSourceUrl) return;
    let cancelled = false;
    const img = new Image();
    img.decoding = "async";
    const timeout = window.setTimeout(() => {
      if (!cancelled && !img.complete) {
        setBackImageDimError("Timed out loading check image.");
      }
    }, 10000);
    img.onload = () => {
      if (cancelled) return;
      window.clearTimeout(timeout);
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setBackImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
      } else {
        setBackImageDimError("Check image reported zero dimensions.");
      }
    };
    img.onerror = () => {
      if (cancelled) return;
      window.clearTimeout(timeout);
      setBackImageDimError("We couldn't load the check image.");
    };
    img.src = endorsementAdjusterSourceUrl;
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [endorsementAdjusterSourceUrl, backImageDimReloadKey]);

  // Hard preparation timeout so "Preparing endorsement editor…" can never hang.
  const [endorsementPrepTimedOut, setEndorsementPrepTimedOut] = useState(false);
  const endorsementEditorReady = !!endorsementAdjusterSourceUrl && !!backImageDimensions;
  useEffect(() => {
    setEndorsementPrepTimedOut(false);
    if (!showEndorsementAdjuster) return;
    if (endorsementEditorReady) return;
    const t = window.setTimeout(() => setEndorsementPrepTimedOut(true), 8000);
    return () => window.clearTimeout(t);
  }, [showEndorsementAdjuster, endorsementEditorReady, backImageDimReloadKey, endorsementAdjusterSourceUrl]);

  const endorsementPrepError =
    backImageDimError ||
    (endorsementPrepTimedOut && !endorsementEditorReady
      ? "The endorsement editor could not finish loading. The check image may be temporarily unavailable."
      : null) ||
    ((endorsementAdjusterImageUrlError || backImageUrlError) && !endorsementAdjusterSourceUrl
      ? "We couldn't resolve the back-of-check image URL."
      : null);

  const retryEndorsementPrep = useCallback(() => {
    setEndorsementPrepTimedOut(false);
    setBackImageDimError(null);
    setBackImageDimensions(null);
    qc.invalidateQueries({ queryKey: ["check-back-img", check?.back_image_path] });
    qc.invalidateQueries({ queryKey: ["check-back-img-original-for-adjuster", check?.id, check?.back_image_path] });
    void refetchBackImageUrl();
    void refetchEndorsementAdjusterImageUrl();
    setBackImageDimReloadKey((k) => k + 1);
  }, [qc, check?.back_image_path, check?.id, refetchBackImageUrl, refetchEndorsementAdjusterImageUrl]);

  useEffect(() => {
    setFrontImageDimensions(null);
    if (!frontImageUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setFrontImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.src = frontImageUrl;
    return () => { cancelled = true; };
  }, [frontImageUrl]);



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
      const [{ data: endorsementData, error: endorsementError }, { data: payeeData, error: payeeError }] = await Promise.all([
        supabase
          .from("check_endorsements")
          .select("id, payee_name, payee_type, status, signature_image_url, signature_method, signed_at")
          .eq("check_id", checkId),
        supabase
          .from("check_payees")
          .select("id, payee_name, payee_type, endorsement_status, endorsed_at, contact_email, contact_phone, notification_sent_via, notification_sent_at")
          .eq("check_id", checkId),
      ]);

      if (endorsementError) throw endorsementError;
      if (payeeError) throw payeeError;

      return mergeEndorsementSummaryRows(
        checkId,
        (endorsementData ?? []) as CheckEndorsementSummary[],
        (payeeData ?? []) as CheckPayee[],
      );
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

      const { error: decisionErr } = await supabase.rpc("submit_check_review_decision_safe", {
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
      const { data, error } = await supabase.rpc("submit_check_review_decision_safe", {
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

  // One-click CheckAlt deposit from the check's own Overview tab — ensures a
  // deposit_items row exists and is assigned to CheckAlt, then submits the
  // real FinCapture API call (mirrors DepositOperationsConsole's flow).
  const handleDepositWithCheckAlt = async () => {
    if (!user?.id || !check) return;
    setDepositingWithCheckAlt(true);
    try {
      const { data: existingItem } = await supabase
        .from("deposit_items")
        .select("id, status, provider")
        .eq("check_id", checkId)
        .maybeSingle();

      let depositItemId = existingItem?.id ?? null;
      let itemStatus = existingItem?.status ?? null;
      const itemProvider = existingItem?.provider ?? null;

      if (!depositItemId) {
        const { data: prepData, error: prepErr } = await supabase.rpc("deposit_action", {
          p_action: "prepare_deposit",
          p_actor_id: user.id,
          p_check_id: checkId,
          p_notes: "Deposited from Check Command Center",
        });
        if (prepErr) throw prepErr;
        depositItemId = (prepData as any)?.deposit_item_id ?? null;
        if (!depositItemId) throw new Error("prepare_deposit did not return a deposit_item_id");
        itemStatus = "pending_assignment";
      }

      if (itemStatus === "pending_assignment") {
        const { error: assignErr } = await supabase.rpc("deposit_action", {
          p_action: "assign_provider",
          p_actor_id: user.id,
          p_deposit_item_id: depositItemId,
          p_provider: "checkalt",
          p_notes: "Assigned deposit rail from Check Command Center",
        });
        if (assignErr) throw assignErr;
      } else if (itemProvider !== "checkalt") {
        throw new Error(`This check is already assigned to ${itemProvider ?? "another"} provider in the deposit pipeline.`);
      }

      // Pre-normalize each side in its own edge invocation so oversized
      // legacy images never trip the deposit worker's CPU limit.
      const prepared = await prepareCheckAltDeposit(checkId);
      const { data: submitData, error: submitErr } = await supabase.functions.invoke("checkalt-submit-deposit", {
        body: { check_intake_item_id: checkId, ...prepared },
      });
      if (submitErr) throw new Error(await getFunctionErrorMessage(submitErr, "Deposit failed"));

      sonnerToast.success("Deposit queued", {
        description: `Check #${check.check_number ?? checkId.slice(0, 8)} — images are being compressed and submitted in the background. Status will update shortly.`,
      });
      qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["deposit-items"] });
      qc.invalidateQueries({ queryKey: ["check-audit", checkId] });
      onRefresh();
    } catch (e: any) {
      toast({ title: "Deposit failed", description: e.message, variant: "destructive" });
    } finally {
      setDepositingWithCheckAlt(false);
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

  const ensureDepositReadyBackImage = async (overrideData?: EndorsementOverride | null) => {
    if (!check?.id || !check.back_image_path) return backImageUrl ?? null;

    setPreparingDepositPrint(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const { data, error } = await supabase.functions.invoke("composite-endorsement-signatures", {
        body: { checkId: check.id, overrideData: overrideData ?? undefined },
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
        image_dimensions?: { width?: number; height?: number };
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

      qc.setQueryData(["check-detail", checkId], (current: CheckItem | undefined) => (
        current
          ? {
              ...current,
              back_image_path: compositedPath,
              endorsement_override: overrideData
                ? (overrideData as unknown as Record<string, unknown>)
                : current.endorsement_override,
            }
          : current
      ));
      if (signedData?.signedUrl) {
        qc.setQueryData(["check-back-img", compositedPath], signedData.signedUrl);
      }
      if (payload.image_dimensions?.width && payload.image_dimensions?.height) {
        setBackImageDimensions({
          width: payload.image_dimensions.width,
          height: payload.image_dimensions.height,
        });
      }

      qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-audit", checkId] });
      qc.invalidateQueries({ queryKey: ["check-back-img"] });
      qc.invalidateQueries({ queryKey: ["check-back-img-original-for-adjuster", checkId] });
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

  // Suppress redundant "Ready for Deposit" recommendation when status already shows it.
  const suppressDetailRec =
    check.deposit_recommendation === "ready_for_deposit" &&
    (check.status === "approved_for_deposit" || check.status === "deposited");
  const rec = check.deposit_recommendation && !suppressDetailRec
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
          <div className="flex items-center gap-2">
            <Badge className={statusColors[check.status] ?? ""}>
              {prettifyStatus(check.status)}
            </Badge>
          </div>
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
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => setDetailShareOpen(true)}
              title="Share with partner"
            >
              <Share2 className="h-3 w-3" /> Share
            </Button>
          )}
        </div>

        {/* Inline front-of-check thumbnail removed — the "View Check Images"
            button at the top of the panel is the single entry point for check
            imagery. */}
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
          const v = assessCheckValidity(check.issue_date, { staleThresholdDays: check.expiration_days });
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

        {/* Deposit Blocked banner moved into Endorsements tab */}


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

        {/* Endorsement Packet moved into Audit tab */}
      </CardHeader>
      <CardContent className="p-0">
        <Tabs value={detailTab} onValueChange={setDetailTab}>
          <div className="w-full overflow-x-auto scrollbar-hide">
            <TabsList className="w-max min-w-full rounded-none flex-nowrap justify-start">
              <TabsTrigger value="overview" className="text-xs whitespace-nowrap px-2 sm:px-3">Overview</TabsTrigger>
              <TabsTrigger value="endorsements" className="text-xs whitespace-nowrap px-2 sm:px-3">
                Payee Endorsements
                {pendingEndorsements.length > 0 && (
                  <span className="ml-1 bg-amber-500/30 text-amber-400 rounded-full text-[9px] px-1.5">
                    {pendingEndorsements.length}
                  </span>
                )}
              </TabsTrigger>

              
              <TabsTrigger value="funds" className="text-xs whitespace-nowrap px-2 sm:px-3 gap-1">
                Funds
                {incomingPaymentCount > 0 && (
                  <span className="ml-1 bg-emerald-500/30 text-emerald-400 rounded-full text-[9px] px-1.5">
                    {incomingPaymentCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="files" className="text-xs whitespace-nowrap px-2 sm:px-3">Files</TabsTrigger>

              <TabsTrigger value="partners" className="text-xs whitespace-nowrap px-2 sm:px-3 gap-1">
                <Share2 className="h-3 w-3" /> Partners
                <MessageSquare className="h-3 w-3 ml-0.5 opacity-70" />
              </TabsTrigger>
              <TabsTrigger value="audit" className="text-xs whitespace-nowrap px-2 sm:px-3">Audit</TabsTrigger>
            </TabsList>
          </div>

          <ScrollArea className="h-[calc(100vh-340px)] min-h-[400px]">
            <TabsContent value="overview" className="p-4 space-y-3 mt-0">
              <PostHomeownerUpdateCard
                claimId={check.claim_id ?? null}
                tenantId={(check as any).tenant_id ?? null}
                checkId={checkId}
                compact
              />

              <DepositStatusPanel
                checkId={checkId}
                depositedAt={check.deposited_at ?? null}
                depositedByTenantId={check.deposited_by_tenant_id ?? null}
                lastUpdated={check.updated_at ?? null}
              />
              <SignatureStatusPanel checkId={checkId} />
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
              <EditableField
                label="Expiration (Days)"
                checkId={checkId}
                field="expiration_days"
                value={check.expiration_days?.toString() ?? null}
                inputType="number"
                readOnly={isSharedView}
                displayFormatter={(v) => (v ? `${v} days` : "Default (180 days)")}
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
              {/* OCR status/re-run intentionally hidden from Overview to
                  reduce noise. Access via Audit tab or admin tools. */}
              <Separator />
              {/* Inline front/back previews removed — the front of the check
                  is shown at the top of the detail panel, and the back is
                  available via the "View Check Images" button. The wrapper
                  below stays in place so the back-upload prompt and the
                  ready-for-deposit CTA continue to render. */}
              {(frontImageUrl || backImageUrl) && (
                <div className="space-y-2">
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
                  {/* Ready-for-deposit CTA — only visible once all endorsements are complete.
                      When CheckAlt is enabled this is the one-click "Deposit Check"
                      button; otherwise it falls back to manual mobile deposit. */}
                  {(() => {
                    const latestCA = (check.checkalt_deposits ?? [])
                      .slice()
                      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))[0];
                    const caRejected = latestCA && ["rejected", "returned", "error"].includes(String(latestCA.status));
                    const rejPayload = (latestCA?.last_status_payload as any) ?? null;
                    const rejCode = rejPayload?.status ?? rejPayload?.statusCode ?? null;
                    const rejDesc = rejPayload?.statusDescription ?? rejPayload?.description ?? null;
                    return (
                      <>
                        {caRejected && check.check_stage !== "deposited" && check.status !== "deposited" && (
                          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-300 mt-1">
                            <div className="font-medium">Deposit {latestCA?.status} {rejCode ? `(code ${rejCode})` : ""}</div>
                            {rejDesc && <div className="text-red-200/80 mt-0.5">{String(rejDesc)}</div>}
                            <div className="text-red-200/60 mt-1">Click below to resubmit deposit.</div>
                          </div>
                        )}
                        {allEndorsementsComplete && !isDepositBlocked && check.check_stage !== "deposited" && check.status !== "deposited" && (
                          checkAltEnabled ? (
                            <Button
                              size="sm"
                              className="w-full mt-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                              disabled={depositingWithCheckAlt}
                              onClick={handleDepositWithCheckAlt}
                            >
                              <Banknote className="h-4 w-4 mr-2" />
                              {depositingWithCheckAlt ? "Depositing..." : caRejected ? "Resubmit Deposit" : "Deposit Check"}
                            </Button>
                          ) : (
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
                      )
                        )}
                      </>
                    );
                  })()}
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
              {isDepositBlocked && (
                <div className="border border-amber-500/30 bg-amber-500/10 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2 text-amber-400 font-semibold text-sm">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    Deposit Blocked
                  </div>
                  {blockingReasons.map((reason, i) => (
                    <p key={i} className="text-xs text-amber-300/80 pl-6">• {reason}</p>
                  ))}
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
              <Suspense fallback={<TabLoader />}>
                <EndorsementChecklist
                  checkId={checkId}
                  onRefresh={onRefresh}
                  partnerMode={isSharedView}
                />
              </Suspense>

              {/* Fallback email-based endorsement composer — only shown when no payees
                  are listed on the check, since the checklist above handles signers. */}
              {payeesCount === 0 && (
                <Suspense fallback={<TabLoader />}>
                  <SharedCheckEndorsements
                    checkIntakeItemId={checkId}
                    documentName={`Check #${check?.check_number || ""} endorsement`.trim()}
                  />
                </Suspense>
              )}

              {/* Direction-to-Pay composer moved to the Files tab. */}




              {check?.back_image_path && !isSharedView && (
                <>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      disabled={!check?.back_image_path}
                      onPointerEnter={() => { void preloadEndorsementAdjuster(); }}
                      onFocus={() => { void preloadEndorsementAdjuster(); }}
                      onClick={() => {
                        if (showEndorsementAdjuster) return;
                        // Open the dialog immediately — assets load inside it.
                        setShowEndorsementAdjuster(true);
                      }}
                    >
                      Adjust Received Endorsement
                    </Button>
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
                           await ensureDepositReadyBackImage(nextOverride);
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

                  <Dialog
                    open={showEndorsementAdjuster}
                    onOpenChange={(open) => {
                      if (!open) requestCloseEndorsementAdjuster();
                    }}
                  >
                    <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
                      <DialogHeader>
                        <DialogTitle>Adjust Received Endorsement</DialogTitle>
                      </DialogHeader>
                      {endorsementAdjusterSourceUrl && backImageDimensions ? (
                        <EndorsementAdjuster
                          key={checkId}
                          checkId={checkId}
                          originalImageUrl={endorsementAdjusterSourceUrl}
                          originalImagePath={
                            endorsementAdjusterSourcePath
                          }
                          imageWidth={backImageDimensions.width}
                          imageHeight={backImageDimensions.height}
                          companyName={check?.external_origin?.tenant_name as string || "Freedom Adjustment"}
                          initialOverride={
                            (check?.endorsement_override as unknown as EndorsementOverride | null) ?? null
                          }
                          onUnapprovedDepositChange={setHasUnapprovedEndorsementDeposit}
                          onDepositImageApproved={async ({ depositPath }) => {
                            const originalToPersist =
                              ((check as any)?.back_image_original_path as string | null) ??
                              endorsementAdjusterSourcePath;
                            const { error: saveErr } = await supabase
                              .from("check_intake_items")
                              .update({
                                back_image_path: depositPath,
                                back_image_original_path: originalToPersist,
                                updated_at: new Date().toISOString(),
                              })
                              .eq("id", checkId);
                            if (saveErr) throw saveErr;
                            setHasUnapprovedEndorsementDeposit(false);
                            setShowEndorsementAdjuster(false);
                            qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
                            qc.invalidateQueries({ queryKey: ["check-back-img"] });
                          }}
                          onClose={requestCloseEndorsementAdjuster}
                        />
                      ) : (
                        <div className="space-y-4 py-2">
                          <div className={`text-sm ${endorsementPrepError ? "text-destructive" : "text-muted-foreground"}`}>
                            {endorsementPrepError
                              ? endorsementPrepError
                              : !endorsementAdjusterSourceUrl
                                ? (endorsementAdjusterImageUrlFetching || backImageUrlFetching
                                    ? "Loading check image URL…"
                                    : "Preparing endorsement editor…")
                                : "Loading check image…"}
                          </div>
                          <div className="h-64 w-full animate-pulse rounded-md bg-muted" />
                          <div className="grid grid-cols-2 gap-3">
                            <div className="h-8 animate-pulse rounded bg-muted" />
                            <div className="h-8 animate-pulse rounded bg-muted" />
                          </div>
                          {(endorsementPrepError || endorsementPrepTimedOut) && (
                            <div className="flex gap-2">
                              <Button size="sm" variant="outline" onClick={retryEndorsementPrep}>
                                Retry Loading
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setShowEndorsementAdjuster(false)}>
                                Close
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </DialogContent>
                  </Dialog>
                </>
              )}

              {/* Payees are managed inline in the endorsement list above —
                  one row per payee with email, CC contractor, add and remove. */}
            </TabsContent>


            <TabsContent value="funds" className="p-4 mt-0 space-y-4">
              {/* Claim Ledger — always visible so funds can be tracked accurately */}
              <ClaimLedgerCard
                checkIntakeItemId={checkId}
                claimId={check.claim_id ?? null}
                detectedClaimNumber={check.detected_claim_number ?? null}
                readOnly={isSharedView}
              />

              {(() => {
                const stage = (check as any).check_stage ?? null;
                const status = (check as any).status ?? null;
                const isDeposited = stage === "deposited" || status === "deposited";
                const checkAmt = Number(check.amount ?? 0);

                if (!isOwner) {
                  return (
                    <IncomingFundsTab
                      checkIntakeItemId={checkId}
                      checkNumber={check.check_number ?? undefined}
                      carrierName={check.carrier_name ?? undefined}
                      claimId={check.claim_id ?? null}
                      detectedClaimNumber={check.detected_claim_number ?? null}
                    />

                  );
                }


                return (
                  <>
                    {contractorPartner ? (
                      <SendPaymentPanel
                        checkIntakeItemId={checkId}
                        checkAmount={checkAmt}
                        checkNumber={check.check_number ?? undefined}
                        carrierName={check.carrier_name ?? undefined}
                        contractorTenantId={contractorPartner.id}
                        contractorName={contractorPartner.name}
                      />
                    ) : null}

                    <IncomingFundsTab
                        checkIntakeItemId={checkId}
                        checkNumber={check.check_number ?? undefined}
                        carrierName={check.carrier_name ?? undefined}
                        claimId={check.claim_id ?? null}
                        detectedClaimNumber={check.detected_claim_number ?? null}
                        payoutEnabled={isDeposited}
                      />
                  </>
                );
              })()}
            </TabsContent>


            <TabsContent value="files" className="p-4 mt-0 space-y-4">
              <Suspense fallback={<TabLoader />}>
                <CheckFilesSection checkIntakeItemId={checkId} />
              </Suspense>
              <Suspense fallback={<TabLoader />}>
                <SharedCheckPaymentDirection
                  checkIntakeItemId={checkId}
                  checkNumber={check?.check_number}
                />
              </Suspense>
            </TabsContent>




            <TabsContent value="packet" className="p-4 mt-0">
              <Suspense fallback={<TabLoader />}>
                <DepositPacketGenerator checkId={checkId} />
              </Suspense>
            </TabsContent>

            <TabsContent value="audit" className="p-4 space-y-3 mt-0">
              <EndorsementPacketCard checkId={checkId} packetPath={check.endorsement_packet_path} />
              <div className="space-y-2">
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
              </div>
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
        {/* Admin tools — hidden by default, available on every tab */}
        {!isSharedView && (
          <div className="border-t px-4 py-2 bg-muted/20">
            <details className="group">
              <summary className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer list-none flex justify-end select-none">
                <span className="underline underline-offset-2">Admin tools</span>
              </summary>
              <div className="mt-2 flex flex-col sm:flex-row sm:flex-wrap sm:justify-end gap-2 items-stretch sm:items-center">
                <div className="w-full sm:w-auto sm:max-w-xs">
                  <StatusOverride
                    checkId={checkId}
                    currentStatus={check.status}
                    onSuccess={() => { qc.invalidateQueries({ queryKey: ["check-detail", checkId] }); qc.invalidateQueries({ queryKey: ["check-intake-items"] }); onRefresh(); }}
                  />
                </div>
                <ReuploadCheckImageButton
                  checkId={checkId}
                  side="front"
                  imagePath={check.front_image_path}
                  onUploaded={onRefresh}
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                />
                <ReuploadCheckImageButton
                  checkId={checkId}
                  side="back"
                  imagePath={check.back_image_path}
                  onUploaded={onRefresh}
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                />
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
                  className="h-8 text-xs"
                />
              </div>

            </details>
          </div>
        )}
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
    <ShareCheckDialog
      checkId={checkId}
      open={detailShareOpen}
      onOpenChange={setDetailShareOpen}
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
      if (error) throw new Error(await getFunctionErrorMessage(error, "Failed to generate endorsement packet"));
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
  inputType?: "text" | "date" | "boolean" | "number";
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
      } else if (inputType === "number") {
        const n = parseInt(draft, 10);
        outValue = isNaN(n) ? null : n;
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
              type={inputType === "date" ? "date" : inputType === "number" ? "number" : "text"}
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
  { value: "deductible", label: "Deductible" },
  { value: "other_structures", label: "Other Structures" },
  { value: "personal_property", label: "Personal Property" },
  { value: "additional_living_expenses", label: "Additional Living Expenses (ALE)" },
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

  const sendEndorsementRequest = async (method: "email") => {
    setSending(true);
    try {
      const normalizedEmail = email.trim();

      if (!normalizedEmail) {
        throw new Error("Please enter an email address for this payee");
      }

      const { error: updateError } = await supabase
        .from("check_payees")
        .update({ contact_email: normalizedEmail || null })
        .eq("id", payee.id);
      if (updateError) throw updateError;

      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Not authenticated");

      const { error } = await supabase.functions.invoke("check-endorsement", {
        body: { action: "send_endorsement_request", payeeId: payee.id, method, email: normalizedEmail },
        headers: { Authorization: `Bearer ${session.session.access_token}` },
      });

      if (error) throw new Error(await getFunctionErrorMessage(error, "Failed to send endorsement request"));
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
            {endorsementStatusLabel(payee.endorsement_status)}
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

      {payee.endorsement_status !== "signed" && payee.endorsement_status !== "waived" && payee.endorsement_status !== "rejected" && !editing && !readOnly && (
        <div className="space-y-2 pt-1">
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-8 text-xs" />
          <Button size="sm" variant="outline" className="w-full text-xs h-7" disabled={sending || !email} onClick={() => sendEndorsementRequest("email")}>
            <Send className="h-3 w-3 mr-1" />Email Endorsement Request
          </Button>
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
  const [sending, setSending] = useState(false);
  const PayeeIcon = payeeTypeIcons[payee.payee_type] ?? AlertTriangle;

  const sendEndorsementRequest = async (method: "email") => {
    setSending(true);
    try {
      const normalizedEmail = email.trim();

      if (!normalizedEmail) {
        throw new Error("Please enter an email address for this payee");
      }

      const { error: updateError } = await supabase
        .from("check_payees")
        .update({ contact_email: normalizedEmail || null })
        .eq("id", payee.id);

      if (updateError) throw updateError;

      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Not authenticated");

      const { error } = await supabase.functions.invoke("check-endorsement", {
        body: {
          action: "send_endorsement_request",
          payeeId: payee.id,
          method,
          email: normalizedEmail,
        },
        headers: { Authorization: `Bearer ${session.session.access_token}` },
      });

      if (error) throw new Error(await getFunctionErrorMessage(error, "Failed to send endorsement request"));
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
          {endorsementStatusLabel(payee.endorsement_status)}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground capitalize">
        {payee.payee_type.replace(/_/g, " ")}
      </p>

      {payee.endorsement_status !== "signed" && payee.endorsement_status !== "waived" && payee.endorsement_status !== "rejected" && (
        <div className="space-y-2 pt-1">
          <Input
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="w-full text-xs h-7"
            disabled={sending || !email}
            onClick={() => sendEndorsementRequest("email")}
          >
            <Send className="h-3 w-3 mr-1" />Email Endorsement Request
          </Button>
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
