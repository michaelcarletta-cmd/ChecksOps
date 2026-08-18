import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/hooks/use-toast";
import { toast as sonnerToast } from "sonner";
import { Loader2, Plus, Trash2, Mail, Building2, Users, Settings, ArrowLeft, RefreshCw, Copy, Upload, X, FileText, Receipt, Link2, Gift, ShieldCheck, Eye, Crosshair, Palette, Briefcase, Home } from "lucide-react";
import { goToChecksOpsHome } from "@/lib/goToChecksOpsHome";

import { isCheckOpsHost } from "@/lib/checkopsHost";
import { useRef } from "react";
import { TenantDocumentsManager } from "@/components/white-label/TenantDocumentsManager";
import { VerificationDocumentsPanel } from "@/components/payments/VerificationDocumentsPanel";
import { CheckAltSettings } from "@/components/settings/CheckAltSettings";
import { EmailSenderSettings } from "@/components/settings/EmailSenderSettings";
import { ComplianceSettings } from "@/components/settings/ComplianceSettings";
import { AdminReferralDashboard } from "@/components/settings/AdminReferralDashboard";
import { BillingConfigPanel } from "@/components/billing/BillingConfigPanel";
import { MaintenancePaymentsTracker } from "@/components/settings/MaintenancePaymentsTracker";
import { TenantProBadgeManagement } from "@/components/settings/TenantProBadgeManagement";

import { TenantProvider } from "@/contexts/TenantContext";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";


const ALLOWED_EMAIL = "mcarletta@freedomadj.com";

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
  max_checks_per_month: number | null;
  email_from_name: string | null;
  email_from_address: string | null;
  email_reply_to: string | null;
  partner_code: string | null;
  is_system_tenant: boolean | null;
  per_check_billing_enabled?: boolean | null;
  per_check_rate_cents?: number | null;
  is_founding_partner?: boolean | null;
  monthly_rate_cents?: number | null;
  referral_code?: string | null;
  referral_discount_cents?: number | null;
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

const PLAN_TIERS = ["starter", "pro", "enterprise"] as const;
const TENANT_ROLES = ["admin", "operator", "viewer"];

