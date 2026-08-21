import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, FileSignature, Send, Copy, AlertCircle, CheckCircle2, RefreshCw } from "lucide-react";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";
import { useAuditLog } from "@/hooks/useAuditLog";
import { useAuth } from "@/hooks/useAuth";
import { DTPStatusIndicator } from "./DTPStatusIndicator";
import { cn } from "@/lib/utils";

const isRequestExpired = (request: any) => {
  const signers = request.signature_signers ?? [];
  const hasSignedSigner = signers.some((signer: any) => signer.status === "signed");
  if (hasSignedSigner) return false;

  const now = Date.now();
  const hasExpiredSigner = signers.some((signer: any) => {
    if (!signer.expires_at) return false;
    const expiresAt = new Date(signer.expires_at).getTime();
    return Number.isFinite(expiresAt) && expiresAt <= now;
  });

  return request.status === "expired" || hasExpiredSigner;
};

// Page geometry — letter, points (jsPDF default for letter/pt)
const PDF_PAGE_W = 612;
const PDF_PAGE_H = 792;

// Fixed signature region near the bottom of page 1 so field coords always match.
const SIG_LABEL_Y = 640; // top-of-text baseline-ish
const SIG_BOX = { x: 54, y: 655, w: 300, h: 40 };
const DATE_BOX = { x: 400, y: 655, w: 150, h: 40 };

function pctRect(box: { x: number; y: number; w: number; h: number }) {
  return {
    x: (box.x / PDF_PAGE_W) * 100,
    y: (box.y / PDF_PAGE_H) * 100,
    width: (box.w / PDF_PAGE_W) * 100,
    height: (box.h / PDF_PAGE_H) * 100,
  };
}

async function buildDtpPdf(opts: {
  recipientName: string;
  insuredName: string;
  insuredEmail: string;
  checkNumber?: string | null;
}): Promise<Blob> {
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const margin = 54;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("Direction to Pay", margin, y);
  y += 28;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(`Date: ${new Date().toLocaleDateString()}`, margin, y);
  y += 16;
  if (opts.checkNumber) {
    doc.text(`Check Number: ${opts.checkNumber}`, margin, y);
    y += 16;
  }
  y += 8;

  const body =
    `I, ${opts.insuredName} (the "Insured"), hereby authorize and direct that ` +
    `proceeds from the referenced insurance claim check be paid to ` +
    `${opts.recipientName} for work performed and/or services rendered in connection ` +
    `with my property loss claim.\n\n` +
    `This Direction to Pay constitutes my express written authorization to release ` +
    `the indicated funds to ${opts.recipientName}. I understand that this direction ` +
    `does not assign my insurance policy or any rights thereunder, and that I remain ` +
    `the policyholder of record.\n\n` +
    `By signing below, I confirm that the information above is accurate and that I ` +
    `am authorized to issue this direction.`;

  const lines = doc.splitTextToSize(body, 504);
  doc.text(lines, margin, y);

  // Fixed signature region (so the signature_fields rows always match).
  doc.setFont("helvetica", "bold");
  doc.text("Insured Signature:", margin, SIG_LABEL_Y);
  doc.setFont("helvetica", "normal");
  // Visual placeholder boxes
  doc.setDrawColor(160);
  doc.rect(SIG_BOX.x, SIG_BOX.y, SIG_BOX.w, SIG_BOX.h);
  doc.text("Date:", DATE_BOX.x, SIG_LABEL_Y);
  doc.rect(DATE_BOX.x, DATE_BOX.y, DATE_BOX.w, DATE_BOX.h);

  doc.text(`Name: ${opts.insuredName}`, margin, SIG_BOX.y + SIG_BOX.h + 18);
  doc.text(`Email: ${opts.insuredEmail}`, margin, SIG_BOX.y + SIG_BOX.h + 34);

  return doc.output("blob");
}

interface SharedCheckPaymentDirectionProps {
  checkIntakeItemId: string;
  checkNumber?: string | null;
}

const emailSchema = z.string().trim().toLowerCase().email();

/**
 * Direction-to-Pay (DTP) composer for shared checks.
 *
 * Use this when a contractor / PA / sales rep will be paid from the check
 * proceeds but is NOT a named payee on the check itself. Endorsements come
 * from the named payees; this collects the *insured's* signed authorization
 * directing the funds to a third party.
 */
