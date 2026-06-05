import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { MortgageMonitoringSection } from "./MortgageMonitoringSection";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { DisbursementConsole } from "@/components/disbursement/DisbursementConsole";

const WORKFLOW_STATUS_OPTIONS = [
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
] as const;

const MORTGAGE_FLAG_OPTIONS = [
  { value: "unknown", label: "Unknown" },
  { value: "yes", label: "Mortgage exists" },
  { value: "no", label: "No mortgage" },
] as const;

const MONITORING_OPTIONS = [
  { value: "not_set", label: "Unset" },
  { value: "monitored", label: "Monitored" },
  { value: "not_monitored", label: "Not monitored" },
] as const;

const ENDORSEMENT_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "signed", label: "Signed" },
  { value: "waived", label: "Waived" },
  { value: "rejected", label: "Rejected" },
] as const;

const PAYMENT_DIRECTION_OPTIONS = [
  { value: "not_requested", label: "Not Requested" },
  { value: "requested", label: "Requested" },
  { value: "pay_contractor", label: "Pay Contractor" },
  { value: "pay_insured", label: "Pay Insured" },
] as const;

const DEPOSIT_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "ready", label: "Ready" },
  { value: "approved", label: "Approved" },
  { value: "deposited", label: "Deposited" },
] as const;

const CLEARED_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "cleared", label: "Cleared" },
] as const;

type AdminDraft = {
  workflowStatus: string;
  mortgageFlag: string;
  mortgageMonitoringType: string;
  endorsementStatus: string;
  paymentDirectionStatus: string;
  depositStatus: string;
  clearedStatus: string;
};

const createAdminDraft = (check: any, intakeCheck: any): AdminDraft => ({
  workflowStatus: intakeCheck?.status ?? "needs_review",
  mortgageFlag:
    check?.mortgage_flag === true ? "yes" : check?.mortgage_flag === false ? "no" : "unknown",
  mortgageMonitoringType:
    intakeCheck?.mortgage_monitoring_type ?? check?.mortgage_monitoring_type ?? "not_set",
  endorsementStatus: check?.endorsement_status ?? "pending",
  paymentDirectionStatus: check?.payment_direction_status ?? "not_requested",
  depositStatus: check?.deposit_status ?? "pending",
  clearedStatus: check?.cleared_status ?? "pending",
});

type Props = {
  claimId: string;
  checkId: string;
  isAdmin?: boolean;
};