export default function AdminTenants() {
  const navigate = useNavigate();
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
      if (!email || email !== ALLOWED_EMAIL) {
        setAuthorized(false);
      } else {
        setAuthorized(true);
      }
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
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-card">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}>
              <ArrowLeft className="w-4 h-4 mr-1" /> Back
            </Button>
            <Button variant="ghost" size="sm" onClick={() => goToChecksOpsHome(navigate)}>
              <Home className="w-4 h-4 mr-1" /> Home
            </Button>

            <Building2 className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-xl font-semibold">Tenant Management</h1>
              <p className="text-xs text-muted-foreground">Master merchant — {ALLOWED_EMAIL}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/admin/mortgage-ops")}>
              <Briefcase className="w-4 h-4 mr-1" /> Mortgage Ops
            </Button>
            <Button variant="ghost" size="sm" onClick={loadTenants}>
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh
            </Button>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm"><Plus className="w-4 h-4 mr-1" /> New Tenant</Button>
              </DialogTrigger>
              <CreateTenantDialog onCreated={(t) => { setCreateOpen(false); loadTenants(); setSelected(t); }} />
            </Dialog>
          </div>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-6 py-8">
        <Tabs defaultValue="tenants" className="w-full">
          <TabsList className="mb-6">
            <TabsTrigger value="tenants"><Building2 className="w-4 h-4 mr-1" /> Tenants</TabsTrigger>
            <TabsTrigger value="referrals"><Gift className="w-4 h-4 mr-1" /> Referral Dashboard</TabsTrigger>
            <TabsTrigger value="platform-billing"><Receipt className="w-4 h-4 mr-1" /> Platform Billing</TabsTrigger>
            
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
          <TabsContent value="referrals">
            <AdminReferralDashboard />
          </TabsContent>
          <TabsContent value="platform-billing" className="space-y-6">
            <BillingConfigPanel />
            <MaintenancePaymentsTracker />
          </TabsContent>
        </Tabs>
      </div>

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
      .insert({ name: name.trim(), slug: slug.trim() })
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
        <DialogDescription>Add a new client company. You can configure branding, contact info, and invite users next.</DialogDescription>
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
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-card">
        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="w-4 h-4 mr-1" /> All Tenants</Button>
          <Separator orientation="vertical" className="h-6" />
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-md flex items-center justify-center text-white font-semibold text-sm"
              style={{ backgroundColor: tenant.primary_color || "#3B82F6" }}
            >
              {tenant.name.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <h1 className="text-lg font-semibold">{tenant.name}</h1>
              <p className="text-xs text-muted-foreground">/{tenant.slug}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <Tabs defaultValue="company" className="w-full">
          <TabsList className="flex w-full flex-wrap h-auto justify-start gap-1 p-1">
            <TabsTrigger value="company" className="flex-1 min-w-[110px] whitespace-nowrap"><Building2 className="w-4 h-4 mr-1" /> Company</TabsTrigger>
            <TabsTrigger value="branding" className="flex-1 min-w-[150px] whitespace-nowrap"><Palette className="w-4 h-4 mr-1" /> Branding & Email</TabsTrigger>
            <TabsTrigger value="compliance" className="flex-1 min-w-[170px] whitespace-nowrap"><ShieldCheck className="w-4 h-4 mr-1" /> Compliance & Docs</TabsTrigger>
            <TabsTrigger value="integrations" className="flex-1 min-w-[130px] whitespace-nowrap"><Link2 className="w-4 h-4 mr-1" /> Integrations</TabsTrigger>
            
            <TabsTrigger value="billing" className="flex-1 min-w-[100px] whitespace-nowrap"><Receipt className="w-4 h-4 mr-1" /> Billing & Usage</TabsTrigger>
            <TabsTrigger value="pro-badge" className="flex-1 min-w-[115px] whitespace-nowrap"><Crosshair className="w-4 h-4 mr-1" strokeWidth={2.5} /> OPS Badge</TabsTrigger>
            <TabsTrigger value="users" className="flex-1 min-w-[95px] whitespace-nowrap"><Users className="w-4 h-4 mr-1" /> Users</TabsTrigger>
          </TabsList>

          <TabsContent value="company" className="mt-6">
            <CompanyTab tenant={tenant} onUpdated={onUpdated} />
          </TabsContent>
          <TabsContent value="branding" className="mt-6 space-y-6">
            <BrandingTab tenant={tenant} onUpdated={onUpdated} />
            <EmailSenderSettings />
          </TabsContent>
          <TabsContent value="compliance" className="mt-6 space-y-8">
            <ComplianceSettings />
            <div className="pt-6 border-t border-border/60">
              <h3 className="text-sm font-semibold mb-4 flex items-center gap-2">
                <FileText className="w-4 h-4" /> Tenant Documents
              </h3>
              <TenantDocumentsManager tenantId={tenant.id} />
            </div>
            <div className="pt-6 border-t border-border/60">
              <VerificationDocumentsPanel tenantId={tenant.id} readOnly />
            </div>
          </TabsContent>
          <TabsContent value="integrations" className="mt-6 space-y-6">
            <CheckAltSettings />
          </TabsContent>
          <TabsContent value="billing" className="mt-6 space-y-6">
            <BillingTab tenant={tenant} onUpdated={onUpdated} />
            <TenantBillingBankPanel tenantId={tenant.id} tenantName={tenant.name} />
            <TenantUsageInlinePanel tenantId={tenant.id} tenantName={tenant.name} />
          </TabsContent>
          <TabsContent value="pro-badge" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Crosshair className="w-5 h-5 text-primary" strokeWidth={2.5} /> Contractor OPS Badge
                </CardTitle>
                <CardDescription>
                  Approve or revoke the Find-a-Pro badge for contractor profiles in this tenant.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => setProOpen(true)}>
                  <Crosshair className="w-4 h-4 mr-2" strokeWidth={2.5} /> Manage OPS Badge

                </Button>
              </CardContent>
            </Card>
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
      </div>
    </div>
    </TenantProvider>
  );
}



