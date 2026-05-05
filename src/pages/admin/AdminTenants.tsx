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
import { Loader2, Plus, Trash2, Mail, Building2, Users, Settings, ArrowLeft, RefreshCw, Copy } from "lucide-react";

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
const TENANT_ROLES = ["owner", "admin", "member", "viewer"];

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
            <Building2 className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-xl font-semibold">Tenant Management</h1>
              <p className="text-xs text-muted-foreground">Master merchant — {ALLOWED_EMAIL}</p>
            </div>
          </div>
          <div className="flex gap-2">
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

      <div className="max-w-7xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin" /></div>
        ) : tenants.length === 0 ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground">No tenants yet. Click "New Tenant" to add one.</CardContent></Card>
        ) : (
          <div className="grid gap-3">
            {tenants.map((t) => (
              <Card key={t.id} className="hover:border-primary/50 transition-colors cursor-pointer" onClick={() => setSelected(t)}>
                <CardContent className="py-4 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div
                      className="w-10 h-10 rounded-md flex items-center justify-center text-white font-semibold text-sm"
                      style={{ backgroundColor: t.primary_color || "#3B82F6" }}
                    >
                      {t.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold">{t.name}</h3>
                        {t.is_system_tenant && <Badge variant="outline">System</Badge>}
                        <Badge variant={t.subscription_status === "active" ? "default" : "secondary"}>
                          {t.subscription_status || "inactive"}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        /{t.slug} • {t.plan_tier || "starter"} • {t.custom_domain || "no custom domain"}
                      </p>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm">Manage →</Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
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
  return (
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
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="company"><Building2 className="w-4 h-4 mr-1" /> Company</TabsTrigger>
            <TabsTrigger value="branding"><Settings className="w-4 h-4 mr-1" /> Branding</TabsTrigger>
            <TabsTrigger value="email"><Mail className="w-4 h-4 mr-1" /> Email</TabsTrigger>
            <TabsTrigger value="users"><Users className="w-4 h-4 mr-1" /> Users</TabsTrigger>
          </TabsList>

          <TabsContent value="company" className="mt-6">
            <CompanyTab tenant={tenant} onUpdated={onUpdated} />
          </TabsContent>
          <TabsContent value="branding" className="mt-6">
            <BrandingTab tenant={tenant} onUpdated={onUpdated} />
          </TabsContent>
          <TabsContent value="email" className="mt-6">
            <EmailTab tenant={tenant} onUpdated={onUpdated} />
          </TabsContent>
          <TabsContent value="users" className="mt-6">
            <UsersTab tenant={tenant} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/* ---------------- Tabs ---------------- */

function useTenantSave(tenant: Tenant, onUpdated: (t: Tenant) => void) {
  const [saving, setSaving] = useState(false);
  const save = async (patch: Partial<Tenant>) => {
    setSaving(true);
    const { data, error } = await supabase
      .from("tenants")
      .update(patch)
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
        <div className="grid grid-cols-3 gap-4">
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
  const { saving, save } = useTenantSave(tenant, onUpdated);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Branding</CardTitle>
        <CardDescription>Logo and color theme used on the tenant's portal and emails.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Logo URL</Label>
          <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://..." />
          {logoUrl && <img src={logoUrl} alt="logo preview" className="h-12 mt-2 rounded border border-border bg-white p-1" />}
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
        <Button onClick={() => save({ logo_url: logoUrl || null, primary_color: primary, secondary_color: secondary })} disabled={saving}>
          {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save Branding
        </Button>
      </CardContent>
    </Card>
  );
}

function EmailTab({ tenant, onUpdated }: { tenant: Tenant; onUpdated: (t: Tenant) => void }) {
  const [fromName, setFromName] = useState(tenant.email_from_name || "");
  const [fromAddress, setFromAddress] = useState(tenant.email_from_address || "");
  const [replyTo, setReplyTo] = useState(tenant.email_reply_to || "");
  const { saving, save } = useTenantSave(tenant, onUpdated);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email & Contact</CardTitle>
        <CardDescription>Contact info and "From" identity for outbound emails to this tenant's users.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>From Name</Label>
          <Input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Acme Inspections" />
        </div>
        <div className="space-y-2">
          <Label>From Address</Label>
          <Input value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} placeholder="noreply@acme.com" />
          <p className="text-xs text-muted-foreground">Domain must be verified in Cloud → Emails. Falls back to ChecksOps default if blank.</p>
        </div>
        <div className="space-y-2">
          <Label>Reply-To</Label>
          <Input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="support@acme.com" />
        </div>
        <Button onClick={() => save({ email_from_name: fromName || null, email_from_address: fromAddress || null, email_reply_to: replyTo || null })} disabled={saving}>
          {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save Email Settings
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
      body: { tenant_id: tenant.id, email: inviteEmail.trim().toLowerCase(), role: inviteRole },
    });
    setInviting(false);
    if (error || (data as any)?.error) {
      toast({ title: "Invite failed", description: error?.message || (data as any)?.error, variant: "destructive" });
      return;
    }
    toast({
      title: (data as any)?.is_new_user ? "User created & invite sent" : "User added to tenant",
      description: (data as any)?.invite_sent ? `Reset link emailed to ${inviteEmail}` : "User added (no email sent).",
    });
    setInviteEmail("");
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
        <CardContent>
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
