import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertTriangle, CheckCircle2, Building2, Edit3, Save,
  RotateCcw, Shield, Users, FileCheck, Loader2,
} from "lucide-react";

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
  carrier_name: string | null;
  check_number: string | null;
  amount: number | null;
  issue_date: string | null;
  payee_line: string | null;
  is_multi_payee: boolean;
  ocr_status: string;
  status: string;
  deposit_recommendation: string | null;
  deposit_recommendation_reasons: string[] | null;
  detected_claim_number: string | null;
  claim_id: string | null;
  created_at: string;
  check_payees?: CheckPayee[];
}

const REVIEW_STATUSES = [
  "needs_review",
  "manual_review_required",
  "endorsements_complete",
  "branch_deposit_recommended",
];

const DEPOSIT_PATHS = [
  { value: "approved_for_deposit", label: "Approved for Deposit", icon: CheckCircle2, color: "text-emerald-400" },
  { value: "branch_deposit_required", label: "Branch Deposit Required", icon: Building2, color: "text-blue-400" },
  { value: "reissue_requested", label: "Request Reissue", icon: RotateCcw, color: "text-orange-400" },
  { value: "hold_for_claim_review", label: "Hold for Claim Review", icon: AlertTriangle, color: "text-amber-400" },
];

const PAYEE_TYPES = ["insured", "mortgage_company", "contractor", "public_adjuster", "unknown"];

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
  const { data: reviewChecks = [], isLoading } = useQuery({
    queryKey: ["check-review-queue"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("*, check_payees(*)")
        .or(
          `status.in.(${REVIEW_STATUSES.join(",")}),deposit_recommendation.in.(manual_review_required,branch_deposit_recommended),ocr_status.eq.failed`
        )
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as ReviewCheck[];
    },
    refetchInterval: 15000,
  });

  function getReviewReason(check: ReviewCheck): string {
    const reasons: string[] = [];
    if (check.ocr_status === "failed") reasons.push("OCR failed");
    if (check.deposit_recommendation === "manual_review_required") reasons.push("Manual review required");
    if (check.deposit_recommendation === "branch_deposit_recommended") reasons.push("Branch deposit");
    if (check.status === "needs_review") reasons.push("Low OCR confidence");
    if (check.status === "endorsements_complete") reasons.push("Endorsements complete — needs approval");
    if (check.check_payees?.some((p) => p.endorsement_status === "rejected")) reasons.push("Rejected endorsement");
    if (check.check_payees?.some((p) => p.payee_type === "mortgage_company")) reasons.push("Mortgage payee");
    if ((check.check_payees?.length ?? 0) >= 3) reasons.push("3+ payees");
    if (check.check_payees?.some((p) => p.payee_type === "unknown")) reasons.push("Unclear payee classification");
    return reasons.join(" · ") || "Pending review";
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
    <ScrollArea className="h-[calc(100vh-400px)]">
      <div className="space-y-2 p-2">
        {reviewChecks.map((check) => (
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
                <Badge variant="outline" className="text-[10px] bg-orange-500/10 text-orange-400 border-orange-500/20">
                  <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                  {getReviewReason(check).split(" · ")[0]}
                </Badge>
                {check.check_payees && check.check_payees.length > 0 && (
                  <Badge variant="outline" className="text-[10px]">
                    {check.check_payees.length} payee{check.check_payees.length > 1 ? "s" : ""}
                  </Badge>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </ScrollArea>
  );
}

/* ------------------------------------------------------------------ */
/*  Review Decision Panel                                              */
/* ------------------------------------------------------------------ */

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
  });

  const [editing, setEditing] = useState(false);
  const [carrierName, setCarrierName] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [payeeLine, setPayeeLine] = useState("");
  const [depositPath, setDepositPath] = useState("");
  const [notes, setNotes] = useState("");

  // Sync form when check loads
  useEffect(() => {
    if (check) {
      setCarrierName(check.carrier_name ?? "");
      setCheckNumber(check.check_number ?? "");
      setAmount(check.amount?.toString() ?? "");
      setPayeeLine(check.payee_line ?? "");
    }
  }, [check]);

  const submitDecision = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("Not authenticated");
      if (!depositPath) throw new Error("Select a deposit path");
      if (!check) throw new Error("Check not loaded");

      const changes: { field: string; old_value: string | null; new_value: string | null }[] = [];

      if (editing) {
        if (carrierName !== (check.carrier_name ?? "")) {
          changes.push({ field: "carrier_name", old_value: check.carrier_name, new_value: carrierName || null });
        }
        if (checkNumber !== (check.check_number ?? "")) {
          changes.push({ field: "check_number", old_value: check.check_number, new_value: checkNumber || null });
        }
        if (amount !== (check.amount?.toString() ?? "")) {
          changes.push({ field: "amount", old_value: check.amount?.toString() ?? null, new_value: amount || null });
        }
        if (payeeLine !== (check.payee_line ?? "")) {
          changes.push({ field: "payee_line", old_value: check.payee_line, new_value: payeeLine || null });
        }
      }

      // Update check fields if edited
      const updatePayload: Record<string, unknown> = {
        status: depositPath === "reissue_requested" ? "reissue_requested" : depositPath,
        deposit_recommendation: depositPath === "hold_for_claim_review" 
          ? check.deposit_recommendation 
          : depositPath === "approved_for_deposit" 
            ? "ready_for_deposit" 
            : depositPath,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        review_notes: notes || null,
      };

      if (editing) {
        if (carrierName) updatePayload.carrier_name = carrierName;
        if (checkNumber) updatePayload.check_number = checkNumber;
        if (amount) updatePayload.amount = parseFloat(amount);
        if (payeeLine) updatePayload.payee_line = payeeLine;
      }

      const { error: updateErr } = await supabase
        .from("check_intake_items")
        .update(updatePayload)
        .eq("id", checkId);
      if (updateErr) throw updateErr;

      // Save review decision record
      const { error: decErr } = await supabase
        .from("check_review_decisions")
        .insert({
          check_id: checkId,
          reviewer_id: user.id,
          decision: depositPath,
          confirmed_carrier_name: carrierName || null,
          confirmed_check_number: checkNumber || null,
          confirmed_amount: amount ? parseFloat(amount) : null,
          confirmed_payee_line: payeeLine || null,
          deposit_path: depositPath,
          reviewer_notes: notes || null,
        });
      if (decErr) throw decErr;

      // Audit each field change
      for (const change of changes) {
        await supabase.from("check_audit_log").insert({
          check_id: checkId,
          event_type: "manual_field_edit",
          event_description: `Reviewer changed ${change.field}: "${change.old_value ?? ""}" → "${change.new_value ?? ""}"`,
          event_data: {
            field: change.field,
            old_value: change.old_value,
            new_value: change.new_value,
            reason: notes || "Review decision",
          },
          actor_id: user.id,
        });
      }

      // Audit the decision itself
      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "review_decision",
        event_description: `Reviewer set deposit path: ${depositPath}`,
        event_data: {
          deposit_path: depositPath,
          fields_edited: changes.length,
          notes: notes || null,
        },
        actor_id: user.id,
      });

      // If reissue requested, create reissue record
      if (depositPath === "reissue_requested") {
        await supabase.from("check_reissue_requests").insert({
          check_id: checkId,
          requested_by: user.id,
          reason: notes || "Check not practically depositable",
          reason_category: "payee_error",
        });
      }
    },
    onSuccess: () => {
      toast({ title: "Review decision saved" });
      qc.invalidateQueries({ queryKey: ["check-review-queue"] });
      qc.invalidateQueries({ queryKey: ["review-check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      onComplete();
    },
    onError: (err) => {
      toast({ title: "Failed to save decision", description: err.message, variant: "destructive" });
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
    <ScrollArea className="h-[calc(100vh-400px)]">
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Review Check #{check.check_number || "—"}</h3>
          <Button
            size="sm"
            variant={editing ? "default" : "outline"}
            onClick={() => {
              if (!editing) {
                setCarrierName(check.carrier_name ?? "");
                setCheckNumber(check.check_number ?? "");
                setAmount(check.amount?.toString() ?? "");
                setPayeeLine(check.payee_line ?? "");
              }
              setEditing(!editing);
            }}
          >
            <Edit3 className="h-3 w-3 mr-1" />
            {editing ? "Cancel Edit" : "Edit Fields"}
          </Button>
        </div>

        {/* Review reasons */}
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

        {/* OCR Fields */}
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Check Details</h4>
          {editing ? (
            <>
              <div>
                <Label className="text-xs">Carrier Name</Label>
                <Input value={carrierName} onChange={(e) => setCarrierName(e.target.value)} className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Check Number</Label>
                <Input value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} className="h-8 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Amount</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <Label className="text-xs">Payee Line</Label>
                <Input value={payeeLine} onChange={(e) => setPayeeLine(e.target.value)} className="h-8 text-sm" />
              </div>
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

        <Separator />

        {/* Payee Reconciliation */}
        <PayeeReconciliation checkId={checkId} payees={check.check_payees ?? []} />

        <Separator />

        {/* Deposit Path Decision */}
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Deposit Decision</h4>
          <div className="grid grid-cols-2 gap-2">
            {DEPOSIT_PATHS.map((path) => {
              const PathIcon = path.icon;
              return (
                <Card
                  key={path.value}
                  className={`cursor-pointer transition-all p-2.5 text-center hover:bg-accent/30 ${
                    depositPath === path.value ? "ring-1 ring-primary bg-accent/50" : ""
                  }`}
                  onClick={() => setDepositPath(path.value)}
                >
                  <PathIcon className={`h-5 w-5 mx-auto mb-1 ${path.color}`} />
                  <p className="text-[11px] font-medium leading-tight">{path.label}</p>
                </Card>
              );
            })}
          </div>
        </div>

        {/* Notes */}
        <div>
          <Label className="text-xs">Reviewer Notes</Label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes about this decision..."
            className="text-sm min-h-[60px]"
          />
        </div>

        {/* Submit */}
        <Button
          onClick={() => submitDecision.mutate()}
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
    </ScrollArea>
  );
}

/* ------------------------------------------------------------------ */
/*  Payee Reconciliation                                               */
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

  const updatePayee = useMutation({
    mutationFn: async ({ payeeId, name, type }: { payeeId: string; name: string; type: string }) => {
      const original = payees.find((p) => p.id === payeeId);
      if (!original) throw new Error("Payee not found");

      // Update payee without regenerating token
      const { error } = await supabase
        .from("check_payees")
        .update({
          payee_name: name,
          payee_type: type,
        })
        .eq("id", payeeId);
      if (error) throw error;

      // Audit the change
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

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Payee Reconciliation
      </h4>
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
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PAYEE_TYPES.map((t) => (
                        <SelectItem key={t} value={t} className="text-xs">
                          {t.replace(/_/g, " ")}
                        </SelectItem>
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
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px]"
                      onClick={() => setEditingPayee(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 min-w-0">
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
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
}