export function CheckProcessingCard({ claimId, checkId, isAdmin = false }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { user } = useAuth();
  const [check, setCheck] = useState<any>(null);
  const [intakeCheck, setIntakeCheck] = useState<any>(null);
  const [paymentDirection, setPaymentDirection] = useState<any>(null);
  const [disbursement, setDisbursement] = useState<any>(null);
  const [draws, setDraws] = useState<any[]>([]);
  const [adminDraft, setAdminDraft] = useState<AdminDraft>(createAdminDraft(null, null));
  const [loading, setLoading] = useState(true);
  const [savingCorrections, setSavingCorrections] = useState(false);

  async function load() {
    setLoading(true);

    const [{ data: checkData }, { data: directionData }, { data: disbursementData }, { data: drawData }] =
      await Promise.all([
        supabase
          .from("claim_checks")
          .select("*")
          .eq("id", checkId)
          .single(),
        supabase
          .from("check_payment_directions")
          .select("*")
          .eq("check_id", checkId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("claim_disbursements")
          .select("*")
          .eq("check_id", checkId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("claim_check_mortgage_draws" as any)
          .select("*")
          .eq("check_id", checkId)
          .order("draw_number", { ascending: true }),
      ]);

    let intakeData = null;
    if (checkData?.check_intake_item_id) {
      const { data } = await supabase
        .from("check_intake_items")
        .select("id, status, mortgage_monitoring_type")
        .eq("id", checkData.check_intake_item_id)
        .maybeSingle();
      intakeData = data ?? null;
    }

    setCheck(checkData ?? null);
    setIntakeCheck(intakeData);
    setPaymentDirection(directionData ?? null);
    setDisbursement(disbursementData ?? null);
    setDraws((drawData as any[]) ?? []);
    setAdminDraft(createAdminDraft(checkData, intakeData));
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [checkId]);

  async function markDeposited() {
    await supabase
      .from("claim_checks")
      .update({ deposit_status: "deposited" })
      .eq("id", checkId);

    await supabase.from("claim_events").insert({
      claim_id: claimId,
      event_type: "check_deposited",
      occurred_at: new Date().toISOString(),
      date_source: "system",
      summary: "Check marked as deposited.",
      metadata_json: { check_id: checkId },
    });

    await Promise.all([
      qc.invalidateQueries({ queryKey: ["claim-checks", claimId] }),
      load()
    ]);
  }

  async function markCleared() {
    await supabase
      .from("claim_checks")
      .update({ cleared_status: "cleared" })
      .eq("id", checkId);

    await supabase.from("claim_events").insert({
      claim_id: claimId,
      event_type: "check_cleared",
      occurred_at: new Date().toISOString(),
      date_source: "system",
      summary: "Check marked as cleared.",
      metadata_json: { check_id: checkId },
    });

    await Promise.all([
      qc.invalidateQueries({ queryKey: ["claim-checks", claimId] }),
      load()
    ]);
  }

  async function saveAdminCorrections() {
    setSavingCorrections(true);
    try {
      const hasMortgage = adminDraft.mortgageFlag === "yes" ? true : adminDraft.mortgageFlag === "no" ? false : null;
      const claimCheckUpdates: Record<string, unknown> = {
        endorsement_status: adminDraft.endorsementStatus,
        payment_direction_status: adminDraft.paymentDirectionStatus,
        deposit_status: adminDraft.depositStatus,
        cleared_status: adminDraft.clearedStatus,
        mortgage_flag: hasMortgage,
        mortgage_monitoring_type: hasMortgage ? adminDraft.mortgageMonitoringType : "not_set",
      };

      if (!hasMortgage) {
        claimCheckUpdates.mortgage_sent_at = null;
        claimCheckUpdates.mortgage_received_at = null;
        claimCheckUpdates.mortgage_final_released_at = null;
        claimCheckUpdates.mortgage_tracking_number = null;
      }

      const { error: claimCheckError } = await supabase
        .from("claim_checks")
        .update(claimCheckUpdates as any)
        .eq("id", checkId);

      if (claimCheckError) throw claimCheckError;

      if (intakeCheck?.id) {
        const intakeUpdates: Record<string, unknown> = {
          status: adminDraft.workflowStatus,
          mortgage_monitoring_type: hasMortgage ? adminDraft.mortgageMonitoringType : "not_set",
          updated_at: new Date().toISOString(),
        };

        if (!hasMortgage) {
          intakeUpdates.mortgage_sent_at = null;
          intakeUpdates.mortgage_received_at = null;
          intakeUpdates.mortgage_final_released_at = null;
          intakeUpdates.mortgage_tracking_number = null;
        }

        const { error: intakeError } = await supabase
          .from("check_intake_items")
          .update(intakeUpdates as any)
          .eq("id", intakeCheck.id);

        if (intakeError) throw intakeError;

        await supabase.from("check_audit_log").insert({
          check_id: intakeCheck.id,
          event_type: "admin_correction",
          actor_id: user?.id ?? null,
          event_description: "Admin corrected check routing and mortgage settings from claim accounting.",
          event_data: {
            workflow_status: adminDraft.workflowStatus,
            mortgage_flag: hasMortgage,
            mortgage_monitoring_type: hasMortgage ? adminDraft.mortgageMonitoringType : "not_set",
            endorsement_status: adminDraft.endorsementStatus,
            payment_direction_status: adminDraft.paymentDirectionStatus,
            deposit_status: adminDraft.depositStatus,
            cleared_status: adminDraft.clearedStatus,
          },
        });
      }

      await supabase.from("claim_events").insert({
        claim_id: claimId,
        event_type: "admin_check_correction",
        occurred_at: new Date().toISOString(),
        date_source: "system",
        summary: "Admin corrected a check's routing and mortgage settings.",
        metadata_json: {
          check_id: checkId,
          workflow_status: adminDraft.workflowStatus,
          mortgage_flag: hasMortgage,
          deposit_status: adminDraft.depositStatus,
        },
      });

      await Promise.all([
        qc.invalidateQueries({ queryKey: ["claim-checks", claimId] }),
        qc.invalidateQueries({ queryKey: ["check-intake-items"] }),
      ]);

      toast({
        title: "Check corrected",
        description: "Admin edits were saved for mortgage handling and workflow status.",
      });
      await load();
    } catch (error: any) {
      toast({
        title: "Couldn't save corrections",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSavingCorrections(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading check workflow...</span>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Check Processing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <StatusRow label="Endorsement" value={check?.endorsement_status ?? "pending"} />
          <StatusRow label="Payment Direction" value={check?.payment_direction_status ?? "not_requested"} />
          <StatusRow label="Deposit" value={check?.deposit_status ?? "pending"} />
          <StatusRow label="Cleared" value={check?.cleared_status ?? "pending"} />
        </div>

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={markDeposited}
            disabled={check?.deposit_status === "deposited"}
          >
            Mark Deposited
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={markCleared}
            disabled={check?.cleared_status === "cleared"}
          >
            Mark Cleared
          </Button>
        </div>

        {paymentDirection?.decision === "pay_contractor" && (
          <Badge variant="default">
            Client authorized direct contractor payment
          </Badge>
        )}

        {paymentDirection?.decision === "pay_insured" && (
          <Badge variant="secondary">
            Client requested funds be sent to insured
          </Badge>
        )}

        {isAdmin && (
          <div className="space-y-3 rounded-md border border-border/60 p-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Admin corrections</p>
              <p className="text-xs text-muted-foreground">
                Override check routing, mortgage presence, and downstream statuses.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Workflow status</Label>
                <Select
                  value={adminDraft.workflowStatus}
                  onValueChange={(value) => setAdminDraft((current) => ({ ...current, workflowStatus: value }))}
                  disabled={!intakeCheck?.id}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={intakeCheck?.id ? "Select status" : "No linked intake workflow"} />
                  </SelectTrigger>
                  <SelectContent>
                    {WORKFLOW_STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="text-xs">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Mortgage present</Label>
                <Select
                  value={adminDraft.mortgageFlag}
                  onValueChange={(value) => setAdminDraft((current) => ({
                    ...current,
                    mortgageFlag: value,
                    mortgageMonitoringType: value === "no" ? "not_set" : current.mortgageMonitoringType,
                  }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MORTGAGE_FLAG_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="text-xs">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Mortgage handling</Label>
                <Select
                  value={adminDraft.mortgageMonitoringType}
                  onValueChange={(value) => setAdminDraft((current) => ({ ...current, mortgageMonitoringType: value }))}
                  disabled={adminDraft.mortgageFlag === "no"}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONITORING_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="text-xs">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Endorsement status</Label>
                <Select
                  value={adminDraft.endorsementStatus}
                  onValueChange={(value) => setAdminDraft((current) => ({ ...current, endorsementStatus: value }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ENDORSEMENT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="text-xs">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Payment direction</Label>
                <Select
                  value={adminDraft.paymentDirectionStatus}
                  onValueChange={(value) => setAdminDraft((current) => ({ ...current, paymentDirectionStatus: value }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_DIRECTION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="text-xs">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Deposit status</Label>
                <Select
                  value={adminDraft.depositStatus}
                  onValueChange={(value) => setAdminDraft((current) => ({ ...current, depositStatus: value }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEPOSIT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="text-xs">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Cleared status</Label>
                <Select
                  value={adminDraft.clearedStatus}
                  onValueChange={(value) => setAdminDraft((current) => ({ ...current, clearedStatus: value }))}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLEARED_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} className="text-xs">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {!intakeCheck?.id && (
              <p className="text-xs text-muted-foreground">
                This check is not linked to the intake pipeline, so workflow status edits are unavailable here.
              </p>
            )}

            <Button
              size="sm"
              variant="outline"
              onClick={saveAdminCorrections}
              disabled={savingCorrections}
              className="w-full"
            >
              {savingCorrections && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save admin corrections
            </Button>
          </div>
        )}

        {/* Actum Disbursement section - Only shows when check is deposited */}
        {check?.deposit_status === "deposited" && (
          <div className="pt-4 border-t space-y-4">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              Financial Disbursement (Actum)
            </h4>
            <DisbursementConsole
              checkAmount={Number(check.amount)}
              checkNumber={check.check_number}
              carrierName={check.carrier_name}
              checkIntakeItemId={check.check_intake_item_id}
              onComplete={load}
            />
          </div>
        )}

        {/* Mortgage / Loss Draft section */}
        <MortgageMonitoringSection
          claimId={claimId}
          checkId={checkId}
          check={check}
          draws={draws}
          onRefresh={load}
        />
      </CardContent>
    </Card>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant="outline" className="capitalize text-xs">
        {value.replace(/_/g, " ")}
      </Badge>
    </div>
  );
}
