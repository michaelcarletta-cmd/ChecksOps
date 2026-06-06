import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ShieldCheck, AlertTriangle, CheckCircle2, XCircle, FileText, Loader2 } from "lucide-react";
import { format } from "date-fns";

interface Props {
  stakeholderAccountId: string;
  accountNickname: string;
  accountLast4: string;
  custname: string;
}

const ACH_FORM_TEXT = (companyName: string, accountNickname: string) =>
  `I authorize ChecksOps and ${companyName} to initiate ACH debit entries to the bank account identified as "${accountNickname}". This authorization is for the purpose of funding disbursements to subcontractors, vendors, and other payees associated with insurance check proceeds. I confirm that I am an authorized signer on this bank account. This authorization remains in effect until I notify ChecksOps in writing to revoke it with sufficient time to act.`;

export function AchAuthorizationForm({
  stakeholderAccountId,
  accountNickname,
  accountLast4,
  custname,
}: Props) {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [signatureName, setSignatureName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [showForm, setShowForm] = useState(false);

  // Load existing authorization for this account
  const { data: existingAuth, isLoading } = useQuery({
    queryKey: ["ach-authorization", stakeholderAccountId],
    enabled: !!stakeholderAccountId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ach_authorizations")
        .select("*")
        .eq("stakeholder_account_id", stakeholderAccountId)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1);
      
      if (error) throw error;
      return data?.[0] ?? null;
    },
  });

  const formText = ACH_FORM_TEXT(tenant?.name ?? "your company", accountNickname);

  const signAuthorization = useMutation({
    mutationFn: async () => {
      if (!user || !tenant) throw new Error("Not authenticated");
      if (!signatureName.trim()) throw new Error("Signature name is required");
      if (!agreed) throw new Error("You must agree to the authorization");

      const { error } = await supabase
        .from("ach_authorizations")
        .insert({
          tenant_id: tenant.id,
          stakeholder_account_id: stakeholderAccountId,
          authorized_by: user.id,
          authorized_name: signatureName.trim(),
          form_text: formText,
          is_active: true,
        });

      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "ACH Authorized", description: "Authorization has been successfully recorded." });
      qc.invalidateQueries({ queryKey: ["ach-authorization", stakeholderAccountId] });
      setShowForm(false);
      setSignatureName("");
      setAgreed(false);
    },
    onError: (e: any) => {
      toast({ title: "Authorization failed", description: e.message, variant: "destructive" });
    },
  });

  const revokeAuthorization = useMutation({
    mutationFn: async () => {
      if (!user || !existingAuth) return;
      const { error } = await supabase
        .from("ach_authorizations")
        .update({
          is_active: false,
          revoked_at: new Date().toISOString(),
          revoked_by: user.id,
        })
        .eq("id", existingAuth.id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Authorization revoked" });
      qc.invalidateQueries({ queryKey: ["ach-authorization", stakeholderAccountId] });
    },
    onError: (e: any) => {
      toast({ title: "Revocation failed", description: e.message, variant: "destructive" });
    },
  });

  if (isLoading) return null;

  return (
    <div className="mt-2 space-y-2">
      {existingAuth ? (
        <div className="flex items-center justify-between p-3 rounded-md border bg-emerald-50/50 border-emerald-200">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-emerald-100 flex items-center justify-center">
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-emerald-900">ACH Debit Authorized</span>
                <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100">Active</Badge>
              </div>
              <p className="text-xs text-emerald-700">
                Signed by {existingAuth.authorized_name} on {format(new Date(existingAuth.created_at), "MMM d, yyyy")}
              </p>
            </div>
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            className="text-xs h-8 border-emerald-200 hover:bg-emerald-100 hover:text-emerald-900"
            onClick={() => {
              if (confirm("Are you sure you want to revoke this ACH authorization? You will not be able to disburse funds until a new authorization is signed.")) {
                revokeAuthorization.mutate();
              }
            }}
            disabled={revokeAuthorization.isPending}
          >
            {revokeAuthorization.isPending ? "Revoking..." : "Revoke"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 rounded-md border bg-amber-50 border-amber-200">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-amber-100 flex items-center justify-center">
                <AlertTriangle className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-amber-900">ACH debit not authorized</p>
                <p className="text-xs text-amber-700">Required for disbursements from this account.</p>
              </div>
            </div>
            <Button 
              variant="outline" 
              size="sm" 
              className="text-xs h-8 bg-white border-amber-200 hover:bg-amber-100"
              onClick={() => setShowForm(!showForm)}
            >
              {showForm ? "Hide form" : "Authorize now"}
            </Button>
          </div>

          {showForm && (
            <Card className="border-amber-200 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileText className="h-4 w-4 text-amber-600" />
                  ACH Debit Authorization Agreement
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 bg-muted rounded-md text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
                  {formText}
                </div>

                <div className="space-y-4 pt-2">
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">Type your full legal name to sign</Label>
                    <Input 
                      placeholder="Your Name" 
                      className="h-9"
                      value={signatureName}
                      onChange={(e) => setSignatureName(e.target.value)}
                    />
                  </div>

                  <div className="flex items-start gap-2">
                    <Checkbox 
                      id="agree" 
                      className="mt-0.5" 
                      checked={agreed}
                      onCheckedChange={(v) => setAgreed(!!v)}
                    />
                    <label 
                      htmlFor="agree" 
                      className="text-xs text-muted-foreground leading-tight cursor-pointer"
                    >
                      I confirm I am an authorized signer on account ending in ••••{accountLast4} and I agree to the terms above.
                    </label>
                  </div>

                  <Button 
                    className="w-full h-9" 
                    onClick={() => signAuthorization.mutate()}
                    disabled={!agreed || !signatureName.trim() || signAuthorization.isPending}
                  >
                    {signAuthorization.isPending ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Signing...</>
                    ) : (
                      "Sign & Authorize ACH Debits"
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}