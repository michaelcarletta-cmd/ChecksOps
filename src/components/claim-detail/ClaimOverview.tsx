import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { User, Calendar, MapPin, Mail, UserPlus, Loader2, Plus, Trash2, Users } from "lucide-react";
import { format } from "date-fns";
import { ClaimCustomFields } from "./ClaimCustomFields";
import { CredentialsDialog } from "@/components/CredentialsDialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { generateClientPassword } from "@/lib/generateClientPassword";


interface ClaimOverviewProps {
  claim: any;
  isPortalUser?: boolean;
  onClaimUpdated?: (claim: any) => void;
}

// Generate claim-specific email address using policy number
const getClaimEmail = (claim: any): string => {
  const domain = "claims.freedomclaims.work";
  if (claim.policy_number) {
    const sanitized = claim.policy_number
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return `claim-${sanitized}@${domain}`;
  }
  return claim.claim_email_id ? `claim-${claim.claim_email_id}@${domain}` : '';
};

export function ClaimOverview({ claim, isPortalUser = false, onClaimUpdated }: ClaimOverviewProps) {
  const [creatingPortal, setCreatingPortal] = useState(false);
  const [hasPortalAccess, setHasPortalAccess] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [credentials, setCredentials] = useState({ email: "", password: "", pin: "" });
  const [resendingInvite, setResendingInvite] = useState(false);

  // Check if client already has portal access
  useEffect(() => {
    const checkPortalAccess = async () => {
      if (claim.client_id) {
        const { data } = await supabase
          .from("clients")
          .select("user_id")
          .eq("id", claim.client_id)
          .single();
        setHasPortalAccess(!!data?.user_id);
      } else {
        setHasPortalAccess(false);
      }
    };
    checkPortalAccess();
  }, [claim.client_id]);

  const handleCreatePortalAccess = async () => {
    if (!claim.policyholder_email) {
      toast.error("Policyholder email is required to create portal access");
      return;
    }

    setCreatingPortal(true);
    try {
      const tempPassword = generateClientPassword(claim.policyholder_name || "Client");

      // Create portal user via edge function
      const { data: userData, error: userError } = await supabase.functions.invoke(
        "create-portal-user",
        {
          body: {
            email: claim.policyholder_email,
            password: tempPassword,
            fullName: claim.policyholder_name,
            role: "client",
            phone: claim.policyholder_phone,
          },
        }
      );

      if (userError) throw userError;
      if (userData?.error) throw new Error(userData.error);

      const userId = userData?.userId;
      if (!userId) throw new Error("Failed to create user account");

      let clientId = claim.client_id;

      // Create or update client record
      if (!clientId) {
        // Check if client already exists with this email
        const { data: existingClient } = await supabase
          .from("clients")
          .select("id, name")
          .eq("email", claim.policyholder_email)
          .maybeSingle();

        if (existingClient) {
          // Update existing client with user_id and sync name with policyholder
          await supabase
            .from("clients")
            .update({ 
              user_id: userId,
              name: claim.policyholder_name || existingClient.name 
            })
            .eq("id", existingClient.id);
          clientId = existingClient.id;
        } else {
          // Create new client
          const { data: newClient, error: clientError } = await supabase
            .from("clients")
            .insert({
              name: claim.policyholder_name,
              email: claim.policyholder_email,
              phone: claim.policyholder_phone,
              user_id: userId,
            })
            .select()
            .single();

          if (clientError) throw clientError;
          clientId = newClient.id;
        }

        // Link client to claim
        const { error: updateError } = await supabase
          .from("claims")
          .update({ client_id: clientId })
          .eq("id", claim.id);

        if (updateError) throw updateError;

        // Update parent component
        if (onClaimUpdated) {
          onClaimUpdated({ ...claim, client_id: clientId });
        }
      } else {
        // Update existing client with user_id
        await supabase
          .from("clients")
          .update({ user_id: userId })
          .eq("id", clientId);
      }

      setHasPortalAccess(true);
      
      if (userData?.existingUser) {
        toast.success("Portal access linked - user already has an account");
      } else {
        // Automatically send invite email
        try {
          const appUrl = window.location.origin;
          console.log("Sending portal invite email to:", claim.policyholder_email);
          const { error: emailError } = await supabase.functions.invoke("send-portal-invite", {
            body: { 
              email: claim.policyholder_email, 
              password: tempPassword,
              pin: userData?.pin,
              userType: "Client", 
              userName: claim.policyholder_name || undefined,
              appUrl 
            },
          });
          if (emailError) {
            console.error("Failed to send invite email:", emailError);
            toast.warning("Portal created but email failed to send");
          } else {
            console.log("Invite email sent successfully");
            toast.success("Portal access created and invite email sent");
          }
        } catch (emailErr) {
          console.error("Error sending invite email:", emailErr);
          toast.warning("Portal created but email failed to send");
        }

        setCredentials({ email: claim.policyholder_email, password: tempPassword, pin: userData?.pin || "" });
        setCredentialsOpen(true);
      }
    } catch (error: any) {
      console.error("Error creating portal access:", error);
      toast.error(error.message || "Failed to create portal access");
    } finally {
      setCreatingPortal(false);
    }
  };

  const handleResendInvite = async () => {
    if (!claim.policyholder_email) {
      toast.error("No email address available");
      return;
    }

    setResendingInvite(true);
    try {
      // Generate a new password for the resend
      const tempPassword = generateClientPassword(claim.policyholder_name || "Client");
      
      // Update the user's password via edge function
      const { data, error } = await supabase.functions.invoke("create-portal-user", {
        body: {
          email: claim.policyholder_email,
          password: tempPassword,
          fullName: claim.policyholder_name,
          role: "client",
          phone: claim.policyholder_phone,
        },
      });

      if (error) throw error;

      // Send the invite email
      const appUrl = window.location.origin;
      const { error: emailError } = await supabase.functions.invoke("send-portal-invite", {
        body: { 
          email: claim.policyholder_email, 
          password: tempPassword,
          pin: data?.pin,
          userType: "Client", 
          userName: claim.policyholder_name || undefined,
          appUrl 
        },
      });

      if (emailError) {
        console.error("Failed to send invite email:", emailError);
        toast.warning("Password reset but email failed to send");
        setCredentials({ email: claim.policyholder_email, password: tempPassword, pin: data?.pin || "" });
        setCredentialsOpen(true);
      } else {
        toast.success("New invite email sent successfully");
        setCredentials({ email: claim.policyholder_email, password: tempPassword, pin: data?.pin || "" });
        setCredentialsOpen(true);
      }
    } catch (error: any) {
      console.error("Error resending invite:", error);
      toast.error(error.message || "Failed to resend invite");
    } finally {
      setResendingInvite(false);
    }
  };

  return (
    <div className="grid gap-6">
      {/* Policyholder Information */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5 text-primary" />
            Policyholder Information
          </CardTitle>
          {!isPortalUser && claim.policyholder_email && (
            hasPortalAccess ? (
              <Button
                size="sm"
                variant="outline"
                onClick={handleResendInvite}
                disabled={resendingInvite}
              >
                {resendingInvite ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4 mr-2" />
                )}
                Resend Invite
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={handleCreatePortalAccess}
                disabled={creatingPortal}
              >
                {creatingPortal ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <UserPlus className="h-4 w-4 mr-2" />
                )}
                Create Portal Access
              </Button>
            )
          )}
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Name</p>
              <p className="text-sm font-medium">{claim.policyholder_name || "N/A"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Email</p>
              <p className="text-sm font-medium">{claim.policyholder_email || "N/A"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Phone</p>
              <p className="text-sm font-medium">{claim.policyholder_phone || "N/A"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Address</p>
              <p className="text-sm font-medium">{claim.policyholder_address || "N/A"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Additional Contacts */}
      {!isPortalUser && <AdditionalContacts claimId={claim.id} />}

      {/* Loss Information */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            Loss Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Date of Loss</p>
              <p className="text-sm font-medium">
                {claim.loss_date ? format(new Date(claim.loss_date + 'T12:00:00'), "MMM dd, yyyy") : "N/A"}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Type of Loss</p>
              <p className="text-sm font-medium">{claim.loss_type || "N/A"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Date Submitted</p>
              <p className="text-sm font-medium">
                {claim.created_at ? format(new Date(claim.created_at), "MMM dd, yyyy") : "N/A"}
              </p>
            </div>
            {!isPortalUser && getClaimEmail(claim) && (
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground flex items-center gap-1">
                  <Mail className="h-3 w-3" />
                  Claim Email
                </p>
                <p className="text-sm font-medium font-mono text-primary break-all">
                  {getClaimEmail(claim)}
                </p>
              </div>
            )}
            <div className="space-y-1 md:col-span-2">
              <p className="text-sm text-muted-foreground">Loss Description</p>
              <p className="text-sm font-medium">{claim.loss_description || "N/A"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Insurance Company Information */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            Insurance Company Information
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Company Name</p>
              <p className="text-sm font-medium">{claim.insurance_company || "N/A"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Policy Number</p>
              <p className="text-sm font-medium">{claim.policy_number || "N/A"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Phone</p>
              <p className="text-sm font-medium">{claim.insurance_phone || "N/A"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Email</p>
              <p className="text-sm font-medium">{claim.insurance_email || "N/A"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Custom Fields */}
      <ClaimCustomFields claimId={claim.id} claimStatus={claim.status} />

      {/* Credentials Dialog */}
      <CredentialsDialog
        isOpen={credentialsOpen}
        onClose={() => setCredentialsOpen(false)}
        email={credentials.email}
        password={credentials.password}
        pin={credentials.pin}
        userType="Client"
        userName={claim.policyholder_name}
      />
    </div>
  );
}