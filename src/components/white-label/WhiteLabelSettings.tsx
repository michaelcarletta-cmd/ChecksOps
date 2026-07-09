import { useState, lazy, Suspense } from "react";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Navigate, Link } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { 
  LogOut, Building2, Users, Link2, CreditCard, Palette, ArrowLeft,
  Loader2, Save, Trash2, Receipt, Banknote, KeyRound, HelpCircle,
  ArrowDownToLine, FileBarChart, Gift, ShieldCheck, FileText
} from "lucide-react";
import { ReferralSettings } from "@/components/settings/ReferralSettings";
import { EmailSenderSettings } from "@/components/settings/EmailSenderSettings";
import { TenantEmailHealthPanel } from "@/components/settings/TenantEmailHealthPanel";
import { Mail } from "lucide-react";
import { CheckCenterHelpPanel } from "@/components/check-review/CheckCenterHelp";
import { StakeholderAccountSettings } from "@/components/disbursement/StakeholderAccountSettings";
import { TenantBankAccountSettings } from "@/components/settings/TenantBankAccountSettings";
import { TenantUserManager } from "./TenantUserManager";
import { TenantDocumentsManager } from "./TenantDocumentsManager";
import { TenantPartnerManager } from "./TenantPartnerManager";
import { TenantAIKeySettings } from "./TenantAIKeySettings";
import { ComplianceSettings } from "@/components/settings/ComplianceSettings";

import { ContractorServiceAreaCard } from "@/components/networking/ContractorServiceAreaCard";
import { ContractorLeadsCard } from "@/components/networking/ContractorLeadsCard";
import { ContractorVerificationStatusCard } from "@/components/networking/ContractorVerificationStatusCard";
import { Search as SearchIcon } from "lucide-react";

import { ChangePasswordCard } from "@/components/settings/ChangePasswordCard";
import { CheckUsageCard } from "@/components/billing/CheckUsageCard";
import { TenantUsageTracker } from "@/components/billing/TenantUsageTracker";
import { BillingConfigPanel } from "@/components/billing/BillingConfigPanel";
import { TenantBillingAccountPanel } from "@/components/settings/TenantBillingAccountPanel";
import { usePermissions } from "@/hooks/usePermissions";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isCheckOpsHost } from "@/lib/checkopsHost";

const FREEDOM_ADJUSTMENT_EMAIL = "mcarletta@freedomadj.com";

const DepositOperationsConsole = lazy(() =>
  import("@/components/deposit-ops/DepositOperationsConsole").then(m => ({ default: m.DepositOperationsConsole }))
);
const DepositReports = lazy(() =>
  import("@/components/deposit-ops/DepositReports").then(m => ({ default: m.DepositReports }))
);
const MortgageCompaniesDirectory = lazy(() =>
  import("@/components/checks/MortgageCompaniesDirectory").then(m => ({ default: m.MortgageCompaniesDirectory }))
);

function resolveTenantBase(slug?: string | null): string {
  if (!slug) return "";
  if (isCheckOpsHost()) return `/${slug}`;
  return `/wl/${slug}`;
}

const TabLoader = () => (
  <div className="flex items-center justify-center py-12">
    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
  </div>
);

const PageLoader = () => (
  <div className="min-h-screen flex items-center justify-center">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
  </div>
);

function MyVerificationStatus() {
  const { user } = useAuth();
  const { data: profileId } = useQuery({
    queryKey: ["my-contractor-profile-id", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("contractor_profiles")
        .select("id")
        .eq("user_id", user!.id)
        .maybeSingle();
      return data?.id ?? null;
    },
  });
  if (!profileId) return null;
  return <ContractorVerificationStatusCard contractorId={profileId} />;
}


