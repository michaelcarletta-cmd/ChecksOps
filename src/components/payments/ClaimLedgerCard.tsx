import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { FileText, Link2, CheckCircle2, AlertCircle, Pencil, DollarSign } from "lucide-react";
import { format } from "date-fns";
import { ClaimSettlementEditor } from "./ClaimSettlementEditor";
import { getDepositLabel } from "@/lib/depositLabel";
import { fundsReceivedFromScopedIntakeRows } from "@/lib/claimLedgerSync";
import {
  CLAIM_LEDGER_NOT_LINKED,
  CLAIM_NUMBER_SAVE_SELECT,
  claimLinkUserMessage,
  planClaimNumberSave,
  resolveAuthoritativeClaimId,
} from "@/lib/checkClaimLinkGuard";

interface Props {
  checkIntakeItemId: string;
  claimId: string | null;
  detectedClaimNumber: string | null;
  readOnly?: boolean;
  onLinked?: (claimId: string) => void;
}

const fmt = (n: number) =>
  `$${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ClaimLedgerCard({ checkIntakeItemId, claimId, detectedClaimNumber, readOnly = false, onLinked }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(!claimId && !readOnly);
  const [input, setInput] = useState(detectedClaimNumber ?? "");
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  // Read-only mode (partner viewing a shared check): fetch via SECURITY
  // DEFINER RPC that validates access through shared_checks, so partner
  // tenants don't need direct RLS access to claims/claim_settlements.
  const { data: rpcData } = useQuery({
    queryKey: ["claim-ledger-rpc", checkIntakeItemId],
    enabled: readOnly,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("get_check_claim_settlement", {
        p_check_id: checkIntakeItemId,
      });
      if (error) throw error;
      return data as any;
    },
  });

  const { data: liveCheckLink, isFetched: liveLinkFetched } = useQuery({
    queryKey: ["claim-ledger-check-link", checkIntakeItemId],
    enabled: !!checkIntakeItemId && !readOnly,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, claim_id")
        .eq("id", checkIntakeItemId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const linkedClaimId = resolveAuthoritativeClaimId({
    liveCheckClaimId: liveCheckLink?.claim_id ?? null,
    loadedClaimId: null,
    claimIdProp: claimId,
  });

  const { data: ownerClaim } = useQuery({
    queryKey: ["claim-ledger", linkedClaimId],
    enabled: !!linkedClaimId && !readOnly,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claims")
        .select("id, claim_number, policyholder_name, policyholder_address")
        .eq("id", linkedClaimId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: ownerSettlement } = useQuery({
    queryKey: ["claim-ledger-settlement", linkedClaimId],
    enabled: !!linkedClaimId && !readOnly,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_settlements")
        .select("*")
        .eq("claim_id", linkedClaimId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: ownerSiblingChecks = [] } = useQuery({
    queryKey: ["claim-ledger-checks", linkedClaimId],
    enabled: !!linkedClaimId && !readOnly,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, check_number, amount, carrier_name, issue_date, status, check_stage, created_at")
        .eq("claim_id", linkedClaimId!)
        .order("issue_date", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const claim: any = readOnly ? rpcData?.claim : ownerClaim;
  const settlement: any = readOnly ? rpcData?.settlement : ownerSettlement;
  const siblingChecks: any[] = readOnly ? (rpcData?.sibling_checks ?? []) : ownerSiblingChecks;
  const effectiveClaimId = readOnly ? (rpcData?.claim?.id ?? null) : linkedClaimId;

  const resolveExistingClaimId = () => resolveAuthoritativeClaimId({
    liveCheckClaimId: liveCheckLink?.claim_id ?? null,
    loadedClaimId: claim?.id ?? null,
    claimIdProp: claimId,
  });

  const linkMutation = useMutation({
    mutationFn: async (vars: { claimNumber: string; existingClaimId?: string | null }) => {
      const plan = planClaimNumberSave({
        existingClaimId: vars.existingClaimId ?? null,
        claimNumber: vars.claimNumber,
      });

      if (plan.mode === "update_existing") {
        const { data: existing, error: existingErr } = await supabase
          .from("claims")
          .select(CLAIM_NUMBER_SAVE_SELECT)
          .eq("id", plan.claimId)
          .single();
        if (existingErr) throw existingErr;
        if (!existing?.id) throw new Error(claimLinkUserMessage("missing_claim"));

        const { data: updated, error: updateErr } = await supabase
          .from("claims")
          .update({ claim_number: plan.claimNumber })
          .eq("id", plan.claimId)
          .select(CLAIM_NUMBER_SAVE_SELECT)
          .single();
        if (updateErr) throw updateErr;
        if (!updated?.id || String(updated.id) !== String(plan.claimId)) {
          throw new Error("Claim number save did not keep the existing claim.");
        }

        return {
          created: false,
          updatedExisting: true,
          claimNumber: updated.claim_number,
          claimId: updated.id,
          previousClaimId: plan.claimId,
          policyholderName: updated.policyholder_name,
        };
      }

      throw new Error(CLAIM_LEDGER_NOT_LINKED);
    },
    onSuccess: (res) => {
      if (onLinked) onLinked(res.claimId);
      qc.invalidateQueries({ queryKey: ["intake-check"] });
      qc.invalidateQueries({ queryKey: ["check-detail"] });
      qc.invalidateQueries({ queryKey: ["check-detail", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["claim-ledger"] });
      qc.invalidateQueries({ queryKey: ["claim-ledger-settlement"] });
      qc.invalidateQueries({ queryKey: ["claim-ledger-checks"] });
      qc.invalidateQueries({ queryKey: ["claim-ledger-check-link"] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["review-settlement-check"] });
      // Invalidate loss draft queries to ensure the UI updates with the new claim link
      qc.invalidateQueries({ queryKey: ["loss-draft"] });
      qc.invalidateQueries({ queryKey: ["loss-drafts"] });
      
      setEditing(false);
      
      // If a matching claim was found or a new one created, we have a claimId now.
      // We must ensure the UI shows the ledger and the editor can be opened.
      qc.invalidateQueries({ queryKey: ["claim-ledger", res.claimId] });
      qc.invalidateQueries({ queryKey: ["claim-ledger-settlement", res.claimId] });
      qc.invalidateQueries({ queryKey: ["claim-ledger-checks", res.claimId] });
      if (res.previousClaimId && res.previousClaimId !== res.claimId) {
        qc.invalidateQueries({ queryKey: ["claim-ledger-checks", res.previousClaimId] });
      }
      
      // Auto-open editor to allow entering amounts immediately
      setTimeout(() => {
        setEditorOpen(true);
      }, 100);

      toast({
        title: res.updatedExisting
          ? "Claim number updated"
          : res.created
            ? "Claim tracker created"
            : "Linked to claim",
        description: res.updatedExisting
          ? `${res.claimNumber}${res.policyholderName ? ` — ${res.policyholderName}` : ""}`
          : res.created
            ? `Now tracking funds for ${res.claimNumber}. Enter the settlement amounts to monitor releases.`
            : `${res.claimNumber}${res.policyholderName ? ` — ${res.policyholderName}` : ""}`,
      });
    },
    onError: (e: any) => {
      toast({ title: "Could not save claim", description: e.message, variant: "destructive" });
    },
    onSettled: () => setSaving(false),
  });

  const handleLinkedSave = () => {
    const existingClaimId = resolveExistingClaimId();
    if (!existingClaimId) {
      toast({
        title: "Could not save claim",
        description: CLAIM_LEDGER_NOT_LINKED,
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    linkMutation.mutate({ claimNumber: input, existingClaimId });
  };

  // Read-only & no claim resolved → render a small placeholder so the
  // partner still sees the section but doesn't get a link/edit form.
  if (readOnly && !effectiveClaimId) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Claim Ledger
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            The public adjuster hasn't entered settlement amounts for this claim yet. Once they do,
            you'll see the RCV, depreciation, deductible and remaining balance here.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ─── Unlinked state ─────────────────────────────────────────────
  if (!readOnly && !linkedClaimId) {
    if (!liveLinkFetched) {
      return (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Link2 className="h-4 w-4 text-amber-600" />
              Claim Ledger
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">Loading claim link…</p>
          </CardContent>
        </Card>
      );
    }
    return (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Link2 className="h-4 w-4 text-amber-600" />
            This check is not linked to a claim
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Claim Ledger Save only updates an existing linked claim. It cannot create
            or attach a claim. {detectedClaimNumber
              ? "The detected number below is OCR text, not a claim link."
              : "No claim_id is set on this check."}
          </p>
          {detectedClaimNumber ? (
            <p className="text-sm font-medium">Detected (unlinked): {detectedClaimNumber}</p>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  // ─── Linked state ──────────────────────────────────────────────
  const s: any = settlement || {};
  const dwellingAcv = Math.max(0,
    Number(s.replacement_cost_value || 0)
    - Number(s.recoverable_depreciation || 0)
    - Number(s.non_recoverable_depreciation || 0)
    - Number(s.deductible || 0));
  const otherStructuresAcv = Math.max(0,
    Number(s.other_structures_rcv || 0)
    - Number(s.other_structures_recoverable_depreciation || 0)
    - Number(s.other_structures_non_recoverable_depreciation || 0)
    - Number(s.other_structures_deductible || 0));
  const ppAcv = Math.max(0,
    Number(s.personal_property_rcv || 0)
    - Number(s.personal_property_recoverable_depreciation || 0)
    - Number(s.personal_property_non_recoverable_depreciation || 0));
  const ordLawNet = Math.max(0,
    Number(s.pwi_rcv || 0)
    - Number(s.pwi_recoverable_depreciation || 0)
    - Number(s.pwi_non_recoverable_depreciation || 0));
  const aleAcv = Math.max(0,
    Number(s.ale_rcv || 0)
    - Number(s.ale_recoverable_depreciation || 0)
    - Number(s.ale_non_recoverable_depreciation || 0));
  const totalRecDep =
    Number(s.recoverable_depreciation || 0)
    + Number(s.other_structures_recoverable_depreciation || 0)
    + Number(s.pwi_recoverable_depreciation || 0)
    + Number(s.personal_property_recoverable_depreciation || 0)
    + Number(s.ale_recoverable_depreciation || 0);
  const totalRcv =
    Number(s.replacement_cost_value || 0)
    + Number(s.other_structures_rcv || 0)
    + Number(s.pwi_rcv || 0)
    + Number(s.personal_property_rcv || 0)
    + Number(s.ale_rcv || 0);
  const totalDeductible =
    Number(s.deductible || 0)
    + Number(s.other_structures_deductible || 0);
  // Expected funds = full RCV across every category (+ any known supplement).
  // Deductible and non-recoverable/withheld amounts (e.g. Ordinance & Law paid
  // when incurred) are shown in the breakdown but must NOT reduce the target —
  // otherwise a claim can look "fully funded" while money is still outstanding.
  const totalExpected = totalRcv + Number(s.supplement_expected || 0);


  const totalReceived = fundsReceivedFromScopedIntakeRows(siblingChecks);
  const remaining = Math.max(0, totalExpected - totalReceived);
  const pct = totalExpected > 0 ? Math.min(100, (totalReceived / totalExpected) * 100) : 0;

  type CatRow = {
    label: string;
    rcv: number;
    recDep: number;
    nonRecDep: number;
    deductible: number;
    acv: number;
  };
  const categories: CatRow[] = [
    {
      label: "Dwelling",
      rcv: Number(s.replacement_cost_value || 0),
      recDep: Number(s.recoverable_depreciation || 0),
      nonRecDep: Number(s.non_recoverable_depreciation || 0),
      deductible: Number(s.deductible || 0),
      acv: dwellingAcv,
    },
    {
      label: "Other Structures",
      rcv: Number(s.other_structures_rcv || 0),
      recDep: Number(s.other_structures_recoverable_depreciation || 0),
      nonRecDep: Number(s.other_structures_non_recoverable_depreciation || 0),
      deductible: Number(s.other_structures_deductible || 0),
      acv: otherStructuresAcv,
    },
    {
      label: "Ordinance & Law",
      rcv: Number(s.pwi_rcv || 0),
      recDep: Number(s.pwi_recoverable_depreciation || 0),
      nonRecDep: Number(s.pwi_non_recoverable_depreciation || 0),
      deductible: 0,
      acv: ordLawNet,
    },
    {
      label: "Personal Property",
      rcv: Number(s.personal_property_rcv || 0),
      recDep: Number(s.personal_property_recoverable_depreciation || 0),
      nonRecDep: Number(s.personal_property_non_recoverable_depreciation || 0),
      deductible: 0,
      acv: ppAcv,
    },
    {
      label: "Additional Living Exp.",
      rcv: Number(s.ale_rcv || 0),
      recDep: Number(s.ale_recoverable_depreciation || 0),
      nonRecDep: Number(s.ale_non_recoverable_depreciation || 0),
      deductible: 0,
      acv: aleAcv,
    },
  ].filter((c) => c.rcv > 0 || c.recDep > 0 || c.nonRecDep > 0 || c.deductible > 0);
  const supplementExpected = Number(s.supplement_expected || 0);
  const hasBreakdown = categories.length > 0 || supplementExpected > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2 min-w-0">
            <FileText className="h-4 w-4 text-primary shrink-0" />
            <span className="truncate">
              Claim Ledger — #{claim?.claim_number ?? "…"}
            </span>
          </CardTitle>
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1 text-[10px]"
              onClick={() => { setInput(claim?.claim_number ?? ""); setEditing((v) => !v); }}
            >
              <Pencil className="h-3 w-3 mr-1" /> Change
            </Button>
          )}
        </div>
        {claim?.policyholder_name && (
          <p className="text-xs text-muted-foreground truncate">{claim.policyholder_name}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {!readOnly && editing && (
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Re-link to a different claim number"
              className="h-8 text-sm"
            />
            <Button size="sm" disabled={saving || !input.trim()} onClick={handleLinkedSave}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        )}

        {/* Totals */}
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md bg-muted/40 p-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Total RCV</p>
            <p className="text-sm font-bold">{fmt(totalRcv)}</p>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Received</p>
            <p className="text-sm font-bold text-primary">{fmt(totalReceived)}</p>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Outstanding</p>
            <p className={`text-sm font-bold ${remaining === 0 && totalExpected > 0 ? "text-emerald-600" : "text-amber-600"}`}>
              {fmt(remaining)}
            </p>
          </div>
        </div>

        {totalExpected > 0 && (
          <div className="space-y-1">
            <Progress value={pct} className="h-2" />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>{Math.round(pct)}% of expected funds released</span>
              <span>Expected: {fmt(totalExpected)}</span>
            </div>
          </div>
        )}

        {/* Settlement breakdown */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Settlement breakdown
            </p>
            {!readOnly && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditorOpen(true)}>
                <DollarSign className="h-3 w-3 mr-1" />
                {hasBreakdown ? "Edit amounts" : "Enter amounts"}
              </Button>
            )}
          </div>
          {hasBreakdown ? (
            <div className="space-y-2">
              {categories.map((c) => (
                <div key={c.label} className="rounded-md border border-border/50 overflow-hidden">
                  <div className="flex items-center justify-between bg-muted/40 px-2 py-1.5">
                    <span className="text-xs font-semibold">{c.label}</span>
                    <span className="text-xs font-bold tabular-nums text-primary">
                      ACV {fmt(c.acv)}
                    </span>
                  </div>
                  <div className="divide-y divide-border/50">
                    <Row label="Replacement Cost Value" amount={c.rcv} />
                    {c.recDep > 0 && <Row label="Recoverable Depreciation" amount={-c.recDep} />}
                    {c.nonRecDep > 0 && <Row label="Non-Recoverable Depreciation" amount={-c.nonRecDep} />}
                    {c.deductible > 0 && <Row label="Deductible" amount={-c.deductible} />}
                  </div>
                </div>
              ))}
              {supplementExpected > 0 && (
                <div className="flex justify-between rounded-md border border-border/50 px-2 py-1.5 text-xs">
                  <span className="text-muted-foreground">Supplements (expected)</span>
                  <span className="tabular-nums font-medium">{fmt(supplementExpected)}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
              {readOnly
                ? "The public adjuster hasn't entered settlement amounts yet."
                : <>No settlement amounts entered yet. Click <span className="font-medium">Enter amounts</span> to add RCV, recoverable depreciation, deductible, ordinance &amp; law, other structures, personal property and ALE.</>}
            </div>
          )}
        </div>

        {!readOnly && linkedClaimId && (
          <ClaimSettlementEditor
            open={editorOpen}
            onOpenChange={setEditorOpen}
            claimId={linkedClaimId}
            settlement={settlement}
          />
        )}


        {/* Sibling checks */}
        <div>
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
            All checks for this claim ({siblingChecks.length})
          </p>
          <div className="rounded-md border border-border/50 divide-y divide-border/50">
            {siblingChecks.map((c: any) => {
              const isCurrent = c.id === checkIntakeItemId;
              return (
                <div
                  key={c.id}
                  className={`flex items-center justify-between px-2 py-1.5 text-xs ${isCurrent ? "bg-primary/5" : ""}`}
                >
                  <div className="min-w-0 flex items-center gap-2">
                    {isCurrent ? (
                      <CheckCircle2 className="h-3 w-3 text-primary shrink-0" />
                    ) : (
                      <AlertCircle className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate">
                      {c.check_number ? `#${c.check_number}` : "(no #)"}
                      {c.carrier_name && <span className="text-muted-foreground"> · {c.carrier_name}</span>}
                      {c.issue_date && (
                        <span className="text-muted-foreground"> · {format(new Date(c.issue_date), "MMM d, yyyy")}</span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="text-[9px] capitalize">
                      {getDepositLabel(c as any)}
                    </Badge>
                    <span className="tabular-nums font-medium">{fmt(Number(c.amount || 0))}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between border-t pt-2 text-xs">
          <span className="font-medium">Running total released</span>
          <span className="font-bold text-primary tabular-nums">{fmt(totalReceived)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, amount }: { label: string; amount: number }) {
  const negative = amount < 0;
  return (
    <div className="flex justify-between px-2 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums font-medium ${negative ? "text-amber-600" : ""}`}>
        {negative ? "−" : ""}${Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </span>
    </div>
  );
}
