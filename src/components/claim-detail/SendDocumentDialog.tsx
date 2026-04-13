import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Send, AlertCircle, Bookmark, Trash2, Users } from "lucide-react";

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

interface SavedContact {
  id: string;
  name: string;
  label: string | null;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  zip: string;
}

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

  // Saved contacts
  const [savedContacts, setSavedContacts] = useState<SavedContact[]>([]);
  const [selectedContactId, setSelectedContactId] = useState("");
  const [saveAddress, setSaveAddress] = useState(false);
  const [saveLabel, setSaveLabel] = useState("");
  const [showManageContacts, setShowManageContacts] = useState(false);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);

  const [fetchedFiles, setFetchedFiles] = useState<Array<{ id: string; file_name: string; file_path: string }>>([]);

  const allFiles = claimFiles.length > 0 ? claimFiles : fetchedFiles;
  const pdfFiles = allFiles.filter(f =>
    f.file_name?.toLowerCase().endsWith(".pdf")
  );

  // Fetch org_id and saved contacts
  useEffect(() => {
    if (!open) return;
    const fetchData = async () => {
      setLoadingContacts(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;

        // Fetch claim files if not provided via props
        if (claimFiles.length === 0 && claimId) {
          const { data: files } = await supabase
            .from("claim_files")
            .select("id, file_name, file_path")
            .eq("claim_id", claimId);
          setFetchedFiles(files || []);
        }

        const { data: orgMember } = await supabase
          .from("org_members")
          .select("org_id")
          .eq("user_id", user.id)
          .maybeSingle();

        if (orgMember?.org_id) {
          setOrgId(orgMember.org_id);
          const { data: contacts } = await supabase
            .from("docupost_contacts")
            .select("id, name, label, address1, address2, city, state, zip")
            .eq("org_id", orgMember.org_id)
            .order("name");

          setSavedContacts(contacts || []);
        }
      } catch (err) {
        console.error("Failed to load data:", err);
      } finally {
        setLoadingContacts(false);
      }
    };
    fetchData();
  }, [open, claimId, claimFiles.length]);

  const handleContactSelect = (contactId: string) => {
    setSelectedContactId(contactId);
    if (!contactId || contactId === "__none__") {
      return;
    }
    const contact = savedContacts.find(c => c.id === contactId);
    if (contact) {
      setToName(contact.name);
      setToAddress1(contact.address1);
      setToAddress2(contact.address2 || "");
      setToCity(contact.city);
      setToState(contact.state);
      setToZip(contact.zip);
    }
  };

  const handleSaveContact = async () => {
    if (!orgId || !toName || !toAddress1 || !toCity || !toState || !toZip) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error } = await supabase
      .from("docupost_contacts")
      .insert({
        org_id: orgId,
        name: toName,
        label: saveLabel || null,
        address1: toAddress1,
        address2: toAddress2 || null,
        city: toCity,
        state: toState,
        zip: toZip,
        created_by: user.id,
      })
      .select("id, name, label, address1, address2, city, state, zip")
      .single();

    if (error) {
      toast({ title: "Failed to save contact", description: error.message, variant: "destructive" });
      return false;
    }
    if (data) {
      setSavedContacts(prev => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      toast({ title: "Contact saved", description: `${toName} has been saved for future use.` });
    }
    return true;
  };

  const handleDeleteContact = async (contactId: string) => {
    const { error } = await supabase
      .from("docupost_contacts")
      .delete()
      .eq("id", contactId);

    if (error) {
      toast({ title: "Failed to delete contact", description: error.message, variant: "destructive" });
      return;
    }
    setSavedContacts(prev => prev.filter(c => c.id !== contactId));
    if (selectedContactId === contactId) setSelectedContactId("");
    toast({ title: "Contact deleted" });
  };

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

      // Save contact if checkbox is checked
      if (saveAddress) {
        await handleSaveContact();
        setSaveAddress(false);
        setSaveLabel("");
      }

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
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-foreground">Recipient</h4>
              <button
                type="button"
                onClick={() => setShowManageContacts(!showManageContacts)}
                className="text-xs text-primary hover:underline flex items-center gap-1"
              >
                <Users className="h-3 w-3" />
                {showManageContacts ? "Hide contacts" : "Manage contacts"}
              </button>
            </div>

            {/* Saved Contacts Dropdown */}
            {savedContacts.length > 0 && !showManageContacts && (
              <div className="space-y-1">
                <Label className="text-xs">Saved Contacts</Label>
                <Select value={selectedContactId} onValueChange={handleContactSelect}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a saved contact..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— Manual entry —</SelectItem>
                    {savedContacts.map(c => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}{c.label ? ` (${c.label})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Manage Contacts List */}
            {showManageContacts && (
              <div className="border rounded-md p-3 space-y-2 bg-muted/30">
                <p className="text-xs text-muted-foreground font-medium">Saved contacts ({savedContacts.length})</p>
                {savedContacts.length === 0 && (
                  <p className="text-xs text-muted-foreground">No saved contacts yet. Send a document and check "Save this address" to create one.</p>
                )}
                {savedContacts.map(c => (
                  <div key={c.id} className="flex items-center justify-between text-sm border-b border-border/50 pb-1.5 last:border-0 last:pb-0">
                    <div>
                      <span className="font-medium">{c.name}</span>
                      {c.label && <span className="text-muted-foreground ml-1">({c.label})</span>}
                      <p className="text-xs text-muted-foreground">{c.address1}, {c.city}, {c.state} {c.zip}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      onClick={() => handleDeleteContact(c.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Name *</Label>
                <div className="flex gap-2">
                  <Input value={toName} onChange={e => setToName(e.target.value)} placeholder="Recipient name" className="flex-1" />
                  {orgId && toName && toAddress1 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 h-10"
                      onClick={handleSaveContact}
                      title="Save this contact"
                    >
                      <Bookmark className="h-4 w-4" />
                    </Button>
                  )}
                </div>
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

            {/* Save Address Checkbox */}
            {orgId && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="save-address"
                    checked={saveAddress}
                    onCheckedChange={(checked) => setSaveAddress(checked === true)}
                  />
                  <label htmlFor="save-address" className="text-xs cursor-pointer">
                    Save this address for future mailings
                  </label>
                </div>
                {saveAddress && (
                  <Input
                    placeholder="Label (e.g. 'Citizens - Claims Dept')"
                    value={saveLabel}
                    onChange={e => setSaveLabel(e.target.value)}
                    className="text-xs h-8"
                  />
                )}
              </div>
            )}
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
