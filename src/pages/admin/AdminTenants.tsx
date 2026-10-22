import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PLATFORM_OWNER_EMAIL, isPlatformOwner } from "@/lib/masterMerchant";
import { TenantMoovIdentityCard } from "@/components/admin/TenantMoovIdentityCard";
import { TenantManagementV2Dashboard } from "@/components/admin/TenantManagementV2Dashboard";
import { PlatformBankPanel } from "@/components/admin/PlatformBankPanel";
import { PlatformTreasuryPanel } from "@/components/admin/PlatformTreasuryPanel";
import { PlatformFeeDestinationCard, TenantBillingVerifyButton, TenantFeeCollectButton } from "@/components/admin/TenantFeeCollection";
import { billingPeriodKey } from "@/lib/tenantFeeBilling";
import { TenantDepositsSwitch } from "@/components/admin/TenantDepositsSwitch";
import { useNavigate, useSearchParams } from "react-router-dom";
import { resolveAdminTenantTab } from "@/lib/adminTenantTab";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/hooks/use-toast";
import { Megaphone, Loader2, Plus, Trash2, Mail, Building2, Users, Settings, ArrowLeft, RefreshCw, Copy, FileText, Receipt, Link2, Gift, ShieldCheck, Eye, Crosshair, Briefcase, Home, Calculator, Landmark, Wallet, LogOut, Banknote } from "lucide-react";
import { goToChecksOpsHome } from "@/lib/goToChecksOpsHome";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { SettingsHero } from "@/components/settings/SettingsHero";
import { SectionCard } from "@/components/settings/SectionCard";


import { isCheckOpsHost } from "@/lib/checkopsHost";

import { CheckAltSettings } from "@/components/settings/CheckAltSettings";
import { CheckAltTenantAccountCard } from "@/components/settings/CheckAltTenantAccountCard";
import { ComplianceSettings } from "@/components/settings/ComplianceSettings";
import { AdminReferralDashboard } from "@/components/settings/AdminReferralDashboard";
import { PlatformAnnouncementsManager } from "@/components/admin/PlatformAnnouncementsManager";
import { MortgageAgentsPanel } from "@/components/admin/MortgageAgentsPanel";
import { TenantProBadgeManagement } from "@/components/settings/TenantProBadgeManagement";

import { TenantProvider } from "@/contexts/TenantContext";
import { tenantMoovDefaults } from "@/lib/payments/tenantMoovDefaults";
import { saveTenantPricing, type TenantPricingPatch } from "@/lib/tenantPricing";
import { removeTenantMember, resendTenantInvite, saveTenantProfile, type TenantProfilePatch } from "@/lib/tenantProfile";
import { isAwsStaging } from "@/lib/awsStaging";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataView, FilterBar, type DataColumn } from "@/components/shell";


const ALLOWED_EMAIL = PLATFORM_OWNER_EMAIL;

type Tenant = {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  custom_domain: string | null;
  subscription_status: string | null;
  plan_tier: string | null;
  is_test_account?: boolean | null;
  max_checks_per_month: number | null;
  email_from_name: string | null;
  email_from_address: string | null;
  email_reply_to: string | null;
  partner_code: string | null;
  is_system_tenant: boolean | null;
  per_check_billing_enabled?: boolean | null;
  /** SQL 98 deposits switch (platform owner only); absent = on. */
  deposits_enabled?: boolean | null;
  per_check_rate_cents?: number | null;
  monthly_rate_cents?: number | null;
  referral_code?: string | null;
  referral_discount_cents?: number | null;
  next_day_rate_cents?: number | null;
  same_day_rate_cents?: number | null;
  mortgage_ops_initial_rate_cents?: number | null;
  mortgage_ops_additional_rate_cents?: number | null;
  kyc_status?: string | null;
  kyc_notes?: string | null;
  internal_notes?: string | null;
  created_at: string;
};


type TenantUserRow = {
  id: string;
  user_id: string;
  role: string;
  email?: string;
  full_name?: string;
};


export default function AdminTenants() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveAdminTenantTab(searchParams.get("tab"));
  const [authChecked, setAuthChecked] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Tenant | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const email = session?.user?.email?.toLowerCase();
      const userId = session?.user?.id;
      // Prefer application UUID (matches is_master_owner()); email is secondary.
      setAuthorized(isPlatformOwner(email, userId));
      setAuthChecked(true);
    })();
  }, []);

  useEffect(() => {
    if (authorized) loadTenants();
  }, [authorized]);

  const loadTenants = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("tenants")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) toast({ title: "Failed to load tenants", description: error.message, variant: "destructive" });
    setTenants((data as Tenant[]) || []);
    setLoading(false);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!authorized) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>Access Restricted</CardTitle>
            <CardDescription>
              This admin area is only accessible to the master merchant account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate("/login")} className="w-full">Back to Login</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (selected) {
    return (
      <TenantDetail
        tenant={selected}
        onBack={() => { setSelected(null); loadTenants(); }}
        onUpdated={(t) => { setSelected(t); }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 sm:px-6">
      <SettingsPageShell className="max-w-[1600px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}>
              <ArrowLeft className="w-4 h-4 mr-1" /> Back
            </Button>
            <Button variant="ghost" size="sm" onClick={() => goToChecksOpsHome(navigate)}>
              <Home className="w-4 h-4 mr-1" /> Home
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/admin/mortgage-ops")}>
              <Briefcase className="w-4 h-4 sm:mr-1" /> <span className="hidden sm:inline">Mortgage Ops</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate("/admin/financial-model")}>
              <Calculator className="w-4 h-4 sm:mr-1" /> <span className="hidden sm:inline">Financial Model</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={loadTenants}>
              <RefreshCw className="w-4 h-4 sm:mr-1" /> <span className="hidden sm:inline">Refresh</span>
            </Button>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm"><Plus className="w-4 h-4 mr-1" /> New Tenant</Button>
              </DialogTrigger>
              <CreateTenantDialog onCreated={(t) => { setCreateOpen(false); loadTenants(); setSelected(t); }} />
            </Dialog>
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                await supabase.auth.signOut();
                navigate("/login");
              }}
            >
              <LogOut className="w-4 h-4 sm:mr-1" /> <span className="hidden sm:inline">Log Out</span>
            </Button>
          </div>
        </div>

        <SettingsHero
          title="Tenant Management"
          description={`Master merchant control panel — review, approve, and configure every tenant. Signed in as ${ALLOWED_EMAIL}.`}
          badge="Administration"
          icon={<Building2 className="h-4 w-4 text-primary" />}
        />

        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            const next = new URLSearchParams(searchParams);
            if (value === "tenants") next.delete("tab");
            else next.set("tab", value);
            setSearchParams(next, { replace: true });
          }}
          className="w-full"
        >
          <TabsList className="mb-6 w-full justify-start overflow-x-auto flex-nowrap">

            <TabsTrigger value="tenants"><Building2 className="w-4 h-4 mr-1" /> Tenants</TabsTrigger>
            <TabsTrigger value="mortgage-agents"><Briefcase className="w-4 h-4 mr-1" /> Mortgage Agents</TabsTrigger>
            <TabsTrigger value="platform-finance"><Landmark className="w-4 h-4 mr-1" /> Platform Finance</TabsTrigger>
            <TabsTrigger value="checkalt"><Banknote className="w-4 h-4 mr-1" /> CheckAlt</TabsTrigger>
            <TabsTrigger value="referrals"><Gift className="w-4 h-4 mr-1" /> Referral Dashboard</TabsTrigger>
            <TabsTrigger value="announcements"><Megaphone className="w-4 h-4 mr-1" /> Announcements</TabsTrigger>

          </TabsList>
          <TabsContent value="tenants">
            {loading ? (
              <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : tenants.length === 0 ? (
              <Card><CardContent className="py-16 text-center text-muted-foreground">No tenants yet. Click "New Tenant" to add one.</CardContent></Card>
            ) : (
              <TenantManagementTable
                tenants={tenants}
                onOpen={(t) => setSelected(t)}
                onChanged={loadTenants}
              />
            )}
          </TabsContent>
          <TabsContent value="platform-finance">
            <Tabs defaultValue="banking" className="w-full">
              <TabsList className="mb-4">
                <TabsTrigger value="banking"><Landmark className="w-4 h-4 mr-1" /> Banking</TabsTrigger>
                <TabsTrigger value="treasury"><Wallet className="w-4 h-4 mr-1" /> Wallet &amp; P&amp;L</TabsTrigger>
              </TabsList>
              <TabsContent value="banking">
                <PlatformBankPanel />
              </TabsContent>
              <TabsContent value="treasury">
                <PlatformTreasuryPanel />
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="checkalt">
            <CheckAltSettings />
          </TabsContent>
          <TabsContent value="referrals">
            <AdminReferralDashboard />
          </TabsContent>
          <TabsContent value="announcements">
            <PlatformAnnouncementsManager />
          </TabsContent>
          <TabsContent value="mortgage-agents">
            <MortgageAgentsPanel />
          </TabsContent>

        </Tabs>

      </SettingsPageShell>
    </div>

  );
}

