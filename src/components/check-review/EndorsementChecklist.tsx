import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
  Landmark, PenTool, Eye, ShieldCheck, Loader2,
} from "lucide-react";
import { format } from "date-fns";

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

interface EndorsementChecklistProps {
  checkId: string;
  onRefresh?: () => void;
  readOnly?: boolean;
}

export function EndorsementChecklist({ checkId, onRefresh, readOnly = false }: EndorsementChecklistProps) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: endorsements = [], isLoading } = useQuery({
    queryKey: ["check-endorsements", checkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_endorsements")
        .select("*")
        .eq("check_id", checkId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CheckEndorsement[];
    },
  });

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
            signature_method: "manual_override",
          })
          .in("id", incompleteIds);

        if (error) throw error;
      }

      // Audit log
      await supabase.from("check_audit_log").insert({
        check_id: checkId,
        event_type: "endorsements_force_completed",
        event_description: `All endorsements manually marked as received (${incompleteIds.length} updated)`,
        actor_id: userId,
        event_data: { overridden_ids: incompleteIds },
      });

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
    <div className="space-y-3">
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
      </div>

      {!allComplete && !readOnly && (
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
        />
      ))}
    </div>
  );
}

function EndorsementCard({
  endorsement,
  onRefresh,
}: {
  endorsement: CheckEndorsement;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState(endorsement.contact_email ?? "");
  const [phone, setPhone] = useState(endorsement.contact_phone ?? "");
  const [sending, setSending] = useState(false);
  const [markingInternal, setMarkingInternal] = useState(false);

  const config = statusConfig[endorsement.status] ?? statusConfig.pending;
  const StatusIcon = config.icon;
  const PayeeIcon = payeeTypeIcons[endorsement.payee_type] ?? AlertTriangle;

  const isMortgage = endorsement.payee_type === "mortgage_company";
  const canSendRequest = !isMortgage &&
    endorsement.status !== "signed" &&
    endorsement.status !== "waived" &&
    endorsement.status !== "rejected";
  const canMarkInternal = endorsement.status !== "signed" && endorsement.status !== "waived";
  const isResend = endorsement.request_sent_at != null;

  const sendRequest = async (method: "email" | "sms") => {
    setSending(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Not authenticated");

      const { error } = await supabase.functions.invoke("check-endorsement", {
        body: {
          action: "send_endorsement_request",
          endorsementId: endorsement.id,
          method,
          email: email || undefined,
          phone: phone || undefined,
        },
        headers: { Authorization: `Bearer ${session.session.access_token}` },
      });

      if (error) throw new Error(error.message);
      toast({ title: `Endorsement request ${isResend ? "resent" : "sent"} via ${method}` });
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
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Not authenticated");

      const { error } = await supabase.functions.invoke("check-endorsement", {
        body: { action: "mark_internal_signed", endorsementId: endorsement.id },
        headers: { Authorization: `Bearer ${session.session.access_token}` },
      });

      if (error) throw new Error(error.message);
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
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Not authenticated");

      const { error } = await supabase.functions.invoke("check-endorsement", {
        body: { action: "waive_endorsement", endorsementId: endorsement.id },
        headers: { Authorization: `Bearer ${session.session.access_token}` },
      });

      if (error) throw new Error(error.message);
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
        <div className="text-[10px] text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-2 py-1 flex items-center gap-1">
          <Landmark className="h-3 w-3 shrink-0" />
          Routed to Loss Draft workflow — requires manual endorsement
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

      {/* Send/resend controls for non-mortgage payees */}
      {canSendRequest && (
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
              onClick={() => sendRequest("email")}
            >
              {sending ? <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
              {isResend ? "Resend" : "Email"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 text-xs h-7"
              disabled={sending || !phone}
              onClick={() => sendRequest("sms")}
            >
              {sending ? <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
              SMS
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
