import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { Headset, Loader2 } from "lucide-react";

interface Props {
  checkIntakeItemId: string;
  tenantId: string;
  claimId?: string | null;
  defaultMortgageCompany?: string | null;
  defaultLoanNumber?: string | null;
  className?: string;
}

/**
 * Sends the current loss-draft check to the ChecksOps Mortgage Desk queue
 * (mortgage_handling_requests). Shows a status badge when a request is already
 * open for this check.
 */
export function SendToMortgageDeskButton({
  checkIntakeItemId,
  tenantId,
  claimId,
  defaultMortgageCompany,
  defaultLoanNumber,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [company, setCompany] = useState(defaultMortgageCompany ?? "");
  const [loan, setLoan] = useState(defaultLoanNumber ?? "");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: request, refetch } = useQuery({
    queryKey: ["mortgage-desk-request", checkIntakeItemId],
    queryFn: async () => {
      const { data } = await supabase
        .from("mortgage_handling_requests")
        .select("id, status, completed_at, created_at")
        .eq("check_intake_item_id", checkIntakeItemId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
    enabled: !!checkIntakeItemId,
  });

  const openStatuses = ["requested", "in_progress"];
  const isOpen = request && openStatuses.includes(request.status);
  const isCompleted = request?.status === "completed";

  async function submit() {
    if (!company.trim()) {
      toast({ title: "Mortgage company required", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from("mortgage_handling_requests").insert({
      tenant_id: tenantId,
      check_intake_item_id: checkIntakeItemId,
      claim_id: claimId ?? null,
      mortgage_company: company.trim(),
      loan_number: loan.trim() || null,
      note: note.trim() || null,
      requested_by: userData.user?.id ?? null,
    } as any);
    if (error) {
      const dup = /duplicate|unique/i.test(error.message);
      toast({
        title: dup ? "Request already open" : "Could not create request",
        description: dup
          ? "A ChecksOps mortgage request is already active for this check."
          : error.message,
        variant: "destructive",
      });
      setSubmitting(false);
      if (dup) { setOpen(false); refetch(); }
      return;
    }
    const { data: created } = await supabase
      .from("mortgage_handling_requests")
      .select("id")
      .eq("check_intake_item_id", checkIntakeItemId)
      .in("status", openStatuses)
      .maybeSingle();
    if (created?.id) {
      supabase.functions.invoke("notify-mortgage-handling-request", {
        body: { request_id: created.id },
      }).catch(() => {});
    }
    toast({
      title: "Sent to ChecksOps Mortgage Desk",
      description: "Our team has been notified and will contact the mortgage company.",
    });
    setOpen(false);
    setNote("");
    setSubmitting(false);
    refetch();
  }

  if (isOpen) {
    return (
      <Badge
        variant="outline"
        className={`h-7 gap-1 border-blue-400/40 text-blue-400 bg-blue-400/5 ${className ?? ""}`}
      >
        <Headset className="h-3 w-3" />
        Mortgage Desk: {request?.status === "in_progress" ? "In progress" : "Requested"}
      </Badge>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className={`h-7 text-xs gap-1 border-primary/40 text-primary hover:bg-primary/10 ${className ?? ""}`}
        onClick={() => setOpen(true)}
      >
        <Headset className="h-3 w-3" />
        {isCompleted ? "Send to Mortgage Desk again" : "Send to Mortgage Desk"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send to ChecksOps Mortgage Desk</DialogTitle>
            <DialogDescription>
              Hand this loss-draft check off to the ChecksOps mortgage-ops team. They'll contact
              the mortgage company, chase endorsements, and manage draw requests on your behalf.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mortgage-company">Mortgage company *</Label>
              <Input
                id="mortgage-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="e.g. Chase, Rocket Mortgage"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="loan-number">Loan number</Label>
              <Input
                id="loan-number"
                value={loan}
                onChange={(e) => setLoan(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="desk-note">Notes for the desk</Label>
              <Textarea
                id="desk-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Anything the mortgage ops team should know…"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              Send request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
