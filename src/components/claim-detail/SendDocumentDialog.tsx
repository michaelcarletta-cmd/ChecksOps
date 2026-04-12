import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Send, AlertCircle } from "lucide-react";

const DOCUMENT_TYPES = [
  "Letter",
  "Certificate of Completion",
  "Demand Letter",
  "Notice of Loss",
  "Proof of Loss",
  "Supplement Request",
  "Invoice",
  "Report",
  "Authorization Form",
  "Other",
];

const MAIL_SERVICES = [
  { value: "usps_first_class", label: "USPS First Class" },
  { value: "usps_standard", label: "USPS Standard" },
  { value: "certified", label: "Certified Mail" },
  { value: "certified_return_receipt", label: "Certified w/ Return Receipt" },
];

interface SendDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  claimId: string;
  claimNumber: string;
  policyholderName?: string;
  propertyAddress?: string;
  claimFiles?: Array<{ id: string; file_name: string; file_path: string }>;
}

export function SendDocumentDialog({
  open,
  onOpenChange,
  claimId,
  claimNumber,
  policyholderName,
  propertyAddress,
  claimFiles = [],
}: SendDocumentDialogProps) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [documentType, setDocumentType] = useState("Letter");
  const [mailService, setMailService] = useState("usps_first_class");
  const [selectedFileId, setSelectedFileId] = useState("");
  const [pdfUrl, setPdfUrl] = useState("");

  // Recipient
  const [toName, setToName] = useState(policyholderName || "");
  const [toAddress1, setToAddress1] = useState("");
  const [toAddress2, setToAddress2] = useState("");
  const [toCity, setToCity] = useState("");
  const [toState, setToState] = useState("");
  const [toZip, setToZip] = useState("");

  // Sender (optional)
  const [fromName, setFromName] = useState("Freedom Public Adjusters");
  const [fromAddress1, setFromAddress1] = useState("");
  const [fromCity, setFromCity] = useState("");
  const [fromState, setFromState] = useState("");
  const [fromZip, setFromZip] = useState("");

  const pdfFiles = claimFiles.filter(f =>
    f.file_name?.toLowerCase().endsWith(".pdf")
  );

  const handleFileSelect = async (fileId: string) => {
    setSelectedFileId(fileId);
    if (!fileId) {
      setPdfUrl("");
      return;
    }
    const file = claimFiles.find(f => f.id === fileId);
    if (file?.file_path) {
      const { data } = supabase.storage
        .from("claim-files")
        .getPublicUrl(file.file_path);
      setPdfUrl(data?.publicUrl || "");
    }
  };

  const handleSend = async () => {
    if (!toName || !toAddress1 || !toCity || !toState || !toZip) {
      toast({ title: "Missing fields", description: "Please fill in all required recipient address fields.", variant: "destructive" });
      return;
    }
    if (!pdfUrl) {
      toast({ title: "No document", description: "Please select a PDF file or enter a PDF URL.", variant: "destructive" });
      return;
    }

    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-docupost", {
        body: {
          claim_id: claimId,
          claim_number: claimNumber,
          document_type: documentType,
          to_name: toName,
          to_address1: toAddress1,
          to_address2: toAddress2,
          to_city: toCity,
          to_state: toState,
          to_zip: toZip,
          from_name: fromName,
          from_address1: fromAddress1,
          from_city: fromCity,
          from_state: fromState,
          from_zip: fromZip,
          pdf_url: pdfUrl,
          mail_service: mailService,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast({ title: "Document queued for delivery", description: `${documentType} will be mailed to ${toName} via Docupost.` });
      onOpenChange(false);
    } catch (err: any) {
      console.error("Docupost send error:", err);
      toast({
        title: "Failed to send document",
        description: err.message || "An error occurred. Please try again.",
        variant: "destructive",
        action: (
          <Button variant="outline" size="sm" onClick={handleSend}>
            Retry
          </Button>
        ),
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            Send Document via Docupost
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Document Type & Mail Service */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Document Type</Label>
              <Select value={documentType} onValueChange={setDocumentType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DOCUMENT_TYPES.map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Mail Service</Label>
              <Select value={mailService} onValueChange={setMailService}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MAIL_SERVICES.map(s => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* PDF Selection */}
          <div className="space-y-1.5">
            <Label>Document (PDF)</Label>
            {pdfFiles.length > 0 ? (
              <Select value={selectedFileId} onValueChange={handleFileSelect}>
                <SelectTrigger><SelectValue placeholder="Select a claim PDF..." /></SelectTrigger>
                <SelectContent>
                  {pdfFiles.map(f => (
                    <SelectItem key={f.id} value={f.id}>{f.file_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <AlertCircle className="h-4 w-4" />
                No PDF files on this claim
              </div>
            )}
            <Input
              placeholder="Or paste a PDF URL directly..."
              value={pdfUrl}
              onChange={e => { setPdfUrl(e.target.value); setSelectedFileId(""); }}
              className="mt-1.5"
            />
          </div>

          {/* Recipient */}
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">Recipient</h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Name *</Label>
                <Input value={toName} onChange={e => setToName(e.target.value)} placeholder="Recipient name" />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Address Line 1 *</Label>
                <Input value={toAddress1} onChange={e => setToAddress1(e.target.value)} placeholder="Street address" />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Address Line 2</Label>
                <Input value={toAddress2} onChange={e => setToAddress2(e.target.value)} placeholder="Apt, suite, etc." />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">City *</Label>
                <Input value={toCity} onChange={e => setToCity(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">State *</Label>
                  <Input value={toState} onChange={e => setToState(e.target.value)} maxLength={2} placeholder="FL" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">ZIP *</Label>
                  <Input value={toZip} onChange={e => setToZip(e.target.value)} placeholder="33101" />
                </div>
              </div>
            </div>
          </div>

          {/* Sender (collapsed by default) */}
          <details className="space-y-2">
            <summary className="text-sm font-semibold text-foreground cursor-pointer">Return Address (optional)</summary>
            <div className="grid grid-cols-2 gap-3 mt-2">
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Name</Label>
                <Input value={fromName} onChange={e => setFromName(e.target.value)} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Address</Label>
                <Input value={fromAddress1} onChange={e => setFromAddress1(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">City</Label>
                <Input value={fromCity} onChange={e => setFromCity(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">State</Label>
                  <Input value={fromState} onChange={e => setFromState(e.target.value)} maxLength={2} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">ZIP</Label>
                  <Input value={fromZip} onChange={e => setFromZip(e.target.value)} />
                </div>
              </div>
            </div>
          </details>

          <Button onClick={handleSend} disabled={sending} className="w-full">
            {sending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="h-4 w-4 mr-2" />
                Send via Docupost
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
