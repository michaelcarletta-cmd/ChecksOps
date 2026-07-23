import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { compressCheckImage } from "@/lib/compressCheckImage";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Send, CheckCircle2, Clock, AlertTriangle, XCircle,
  Users, Building2, Shield, FileCheck, Ban, RefreshCw,
  Landmark, PenTool, Eye, ShieldCheck, Loader2, Upload, FileImage,
} from "lucide-react";
import { DepositImageViewer } from "@/components/checks/DepositImageViewer";
import { format } from "date-fns";
import { CheckStatusTimeline } from "./CheckStatusTimeline";

interface CheckEndorsement {
  id: string;
  check_id: string;
  payee_name: string;
  payee_type: string;
  status: string;
  signature_method: string;
  signed_at: string | null;
  request_sent_at: string | null;
  last_reminder_at: string | null;
  reminder_count: number;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  loss_draft_task_created: boolean;
  created_at: string;
}

interface CheckPayee {
  id: string;
  payee_name: string;
  payee_type: string | null;
  endorsement_status: string | null;
  endorsed_at: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  created_at: string;
}

const statusConfig: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  pending: { label: "Pending", color: "bg-muted text-muted-foreground", icon: Clock },
  sent: { label: "Sent", color: "bg-blue-500/20 text-blue-400", icon: Send },
  signed: { label: "Signed", color: "bg-emerald-500/20 text-emerald-400", icon: CheckCircle2 },
  waived: { label: "Waived", color: "bg-amber-500/20 text-amber-400", icon: ShieldCheck },
  manual_required: { label: "Manual Required", color: "bg-orange-500/20 text-orange-400", icon: AlertTriangle },
  rejected: { label: "Rejected", color: "bg-destructive/20 text-destructive", icon: XCircle },
  expired: { label: "Expired", color: "bg-muted text-muted-foreground line-through", icon: Ban },
};

const payeeTypeIcons: Record<string, typeof Users> = {
  insured: Users,
  mortgage_company: Building2,
  contractor: Shield,
  public_adjuster: FileCheck,
  other: AlertTriangle,
};

const normalizeName = (value?: string | null) => (value ?? "").trim().toLowerCase();
const normalizeType = (value?: string | null) => (value ?? "other").trim().toLowerCase();

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

function mergeEndorsementsWithPayees(checkId: string, endorsements: CheckEndorsement[], payees: CheckPayee[]): CheckEndorsement[] {
  if (payees.length === 0) return endorsements;

  const usedEndorsementIds = new Set<string>();
  const byExactKey = new Map<string, CheckEndorsement[]>();
  const byName = new Map<string, CheckEndorsement[]>();

  for (const endorsement of endorsements) {
    const exactKey = `${normalizeName(endorsement.payee_name)}::${normalizeType(endorsement.payee_type)}`;
    const nameKey = normalizeName(endorsement.payee_name);
    byExactKey.set(exactKey, [...(byExactKey.get(exactKey) ?? []), endorsement]);
    byName.set(nameKey, [...(byName.get(nameKey) ?? []), endorsement]);
  }

  // First, map existing real endorsements.
  // Then, only add synthetic ones for payees that DON'T have a matching real endorsement.
  const realEndorsementsMapped = new Set<string>();
  
  const merged: CheckEndorsement[] = [];

  payees.forEach((payee) => {
    const exactKey = `${normalizeName(payee.payee_name)}::${normalizeType(payee.payee_type)}`;
    const nameKey = normalizeName(payee.payee_name);
    
    const match =
      byExactKey.get(exactKey)?.find((row) => !usedEndorsementIds.has(row.id)) ??
      byName.get(nameKey)?.find((row) => !usedEndorsementIds.has(row.id));

    if (match) {
      usedEndorsementIds.add(match.id);
      realEndorsementsMapped.add(match.id);
      merged.push(match);
    } else {
      merged.push({
        id: `payee-${payee.id}`,
        check_id: checkId,
        payee_name: payee.payee_name,
        payee_type: payee.payee_type ?? "other",
        status: normalizeEndorsementStatus(payee.endorsement_status, payee.endorsed_at),
        signature_method: "",
        signed_at: payee.endorsed_at,
        request_sent_at: null,
        last_reminder_at: null,
        reminder_count: 0,
        contact_email: payee.contact_email,
        contact_phone: payee.contact_phone,
        notes: null,
        loss_draft_task_created: false,
        created_at: payee.created_at,
      });
    }
  });

  // Finally, add any real endorsements that weren't linked to a payee record
  for (const endorsement of endorsements) {
    if (!usedEndorsementIds.has(endorsement.id)) {
      merged.push(endorsement);
    }
  }

  return merged;
}

