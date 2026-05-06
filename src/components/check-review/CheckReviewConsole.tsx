import { Fragment, useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertTriangle, CheckCircle2, Building2, Edit3, Save,
  RotateCcw, Shield, Users, FileCheck, Loader2, Merge,
  Trash2, Plus, FileImage,
} from "lucide-react";
import { DepositImageViewer } from "@/components/checks/DepositImageViewer";
import { assessCheckValidity, isAtRisk } from "@/lib/checkValidity";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CheckPayee {
  id: string;
  payee_name: string;
  payee_type: string;
  endorsement_status: string;
  endorsed_at: string | null;
  endorsement_token: string | null;
}

interface ReviewCheck {
  id: string;
  front_image_path: string | null;
  carrier_name: string | null;
  check_number: string | null;
  amount: number | null;
  issue_date: string | null;
  payee_line: string | null;
  is_multi_payee: boolean;
  ocr_status: string;
  ocr_needs_verification?: boolean | null;
  status: string;
  deposit_recommendation: string | null;
  deposit_recommendation_reasons: string[] | null;
  detected_claim_number: string | null;
  claim_id: string | null;
  created_at: string;
  check_payees?: CheckPayee[];
}

interface ReviewCheckGroup {
  key: string;
  claimNumber: string;
  policyholderName: string;
  checks: ReviewCheck[];
  totalAmount: number;
  earliestCreatedAt: string;
}

const ROUTED_STATUSES = [
  "endorsements_in_progress",
  "endorsements_complete",
  "approved_for_deposit",
  "branch_deposit_required",
  "loss_draft_required",
  "reissue_requested",
  "ready",
  "deposited",
  "voided",
];

const DEPOSIT_PATHS = [
  { value: "endorsements_in_progress", label: "Send to Endorsing", icon: Users, color: "text-amber-400" },
  { value: "loss_draft_required", label: "Loss Draft (Mortgage)", icon: Building2, color: "text-purple-400" },
  { value: "branch_deposit_required", label: "Branch Deposit Required", icon: Building2, color: "text-blue-400" },
  { value: "reissue_requested", label: "Request Reissue", icon: RotateCcw, color: "text-orange-400" },
  { value: "hold_for_claim_review", label: "Hold for Claim Review", icon: AlertTriangle, color: "text-amber-400" },
];

const PAYEE_TYPES = ["insured", "mortgage_company", "contractor", "public_adjuster", "unknown"];

const REISSUE_REASON_CATEGORIES = [
  { value: "payee_error", label: "Payee Error" },
  { value: "amount_mismatch", label: "Amount Mismatch" },
  { value: "stale_dated", label: "Stale Dated" },
  { value: "damaged_check", label: "Damaged Check" },
  { value: "wrong_claim", label: "Wrong Claim" },
  { value: "missing_payee", label: "Missing Payee" },
  { value: "other", label: "Other" },
];

const payeeTypeIcons: Record<string, typeof Users> = {
  insured: Users,
  mortgage_company: Building2,
  contractor: Shield,
  public_adjuster: FileCheck,
  unknown: AlertTriangle,
};

/* ------------------------------------------------------------------ */
/*  Review Queue                                                       */
/* ------------------------------------------------------------------ */

