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

  const { data: ownerClaim } = useQuery({
    queryKey: ["claim-ledger", claimId],
    enabled: !!claimId && !readOnly,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claims")
        .select("id, claim_number, policyholder_name, policyholder_address")
        .eq("id", claimId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: ownerSettlement } = useQuery({
    queryKey: ["claim-ledger-settlement", claimId],
    enabled: !!claimId && !readOnly,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_settlements")
        .select("*")
        .eq("claim_id", claimId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: ownerSiblingChecks = [] } = useQuery({
    queryKey: ["claim-ledger-checks", claimId],
    enabled: !!claimId && !readOnly,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, check_number, amount, carrier_name, issue_date, status, check_stage, created_at")
        .eq("claim_id", claimId!)
        .order("issue_date", { ascending: false, nullsFirst: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const claim: any = readOnly ? rpcData?.claim : ownerClaim;
  const settlement: any = readOnly ? rpcData?.settlement : ownerSettlement;
  const siblingChecks: any[] = readOnly ? (rpcData?.sibling_checks ?? []) : ownerSiblingChecks;
  const effectiveClaimId = readOnly ? (rpcData?.claim?.id ?? null) : claimId;

  const linkMutation = useMutation({
    mutationFn: async (claimNumber: string) => {
      const trimmed = claimNumber.trim();
      if (!trimmed) throw new Error("Enter a claim number");

      // Look up existing claim by claim_number (case-insensitive)
      const { data: matches, error: lookupErr } = await supabase
        .from("claims")
        .select("id, claim_number, policyholder_name")
        .ilike("claim_number", trimmed)
        .limit(2);
      if (lookupErr) throw lookupErr;

      if (matches && matches.length > 1) {
        throw new Error(`Multiple claims match "${trimmed}". Please disambiguate.`);
      }

      let matched = matches?.[0];
      let created = false;

      // No CRM claim — create a lightweight tracking-only claim record so
      // figures (RCV, ACV, deductible, etc.) can still be entered and all
      // future checks for this claim number link to the same ledger.
      if (!matched) {
        const { data: newClaim, error: insertErr } = await supabase
          .from("claims")
          .insert({ claim_number: trimmed, status: "tracking" })
          .select("id, claim_number, policyholder_name")
          .single();
        if (insertErr) throw insertErr;
        matched = newClaim;
        created = true;
      }

      const { error } = await supabase
        .from("check_intake_items")
        .update({ detected_claim_number: trimmed, claim_id: matched.id })
        .eq("id", checkIntakeItemId);
      if (error) throw error;

      return {
        created,
        claimNumber: matched.claim_number,
        claimId: matched.id,
        policyholderName: matched.policyholder_name,
      };
    },
    onSuccess: (res) => {
      if (onLinked) onLinked(res.claimId);
      qc.invalidateQueries({ queryKey: ["intake-check"] });
      qc.invalidateQueries({ queryKey: ["claim-ledger"] });
      qc.invalidateQueries({ queryKey: ["claim-ledger-settlement"] });
      qc.invalidateQueries({ queryKey: ["claim-ledger-checks"] });
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
      
      // Auto-open editor to allow entering amounts immediately
      setTimeout(() => {
        setEditorOpen(true);
      }, 100);

      toast({
        title: res.created ? "Claim tracker created" : "Linked to claim",
        description: res.created
          ? `Now tracking funds for ${res.claimNumber}. Enter the settlement amounts to monitor releases.`
          : `${res.claimNumber}${res.policyholderName ? ` — ${res.policyholderName}` : ""}`,
      });
    },
    onError: (e: any) => {
      toast({ title: "Could not save claim", description: e.message, variant: "destructive" });
    },
    onSettled: () => setSaving(false),
  });

  const handleSave = () => {
    setSaving(true);
    linkMutation.mutate(input);
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
  if (!readOnly && !claimId) {
    return (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Link2 className="h-4 w-4 text-amber-600" />
            Link this check to a claim
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {detectedClaimNumber
              ? "OCR detected the claim number below — confirm or correct it. If a matching claim exists in the CRM we'll link to it; otherwise we'll start a new tracker so you can still enter RCV, ACV, deductible and watch funds add up."
              : "Enter the claim number from the check. If it doesn't match a CRM claim, we'll create a tracker so you can still log RCV, ACV, ordinance & law, etc. and track every check against the same total."}
          </p>
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Claim number"
              className="h-8 text-sm"
            />
            <Button size="sm" disabled={saving || !input.trim()} onClick={handleSave}>
              {saving ? "Linking..." : "Link"}
            </Button>
          </div>
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
  const totalExpected = dwellingAcv + otherStructuresAcv + ppAcv + ordLawNet + aleAcv + totalRecDep
    + Number(s.supplement_expected || 0);

  const totalReceived = siblingChecks.reduce((sum, c: any) => sum + Number(c.amount || 0), 0);
  const remaining = Math.max(0, totalExpected - totalReceived);
  const pct = totalExpected > 0 ? Math.min(100, (totalReceived / totalExpected) * 100) : 0;

  const breakdown = [
    { label: "Dwelling ACV", amount: dwellingAcv },
    { label: "Recoverable Depreciation", amount: totalRecDep },
    { label: "Other Structures", amount: otherStructuresAcv },
    { label: "Ordinance & Law", amount: ordLawNet },
    { label: "Personal Property", amount: ppAcv },
    { label: "Additional Living Exp.", amount: aleAcv },
    { label: "Supplements (expected)", amount: Number(s.supplement_expected || 0) },
    { label: "Deductible (carrier withheld)", amount: -totalDeductible },
  ].filter((b) => b.amount !== 0);

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
            <Button size="sm" disabled={saving || !input.trim()} onClick={handleSave}>
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
                {breakdown.length > 0 ? "Edit amounts" : "Enter amounts"}
              </Button>
            )}
          </div>
          {breakdown.length > 0 ? (
            <div className="rounded-md border border-border/50 divide-y divide-border/50">
              {breakdown.map((b) => (
                <div key={b.label} className="flex justify-between px-2 py-1.5 text-xs">
                  <span className="text-muted-foreground">{b.label}</span>
                  <span className={`tabular-nums font-medium ${b.amount < 0 ? "text-amber-600" : ""}`}>
                    {b.amount < 0 ? "−" : ""}{fmt(Math.abs(b.amount))}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
              {readOnly
                ? "The public adjuster hasn't entered settlement amounts yet."
                : <>No settlement amounts entered yet. Click <span className="font-medium">Enter amounts</span> to add RCV, recoverable depreciation, deductible, ordinance &amp; law, other structures, personal property and ALE.</>}
            </div>
          )}
        </div>

        {!readOnly && claimId && (
          <ClaimSettlementEditor
            open={editorOpen}
            onOpenChange={setEditorOpen}
            claimId={claimId}
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
