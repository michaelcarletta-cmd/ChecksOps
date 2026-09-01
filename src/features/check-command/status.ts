/**
 * Pure status / label / config helpers for the Check Command Center.
 * Extracted from CheckCommandCenter.tsx (Phase 3 architecture split).
 * No React state here — safe to unit test and reuse.
 */
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Clock,
  FileCheck,
  RotateCcw,
  Shield,
  Users,
} from "lucide-react";
import type {
  CheckAltDepositSummary,
  CheckEndorsementSummary,
  CheckItem,
  CheckPayee,
} from "./types";

export const normalizeEndorsementName = (value?: string | null) => (value ?? "").trim().toLowerCase();
export const normalizeEndorsementType = (value?: string | null) => (value ?? "other").trim().toLowerCase();

/**
 * Matches a free-text search query against a money amount.
 * Accepts "$1,250.00", "1250", "1250.00", or partials like "250.0".
 * Only numeric-looking queries (after stripping $, commas, spaces) are tested
 * so name searches never accidentally match amounts.
 */
export const matchesAmountQuery = (query: string, amount: number | null | undefined): boolean => {
  if (amount == null || !Number.isFinite(amount)) return false;
  const q = query.replace(/[$,\s]/g, "");
  if (!q || !/^\d*\.?\d+$/.test(q)) return false;
  const variants = [
    amount.toFixed(2),
    amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    String(Math.trunc(amount)),
  ];
  return variants.some((v) => v.includes(q));
};