export function WhiteLabelSettings() {
  const { tenant } = useTenant();
  const { user, loading } = useAuth();
  const { isAdmin } = usePermissions();

  if (loading) return <PageLoader />;
  if (!user) return <Navigate to={tenant?.slug ? `${resolveTenantBase(tenant.slug)}/login` : "/login"} replace />;
  const tenantBase = resolveTenantBase(tenant?.slug);

  return (
    <div className="min-h-screen bg-background">
      <header className="h-14 border-b border-border/70 bg-background/95 backdrop-blur flex items-center px-4 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          {tenant?.logo_url && (
            <img src={tenant.logo_url} alt={tenant.name} className="h-8 object-contain" />
          )}
          <span className="text-sm font-medium">{tenant?.name || "Settings"}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to={`${tenantBase}/checks`}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Back to Checks
            </Link>
          </Button>
          <Button variant="ghost" size="icon" onClick={() => supabase.auth.signOut()} title="Sign Out">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4 md:p-8">
        <h1 className="text-xl font-bold mb-6">Settings</h1>

        <Tabs defaultValue="profile" className="space-y-6">
          <TabsList className="w-full flex-wrap h-auto gap-1 bg-muted/50">
            <TabsTrigger value="profile" className="text-xs gap-1"><Building2 className="h-3 w-3" />Profile</TabsTrigger>
            <TabsTrigger value="usage" className="text-xs gap-1"><Receipt className="h-3 w-3" />Usage</TabsTrigger>
            <TabsTrigger value="ai-key" className="text-xs gap-1"><KeyRound className="h-3 w-3" />AI Key</TabsTrigger>
            <TabsTrigger value="users" className="text-xs gap-1"><Users className="h-3 w-3" />Users</TabsTrigger>

            <TabsTrigger value="partners" className="text-xs gap-1"><Link2 className="h-3 w-3" />Partners</TabsTrigger>
            <TabsTrigger value="banking" className="text-xs gap-1"><Banknote className="h-3 w-3" />Bank Accounts</TabsTrigger>
            <TabsTrigger value="disbursement" className="text-xs gap-1"><CreditCard className="h-3 w-3" />Disbursement</TabsTrigger>

            <TabsTrigger value="branding" className="text-xs gap-1"><Palette className="h-3 w-3" />Branding</TabsTrigger>
            <TabsTrigger value="referrals" className="text-xs gap-1"><Gift className="h-3 w-3" />Referrals</TabsTrigger>
            <TabsTrigger value="email" className="text-xs gap-1"><Mail className="h-3 w-3" />Email</TabsTrigger>
            <TabsTrigger value="compliance" className="text-xs gap-1"><ShieldCheck className="h-3 w-3" />Compliance & Docs</TabsTrigger>
            <TabsTrigger value="guide" className="text-xs gap-1"><HelpCircle className="h-3 w-3" />ChecksOps Guide</TabsTrigger>
            <TabsTrigger value="directory" className="text-xs gap-1"><SearchIcon className="h-3 w-3" />Find-a-Pro Directory</TabsTrigger>
          </TabsList>


          <TabsContent value="profile" className="space-y-6">
            {tenant && <ProfileSettings tenant={tenant} />}
            <ChangePasswordCard />
          </TabsContent>

          <TabsContent value="usage" className="space-y-4">
            <TenantUsageTracker />
            <TenantBillingAccountPanel />
          </TabsContent>


          <TabsContent value="ai-key">
            <TenantAIKeySettings />
          </TabsContent>


          <TabsContent value="users">
            {tenant && <TenantUserManager tenantId={tenant.id} />}
          </TabsContent>

          <TabsContent value="partners">
            <TenantPartnerManager />
          </TabsContent>

          <TabsContent value="banking">
            <TenantBankAccountSettings />
          </TabsContent>

          <TabsContent value="disbursement">
            <StakeholderAccountSettings />
          </TabsContent>

          <TabsContent value="branding">
            {tenant && <BrandingSettings tenant={tenant} />}
          </TabsContent>

          <TabsContent value="referrals">
            <ReferralSettings />
          </TabsContent>

          <TabsContent value="email" className="space-y-4">
            <EmailSenderSettings />
            <TenantEmailHealthPanel />
          </TabsContent>

          <TabsContent value="compliance" className="space-y-8">
            <ComplianceSettings />
            {tenant && (
              <div className="pt-6 border-t border-border/60">
                <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                  <FileText className="h-4 w-4" /> Tenant Documents
                </h3>
                <TenantDocumentsManager tenantId={tenant.id} />
              </div>
            )}
          </TabsContent>

          <TabsContent value="guide">
            <CheckCenterHelpPanel />
          </TabsContent>

          <TabsContent value="directory" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <SearchIcon className="h-4 w-4" /> How homeowners find you
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
                <p>
                  Verified ChecksOps contractors are listed on the public{" "}
                  <a href="/find-a-pro" target="_blank" rel="noreferrer" className="text-primary underline">
                    Find a Pro directory
                  </a>{" "}
                  at <code>checksops.com/find-a-pro</code>. Homeowners enter their ZIP to see contractors whose service
                  area covers them, sorted by distance from your home base.
                </p>
                <p>
                  Set your <strong>ZIP prefixes</strong> (broad coverage), <strong>home-base ZIP</strong> (auto-fills
                  lat/lng), and <strong>service radius</strong> below. A homeowner match happens when either their ZIP
                  starts with one of your prefixes <em>or</em> they fall inside your radius.
                </p>
              </CardContent>
            </Card>
            <MyVerificationStatus />
            <ContractorServiceAreaCard />
            <ContractorLeadsCard />
          </TabsContent>
        </Tabs>


      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Profile Settings                                                    */
