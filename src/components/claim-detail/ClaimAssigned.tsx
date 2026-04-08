import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPhoneNumber } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { User, MapPin, Plus, Trash2, Edit, Search, Check, ChevronsUpDown } from "lucide-react";
import { ClaimAssignments } from "./ClaimAssignments";
import { ClaimPartnerAssignment } from "./ClaimPartnerAssignment";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface DirectoryAdjuster {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  phone_extension: string | null;
  company: string | null;
}

interface ClaimAssignedProps {
  claim: any;
}

interface Adjuster {
  id: string;
  claim_id: string;
  adjuster_id: string | null;
  adjuster_name: string;
  adjuster_email: string | null;
  adjuster_phone: string | null;
  company: string | null;
  is_primary: boolean;
  notes: string | null;
  created_at: string;
  adjuster?: {
    phone_extension: string | null;
  } | null;
}

export function ClaimAssigned({ claim }: ClaimAssignedProps) {
  const queryClient = useQueryClient();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editingAdjuster, setEditingAdjuster] = useState<Adjuster | null>(null);
  const [adjusterSearchOpen, setAdjusterSearchOpen] = useState(false);
  const [selectedDirectoryAdjuster, setSelectedDirectoryAdjuster] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    adjuster_name: "",
    adjuster_email: "",
    adjuster_phone: "",
    company: "",
    is_primary: false,
    notes: "",
  });

  // Fetch adjusters directory
  const { data: directoryAdjusters = [] } = useQuery({
    queryKey: ["adjusters-directory"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("adjusters")
        .select("id, name, email, phone, phone_extension, company")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data as DirectoryAdjuster[];
    },
  });

  const { data: adjusters = [], isLoading } = useQuery({
    queryKey: ["claim-adjusters", claim.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_adjusters")
        .select("*, adjuster:adjusters(phone_extension)")
        .eq("claim_id", claim.id)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true });

      if (error) throw error;
      return data as Adjuster[];
    },
  });

  const addAdjusterMutation = useMutation({
    mutationFn: async (data: typeof formData & { directoryAdjusterId?: string | null }) => {
      let adjusterId = data.directoryAdjusterId;

      // If not selected from directory, create new entry in adjusters table
      if (!adjusterId) {
        const { data: newAdjuster, error: adjusterError } = await supabase
          .from("adjusters")
          .insert({
            name: data.adjuster_name,
            email: data.adjuster_email || null,
            phone: data.adjuster_phone || null,
            company: data.company || null,
          })
          .select("id")
          .single();
        
        if (adjusterError) throw adjusterError;
        adjusterId = newAdjuster.id;
      }

      // Create claim adjuster entry linked to directory
      const { error } = await supabase.from("claim_adjusters").insert({
        claim_id: claim.id,
        adjuster_id: adjusterId,
        adjuster_name: data.adjuster_name,
        adjuster_email: data.adjuster_email || null,
        adjuster_phone: data.adjuster_phone || null,
        company: data.company || null,
        is_primary: data.is_primary,
        notes: data.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-adjusters", claim.id] });
      queryClient.invalidateQueries({ queryKey: ["adjusters-directory"] });
      toast.success("Adjuster added successfully");
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error("Failed to add adjuster");
      console.error(error);
    },
  });

  const updateAdjusterMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: typeof formData }) => {
      const { error } = await supabase
        .from("claim_adjusters")
        .update({
          adjuster_name: data.adjuster_name,
          adjuster_email: data.adjuster_email || null,
          adjuster_phone: data.adjuster_phone || null,
          company: data.company || null,
          is_primary: data.is_primary,
          notes: data.notes || null,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-adjusters", claim.id] });
      toast.success("Adjuster updated successfully");
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error("Failed to update adjuster");
      console.error(error);
    },
  });

  const deleteAdjusterMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("claim_adjusters")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-adjusters", claim.id] });
      toast.success("Adjuster removed");
    },
    onError: (error) => {
      toast.error("Failed to remove adjuster");
      console.error(error);
    },
  });

  const handleCloseDialog = () => {
    setIsAddDialogOpen(false);
    setEditingAdjuster(null);
    setSelectedDirectoryAdjuster(null);
    setFormData({
      adjuster_name: "",
      adjuster_email: "",
      adjuster_phone: "",
      company: "",
      is_primary: false,
      notes: "",
    });
  };

  const handleSelectDirectoryAdjuster = (adjusterId: string) => {
    const adjuster = directoryAdjusters.find(a => a.id === adjusterId);
    if (adjuster) {
      setSelectedDirectoryAdjuster(adjusterId);
      setFormData({
        ...formData,
        adjuster_name: adjuster.name,
        adjuster_email: adjuster.email || "",
        adjuster_phone: adjuster.phone || "",
        company: adjuster.company || "",
      });
    }
    setAdjusterSearchOpen(false);
  };

  const handleOpenEdit = (adjuster: Adjuster) => {
    setEditingAdjuster(adjuster);
    setFormData({
      adjuster_name: adjuster.adjuster_name,
      adjuster_email: adjuster.adjuster_email || "",
      adjuster_phone: adjuster.adjuster_phone || "",
      company: adjuster.company || "",
      is_primary: adjuster.is_primary,
      notes: adjuster.notes || "",
    });
    setIsAddDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!formData.adjuster_name.trim()) {
      toast.error("Adjuster name is required");
      return;
    }

    if (editingAdjuster) {
      updateAdjusterMutation.mutate({ id: editingAdjuster.id, data: formData });
    } else {
      addAdjusterMutation.mutate({ ...formData, directoryAdjusterId: selectedDirectoryAdjuster });
    }
  };

  const normalizePhone = (value: string | null | undefined) => (value || "").replace(/\D/g, "");
  const resolveAdjusterExtension = (adjuster: Adjuster): string | null => {
    const linkedExtension = Array.isArray(adjuster.adjuster)
      ? adjuster.adjuster[0]?.phone_extension ?? null
      : adjuster.adjuster?.phone_extension ?? null;
    if (linkedExtension) return linkedExtension;

    const adjusterEmail = (adjuster.adjuster_email || "").trim().toLowerCase();
    const adjusterPhone = normalizePhone(adjuster.adjuster_phone);
    const adjusterName = (adjuster.adjuster_name || "").trim().toLowerCase();

    const matchedDirectoryAdjuster = directoryAdjusters.find((candidate) => {
      if (adjuster.adjuster_id && candidate.id === adjuster.adjuster_id) return true;

      const candidateEmail = (candidate.email || "").trim().toLowerCase();
      if (adjusterEmail && candidateEmail && candidateEmail === adjusterEmail) return true;

      const candidatePhone = normalizePhone(candidate.phone);
      if (adjusterPhone && candidatePhone && candidatePhone === adjusterPhone) return true;

      const candidateName = (candidate.name || "").trim().toLowerCase();
      if (adjusterName && candidateName && candidateName === adjusterName) return true;

      return false;
    });

    return matchedDirectoryAdjuster?.phone_extension ?? null;
  };

  return (
    <div className="grid gap-6">
      {/* Adjuster Information */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5 text-primary" />
            Adjuster Information
          </CardTitle>
          <Button size="sm" onClick={() => setIsAddDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Add Adjuster
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading adjusters...</p>
          ) : adjusters.length === 0 ? (
            <p className="text-sm text-muted-foreground">No adjusters assigned yet.</p>
          ) : (
            <div className="space-y-4">
              {adjusters.map((adjuster) => {
                const adjusterExtension = resolveAdjusterExtension(adjuster);
                return (
                <div key={adjuster.id} className="border rounded-lg p-4 bg-muted/20">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{adjuster.adjuster_name}</span>
                      {adjuster.is_primary && (
                        <Badge variant="secondary" className="text-xs">Primary</Badge>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleOpenEdit(adjuster)}
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => deleteAdjusterMutation.mutate(adjuster.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2 text-sm">
                    {adjuster.company && (
                      <div>
                        <span className="text-muted-foreground">Company: </span>
                        <span>{adjuster.company}</span>
                      </div>
                    )}
                    {adjuster.adjuster_phone && (
                      <div>
                        <span className="text-muted-foreground">Phone: </span>
                        <span>
                          {adjuster.adjuster_phone}
                          {adjusterExtension ? ` ext ${adjusterExtension}` : ""}
                        </span>
                      </div>
                    )}
                    {adjuster.adjuster_email && (
                      <div>
                        <span className="text-muted-foreground">Email: </span>
                        <span>{adjuster.adjuster_email}</span>
                      </div>
                    )}
                    {adjuster.notes && (
                      <div className="md:col-span-2">
                        <span className="text-muted-foreground">Notes: </span>
                        <span>{adjuster.notes}</span>
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Claim Assignments (Staff, Contractors, Mortgage) */}
      <ClaimAssignments 
        claimId={claim.id}
        currentMortgageCompanyId={claim.mortgage_company_id}
        loanNumber={claim.loan_number}
        ssnLastFour={claim.ssn_last_four}
        mortgagePortalSite={claim.mortgage_portal_site}
        mortgagePortalUsername={claim.mortgage_portal_username}
        mortgagePortalPassword={claim.mortgage_portal_password}
        claimTrackingNumber={claim.claim_tracking_number}
        fedexTrackingNumber={claim.fedex_tracking_number}
      />

      {/* Partner Sales Rep Assignment */}
      <ClaimPartnerAssignment claimId={claim.id} />

      {/* Add/Edit Adjuster Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={handleCloseDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingAdjuster ? "Edit Adjuster" : "Add Adjuster"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {/* Adjuster Directory Selector - only show when adding */}
            {!editingAdjuster && directoryAdjusters.length > 0 && (
              <div className="grid gap-2">
                <Label>Select from Directory</Label>
                <Popover open={adjusterSearchOpen} onOpenChange={setAdjusterSearchOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      aria-expanded={adjusterSearchOpen}
                      className="justify-between"
                    >
                      {selectedDirectoryAdjuster
                        ? directoryAdjusters.find(a => a.id === selectedDirectoryAdjuster)?.name
                        : "Search saved adjusters..."}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[400px] p-0">
                    <Command>
                      <CommandInput placeholder="Search adjusters..." />
                      <CommandList>
                        <CommandEmpty>No adjuster found.</CommandEmpty>
                        <CommandGroup>
                          {directoryAdjusters.map((adjuster) => (
                            <CommandItem
                              key={adjuster.id}
                              value={`${adjuster.name} ${adjuster.company || ""}`}
                              onSelect={() => handleSelectDirectoryAdjuster(adjuster.id)}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  selectedDirectoryAdjuster === adjuster.id ? "opacity-100" : "opacity-0"
                                )}
                              />
                              <div className="flex flex-col">
                                <span>{adjuster.name}</span>
                                {adjuster.company && (
                                  <span className="text-xs text-muted-foreground">{adjuster.company}</span>
                                )}
                              </div>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                <p className="text-xs text-muted-foreground">Or enter details manually below</p>
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="adjuster_name">Name *</Label>
              <Input
                id="adjuster_name"
                value={formData.adjuster_name}
                onChange={(e) =>
                  setFormData({ ...formData, adjuster_name: e.target.value })
                }
                placeholder="Adjuster name"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="company">Company</Label>
              <Input
                id="company"
                value={formData.company}
                onChange={(e) =>
                  setFormData({ ...formData, company: e.target.value })
                }
                placeholder="Insurance company"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="adjuster_phone">Phone</Label>
                <Input
                  id="adjuster_phone"
                  type="tel"
                  value={formData.adjuster_phone}
                  onChange={(e) =>
                    setFormData({ ...formData, adjuster_phone: formatPhoneNumber(e.target.value) })
                  }
                  placeholder="123-456-7890"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="adjuster_email">Email</Label>
                <Input
                  id="adjuster_email"
                  type="email"
                  value={formData.adjuster_email}
                  onChange={(e) =>
                    setFormData({ ...formData, adjuster_email: e.target.value })
                  }
                  placeholder="Email address"
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea
                id="notes"
                value={formData.notes}
                onChange={(e) =>
                  setFormData({ ...formData, notes: e.target.value })
                }
                placeholder="Additional notes about this adjuster"
                rows={2}
              />
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="is_primary"
                checked={formData.is_primary}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, is_primary: checked as boolean })
                }
              />
              <Label htmlFor="is_primary" className="font-normal">
                Primary adjuster for this claim
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCloseDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={addAdjusterMutation.isPending || updateAdjusterMutation.isPending}
            >
              {editingAdjuster ? "Save Changes" : "Add Adjuster"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
