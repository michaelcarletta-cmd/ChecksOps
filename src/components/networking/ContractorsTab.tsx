import { useState, useEffect } from "react";
import { generateClientPassword } from "@/lib/generateClientPassword";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { UserPlus, Mail, Phone, Search, Trash2, Link2, Send, Pencil, Upload, X, Image, FileText } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CredentialsDialog } from "@/components/CredentialsDialog";
import { Switch } from "@/components/ui/switch";
import { formatPhoneNumber } from "@/lib/utils";
import { ContractorDocumentsDialog } from "./ContractorDocumentsDialog";

interface Contractor {
  id: string;
  full_name: string | null;
  email: string;
  phone: string | null;
  logo_url?: string | null;
  jobnimbus_api_key?: string | null;
  jobnimbus_enabled?: boolean;
  external_instance_url?: string | null;
  external_instance_name?: string | null;
}

export const ContractorsTab = () => {
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [filteredContractors, setFilteredContractors] = useState<Contractor[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [contractorToDelete, setContractorToDelete] = useState<Contractor | null>(null);
  const [formData, setFormData] = useState({
    email: "",
    full_name: "",
    phone: "",
  });
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);
  const [integrationDialogOpen, setIntegrationDialogOpen] = useState(false);
  const [selectedContractor, setSelectedContractor] = useState<Contractor | null>(null);
  const [jobnimbusApiKey, setJobnimbusApiKey] = useState("");
  const [jobnimbusEnabled, setJobnimbusEnabled] = useState(false);
  const [sendingInvite, setSendingInvite] = useState<string | null>(null);
  const [externalInstanceUrl, setExternalInstanceUrl] = useState("");
  const [externalInstanceName, setExternalInstanceName] = useState("");
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingContractor, setEditingContractor] = useState<Contractor | null>(null);
  const [editFormData, setEditFormData] = useState({
    full_name: "",
    phone: "",
  });
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [editLogoUrl, setEditLogoUrl] = useState<string | null>(null);
  const [documentsDialogOpen, setDocumentsDialogOpen] = useState(false);
  const [documentsContractor, setDocumentsContractor] = useState<Contractor | null>(null);

  const handleOpenDocuments = (contractor: Contractor) => {
    setDocumentsContractor(contractor);
    setDocumentsDialogOpen(true);
  };

  const handleSendPortalInvite = async (contractor: Contractor) => {
    if (!contractor.email) {
      toast.error("Contractor has no email address");
      return;
    }

    setSendingInvite(contractor.id);
    // Generate a new temporary password
    const tempPassword = generateClientPassword(contractor.full_name || "Contractor");
    
    try {
      // Update the user's password first
      const { error: updateError } = await supabase.auth.admin.updateUserById(
        contractor.id,
        { password: tempPassword }
      );

      // Even if admin update fails, try to send the invite with a reset link option
      const { error } = await supabase.functions.invoke("send-portal-invite", {
        body: {
          email: contractor.email,
          password: tempPassword,
          userType: "Contractor",
          userName: contractor.full_name,
          appUrl: window.location.origin,
        },
      });

      if (error) throw error;

      toast.success(`Portal invite sent to ${contractor.email}`);
    } catch (error: any) {
      console.error("Error sending invite:", error);
      toast.error("Failed to send portal invite: " + error.message);
    } finally {
      setSendingInvite(null);
    }
  };

  useEffect(() => {
    fetchContractors();
  }, []);

  useEffect(() => {
    const filtered = contractors.filter((contractor) => {
      const searchLower = searchQuery.toLowerCase();
      return (
        contractor.full_name?.toLowerCase().includes(searchLower) ||
        contractor.email.toLowerCase().includes(searchLower) ||
        contractor.phone?.toLowerCase().includes(searchLower)
      );
    });
    setFilteredContractors(filtered);
  }, [contractors, searchQuery]);

  const fetchContractors = async () => {
    // Fetch users with contractor role
    const { data: roleData, error: roleError } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "contractor");

    if (roleError) {
      toast.error("Failed to fetch contractors");
      return;
    }

    if (!roleData || roleData.length === 0) {
      setContractors([]);
      return;
    }

    const contractorIds = roleData.map((r) => r.user_id);

    // Fetch profiles for these users
    const { data: profileData, error: profileError } = await supabase
      .from("profiles")
      .select("id, full_name, email, phone, logo_url, jobnimbus_api_key, jobnimbus_enabled, external_instance_url, external_instance_name")
      .in("id", contractorIds);

    if (profileError) {
      toast.error("Failed to fetch contractor profiles");
      return;
    }

    setContractors(profileData || []);
  };

  const handleOpenIntegration = (contractor: Contractor) => {
    setSelectedContractor(contractor);
    setJobnimbusApiKey(contractor.jobnimbus_api_key || "");
    setJobnimbusEnabled(contractor.jobnimbus_enabled || false);
    setExternalInstanceUrl(contractor.external_instance_url || "");
    setExternalInstanceName(contractor.external_instance_name || "");
    setIntegrationDialogOpen(true);
  };

  const handleSaveIntegration = async () => {
    if (!selectedContractor) return;

    const { error } = await supabase
      .from("profiles")
      .update({
        jobnimbus_api_key: jobnimbusApiKey || null,
        jobnimbus_enabled: jobnimbusEnabled,
        external_instance_url: externalInstanceUrl || null,
        external_instance_name: externalInstanceName || null,
      })
      .eq("id", selectedContractor.id);

    if (error) {
      toast.error("Failed to save integration settings");
      return;
    }

    toast.success("Integration settings saved");
    setIntegrationDialogOpen(false);
    fetchContractors();
  };

  const handleAddContractor = async () => {
    if (!formData.email.trim() || !formData.full_name.trim()) {
      toast.error("Email and name are required");
      return;
    }

    // Create a temporary password for the contractor
    const tempPassword = generateClientPassword(formData.full_name || "Contractor");

    // Use edge function to create user without auto-login
    const { data: funcData, error: funcError } = await supabase.functions.invoke(
      "create-portal-user",
      {
        body: {
          email: formData.email,
          password: tempPassword,
          fullName: formData.full_name,
          role: "contractor",
          phone: formData.phone || undefined,
        },
      }
    );

    if (funcError) {
      toast.error("Failed to create contractor: " + funcError.message);
      return;
    }

    if (funcData?.error) {
      toast.error("Failed to create contractor: " + funcData.error);
      return;
    }

    setDialogOpen(false);
    setFormData({ email: "", full_name: "", phone: "" });
    setCredentials({ email: formData.email, password: tempPassword });
    fetchContractors();
  };

  const handleDeleteClick = (contractor: Contractor) => {
    setContractorToDelete(contractor);
    setDeleteDialogOpen(true);
  };

  const handleEditClick = (contractor: Contractor) => {
    setEditingContractor(contractor);
    setEditFormData({
      full_name: contractor.full_name || "",
      phone: contractor.phone || "",
    });
    setEditLogoUrl(contractor.logo_url || null);
    setEditDialogOpen(true);
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editingContractor) return;

    // Validate file type
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];
    if (!allowedTypes.includes(file.type)) {
      toast.error("Please upload a PNG, JPG, or SVG file");
      return;
    }

    // Validate file size (2MB max)
    if (file.size > 2 * 1024 * 1024) {
      toast.error("File size must be less than 2MB");
      return;
    }

    setUploadingLogo(true);

    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `${editingContractor.id}/logo.${fileExt}`;

      // Upload to storage
      const { error: uploadError } = await supabase.storage
        .from('company-branding')
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      // Get public URL
      const { data: urlData } = supabase.storage
        .from('company-branding')
        .getPublicUrl(filePath);

      setEditLogoUrl(urlData.publicUrl);
      toast.success("Logo uploaded successfully");
    } catch (error: any) {
      console.error("Upload error:", error);
      toast.error("Failed to upload logo: " + error.message);
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleRemoveLogo = () => {
    setEditLogoUrl(null);
  };

  const handleSaveEdit = async () => {
    if (!editingContractor) return;

    const { error } = await supabase
      .from("profiles")
      .update({
        full_name: editFormData.full_name || null,
        phone: editFormData.phone || null,
        logo_url: editLogoUrl,
      })
      .eq("id", editingContractor.id);

    if (error) {
      toast.error("Failed to update contractor");
      return;
    }

    toast.success("Contractor updated");
    setEditDialogOpen(false);
    setEditingContractor(null);
    fetchContractors();
  };

  const handleDeleteConfirm = async () => {
    if (!contractorToDelete) return;

    try {
      // Delete the auth user via edge function
      await supabase.functions.invoke("delete-user", {
        body: { userId: contractorToDelete.id },
      });

      toast.success("Contractor deleted completely");
      fetchContractors();
    } catch (error: any) {
      console.error("Delete error:", error);
      toast.error(error.message || "Failed to delete contractor");
    } finally {
      setDeleteDialogOpen(false);
      setContractorToDelete(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <CardTitle>Contractors</CardTitle>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => setFormData({ email: "", full_name: "", phone: "" })}>
              <UserPlus className="h-4 w-4 mr-2" />
              Add Contractor
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Contractor</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Email *</Label>
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="Enter email"
                />
              </div>
              <div>
                <Label>Full Name *</Label>
                <Input
                  value={formData.full_name}
                  onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                  placeholder="Enter full name"
                />
              </div>
              <div>
                <Label>Phone</Label>
                <Input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: formatPhoneNumber(e.target.value) })}
                  placeholder="123-456-7890"
                />
              </div>
              <Button onClick={handleAddContractor} className="w-full">
                Add Contractor
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, or phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {filteredContractors.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            {contractors.length === 0 ? "No contractors found" : "No contractors match your search"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[500px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">Name</TableHead>
                  <TableHead className="whitespace-nowrap">Email</TableHead>
                  <TableHead className="whitespace-nowrap">Phone</TableHead>
                  <TableHead className="whitespace-nowrap">Integrations</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
              {filteredContractors.map((contractor) => (
                <TableRow key={contractor.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Avatar className="h-8 w-8">
                        <AvatarImage src={contractor.logo_url || undefined} alt={contractor.full_name || "Contractor"} />
                        <AvatarFallback className="text-xs">
                          {contractor.full_name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || '??'}
                        </AvatarFallback>
                      </Avatar>
                      {contractor.full_name || "No name"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      {contractor.email}
                    </div>
                  </TableCell>
                  <TableCell>
                    {contractor.phone ? (
                      <div className="flex items-center gap-2">
                        <Phone className="h-4 w-4 text-muted-foreground" />
                        {contractor.phone}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleOpenIntegration(contractor)}
                      className="gap-1"
                    >
                      <Link2 className="h-4 w-4" />
                      {contractor.external_instance_url ? (
                        <span className="text-xs text-primary">{contractor.external_instance_name || 'External'}</span>
                      ) : contractor.jobnimbus_enabled ? (
                        <span className="text-xs text-success">JobNimbus</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Configure</span>
                      )}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleOpenDocuments(contractor)}
                        title="View documents"
                      >
                        <FileText className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleEditClick(contractor)}
                        title="Edit contractor"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleSendPortalInvite(contractor)}
                        disabled={sendingInvite === contractor.id}
                        title="Send portal invite email"
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteClick(contractor)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contractor</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this contractor? This will also remove their portal access and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {credentials && (
        <CredentialsDialog
          isOpen={!!credentials}
          onClose={() => setCredentials(null)}
          email={credentials.email}
          password={credentials.password}
          userType="Contractor"
        />
      )}

      <Dialog open={integrationDialogOpen} onOpenChange={setIntegrationDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Integration Settings - {selectedContractor?.full_name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-6">
            <div className="p-4 border rounded-lg space-y-4">
              <h4 className="font-medium">External Instance Sync</h4>
              <p className="text-sm text-muted-foreground">
                Auto-sync claims when this contractor is assigned
              </p>
              <div>
                <Label>Instance Name</Label>
                <Input
                  value={externalInstanceName}
                  onChange={(e) => setExternalInstanceName(e.target.value)}
                  placeholder="e.g., Condition One"
                />
              </div>
              <div>
                <Label>Instance URL</Label>
                <Input
                  value={externalInstanceUrl}
                  onChange={(e) => setExternalInstanceUrl(e.target.value)}
                  placeholder="https://xxx.supabase.co"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The Supabase project URL of the external instance
                </p>
              </div>
            </div>

            <div className="p-4 border rounded-lg space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-medium">JobNimbus Integration</h4>
                  <p className="text-sm text-muted-foreground">
                    Sync claims, tasks, notes, and files
                  </p>
                </div>
                <Switch
                  checked={jobnimbusEnabled}
                  onCheckedChange={setJobnimbusEnabled}
                />
              </div>
              {jobnimbusEnabled && (
                <div>
                  <Label>JobNimbus API Key</Label>
                  <Input
                    type="password"
                    value={jobnimbusApiKey}
                    onChange={(e) => setJobnimbusApiKey(e.target.value)}
                    placeholder="Enter API key from JobNimbus settings"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Find this in JobNimbus → Settings → API
                  </p>
                </div>
              )}
            </div>
            <Button onClick={handleSaveIntegration} className="w-full">
              Save Integration Settings
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Contractor</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Logo Upload */}
            <div>
              <Label>Company Logo</Label>
              <div className="mt-2">
                {editLogoUrl ? (
                  <div className="relative inline-block">
                    <img
                      src={editLogoUrl}
                      alt="Company logo"
                      className="h-20 w-auto max-w-[200px] object-contain border rounded"
                    />
                    <Button
                      variant="destructive"
                      size="icon"
                      className="absolute -top-2 -right-2 h-6 w-6"
                      onClick={handleRemoveLogo}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <div className="flex items-center justify-center h-20 w-20 border-2 border-dashed rounded hover:border-primary transition-colors">
                      {uploadingLogo ? (
                        <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
                      ) : (
                        <div className="flex flex-col items-center text-muted-foreground">
                          <Upload className="h-5 w-5" />
                          <span className="text-xs mt-1">Upload</span>
                        </div>
                      )}
                    </div>
                    <input
                      type="file"
                      className="hidden"
                      accept=".png,.jpg,.jpeg,.svg"
                      onChange={handleLogoUpload}
                      disabled={uploadingLogo}
                    />
                  </label>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-1">PNG, JPG, or SVG (max 2MB)</p>
            </div>
            
            <div>
              <Label>Email</Label>
              <Input
                type="email"
                value={editingContractor?.email || ""}
                disabled
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground mt-1">Email cannot be changed</p>
            </div>
            <div>
              <Label>Full Name</Label>
              <Input
                value={editFormData.full_name}
                onChange={(e) => setEditFormData({ ...editFormData, full_name: e.target.value })}
                placeholder="Enter full name"
              />
            </div>
            <div>
              <Label>Phone</Label>
              <Input
                type="tel"
                value={editFormData.phone}
                onChange={(e) => setEditFormData({ ...editFormData, phone: formatPhoneNumber(e.target.value) })}
                placeholder="123-456-7890"
              />
            </div>
            <Button onClick={handleSaveEdit} className="w-full">
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ContractorDocumentsDialog
        open={documentsDialogOpen}
        onOpenChange={setDocumentsDialogOpen}
        contractor={documentsContractor}
      />
    </Card>
  );
};
