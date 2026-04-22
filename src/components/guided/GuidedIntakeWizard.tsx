import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Upload, CheckCircle2, FileText, ArrowRight, ArrowLeft, Plus } from "lucide-react";

interface Props {
  userId: string;
  onComplete: (claimId: string) => void;
  onCancel: () => void;
}

const LOSS_TYPES = [
  "Wind/Hail", "Fire", "Water/Flood", "Theft", "Vandalism",
  "Lightning", "Tree/Debris Impact", "Freeze/Ice", "Other",
];

const CLAIM_STATUSES = [
  "Filed - Awaiting Inspection", "Inspected - Awaiting Estimate",
  "Estimate Received", "Partial Payment Received", "Denied",
  "Under Review", "Supplement Submitted", "In Dispute", "Other",
];

const DOCUMENT_TYPES = [
  { key: "policy", label: "Policy Declaration Page", required: false },
  { key: "carrier_estimate", label: "Carrier Estimate", required: false },
  { key: "denial_letter", label: "Denial / Limitation Letter", required: false },
  { key: "inspection_report", label: "Inspection Report", required: false },
  { key: "engineer_report", label: "Engineer Report", required: false },
  { key: "contractor_estimate", label: "Contractor Estimate", required: false },
  { key: "photos", label: "Photos", required: false },
  { key: "payment_letters", label: "Payment Letters", required: false },
  { key: "prior_emails", label: "Prior Emails / Correspondence", required: false },
];

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function GuidedIntakeWizard({ userId, onComplete, onCancel }: Props) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [claimId, setClaimId] = useState<string | null>(null);
  const { toast } = useToast();

  // Carrier list from DB
  const [carrierList, setCarrierList] = useState<string[]>([]);
  const [carrierLoading, setCarrierLoading] = useState(true);
  const [addingNewCarrier, setAddingNewCarrier] = useState(false);
  const newCarrierRef = useRef<HTMLInputElement>(null);

  // Step 1: Claim info
  const [carrier, setCarrier] = useState("");
  const [customCarrier, setCustomCarrier] = useState("");
  const [claimNumber, setClaimNumber] = useState("");
  const [adjusterName, setAdjusterName] = useState("");
  const [adjusterEmail, setAdjusterEmail] = useState("");
  const [adjusterPhone, setAdjusterPhone] = useState("");
  const [lossDate, setLossDate] = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [lossType, setLossType] = useState("");
  const [claimStatus, setClaimStatus] = useState("");

  // Step 2: Uploads
  const [uploadedDocs, setUploadedDocs] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState<string | null>(null);

  useEffect(() => {
    const loadCarriers = async () => {
      const { data } = await supabase
        .from("claims")
        .select("insurance_company")
        .not("insurance_company", "is", null)
        .not("insurance_company", "eq", "");

      if (data) {
        const unique = [...new Set(data.map((d: any) => d.insurance_company as string))].sort();
        setCarrierList(unique);
      }
      setCarrierLoading(false);
    };
    loadCarriers();
  }, []);

  const resolvedCarrier = carrier === "__new__" ? customCarrier.trim() : carrier;

  const buildFullAddress = () => {
    const parts = [streetAddress, city, state].filter(Boolean);
    let addr = parts.join(", ");
    if (zip) addr += ` ${zip}`;
    return addr.trim() || null;
  };

  const handleCarrierSelect = (val: string) => {
    if (val === "__new__") {
      setCarrier("__new__");
      setAddingNewCarrier(true);
      setTimeout(() => newCarrierRef.current?.focus(), 50);
    } else {
      setCarrier(val);
      setAddingNewCarrier(false);
      setCustomCarrier("");
    }
  };

  const handleCreateClaim = async () => {
    if (!resolvedCarrier || !claimNumber) {
      toast({ title: "Required fields", description: "Please fill in carrier and claim number.", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const { data: claim, error } = await supabase
        .from("claims")
        .insert({
          insurance_company: resolvedCarrier,
          claim_number: claimNumber,
          loss_date: lossDate || null,
          loss_type: lossType || null,
          status: claimStatus || "New",
          is_guided_mode: true,
          policyholder_name: "",
          policyholder_address: buildFullAddress(),
        })
        .select()
        .single();

      if (error) throw error;

      await supabase.from("guided_claim_access").insert({
        user_id: userId,
        claim_id: claim.id,
        relationship: "policyholder",
      });

      if (adjusterName) {
        await supabase.from("claim_adjusters").insert({
          claim_id: claim.id,
          adjuster_name: adjusterName,
          adjuster_email: adjusterEmail || null,
          adjuster_phone: adjusterPhone || null,
        });
      }

      setClaimId(claim.id);
      setStep(2);
      toast({ title: "Claim created", description: "Now upload your documents." });
    } catch (err: any) {
      toast({ title: "Error creating claim", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = async (docType: string, files: FileList | null) => {
    if (!files?.length || !claimId) return;
    setUploading(docType);

    try {
      for (const file of Array.from(files)) {
        const filePath = `${claimId}/guided/${docType}/${file.name}`;
        const { error: uploadError } = await supabase.storage
          .from("claim-files")
          .upload(filePath, file);

        if (uploadError) throw uploadError;

        await supabase.from("claim_files").insert({
          claim_id: claimId,
          file_name: file.name,
          file_path: filePath,
          file_type: file.type,
          file_size: file.size,
          document_type: docType,
          uploaded_by: userId,
        });
      }

      setUploadedDocs(prev => ({ ...prev, [docType]: true }));
      toast({ title: "Uploaded", description: `${docType} uploaded successfully.` });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(null);
    }
  };

  const handleFinish = () => {
    if (claimId) onComplete(claimId);
  };

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Progress */}
      <div className="flex items-center gap-2 text-sm">
        <span className={`px-3 py-1 rounded-full font-medium ${step === 1 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
          1. Claim Details
        </span>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
        <span className={`px-3 py-1 rounded-full font-medium ${step === 2 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
          2. Upload Documents
        </span>
      </div>

      {step === 1 && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-foreground">Start Your Claim</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Carrier dropdown */}
              <div className="space-y-2">
                <Label>Insurance Company *</Label>
                {carrierLoading ? (
                  <div className="flex items-center gap-2 h-10 px-3 border border-border rounded-md bg-muted/30">
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Loading...</span>
                  </div>
                ) : (
                  <Select value={carrier} onValueChange={handleCarrierSelect}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select carrier" />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {carrierList.map(c => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                      <SelectItem value="__new__">
                        <span className="flex items-center gap-1 text-primary font-medium">
                          <Plus className="h-3 w-3" /> Add New Company
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {addingNewCarrier && (
                  <Input
                    ref={newCarrierRef}
                    value={customCarrier}
                    onChange={e => setCustomCarrier(e.target.value)}
                    placeholder="Enter insurance company name"
                    className="mt-1"
                  />
                )}
              </div>

              <div className="space-y-2">
                <Label>Claim Number *</Label>
                <Input value={claimNumber} onChange={e => setClaimNumber(e.target.value)} placeholder="e.g. 12-3456-789" />
              </div>

              <div className="space-y-2">
                <Label>Adjuster Name</Label>
                <Input value={adjusterName} onChange={e => setAdjusterName(e.target.value)} placeholder="Adjuster name" />
              </div>
              <div className="space-y-2">
                <Label>Adjuster Email</Label>
                <Input type="email" value={adjusterEmail} onChange={e => setAdjusterEmail(e.target.value)} placeholder="adjuster@carrier.com" />
              </div>
              <div className="space-y-2">
                <Label>Adjuster Phone</Label>
                <Input
                  type="tel"
                  value={adjusterPhone}
                  onChange={e => setAdjusterPhone(formatPhone(e.target.value))}
                  placeholder="xxx-xxx-xxxx"
                  maxLength={12}
                />
              </div>
              <div className="space-y-2">
                <Label>Date of Loss</Label>
                <Input type="date" value={lossDate} onChange={e => setLossDate(e.target.value)} />
              </div>
            </div>

            {/* Address fields */}
            <div className="space-y-2">
              <Label>Property Address</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <Input value={streetAddress} onChange={e => setStreetAddress(e.target.value)} placeholder="Street address" />
                </div>
                <Input value={city} onChange={e => setCity(e.target.value)} placeholder="City" />
                <div className="grid grid-cols-2 gap-3">
                  <Select value={state} onValueChange={setState}>
                    <SelectTrigger>
                      <SelectValue placeholder="State" />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {US_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input
                    value={zip}
                    onChange={e => setZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
                    placeholder="Zip"
                    maxLength={5}
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Loss Type</Label>
                <Select value={lossType} onValueChange={setLossType}>
                  <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
                  <SelectContent>
                    {LOSS_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Current Claim Status</Label>
                <Select value={claimStatus} onValueChange={setClaimStatus}>
                  <SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger>
                  <SelectContent>
                    {CLAIM_STATUSES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex gap-3 pt-4">
              <Button variant="outline" onClick={onCancel}>Cancel</Button>
              <Button onClick={handleCreateClaim} disabled={loading} className="flex-1">
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Claim & Continue
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-foreground">Upload Documents</CardTitle>
            <p className="text-sm text-muted-foreground">
              Upload whatever you have. The more Darwin knows, the stronger your communications will be.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {DOCUMENT_TYPES.map(doc => (
              <div
                key={doc.key}
                className="flex items-center justify-between border border-border rounded-lg p-3 bg-muted/20"
              >
                <div className="flex items-center gap-3">
                  {uploadedDocs[doc.key] ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                  ) : (
                    <FileText className="h-5 w-5 text-muted-foreground" />
                  )}
                  <span className="text-sm text-foreground">{doc.label}</span>
                </div>
                <label className="cursor-pointer">
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={e => handleFileUpload(doc.key, e.target.files)}
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.tiff,.bmp"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    disabled={uploading === doc.key}
                  >
                    <span>
                      {uploading === doc.key ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Upload className="h-3 w-3 mr-1" />
                      )}
                      {uploadedDocs[doc.key] ? "Add More" : "Upload"}
                    </span>
                  </Button>
                </label>
              </div>
            ))}

            <div className="flex gap-3 pt-4">
              <Button variant="outline" onClick={() => setStep(1)}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Button>
              <Button onClick={handleFinish} className="flex-1">
                Continue to Claim Dashboard
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