/* ------------------------------------------------------------------ */

function ProfileSettings({ tenant }: { tenant: any }) {
  const { toast } = useToast();
  const [name, setName] = useState(tenant.name || "");
  const [saving, setSaving] = useState(false);
  const tenantUrl = isCheckOpsHost() ? `/${tenant.slug}/checks` : `/wl/${tenant.slug}/checks`;

  const handleSave = async () => {
    setSaving(true);
    const { error } = await supabase
      .from("tenants")
      .update({ name })
      .eq("id", tenant.id);
    setSaving(false);
    if (error) {
      toast({ title: "Failed to save", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Profile updated" });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Company Profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs">Company Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label className="text-xs">Slug (URL path)</Label>
          <Input value={tenant.slug} disabled className="opacity-60" />
          <p className="text-[10px] text-muted-foreground">Workspace URL: {tenantUrl}</p>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">Partner Code</Label>
          <Input value={tenant.partner_code || "—"} disabled className="font-mono tracking-widest opacity-60" />
          <p className="text-[10px] text-muted-foreground">Share this code with partners for check sharing.</p>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">Plan</Label>
          <Badge variant="outline">{tenant.plan_tier}</Badge>
        </div>
        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
          Save Changes
        </Button>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Banking Settings                                                    */
/* ------------------------------------------------------------------ */

function BankingSettings({ tenantId }: { tenantId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [bankName, setBankName] = useState("");
  const [holderName, setHolderName] = useState("");
  const [routingNumber, setRoutingNumber] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountType, setAccountType] = useState("checking");

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["tenant-bank-accounts", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_bank_accounts")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      if (!bankName || !holderName || !routingNumber || !accountNumber) {
        throw new Error("All fields are required");
      }
      const last4 = accountNumber.slice(-4);
      const { error } = await supabase.from("tenant_bank_accounts").insert({
        tenant_id: tenantId,
        bank_name: bankName,
        account_holder_name: holderName,
        routing_number: routingNumber,
        account_number_last4: last4,
        account_type: accountType,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Bank account added" });
      setShowForm(false);
      setBankName("");
      setHolderName("");
      setRoutingNumber("");
      setAccountNumber("");
      qc.invalidateQueries({ queryKey: ["tenant-bank-accounts", tenantId] });
    },
    onError: (e: any) => {
      toast({ title: "Failed to add", description: e.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("tenant_bank_accounts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Bank account removed" });
      qc.invalidateQueries({ queryKey: ["tenant-bank-accounts", tenantId] });
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center justify-between">
            <span>Bank Accounts</span>
            {!showForm && (
              <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
                Add Account
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-4">
            Bank account information for receiving digital deposits. Full account numbers are never stored — only the last 4 digits are saved for identification.
          </p>

          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : accounts.length === 0 && !showForm ? (
            <div className="text-sm text-muted-foreground">No bank accounts configured yet.</div>
          ) : (
            <div className="space-y-3">
              {accounts.map((acct: any) => (
                <div key={acct.id} className="flex items-center justify-between rounded-md border border-border/60 px-4 py-3">
                  <div>
                    <div className="text-sm font-medium">{acct.bank_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {acct.account_holder_name} · {acct.account_type} · ••••{acct.account_number_last4}
                    </div>
                    <div className="text-xs text-muted-foreground">Routing: {acct.routing_number}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {acct.is_primary && <Badge variant="outline" className="text-[10px]">Primary</Badge>}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={() => {
                        if (confirm("Remove this bank account?")) deleteMutation.mutate(acct.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {showForm && (
            <div className="mt-4 space-y-3 border border-border/60 rounded-lg p-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Bank Name</Label>
                  <Input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. Chase" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Account Holder Name</Label>
                  <Input value={holderName} onChange={(e) => setHolderName(e.target.value)} placeholder="Company LLC" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Routing Number</Label>
                  <Input value={routingNumber} onChange={(e) => setRoutingNumber(e.target.value.replace(/\D/g, ""))} maxLength={9} placeholder="9 digits" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Account Number</Label>
                  <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ""))} placeholder="Full account number" type="password" />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Account Type</Label>
                <Select value={accountType} onValueChange={setAccountType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="checking">Checking</SelectItem>
                    <SelectItem value="savings">Savings</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2 pt-2">
                <Button size="sm" onClick={() => addMutation.mutate()} disabled={addMutation.isPending}>
                  {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  Save Account
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Branding Settings                                                   */
/* ------------------------------------------------------------------ */

function BrandingSettings({ tenant }: { tenant: any }) {
  const { toast } = useToast();
  const [primaryColor, setPrimaryColor] = useState(tenant.primary_color || "#3B82F6");
  const [secondaryColor, setSecondaryColor] = useState(tenant.secondary_color || "#1E40AF");
  const [logoUrl, setLogoUrl] = useState(tenant.logo_url || "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const handleLogoUpload = async (file: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Invalid file", description: "Please choose an image file (PNG, JPG, SVG).", variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "File too large", description: "Logo must be under 5MB.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop() || "png";
      const path = `${tenant.id}/logo-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("tenant-logos")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from("tenant-logos").getPublicUrl(path);
      setLogoUrl(data.publicUrl);
      toast({ title: "Logo uploaded", description: "Click Save to apply." });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    const { error } = await supabase
      .from("tenants")
      .update({
        primary_color: primaryColor,
        secondary_color: secondaryColor,
        logo_url: logoUrl || null,
      })
      .eq("id", tenant.id);
    setSaving(false);
    if (error) {
      toast({ title: "Failed to save", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Branding updated", description: "Refresh to see changes." });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Branding & Appearance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs">Logo</Label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="logo-upload-input"
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleLogoUpload(f);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => document.getElementById("logo-upload-input")?.click()}
            >
              {uploading ? "Uploading..." : logoUrl ? "Replace logo" : "Upload logo"}
            </Button>
            {logoUrl && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setLogoUrl("")}>
                Remove
              </Button>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Or paste a URL</Label>
            <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://..." />
          </div>
          {logoUrl && (
            <div className="mt-2 p-3 border border-border/60 rounded-md inline-block bg-white">
              <img src={logoUrl} alt="Logo preview" className="h-10 object-contain" />
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-xs">Primary Color</Label>
            <div className="flex items-center gap-2">
              <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="h-8 w-8 rounded cursor-pointer" />
              <Input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="font-mono text-xs" />
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Secondary Color</Label>
            <div className="flex items-center gap-2">
              <input type="color" value={secondaryColor} onChange={(e) => setSecondaryColor(e.target.value)} className="h-8 w-8 rounded cursor-pointer" />
              <Input value={secondaryColor} onChange={(e) => setSecondaryColor(e.target.value)} className="font-mono text-xs" />
            </div>
          </div>
        </div>
        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
          Save Branding
        </Button>
      </CardContent>
    </Card>
  );
}
