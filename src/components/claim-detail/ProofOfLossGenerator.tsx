import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { Separator } from "@/components/ui/separator";
import { FileText, Loader2, Download, Sparkles, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format } from "date-fns";

interface ProofOfLossGeneratorProps {
  claimId: string;
  claim: any;
}

interface POLData {
  insured_name: string;
  insured_phone: string;
  insured_email: string;
  policy_number: string;
  claim_number: string;
  date_of_loss: string;
  property_address: string;
  insurance_company: string;
  insurance_phone: string;
  insurance_email: string;
  adjuster_name: string;
  adjuster_phone: string;
  adjuster_email: string;
  loss_type: string;
  loss_description: string;
  building_damage: string;
  contents_damage: string;
  additional_living_expense: string;
  total_claimed: string;
  ai_summary: string;
  ai_damage_narrative: string;
}

export const ProofOfLossGenerator = ({ claimId, claim }: ProofOfLossGeneratorProps) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [polData, setPolData] = useState<POLData | null>(null);

  const initializePOLData = async () => {
    setLoading(true);
    try {
      // Fetch settlement data if exists
      const { data: settlement } = await supabase
        .from("claim_settlements")
        .select("*")
        .eq("claim_id", claimId)
        .maybeSingle();

      // Initialize form with claim data - fix timezone issue
      const initialData: POLData = {
        insured_name: claim.policyholder_name || "",
        insured_phone: claim.policyholder_phone || "",
        insured_email: claim.policyholder_email || "",
        policy_number: claim.policy_number || "",
        claim_number: claim.claim_number || "",
        date_of_loss: claim.loss_date ? format(new Date(claim.loss_date + 'T12:00:00'), "MMMM d, yyyy") : "",
        property_address: claim.policyholder_address || "",
        insurance_company: claim.insurance_company || "",
        insurance_phone: claim.insurance_phone || "",
        insurance_email: claim.insurance_email || "",
        adjuster_name: claim.adjuster_name || "",
        adjuster_phone: claim.adjuster_phone || "",
        adjuster_email: claim.adjuster_email || "",
        loss_type: claim.loss_type || "",
        loss_description: claim.loss_description || "",
        building_damage: settlement?.replacement_cost_value?.toString() || "",
        contents_damage: "",
        additional_living_expense: "",
        total_claimed: settlement?.total_settlement?.toString() || "",
        ai_summary: "",
        ai_damage_narrative: "",
      };

      setPolData(initialData);
    } catch (error) {
      console.error("Error initializing POL data:", error);
      toast.error("Failed to load claim data");
    } finally {
      setLoading(false);
    }
  };

  const generateAINarrative = async () => {
    if (!polData) return;
    
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("claims-ai-assistant", {
        body: {
          question: `Generate a professional Proof of Loss damage narrative for this claim. Include:
1. A detailed description of the loss event
2. Specific damages observed
3. Areas/items affected
4. Cause and extent of damage

Claim Details:
- Loss Type: ${polData.loss_type}
- Loss Date: ${polData.date_of_loss}
- Property: ${polData.property_address}
- Description: ${polData.loss_description}
- Building Damage Amount: $${polData.building_damage || "TBD"}

Write in professional insurance claim language suitable for a Proof of Loss form. Be specific and factual.`,
          mode: "general",
          messages: [],
        },
      });

      if (error) throw error;

      setPolData({
        ...polData,
        ai_damage_narrative: data.answer,
        ai_summary: `Proof of Loss for ${polData.loss_type} damage at ${polData.property_address} on ${polData.date_of_loss}.`,
      });

      toast.success("AI narrative generated");
    } catch (error: any) {
      console.error("Error generating narrative:", error);
      toast.error(error.message || "Failed to generate AI narrative");
    } finally {
      setGenerating(false);
    }
  };

  const downloadPOL = async () => {
    if (!polData) return;

    setDownloading(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-pol-docx", {
        body: {
          polData,
          claimId,
        },
      });

      if (error) throw error;

      if (data?.downloadUrl) {
        window.open(data.downloadUrl, "_blank");
        toast.success("Proof of Loss saved to claim files");
      }
    } catch (error: any) {
      console.error("Error generating POL document:", error);
      toast.error(error.message || "Failed to generate POL document");
    } finally {
      setDownloading(false);
    }
  };

  const updateField = (field: keyof POLData, value: string) => {
    if (!polData) return;
    setPolData({ ...polData, [field]: value });
  };

  const calculateTotal = () => {
    if (!polData) return;
    const building = parseFloat(polData.building_damage) || 0;
    const contents = parseFloat(polData.contents_damage) || 0;
    const ale = parseFloat(polData.additional_living_expense) || 0;
    setPolData({ ...polData, total_claimed: (building + contents + ale).toFixed(2) });
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen);
      if (isOpen && !polData) {
        initializePOLData();
      }
    }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <FileText className="h-4 w-4" />
          Generate POL
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl h-[85vh] flex flex-col">
        <DialogHeader className="flex-shrink-0 pb-4">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            Proof of Loss Generator
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : polData ? (
          <div className="flex-1 overflow-y-auto pr-4">
            <div className="space-y-6">
              {/* Insured Information */}
              <Card className="p-4 space-y-4">
                <h3 className="font-semibold">Insured Information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Insured Name</Label>
                    <Input
                      value={polData.insured_name}
                      onChange={(e) => updateField("insured_name", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Insured Phone</Label>
                    <Input
                      value={polData.insured_phone}
                      onChange={(e) => updateField("insured_phone", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Insured Email</Label>
                    <Input
                      value={polData.insured_email}
                      onChange={(e) => updateField("insured_email", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Property Address</Label>
                    <Input
                      value={polData.property_address}
                      onChange={(e) => updateField("property_address", e.target.value)}
                    />
                  </div>
                </div>
              </Card>

              {/* Policy & Claim Information */}
              <Card className="p-4 space-y-4">
                <h3 className="font-semibold">Policy & Claim Information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Policy Number</Label>
                    <Input
                      value={polData.policy_number}
                      onChange={(e) => updateField("policy_number", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Claim Number</Label>
                    <Input
                      value={polData.claim_number}
                      onChange={(e) => updateField("claim_number", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Insurance Company</Label>
                    <Input
                      value={polData.insurance_company}
                      onChange={(e) => updateField("insurance_company", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Insurance Phone</Label>
                    <Input
                      value={polData.insurance_phone}
                      onChange={(e) => updateField("insurance_phone", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Insurance Email</Label>
                    <Input
                      value={polData.insurance_email}
                      onChange={(e) => updateField("insurance_email", e.target.value)}
                    />
                  </div>
                </div>
              </Card>

              {/* Adjuster Information */}
              <Card className="p-4 space-y-4">
                <h3 className="font-semibold">Adjuster Information</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <Label>Adjuster Name</Label>
                    <Input
                      value={polData.adjuster_name}
                      onChange={(e) => updateField("adjuster_name", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Adjuster Phone</Label>
                    <Input
                      value={polData.adjuster_phone}
                      onChange={(e) => updateField("adjuster_phone", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Adjuster Email</Label>
                    <Input
                      value={polData.adjuster_email}
                      onChange={(e) => updateField("adjuster_email", e.target.value)}
                    />
                  </div>
                </div>
              </Card>

              {/* Loss Information */}
              <Card className="p-4 space-y-4">
                <h3 className="font-semibold">Loss Information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Date of Loss</Label>
                    <Input
                      value={polData.date_of_loss}
                      onChange={(e) => updateField("date_of_loss", e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Type of Loss</Label>
                    <Input
                      value={polData.loss_type}
                      onChange={(e) => updateField("loss_type", e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <Label>Loss Description</Label>
                  <Textarea
                    value={polData.loss_description}
                    onChange={(e) => updateField("loss_description", e.target.value)}
                    rows={3}
                  />
                </div>
              </Card>

              {/* AI Damage Narrative */}
              <Card className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">AI Damage Narrative</h3>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generateAINarrative}
                    disabled={generating}
                    className="gap-2"
                  >
                    {generating ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                    {polData.ai_damage_narrative ? "Regenerate" : "Generate"} with AI
                  </Button>
                </div>
                <Textarea
                  value={polData.ai_damage_narrative}
                  onChange={(e) => updateField("ai_damage_narrative", e.target.value)}
                  placeholder="Click 'Generate with AI' to create a professional damage narrative, or write your own..."
                  rows={6}
                />
              </Card>

              {/* Claimed Amounts */}
              <Card className="p-4 space-y-4">
                <h3 className="font-semibold">Claimed Amounts</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <Label>Building Damage ($)</Label>
                    <Input
                      type="number"
                      value={polData.building_damage}
                      onChange={(e) => updateField("building_damage", e.target.value)}
                      onBlur={calculateTotal}
                    />
                  </div>
                  <div>
                    <Label>Contents Damage ($)</Label>
                    <Input
                      type="number"
                      value={polData.contents_damage}
                      onChange={(e) => updateField("contents_damage", e.target.value)}
                      onBlur={calculateTotal}
                    />
                  </div>
                  <div>
                    <Label>Additional Living Expense ($)</Label>
                    <Input
                      type="number"
                      value={polData.additional_living_expense}
                      onChange={(e) => updateField("additional_living_expense", e.target.value)}
                      onBlur={calculateTotal}
                    />
                  </div>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Total Amount Claimed</Label>
                    <div className="text-2xl font-bold text-primary">
                      ${parseFloat(polData.total_claimed || "0").toLocaleString("en-US", { minimumFractionDigits: 2 })}
                    </div>
                  </div>
                  <Button onClick={calculateTotal} variant="ghost" size="sm">
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Recalculate
                  </Button>
                </div>
              </Card>

              {/* Actions */}
              <div className="flex justify-end gap-2 pb-4">
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={downloadPOL} disabled={downloading} className="gap-2">
                  {downloading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Download POL (.docx)
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