export const normalizeEndorsementStatus = (status?: string | null, signedAt?: string | null) => {
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

export function mergeEndorsementSummaryRows(
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

  // Final deduplication by name to ensure no duplicate rows appear in the UI
  const best = new Map<string, CheckEndorsementSummary>();
  const rank = (e: CheckEndorsementSummary) => {
    const s = (e.status ?? "").toLowerCase();
    if (s === "signed" || !!e.signed_at) return 3;
    if (s === "waived") return 2;
    if (s === "sent") return 1;
    return 0;
  };
  for (const e of merged) {
    const key = normalizeEndorsementName(e.payee_name);
    const prev = best.get(key);
    // Prefer higher rank, or earlier creation date for stability
    if (!prev || rank(e) > rank(prev)) {
      best.set(key, e);
    } else if (rank(e) === rank(prev) && e.created_at && prev.created_at) {
      if (new Date(e.created_at).getTime() < new Date(prev.created_at).getTime()) {
        best.set(key, e);
      }
    }
  }

  return Array.from(best.values());
}

/**
 * For checks mirrored from a partner app (e.g. FreedomClaims), the local `status`
 * column stays at `uploaded` because ChecksOps has not processed them internally.
 * The partner's authoritative workflow state is mirrored into `partner_status`
 * by the receive-check-status edge function.
 */
export const isMirroredCheck = (c: CheckItem) =>
  !!c.external_origin && typeof c.external_origin === "object" &&
  (c.external_origin as any).source_app === "freedom_crm";

// Lifecycle rank — higher = further along. Used to prefer whichever of local
// status vs mirrored partner_status is most advanced.
export const lifecycleRank = (s: string | null | undefined): number => {
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

export const getEffectiveStatus = (c: CheckItem): string => {
  if (isMirroredCheck(c) && c.partner_status) {
    // Prefer local on ties so completed local work is never masked.
    return lifecycleRank(c.status) >= lifecycleRank(c.partner_status)
      ? c.status
      : c.partner_status;
  }
  return c.status;
};

export const prettifyStatus = (s: string | null | undefined): string => {
  if (!s) return "";
  if (s === "approved_for_deposit" || s === "ready_for_deposit" || s === "ready") {
    return "Ready for Deposit";
  }
  if (s === "released" || s === "deposited") {
    return "Deposited";
  }
  return s.replace(/_/g, " ");
};

export const getEffectiveStatusLabel = (c: CheckItem): string => {
  if (isMirroredCheck(c) && c.partner_status) {
    const useLocal = lifecycleRank(c.status) >= lifecycleRank(c.partner_status);
    if (useLocal) return prettifyStatus(c.status);
    return prettifyStatus(c.partner_status);
  }
  return prettifyStatus(c.status);
};

export const getLatestCheckAltDeposit = (c: CheckItem): CheckAltDepositSummary | null => {
  const deposits = c.checkalt_deposits ?? [];
  if (deposits.length === 0) return null;
  return [...deposits].sort((a, b) => {
    const aTime = new Date(a.updated_at ?? a.approved_at ?? a.submitted_at ?? 0).getTime();
    const bTime = new Date(b.updated_at ?? b.approved_at ?? b.submitted_at ?? 0).getTime();
    return bTime - aTime;
  })[0] ?? null;
};

export const getCheckAltStatus = (c: CheckItem): string | null =>
  getLatestCheckAltDeposit(c)?.status ?? null;

export const statusColors: Record<string, string> = {
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
  returned: "bg-orange-500/20 text-orange-300",
  voided: "bg-destructive/20 text-destructive",
  ready: "bg-emerald-500/20 text-emerald-400",
};

// Per-tab status label overrides requested by ops.
export const getTabStatusLabel = (c: CheckItem, tab: string): string => {
  if (tab === "endorsements") return "Endorsements in Progress";
  if (tab === "ready") return "Endorsed - Ready for Deposit";
  if (tab === "deposited") {
    if (getCheckAltStatus(c) === "pending_approval") return "Pending Approval";
    const depositedAt = c.deposited_at;
    if (!depositedAt) return "Deposit in Progress";
    const hours = (Date.now() - new Date(depositedAt).getTime()) / 36e5;
    return hours >= 48 ? "Ready for Release" : "Deposit in Progress";
  }
  return getEffectiveStatusLabel(c);
};

export const getTabStatusClass = (c: CheckItem, tab: string): string => {
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

/**
 * Extract a clean insured/policyholder name from a raw check payee_line.
 */
export function extractInsuredName(payeeLine: string | null | undefined): string | null {
  if (!payeeLine) return null;
  let line = payeeLine.replace(/^\s*(pay\s+to\s+the\s+order\s+of[:\s]*|pay\s+to[:\s]+|of[:\s]+)/i, "").trim();
  const digitIdx = line.search(/\d/);
  if (digitIdx > 0) line = line.slice(0, digitIdx).trim();
  const parts = line.split(/\s*(?:&|\band\b|,|\/)\s*/i).map((p) => p.trim()).filter(Boolean);
  const EXCLUDE = /freedom\s+adjust|adjuster|bank|mortgage|loan\s*depot|loandepot|isaoa|atima|its\s+successors|n\.?a\.?$|llc$|inc\.?$|corp|company|servicing|trust|holdings|public\s+adjust/i;
  const insured = parts.find((p) => !EXCLUDE.test(p)) || parts[0] || null;
  return insured ? insured.replace(/\s+/g, " ").trim() : null;
}

export const recommendationConfig: Record<string, { label: string; icon: typeof CheckCircle2; color: string }> = {
  ready_for_deposit: { label: "Ready for Deposit", icon: CheckCircle2, color: "text-emerald-400" },
  endorsements_pending: { label: "Endorsements Pending", icon: Clock, color: "text-amber-400" },
  manual_review_required: { label: "Manual Review Required", icon: AlertTriangle, color: "text-orange-400" },
  branch_deposit_recommended: { label: "Branch Deposit", icon: Building2, color: "text-blue-400" },
  request_reissue: { label: "Request Reissue", icon: RotateCcw, color: "text-red-400" },
};

export const payeeTypeIcons: Record<string, typeof Users> = {
  insured: Users,
  mortgage_company: Building2,
  contractor: Shield,
  public_adjuster: FileCheck,
  other: AlertTriangle,
};

export const endorsementColors: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  viewed: "bg-blue-500/20 text-blue-400",
  signed: "bg-emerald-500/20 text-emerald-400",
  waived: "bg-emerald-500/20 text-emerald-400",
  rejected: "bg-red-500/20 text-red-400",
  expired: "bg-muted text-muted-foreground line-through",
};

// "Waived" means the signature is physically on the check — show it as Endorsed.
export const endorsementStatusLabel = (status?: string | null): string => {
  const v = (status ?? "").toLowerCase();
  if (v === "waived" || v === "signed") return "Endorsed";
  return status ?? "pending";
};

export const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "needs_review", label: "Review" },
  { value: "endorsements_in_progress", label: "Endorsing" },
  { value: "approved_for_deposit", label: "Ready for Deposit" },
  { value: "loss_draft_required", label: "Loss Draft" },
  { value: "reissue_requested", label: "Reissue" },
  { value: "voided", label: "Void" },
];

export const FUNDS_TYPE_OPTIONS: { value: string; label: string }[] = [
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
