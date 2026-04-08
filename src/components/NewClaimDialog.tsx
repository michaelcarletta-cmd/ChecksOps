import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Plus, Upload, Loader2, FileText, Sparkles, Check, X, Users } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { formatPhoneNumber, cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface TeamMemberOption {
  id: string;
  full_name: string | null;
  email: string;
}

interface InsuranceCompany {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
}

interface LossType {
  id: string;
  name: string;
}

interface Contractor {
  id: string;
  full_name: string | null;
  email: string;
}

interface Client {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  policy_number: string | null;
}

interface MortgageCompany {
  id: string;
  name: string;
}

interface Workspace {
  id: string;
  name: string;
}

export function NewClaimDialog() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [insuranceCompanies, setInsuranceCompanies] = useState<InsuranceCompany[]>([]);
  const [lossTypes, setLossTypes] = useState<LossType[]>([]);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [mortgageCompanies, setMortgageCompanies] = useState<MortgageCompany[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string>("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [addInsuranceOpen, setAddInsuranceOpen] = useState(false);
  const [addMortgageOpen, setAddMortgageOpen] = useState(false);
  const [newInsuranceName, setNewInsuranceName] = useState("");
  const [newMortgageName, setNewMortgageName] = useState("");
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractedFileName, setExtractedFileName] = useState<string | null>(null);
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    // Client Information
    policyholderName: "",
    policyholderPhone: "",
    policyholderEmail: "",
    policyholderStreet: "",
    policyholderCity: "",
    policyholderState: "",
    policyholderZip: "",
    
    // Claim Information
    claimNumber: "",
    policyNumber: "",
    insuranceCompanyId: "",
    insurancePhone: "",
    insuranceEmail: "",
    lossTypeId: "",
    lossDate: "",
    lossDescription: "",
    contractorId: "",
    mortgageCompanyId: "",
  });

  useEffect(() => {
    if (open) {
      fetchDropdownData();
    }
  }, [open]);

  const fetchDropdownData = async () => {
    try {
      const [insuranceRes, lossTypesRes, clientsRes, mortgageRes] = await Promise.all([
        supabase.from("insurance_companies").select("id, name, phone, email").eq("is_active", true).order("name"),
        supabase.from("loss_types").select("id, name").eq("is_active", true).order("name"),
        supabase.from("clients").select("id, name, email, phone, street, city, state, zip_code, policy_number").order("name"),
        supabase.from("mortgage_companies").select("id, name").eq("is_active", true).order("name"),
      ]);

      if (insuranceRes.error) throw insuranceRes.error;
      if (lossTypesRes.error) throw lossTypesRes.error;
      if (clientsRes.error) throw clientsRes.error;
      if (mortgageRes.error) throw mortgageRes.error;

      setInsuranceCompanies(insuranceRes.data || []);
      setLossTypes(lossTypesRes.data || []);
      setClients(clientsRes.data || []);
      setMortgageCompanies(mortgageRes.data || []);
      
      // Fetch contractors (users with contractor role)
      const { data: roleData } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "contractor");
      
      if (roleData && roleData.length > 0) {
        const contractorIds = roleData.map(r => r.user_id);
        const { data: profiles } = await supabase
          .from("profiles")
          .select("id, full_name, email")
          .in("id", contractorIds)
          .order("full_name");
        
        setContractors(profiles || []);
      }
      
      // Fetch workspaces user has access to
      const { data: userData } = await supabase.auth.getUser();
      if (userData?.user) {
        const { data: orgMember } = await supabase
          .from("org_members")
          .select("org_id")
          .eq("user_id", userData.user.id)
          .single();
        
        if (orgMember) {
          const { data: workspaceMembers } = await supabase
            .from("workspace_members")
            .select("workspace_id, workspaces(id, name)")
            .eq("org_id", orgMember.org_id)
            .eq("status", "active");
          
          if (workspaceMembers) {
            const ws = workspaceMembers
              .filter((wm: any) => wm.workspaces)
              .map((wm: any) => ({ id: wm.workspaces.id, name: wm.workspaces.name }));
            setWorkspaces(ws);
          }
        }
      }
    } catch (error: any) {
      console.error("Error fetching dropdown data:", error);
      toast({
        title: "Error",
        description: "Failed to load form data",
        variant: "destructive",
      });
    }
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
      setFormData({ ...formData, insuranceCompanyId: data.id });
      setNewInsuranceName("");
      setAddInsuranceOpen(false);
      toast({ title: "Insurance company added" });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleAddMortgageCompany = async () => {
    if (!newMortgageName.trim()) return;
    
    try {
      const { data, error } = await supabase
        .from("mortgage_companies")
        .insert({ name: newMortgageName.trim() })
        .select()
        .single();
      
      if (error) throw error;
      
      setMortgageCompanies([...mortgageCompanies, data]);
      setFormData({ ...formData, mortgageCompanyId: data.id });
      setNewMortgageName("");
      setAddMortgageOpen(false);
      toast({ title: "Mortgage company added" });
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleInsuranceCompanyChange = (companyId: string) => {
    const selectedCompany = insuranceCompanies.find((c) => c.id === companyId);
    setFormData({
      ...formData,
      insuranceCompanyId: companyId,
      insurancePhone: selectedCompany?.phone || "",
      insuranceEmail: selectedCompany?.email || "",
    });
  };

  const handleClientChange = (clientId: string) => {
    setSelectedClientId(clientId);
    if (clientId === "new") {
      // Clear fields for new client
      setFormData({
        ...formData,
        policyholderName: "",
        policyholderPhone: "",
        policyholderEmail: "",
        policyholderStreet: "",
        policyholderCity: "",
        policyholderState: "",
        policyholderZip: "",
      });
    } else {
      // Populate fields from selected client
      const selectedClient = clients.find((c) => c.id === clientId);
      if (selectedClient) {
        setFormData({
          ...formData,
          policyholderName: selectedClient.name,
          policyholderPhone: selectedClient.phone || "",
          policyholderEmail: selectedClient.email || "",
          policyholderStreet: selectedClient.street || "",
          policyholderCity: selectedClient.city || "",
          policyholderState: selectedClient.state || "",
          policyholderZip: selectedClient.zip_code || "",
          policyNumber: selectedClient.policy_number || "",
        });
      }
    }
  };

  const parseAddress = (address: string) => {
    // Try to parse "123 Main St, City, ST 12345" or similar patterns
    const parts = address.split(",").map(p => p.trim());
    if (parts.length >= 3) {
      const street = parts[0];
      const city = parts[1];
      const stateZip = parts[parts.length - 1].trim();
      const stateZipMatch = stateZip.match(/^([A-Z]{2})\s*(\d{5}(-\d{4})?)?$/);
      if (stateZipMatch) {
        return { street, city, state: stateZipMatch[1], zip: stateZipMatch[2] || "" };
      }
      // Try state without zip
      const stateOnly = stateZip.match(/^([A-Z]{2})$/);
      if (stateOnly) {
        return { street, city, state: stateOnly[1], zip: "" };
      }
      return { street, city, state: stateZip, zip: "" };
    }
    if (parts.length === 2) {
      return { street: parts[0], city: parts[1], state: "", zip: "" };
    }
    return { street: address, city: "", state: "", zip: "" };
  };

  const handleDocumentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 20 * 1024 * 1024) {
      toast({ title: "Error", description: "File must be under 20MB", variant: "destructive" });
      return;
    }

    setExtracting(true);
    try {
      const formDataUpload = new FormData();
      formDataUpload.append("file", file);

      const { data: { session } } = await supabase.auth.getSession();
      
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/extract-claim-info`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
          },
          body: formDataUpload,
        }
      );

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "Extraction failed");
      }

      const result = await response.json();
      const ext = result.extracted || {};

      // Auto-populate form fields from extracted data
      const updates: any = { ...formData };
      
      if (ext.policyholder_name) updates.policyholderName = ext.policyholder_name;
      if (ext.claim_number) updates.claimNumber = ext.claim_number;
      if (ext.policy_number) updates.policyNumber = ext.policy_number;
      if (ext.loss_date) updates.lossDate = ext.loss_date;
      if (ext.loss_description) updates.lossDescription = ext.loss_description;

      if (ext.street_address) updates.policyholderStreet = ext.street_address;
      if (ext.city) updates.policyholderCity = ext.city;
      if (ext.state) updates.policyholderState = ext.state;
      if (ext.zip_code) updates.policyholderZip = ext.zip_code;

      // Fallback: if old-style property_address is returned, parse it
      if (ext.property_address && !ext.street_address) {
        const parsed = parseAddress(ext.property_address);
        updates.policyholderStreet = parsed.street;
        updates.policyholderCity = parsed.city;
        updates.policyholderState = parsed.state;
        updates.policyholderZip = parsed.zip;
      }

      // Try to match insurance company (fuzzy)
      if (ext.insurance_company) {
        const extName = ext.insurance_company.toLowerCase();
        const match = insuranceCompanies.find(c => {
          const dbName = c.name.toLowerCase();
          return dbName === extName || dbName.includes(extName) || extName.includes(dbName);
        });
        if (match) {
          updates.insuranceCompanyId = match.id;
          updates.insurancePhone = match.phone || "";
          updates.insuranceEmail = match.email || "";
        } else {
          // No match found - notify user
          console.log(`Insurance company "${ext.insurance_company}" not found in database`);
        }
      }

      // Try to match loss type
      if (ext.loss_type) {
        const lossTypeNorm = ext.loss_type.toLowerCase();
        const match = lossTypes.find(
          lt => lt.name.toLowerCase().includes(lossTypeNorm) || lossTypeNorm.includes(lt.name.toLowerCase())
        );
        if (match) {
          updates.lossTypeId = match.id;
        }
      }

      setFormData(updates);
      setExtractedFileName(file.name);
      setSelectedClientId("new");

      const fieldsFound = Object.keys(ext).length;
      toast({
        title: "Document Analyzed",
        description: `Extracted ${fieldsFound} field${fieldsFound !== 1 ? 's' : ''} from ${file.name}`,
      });
    } catch (error: any) {
      console.error("Extraction error:", error);
      toast({
        title: "Extraction Failed",
        description: error.message || "Could not extract claim info from document",
        variant: "destructive",
      });
    } finally {
      setExtracting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Determine client_id
      let clientId = null;
      
      if (selectedClientId && selectedClientId !== "new") {
        // Use existing client
        clientId = selectedClientId;
      } else {
        // Create new client or find by email
        if (formData.policyholderEmail) {
          const { data: existingClient } = await supabase
            .from("clients")
            .select("id")
            .eq("email", formData.policyholderEmail)
            .maybeSingle();
          
          if (existingClient) {
            clientId = existingClient.id;
          }
        }
        
        // If still no client, create a new one (without user account - use "Create Portal Access" for that)
        if (!clientId && formData.policyholderName) {
          const { data: newClient, error: clientError } = await supabase
            .from("clients")
            .insert({
              name: formData.policyholderName,
              email: formData.policyholderEmail || null,
              phone: formData.policyholderPhone || null,
              street: formData.policyholderStreet || null,
              city: formData.policyholderCity || null,
              state: formData.policyholderState || null,
              zip_code: formData.policyholderZip || null,
            })
            .select()
            .single();

          if (clientError) throw clientError;
          clientId = newClient.id;
        }
      }

      // Build policyholder address from separate fields
      const addressParts = [
        formData.policyholderStreet,
        formData.policyholderCity,
        formData.policyholderState,
        formData.policyholderZip,
      ].filter(Boolean);
      const fullAddress = addressParts.length > 0 ? addressParts.join(", ") : null;

      // Now create the claim via a backend helper function that enforces roles
      const { data, error } = await supabase
        .rpc("create_claim_for_staff", {
          p_claim_number: formData.claimNumber || null,
          p_policy_number: formData.policyNumber || null,
          p_policyholder_name: formData.policyholderName || null,
          p_policyholder_phone: formData.policyholderPhone || null,
          p_policyholder_email: formData.policyholderEmail || null,
          p_policyholder_address: fullAddress,
          p_insurance_company_id: formData.insuranceCompanyId || null,
          p_insurance_phone: formData.insurancePhone || null,
          p_insurance_email: formData.insuranceEmail || null,
          p_loss_type_id: formData.lossTypeId || null,
          p_loss_date: formData.lossDate || null,
          p_loss_description: formData.lossDescription || null,
          p_referrer_id: null,
          p_client_id: clientId,
          p_mortgage_company_id: formData.mortgageCompanyId || null,
        })
        .single();

      if (error) throw error;

      const claim = data as { id: string } | null;

      // Auto-assign staff member who created the claim
      if (claim?.id) {
        const { data: userData } = await supabase.auth.getUser();
        const user = userData?.user;
        if (user) {
          const { data: roles } = await supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", user.id);
          
          const isStaff = roles?.some(r => r.role === "staff");
          
          // Assign the staff member to the claim they just created
          if (isStaff) {
            await supabase
              .from("claim_staff")
              .insert({ claim_id: claim.id, staff_id: user.id });
          }
        }
      }

      // Auto-create Darwin automation with passive scope + semi-autonomous level
      if (claim?.id) {
        await Promise.all([
          supabase
            .from("claims")
            .update({ automation_mode: "passive" })
            .eq("id", claim.id),
          supabase
            .from("claim_automations")
            .insert([{
              claim_id: claim.id,
              is_enabled: true,
              autonomy_level: "semi_autonomous",
              settings: {
                auto_respond_emails: true,
                auto_update_notes: true,
                auto_send_sms: false,
                notify_client_on_updates: false,
              } as any,
            }]),
        ]);
      }

      // Assign contractor if selected
      if (claim?.id && formData.contractorId) {
        await supabase
          .from("claim_contractors")
          .insert({ claim_id: claim.id, contractor_id: formData.contractorId });
      }

      // Share to workspace if selected
      if (claim?.id && selectedWorkspaceId) {
        await supabase
          .from("claims")
          .update({ workspace_id: selectedWorkspaceId })
          .eq("id", claim.id);
      }

      toast({
        title: "Success",
        description: selectedWorkspaceId ? "Claim created and shared to workspace" : "Claim created successfully",
      });

      setOpen(false);
      setSelectedClientId("");
      setSelectedWorkspaceId("");
      setFormData({
        policyholderName: "",
        policyholderPhone: "",
        policyholderEmail: "",
        policyholderStreet: "",
        policyholderCity: "",
        policyholderState: "",
        policyholderZip: "",
        claimNumber: "",
        policyNumber: "",
        insuranceCompanyId: "",
        insurancePhone: "",
        insuranceEmail: "",
        lossTypeId: "",
        lossDate: "",
        lossDescription: "",
        contractorId: "",
        mortgageCompanyId: "",
      });

      // Navigate to the new claim
      if (claim?.id) {
        navigate(`/claims/${claim.id}`);
      }
    } catch (error: any) {
      console.error("Error creating claim:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to create claim",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-primary hover:bg-primary/90">
          <Plus className="h-4 w-4 mr-2" />
          New Claim
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl">Create New Claim</DialogTitle>
        </DialogHeader>

        {/* Document Upload for Auto-Extract */}
        <div className="border-2 border-dashed border-primary/30 rounded-lg p-4 bg-primary/5 hover:border-primary/50 transition-colors">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.doc,.docx,.txt,.csv,.xls,.xlsx"
            onChange={handleDocumentUpload}
          />
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              {extracting ? (
                <Loader2 className="h-5 w-5 text-primary animate-spin" />
              ) : (
                <Sparkles className="h-5 w-5 text-primary" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">
                {extracting ? "Analyzing document..." : "Upload estimate or carrier letter"}
              </p>
              <p className="text-xs text-muted-foreground">
                {extractedFileName 
                  ? <>Extracted from: <Badge variant="secondary" className="text-xs ml-1"><FileText className="h-3 w-3 mr-1" />{extractedFileName}</Badge></>
                  : "Darwin will auto-extract client info, claim number, loss type & more"
                }
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={extracting}
            >
              <Upload className="h-4 w-4 mr-1" />
              {extractedFileName ? "Re-upload" : "Upload"}
            </Button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Client Information Section */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-foreground border-b border-border pb-2">
              Client Information
            </h3>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="clientSelect">Select Existing Client (Optional)</Label>
                <Select value={selectedClientId} onValueChange={handleClientChange}>
                  <SelectTrigger id="clientSelect">
                    <SelectValue placeholder="Select a client or create new" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">Create New Client</SelectItem>
                    {clients.map((client) => (
                      <SelectItem key={client.id} value={client.id}>
                        {client.name} {client.email && `(${client.email})`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="policyholderName">Full Name</Label>
                <Input
                  id="policyholderName"
                  value={formData.policyholderName}
                  onChange={(e) => setFormData({ ...formData, policyholderName: e.target.value })}
                  placeholder="John Doe"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="policyholderPhone">Phone Number</Label>
                <Input
                  id="policyholderPhone"
                  type="tel"
                  value={formData.policyholderPhone}
                  onChange={(e) => setFormData({ ...formData, policyholderPhone: formatPhoneNumber(e.target.value) })}
                  placeholder="123-456-7890"
                />
              </div>
              <div className="space-y-2 col-span-2">
                <Label htmlFor="policyholderEmail">Email</Label>
                <Input
                  id="policyholderEmail"
                  type="email"
                  value={formData.policyholderEmail}
                  onChange={(e) => setFormData({ ...formData, policyholderEmail: e.target.value })}
                  placeholder="john@example.com"
                />
              </div>
              <div className="space-y-2 col-span-2">
                <Label htmlFor="policyholderStreet">Street Address</Label>
                <Input
                  id="policyholderStreet"
                  value={formData.policyholderStreet}
                  onChange={(e) => setFormData({ ...formData, policyholderStreet: e.target.value })}
                  placeholder="123 Main St"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="policyholderCity">City</Label>
                <Input
                  id="policyholderCity"
                  value={formData.policyholderCity}
                  onChange={(e) => setFormData({ ...formData, policyholderCity: e.target.value })}
                  placeholder="Miami"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="policyholderState">State</Label>
                <Input
                  id="policyholderState"
                  value={formData.policyholderState}
                  onChange={(e) => setFormData({ ...formData, policyholderState: e.target.value })}
                  placeholder="FL"
                />
              </div>
              <div className="space-y-2 col-span-2">
                <Label htmlFor="policyholderZip">ZIP Code</Label>
                <Input
                  id="policyholderZip"
                  value={formData.policyholderZip}
                  onChange={(e) => setFormData({ ...formData, policyholderZip: e.target.value })}
                  placeholder="33101"
                />
              </div>
            </div>
          </div>

          {/* Claim Information Section */}
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-foreground border-b border-border pb-2">
              Claim Information
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="claimNumber">Claim Number</Label>
                <Input
                  id="claimNumber"
                  value={formData.claimNumber}
                  onChange={(e) => setFormData({ ...formData, claimNumber: e.target.value })}
                  placeholder="CLM-2024-001"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="policyNumber">Policy Number</Label>
                <Input
                  id="policyNumber"
                  value={formData.policyNumber}
                  onChange={(e) => setFormData({ ...formData, policyNumber: e.target.value })}
                  placeholder="POL-123456"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="insuranceCompany">Insurance Company</Label>
                {addInsuranceOpen ? (
                  <div className="flex gap-2">
                    <Input
                      placeholder="New insurance company name"
                      value={newInsuranceName}
                      onChange={(e) => setNewInsuranceName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddInsuranceCompany())}
                    />
                    <Button type="button" size="sm" onClick={handleAddInsuranceCompany}>Add</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setAddInsuranceOpen(false)}>Cancel</Button>
                  </div>
                ) : (
                  <Select
                    value={formData.insuranceCompanyId}
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
                      {insuranceCompanies.map((company) => (
                        <SelectItem key={company.id} value={company.id}>
                          {company.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="lossType">Type of Loss</Label>
                <Select
                  value={formData.lossTypeId}
                  onValueChange={(value) => setFormData({ ...formData, lossTypeId: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select loss type" />
                  </SelectTrigger>
                  <SelectContent>
                    {lossTypes.map((type) => (
                      <SelectItem key={type.id} value={type.id}>
                        {type.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="lossDate">Date of Loss</Label>
                <Input
                  id="lossDate"
                  type="date"
                  value={formData.lossDate}
                  onChange={(e) => setFormData({ ...formData, lossDate: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contractor">Contractor</Label>
                <Select
                  value={formData.contractorId}
                  onValueChange={(value) => setFormData({ ...formData, contractorId: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select contractor" />
                  </SelectTrigger>
                  <SelectContent>
                    {contractors.map((contractor) => (
                      <SelectItem key={contractor.id} value={contractor.id}>
                        {contractor.full_name || contractor.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mortgageCompany">Mortgage Company</Label>
                {addMortgageOpen ? (
                  <div className="flex gap-2">
                    <Input
                      placeholder="New mortgage company name"
                      value={newMortgageName}
                      onChange={(e) => setNewMortgageName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddMortgageCompany())}
                    />
                    <Button type="button" size="sm" onClick={handleAddMortgageCompany}>Add</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setAddMortgageOpen(false)}>Cancel</Button>
                  </div>
                ) : (
                  <Select
                    value={formData.mortgageCompanyId}
                    onValueChange={(value) => {
                      if (value === "__add_new__") {
                        setAddMortgageOpen(true);
                      } else {
                        setFormData({ ...formData, mortgageCompanyId: value });
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select mortgage company" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__add_new__" className="text-primary font-medium">
                        <span className="flex items-center gap-1"><Plus className="h-4 w-4" /> Add New Mortgage Company</span>
                      </SelectItem>
                      {mortgageCompanies.map((company) => (
                        <SelectItem key={company.id} value={company.id}>
                          {company.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-2 col-span-2">
                <Label htmlFor="lossDescription">Loss Description</Label>
                <Textarea
                  id="lossDescription"
                  value={formData.lossDescription}
                  onChange={(e) => setFormData({ ...formData, lossDescription: e.target.value })}
                  placeholder="Describe the incident..."
                  rows={3}
                />
              </div>
            </div>
          </div>

          {/* Share to Workspace Section */}
          {workspaces.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-foreground border-b border-border pb-2">
                Share to Workspace (Optional)
              </h3>
              <div className="space-y-2">
                <Label htmlFor="workspace">Share with Partner Organization</Label>
                <Select
                  value={selectedWorkspaceId || "__none__"}
                  onValueChange={(value) => setSelectedWorkspaceId(value === "__none__" ? "" : value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select workspace to share" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Don't share</SelectItem>
                    {workspaces.map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Select a workspace to immediately share this claim with partner organizations
                </p>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4 border-t border-border">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Creating..." : "Create Claim"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
