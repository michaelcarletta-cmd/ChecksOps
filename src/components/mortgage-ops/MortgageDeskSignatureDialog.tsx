import { lazy, Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronLeft, ChevronRight, Loader2, Mail, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { detectDocumentType } from "@/lib/signer-display-templates";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";
import {
  MORTGAGE_DESK_ESIGN_MAX_SIGNERS,
  buildDeskSignaturePayload,
  deskSignerMissingSignature,
  invokeMortgageDeskEsign,
  isDeskDocxFile,
  signMortgageDeskFile,
  type MortgageDeskFunctionsClient,
  type MortgageDeskSignerInput,
} from "@/lib/mortgageDeskEsign";

// The tenant's field placer (Files > Signature Requests), so the Desk places
// fields exactly as a tenant does.
const FieldPlacementEditor = lazy(() => import("@/components/claim-detail/FieldPlacementEditor").then((m) => ({ default: m.FieldPlacementEditor })));

type PlacedField = { type?: string; signerIndex?: number } & Record<string, unknown>;

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export interface MortgageDeskSignatureDocument {
  name: string;
  path: string;
  /** Bytes of a DOCX the agent just picked (avoids a download round trip). */
  file?: File | null;
}

interface Props {
  client: MortgageDeskFunctionsClient;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  document: MortgageDeskSignatureDocument | null;
  /** The first signer, as the tenant dialog starts it (the claim's policyholder when known). */
  defaultSigners: MortgageDeskSignerInput[];
  onSent?: () => void;
}

const emptySigner = (): MortgageDeskSignerInput => ({ name: "", email: "" });

/**
 * Send one check file for signature from the Mortgage Desk (SQL 124), the way a
 * tenant does from the Files tab once the document is chosen: place the
 * signature and date fields, then enter each signer's name and email (in
 * order), then send. The email goes out from "ChecksOps".
 */
export function MortgageDeskSignatureDialog({
  client,
  open,
  onOpenChange,
  requestId,
  document,
  defaultSigners,
  onSent,
}: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [signers, setSigners] = useState<MortgageDeskSignerInput[]>([emptySigner()]);
  const [fields, setFields] = useState<PlacedField[]>([]);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [docxData, setDocxData] = useState<Uint8Array | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [sending, setSending] = useState(false);

  // Fresh state and the document for every file the dialog opens on.
  useEffect(() => {
    if (!open || !document) return;
    let cancelled = false;
    setStep(1);
    setSigners(defaultSigners.length ? defaultSigners.map((s) => ({ ...s })) : [emptySigner()]);
    setFields([]);
    setDocUrl(null);
    setDocxData(null);
    setLoadingDoc(true);
    (async () => {
      try {
        if (isDeskDocxFile(document.path) && document.file) {
          const bytes = new Uint8Array(await document.file.arrayBuffer());
          if (!cancelled) setDocxData(bytes);
          return;
        }
        // The agent cannot sign check files through /storage/sign: SQL 124 (e) signs them.
        const { signedUrl, error } = await signMortgageDeskFile(client, { requestId, path: document.path });
        if (error || !signedUrl) throw new Error(error || "Could not open the document");
        if (isDeskDocxFile(document.path)) {
          const res = await fetch(signedUrl);
          if (!res.ok) throw new Error("Could not download the document");
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (!cancelled) setDocxData(bytes);
        } else if (!cancelled) {
          setDocUrl(signedUrl);
        }
      } catch (e: unknown) {
        if (!cancelled) toast.error(errorText(e, "Could not open the document"));
      } finally {
        if (!cancelled) setLoadingDoc(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, document?.path]);

  const addSigner = () => setSigners((list) => [...list, emptySigner()]);
  const updateSigner = (index: number, field: keyof MortgageDeskSignerInput, value: string) => {
    setSigners((list) => list.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  };
  const removeSigner = (index: number) => setSigners((list) => list.filter((_, i) => i !== index));

  const send = async () => {
    if (!document) return;
    // Every signer needs a signature field (SQL 124): say which before sending.
    const missing = deskSignerMissingSignature(fields, signers.length);
    if (missing) {
      toast.error(`Signer ${missing} needs at least one signature field. Go back and place one for them.`);
      return;
    }
    setSending(true);
    try {
      const { data, error } = await invokeMortgageDeskEsign<{ sent?: number; failed?: number; total?: number }>(
        client,
        buildDeskSignaturePayload({
          requestId,
          documentName: document.name,
          documentPath: document.path,
          documentType: detectDocumentType(document.name),
          fieldData: fields,
          signers,
        }),
        (err) => getFunctionErrorMessage(err, "Could not send signature request"),
      );
      if (error) throw new Error(error);
      const failed = Number(data?.failed || 0);
      if (failed > 0) {
        toast.warning(`Sent to ${data?.sent ?? 0} of ${data?.total ?? signers.length} signers; ${failed} email${failed === 1 ? "" : "s"} failed.`);
      } else {
        toast.success("Signature request created and emails sent");
      }
      onOpenChange(false);
      onSent?.();
    } catch (e: unknown) {
      toast.error(errorText(e, "Failed to create request"));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!sending) onOpenChange(v); }}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-4xl max-h-[90vh] min-w-0 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
        <DialogHeader className="min-w-0 space-y-1.5 pr-8 text-left">
          <DialogTitle className="text-base leading-snug break-words sm:text-lg">
            Create Signature Request - Step {step} of 2
          </DialogTitle>
          <DialogDescription className="text-left">
            {step === 1 && "Place signature and date fields on the document"}
            {step === 2 && "Configure signers"}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Field Placement */}
        {step === 1 && loadingDoc && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 mr-2 inline animate-spin" />
            Loading document…
          </div>
        )}
        {step === 1 && (docUrl || docxData) && (
          <Suspense fallback={<div className="py-10 text-center text-sm text-muted-foreground">Loading document editor…</div>}>
            <FieldPlacementEditor
              documentUrl={docUrl || undefined}
              docxData={docxData || undefined}
              onFieldsChange={(next) => setFields(next as unknown as PlacedField[])}
              signerCount={signers.length}
            />
          </Suspense>
        )}

        {/* Step 2: Signer Configuration */}
        {step === 2 && (
          <div className="min-w-0 space-y-3" data-testid="mortgage-desk-signers">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <Label className="min-w-0">Signers (in order)</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={addSigner}
                disabled={signers.length >= MORTGAGE_DESK_ESIGN_MAX_SIGNERS}
              >
                <Plus className="w-3 h-3 mr-1" />
                Add Signer
              </Button>
            </div>
            {signers.map((signer, index) => (
              <div key={index} className="flex min-w-0 items-start gap-2">
                <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input
                    placeholder="Name"
                    value={signer.name}
                    onChange={(e) => updateSigner(index, "name", e.target.value)}
                  />
                  <Input
                    type="email"
                    placeholder="Email"
                    value={signer.email}
                    onChange={(e) => updateSigner(index, "email", e.target.value)}
                  />
                </div>
                {signers.length > 1 && (
                  <Button type="button" variant="ghost" size="icon" onClick={() => removeSigner(index)}>
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="sticky bottom-0 z-10 min-w-0 bg-background pt-2">
          <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex w-full min-w-0 sm:w-auto">
              {step === 2 && (
                <Button variant="outline" className="w-full sm:w-auto" disabled={sending} onClick={() => setStep(1)}>
                  <ChevronLeft className="w-4 h-4 mr-2" />
                  Back
                </Button>
              )}
            </div>
            <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:flex-row sm:justify-end">
              {step === 1 && (
                <Button className="w-full sm:w-auto" onClick={() => setStep(2)} disabled={loadingDoc || (!docUrl && !docxData)}>
                  Next
                  <ChevronRight className="w-4 h-4 ml-2" />
                </Button>
              )}
              {step === 2 && (
                <Button
                  className="w-full sm:w-auto"
                  onClick={send}
                  disabled={signers.some((s) => !s.name || !s.email) || sending}
                >
                  {sending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Mail className="w-4 h-4 mr-2" />
                      Send for Signature
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