export function SharedCheckPaymentDirection({
  checkIntakeItemId,
  checkNumber,
}: SharedCheckPaymentDirectionProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { log: logAudit } = useAuditLog();
  const { user } = useAuth();
  const currentEmail = user?.email?.toLowerCase() ?? "";

  const [recipientName, setRecipientName] = useState("");
  const [insuredName, setInsuredName] = useState("");
  const [insuredEmail, setInsuredEmail] = useState("");
  const [touched, setTouched] = useState<{ email?: boolean; name?: boolean; recipient?: boolean }>({});

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ["shared-check-dtp-requests", checkIntakeItemId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signature_requests")
        .select("*, signature_signers(*)")
        .eq("check_intake_item_id", checkIntakeItemId)
        .ilike("document_name", "Direction to Pay%")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Validation
  const errors = useMemo(() => {
    const out: { recipient?: string; insuredName?: string; email?: string } = {};
    const email = insuredEmail.trim().toLowerCase();
    const name = insuredName.trim();
    const recipient = recipientName.trim();

    if (!recipient) out.recipient = "Required";
    if (!name) out.insuredName = "Required";

    if (!email) {
      out.email = "Email is required";
    } else if (!emailSchema.safeParse(email).success) {
      out.email = "Enter a valid email address";
    } else if (currentEmail && email === currentEmail) {
      out.email = "Cannot send DTP to yourself";
    } else {
      const alreadySigned = requests.some((r: any) =>
        (r.signature_signers ?? []).some(
          (s: any) => s.signer_email?.toLowerCase() === email && s.status === "signed",
        ),
      );
      if (alreadySigned) out.email = "This recipient has already signed a DTP on this check";
    }
    return out;
  }, [recipientName, insuredName, insuredEmail, currentEmail, requests]);

  const hasErrors = Object.keys(errors).length > 0;
  const emailValid = !!insuredEmail.trim() && !errors.email;

  const sendMutation = useMutation({
    mutationFn: async () => {
      const recipient = recipientName.trim();
      const name = insuredName.trim();
      const email = insuredEmail.trim().toLowerCase();

      const docName = `Direction to Pay - ${recipient}${checkNumber ? ` (Check #${checkNumber})` : ""}`;
      const docPath = `check-intake/${checkIntakeItemId}/payment-direction-${crypto.randomUUID()}.pdf`;

      // 1. Generate and upload the DTP PDF so the signing page has a real document.
      const pdfBlob = await buildDtpPdf({
        recipientName: recipient,
        insuredName: name,
        insuredEmail: email,
        checkNumber,
      });
      const { error: uploadErr } = await supabase.storage
        .from("claim-files")
        .upload(docPath, pdfBlob, { contentType: "application/pdf", upsert: true });
      if (uploadErr) throw new Error(`Could not upload DTP PDF: ${uploadErr.message}`);

      const { data: req, error: reqErr } = await supabase
        .from("signature_requests")
        .insert({
          claim_id: null,
          check_intake_item_id: checkIntakeItemId,
          document_name: docName,
          document_path: docPath,
          status: "draft",
        })
        .select()
        .single();
      if (reqErr) throw reqErr;

      await logAudit({
        action: "create",
        recordType: "dtp_request",
        recordId: req.id,
        metadata: {
          dtp_action: "dtp_requested",
          check_intake_item_id: checkIntakeItemId,
          check_number: checkNumber,
          recipient_email: email,
          recipient_name: recipient,
          signer_name: name,
        },
      });

      const { error: signerErr } = await supabase.from("signature_signers").insert({
        signature_request_id: req.id,
        signer_name: name,
        signer_email: email,
        signing_order: 1,
        signer_type: "policyholder",
        status: "pending",
      });
      if (signerErr) {
        // Roll back the parent request so we don't leave an orphan that breaks Resend.
        await supabase.from("signature_requests").delete().eq("id", req.id);
        throw signerErr;
      }

      // Insert signature + date fields for the insured (signer_index 0) so the
      // signing page actually prompts for a signature.
      const sigPct = pctRect(SIG_BOX);
      const datePct = pctRect(DATE_BOX);
      const { error: fieldsErr } = await supabase.from("signature_fields").insert([
        {
          signature_request_id: req.id,
          signer_index: 0,
          field_type: "signature",
          label: "Insured Signature",
          page: 1,
          required: true,
          ...sigPct,
        },
        {
          signature_request_id: req.id,
          signer_index: 0,
          field_type: "date",
          label: "Date",
          page: 1,
          required: true,
          ...datePct,
        },
      ]);
      if (fieldsErr) {
        await supabase.from("signature_requests").delete().eq("id", req.id);
        throw fieldsErr;
      }

      const { data, error } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId: req.id },
      });
      if (error) {
        throw new Error(await getFunctionErrorMessage(error, "Could not send DTP request"));
      }
      if (data?.error) throw new Error(data.error);

      await logAudit({
        action: "email_sent",
        recordType: "dtp_request",
        recordId: req.id,
        metadata: {
          dtp_action: "dtp_sent",
          recipient_email: email,
          signature_status: "pending",
        },
      });

      return data;
    },
    onSuccess: () => {
      toast({ title: "Direction-to-Pay request sent" });
      setRecipientName("");
      setInsuredName("");
      setInsuredEmail("");
      setTouched({});
      qc.invalidateQueries({ queryKey: ["shared-check-dtp-requests", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["dtp-status", checkIntakeItemId] });
    },
    onError: (err: Error) =>
      toast({ title: "Failed to send", description: err.message, variant: "destructive" }),
  });

  const resendMutation = useMutation({
    mutationFn: async (requestId: string) => {
      const { data, error } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId },
      });
      if (error) throw new Error(await getFunctionErrorMessage(error, "Could not resend"));
      if (data?.error) throw new Error(data.error);

      await logAudit({
        action: "email_sent",
        recordType: "dtp_request",
        recordId: requestId,
        metadata: { dtp_action: "dtp_resent" },
      });
      return data;
    },
    onSuccess: () => {
      toast({ title: "Resent" });
      qc.invalidateQueries({ queryKey: ["shared-check-dtp-requests", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["dtp-status", checkIntakeItemId] });
    },
    onError: (err: Error) =>
      toast({ title: "Resend failed", description: err.message, variant: "destructive" }),
  });

  const copySignLink = (token: string) => {
    const url = `${window.location.origin}/sign?token=${token}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Sign link copied" });
  };

  const attemptSend = () => {
    setTouched({ email: true, name: true, recipient: true });
    if (hasErrors) {
      toast({
        title: "Fix the errors below",
        description: Object.values(errors).filter(Boolean).join(" · "),
        variant: "destructive",
      });
      return;
    }
    sendMutation.mutate();
  };

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileSignature className="h-4 w-4" />
            Request Direction to Pay (DTP)
          </CardTitle>
          <DTPStatusIndicator checkIntakeItemId={checkIntakeItemId} />
        </div>
        <p className="text-xs text-muted-foreground">
          Use this when a contractor, PA, or sales rep will be paid from this check but is{" "}
          <strong>not a named payee</strong>. The insured signs authorizing the disbursement —
          endorsements come from the named payees separately above.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Payment recipient (contractor / PA / rep)
            </Label>
            <Input
              placeholder="e.g. Acme Restoration LLC"
              value={recipientName}
              onChange={(e) => setRecipientName(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, recipient: true }))}
              className={cn(touched.recipient && errors.recipient && "border-destructive")}
            />
            {touched.recipient && errors.recipient && (
              <p className="text-[11px] text-destructive mt-1">{errors.recipient}</p>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Insured name
              </Label>
              <Input
                placeholder="Policyholder name"
                value={insuredName}
                onChange={(e) => setInsuredName(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                className={cn(touched.name && errors.insuredName && "border-destructive")}
              />
              {touched.name && errors.insuredName && (
                <p className="text-[11px] text-destructive mt-1">{errors.insuredName}</p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Insured email
              </Label>
              <div className="relative">
                <Input
                  type="email"
                  placeholder="insured@example.com"
                  value={insuredEmail}
                  onChange={(e) => setInsuredEmail(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                  className={cn(
                    "pr-8",
                    touched.email && errors.email && "border-destructive",
                    touched.email && emailValid && "border-emerald-500/50",
                  )}
                />
                {touched.email && errors.email && (
                  <AlertCircle className="h-4 w-4 text-destructive absolute right-2 top-1/2 -translate-y-1/2" />
                )}
                {touched.email && emailValid && (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500 absolute right-2 top-1/2 -translate-y-1/2" />
                )}
              </div>
              {touched.email && errors.email && (
                <p className="text-[11px] text-destructive mt-1">{errors.email}</p>
              )}
            </div>
          </div>
          <Button
            size="sm"
            onClick={attemptSend}
            disabled={sendMutation.isPending || (Object.values(touched).some(Boolean) && hasErrors)}
          >
            {sendMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
            ) : (
              <Send className="h-3.5 w-3.5 mr-1" />
            )}
            Send DTP request
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-3">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : requests.length > 0 ? (
          <div className="space-y-2 pt-2 border-t">
            <p className="text-xs font-medium">Sent DTP requests ({requests.length})</p>
            {requests.map((req: any) => {
              const isExpired = isRequestExpired(req);
              const statusLabel = req.status === "completed" ? "completed" : isExpired ? "expired" : "sent";
              return (
                <div key={req.id} className="rounded border p-2 space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium truncate">{req.document_name}</span>
                      <Badge
                        variant={
                          req.status === "completed"
                            ? "default"
                            : isExpired
                              ? "destructive"
                              : "secondary"
                        }
                      >
                          {statusLabel}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-muted-foreground">
                        {new Date(req.created_at).toLocaleString()}
                      </span>
                      {isExpired && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2"
                          onClick={() => resendMutation.mutate(req.id)}
                          disabled={resendMutation.isPending}
                        >
                          <RefreshCw className="h-3 w-3 mr-1" />
                          Resend
                        </Button>
                      )}
                    </div>
                  </div>
                  {req.last_error && (
                    <p className="text-destructive text-[11px]">{req.last_error}</p>
                  )}
                  <div className="space-y-1">
                    {(req.signature_signers ?? []).map((signer: any) => (
                      <div
                        key={signer.id}
                        className="flex items-center justify-between gap-2 bg-muted/40 rounded px-2 py-1"
                      >
                        <div className="min-w-0">
                          <span className="font-medium">{signer.signer_name}</span>
                          <span className="text-muted-foreground"> · {signer.signer_email}</span>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {signer.delivery_status && (
                            <Badge variant="outline" className="text-[10px]">
                              {signer.delivery_status}
                            </Badge>
                          )}
                          {signer.access_token && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => copySignLink(signer.access_token)}
                              aria-label="Copy sign link"
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
