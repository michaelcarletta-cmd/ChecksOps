import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { formatPhoneNumber } from "@/lib/utils";
import { Plus } from "lucide-react";

interface EditClaimDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  claim: any;
  onClaimUpdated: (updatedClaim: any) => void;
}

export function EditClaimDialog({ open, onOpenChange, claim, onClaimUpdated }: EditClaimDialogProps) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [lossTypes, setLossTypes] = useState<any[]>([]);
  const [insuranceCompanies, setInsuranceCompanies] = useState<any[]>([]);
  const [addInsuranceOpen, setAddInsuranceOpen] = useState(false);
  const [newInsuranceName, setNewInsuranceName] = useState("");
  const [formData, setFormData] = useState({
    claim_number: claim?.claim_number || "",
    policyholder_name: claim?.policyholder_name || "",
    policyholder_email: claim?.policyholder_email || "",
    policyholder_phone: claim?.policyholder_phone || "",
    policyholder_address: claim?.policyholder_address || "",
    policy_number: claim?.policy_number || "",
    loss_date: claim?.loss_date || "",
    date_claim_filed: claim?.date_claim_filed || "",
    loss_type: claim?.loss_type || "",
    loss_type_id: claim?.loss_type_id || "",
    loss_description: claim?.loss_description || "",
    insurance_company: claim?.insurance_company || "",
    insurance_company_id: claim?.insurance_company_id || "",
    insurance_phone: claim?.insurance_phone || "",
    insurance_email: claim?.insurance_email || "",
    claim_amount: claim?.claim_amount || "",
    status: claim?.status || "open",
    loan_number: claim?.loan_number || "",
    ssn_last_four: claim?.ssn_last_four || "",
  });

  useEffect(() => {
    if (claim) {
      setFormData({
        claim_number: claim.claim_number || "",
        policyholder_name: claim.policyholder_name || "",
        policyholder_email: claim.policyholder_email || "",
        policyholder_phone: claim.policyholder_phone || "",
        policyholder_address: claim.policyholder_address || "",
        policy_number: claim.policy_number || "",
        loss_date: claim.loss_date || "",
        loss_type: claim.loss_type || "",
        loss_type_id: claim.loss_type_id || "",
        loss_description: claim.loss_description || "",
        insurance_company: claim.insurance_company || "",
        insurance_company_id: claim.insurance_company_id || "",
        insurance_phone: claim.insurance_phone || "",
        insurance_email: claim.insurance_email || "",
        claim_amount: claim.claim_amount || "",
        status: claim.status || "open",
        loan_number: claim.loan_number || "",
        ssn_last_four: claim.ssn_last_four || "",
      });
    }
  }, [claim]);

  useEffect(() => {
    if (open) {
      fetchDropdownData();
    }
  }, [open]);

  const fetchDropdownData = async () => {
    const { data: lossTypesData } = await supabase
      .from("loss_types")
      .select("*")
      .eq("is_active", true)
      .order("name");

    const { data: insuranceCompaniesData } = await supabase
      .from("insurance_companies")
      .select("id, name, phone, email, is_active, created_at, updated_at")
      .eq("is_active", true)
      .order("name");

    setLossTypes(lossTypesData || []);
    setInsuranceCompanies(insuranceCompaniesData || []);
    
    // Update insurance phone/email if company is already selected
    if (formData.insurance_company_id && insuranceCompaniesData) {
      const selectedCompany = insuranceCompaniesData.find((ic) => ic.id === formData.insurance_company_id);
      if (selectedCompany) {
        setFormData((prev) => ({
          ...prev,
          insurance_phone: selectedCompany.phone || "",
          insurance_email: selectedCompany.email || "",
        }));
      }
    }
  };

  const handleChange = (field: string, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleLossTypeChange = (lossTypeId: string) => {
    const selectedLossType = lossTypes.find((lt) => lt.id === lossTypeId);
    setFormData((prev) => ({
      ...prev,
      loss_type_id: lossTypeId,
      loss_type: selectedLossType?.name || "",
    }));
  };

  const handleInsuranceCompanyChange = (insuranceCompanyId: string) => {
    const selectedCompany = insuranceCompanies.find((ic) => ic.id === insuranceCompanyId);
    setFormData((prev) => ({
      ...prev,
      insurance_company_id: insuranceCompanyId,
      insurance_company: selectedCompany?.name || "",
      insurance_phone: selectedCompany?.phone || "",
      insurance_email: selectedCompany?.email || "",
    }));
  };

  const handleAddInsuranceCompany = async () => {
    if (!newInsuranceName.trim()) return;
    
    try {
      const { data, error } = await supabase
        .from("insurance_companies")
        .insert({ name: newInsuranceName.trim() })
        .select()
        .single();
      
      if (error) throw error;
      
      setInsuranceCompanies([...insuranceCompanies, data]);
      handleInsuranceCompanyChange(data.id);
      setNewInsuranceName("");
      setAddInsuranceOpen(false);
      toast.success("Insurance company added");
    } catch (error: any) {
      toast.error(error.message || "Failed to add insurance company");
    }
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const updateData: any = { ...formData };
      const oldStatus = claim?.status;
      const newStatus = formData.status;
      
      // Ensure insurance_company name is set if insurance_company_id is selected
      if (formData.insurance_company_id && !formData.insurance_company) {
        const selectedCompany = insuranceCompanies.find((ic) => ic.id === formData.insurance_company_id);
        if (selectedCompany) {
          updateData.insurance_company = selectedCompany.name;
        }
      }
      
      // Ensure loss_type name is set if loss_type_id is selected
      if (formData.loss_type_id && !formData.loss_type) {
        const selectedLossType = lossTypes.find((lt) => lt.id === formData.loss_type_id);
        if (selectedLossType) {
          updateData.loss_type = selectedLossType.name;
        }
      }
      
      // Convert empty strings to null for optional fields
      Object.keys(updateData).forEach(key => {
        if (updateData[key] === "") {
          updateData[key] = null;
        }
      });
      
      // Parse claim amount if present
      if (formData.claim_amount && formData.claim_amount !== "") {
        updateData.claim_amount = parseFloat(formData.claim_amount);
      } else {
        updateData.claim_amount = null;
      }
      const { data, error } = await supabase
        .from("claims")
        .update(updateData)
        .eq("id", claim.id)
        .select("*, client_id")
        .single();

      if (error) throw error;

      // Sync client email if policyholder_email changed and claim has a linked client
      if (data.client_id && formData.policyholder_email && formData.policyholder_email !== claim.policyholder_email) {
        await supabase
          .from("clients")
          .update({ 
            email: formData.policyholder_email,
            name: formData.policyholder_name || undefined,
            phone: formData.policyholder_phone || undefined,
          })
          .eq("id", data.client_id);
      }

      // Trigger client notification if status changed
      if (oldStatus !== newStatus && newStatus) {
        supabase.functions.invoke("notify-client-claim-update", {
          body: {
            claimId: claim.id,
            changeType: "status_change",
            oldValue: oldStatus,
            newValue: newStatus,
          },
        }).catch((err) => {
          console.log("Client notification failed (may be disabled):", err);
        });
      }

      toast.success("Claim updated successfully");
      onClaimUpdated(data);
      queryClient.invalidateQueries({ queryKey: ["claims"] });
      onOpenChange(false);
    } catch (error: any) {
      toast.error(error.message || "Failed to update claim");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Claim</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-6">
          {/* Claim Information */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">Claim Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="claim_number">Claim Number</Label>
                <Input
                  id="claim_number"
                  value={formData.claim_number}
                  onChange={(e) => handleChange("claim_number", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="policy_number">Policy Number</Label>
                <Input
                  id="policy_number"
                  value={formData.policy_number}
                  onChange={(e) => handleChange("policy_number", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="claim_amount">Claim Amount</Label>
                <Input
                  id="claim_amount"
                  type="number"
                  value={formData.claim_amount}
                  onChange={(e) => handleChange("claim_amount", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="status">Status</Label>
                <Input
                  id="status"
                  value={formData.status}
                  onChange={(e) => handleChange("status", e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Policyholder Information */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">Policyholder Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="policyholder_name">Name</Label>
                <Input
                  id="policyholder_name"
                  value={formData.policyholder_name}
                  onChange={(e) => handleChange("policyholder_name", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="policyholder_email">Email</Label>
                <Input
                  id="policyholder_email"
                  type="email"
                  value={formData.policyholder_email}
                  onChange={(e) => handleChange("policyholder_email", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="policyholder_phone">Phone</Label>
                <Input
                  id="policyholder_phone"
                  type="tel"
                  value={formData.policyholder_phone}
                  onChange={(e) => handleChange("policyholder_phone", formatPhoneNumber(e.target.value))}
                  placeholder="123-456-7890"
                />
              </div>
              <div className="col-span-2">
                <Label htmlFor="policyholder_address">Address</Label>
                <Input
                  id="policyholder_address"
                  value={formData.policyholder_address}
                  onChange={(e) => handleChange("policyholder_address", e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Loss Information */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">Loss Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="loss_date">Date of Loss</Label>
                <Input
                  id="loss_date"
                  type="date"
                  value={formData.loss_date}
                  onChange={(e) => handleChange("loss_date", e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="loss_type">Type of Loss</Label>
                <Select value={formData.loss_type_id} onValueChange={handleLossTypeChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select loss type" />
                  </SelectTrigger>
                  <SelectContent>
                    {lossTypes.map((lt) => (
                      <SelectItem key={lt.id} value={lt.id}>
                        {lt.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label htmlFor="loss_description">Loss Description</Label>
                <Textarea
                  id="loss_description"
                  value={formData.loss_description}
                  onChange={(e) => handleChange("loss_description", e.target.value)}
                  rows={3}
                />
              </div>
            </div>
          </div>

          {/* Insurance Company Information */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">Insurance Company Information</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="insurance_company">Company Name</Label>
                {addInsuranceOpen ? (
                  <div className="flex gap-2">
                    <Input
                      placeholder="New insurance company name"
                      value={newInsuranceName}
                      onChange={(e) => setNewInsuranceName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAddInsuranceCompany()}
                    />
                    <Button type="button" size="sm" onClick={handleAddInsuranceCompany}>Add</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setAddInsuranceOpen(false)}>Cancel</Button>
                  </div>
                ) : (
                  <Select 
                    value={formData.insurance_company_id} 
                    onValueChange={(value) => {
                      if (value === "__add_new__") {
                        setAddInsuranceOpen(true);
                      } else {
                        handleInsuranceCompanyChange(value);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select insurance company" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__add_new__" className="text-primary font-medium">
                        <span className="flex items-center gap-1"><Plus className="h-4 w-4" /> Add New Insurance Company</span>
                      </SelectItem>
                      {insuranceCompanies.map((ic) => (
                        <SelectItem key={ic.id} value={ic.id}>
                          {ic.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div>
                <Label htmlFor="insurance_phone">Phone</Label>
                <Input
                  id="insurance_phone"
                  type="tel"
                  value={formData.insurance_phone}
                  onChange={(e) => handleChange("insurance_phone", formatPhoneNumber(e.target.value))}
                  placeholder="123-456-7890"
                />
              </div>
              <div>
                <Label htmlFor="insurance_email">Email</Label>
                <Input
                  id="insurance_email"
                  type="email"
                  value={formData.insurance_email}
                  onChange={(e) => handleChange("insurance_email", e.target.value)}
                />
              </div>
            </div>
          </div>


          {/* Mortgage Company Details */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold">Mortgage Company Details</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="loan_number">Loan Number</Label>
                <Input
                  id="loan_number"
                  value={formData.loan_number}
                  onChange={(e) => handleChange("loan_number", e.target.value)}
                  placeholder="Enter loan number"
                />
              </div>
              <div>
                <Label htmlFor="ssn_last_four">SSN Last Four</Label>
                <Input
                  id="ssn_last_four"
                  value={formData.ssn_last_four}
                  onChange={(e) => handleChange("ssn_last_four", e.target.value)}
                  placeholder="Enter last 4 digits"
                  maxLength={4}
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={loading}>
            {loading ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