interface EndorsementChecklistProps {
  checkId: string;
  onRefresh?: () => void;
  readOnly?: boolean;
  /** Partner-mode: hides send-request controls but keeps mark-signed/waive,
   *  performing them as direct DB updates (no staff-only edge function). */
  partnerMode?: boolean;
}

export function EndorsementChecklist({ checkId, onRefresh, readOnly = false, partnerMode = false }: EndorsementChecklistProps) {

  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: endorsements = [], isLoading } = useQuery({
    queryKey: ["check-endorsements", checkId],
    queryFn: async () => {
      const [{ data: endorsementData, error: endorsementError }, { data: payeeData, error: payeeError }] = await Promise.all([
        supabase
          .from("check_endorsements")
          .select("*")
          .eq("check_id", checkId)
          .order("created_at", { ascending: true }),
        supabase
          .from("check_payees")
          .select("id, payee_name, payee_type, endorsement_status, endorsed_at, contact_email, contact_phone, created_at")
          .eq("check_id", checkId)
          .order("created_at", { ascending: true }),
      ]);

      if (endorsementError) throw endorsementError;
      if (payeeError) throw payeeError;

      return mergeEndorsementsWithPayees(
        checkId,
        (endorsementData ?? []) as CheckEndorsement[],
        (payeeData ?? []) as CheckPayee[],
      );
    },
  });

  // Look up the assigned contractor's email (if any) for this check's claim,
  // so we can pre-fill a "CC contractor" field on the send form.
  const { data: contractorEmail } = useQuery({
    queryKey: ["check-claim-contractor-email", checkId],
    queryFn: async () => {
      const { data: check } = await supabase
        .from("check_intake_items")
        .select("claim_id")
        .eq("id", checkId)
        .maybeSingle();

      const claimId = check?.claim_id;
      if (!claimId) return { claimId: null, email: "" };

      // Prefer a previously-saved CC on the claim
      const { data: claim } = await supabase
        .from("claims")
        .select("signature_cc_email")
        .eq("id", claimId)
        .maybeSingle();

      if ((claim as any)?.signature_cc_email) {
        return { claimId, email: (claim as any).signature_cc_email as string };
      }

      const { data: assignments } = await supabase
        .from("claim_contractors")
        .select("contractor_id")
        .eq("claim_id", claimId);

      const ids = (assignments ?? []).map((a: any) => a.contractor_id).filter(Boolean);
      if (ids.length === 0) return { claimId, email: "" };

      const { data: profiles } = await supabase
        .from("profiles")
        .select("email")
        .in("id", ids);

      return { claimId, email: profiles?.find((p: any) => p.email)?.email ?? "" };
    },
  });


  const { data: checkData } = useQuery({
    queryKey: ["endorsement-checklist-check-images", checkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("front_image_path, back_image_path, check_number")
        .eq("id", checkId)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const { data: frontImageUrl } = useQuery({
    queryKey: ["endorsement-check-front-img", checkData?.front_image_path],
    enabled: !!checkData?.front_image_path,
    queryFn: async () => {
      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(checkData!.front_image_path!, 3600);
      return data?.signedUrl ?? null;
    },
  });

  const { data: backImageUrl } = useQuery({
    queryKey: ["endorsement-check-back-img", checkData?.back_image_path],
    enabled: !!checkData?.back_image_path,
    queryFn: async () => {
      const { data } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(checkData!.back_image_path!, 3600);
      return data?.signedUrl ?? null;
    },
  });

  const [frontViewerOpen, setFrontViewerOpen] = useState(false);
  const [backViewerOpen, setBackViewerOpen] = useState(false);

  const [forceCompleting, setForceCompleting] = useState(false);


  const allComplete = endorsements.length > 0 && endorsements.every(
    (e) => e.status === "signed" || e.status === "waived" ||
      (e.payee_type === "mortgage_company" && e.status === "manual_required"),
  );

  const pendingCount = endorsements.filter(
    (e) => e.status === "pending" || e.status === "sent",
  ).length;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["check-endorsements", checkId] });
    qc.invalidateQueries({ queryKey: ["check-endorsements-summary", checkId] });
    qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
    qc.invalidateQueries({ queryKey: ["check-intake-items"] });
    onRefresh?.();
  };

  const forceCompleteAll = async () => {
    setForceCompleting(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user?.id ?? "unknown";

      const incompleteIds = endorsements
        .filter((e) => e.status !== "signed" && e.status !== "waived")
        .map((e) => e.id);

      if (incompleteIds.length > 0) {
        const { error } = await supabase
          .from("check_endorsements")
          .update({
            status: "signed",
            signed_at: new Date().toISOString(),
            notes: `Manually marked as received by staff override`,
            signature_method: "manual",
          })
          .in("id", incompleteIds);

        if (error) throw error;
      }

      // Audit log is best-effort; partner tenants may not have insert rights.
      try {
        await supabase.from("check_audit_log").insert({
          check_id: checkId,
          event_type: "endorsements_force_completed",
          event_description: `All endorsements manually marked as received (${incompleteIds.length} updated)`,
          actor_id: userId,
          event_data: { overridden_ids: incompleteIds, partner_mode: partnerMode },
        });
      } catch (auditErr) {
        console.warn("Audit log insert skipped:", auditErr);
      }


      toast({
        title: "Endorsements marked as complete",
        description: `${incompleteIds.length} endorsement(s) updated at ${new Date().toLocaleTimeString()}`,
      });

      refresh();
    } catch (e: unknown) {
      console.error("Force complete endorsements failed:", e);
      toast({
        title: "Failed to update endorsements",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setForceCompleting(false);
    }
  };

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading endorsements...</div>;
  }

  if (endorsements.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        <PenTool className="h-8 w-8 mx-auto mb-2 opacity-30" />
        No endorsements required
      </div>
    );
  }

  return (
    <>
    <div className="space-y-3">

      {/* Workflow timeline + 24h stale alert */}
      <CheckStatusTimeline checkId={checkId} />

      {/* Status summary */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <PenTool className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Endorsements</span>
        </div>
        {allComplete ? (
          <Badge className="bg-emerald-500/20 text-emerald-400 text-[10px]">
            <CheckCircle2 className="h-3 w-3 mr-1" />All Complete
          </Badge>
        ) : (
          <Badge className="bg-amber-500/20 text-amber-400 text-[10px]">
            <Clock className="h-3 w-3 mr-1" />{pendingCount} Pending
          </Badge>
        )}
        {/* View Check Images buttons removed — use the "View Check Images"
            button at the top of the check file instead. */}
      </div>


      {!allComplete && !readOnly && !partnerMode && (
        <div className="px-1 space-y-2">
          <div className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-md px-2.5 py-1.5 flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            Deposit blocked until all required endorsements are completed
          </div>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="w-full text-xs h-8 border-muted-foreground/30 text-muted-foreground hover:text-primary hover:border-primary"
                disabled={forceCompleting}
              >
                {forceCompleting ? (
                  <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3 w-3 mr-1.5" />
                )}
                Mark All Endorsements Received
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Force Complete Endorsements</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure all endorsements have been received? This will mark {pendingCount} pending endorsement(s) as signed. This action will be logged and cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={forceCompleteAll}>
                  Confirm
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {endorsements.map((endorsement) => (
        <EndorsementCard
          key={endorsement.id}
          endorsement={endorsement}
          onRefresh={refresh}
          readOnly={readOnly}
          partnerMode={partnerMode}
          defaultContractorCc={contractorEmail?.email ?? ""}
          claimId={contractorEmail?.claimId ?? null}

        />
      ))}

    </div>

    <DepositImageViewer
      open={frontViewerOpen}
      imageUrl={frontImageUrl ?? null}
      title={`Front of Check #${checkData?.check_number || checkId.slice(0, 8)}`}
      onClose={() => setFrontViewerOpen(false)}
    />
    <DepositImageViewer
      open={backViewerOpen}
      imageUrl={backImageUrl ?? null}
      title={`Back of Check #${checkData?.check_number || checkId.slice(0, 8)}`}
      onClose={() => setBackViewerOpen(false)}
    />
    </>
  );
}



function EndorsementCard({
  endorsement,
  onRefresh,
  readOnly = false,
  partnerMode = false,
  defaultContractorCc = "",
  claimId = null,
}: {
  endorsement: CheckEndorsement;
  onRefresh: () => void;
  readOnly?: boolean;
  partnerMode?: boolean;
  defaultContractorCc?: string;
  claimId?: string | null;
}) {

  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState(endorsement.contact_email ?? "");
  // SMS removed from endorsements
  const [ccContractor, setCcContractor] = useState(defaultContractorCc);
  const [includeCc, setIncludeCc] = useState(Boolean(defaultContractorCc));

  // Sync state if defaultContractorCc changes (e.g. after first send)
  useEffect(() => {
    if (defaultContractorCc && !ccContractor) {
      setCcContractor(defaultContractorCc);
      setIncludeCc(true);
    }
  }, [defaultContractorCc]);
  const [sending, setSending] = useState(false);
  const [markingInternal, setMarkingInternal] = useState(false);
  const [uploading, setUploading] = useState(false);


  const config = statusConfig[endorsement.status] ?? statusConfig.pending;
  const StatusIcon = config.icon;
  const PayeeIcon = payeeTypeIcons[endorsement.payee_type] ?? AlertTriangle;

  const isMortgage = endorsement.payee_type === "mortgage_company";
  const isSynthetic = endorsement.id.startsWith("payee-");
  const canSendRequest = !readOnly && !partnerMode && !isMortgage &&
    endorsement.status !== "signed" &&
    endorsement.status !== "waived" &&
    endorsement.status !== "rejected";
  const canMarkInternal = !readOnly && !partnerMode && endorsement.status !== "signed" && endorsement.status !== "waived";
  const isResend = endorsement.request_sent_at != null;


  const sendRequest = async () => {
    setSending(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Not authenticated");

      const ccEmail = includeCc ? ccContractor.trim() : "";
      const { error } = await supabase.functions.invoke("check-endorsement", {
        body: {
          action: "send_endorsement_request",
          endorsementId: endorsement.id.startsWith("payee-") ? undefined : endorsement.id,
          payeeId: endorsement.id.startsWith("payee-") ? endorsement.id.replace("payee-", "") : undefined,
          method: "email",
          email: email || undefined,
          cc: ccEmail ? [ccEmail] : undefined,
        },
        headers: { Authorization: `Bearer ${session.session.access_token}` },
      });

      if (error) throw new Error(await getFunctionErrorMessage(error, "Failed to send endorsement request"));
      // Remember CC email on the claim so we don't re-enter it next time
      if (ccEmail && claimId) {
        await supabase
          .from("claims")
          .update({ signature_cc_email: ccEmail } as any)
          .eq("id", claimId);
      }

      toast({ title: `Endorsement request ${isResend ? "resent" : "sent"} via email` });
      onRefresh();

    } catch (e: unknown) {
      toast({
        title: "Failed to send",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  const markInternalSigned = async () => {
    setMarkingInternal(true);
    try {
      {
        const { data: session } = await supabase.auth.getSession();
        if (!session.session?.access_token) throw new Error("Not authenticated");
        const { error } = await supabase.functions.invoke("check-endorsement", {
          body: { 
            action: "mark_internal_signed", 
            endorsementId: endorsement.id.startsWith("payee-") ? undefined : endorsement.id,
            payeeId: endorsement.id.startsWith("payee-") ? endorsement.id.replace("payee-", "") : undefined
          },
          headers: { Authorization: `Bearer ${session.session.access_token}` },
        });
        if (error) throw new Error(error.message);
      }
      toast({ title: `${endorsement.payee_name} marked as endorsed` });
      onRefresh();
    } catch (e: unknown) {
      toast({
        title: "Failed to mark signed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setMarkingInternal(false);
    }
  };

  const waiveEndorsement = async () => {
    try {
      {
        const { data: session } = await supabase.auth.getSession();
        if (!session.session?.access_token) throw new Error("Not authenticated");
        const { error } = await supabase.functions.invoke("check-endorsement", {
          body: { 
            action: "waive_endorsement", 
            endorsementId: endorsement.id.startsWith("payee-") ? undefined : endorsement.id,
            payeeId: endorsement.id.startsWith("payee-") ? endorsement.id.replace("payee-", "") : undefined
          },
          headers: { Authorization: `Bearer ${session.session.access_token}` },
        });
        if (error) throw new Error(error.message);
      }
      toast({ title: `${endorsement.payee_name} endorsement waived` });
      onRefresh();
    } catch (e: unknown) {
      toast({
        title: "Failed to waive",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };


  const handleBackImageUpload = async (file: File) => {
    setUploading(true);
    try {
      const compressed = await compressCheckImage(file);
      const ext = (compressed.name.split(".").pop() || "jpg").toLowerCase();
      const newPath = `checks/${endorsement.check_id}/back-${Date.now()}.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from("claim-files")
        .upload(newPath, compressed, {
          cacheControl: "31536000",
          upsert: false,
          contentType: compressed.type || "image/jpeg",
        });

      if (uploadErr) throw uploadErr;

      const { error: updateErr } = await supabase
        .from("check_intake_items")
        .update({ back_image_path: newPath })
        .eq("id", endorsement.check_id);

      if (updateErr) throw updateErr;

      // Track re-upload event
      const { data: session } = await supabase.auth.getSession();
      await supabase.from("check_audit_log").insert({
        check_id: endorsement.check_id,
        event_type: "back_image_reuploaded",
        actor_id: session.session?.user?.id ?? null,
        event_description: "Endorsed back of check uploaded from Endorsement Checklist",
        event_data: { new_path: newPath },
      });

      toast({
        title: "Back image uploaded",
        description: "The check's back image has been updated successfully.",
      });
      onRefresh();
    } catch (e: any) {
      toast({
        title: "Upload failed",
        description: e.message,
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PayeeIcon className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-sm">{endorsement.payee_name}</span>
        </div>
        <Badge className={`text-[10px] ${config.color}`}>
          <StatusIcon className="h-3 w-3 mr-1" />
          {config.label}
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground capitalize">
        {endorsement.payee_type.replace(/_/g, " ")}
        {endorsement.signature_method !== "portal" && (
          <span className="ml-1 text-[10px]">
            · {endorsement.signature_method}
          </span>
        )}
      </p>

      {/* Mortgage payee → loss draft routing */}
      {isMortgage && (
        <div className="space-y-2">
          <div className="text-[10px] text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-2 py-1 flex items-center gap-1">
            <Landmark className="h-3 w-3 shrink-0" />
            Routed to Loss Draft workflow — requires manual endorsement
          </div>
          {!readOnly && !partnerMode && (
            <div className="pt-0.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleBackImageUpload(f);
                  e.target.value = "";
                }}
              />
              <Button
                size="sm"
                variant="outline"
                className="w-full text-[10px] h-7 border-blue-500/30 text-blue-400 hover:text-blue-300 hover:bg-blue-500/5"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? (
                  <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" />
                ) : (
                  <Upload className="h-3 w-3 mr-1.5" />
                )}
                {uploading ? "Uploading..." : "Upload Back of Check"}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Signed info */}
      {endorsement.signed_at && (
        <p className="text-[10px] text-emerald-400">
          ✓ Signed {format(new Date(endorsement.signed_at), "MMM d, yyyy h:mm a")}
        </p>
      )}

      {/* Request sent info */}
      {endorsement.request_sent_at && endorsement.status !== "signed" && (
        <p className="text-[10px] text-muted-foreground">
          Last sent {format(new Date(endorsement.request_sent_at), "MMM d h:mm a")}
          {endorsement.reminder_count > 0 && ` · ${endorsement.reminder_count} reminder(s)`}
        </p>
      )}

      {isSynthetic && (
        <p className="text-[10px] text-muted-foreground">
          Showing from payee record while endorsement tracking sync catches up
        </p>
      )}

      {/* Send/resend controls for non-mortgage payees */}
      {canSendRequest && (
        <div className="space-y-2 pt-1">
          <Input
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-8 text-xs"
          />
          {/* CC contractor on the endorsement email so they can follow up with the client */}
          <div className="space-y-1 rounded-md border border-muted-foreground/20 bg-muted/30 p-2">
            <label className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={includeCc}
                onChange={(e) => setIncludeCc(e.target.checked)}
                className="h-3 w-3"
              />
              <Shield className="h-3 w-3" />
              CC contractor on email
            </label>
            {includeCc && (
              <Input
                placeholder="contractor@example.com"
                value={ccContractor}
                onChange={(e) => {
                  const val = e.target.value;
                  setCcContractor(val);
                  // Auto-save as the user types so it's not lost
                  if (claimId && val.includes("@")) {
                    supabase
                      .from("claims")
                      .update({ signature_cc_email: val } as any)
                      .eq("id", claimId)
                      .then(({ error }) => {
                        if (error) console.error("Error saving CC email:", error);
                      });
                  }
                }}
                className="h-7 text-xs"
              />
            )}
          </div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              className="w-full text-xs h-7"
              disabled={sending || !email}
              onClick={() => sendRequest()}
            >
              {sending ? <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
              {isResend ? "Resend Endorsement Request" : "Send Endorsement Request"}
            </Button>
          </div>

        </div>
      )}

      {/* Staff action buttons */}
      {canMarkInternal && (
        <div className="flex gap-1 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 text-xs h-7 text-emerald-400 hover:text-emerald-300"
            disabled={markingInternal}
            onClick={markInternalSigned}
          >
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Mark Signed
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-xs h-7 text-muted-foreground"
            onClick={waiveEndorsement}
          >
            <Eye className="h-3 w-3 mr-1" />
            Waive
          </Button>
        </div>
      )}
    </Card>
  );
}
