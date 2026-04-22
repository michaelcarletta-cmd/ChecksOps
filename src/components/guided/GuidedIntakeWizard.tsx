import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Upload, CheckCircle2, FileText, ArrowRight, ArrowLeft } from "lucide-react";

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

export function GuidedIntakeWizard({ userId, onComplete, onCancel }: Props) {
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [claimId, setClaimId] = useState<string | null>(null);
  const { toast } = useToast();

  // Step 1: Claim info
  const [carrier, setCarrier] = useState("");
  const [claimNumber, setClaimNumber] = useState("");
  const [adjusterName, setAdjusterName] = useState("");
  const [adjusterEmail, setAdjusterEmail] = useState("");
  const [lossDate, setLossDate] = useState("");
  const [propertyAddress, setPropertyAddress] = useState("");
  const [lossType, setLossType] = useState("");
  const [claimStatus, setClaimStatus] = useState("");

  // Step 2: Uploads
  const [uploadedDocs, setUploadedDocs] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState<string | null>(null);

  const handleCreateClaim = async () => {
    if (!carrier || !claimNumber) {
      toast({ title: "Required fields", description: "Please fill in carrier and claim number.", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      // Create the claim
      const { data: claim, error } = await supabase
        .from("claims")
        .insert({
          carrier,
          claim_number: claimNumber,
          loss_date: lossDate || null,
          property_address: propertyAddress || null,
          loss_type: lossType || null,
          status: claimStatus || "New",
          is_guided_mode: true,
          policyholder_name: "", // Will be filled from profile
        })
        .select()
        .single();

      if (error) throw error;

      // Link user to claim
      await supabase.from("guided_claim_access").insert({
        user_id: userId,
        claim_id: claim.id,
        relationship: "policyholder",
      });

      // Add adjuster if provided
      if (adjusterName) {
        await supabase.from("claim_adjusters").insert({
          claim_id: claim.id,
          adjuster_name: adjusterName,
          adjuster_email: adjusterEmail || null,
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
              <div className="space-y-2">
                <Label>Carrier *</Label>
                <Input value={carrier} onChange={e => setCarrier(e.target.value)} placeholder="e.g. State Farm" />
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
                <Label>Date of Loss</Label>
                <Input type="date" value={lossDate} onChange={e => setLossDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Property Address</Label>
                <Input value={propertyAddress} onChange={e => setPropertyAddress(e.target.value)} placeholder="123 Main St, City, State" />
              </div>
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
