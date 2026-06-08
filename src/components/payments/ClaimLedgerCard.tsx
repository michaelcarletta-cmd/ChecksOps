import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { FileText, Link2, CheckCircle2, AlertCircle, Pencil } from "lucide-react";
import { format } from "date-fns";

interface Props {
  checkIntakeItemId: string;
  claimId: string | null;
  detectedClaimNumber: string | null;
}

const fmt = (n: number) =>
  `$${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ClaimLedgerCard({ checkIntakeItemId, claimId, detectedClaimNumber }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(!claimId);
  const [input, setInput] = useState(detectedClaimNumber ?? "");
  const [saving, setSaving] = useState(false);

  // Fetch claim + settlement + all checks for this claim
  const { data: claim } = useQuery({
    queryKey: ["claim-ledger", claimId],
    enabled: !!claimId,
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

  const { data: settlement } = useQuery({
    queryKey: ["claim-ledger-settlement", claimId],
    enabled: !!claimId,
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

  const { data: siblingChecks = [] } = useQuery({
    queryKey: ["claim-ledger-checks", claimId],
    enabled: !!claimId,
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

      if (!matches || matches.length === 0) {
        // No claim found — just save the detected number; user can create the claim elsewhere
        const { error } = await supabase
          .from("check_intake_items")
          .update({ detected_claim_number: trimmed })
          .eq("id", checkIntakeItemId);
        if (error) throw error;
        return { linked: false as const, claimNumber: trimmed };
      }
      if (matches.length > 1) {
        throw new Error(`Multiple claims match "${trimmed}". Please disambiguate.`);
      }
      const match = matches[0];
      const { error } = await supabase
        .from("check_intake_items")
        .update({ detected_claim_number: trimmed, claim_id: match.id })
        .eq("id", checkIntakeItemId);
      if (error) throw error;
      return { linked: true as const, claimNumber: match.claim_number, claimId: match.id, policyholderName: match.policyholder_name };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["intake-check"] });
      qc.invalidateQueries({ queryKey: ["claim-ledger"] });
      qc.invalidateQueries({ queryKey: ["claim-ledger-settlement"] });
      qc.invalidateQueries({ queryKey: ["claim-ledger-checks"] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      if (res.linked) {
        toast({ title: "Linked to claim", description: `${res.claimNumber} — ${res.policyholderName ?? ""}` });
        setEditing(false);
      } else {
        toast({
          title: "Claim number saved",
          description: `No existing claim found for "${res.claimNumber}". Create the claim to start tracking funds.`,
        });
      }
    },
    onError: (e: any) => {
      toast({ title: "Could not link claim", description: e.message, variant: "destructive" });
    },
    onSettled: () => setSaving(false),
  });

  const handleSave = () => {
    setSaving(true);
    linkMutation.mutate(input);
  };

  // ─── Unlinked state ─────────────────────────────────────────────
  if (!claimId) {
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
            Tracking all funds released against a single claim number requires this check to be
            linked. {detectedClaimNumber ? "OCR detected the number below — confirm or correct it." : "Enter the claim number from the check."}
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
  const s = settlement || {};
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
    - Number(s.pwi_non_recoverable_depreciation || 0)
    - Number(s.pwi_deductible || 0));
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
    + Number(s.other_structures_deductible || 0)
    + Number(s.pwi_deductible || 0);
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
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1 text-[10px]"
            onClick={() => { setInput(claim?.claim_number ?? ""); setEditing((v) => !v); }}
          >
            <Pencil className="h-3 w-3 mr-1" /> Change
          </Button>
        </div>
        {claim?.policyholder_name && (
          <p className="text-xs text-muted-foreground truncate">{claim.policyholder_name}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {editing && (
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
            No settlement amounts entered yet. Add RCV, depreciation, deductible, and other categories
            from the claim's accounting tab to start tracking progress toward the full RCV.
          </div>
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
                    <Badge variant="outline" className="text-[9px]">
                      {c.check_stage}
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