export function CheckReviewQueue({
  onSelectCheck,
  selectedCheckId,
}: {
  onSelectCheck: (id: string) => void;
  selectedCheckId: string | null;
}) {
  const { tenantId } = useTenantFilter();
  const { data: reviewChecks = [], isLoading } = useQuery({
    queryKey: ["check-review-queue", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("*, check_payees(*)")
        .eq("tenant_id", tenantId!)
        .not("status", "in", `(${ROUTED_STATUSES.join(",")})`)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ReviewCheck[];
    },
    enabled: !!tenantId,
    refetchInterval: 15000,
  });

  const linkedClaimIds = useMemo(() => Array.from(new Set(reviewChecks.map((check) => check.claim_id).filter(Boolean))) as string[], [reviewChecks]);

  const { data: linkedClaims = [] } = useQuery({
    queryKey: ["check-review-linked-claims", linkedClaimIds],
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

  const groupedReviewChecks = useMemo<ReviewCheckGroup[]>(() => {
    const claimLookup = new Map(linkedClaims.map((claim: any) => [claim.id, claim]));
    const groups = new Map<string, ReviewCheckGroup>();

    reviewChecks.forEach((check) => {
      const linked = check.claim_id ? claimLookup.get(check.claim_id) : null;
      const claimNumber = linked?.claim_number || check.detected_claim_number || "Unlinked claim";
      const insuredPayee = check.check_payees?.find((payee) => payee.payee_type === "insured")?.payee_name;
      const policyholderName = linked?.policyholder_name || insuredPayee || check.payee_line || "Unknown insured";
      const key = `${claimNumber.trim().toLowerCase()}::${policyholderName.trim().toLowerCase()}`;
      const existing = groups.get(key);

      if (existing) {
        existing.checks.push(check);
        existing.totalAmount += check.amount ?? 0;
        if (new Date(check.created_at).getTime() < new Date(existing.earliestCreatedAt).getTime()) {
          existing.earliestCreatedAt = check.created_at;
        }
      } else {
        groups.set(key, { key, claimNumber, policyholderName, checks: [check], totalAmount: check.amount ?? 0, earliestCreatedAt: check.created_at });
      }
    });

    return Array.from(groups.values()).sort((a, b) => new Date(a.earliestCreatedAt).getTime() - new Date(b.earliestCreatedAt).getTime());
  }, [linkedClaims, reviewChecks]);

  function getReviewReason(check: ReviewCheck): string {
    const reasons: string[] = [];
    if (check.ocr_needs_verification) reasons.push("Needs Verification");
    if (check.ocr_status === "failed") reasons.push("OCR failed");
    if (check.deposit_recommendation === "manual_review_required") reasons.push("Manual review required");
    if (check.check_payees?.some((p) => p.endorsement_status === "rejected")) reasons.push("Rejected endorsement");
    if (check.check_payees?.some((p) => p.payee_type === "mortgage_company")) reasons.push("Mortgage payee");
    if ((check.check_payees?.length ?? 0) >= 3) reasons.push("3+ payees");
    if (check.check_payees?.some((p) => p.payee_type === "unknown")) reasons.push("Unclear payee classification");
    if (reasons.length === 0) reasons.push("Awaiting routing");
    return reasons.join(" · ");
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />Loading review queue...
      </div>
    );
  }

  if (reviewChecks.length === 0) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <CheckCircle2 className="h-8 w-8 mx-auto mb-2 opacity-30" />
        <p className="text-sm">No checks pending review</p>
      </div>
    );
  }

  return (
    <ScrollArea className="max-h-none lg:h-[calc(100vh-400px)]">
      <div className="space-y-2 p-2">
        {groupedReviewChecks.map((group) => (
          <Fragment key={group.key}>
            <div className="rounded-lg border bg-muted/30 px-3 py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{group.policyholderName}</p>
                  <p className="text-xs text-muted-foreground">Claim #{group.claimNumber} · {group.checks.length} {group.checks.length === 1 ? "check" : "checks"}</p>
                </div>
                <span className="text-sm font-semibold tabular-nums text-foreground">${group.totalAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
            {group.checks.map((check) => (
              <Card
                key={check.id}
                className={`cursor-pointer transition-colors hover:bg-accent/30 ${
                  selectedCheckId === check.id ? "ring-1 ring-primary bg-accent/50" : ""
                }`}
                onClick={() => onSelectCheck(check.id)}
              >
                <CardContent className="p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-sm font-medium">
                      #{check.check_number || "Pending"}
                    </span>
                    <span className="text-sm font-bold tabular-nums">
                      {check.amount != null
                        ? `$${check.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                        : "—"}
                    </span>
                  </div>
              <p className="text-xs text-muted-foreground truncate">
                {check.carrier_name || "Unknown carrier"}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {check.ocr_needs_verification ? (
                  <Badge variant="outline" className="text-[10px] bg-amber-500/15 text-amber-500 border-amber-500/30">
                    <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                    Needs Verification
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] bg-blue-500/10 text-blue-400 border-blue-500/20">
                    {getReviewReason(check).split(" · ")[0]}
                  </Badge>
                )}
                {check.check_payees && check.check_payees.length > 0 && (
                  <Badge variant="outline" className="text-[10px]">
                    {check.check_payees.length} payee{check.check_payees.length > 1 ? "s" : ""}
                  </Badge>
                )}
              </div>
                </CardContent>
              </Card>
            ))}
          </Fragment>
        ))}
      </div>
    </ScrollArea>
  );
}

/* ------------------------------------------------------------------ */
/*  Review Decision Panel — uses transactional RPC                     */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Required-field checker                                             */
/* ------------------------------------------------------------------ */

function getMissingFields(check: ReviewCheck): string[] {
  const missing: string[] = [];
  if (!check.check_number?.trim()) missing.push("Check #");
  if (!check.amount || check.amount <= 0) missing.push("Amount");
  if (!check.issue_date) missing.push("Issue date");
  if (!check.carrier_name?.trim()) missing.push("Carrier name");
  if (!check.payee_line?.trim()) missing.push("Payee line");
  if ((check.check_payees?.length ?? 0) === 0) missing.push("At least one payee");
  return missing;
}

export function ReviewDecisionPanel({
  checkId,
  onComplete,
}: {
  checkId: string;
  onComplete: () => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();

  const formDirtyRef = useRef(false);

  const { data: check } = useQuery({
    queryKey: ["review-check-detail", checkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("*, check_payees(*)")
        .eq("id", checkId)
        .single();
      if (error) throw error;
      return data as ReviewCheck;
    },
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });

  const [editing, setEditing] = useState(false);
  const [carrierName, setCarrierName] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [payeeLine, setPayeeLine] = useState("");
  const [fundsType, setFundsType] = useState<string>("");
  const [propertyAddress, setPropertyAddress] = useState<string>("");
  const [savingMeta, setSavingMeta] = useState(false);
  const [depositPath, setDepositPath] = useState("");
  const [notes, setNotes] = useState("");
  const [reissueCategory, setReissueCategory] = useState("other");
  const [frontViewerOpen, setFrontViewerOpen] = useState(false);

  useEffect(() => {
    if (check && !formDirtyRef.current) {
      setCarrierName(check.carrier_name ?? "");
      setCheckNumber(check.check_number ?? "");
      setAmount(check.amount?.toString() ?? "");
      setPayeeLine(check.payee_line ?? "");
      setFundsType(((check as any).funds_type as string) ?? "");
      setPropertyAddress(((check as any).property_address as string) ?? "");
    }
  }, [check]);

  const persistMeta = async (next: { funds_type?: string | null; property_address?: string | null }) => {
    setSavingMeta(true);
    try {
      const { error } = await supabase
        .from("check_intake_items")
        .update({ ...next, updated_at: new Date().toISOString() })
        .eq("id", checkId);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["review-check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setSavingMeta(false);
    }
  };

  useEffect(() => {
    formDirtyRef.current = false;
    setEditing(false);
    setDepositPath("");
    setNotes("");
    setReissueCategory("other");
  }, [checkId]);

  const markDirty = useCallback(() => { formDirtyRef.current = true; }, []);

  const saveFieldEdits = useMutation({
    mutationFn: async () => {
      if (!check) throw new Error("Check not loaded");
      const parsedAmount = amount.trim() ? Number(amount) : null;
      if (amount.trim() && !Number.isFinite(parsedAmount)) throw new Error("Enter a valid amount");

      const fieldChanges: { field: string; old_value: string | null; new_value: string | null }[] = [];
      const updates: Record<string, string | number | null> = {};

      if (carrierName !== (check.carrier_name ?? "")) {
        updates.carrier_name = carrierName || null;
        fieldChanges.push({ field: "carrier_name", old_value: check.carrier_name, new_value: carrierName || null });
      }
      if (checkNumber !== (check.check_number ?? "")) {
        updates.check_number = checkNumber || null;
        fieldChanges.push({ field: "check_number", old_value: check.check_number, new_value: checkNumber || null });
      }
      if (amount !== (check.amount?.toString() ?? "")) {
        updates.amount = parsedAmount;
        fieldChanges.push({ field: "amount", old_value: check.amount?.toString() ?? null, new_value: amount || null });
      }
      if (payeeLine !== (check.payee_line ?? "")) {
        updates.payee_line = payeeLine || null;
        fieldChanges.push({ field: "payee_line", old_value: check.payee_line, new_value: payeeLine || null });
      }

      if (Object.keys(updates).length === 0) throw new Error("No field changes to save");

      const { error } = await supabase
        .from("check_intake_items")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("id", checkId);
      if (error) throw error;

      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "review_fields_saved",
        event_description: "Review fields updated without moving workflow status",
        event_data: { field_changes: fieldChanges },
        actor_id: user?.id ?? null,
      });
    },
    onSuccess: () => {
      formDirtyRef.current = false;
      setEditing(false);
      toast({ title: "Field changes saved" });
      qc.invalidateQueries({ queryKey: ["review-check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-review-queue"] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
    },
    onError: (err) => {
      toast({ title: "Failed to save fields", description: err.message, variant: "destructive" });
    },
  });

  const submitDecision = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("Not authenticated");
      if (!depositPath) throw new Error("Select a deposit path");
      if (!check) throw new Error("Check not loaded");

      const fieldChanges: { field: string; old_value: string | null; new_value: string | null }[] = [];

      if (editing) {
        if (carrierName !== (check.carrier_name ?? ""))
          fieldChanges.push({ field: "carrier_name", old_value: check.carrier_name, new_value: carrierName || null });
        if (checkNumber !== (check.check_number ?? ""))
          fieldChanges.push({ field: "check_number", old_value: check.check_number, new_value: checkNumber || null });
        if (amount !== (check.amount?.toString() ?? ""))
          fieldChanges.push({ field: "amount", old_value: check.amount?.toString() ?? null, new_value: amount || null });
        if (payeeLine !== (check.payee_line ?? ""))
          fieldChanges.push({ field: "payee_line", old_value: check.payee_line, new_value: payeeLine || null });
      }

      const { data, error } = await supabase.rpc("submit_check_review_decision", {
        p_check_id: checkId,
        p_reviewer_id: user.id,
        p_deposit_path: depositPath,
        p_reviewer_notes: notes || null,
        p_confirmed_carrier_name: editing ? (carrierName || null) : null,
        p_confirmed_check_number: editing ? (checkNumber || null) : null,
        p_confirmed_amount: editing && amount ? parseFloat(amount) : null,
        p_confirmed_payee_line: editing ? (payeeLine || null) : null,
        p_field_changes: fieldChanges,
        p_reissue_reason: depositPath === "reissue_requested" ? (notes || "Check not practically depositable") : null,
        p_reissue_reason_category: depositPath === "reissue_requested" ? reissueCategory : "other",
      });

      if (error) throw error;
      const result = data as { new_stage?: string } | null;
      // Guard: RPC must return a stage — if not, something went silently wrong
      if (!result?.new_stage) {
        throw new Error(
          "Routing failed: the server did not confirm a new stage. The check has NOT moved. Please try again or contact support.",
        );
      }
      return result;
    },
    onSuccess: (data) => {
      formDirtyRef.current = false;
      const stageLabel: Record<string, string> = {
        loss_draft: "Loss Draft",
        endorsing: "Endorsing",
        ready_for_deposit: "Ready for Deposit",
        review: "Review",
      };
      toast({
        title: "Check routed successfully",
        description: `Moved to: ${stageLabel[data?.new_stage] ?? data?.new_stage}`,
      });
      qc.invalidateQueries({ queryKey: ["check-review-queue"] });
      qc.invalidateQueries({ queryKey: ["review-check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["check-dashboard-counts"] });
      onComplete();
    },
    onError: (err) => {
      toast({ title: "Failed to save decision", description: err.message, variant: "destructive" });
    },
  });

  const { data: frontImageUrl } = useQuery({
    queryKey: ["review-check-front-img", check?.front_image_path],
    enabled: !!check?.front_image_path,
    queryFn: async () => {
      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(check!.front_image_path!, 3600);
      return data?.signedUrl ?? null;
    },
  });

  if (!check) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />Loading...
      </div>
    );
  }

  return (
    <>
    <ScrollArea className="max-h-none lg:h-[calc(100vh-400px)]">
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Review Check #{check.check_number || "—"}</h3>
          <div className="flex items-center gap-2">
            {frontImageUrl && (
              <Button size="sm" variant="outline" onClick={() => setFrontViewerOpen(true)}>
                <FileImage className="h-3 w-3 mr-1" /> Front
              </Button>
            )}
            <Button
              size="sm"
              variant={editing ? "default" : "outline"}
              onClick={() => {
                if (!editing) {
                  setCarrierName(check.carrier_name ?? "");
                  setCheckNumber(check.check_number ?? "");
                  setAmount(check.amount?.toString() ?? "");
                  setPayeeLine(check.payee_line ?? "");
                  markDirty();
                }
                setEditing(!editing);
              }}
            >
              <Edit3 className="h-3 w-3 mr-1" />
              {editing ? "Cancel Edit" : "Edit Fields"}
            </Button>
          </div>
        </div>

        {check.deposit_recommendation_reasons && check.deposit_recommendation_reasons.length > 0 && (
          <Card className="border-orange-500/20 bg-orange-500/5">
            <CardContent className="p-3">
              <p className="text-xs font-medium text-orange-400 mb-1">Why this needs review:</p>
              {(check.deposit_recommendation_reasons as string[]).map((r, i) => (
                <p key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <AlertTriangle className="h-3 w-3 mt-0.5 text-orange-400 shrink-0" />
                  {r}
                </p>
              ))}
            </CardContent>
          </Card>
        )}

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
            <Card className={`border ${tone}`}>
              <CardContent className="p-3 space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  Check validity: {v.label}
                </div>
                <p className="text-[11px] opacity-80 pl-5">{v.detail}</p>
              </CardContent>
            </Card>
          );
        })()}

        <div className="space-y-3">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Check Details</h4>
          {editing ? (
            <>
              <div>
                <Label className="text-xs">Carrier Name</Label>
                <Input value={carrierName} onChange={(e) => { setCarrierName(e.target.value); markDirty(); }} className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Check Number</Label>
                <Input value={checkNumber} onChange={(e) => { setCheckNumber(e.target.value); markDirty(); }} className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Amount</Label>
                <Input type="number" step="0.01" value={amount} onChange={(e) => { setAmount(e.target.value); markDirty(); }} className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Payee Line</Label>
                <Input value={payeeLine} onChange={(e) => { setPayeeLine(e.target.value); markDirty(); }} className="h-8 text-sm" />
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => saveFieldEdits.mutate()}
                disabled={saveFieldEdits.isPending}
                className="w-full"
              >
                {saveFieldEdits.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save Field Changes
              </Button>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Carrier</p>
                <p className="font-medium">{check.carrier_name || "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Check #</p>
                <p className="font-mono font-medium">{check.check_number || "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Amount</p>
                <p className="font-bold tabular-nums">
                  {check.amount != null ? `$${check.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Payee Line</p>
                <p className="text-xs break-words">{check.payee_line || "—"}</p>
              </div>
            </div>
          )}
        </div>

        {/* Funds type + property address — visible to all partners with shared access */}
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Check Classification</h4>
          <div>
            <Label className="text-xs">Funds Type</Label>
            <Select
              value={fundsType || "__unset__"}
              onValueChange={(v) => {
                const next = v === "__unset__" ? "" : v;
                setFundsType(next);
                markDirty();
                persistMeta({ funds_type: next || null });
              }}
              disabled={savingMeta}
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Select funds type…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unset__" className="text-xs text-muted-foreground">Not set</SelectItem>
                <SelectItem value="acv" className="text-xs">ACV (Actual Cash Value)</SelectItem>
                <SelectItem value="rcv" className="text-xs">RCV (Replacement Cost Value)</SelectItem>
                <SelectItem value="recoverable_depreciation" className="text-xs">Recoverable Depreciation</SelectItem>
                <SelectItem value="supplement" className="text-xs">Supplement</SelectItem>
                <SelectItem value="overhead_and_profit" className="text-xs">Overhead &amp; Profit (O&amp;P)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Property Address</Label>
            <Input
              value={propertyAddress}
              onChange={(e) => { setPropertyAddress(e.target.value); markDirty(); }}
              onBlur={() => persistMeta({ property_address: propertyAddress.trim() || null })}
              placeholder="Address this check is for…"
              className="h-8 text-sm"
              disabled={savingMeta}
            />
          </div>
        </div>

        <Separator />

        <PayeeReconciliation checkId={checkId} payees={check.check_payees ?? []} />

        <Separator />

        {/* ── Routing Decision ─────────────────────────────────────── */}
        {(() => {
          const hasMortgage = (check.check_payees ?? []).some(
            (p) => p.payee_type === "mortgage_company",
          );
          const missingFields = getMissingFields(check);
          const allEndorsed =
            (check.check_payees ?? []).length > 0 &&
            (check.check_payees ?? []).every(
              (p) =>
                p.endorsement_status === "signed" ||
                p.endorsement_status === "waived" ||
                (p.payee_type === "mortgage_company" &&
                  p.endorsement_status === "manual_required"),
            );

          return (
            <div className="space-y-3">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Routing Decision
              </h4>

              {/* ── Missing fields warning ── */}
              {missingFields.length > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-1">
                  <p className="text-xs font-semibold text-amber-400 flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Complete these fields before routing:
                  </p>
                  <ul className="text-xs text-amber-300 list-disc list-inside">
                    {missingFields.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* ── Mortgage detected — force loss draft ── */}
              {hasMortgage ? (
                <div className="space-y-2">
                  <div className="rounded-md border border-purple-500/40 bg-purple-500/10 p-2.5">
                    <p className="text-xs font-semibold text-purple-300 flex items-center gap-1">
                      <Building2 className="h-3.5 w-3.5" />
                      Mortgage payee detected — this check must go to Loss Draft
                    </p>
                  </div>
                  <Card
                    className={`cursor-pointer transition-all p-2.5 text-center hover:bg-accent/30 ${
                      depositPath === "loss_draft_required"
                        ? "ring-1 ring-purple-500 bg-purple-500/10"
                        : ""
                    }`}
                    onClick={() => {
                      setDepositPath("loss_draft_required");
                      markDirty();
                    }}
                  >
                    <Building2 className="h-5 w-5 mx-auto mb-1 text-purple-400" />
                    <p className="text-[11px] font-medium leading-tight">
                      Send to Loss Draft
                    </p>
                  </Card>
                </div>
              ) : (
                /* ── No mortgage — show endorsing + other options ── */
                <div className="grid grid-cols-2 gap-2">
                  {DEPOSIT_PATHS.filter(
                    (p) => p.value !== "loss_draft_required",
                  ).map((path) => {
                    const PathIcon = path.icon;
                    /* Approved-for-deposit requires all endorsements complete */
                    const isApprove = path.value === "approved_for_deposit";
                    const blocked = isApprove && !allEndorsed;
                    return (
                      <Card
                        key={path.value}
                        className={`transition-all p-2.5 text-center ${
                          blocked
                            ? "opacity-40 cursor-not-allowed"
                            : "cursor-pointer hover:bg-accent/30"
                        } ${
                          depositPath === path.value
                            ? "ring-1 ring-primary bg-accent/50"
                            : ""
                        }`}
                        onClick={() => {
                          if (blocked) {
                            toast({
                              title: "Endorsements required",
                              description:
                                "All payees must sign or waive before this check can be approved for deposit.",
                              variant: "destructive",
                            });
                            return;
                          }
                          setDepositPath(path.value);
                          markDirty();
                        }}
                      >
                        <PathIcon
                          className={`h-5 w-5 mx-auto mb-1 ${path.color}`}
                        />
                        <p className="text-[11px] font-medium leading-tight">
                          {path.label}
                        </p>
                        {blocked && (
                          <p className="text-[9px] text-muted-foreground mt-0.5">
                            Needs signatures
                          </p>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}

              {depositPath === "reissue_requested" && (
                <div>
                  <Label className="text-xs">Reissue Reason Category</Label>
                  <Select
                    value={reissueCategory}
                    onValueChange={(v) => {
                      setReissueCategory(v);
                      markDirty();
                    }}
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REISSUE_REASON_CATEGORIES.map((c) => (
                        <SelectItem key={c.value} value={c.value} className="text-xs">
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div>
                <Label className="text-xs">Reviewer Notes</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    markDirty();
                  }}
                  placeholder="Optional notes about this decision..."
                  className="text-sm min-h-[60px]"
                />
              </div>

              <Button
                onClick={() => {
                  /* Hard block: required fields missing */
                  if (missingFields.length > 0) {
                    toast({
                      title: "Complete all required fields first",
                      description: `Missing: ${missingFields.join(", ")}`,
                      variant: "destructive",
                    });
                    return;
                  }
                  /* Hard block: no routing chosen */
                  if (!depositPath) {
                    toast({
                      title: "Select a routing decision",
                      variant: "destructive",
                    });
                    return;
                  }
                  /* Stale-date soft warning */
                  const v = assessCheckValidity(check.issue_date);
                  if (
                    isAtRisk(v.risk) &&
                    depositPath !== "reissue_requested" &&
                    depositPath !== "hold_for_claim_review"
                  ) {
                    const proceed = window.confirm(
                      `⚠️ Check validity warning\n\n${v.label}\n${v.detail}\n\nThis check may be rejected at deposit. Consider 'Request Reissue' instead.\n\nProceed anyway?`,
                    );
                    if (!proceed) return;
                  }
                  submitDecision.mutate();
                }}
                disabled={!depositPath || submitDecision.isPending}
                className="w-full"
              >
                {submitDecision.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Submit Review Decision
              </Button>
            </div>
          );
        })()}
      </div>
    </ScrollArea>
    <DepositImageViewer
      open={frontViewerOpen}
      imageUrl={frontImageUrl ?? null}
      title={`Front of Check #${check.check_number || checkId.slice(0, 8)}`}
      onClose={() => setFrontViewerOpen(false)}
    />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Payee Reconciliation with merge support                            */
/* ------------------------------------------------------------------ */

function PayeeReconciliation({
  checkId,
  payees,
}: {
  checkId: string;
  payees: CheckPayee[];
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [editingPayee, setEditingPayee] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState("");
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSelection, setMergeSelection] = useState<string[]>([]);
  const [mergedName, setMergedName] = useState("");
  const [addingPayee, setAddingPayee] = useState(false);
  const [newPayeeName, setNewPayeeName] = useState("");
  const [newPayeeType, setNewPayeeType] = useState("insured");

  const updatePayee = useMutation({
    mutationFn: async ({ payeeId, name, type }: { payeeId: string; name: string; type: string }) => {
      const original = payees.find((p) => p.id === payeeId);
      if (!original) throw new Error("Payee not found");

      const { error } = await supabase
        .from("check_payees")
        .update({ payee_name: name, payee_type: type })
        .eq("id", payeeId);
      if (error) throw error;

      const changes: string[] = [];
      if (name !== original.payee_name) changes.push(`name: "${original.payee_name}" → "${name}"`);
      if (type !== original.payee_type) changes.push(`type: "${original.payee_type}" → "${type}"`);

      if (changes.length > 0) {
        await supabase.from("check_audit_log").insert({
          check_id: checkId,
          event_type: "payee_corrected",
          event_description: `Payee corrected: ${changes.join(", ")}`,
          event_data: {
            payee_id: payeeId,
            old_name: original.payee_name,
            new_name: name,
            old_type: original.payee_type,
            new_type: type,
            token_preserved: true,
          },
          actor_id: user?.id ?? null,
        });
      }
    },
    onSuccess: () => {
      toast({ title: "Payee updated" });
      setEditingPayee(null);
      qc.invalidateQueries({ queryKey: ["review-check-detail", checkId] });
    },
    onError: (err) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const deletePayee = useMutation({
    mutationFn: async (payeeId: string) => {
      const original = payees.find((p) => p.id === payeeId);
      if (!original) throw new Error("Payee not found");
      if (original.endorsement_status !== "pending") {
        throw new Error("Cannot delete a payee with active endorsement activity");
      }

      await supabase.from("check_endorsement_events").delete().eq("payee_id", payeeId);
      await supabase.from("check_endorsements").delete().eq("payee_id", payeeId);

      const { error } = await supabase.from("check_payees").delete().eq("id", payeeId);
      if (error) throw error;

      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "payee_deleted",
        event_description: `Payee removed: "${original.payee_name}" (${original.payee_type})`,
        event_data: { payee_id: payeeId, payee_name: original.payee_name, payee_type: original.payee_type },
        actor_id: user?.id ?? null,
      });
    },
    onSuccess: () => {
      toast({ title: "Payee removed" });
      qc.invalidateQueries({ queryKey: ["review-check-detail", checkId] });
    },
    onError: (err) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const addPayee = useMutation({
    mutationFn: async ({ name, type }: { name: string; type: string }) => {
      if (!name.trim()) throw new Error("Name is required");
      const { error } = await supabase.from("check_payees").insert({
        check_id: checkId,
        payee_name: name.trim(),
        payee_type: type,
        endorsement_status: "pending",
        endorsement_token: crypto.randomUUID(),
        endorsement_token_expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      });
      if (error) throw error;

      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "payee_added",
        event_description: `Payee added: "${name.trim()}" (${type})`,
        event_data: { payee_name: name.trim(), payee_type: type },
        actor_id: user?.id ?? null,
      });
    },
    onSuccess: () => {
      toast({ title: "Payee added" });
      setAddingPayee(false);
      setNewPayeeName("");
      setNewPayeeType("insured");
      qc.invalidateQueries({ queryKey: ["review-check-detail", checkId] });
    },
    onError: (err) => {
      toast({ title: "Add failed", description: err.message, variant: "destructive" });
    },
  });

  const mergePayees = useMutation({
    mutationFn: async () => {
      if (mergeSelection.length < 2) throw new Error("Select at least 2 payees to merge");
      if (!user?.id) throw new Error("Not authenticated");

      const sorted = [...mergeSelection].sort((a, b) => {
        const pa = payees.find((p) => p.id === a);
        const pb = payees.find((p) => p.id === b);
        const aActive = pa && pa.endorsement_status !== "pending" ? 0 : 1;
        const bActive = pb && pb.endorsement_status !== "pending" ? 0 : 1;
        return aActive - bActive;
      });

      const targetId = sorted[0];
      const sourceIds = sorted.slice(1);

      const mergeable = sourceIds.filter((id) => {
        const p = payees.find((py) => py.id === id);
        return p?.endorsement_status === "pending";
      });

      if (mergeable.length === 0) {
        throw new Error("Cannot merge: all selected payees have active endorsement activity");
      }

      const mergeOps = mergeable.map((sourceId) => ({
        source_payee_id: sourceId,
        target_payee_id: targetId,
        merged_name: mergedName || null,
      }));

      const { error } = await supabase.rpc("submit_check_review_decision", {
        p_check_id: checkId,
        p_reviewer_id: user.id,
        p_deposit_path: "merge_only",
        p_reviewer_notes: `Merged ${mergeable.length} duplicate payee(s)`,
        p_merge_payees: mergeOps,
        p_field_changes: [],
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Payees merged" });
      setMergeMode(false);
      setMergeSelection([]);
      setMergedName("");
      qc.invalidateQueries({ queryKey: ["review-check-detail", checkId] });
    },
    onError: (err) => {
      toast({ title: "Merge failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleMergeSelection = (id: string) => {
    setMergeSelection((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Payee Reconciliation
        </h4>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px]"
            onClick={() => setAddingPayee(!addingPayee)}
          >
            <Plus className="h-3 w-3 mr-1" />Add
          </Button>
          {payees.length >= 2 && (
            <Button
              size="sm"
              variant={mergeMode ? "default" : "ghost"}
              className="h-6 text-[10px]"
              onClick={() => { setMergeMode(!mergeMode); setMergeSelection([]); setMergedName(""); }}
            >
              <Merge className="h-3 w-3 mr-1" />
              {mergeMode ? "Cancel" : "Merge"}
            </Button>
          )}
        </div>
      </div>

      {addingPayee && (
        <Card className="p-2.5 border-primary/30 bg-primary/5 space-y-2">
          <Input
            value={newPayeeName}
            onChange={(e) => setNewPayeeName(e.target.value)}
            placeholder="Payee name"
            className="h-7 text-xs"
          />
          <Select value={newPayeeType} onValueChange={setNewPayeeType}>
            <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAYEE_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="text-xs">{t.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-1">
            <Button
              size="sm"
              className="flex-1 h-6 text-[10px]"
              disabled={addPayee.isPending || !newPayeeName.trim()}
              onClick={() => addPayee.mutate({ name: newPayeeName, type: newPayeeType })}
            >
              <Plus className="h-3 w-3 mr-1" />Add Payee
            </Button>
            <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => { setAddingPayee(false); setNewPayeeName(""); }}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {mergeMode && mergeSelection.length >= 2 && (
        <Card className="p-2.5 border-primary/30 bg-primary/5 space-y-2">
          <p className="text-[10px] text-muted-foreground">
            {mergeSelection.length} payees selected. Payees with active endorsements will be kept as the target.
          </p>
          <Input
            value={mergedName}
            onChange={(e) => setMergedName(e.target.value)}
            placeholder="Merged payee name (optional)"
            className="h-7 text-xs"
          />
          <Button
            size="sm"
            className="w-full h-6 text-[10px]"
            disabled={mergePayees.isPending}
            onClick={() => mergePayees.mutate()}
          >
            <Merge className="h-3 w-3 mr-1" />Merge Selected
          </Button>
        </Card>
      )}

      {payees.length === 0 ? (
        <p className="text-xs text-muted-foreground">No payees detected</p>
      ) : (
        payees.map((payee) => {
          const PayeeIcon = payeeTypeIcons[payee.payee_type] ?? AlertTriangle;
          const isEditing = editingPayee === payee.id;
          const hasActivity = payee.endorsement_status !== "pending";

          return (
            <Card key={payee.id} className="p-2.5">
              {isEditing ? (
                <div className="space-y-2">
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-7 text-xs"
                    placeholder="Payee name"
                  />
                  <Select value={editType} onValueChange={setEditType}>
                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PAYEE_TYPES.map((t) => (
                        <SelectItem key={t} value={t} className="text-xs">{t.replace(/_/g, " ")}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {hasActivity && (
                    <p className="text-[10px] text-amber-400 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      Endorsement token preserved — only name/type updated
                    </p>
                  )}
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      className="flex-1 h-6 text-[10px]"
                      disabled={updatePayee.isPending}
                      onClick={() => updatePayee.mutate({ payeeId: payee.id, name: editName, type: editType })}
                    >
                      <Save className="h-3 w-3 mr-1" />Save
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => setEditingPayee(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
                    {mergeMode && (
                      <Checkbox
                        checked={mergeSelection.includes(payee.id)}
                        onCheckedChange={() => toggleMergeSelection(payee.id)}
                        className="shrink-0"
                      />
                    )}
                    <PayeeIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{payee.payee_name}</p>
                      <p className="text-[10px] text-muted-foreground capitalize">
                        {payee.payee_type.replace(/_/g, " ")}
                        {hasActivity && (
                          <span className="ml-1.5">
                            · <span className={
                              payee.endorsement_status === "signed" ? "text-emerald-400" :
                              payee.endorsement_status === "rejected" ? "text-red-400" :
                              "text-amber-400"
                            }>{payee.endorsement_status}</span>
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  {!mergeMode && (
                    <div className="flex gap-0.5 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0"
                        onClick={() => {
                          setEditingPayee(payee.id);
                          setEditName(payee.payee_name);
                          setEditType(payee.payee_type);
                        }}
                      >
                        <Edit3 className="h-3 w-3" />
                      </Button>
                      {!hasActivity && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                          onClick={() => {
                            if (confirm(`Remove payee "${payee.payee_name}"?`)) {
                              deletePayee.mutate(payee.id);
                            }
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
