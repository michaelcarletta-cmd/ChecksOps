import { lazy, Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronLeft, ChevronRight, Loader2, Plus, Send, X } from "lucide-react";
import { toast } from "sonner";
import { detectDocumentType } from "@/lib/signer-display-templates";
import { getFunctionErrorMessage } from "@/lib/edgeFunctionError";
import {
  MORTGAGE_DESK_ESIGN_MAX_SIGNERS,
  MORTGAGE_DESK_SIGNER_TYPE_LABELS,
  buildDeskSignaturePayload,
  contractorDeskSigner,
  deskSignerMissingSignature,
  deskSignersProblem,
  invokeMortgageDeskEsign,
  isDeskDocxFile,
  signMortgageDeskFile,
  type MortgageDeskFunctionsClient,
  type MortgageDeskSignerInput,
  type MortgageDeskSignerType,
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
  defaultSigners: MortgageDeskSignerInput[];
  contractorDefaults: { tenantName?: string | null; tenantEmail?: string | null };
  onSent?: () => void;
}

/**
 * Send one check file for signature from the Mortgage Desk (SQL 124). The same
 * steps as the tenant's "Request Signature" dialog: signers, then fields on the
 * document, then send. Signers are the insured and/or the contractor (tenant);
 * the email goes out from "ChecksOps".
 */
export function MortgageDeskSignatureDialog({
  client,
  open,
  onOpenChange,
  requestId,
  document,
  defaultSigners,
  contractorDefaults,
  onSent,
}: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [signers, setSigners] = useState<MortgageDeskSignerInput[]>(defaultSigners);
  const [fields, setFields] = useState<PlacedField[]>([]);
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [docxData, setDocxData] = useState<Uint8Array | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [sending, setSending] = useState(false);

  // Fresh state for every document the dialog opens on.
  useEffect(() => {
    if (!open || !document) return;
    setStep(1);
    setSigners(defaultSigners.length ? defaultSigners : [contractorDeskSigner(contractorDefaults)]);
    setFields([]);
    setDocUrl(null);
    setDocxData(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, document?.path]);

  const loadDocument = async () => {
    if (!document) return false;
    if (docUrl || docxData) return true;
    setLoadingDoc(true);
    try {
      if (isDeskDocxFile(document.path)) {
        if (document.file) {
          setDocxData(new Uint8Array(await document.file.arrayBuffer()));
          return true;
        }
      }
      // The agent cannot sign check files through /storage/sign: SQL 124 (e) signs them.
      const { signedUrl, error } = await signMortgageDeskFile(client, { requestId, path: document.path });
      if (error || !signedUrl) throw new Error(error || "Could not open the document");
      if (isDeskDocxFile(document.path)) {
        const res = await fetch(signedUrl);
        if (!res.ok) throw new Error("Could not download the document");
        setDocxData(new Uint8Array(await res.arrayBuffer()));
      } else {
        setDocUrl(signedUrl);
      }
      return true;
    } catch (e: unknown) {
      toast.error(errorText(e, "Could not open the document"));
      return false;
    } finally {
      setLoadingDoc(false);
    }
  };

  const next = async () => {
    const problem = deskSignersProblem(signers);
    if (problem) {
      toast.error(problem);
      return;
    }
    if (await loadDocument()) setStep(2);
  };

  const updateSigner = (index: number, patch: Partial<MortgageDeskSignerInput>) => {
    setSigners((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const send = async () => {
    if (!document) return;
    const problem = deskSignersProblem(signers);
    if (problem) {
      toast.error(problem);
      return;
    }
    const missing = deskSignerMissingSignature(fields, signers.length);
    if (missing) {
      toast.error(`Signer ${missing} needs at least one signature field.`);
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
        (err) => getFunctionErrorMessage(err, "Could not send for signature"),
      );
      if (error) throw new Error(error);
      const failed = Number(data?.failed || 0);
      if (failed > 0) {
        toast.warning(`Sent to ${data?.sent ?? 0} of ${data?.total ?? signers.length} signers; ${failed} email${failed === 1 ? "" : "s"} failed.`);
      } else {
        toast.success("Signature request sent from ChecksOps");
      }
      onOpenChange(false);
      onSent?.();
    } catch (e: unknown) {
      toast.error(errorText(e, "Could not send for signature"));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!sending) onOpenChange(v); }}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-4xl max-h-[90vh] min-w-0 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
        <DialogHeader className="min-w-0 space-y-1.5 pr-8 text-left">
          <DialogTitle className="text-base leading-snug break-words sm:text-lg">
            Send for signature - Step {step} of 2
          </DialogTitle>
          <DialogDescription className="text-left">
            {step === 1 && `"${document?.name || "Document"}": choose who signs, in order. The email comes from ChecksOps.`}
            {step === 2 && "Place signature and date fields on the document"}
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="min-w-0 space-y-3" data-testid="mortgage-desk-signers">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <Label className="min-w-0">Signers (in order)</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={signers.length >= MORTGAGE_DESK_ESIGN_MAX_SIGNERS}
                onClick={() => setSigners((list) => [
                  ...list,
                  list.some((s) => s.type === "contractor")
                    ? { name: "", email: "", type: "policyholder" }
                    : contractorDeskSigner(contractorDefaults),
                ])}
              >
                <Plus className="w-3 h-3 mr-1" />
                Add Signer
              </Button>
            </div>
            {signers.map((signer, index) => (
              <div key={index} className="flex min-w-0 items-start gap-2">
                <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
                  <Input placeholder="Name" value={signer.name} onChange={(e) => updateSigner(index, { name: e.target.value })} />
                  <Input type="email" placeholder="Email" value={signer.email} onChange={(e) => updateSigner(index, { email: e.target.value })} />
                  <Select value={signer.type} onValueChange={(value) => updateSigner(index, { type: value as MortgageDeskSignerType })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="policyholder">{MORTGAGE_DESK_SIGNER_TYPE_LABELS.policyholder}</SelectItem>
                      <SelectItem value="contractor">{MORTGAGE_DESK_SIGNER_TYPE_LABELS.contractor}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {signers.length > 1 && (
                  <Button type="button" variant="ghost" size="icon" onClick={() => setSigners((list) => list.filter((_, i) => i !== index))}>
                    <X className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Every signer needs at least one signature field. The link expires in 72 hours. The tenant sees this
              request in its own signature list.
            </p>
          </div>
        )}

        {step === 2 && (docUrl || docxData) && (
          <Suspense fallback={<div className="py-10 text-center text-sm text-muted-foreground">Loading document editor…</div>}>
            <FieldPlacementEditor
              documentUrl={docUrl || undefined}
              docxData={docxData || undefined}
              onFieldsChange={(next) => setFields(next as unknown as PlacedField[])}
              signerCount={signers.length}
            />
          </Suspense>
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
                <Button className="w-full sm:w-auto" onClick={next} disabled={loadingDoc}>
                  {loadingDoc ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Loading...</> : <>Next<ChevronRight className="w-4 h-4 ml-2" /></>}
                </Button>
              )}
              {step === 2 && (
                <Button className="w-full sm:w-auto" onClick={send} disabled={sending}>
                  {sending
                    ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Sending…</>
                    : <><Send className="w-4 h-4 mr-2" />Send ({fields.length} field{fields.length === 1 ? "" : "s"})</>}
                </Button>
              )}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