/* ---------------- Tabs ---------------- */

function useTenantSave(tenant: Tenant, onUpdated: (t: Tenant) => void) {
  const [saving, setSaving] = useState(false);
  const save = async (patch: Record<string, any>) => {
    setSaving(true);
    const { data, error } = await supabase
      .from("tenants")
      .update(patch as any)
      .eq("id", tenant.id)
      .select()
      .single();
    setSaving(false);
    if (error) {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Saved" });
    onUpdated(data as Tenant);
  };
  return { saving, save };
}

function CompanyTab({ tenant, onUpdated }: { tenant: Tenant; onUpdated: (t: Tenant) => void }) {
  const [name, setName] = useState(tenant.name);
  const [slug, setSlug] = useState(tenant.slug);
  const [customDomain, setCustomDomain] = useState(tenant.custom_domain || "");
  const [planTier, setPlanTier] = useState(tenant.plan_tier || "starter");
  const [subStatus, setSubStatus] = useState(tenant.subscription_status || "inactive");
  const [maxChecks, setMaxChecks] = useState(tenant.max_checks_per_month ?? 100);
  const { saving, save } = useTenantSave(tenant, onUpdated);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Company & Plan</CardTitle>
        <CardDescription>Core info, URL, billing plan, and usage limits.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2"><Label>Company Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-2"><Label>Slug</Label><Input value={slug} onChange={(e) => setSlug(e.target.value)} /></div>
        </div>
        <div className="space-y-2">
          <Label>Custom Domain</Label>
          <Input value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} placeholder="checks.acme.com" />
          <p className="text-xs text-muted-foreground">Optional. If set, the tenant's portal lives at this domain.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label>Plan Tier</Label>
            <Select value={planTier} onValueChange={setPlanTier}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{PLAN_TIERS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
            </Select>
          </div>
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
          <div className="space-y-2"><Label>Max Checks / Month</Label><Input type="number" value={maxChecks} onChange={(e) => setMaxChecks(parseInt(e.target.value) || 0)} /></div>
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
          </div>
        )}
        <Button onClick={() => save({ name, slug, custom_domain: customDomain || null, plan_tier: planTier as Tenant["plan_tier"], subscription_status: subStatus, max_checks_per_month: maxChecks } as any)} disabled={saving}>
          {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save Changes
        </Button>
      </CardContent>
    </Card>
  );
}

