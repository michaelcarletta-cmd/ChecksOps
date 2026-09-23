import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
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
  const [isSecond, setIsSecond] = useState(false);
  const [company, setCompany] = useState(defaultMortgageCompany ?? "");
  const [loan, setLoan] = useState(defaultLoanNumber ?? "");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Claim / homeowner context — tenant confirms before sending
  const [policyNumber, setPolicyNumber] = useState("");
  const [claimNumber, setClaimNumber] = useState("");
  const [insuranceCompany, setInsuranceCompany] = useState("");
  const [lossType, setLossType] = useState("");
  const [dateOfLoss, setDateOfLoss] = useState("");
  const [homeownerName, setHomeownerName] = useState("");
  const [homeownerEmail, setHomeownerEmail] = useState("");
  const [homeownerPhone, setHomeownerPhone] = useState("");
  const [homeownerSsnLast4, setHomeownerSsnLast4] = useState("");
  const [propertyAddress, setPropertyAddress] = useState("");
  const [prefilled, setPrefilled] = useState(false);

  // All requests for this check (supports two-mortgagee flow)
  const { data: requests, refetch } = useQuery({
    queryKey: ["mortgage-desk-requests", checkIntakeItemId],
    queryFn: async () => {
      const { data } = await supabase
        .from("mortgage_handling_requests")
        .select("id, status, completed_at, created_at, mortgage_company, endorsement_order, total_mortgagees, predecessor_request_id" as any)
        .eq("check_intake_item_id", checkIntakeItemId)
        .order("created_at", { ascending: true });
      return (data as any[]) || [];
    },
    enabled: !!checkIntakeItemId,
  });
  const request = requests?.[requests.length - 1] as any;
  const firstRequest = requests?.[0] as any;


  // Prefill context from claim + check when the dialog opens
  useEffect(() => {
    if (!open || prefilled) return;
    (async () => {
      try {
        const [claimRes, checkRes] = await Promise.all([
          claimId
            ? supabase
                .from("claims")
                .select(
                  "claim_number,policy_number,insurance_company,loss_type,loss_date,policyholder_name,policyholder_email,policyholder_phone,policyholder_address"
                )
                .eq("id", claimId)
                .maybeSingle()
            : Promise.resolve({ data: null } as any),
          supabase
            .from("check_intake_items")
            .select("carrier_name,detected_claim_number,property_address")
            .eq("id", checkIntakeItemId)
            .maybeSingle(),
        ]);
        const c: any = claimRes.data || {};
        const ck: any = checkRes.data || {};
        setClaimNumber((v) => v || c.claim_number || ck.detected_claim_number || "");
        setPolicyNumber((v) => v || c.policy_number || "");
        setInsuranceCompany((v) => v || c.insurance_company || ck.carrier_name || "");
        setLossType((v) => v || c.loss_type || "");
        setDateOfLoss((v) => v || (c.loss_date ? String(c.loss_date).slice(0, 10) : ""));
        setHomeownerName((v) => v || c.policyholder_name || "");
        setHomeownerEmail((v) => v || c.policyholder_email || "");
        setHomeownerPhone((v) => v || c.policyholder_phone || "");
        setPropertyAddress((v) => v || c.policyholder_address || ck.property_address || "");
      } finally {
        setPrefilled(true);
      }
    })();
  }, [open, prefilled, claimId, checkIntakeItemId]);

  const openStatuses = ["requested", "in_progress"];
  const activeRequests = (requests || []).filter((r: any) => r.status !== "cancelled");
  const hasAnyActive = activeRequests.length > 0;
  const hasTwo = activeRequests.length >= 2;
  const isOpen = request && openStatuses.includes(request.status);
  const isCompleted = request?.status === "completed";

  async function submit() {
    if (!company.trim()) {
      toast({ title: "Mortgage company required", variant: "destructive" });
      return;
    }
    if (!homeownerName.trim()) {
      toast({ title: "Homeowner name required", description: "Mortgage Ops needs this to speak with the lender.", variant: "destructive" });
      return;
    }
    const ssn = homeownerSsnLast4.trim();
    if (ssn && !/^\d{4}$/.test(ssn)) {
      toast({ title: "SSN must be 4 digits", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    const { data: userData } = await supabase.auth.getUser();

    // If adding a 2nd mortgagee, tag the new row order=2 and link to the first.
    // Also backfill order=1 + total=2 on the existing first request.
    const orderFields: any = isSecond && firstRequest?.id
      ? {
          endorsement_order: 2,
          total_mortgagees: 2,
          predecessor_request_id: firstRequest.id,
        }
      : hasAnyActive
      ? {}
      : {};

    const { error } = await supabase.from("mortgage_handling_requests").insert({
      tenant_id: tenantId,
      check_intake_item_id: checkIntakeItemId,
      claim_id: claimId ?? null,
      mortgage_company: company.trim(),
      loan_number: loan.trim() || null,
      note: isSecond ? `[2nd mortgagee — send after 1st is endorsed & returned] ${note.trim()}`.trim() : (note.trim() || null),
      requested_by: userData.user?.id ?? null,
      policy_number: policyNumber.trim() || null,
      claim_number: claimNumber.trim() || null,
      insurance_company: insuranceCompany.trim() || null,
      loss_type: lossType.trim() || null,
      date_of_loss: dateOfLoss || null,
      homeowner_name: homeownerName.trim() || null,
      homeowner_email: homeownerEmail.trim() || null,
      homeowner_phone: homeownerPhone.trim() || null,
      homeowner_ssn_last_four: ssn || null,
      property_address: propertyAddress.trim() || null,
      ...orderFields,
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

    // If this was the 2nd mortgagee, update the 1st with order=1, total=2
    if (isSecond && firstRequest?.id) {
      await supabase
        .from("mortgage_handling_requests")
        .update({ endorsement_order: 1, total_mortgagees: 2 } as any)
        .eq("id", firstRequest.id);
    }

    const { data: created } = await supabase
      .from("mortgage_handling_requests")
      .select("id")
      .eq("check_intake_item_id", checkIntakeItemId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (created?.id) {
      supabase.functions.invoke("notify-mortgage-handling-request", {
        body: { request_id: created.id },
      }).catch(() => {});
    }
    toast({
      title: isSecond ? "2nd mortgagee sent to Mortgage Desk" : "Sent to ChecksOps Mortgage Desk",
      description: isSecond
        ? "Mortgage Ops will hold this one until the 1st mortgagee endorses and returns the check."
        : "Our team has been notified and will contact the mortgage company.",
    });
    setOpen(false);
    setIsSecond(false);
    setCompany("");
    setLoan("");
    setNote("");
    setSubmitting(false);
    refetch();
  }

  const openDialog = (second: boolean) => {
    setIsSecond(second);
    if (second) {
      // Reset only the mortgagee-specific fields; keep claim/homeowner prefill
      setCompany("");
      setLoan("");
      setNote("");
    }
    setOpen(true);
  };

  // Render: badge for active, + optional "Add 2nd mortgagee" button
  if (isOpen && !hasTwo) {
    return (
      <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
        <Badge
          variant="outline"
          className="h-7 gap-1 border-blue-400/40 text-blue-400 bg-blue-400/5"
        >
          <Headset className="h-3 w-3" />
          Mortgage Desk: {request?.status === "in_progress" ? "In progress" : "Requested"}
          {request?.mortgage_company ? ` · ${request.mortgage_company}` : ""}
        </Badge>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1 border-primary/40 text-primary hover:bg-primary/10"
          onClick={() => openDialog(true)}
        >
          <Headset className="h-3 w-3" />
          Add 2nd mortgagee
        </Button>
        {renderDialog()}
      </div>
    );
  }

  if (hasTwo) {
    return (
      <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>
        {activeRequests.map((r: any, idx: number) => (
          <Badge
            key={r.id}
            variant="outline"
            className="h-7 gap-1 border-blue-400/40 text-blue-400 bg-blue-400/5"
          >
            <Headset className="h-3 w-3" />
            {idx === 0 ? "1st" : "2nd"}: {r.mortgage_company || "Mortgage"} · {r.status}
          </Badge>
        ))}
      </div>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className={`h-7 text-xs gap-1 border-primary/40 text-primary hover:bg-primary/10 ${className ?? ""}`}
        onClick={() => openDialog(false)}
      >
        <Headset className="h-3 w-3" />
        {isCompleted ? "Send to Mortgage Desk again" : "Send to Mortgage Desk"}
      </Button>
      {renderDialog()}
    </>
  );

  function renderDialog() {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isSecond ? "Send 2nd mortgagee to Mortgage Desk" : "Send to ChecksOps Mortgage Desk"}
            </DialogTitle>
            <DialogDescription>
              {isSecond
                ? "This check has two mortgagees. Mortgage Ops will send it to this lender AFTER the 1st mortgagee endorses and returns the check."
                : "Confirm the claim and homeowner info below — the mortgage ops team uses this when calling the lender, chasing endorsements, and managing draw requests."}

            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Mortgage */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="mortgage-company">Mortgage company *</Label>
                <Input id="mortgage-company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Chase, Rocket Mortgage" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="loan-number">Loan number</Label>
                <Input id="loan-number" value={loan} onChange={(e) => setLoan(e.target.value)} placeholder="Optional" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="policy-number">Policy number</Label>
                <Input id="policy-number" value={policyNumber} onChange={(e) => setPolicyNumber(e.target.value)} />
              </div>
            </div>

            {/* Claim */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="claim-number">Claim number</Label>
                <Input id="claim-number" value={claimNumber} onChange={(e) => setClaimNumber(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="insurance-company">Insurance company</Label>
                <Input id="insurance-company" value={insuranceCompany} onChange={(e) => setInsuranceCompany(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="loss-type">Loss type</Label>
                <Input id="loss-type" value={lossType} onChange={(e) => setLossType(e.target.value)} placeholder="e.g. Wind, Hail, Fire, Water" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="date-of-loss">Date of loss</Label>
                <Input id="date-of-loss" type="date" value={dateOfLoss} onChange={(e) => setDateOfLoss(e.target.value)} />
              </div>
            </div>

            {/* Homeowner */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="ho-name">Homeowner name *</Label>
                <Input id="ho-name" value={homeownerName} onChange={(e) => setHomeownerName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ho-email">Homeowner email</Label>
                <Input id="ho-email" type="email" value={homeownerEmail} onChange={(e) => setHomeownerEmail(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ho-phone">Homeowner phone</Label>
                <Input id="ho-phone" value={homeownerPhone} onChange={(e) => setHomeownerPhone(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ho-ssn4">SSN — last 4</Label>
                <Input
                  id="ho-ssn4"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="e.g. 1234"
                  value={homeownerSsnLast4}
                  onChange={(e) => setHomeownerSsnLast4(e.target.value.replace(/\D/g, "").slice(0, 4))}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="prop-addr">Property address</Label>
                <Input id="prop-addr" value={propertyAddress} onChange={(e) => setPropertyAddress(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="desk-note">Notes for the desk</Label>
              <Textarea id="desk-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the mortgage ops team should know…" rows={3} />
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
    );
  }
}

