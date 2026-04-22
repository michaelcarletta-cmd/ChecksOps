import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { UserPlus, X, Users, UserCheck, Compass } from "lucide-react";

interface ClaimAccessManagementProps {
  claimId: string;
  isGuidedMode?: boolean;
}

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
}

interface Client {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export function ClaimAccessManagement({ claimId, isGuidedMode }: ClaimAccessManagementProps) {
  const [allClients, setAllClients] = useState<Client[]>([]);
  const [contractors, setContractors] = useState<Profile[]>([]);
  const [assignedContractors, setAssignedContractors] = useState<Profile[]>([]);
  const [currentClientId, setCurrentClientId] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [selectedContractor, setSelectedContractor] = useState<string>("");
  const [guidedToggling, setGuidedToggling] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    fetchClients();
    fetchContractors();
    fetchClaimAssignments();
  }, [claimId]);

  const fetchClients = async () => {
    try {
      const { data } = await supabase
        .from("clients")
        .select("*")
        .order("name");
      setAllClients(data || []);
    } catch (error: any) {
      console.error("Error fetching clients:", error);
    }
  };

  const fetchContractors = async () => {
    try {
      const { data: roles } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "contractor");

      if (!roles) return;

      const { data: profiles } = await supabase
        .from("profiles")
        .select("*")
        .in("id", roles.map(r => r.user_id));

      setContractors(profiles || []);
    } catch (error: any) {
      console.error("Error fetching contractors:", error);
    }
  };

  const fetchClaimAssignments = async () => {
    try {
      // Get current claim data
      const { data: claim } = await supabase
        .from("claims")
        .select("client_id")
        .eq("id", claimId)
        .single();

      if (claim) {
        setCurrentClientId(claim.client_id);
      }

      // Get assigned contractors
      const { data: assignments } = await supabase
        .from("claim_contractors")
        .select("contractor_id")
        .eq("claim_id", claimId);

      if (assignments) {
        const contractorIds = assignments.map(a => a.contractor_id);
        const { data: contractorProfiles } = await supabase
          .from("profiles")
          .select("*")
          .in("id", contractorIds);
        
        setAssignedContractors(contractorProfiles || []);
      }
    } catch (error: any) {
      console.error("Error fetching assignments:", error);
    }
  };

  const assignClient = async () => {
    if (!selectedClient) return;

    try {
      const { error } = await supabase
        .from("claims")
        .update({ client_id: selectedClient })
        .eq("id", claimId);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Client assigned to claim",
      });

      setCurrentClientId(selectedClient);
      setSelectedClient("");
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const removeClient = async () => {
    try {
      const { error } = await supabase
        .from("claims")
        .update({ client_id: null })
        .eq("id", claimId);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Client removed from claim",
      });

      setCurrentClientId(null);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const assignContractor = async () => {
    if (!selectedContractor) return;

    try {
      const { error } = await supabase
        .from("claim_contractors")
        .insert({
          claim_id: claimId,
          contractor_id: selectedContractor,
        });

      if (error) throw error;

      toast({
        title: "Success",
        description: "Contractor assigned to claim",
      });

      fetchClaimAssignments();
      setSelectedContractor("");
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const removeContractor = async (contractorId: string) => {
    try {
      const { error } = await supabase
        .from("claim_contractors")
        .delete()
        .eq("claim_id", claimId)
        .eq("contractor_id", contractorId);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Contractor removed from claim",
      });

      fetchClaimAssignments();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const currentClient = allClients.find(c => c.id === currentClientId);

  const handleGuidedModeToggle = async (enabled: boolean) => {
    setGuidedToggling(true);
    const { error } = await supabase
      .from("claims")
      .update({ is_guided_mode: enabled })
      .eq("id", claimId);
    setGuidedToggling(false);
    if (error) {
      toast({ title: "Error", description: "Failed to update guided mode", variant: "destructive" });
    } else {
      toast({ title: enabled ? "Guided Mode enabled" : "Guided Mode disabled" });
      queryClient.invalidateQueries({ queryKey: ["claim"] });
    }
  };

  return (
    <div className="space-y-6">
      {/* Guided Claim Mode */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Compass className="h-5 w-5" />
            Guided Claim Mode
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable Guided Mode</p>
              <p className="text-xs text-muted-foreground">
                Allows the policyholder to self-manage this claim with Darwin guidance
              </p>
            </div>
            <Switch
              checked={!!isGuidedMode}
              onCheckedChange={handleGuidedModeToggle}
              disabled={guidedToggling}
            />
          </div>
          {isGuidedMode && (
            <p className="text-xs text-muted-foreground bg-muted/50 rounded p-2 border border-border">
              The policyholder can access this claim at <span className="font-mono text-foreground">/guided</span> to upload documents, receive AI-drafted communications, and send them from their own email.
            </p>
          )}
        </CardContent>
      </Card>
      {/* Client Assignment */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Client Access
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {currentClient ? (
            <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
              <div>
                <p className="font-medium">{currentClient.name}</p>
                <p className="text-sm text-muted-foreground">{currentClient.email || "No email"}</p>
                <Badge variant="secondary" className="mt-1">Policyholder</Badge>
              </div>
              <Button variant="ghost" size="sm" onClick={removeClient}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Select value={selectedClient} onValueChange={setSelectedClient}>
                <SelectTrigger className="bg-background">
                  <SelectValue placeholder="Select policyholder for client access" />
                </SelectTrigger>
                <SelectContent className="bg-popover z-50">
                  {allClients.map((client) => (
                    <SelectItem key={client.id} value={client.id}>
                      {client.name} {client.email ? `(${client.email})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={assignClient} disabled={!selectedClient}>
                <UserPlus className="h-4 w-4 mr-2" />
                Assign
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            The policyholder will have access to view this claim in the Client Portal
          </p>
        </CardContent>
      </Card>

      {/* Contractor Assignments */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5" />
            Contractor Access
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Select value={selectedContractor} onValueChange={setSelectedContractor}>
              <SelectTrigger className="bg-background">
                <SelectValue placeholder="Select contractor" />
              </SelectTrigger>
              <SelectContent className="bg-popover z-50">
                {contractors
                  .filter(c => !assignedContractors.some(ac => ac.id === c.id))
                  .map((contractor) => (
                    <SelectItem key={contractor.id} value={contractor.id}>
                      {contractor.full_name || contractor.email}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button onClick={assignContractor} disabled={!selectedContractor}>
              <UserPlus className="h-4 w-4 mr-2" />
              Assign
            </Button>
          </div>

          {assignedContractors.length > 0 && (
            <div className="space-y-2">
              {assignedContractors.map((contractor) => (
                <div key={contractor.id} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                  <div>
                    <p className="font-medium">{contractor.full_name || contractor.email}</p>
                    <p className="text-sm text-muted-foreground">{contractor.email}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => removeContractor(contractor.id)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}