function BrandingTab({ tenant, onUpdated }: { tenant: Tenant; onUpdated: (t: Tenant) => void }) {
  const [logoUrl, setLogoUrl] = useState(tenant.logo_url || "");
  const [primary, setPrimary] = useState(tenant.primary_color || "#3B82F6");
  const [secondary, setSecondary] = useState(tenant.secondary_color || "#1E293B");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { saving, save } = useTenantSave(tenant, onUpdated);

  const handleLogoUpload = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Invalid file", description: "Please upload an image file.", variant: "destructive" });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "File too large", description: "Logo must be under 2MB.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop() || "png";
      const path = `${tenant.id}/${Date.now()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from("tenant-logos").upload(path, file, { upsert: true });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from("tenant-logos").getPublicUrl(path);
      setLogoUrl(urlData.publicUrl);
      toast({ title: "Logo uploaded", description: "Click Save Branding to apply." });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Branding</CardTitle>
        <CardDescription>Logo and color theme used on the tenant's portal and emails.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Logo</Label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleLogoUpload(file);
            }}
          />
          {logoUrl ? (
            <div className="flex items-center gap-3 rounded border border-border bg-muted/30 p-2">
              <img src={logoUrl} alt="Logo" className="h-12 max-w-[160px] object-contain rounded bg-white p-1" onError={(e) => (e.currentTarget.style.display = "none")} />
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                  {uploading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Upload className="w-3 h-3 mr-1" />} Replace
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => setLogoUrl("")}>
                  <X className="w-3 h-3" />
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex w-full flex-col items-center justify-center gap-2 rounded border-2 border-dashed border-border bg-muted/30 p-6 hover:bg-muted/50 transition-colors"
            >
              {uploading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  <Upload className="w-5 h-5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Click to upload logo (PNG, JPG, SVG — max 2MB)</span>
                </>
              )}
            </button>
          )}
          <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="...or paste a URL" className="text-xs" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Primary Color</Label>
            <div className="flex gap-2">
              <Input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} className="w-16 p-1 h-10" />
              <Input value={primary} onChange={(e) => setPrimary(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Secondary Color</Label>
            <div className="flex gap-2">
              <Input type="color" value={secondary} onChange={(e) => setSecondary(e.target.value)} className="w-16 p-1 h-10" />
              <Input value={secondary} onChange={(e) => setSecondary(e.target.value)} />
            </div>
          </div>
        </div>
        <Button onClick={() => save({ logo_url: logoUrl || null, primary_color: primary, secondary_color: secondary })} disabled={saving || uploading}>
          {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save Branding
        </Button>
      </CardContent>
    </Card>
  );
}


/* ---------------- Users Tab ---------------- */

function UsersTab({ tenant }: { tenant: Tenant }) {
  const [users, setUsers] = useState<TenantUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
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
        role: inviteRole,
        full_name: inviteName.trim() || null,
      },
    });
    setInviting(false);
    if (error || (data as any)?.error) {
      toast({ title: "Invite failed", description: error?.message || (data as any)?.error, variant: "destructive" });
      return;
    }
    const inviteSent = (data as any)?.invite_sent;
    const inviteErrMsg = (data as any)?.invite_error;
    toast({
      title: (data as any)?.is_new_user ? "User created" : "User added to tenant",
      description: inviteSent
        ? `Invite email sent to ${inviteEmail}`
        : `User added but email failed${inviteErrMsg ? `: ${inviteErrMsg}` : ""}. Use the Resend button.`,
      variant: inviteSent ? "default" : "destructive",
    });
    setInviteEmail("");
    setInviteName("");
    load();
  };

  const resendInvite = async (email: string) => {
    const tenantBaseUrl = tenant.custom_domain ? `https://${tenant.custom_domain}` : `https://checksops.com/${tenant.slug}`;
    const redirectTo = `${tenantBaseUrl}/login`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `https://checksops.com/reset-password?next=${encodeURIComponent(redirectTo)}`,
    });
    if (error) { toast({ title: "Resend failed", description: error.message, variant: "destructive" }); return; }
    toast({ title: "Reset link resent", description: `Sent to ${email}` });
  };

  const updateRole = async (id: string, role: string) => {
    const { error } = await supabase.from("tenant_users").update({ role: role as any }).eq("id", id);
    if (error) { toast({ title: "Update failed", description: error.message, variant: "destructive" }); return; }
    toast({ title: "Role updated" });
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("Remove this user from the tenant? Their account is not deleted.")) return;
    const { error } = await supabase.from("tenant_users").delete().eq("id", id);
    if (error) { toast({ title: "Remove failed", description: error.message, variant: "destructive" }); return; }
    toast({ title: "User removed" });
    load();
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Invite User</CardTitle>
          <CardDescription>Adds the user to this tenant and emails them a tenant-branded reset link to set their password.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input placeholder="Full name (optional)" value={inviteName} onChange={(e) => setInviteName(e.target.value)} className="flex-1" />
          </div>
          <div className="flex gap-2">
            <Input placeholder="user@example.com" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="flex-1" />
            <Select value={inviteRole} onValueChange={setInviteRole}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{TENANT_ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
            <Button onClick={invite} disabled={inviting}>
              {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4 mr-1" />} Invite
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tenant Members ({users.length})</CardTitle>
        </CardHeader>
        <CardContent>
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
                  <Select value={u.role} onValueChange={(v) => updateRole(u.id, v)}>
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>{TENANT_ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                  </Select>
                  {u.email && (
                    <Button variant="outline" size="sm" onClick={() => resendInvite(u.email!)} title="Resend reset email">
                      <Mail className="w-4 h-4" />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => remove(u.id)} className="text-destructive">
                    <Trash2 className="w-4 h-4" />
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

function BillingTab({ tenant, onUpdated }: { tenant: Tenant; onUpdated: (t: Tenant) => void }) {
  const [enabled, setEnabled] = useState(tenant.per_check_billing_enabled || false);
  const [rate, setRate] = useState(tenant.per_check_rate_cents || 0);
  const { saving, save } = useTenantSave(tenant, onUpdated);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Per-Check Billing</CardTitle>
        <CardDescription>Configure how much this tenant is billed per check processed.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
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
          <h3 className="text-sm font-medium">Moov Usage Fees</h3>
          <p className="text-xs text-muted-foreground">These fees are tracked for visibility. Tenants pay these directly to Moov.</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-xs">Same Day Credit</Label>
              <Input value="$1.00" disabled className="bg-muted/50" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Instant Credit</Label>
              <Input value="$1.50" disabled className="bg-muted/50" />
            </div>
          </div>
        </div>

        <Button 
          onClick={() => save({ per_check_billing_enabled: enabled, per_check_rate_cents: rate })} 
          disabled={saving}
        >
          {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save Billing Settings
        </Button>
      </CardContent>
    </Card>
  );
}

/* ---------------- Bank Account (for pulling maintenance fees) ---------------- */

function TenantBillingBankPanel({ tenantId, tenantName }: { tenantId: string; tenantName: string }) {
  const [bank, setBank] = useState<any>(null);
  const [billing, setBilling] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [charging, setCharging] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data: b } = await supabase
      .from("tenant_billing_accounts")
      .select("id, stakeholder_account_id, auto_debit_enabled, ach_authorized_at")
      .eq("tenant_id", tenantId)
      .maybeSingle();
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

  const pullNow = async () => {
    setCharging(true);
    const { data, error } = await supabase.functions.invoke("charge-tenant-maintenance", {
      body: { tenant_ids: [tenantId], dry_run: false },
    });
    setCharging(false);
    if (error) return sonnerToast.error(error.message);
    const r = (data as any)?.results?.[0];
    if (r?.skipped) sonnerToast.warning(`Skipped: ${r.skipped}`);
    else if (r?.error) sonnerToast.error(r.error);
    else if (r?.status === "submitted") sonnerToast.success(`ACH debit submitted for $${(r.amount_cents / 100).toFixed(2)}`);
    else sonnerToast.info(JSON.stringify(r ?? data));
  };

  const linkForBilling = async () => {
    if (!bank?.id) return;
    const payload = {
      tenant_id: tenantId,
      stakeholder_account_id: bank.id,
      auto_debit_enabled: true,
      ach_authorized_at: new Date().toISOString(),
    };
    const { error } = billing?.id
      ? await supabase.from("tenant_billing_accounts").update(payload as any).eq("id", billing.id)
      : await supabase.from("tenant_billing_accounts").insert(payload as any);
    if (error) return sonnerToast.error(error.message);
    sonnerToast.success("Bank account linked for maintenance-fee billing");
    load();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Billing Bank Account</CardTitle>
            <CardDescription>
              Moov-verified account we pull maintenance fees from for {tenantName}.
            </CardDescription>
          </div>
          <Button size="sm" onClick={pullNow} disabled={charging || !bank || !billing?.auto_debit_enabled}>
            {charging ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Pull maintenance fee now
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
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
                <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={linkForBilling}>
                  Link for billing
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
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
  const [tenantMeta, setTenantMeta] = useState<{ monthly_rate_cents: number; referral_discount_cents: number; is_founding_partner: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);

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
          .from("moov_transfers" as any)
          .select("id, amount, status, created_at")
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
          .select("monthly_rate_cents, referral_discount_cents, is_founding_partner")
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
          .reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0),
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
  const instant = events.filter((e) => e.event_type === "moov_instant").length;
  const fmt = (cents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: (data?.currency || "usd").toUpperCase() }).format((cents || 0) / 100);
  const maintenancePaidCents = maintenance
    .filter((r) => ["cleared", "recorded", "submitted"].includes(r.status))
    .reduce((s, r) => s + (r.amount_cents ?? 0), 0);
  const months = Array.from({ length: 12 }, (_, i) => ({ v: i, l: new Date(2020, i, 1).toLocaleString("en-US", { month: "long" }) }));
  const years = Array.from({ length: 5 }, (_, i) => now.getFullYear() - i);

  // Consolidated billing: check processing fees ($4/check), Moov disbursement fees ($1 transfer),
  // maintenance for the month (monthly_rate - referral discount). Applies only when scope=month.
  const CHECK_FEE_CENTS = 400;
  const MOOV_FEE_CENTS = 100;
  const checkaltFeeCents = (checkalt?.count ?? 0) * CHECK_FEE_CENTS;
    const moovFeeCents = (moov?.count ?? 0) * MOOV_FEE_CENTS;
    const mortgageFeeCents = data?.mortgage_amount_cents ?? 0;
    const grossMaintenance = tenantMeta?.monthly_rate_cents ?? 0;
    const discount = tenantMeta?.referral_discount_cents ?? 0;
    const netMaintenance = Math.max(0, grossMaintenance - discount);
    const consolidatedTotalCents = checkaltFeeCents + moovFeeCents + mortgageFeeCents + netMaintenance;

  const pullConsolidated = async () => {
    if (scope !== "month") {
      sonnerToast.error("Switch to a specific month to pull consolidated billing.");
      return;
    }
    if (consolidatedTotalCents <= 0) {
      sonnerToast.warning("Nothing to charge for this period.");
      return;
    }
    const confirmed = window.confirm(
      `Pull $${(consolidatedTotalCents / 100).toFixed(2)} from ${tenantName}'s verified bank account and email them an invoice?`
    );
    if (!confirmed) return;
    setPulling(true);
    const line_items = [
      checkaltFeeCents > 0 && { label: "Check processing", detail: `${checkalt?.count ?? 0} checks × $4.00`, amount_cents: checkaltFeeCents },
      moovFeeCents > 0 && { label: "Moov disbursements", detail: `${moov?.count ?? 0} × $1.00`, amount_cents: moovFeeCents },
      mortgageFeeCents > 0 && { label: "MortgageOps handling", detail: `${mortgageCount} requests`, amount_cents: mortgageFeeCents },
      grossMaintenance > 0 && { label: "Monthly maintenance", detail: range.label, amount_cents: grossMaintenance },
      discount > 0 && { label: "Referral discount", detail: "applied to maintenance", amount_cents: -discount },
    ].filter(Boolean);

    const { data: resp, error } = await supabase.functions.invoke("charge-tenant-maintenance", {
      body: {
        tenant_ids: [tenantId],
        override_amount_cents: consolidatedTotalCents,
        override_kind: "consolidated",
        line_items,
        period_label: range.label,
        send_invoice: true,
      },
    });
    setPulling(false);
    if (error) return sonnerToast.error(error.message);
    const r = (resp as any)?.results?.[0];
    if (r?.skipped) sonnerToast.warning(`Skipped: ${r.skipped}`);
    else if (r?.error) sonnerToast.error(r.error);
    else if (r?.status === "submitted") {
      sonnerToast.success(
        `ACH debit for $${(r.amount_cents / 100).toFixed(2)} submitted${r.invoice_sent ? " · invoice emailed" : r.invoice_error ? ` · invoice: ${r.invoice_error}` : ""}`
      );
      load();
    } else sonnerToast.info(JSON.stringify(r ?? resp));
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <CardTitle>Usage & Payments — {range.label}</CardTitle>
            <CardDescription>
              Checks processed, CheckAlt deposits, Moov disbursements & maintenance fees paid to ChecksOps.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
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
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : loading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Checks Processed</div>
                <div className="text-2xl font-bold mt-1">{checkCount}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Fees: {fmt(data?.amount_cents ?? 0)}</div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">CheckAlt Deposits</div>
                <div className="text-2xl font-bold mt-1">{checkalt?.count ?? 0}</div>
                <div className="text-[10px] text-muted-foreground mt-1">${(checkalt?.amount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Moov Out</div>
                <div className="text-2xl font-bold mt-1">{moov?.count ?? 0}</div>
                <div className="text-[10px] text-muted-foreground mt-1">${(moov?.amountOut ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">MortgageOps Requests</div>
                <div className="text-2xl font-bold mt-1">{mortgageCount}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Fees: {fmt(data?.mortgage_amount_cents ?? 0)}</div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Paid to ChecksOps</div>
                <div className="text-2xl font-bold mt-1">{fmt(maintenancePaidCents)}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Same Day {sameDay} · Instant {instant}</div>
              </div>
            </div>

            {/* Consolidated billing table — one ACH pull for CheckAlt + Moov + maintenance */}
            {scope === "month" && (
              <div className="rounded-lg border">
                <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
                  <div>
                    <h4 className="text-sm font-semibold">Consolidated Billing — {range.label}</h4>
                    <p className="text-[11px] text-muted-foreground">
                      One ACH pull covers all ChecksOps fees for the month. Invoice is emailed automatically.
                    </p>
                  </div>
                  <Button size="sm" onClick={pullConsolidated} disabled={pulling || consolidatedTotalCents <= 0}>
                    {pulling ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
                    Pull {fmt(consolidatedTotalCents)} & email invoice
                  </Button>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-[10px] uppercase text-muted-foreground bg-muted/20">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Line item</th>
                      <th className="text-right px-4 py-2 font-medium">Usage</th>
                      <th className="text-right px-4 py-2 font-medium">Rate</th>
                      <th className="text-right px-4 py-2 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr>
                      <td className="px-4 py-2">CheckAlt check processing</td>
                      <td className="text-right px-4 py-2 tabular-nums">{checkalt?.count ?? 0} checks</td>
                      <td className="text-right px-4 py-2 tabular-nums text-muted-foreground">$4.00</td>
                      <td className="text-right px-4 py-2 tabular-nums font-medium">{fmt(checkaltFeeCents)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2">MortgageOps request handling</td>
                      <td className="text-right px-4 py-2 tabular-nums">{mortgageCount} requests</td>
                      <td className="text-right px-4 py-2 tabular-nums text-muted-foreground">$15.00</td>
                      <td className="text-right px-4 py-2 tabular-nums font-medium">{fmt(mortgageFeeCents)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2">Moov disbursements</td>
                      <td className="text-right px-4 py-2 tabular-nums">{moov?.count ?? 0} txns</td>
                      <td className="text-right px-4 py-2 tabular-nums text-muted-foreground">$1.00</td>
                      <td className="text-right px-4 py-2 tabular-nums font-medium">{fmt(moovFeeCents)}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2">
                        Monthly maintenance
                        {tenantMeta?.is_founding_partner && (
                          <Badge variant="outline" className="ml-2 text-[9px] h-4 border-yellow-500/40 text-yellow-600">Founding partner</Badge>
                        )}
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
                          <Badge variant="secondary" className="text-[9px] h-4 px-1 uppercase">
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
      </CardContent>
    </Card>
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

  const updateTenant = async (id: string, patch: Record<string, any>, silent = false) => {
    setBusyId(id);
    const { error } = await supabase.from("tenants").update(patch as any).eq("id", id);
    setBusyId(null);
    if (error) {
      toast({ title: "Update failed", description: error.message, variant: "destructive" });
      return false;
    }
    if (!silent) toast({ title: "Saved" });
    onChanged();
    return true;
  };

  const toggleActive = (t: Tenant, active: boolean) =>
    updateTenant(t.id, { subscription_status: active ? "active" : "inactive" });

  const toggleFoundingPartner = (t: Tenant, on: boolean) =>
    updateTenant(t.id, on
      ? { is_founding_partner: true, monthly_rate_cents: 7500 }
      : { is_founding_partner: false });

  const fmtMoney = (cents?: number | null) =>
    cents == null ? "—" : `$${(cents / 100).toFixed(2)}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tenant Management</CardTitle>
        <CardDescription>
          Master owner control panel — review, approve, and configure every tenant. Not visible to tenant or staff users.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Founding</TableHead>
              <TableHead>Monthly Rate</TableHead>
              <TableHead>Referral Code</TableHead>
              <TableHead>Referral Disc.</TableHead>
              <TableHead>KYC</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.map((t) => {
              const isActive = t.subscription_status === "active";
              return (
                <TableRow key={t.id} className={busyId === t.id ? "opacity-60" : ""}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-1">
                      <button className="hover:underline text-left" onClick={() => onOpen(t)}>
                        {t.name}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        title="Preview as this tenant (opens their portal in a new tab)"
                        onClick={() => {
                          const url = (typeof window !== "undefined" && isCheckOpsHost(window.location.hostname))
                            ? `${window.location.origin}/${t.slug}/checks`
                            : `/wl/${t.slug}/checks`;
                          window.open(url, "_blank", "noopener,noreferrer");
                          toast({ title: `Previewing as ${t.name}`, description: "Opened tenant portal in a new tab." });
                        }}
                      >
                        <Eye className="w-4 h-4 text-blue-400" />
                      </Button>
                      {t.is_system_tenant && <Badge variant="outline" className="text-[10px]">System</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">/{t.slug}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(t.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant={isActive ? "default" : "secondary"}>
                      {t.subscription_status || "inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={isActive}
                      onCheckedChange={(v) => toggleActive(t, v)}
                      disabled={busyId === t.id}
                    />
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={!!t.is_founding_partner}
                      onCheckedChange={(v) => toggleFoundingPartner(t, v)}
                      disabled={busyId === t.id}
                    />
                  </TableCell>
                  <TableCell>
                    <InlineMoneyEditor
                      valueCents={t.monthly_rate_cents ?? null}
                      onSave={(cents) => updateTenant(t.id, { monthly_rate_cents: cents })}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{t.referral_code || "—"}</TableCell>
                  <TableCell className="text-xs">{fmtMoney(t.referral_discount_cents)}</TableCell>
                  <TableCell>
                    <Select
                      value={t.kyc_status || "pending"}
                      onValueChange={(v) => updateTenant(t.id, { kyc_status: v })}
                    >
                      <SelectTrigger className="h-8 w-[120px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="approved">Approved</SelectItem>
                        <SelectItem value="rejected">Rejected</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Preview as this tenant (opens their portal in a new tab)"
                      onClick={() => {
                        const url = (typeof window !== "undefined" && isCheckOpsHost(window.location.hostname))
                          ? `${window.location.origin}/${t.slug}/checks`
                          : `/wl/${t.slug}/checks`;
                        window.open(url, "_blank", "noopener,noreferrer");
                        toast({ title: `Previewing as ${t.name}`, description: "Opened tenant portal in a new tab." });
                      }}
                    >
                      <Eye className="w-4 h-4 mr-1 text-blue-400" /> Preview
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setNotesTenant(t)}>
                      Notes
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setProTenant(t)}>
                      <Crosshair className="w-4 h-4 mr-1 text-primary" strokeWidth={2.5} /> OPS Badge
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onOpen(t)}>
                      Manage →
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>

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
    </Card>
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
    const { error } = await supabase
      .from("tenants")
      .update({ internal_notes: internal, kyc_notes: kyc } as any)
      .eq("id", tenant.id);
    setSaving(false);
    if (error) {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Notes saved" });
    onSaved();
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