/* ---------------- Create Tenant Dialog ---------------- */

function CreateTenantDialog({ onCreated }: { onCreated: (t: Tenant) => void }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const slugify = (s: string) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  const submit = async () => {
    if (!name.trim() || !slug.trim()) {
      toast({ title: "Name and slug are required", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    const { data, error } = await supabase
      .from("tenants")
      .insert({ name: name.trim(), slug: slug.trim(), ...tenantMoovDefaults() })
      .select()
      .single();
    setSubmitting(false);
    if (error) {
      toast({ title: "Create failed", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Tenant created", description: `${name} is ready to configure.` });
    onCreated(data as Tenant);
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Create New Tenant</DialogTitle>
        <DialogDescription>Add a new client company. You can add contact info and invite users next.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <Label>Company Name</Label>
          <Input value={name} onChange={(e) => { setName(e.target.value); if (!slug) setSlug(slugify(e.target.value)); }} placeholder="Acme Inspections" />
        </div>
        <div className="space-y-2">
          <Label>Slug (URL identifier)</Label>
          <Input value={slug} onChange={(e) => setSlug(slugify(e.target.value))} placeholder="acme-inspections" />
          <p className="text-xs text-muted-foreground">Used in checksops.com/{slug || "..."}</p>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={submitting}>
          {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Create Tenant
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* ---------------- Tenant Detail (with tabs) ---------------- */

function TenantDetail({ tenant, onBack, onUpdated }: { tenant: Tenant; onBack: () => void; onUpdated: (t: Tenant) => void }) {
  const [proOpen, setProOpen] = useState(false);

  return (
    <TenantProvider slug={tenant.slug}>
    <div className="min-h-screen bg-background px-6">
      <SettingsPageShell className="max-w-5xl">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="w-4 h-4 mr-1" /> All Tenants</Button>
          <Separator orientation="vertical" className="h-6" />
          <div
            className="w-8 h-8 rounded-md flex items-center justify-center text-primary-foreground font-semibold text-xs"
            style={{ backgroundColor: tenant.primary_color || "hsl(var(--primary))" }}
          >
            {tenant.name.slice(0, 2).toUpperCase()}
          </div>
        </div>

        <SettingsHero
          title={tenant.name}
          description={`Configure company details, compliance, billing and users for /${tenant.slug}. The company manages its own branding in its settings.`}
          badge="Tenant Settings"
          icon={<Building2 className="h-4 w-4 text-primary" />}
        />

        <Tabs defaultValue="overview" className="w-full">

          <TabsList className="flex w-full flex-wrap h-auto justify-start gap-1 p-1">
            <TabsTrigger value="overview" className="flex-1 min-w-[150px] whitespace-nowrap"><Building2 className="w-4 h-4 mr-1" /> Organization 360</TabsTrigger>
            <TabsTrigger value="company" className="flex-1 min-w-[110px] whitespace-nowrap"><Building2 className="w-4 h-4 mr-1" /> Company</TabsTrigger>
            <TabsTrigger value="compliance" className="flex-1 min-w-[170px] whitespace-nowrap"><ShieldCheck className="w-4 h-4 mr-1" /> Compliance & Docs</TabsTrigger>
            <TabsTrigger value="integrations" className="flex-1 min-w-[130px] whitespace-nowrap"><Link2 className="w-4 h-4 mr-1" /> Integrations</TabsTrigger>
            
            <TabsTrigger value="billing" className="flex-1 min-w-[100px] whitespace-nowrap"><Receipt className="w-4 h-4 mr-1" /> Billing & Usage</TabsTrigger>
            <TabsTrigger value="pro-badge" className="flex-1 min-w-[115px] whitespace-nowrap"><Crosshair className="w-4 h-4 mr-1" strokeWidth={2.5} /> OPS Badge</TabsTrigger>
            <TabsTrigger value="users" className="flex-1 min-w-[95px] whitespace-nowrap"><Users className="w-4 h-4 mr-1" /> Users</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-6">
            <TenantManagementV2Dashboard tenantId={tenant.id} />
          </TabsContent>
          <TabsContent value="company" className="mt-6">
            <CompanyTab tenant={tenant} onUpdated={onUpdated} />
          </TabsContent>
          <TabsContent value="compliance" className="mt-6 space-y-8">
            {/* Read-only by default; the platform owner opts in with "Edit on behalf of tenant". */}
            <ComplianceSettings tenantId={tenant.id} adminView />
          </TabsContent>
          <TabsContent value="integrations" className="mt-6 space-y-6">
            <TenantMoovIdentityCard tenantId={tenant.id} tenantName={tenant.name} />
            <CheckAltTenantAccountCard />
          </TabsContent>
          <TabsContent value="billing" className="mt-6 space-y-6">
            <BillingTab tenant={tenant} onUpdated={onUpdated} />
            <TenantDepositsSwitch
              tenantId={tenant.id}
              tenantName={tenant.name}
              depositsEnabled={tenant.deposits_enabled}
              onSaved={(enabled) => onUpdated({ ...tenant, deposits_enabled: enabled })}
            />
            <PlatformFeeDestinationCard />
            <TenantBillingBankPanel tenantId={tenant.id} tenantName={tenant.name} />
            <TenantUsageInlinePanel tenantId={tenant.id} tenantName={tenant.name} />
          </TabsContent>
          <TabsContent value="pro-badge" className="mt-6">
            <SectionCard
              title="Contractor OPS Badge"
              icon={<Crosshair className="h-4 w-4 text-primary" strokeWidth={2.5} />}
              accent="bg-gradient-to-r from-primary to-primary/40"
              description="Approve or revoke the Find-a-Pro badge for contractor profiles in this tenant."
            >
              <Button onClick={() => setProOpen(true)}>
                <Crosshair className="w-4 h-4 mr-2" strokeWidth={2.5} /> Manage OPS Badge
              </Button>
            </SectionCard>

          </TabsContent>
          <TabsContent value="users" className="mt-6">
            <UsersTab tenant={tenant} />
          </TabsContent>
        </Tabs>
        <TenantProBadgeManagement
          tenantId={tenant.id}
          tenantName={tenant.name}
          isOpen={proOpen}
          onClose={() => setProOpen(false)}
        />
      </SettingsPageShell>
    </div>

    </TenantProvider>
  );
}



/* ---------------- Tabs ---------------- */

// Company details are the platform owner's (tenant-billing-admin
// profile-update, SQL 102); the slug and partner code are permanent and never sent.
function useTenantSave(tenant: Tenant, onUpdated: (t: Tenant) => void) {
  const [saving, setSaving] = useState(false);
  const save = async (patch: TenantProfilePatch) => {
    setSaving(true);
    try {
      const saved = await saveTenantProfile<Partial<Tenant>>(tenant.id, patch);
      toast({ title: "Saved" });
      onUpdated({ ...tenant, ...patch, ...(saved ?? {}) } as Tenant);
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : "Company details were not saved", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  return { saving, save };
}

function CompanyTab({ tenant, onUpdated }: { tenant: Tenant; onUpdated: (t: Tenant) => void }) {
  const [name, setName] = useState(tenant.name);
  const [customDomain, setCustomDomain] = useState(tenant.custom_domain || "");
  const [subStatus, setSubStatus] = useState(tenant.subscription_status || "inactive");
  const [isTest, setIsTest] = useState(!!(tenant as any).is_test_account);
  const [maxChecks, setMaxChecks] = useState<number | "">(tenant.max_checks_per_month ?? 100);
  const { saving, save } = useTenantSave(tenant, onUpdated);

  // Show what the server saved (it normalizes the domain and derives test mode).
  useEffect(() => {
    setName(tenant.name);
    setCustomDomain(tenant.custom_domain || "");
    setSubStatus(tenant.subscription_status || "inactive");
    setIsTest(!!tenant.is_test_account);
    setMaxChecks(tenant.max_checks_per_month ?? 100);
  }, [tenant]);

  return (
    <SectionCard
      title="Company"
      icon={<Building2 className="h-4 w-4 text-primary" />}
      accent="bg-gradient-to-r from-primary to-primary/40"
      description="Core info, URL, subscription status, and usage limits."
    >

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2"><Label>Company Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-2">
            <Label>Slug</Label>
            <Input value={tenant.slug} readOnly disabled className="font-mono" />
            <p className="text-xs text-muted-foreground">Permanent.</p>
          </div>
        </div>
        <div className="space-y-2">
          <Label>Custom Domain</Label>
          <Input value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} placeholder="checks.acme.com" />
          <p className="text-xs text-muted-foreground">Optional. If set, the tenant's portal lives at this domain.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Subscription Status</Label>
            <Select value={subStatus} onValueChange={setSubStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">active</SelectItem>
                <SelectItem value="trialing">trialing</SelectItem>
                <SelectItem value="past_due">past_due</SelectItem>
                <SelectItem value="inactive">inactive</SelectItem>
                <SelectItem value="cancelled">cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Max Checks / Month</Label>
            <Input
              type="number"
              min={0}
              step={1}
              value={maxChecks}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setMaxChecks(e.target.value === "" || !Number.isFinite(n) ? "" : Math.max(0, n));
              }}
            />
            {maxChecks === "" && <p className="text-xs text-muted-foreground">Enter a whole number (0 or more).</p>}
          </div>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 p-3">
          <div className="space-y-0.5">
            <Label>Test Account</Label>
            <p className="text-xs text-muted-foreground">
              Marks this organization as a demo account so prospects can explore the platform before purchasing.
              Test accounts run on the payment provider's sandbox ledger — no real money moves.
            </p>
          </div>
          <Switch checked={isTest} onCheckedChange={setIsTest} />
        </div>
        {tenant.partner_code && (
          <div className="space-y-2">
            <Label>Partner Code</Label>
            <div className="flex gap-2">
              <Input value={tenant.partner_code} readOnly className="font-mono" />
              <Button variant="outline" size="icon" onClick={() => { navigator.clipboard.writeText(tenant.partner_code!); toast({ title: "Copied" }); }}>
                <Copy className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Permanent.</p>
          </div>
        )}
        <Button
          onClick={() => {
            // Only changed fields are sent, so an untouched legacy value never blocks a save.
            const patch: TenantProfilePatch = {};
            const domain = customDomain.trim().toLowerCase() || null;
            if (name.trim() !== tenant.name) patch.name = name.trim();
            if (domain !== (tenant.custom_domain || null)) patch.custom_domain = domain;
            if (subStatus !== (tenant.subscription_status || "inactive")) patch.subscription_status = subStatus;
            if (maxChecks !== "" && maxChecks !== tenant.max_checks_per_month) patch.max_checks_per_month = maxChecks;
            if (isTest !== !!tenant.is_test_account) patch.is_test_account = isTest;
            if (Object.keys(patch).length === 0) {
              toast({ title: "No changes to save" });
              return;
            }
            save(patch);
          }}
          disabled={saving || !name.trim() || maxChecks === ""}
          title={!name.trim() ? "Enter a company name" : maxChecks === "" ? "Enter the max checks per month" : undefined}
        >
          {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save Changes
        </Button>

    </SectionCard>

  );
}


/* ---------------- Users Tab ---------------- */

function UsersTab({ tenant }: { tenant: Tenant }) {
  const [users, setUsers] = useState<TenantUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviting, setInviting] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data: tu, error } = await supabase
      .from("tenant_users")
      .select("id, user_id, role")
      .eq("tenant_id", tenant.id);
    if (error) {
      toast({ title: "Failed to load users", description: error.message, variant: "destructive" });
      setLoading(false);
      return;
    }
    const ids = (tu || []).map((r) => r.user_id);
    let profileMap: Record<string, { email?: string; full_name?: string }> = {};
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("id, email, full_name").in("id", ids);
      profs?.forEach((p: any) => { profileMap[p.id] = { email: p.email, full_name: p.full_name }; });
    }
    setUsers((tu || []).map((r) => ({ ...r, ...profileMap[r.user_id] })));
    setLoading(false);
  };

  useEffect(() => { load(); }, [tenant.id]);

  const invite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    const { data, error } = await supabase.functions.invoke("tenant-invite-user", {
      body: {
        tenant_id: tenant.id,
        email: inviteEmail.trim().toLowerCase(),
        full_name: inviteName.trim() || null,
      },
    });
    setInviting(false);
    if (error || (data as any)?.error) {
      // Platform-owner page: show the API's reason with the code, so a failed invite can be diagnosed.
      const reason = (data as any)?.message;
      const code = error?.message || (data as any)?.error;
      toast({ title: "Invite failed", description: reason && reason !== code ? `${code}: ${reason}` : code, variant: "destructive" });
      return;
    }
    const inviteSent = (data as any)?.invite_sent;
    const inviteErrMsg = (data as any)?.invite_error;
    toast({
      title: (data as any)?.is_new_user ? "User created" : "User added to tenant",
      description: (inviteSent
        ? `Invite email sent to ${inviteEmail}`
        : `User added but email failed${inviteErrMsg ? `: ${inviteErrMsg}` : ""}. Use the Resend button.`)
        + (tenant.subscription_status !== "active" ? " Note: this organization is inactive, so the user can't sign in until it's activated." : ""),
      variant: inviteSent ? "default" : "destructive",
    });
    setInviteEmail("");
    setInviteName("");
    load();
  };

  const [busyMember, setBusyMember] = useState<string | null>(null);

  const resendInvite = async (email: string) => {
    if (!isAwsStaging()) {
      const tenantBaseUrl = tenant.custom_domain ? `https://${tenant.custom_domain}` : `https://checksops.com/${tenant.slug}`;
      const redirectTo = `${tenantBaseUrl}/login`;
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `https://checksops.com/reset-password?next=${encodeURIComponent(redirectTo)}`,
      });
      if (error) { toast({ title: "Resend failed", description: error.message, variant: "destructive" }); return; }
      toast({ title: "Reset link resent", description: `Sent to ${email}` });
      return;
    }
    setBusyMember(email);
    try {
      const result = await resendTenantInvite(tenant.id, email);
      toast(result.invite_sent
        ? { title: "Invite resent", description: `Sent to ${email}` }
        : {
            title: "Invite email failed",
            description: result.invite_error || "The email could not be sent. Try again later.",
            variant: "destructive",
          });
    } catch (e) {
      toast({ title: "Resend failed", description: e instanceof Error ? e.message : "The invite was not sent", variant: "destructive" });
    } finally {
      setBusyMember(null);
    }
  };

  // The server removes by login (user_id), not by the tenant_users row id.
  const remove = async (userId: string) => {
    if (!confirm("Remove this user from the tenant? Their account is not deleted.")) return;
    setBusyMember(userId);
    try {
      await removeTenantMember(tenant.id, userId);
      toast({ title: "User removed" });
      load();
    } catch (e) {
      toast({ title: "Remove failed", description: e instanceof Error ? e.message : "The user was not removed", variant: "destructive" });
    } finally {
      setBusyMember(null);
    }
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="Invite User"
        icon={<Mail className="h-4 w-4 text-sky-500" />}
        accent="bg-gradient-to-r from-sky-500 to-sky-500/30"
        description="Adds the user to this tenant and emails them a tenant-branded reset link to set their password."
      >
        <div className="flex gap-2">
          <Input placeholder="Full name (optional)" value={inviteName} onChange={(e) => setInviteName(e.target.value)} className="flex-1" />
        </div>
        <div className="flex gap-2">
          <Input placeholder="user@example.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="flex-1" />
          <Button onClick={invite} disabled={inviting}>
            {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4 mr-1" />} Invite
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title={`Tenant Members (${users.length})`}
        icon={<Users className="h-4 w-4 text-violet-500" />}
        accent="bg-gradient-to-r from-violet-500 to-violet-500/30"
      >

          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : users.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No members yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {users.map((u) => (
                <div key={u.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{u.full_name || u.email || u.user_id}</p>
                    {u.email && <p className="text-xs text-muted-foreground truncate">{u.email}</p>}
                  </div>
                  {u.email && (
                    <Button variant="outline" size="sm" onClick={() => resendInvite(u.email!)} disabled={busyMember === u.email} title="Resend invite email">
                      <Mail className="w-4 h-4" />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => remove(u.user_id)} disabled={busyMember === u.user_id} className="text-destructive" title="Remove from tenant">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
      </SectionCard>

    </div>
  );
}

function BillingTab({ tenant, onUpdated }: { tenant: Tenant; onUpdated: (t: Tenant) => void }) {
  const [enabled, setEnabled] = useState(tenant.per_check_billing_enabled || false);
  const [rate, setRate] = useState(tenant.per_check_rate_cents || 0);
  const [nextDay, setNextDay] = useState<number | "">(tenant.next_day_rate_cents ?? "");
  const [sameDay, setSameDay] = useState<number | "">(tenant.same_day_rate_cents ?? "");
  const [mortgageInitial, setMortgageInitial] = useState<number | "">(tenant.mortgage_ops_initial_rate_cents ?? "");
  const [mortgageAdditional, setMortgageAdditional] = useState<number | "">(tenant.mortgage_ops_additional_rate_cents ?? "");
  const [saving, setSaving] = useState(false);

  // Pricing is the platform owner's (tenant-billing-admin, SQL 96); it never
  // goes through the generic tenants update.
  // Only rates the owner changed are sent; a rate they blanked is sent as
  // null, which clears the override (default rate).
  const save = async () => {
    const patch: TenantPricingPatch = {
      per_check_billing_enabled: enabled,
      per_check_rate_cents: rate,
    };
    const rateChange = (
      key: "next_day_rate_cents" | "same_day_rate_cents" | "mortgage_ops_initial_rate_cents" | "mortgage_ops_additional_rate_cents",
      value: number | "",
    ) => {
      const next = value === "" ? null : value;
      if (next !== (tenant[key] ?? null)) patch[key] = next;
    };
    rateChange("next_day_rate_cents", nextDay);
    rateChange("same_day_rate_cents", sameDay);
    rateChange("mortgage_ops_initial_rate_cents", mortgageInitial);
    rateChange("mortgage_ops_additional_rate_cents", mortgageAdditional);
    setSaving(true);
    try {
      const saved = await saveTenantPricing(tenant.id, patch);
      const values = { ...patch, ...(saved ?? {}) };
      const asInput = (v: number | null | undefined): number | "" => (v == null ? "" : v);
      if (typeof values.per_check_billing_enabled === "boolean") setEnabled(values.per_check_billing_enabled);
      if (typeof values.per_check_rate_cents === "number") setRate(values.per_check_rate_cents);
      setNextDay(asInput(values.next_day_rate_cents));
      setSameDay(asInput(values.same_day_rate_cents));
      setMortgageInitial(asInput(values.mortgage_ops_initial_rate_cents));
      setMortgageAdditional(asInput(values.mortgage_ops_additional_rate_cents));
      toast({ title: "Saved" });
      onUpdated({ ...tenant, ...values });
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : "Pricing was not saved", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const centsInput = (
    id: string,
    label: string,
    value: number | "",
    setValue: (v: number | "") => void,
  ) => (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input
        id={id}
        type="number"
        min={0}
        value={value}
        placeholder="Default"
        onChange={(e) => setValue(e.target.value === "" ? "" : Math.max(0, parseInt(e.target.value) || 0))}
      />
    </div>
  );

  return (
    <SectionCard
      title="Per-Check Billing"
      icon={<Receipt className="h-4 w-4 text-amber-500" />}
      accent="bg-gradient-to-r from-amber-500 to-amber-500/30"
      description="Configure what this tenant is billed. Only the ChecksOps platform owner can change these; every change is audited."
    >

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>Enable Per-Check Billing</Label>
            <p className="text-xs text-muted-foreground">If enabled, every check that reaches "deposited" status generates a billing event.</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="space-y-2">
          <Label>Standard Check Rate (cents)</Label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              value={rate}
              onChange={(e) => setRate(parseInt(e.target.value) || 0)}
              disabled={!enabled}
              className="max-w-[200px]"
            />
            <span className="text-sm text-muted-foreground font-mono">
              = ${(rate / 100).toFixed(2)} per check
            </span>
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <h3 className="text-sm font-medium">Deposit speed rates (cents)</h3>
          <p className="text-xs text-muted-foreground">Leave empty to use the default rate.</p>
          <div className="grid grid-cols-2 gap-4">
            {centsInput("next-day-rate", "Next Day Credit", nextDay, setNextDay)}
            {centsInput("same-day-rate", "Same Day Credit", sameDay, setSameDay)}
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <h3 className="text-sm font-medium">MortgageOps rates (cents)</h3>
          <div className="grid grid-cols-2 gap-4">
            {centsInput("mortgage-initial-rate", "Initial request", mortgageInitial, setMortgageInitial)}
            {centsInput("mortgage-additional-rate", "Each additional request", mortgageAdditional, setMortgageAdditional)}
          </div>
        </div>

        <Button onClick={save} disabled={saving}>
          {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save Billing Settings
        </Button>
    </SectionCard>

  );
}

/* ---------------- Bank Account (tenant fees are pulled from it) ---------------- */

function TenantBillingBankPanel({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const [bank, setBank] = useState<any>(null);
  const [billing, setBilling] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadFailed(false);
    const { data: b, error: billingError } = await supabase
      .from("tenant_billing_accounts")
      // "*": provider_payment_method_id (the server's readiness field) is not in every schema.
      .select("*")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    setLoadFailed(!!billingError);
    setBilling(b);

    if (b?.stakeholder_account_id) {
      const { data: sa } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, chk_acct, acct_type, custname, verification_status, verified_at")
        .eq("id", b.stakeholder_account_id)
        .maybeSingle();
      setBank(sa);
    } else {
      // Fall back: show any active verified account so admin sees it exists
      const { data: any1 } = await supabase
        .from("stakeholder_accounts")
        .select("id, nickname, chk_acct, acct_type, custname, verification_status, verified_at")
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .in("verification_status", ["verified", "admin_override"])
        .order("verified_at", { ascending: false, nullsFirst: false })
        .limit(1);
      setBank(any1?.[0] ?? null);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [tenantId]);

  // Owner policy: the company authorizes ACH billing itself (Bank Account
  // settings); the platform owner never links or authorizes it from here.
  const verifyDisabledReason = loading
    ? "Checking the billing bank account…"
    : loadFailed
      ? "Couldn't load the billing bank account."
      // The server's readiness: an ACH authorization with a Moov payment method.
      : !billing?.provider_payment_method_id || !billing?.ach_authorized_at
        ? (bank ? "The company hasn't authorized billing yet." : "No verified bank account on file.")
        : null;

  return (
    <SectionCard
      title="Billing Bank Account"
      icon={<ShieldCheck className="h-4 w-4 text-sky-500" />}
      accent="bg-gradient-to-r from-sky-500 to-sky-500/30"
      description={`Moov-verified account we pull maintenance fees from for ${tenantName}.`}
    >
      {/* Fees are computed by the server (tenant-billing-admin preview), confirmed, then pulled. */}
      <div className="flex justify-end gap-2">
        <TenantBillingVerifyButton tenantId={tenantId} tenantName={tenantName} disabledReason={verifyDisabledReason} />
        <TenantFeeCollectButton tenantId={tenantId} tenantName={tenantName} label="Preview & collect this period's fees" />
      </div>

        <p className="text-xs text-muted-foreground">
          The company authorizes billing from its own Bank Account settings.
        </p>
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : loadFailed ? (
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>Couldn&apos;t load the billing bank account.</span>
            <Button size="sm" variant="outline" onClick={() => { void load(); }}>Retry</Button>
          </div>
        ) : !bank ? (
          <div className="text-sm text-muted-foreground italic">
            No verified bank account on file. Tenant must add one via Moov in the Bank Account panel.
          </div>
        ) : (
          <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
            <div>
              <div className="text-sm font-medium">{bank.nickname}</div>
              <div className="text-xs text-muted-foreground">
                {bank.custname} · {bank.acct_type === "C" ? "Checking" : "Savings"} · {bank.chk_acct ? `••••${bank.chk_acct.slice(-4)}` : "Account pending"}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Badge variant="default" className="text-[10px]">
                <ShieldCheck className="w-3 h-3 mr-1" />
                {bank.verification_status === "admin_override" ? "Verified (override)" : "Verified via Moov"}
              </Badge>
              {billing?.stakeholder_account_id ? (
                <span className="text-[10px] text-muted-foreground">
                  {billing?.auto_debit_enabled ? "Auto-debit ON" : "Auto-debit OFF"}
                </span>
              ) : (
                <span className="text-[10px] text-muted-foreground">Not authorized for billing</span>
              )}
            </div>
          </div>
        )}
    </SectionCard>

  );
}

/* ---------------- Usage Tab ---------------- */

function TenantUsageInlinePanel({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const now = new Date();
  const [scope, setScope] = useState<"month" | "year">("month");
  const [month, setMonth] = useState(now.getMonth()); // 0-11
  const [year, setYear] = useState(now.getFullYear());
  const [data, setData] = useState<any>(null);
  const [checkalt, setCheckalt] = useState<{ count: number; amount: number } | null>(null);
  const [moov, setMoov] = useState<{ count: number; amountOut: number } | null>(null);
  const [maintenance, setMaintenance] = useState<any[]>([]);
  const [tenantMeta, setTenantMeta] = useState<{ monthly_rate_cents: number; referral_discount_cents: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = (() => {
    if (scope === "month") {
      const start = new Date(year, month, 1);
      const end = new Date(year, month + 1, 1);
      return { start, end, label: start.toLocaleDateString("en-US", { month: "long", year: "numeric" }) };
    }
    const start = new Date(year, 0, 1);
    const end = new Date(year + 1, 0, 1);
    return { start, end, label: String(year) };
  })();

  const load = async () => {
    setLoading(true);
    setError(null);
    const startISO = range.start.toISOString();
    const endISO = new Date(range.end.getTime() - 1).toISOString();

    try {
      const [usageRes, checkaltRes, moovRes, maintRes, tenantRes] = await Promise.all([
        supabase.rpc("get_tenant_check_usage", {
          _tenant_id: tenantId,
          _month_start: startISO,
          _month_end: endISO,
        } as any),
        supabase
          .from("checkalt_deposits")
          .select("id, amount, status, created_at")
          .eq("tenant_id", tenantId)
          .gte("created_at", range.start.toISOString())
          .lt("created_at", range.end.toISOString()),
        supabase
          .from("payment_transfers")
          .select("id, amount_cents, status, created_at")
          .eq("provider", "moov")
          .eq("tenant_id", tenantId)
          .gte("created_at", range.start.toISOString())
          .lt("created_at", range.end.toISOString()),
        supabase
          .from("tenant_maintenance_payments")
          .select("id, amount_cents, status, received_at, period_start, method, reference, failure_reason")
          .eq("tenant_id", tenantId)
          .gte("received_at", range.start.toISOString())
          .lt("received_at", range.end.toISOString())
          .order("received_at", { ascending: false }),
        supabase
          .from("tenants")
          .select("monthly_rate_cents, referral_discount_cents")
          .eq("id", tenantId)
          .maybeSingle(),
      ]);
      if (usageRes.error) throw usageRes.error;
      setData(usageRes.data);
      setCheckalt({
        count: checkaltRes.data?.length ?? 0,
        amount: (checkaltRes.data ?? []).reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0),
      });
      setMoov({
        count: moovRes.data?.length ?? 0,
        amountOut: (moovRes.data ?? [])
          .filter((r: any) => r.status === "completed")
          .reduce((s: number, r: any) => s + Number(r.amount_cents ?? 0) / 100, 0),
      });
      setMaintenance(maintRes.data ?? []);
      setTenantMeta(tenantRes.data as any ?? null);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenantId, scope, month, year]);

  const events: any[] = data?.events || [];
  const checkCount = events.filter((e) => e.event_type === "check_processing").length;
  const mortgageCount = data?.mortgage_count || events.filter((e) => e.event_type === "mortgage_handling").length;
  const sameDay = events.filter((e) => e.event_type === "moov_same_day").length;
  const nextDay = events.filter((e) => e.event_type === "moov_next_day" || e.event_type === "moov_standard").length;

  const fmt = (cents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: (data?.currency || "usd").toUpperCase() }).format((cents || 0) / 100);
  const maintenancePaidCents = maintenance
    .filter((r) => ["cleared", "recorded", "submitted"].includes(r.status))
    .reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  const months = Array.from({ length: 12 }, (_, i) => ({ v: i, l: new Date(2020, i, 1).toLocaleString("en-US", { month: "long" }) }));
  const years = Array.from({ length: 5 }, (_, i) => now.getFullYear() - i);

  // Usage summary for the month (display only): each event's recorded unit price
  // plus maintenance (monthly rate - referral discount). The amount actually
  // collected is computed by the server (TenantFeeCollectButton preview).
  const usageEvents: any[] = data?.events || [];
  const checkProcessingCents = usageEvents.filter(e => e.event_type === 'check_processing').reduce((s, e) => s + (e.unit_price_cents ?? 0), 0);
  const mortgageOpsCents = usageEvents.filter(e => e.event_type === 'mortgage_handling').reduce((s, e) => s + (e.unit_price_cents ?? 0), 0);
  const disbursementCents = usageEvents.filter(e => e.event_type?.startsWith('moov_')).reduce((s, e) => s + (e.unit_price_cents ?? 0), 0);
  
  const grossMaintenance = tenantMeta?.monthly_rate_cents ?? 0;
  const discount = tenantMeta?.referral_discount_cents ?? 0;
  const netMaintenance = Math.max(0, grossMaintenance - discount);
  const consolidatedTotalCents = checkProcessingCents + mortgageOpsCents + disbursementCents + netMaintenance;

  return (
    <SectionCard
      title={`Usage & Payments — ${range.label}`}
      icon={<Receipt className="h-4 w-4 text-emerald-500" />}
      accent="bg-gradient-to-r from-emerald-500 to-emerald-500/30"
      description="Checks processed, CheckAlt deposits, Moov disbursements & maintenance fees paid to ChecksOps."
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={scope} onValueChange={(v) => setScope(v as any)}>
          <SelectTrigger className="w-[110px] h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="month">Month</SelectItem>
            <SelectItem value="year">Year</SelectItem>
          </SelectContent>
        </Select>
        {scope === "month" && (
          <Select value={String(month)} onValueChange={(v) => setMonth(parseInt(v))}>
            <SelectTrigger className="w-[130px] h-8"><SelectValue /></SelectTrigger>
            <SelectContent>
              {months.map((m) => <SelectItem key={m.v} value={String(m.v)}>{m.l}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <Select value={String(year)} onValueChange={(v) => setYear(parseInt(v))}>
          <SelectTrigger className="w-[90px] h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {years.map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <div className="space-y-6">

        {error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : loading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] text-muted-foreground tracking-wider">Check Processing Usage</div>
                <div className="text-2xl font-bold mt-1">{checkCount}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Fees: {fmt(data?.amount_cents ?? 0)}</div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] text-muted-foreground tracking-wider">MortgageOps Usage</div>
                <div className="text-2xl font-bold mt-1">{mortgageCount}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Fees: {fmt(data?.mortgage_amount_cents ?? 0)}</div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] text-muted-foreground tracking-wider">Disbursement Usage</div>
                <div className="text-2xl font-bold mt-1">{moov?.count ?? 0}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Next Day {nextDay} · Same Day {sameDay}</div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] text-muted-foreground tracking-wider">Paid to ChecksOps</div>
                <div className="text-2xl font-bold mt-1">{fmt(maintenancePaidCents)}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Maintenance fees</div>
              </div>
            </div>

            {/* Consolidated billing table — one ACH pull for CheckAlt + Moov + maintenance */}
            {scope === "month" && (
              <div className="rounded-lg border">
                <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
                  <div>
                    <h4 className="text-sm font-semibold">Consolidated Billing — {range.label}</h4>
                    <p className="text-[11px] text-muted-foreground">
                      One ACH pull covers all ChecksOps fees for the month. The server computes the amount; review it before collecting.
                    </p>
                  </div>
                  <TenantFeeCollectButton
                    tenantId={tenantId}
                    tenantName={tenantName}
                    period={billingPeriodKey(year, month)}
                    label={`Preview & collect ${range.label}`}
                    onCollected={load}
                  />
                </div>
                <table className="w-full text-sm">
                  <thead className="text-[10px] text-muted-foreground bg-muted/20">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Line item</th>
                      <th className="text-right px-4 py-2 font-medium">Usage</th>
                      <th className="text-right px-4 py-2 font-medium">Rate</th>
                      <th className="text-right px-4 py-2 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr>
                      <td className="px-4 py-2">Check Processing Usage</td>
                      <td className="text-right px-4 py-2 tabular-nums">{checkCount} checks</td>
                      <td className="text-right px-4 py-2 tabular-nums text-muted-foreground">as recorded</td>
                      <td className="text-right px-4 py-2 tabular-nums font-medium">{fmt(data?.events?.filter((e: any) => e.event_type === 'check_processing').reduce((s: number, e: any) => s + (e.unit_price_cents ?? 0), 0) ?? 0)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2">MortgageOps Usage</td>
                      <td className="text-right px-4 py-2 tabular-nums">{mortgageCount} requests</td>
                      <td className="text-right px-4 py-2 tabular-nums text-muted-foreground">as recorded</td>
                      <td className="text-right px-4 py-2 tabular-nums font-medium">{fmt(data?.events?.filter((e: any) => e.event_type === 'mortgage_handling').reduce((s: number, e: any) => s + (e.unit_price_cents ?? 0), 0) ?? 0)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2">Disbursement Usage</td>
                      <td className="text-right px-4 py-2 tabular-nums">{moov?.count ?? 0} txns</td>
                      <td className="text-right px-4 py-2 tabular-nums text-muted-foreground">as recorded</td>
                      <td className="text-right px-4 py-2 tabular-nums font-medium">{fmt(data?.events?.filter((e: any) => e.event_type?.startsWith('moov_')).reduce((s: number, e: any) => s + (e.unit_price_cents ?? 0), 0) ?? 0)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2">
                        Monthly maintenance
                      </td>
                      <td className="text-right px-4 py-2 tabular-nums">1 mo</td>
                      <td className="text-right px-4 py-2 tabular-nums text-muted-foreground">{fmt(grossMaintenance)}</td>
                      <td className="text-right px-4 py-2 tabular-nums font-medium">{fmt(grossMaintenance)}</td>
                    </tr>
                    {discount > 0 && (
                      <tr>
                        <td className="px-4 py-2 text-emerald-600">Referral discount</td>
                        <td className="text-right px-4 py-2 tabular-nums text-muted-foreground">—</td>
                        <td className="text-right px-4 py-2 tabular-nums text-muted-foreground">—</td>
                        <td className="text-right px-4 py-2 tabular-nums font-medium text-emerald-600">−{fmt(discount)}</td>
                      </tr>
                    )}
                    <tr className="bg-muted/30">
                      <td className="px-4 py-2 font-semibold" colSpan={3}>Total to pull</td>
                      <td className="text-right px-4 py-2 tabular-nums font-bold text-base">{fmt(consolidatedTotalCents)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {maintenance.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold mb-2">Maintenance Fee Payments ({maintenance.length})</h4>
                <div className="border rounded-lg max-h-56 overflow-y-auto divide-y">
                  {maintenance.map((p) => (
                    <div key={p.id} className="flex items-center justify-between px-3 py-2 text-xs">
                      <div>
                        <div className="font-medium">
                          {new Date(p.received_at).toLocaleDateString()}
                          {p.period_start && <span className="text-muted-foreground ml-2">· {new Date(p.period_start).toLocaleDateString(undefined, { month: "short", year: "numeric" })}</span>}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {p.method?.toUpperCase()} {p.reference && `· ${p.reference}`} {p.failure_reason && `· ${p.failure_reason}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold">{fmt(p.amount_cents)}</span>
                        <Badge variant="outline" className={`text-[9px] h-4 ${
                          p.status === "cleared" ? "border-emerald-500/40 text-emerald-500" :
                          p.status === "returned" || p.status === "failed" ? "border-destructive/40 text-destructive" :
                          "border-muted-foreground/30"
                        }`}>
                          {p.status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h4 className="text-sm font-semibold mb-2">Detailed Check Log ({events.length})</h4>
              <div className="border rounded-lg max-h-72 overflow-y-auto divide-y">
                {events.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground italic">No usage events for this range.</div>
                ) : (
                  events.map((e) => (
                    <div key={e.id} className="flex items-center justify-between px-3 py-2 text-xs">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{new Date(e.billed_at).toLocaleString()}</span>
                          <Badge variant="secondary" className="text-[9px] h-4 px-1">
                            {(e.event_type || "processing").replace("_", " ")}
                          </Badge>
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {e.check_number && <>Check #{e.check_number} · </>}
                          {e.payee_name && <>{e.payee_name} · </>}
                          {e.processed_by && <span className="text-primary/80">By: {e.processed_by}</span>}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-semibold">{fmt(e.unit_price_cents)}</div>
                        <Badge variant="outline" className="text-[9px] h-4 mt-0.5">{e.status}</Badge>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </SectionCard>

  );
}


/* ---------------- Tenant Management Table (master owner only) ---------------- */

function TenantManagementTable({
  tenants,
  onOpen,
  onChanged,
}: {
  tenants: Tenant[];
  onOpen: (t: Tenant) => void;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notesTenant, setNotesTenant] = useState<Tenant | null>(null);
  const [proTenant, setProTenant] = useState<Tenant | null>(null);
  const [search, setSearch] = useState("");

  // Live Moov KYC/verification status per tenant (keyed by tenant_id).
  const { data: moovKycByTenant } = useQuery({
    queryKey: ["admin-tenants-moov-kyc"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payment_provider_accounts")
        .select("tenant_id, onboarding_status, verification_status, environment, created_at")
        .eq("provider", "moov")
        .order("created_at", { ascending: false });
      if (error) throw error;
      const map: Record<string, { status: string | null; verification_status: string | null }> = {};
      for (const a of data ?? []) {
        // newest account wins (rows ordered desc)
        if (!map[a.tenant_id]) {
          map[a.tenant_id] = { status: a.onboarding_status, verification_status: a.verification_status };
        }
      }
      return map;
    },
    staleTime: 30_000,
  });

  // Company details (status, KYC, test mode, notes) are the platform owner's
  // and go through tenant-billing-admin profile-update (SQL 102), never the
  // generic tenants update.
  const updateTenant = async (id: string, patch: TenantProfilePatch, silent = false) => {
    setBusyId(id);
    try {
      await saveTenantProfile(id, patch);
      if (!silent) toast({ title: "Saved" });
      onChanged();
      return true;
    } catch (e) {
      toast({ title: "Update failed", description: e instanceof Error ? e.message : "The change was not saved", variant: "destructive" });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = (t: Tenant, active: boolean) =>
    updateTenant(t.id, { subscription_status: active ? "active" : "inactive" });

  // Pricing (rate, referral discount) is the platform
  // owner's and goes through tenant-billing-admin (SQL 96), never the generic
  // tenants update.
  const updatePricing = async (id: string, patch: TenantPricingPatch) => {
    setBusyId(id);
    try {
      await saveTenantPricing(id, patch);
      toast({ title: "Saved" });
      onChanged();
      return true;
    } catch (e) {
      toast({ title: "Update failed", description: e instanceof Error ? e.message : "Pricing was not saved", variant: "destructive" });
      return false;
    } finally {
      setBusyId(null);
    }
  };

  // Test accounts also move to the payment provider's sandbox ledger, so
  // nothing they do moves real money. The server sets moov_environment.
  const toggleTestAccount = (t: Tenant, on: boolean) =>
    updateTenant(t.id, { is_test_account: on });

  const fmtMoney = (cents?: number | null) =>
    cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;

  const columns: DataColumn<Tenant>[] = [
    {
      id: "name",
      header: "Name",
      primary: true,
      headerClassName: "w-[18%] min-w-[160px]",
      className: "font-medium",
      cell: (t) => (
        <div className="flex items-start gap-1">
          <button
            className="break-anywhere text-left leading-tight hover:underline"
            onClick={() => onOpen(t)}
          >
            {t.name}
          </button>
          {t.is_system_tenant && (
            <Badge variant="outline" className="shrink-0 text-[10px]">
              System
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "slug",
      header: "Slug",
      headerClassName: "w-[10%] min-w-[90px]",
      className: "font-mono text-[11px] text-muted-foreground break-all",
      cell: (t) => `/${t.slug}`,
    },
    {
      id: "created",
      header: "Created",
      headerClassName: "w-[9%] min-w-[80px]",
      className: "text-[11px] text-muted-foreground",
      cell: (t) => new Date(t.created_at).toLocaleDateString(),
    },
    {
      id: "status",
      header: "Status",
      headerClassName: "w-[8%] min-w-[70px]",
      cell: (t) => (
        <Badge
          variant={t.subscription_status === "active" ? "default" : "secondary"}
          className="text-[10px]"
        >
          {t.subscription_status || "inactive"}
        </Badge>
      ),
    },
    {
      id: "active",
      header: "Active",
      headerClassName: "w-[6%] min-w-[55px] text-center",
      className: "text-center",
      cell: (t) => (
        <Switch
          checked={t.subscription_status === "active"}
          onCheckedChange={(v) => toggleActive(t, v)}
          disabled={busyId === t.id}
          aria-label={`Active for ${t.name}`}
        />
      ),
    },
    {
      id: "test",
      header: "Test",
      headerClassName: "w-[5%] min-w-[45px] text-center",
      className: "text-center",
      cell: (t) => (
        <Switch
          checked={!!t.is_test_account}
          onCheckedChange={(v) => toggleTestAccount(t, v)}
          disabled={busyId === t.id}
          aria-label={`Test account for ${t.name}`}
        />
      ),
    },
    {
      id: "rate",
      header: "Rate",
      headerClassName: "w-[9%] min-w-[80px]",
      cell: (t) => (
        <InlineMoneyEditor
          valueCents={t.monthly_rate_cents ?? null}
          onSave={(cents) => updatePricing(t.id, { monthly_rate_cents: cents ?? 0 })}
        />
      ),
    },
    {
      id: "ref_code",
      header: "Ref. Code",
      mobileLabel: "Referral code",
      headerClassName: "w-[9%] min-w-[80px]",
      className: "font-mono text-[11px] break-all",
      cell: (t) => t.referral_code || "—",
    },
    {
      id: "ref_disc",
      header: "Ref. Disc.",
      mobileLabel: "Referral discount",
      headerClassName: "w-[8%] min-w-[70px]",
      className: "text-[11px]",
      cell: (t) => (
        <InlineMoneyEditor
          valueCents={t.referral_discount_cents ?? null}
          onSave={(cents) => updatePricing(t.id, { referral_discount_cents: cents ?? 0 })}
        />
      ),
    },
    {
      id: "kyc",
      header: "KYC",
      headerClassName: "w-[10%] min-w-[110px]",
      cell: (t) => {
        const moov = moovKycByTenant?.[t.id];
        const vs = (moov?.verification_status || "").toLowerCase();
        const moovBadge = !moov ? (
          <Badge variant="outline" className="text-[10px] border-muted-foreground/30 text-muted-foreground">No Moov acct</Badge>
        ) : vs === "verified" || vs === "approved" ? (
          <Badge variant="outline" className="text-[10px] border-emerald-500/40 text-emerald-500">Moov verified</Badge>
        ) : vs === "pending" || vs === "in_review" || vs === "resubmission_requested" ? (
          <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-500">Moov {vs.replace(/_/g, " ")}</Badge>
        ) : vs === "rejected" || vs === "failed" ? (
          <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive">Moov {vs}</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] border-muted-foreground/30">Moov {moov.verification_status || moov.status || "started"}</Badge>
        );
        return (
          <div className="flex flex-col gap-1">
            {moovBadge}
            <Select
              value={t.kyc_status || "pending"}
              onValueChange={(v) => updateTenant(t.id, { kyc_status: v })}
            >
              <SelectTrigger className="h-7 w-full min-w-[70px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      action: true,
      headerClassName: "w-[8%] min-w-[90px] text-right",
      className: "text-right",
      cell: (t) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
              Actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              onClick={() => {
                const url =
                  typeof window !== "undefined" && isCheckOpsHost(window.location.hostname)
                    ? `${window.location.origin}/${t.slug}/checks`
                    : `/wl/${t.slug}/checks`;
                window.open(url, "_blank", "noopener,noreferrer");
                toast({
                  title: `Previewing as ${t.name}`,
                  description: "Opened tenant portal in a new tab.",
                });
              }}
            >
              <Eye className="w-4 h-4 mr-2 text-blue-400" /> Preview portal
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setNotesTenant(t)}>
              <FileText className="w-4 h-4 mr-2" /> Notes
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setProTenant(t)}>
              <Crosshair className="w-4 h-4 mr-2 text-primary" strokeWidth={2.5} /> OPS Badge
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpen(t)}>
              <Settings className="w-4 h-4 mr-2" /> Manage tenant
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const q = search.trim().toLowerCase();
  const visibleTenants = q
    ? tenants.filter(
        (t) =>
          t.name?.toLowerCase().includes(q) ||
          t.slug?.toLowerCase().includes(q) ||
          (t.referral_code || "").toLowerCase().includes(q),
      )
    : tenants;

  return (
    <SectionCard
      title="All Tenants"
      icon={<Building2 className="h-4 w-4 text-primary" />}
      accent="bg-gradient-to-r from-primary to-primary/40"
      description="Review, approve, and configure every tenant. Not visible to tenant or staff users."
    >
      <FilterBar
        search={search}
        onSearchChange={setSearch}
        placeholder="Search tenants by name, slug or referral code…"
        actions={
          <Badge variant="secondary" className="text-[11px]">
            {visibleTenants.length} of {tenants.length}
          </Badge>
        }
      />

      <DataView
        rows={visibleTenants}
        columns={columns}
        getRowId={(t) => t.id}
        empty="No tenants match your search."
        rowClassName={(t) => (busyId === t.id ? "opacity-60" : undefined)}
        className="mt-3"
      />



      {notesTenant && (
        <TenantNotesDialog
          tenant={notesTenant}
          onClose={() => setNotesTenant(null)}
          onSaved={() => { setNotesTenant(null); onChanged(); }}
        />
      )}
      {proTenant && (
        <TenantProBadgeManagement
          tenantId={proTenant.id}
          tenantName={proTenant.name}
          isOpen={true}
          onClose={() => setProTenant(null)}
        />
      )}
    </SectionCard>

  );
}

function InlineMoneyEditor({
  valueCents,
  onSave,
}: {
  valueCents: number | null;
  onSave: (cents: number | null) => Promise<boolean> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(valueCents != null ? (valueCents / 100).toFixed(2) : "");

  useEffect(() => {
    setVal(valueCents != null ? (valueCents / 100).toFixed(2) : "");
  }, [valueCents]);

  if (!editing) {
    return (
      <button
        className="text-sm hover:underline"
        onClick={() => setEditing(true)}
      >
        {valueCents == null ? "Set rate" : `$${(valueCents / 100).toFixed(2)}`}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-muted-foreground">$</span>
      <Input
        autoFocus
        type="number"
        step="0.01"
        className="h-8 w-24"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={async () => {
          const num = val === "" ? null : Math.round(parseFloat(val) * 100);
          if (num !== valueCents) await onSave(Number.isFinite(num as number) ? num : null);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    </div>
  );
}

function TenantNotesDialog({
  tenant,
  onClose,
  onSaved,
}: {
  tenant: Tenant;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [internal, setInternal] = useState(tenant.internal_notes || "");
  const [kyc, setKyc] = useState(tenant.kyc_notes || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await saveTenantProfile(tenant.id, { internal_notes: internal, kyc_notes: kyc });
      toast({ title: "Notes saved" });
      onSaved();
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : "Notes were not saved", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tenant.name} — Internal Notes</DialogTitle>
          <DialogDescription>
            These notes are private to the master owner and never shown to tenant users.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>Internal Notes</Label>
            <textarea
              className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={internal}
              onChange={(e) => setInternal(e.target.value)}
              placeholder="Anything to remember about this tenant — billing exceptions, contacts, history…"
            />
          </div>
          <div className="space-y-2">
            <Label>KYC Notes</Label>
            <textarea
              className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={kyc}
              onChange={(e) => setKyc(e.target.value)}
              placeholder="What was verified, when, and by whom (EIN, business address, beneficial owner ID, etc.)"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save Notes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
