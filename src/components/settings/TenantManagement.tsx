import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Plus, Building2, ExternalLink, Loader2, Pencil, Power, Upload, X, Trash2, Users, Receipt } from "lucide-react";
import { TenantUserManagement } from "./TenantUserManagement";
import { TenantUsageDashboard } from "./TenantUsageDashboard";

interface TenantForm {
  name: string;
  slug: string;
  logo_url: string;
  primary_color: string;
  secondary_color: string;
  custom_domain: string;
  max_checks_per_month: number;
  subscription_status: string;
  plan_tier: string;
  email_from_name: string;
  email_from_address: string;
  email_reply_to: string;
  email_provider: string;
  email_provider_config: Record<string, string>;
}

const defaultForm: TenantForm = {
  name: "",
  slug: "",
  logo_url: "",
  primary_color: "#3B82F6",
  secondary_color: "#1E293B",
  custom_domain: "",
  max_checks_per_month: 100,
  subscription_status: "trial",
  plan_tier: "starter",
  email_from_name: "",
  email_from_address: "",
  email_reply_to: "",
  email_provider: "none",
  email_provider_config: {},
};

export function TenantManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<TenantForm>(defaultForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [usersTarget, setUsersTarget] = useState<{ id: string; name: string } | null>(null);
  const [usageTarget, setUsageTarget] = useState<{ id: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: tenants, isLoading } = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

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
      const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: uploadError } = await supabase.storage.from("tenant-logos").upload(path, file);
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from("tenant-logos").getPublicUrl(path);
      setForm((prev) => ({ ...prev, logo_url: urlData.publicUrl }));
      toast({ title: "Logo uploaded" });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const createTenant = useMutation({
    mutationFn: async (f: TenantForm) => {
      const { error } = await supabase.from("tenants").insert({
        name: f.name,
        slug: f.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        logo_url: f.logo_url || null,
        primary_color: f.primary_color,
        secondary_color: f.secondary_color,
        custom_domain: f.custom_domain || null,
        max_checks_per_month: f.max_checks_per_month,
        email_from_name: f.email_from_name || null,
        email_from_address: f.email_from_address || null,
        email_reply_to: f.email_reply_to || null,
        email_provider: f.email_provider,
        email_provider_config: f.email_provider_config,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      setCreateOpen(false);
      setForm(defaultForm);
      toast({ title: "Tenant Created", description: "New white-label tenant has been created." });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const updateTenant = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<TenantForm> }) => {
      const { error } = await supabase.from("tenants").update({
        name: data.name,
        logo_url: data.logo_url || null,
        primary_color: data.primary_color,
        secondary_color: data.secondary_color,
        custom_domain: data.custom_domain || null,
        max_checks_per_month: data.max_checks_per_month,
        subscription_status: data.subscription_status as any,
        plan_tier: data.plan_tier as any,
        email_from_name: data.email_from_name || null,
        email_from_address: data.email_from_address || null,
        email_reply_to: data.email_reply_to || null,
        email_provider: data.email_provider,
        email_provider_config: data.email_provider_config,
      }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      setEditOpen(false);
      setEditingId(null);
      toast({ title: "Tenant Updated", description: "Tenant settings have been saved." });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const deleteTenant = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("tenants").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      setDeleteTarget(null);
      toast({ title: "Tenant Deleted", description: "The tenant and its associated data have been removed." });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const toggleStatus = useMutation({
    mutationFn: async ({ id, currentStatus }: { id: string; currentStatus: string }) => {
      const newStatus = currentStatus === "active" ? "inactive" : "active";
      const { error } = await supabase.from("tenants").update({ subscription_status: newStatus as any }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      toast({ title: "Status Updated" });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const openEdit = (t: any) => {
    setForm({
      name: t.name,
      slug: t.slug,
      logo_url: t.logo_url || "",
      primary_color: t.primary_color || "#3B82F6",
      secondary_color: t.secondary_color || "#1E293B",
      custom_domain: t.custom_domain || "",
      max_checks_per_month: t.max_checks_per_month || 100,
      subscription_status: t.subscription_status || "trial",
      plan_tier: t.plan_tier || "starter",
      email_from_name: t.email_from_name || "",
      email_from_address: t.email_from_address || "",
      email_reply_to: t.email_reply_to || "",
      email_provider: t.email_provider || "none",
      email_provider_config: (t.email_provider_config as Record<string, string>) || {},
    });
    setEditingId(t.id);
    setEditOpen(true);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active": return "bg-emerald-500/10 text-emerald-400";
      case "trial": return "bg-blue-500/10 text-blue-400";
      default: return "bg-muted text-muted-foreground";
    }
  };

  const updateField = (field: keyof TenantForm, value: any) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const updateConfigField = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, email_provider_config: { ...prev.email_provider_config, [field]: value } }));
  };

  const renderLogoUploader = () => (
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
      {form.logo_url ? (
        <div className="flex items-center gap-3 p-3 border border-border rounded-lg bg-muted/30">
          <img src={form.logo_url} alt="Logo" className="h-10 max-w-[140px] object-contain rounded" onError={(e) => (e.currentTarget.style.display = "none")} />
          <div className="flex gap-1 ml-auto">
            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              Replace
            </Button>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => updateField("logo_url", "")}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full h-20 border-dashed flex flex-col gap-1"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <>
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Click to upload logo (PNG, JPG, SVG — max 2MB)</span>
            </>
          )}
        </Button>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>or paste a URL:</span>
        <Input
          value={form.logo_url}
          onChange={(e) => updateField("logo_url", e.target.value)}
          placeholder="https://..."
          className="h-7 text-xs"
        />
      </div>
    </div>
  );

  const renderEmailConfig = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>From Name</Label>
          <Input
            value={form.email_from_name}
            onChange={(e) => updateField("email_from_name", e.target.value)}
            placeholder="Acme Insurance"
          />
        </div>
        <div className="space-y-2">
          <Label>From Email</Label>
          <Input
            value={form.email_from_address}
            onChange={(e) => updateField("email_from_address", e.target.value)}
            placeholder="checks@acme.com"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Reply-To</Label>
          <Input
            value={form.email_reply_to}
            onChange={(e) => updateField("email_reply_to", e.target.value)}
            placeholder="support@acme.com"
          />
        </div>
        <div className="space-y-2">
          <Label>Email Provider</Label>
          <Select value={form.email_provider} onValueChange={(v) => setForm((prev) => ({ ...prev, email_provider: v, email_provider_config: {} }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Not configured</SelectItem>
              <SelectItem value="smtp">SMTP</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {form.email_provider === "smtp" && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>SMTP Host</Label>
              <Input
                value={form.email_provider_config.host || ""}
                onChange={(e) => updateConfigField("host", e.target.value)}
                placeholder="smtp.example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>SMTP Port</Label>
              <Input
                value={form.email_provider_config.port || ""}
                onChange={(e) => updateConfigField("port", e.target.value)}
                placeholder="587"
              />
            </div>
            <div className="space-y-2">
              <Label>Username</Label>
              <Input
                value={form.email_provider_config.username || ""}
                onChange={(e) => updateConfigField("username", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Password</Label>
              <Input
                type="password"
                value={form.email_provider_config.password || ""}
                onChange={(e) => updateConfigField("password", e.target.value)}
              />
            </div>
          </div>
          <div className="rounded-md bg-muted p-3 space-y-1">
            <p className="text-xs font-medium text-foreground">Quick Setup for Gmail / Outlook:</p>
            <p className="text-xs text-muted-foreground">
              <strong>Gmail:</strong> Host: smtp.gmail.com · Port: 587 · Username: your Gmail · Password: <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener" className="underline">App Password</a> (requires 2FA enabled)
            </p>
            <p className="text-xs text-muted-foreground">
              <strong>Outlook:</strong> Host: smtp.office365.com · Port: 587 · Username: your Outlook email · Password: your account password
            </p>
          </div>
        </div>
      )}

      {form.email_provider !== "none" && (
        <p className="text-xs text-muted-foreground">
          This tenant's endorsement requests and notifications will be sent from their configured email.
        </p>
      )}
    </div>
  );

  const renderBrandingFields = (isEdit?: boolean) => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Organization Name</Label>
          <Input value={form.name} onChange={(e) => updateField("name", e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label>URL Slug</Label>
          <Input
            value={form.slug}
            onChange={(e) => updateField("slug", e.target.value)}
            placeholder="my-company"
            required
            disabled={isEdit}
          />
          {!isEdit && <p className="text-xs text-muted-foreground">Used in the URL: /wl/my-company</p>}
        </div>
      </div>
      {renderLogoUploader()}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Primary Color</Label>
          <div className="flex gap-2">
            <Input type="color" value={form.primary_color} onChange={(e) => updateField("primary_color", e.target.value)} className="w-12 h-10 p-1" />
            <Input value={form.primary_color} onChange={(e) => updateField("primary_color", e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Secondary Color</Label>
          <div className="flex gap-2">
            <Input type="color" value={form.secondary_color} onChange={(e) => updateField("secondary_color", e.target.value)} className="w-12 h-10 p-1" />
            <Input value={form.secondary_color} onChange={(e) => updateField("secondary_color", e.target.value)} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Custom Domain</Label>
          <Input value={form.custom_domain} onChange={(e) => updateField("custom_domain", e.target.value)} placeholder="checks.company.com" />
        </div>
        <div className="space-y-2">
          <Label>Max Checks/Month</Label>
          <Input type="number" value={form.max_checks_per_month} onChange={(e) => updateField("max_checks_per_month", parseInt(e.target.value) || 100)} />
        </div>
      </div>
      {isEdit && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={form.subscription_status} onValueChange={(v) => updateField("subscription_status", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="trial">Trial</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Plan Tier</Label>
            <Select value={form.plan_tier} onValueChange={(v) => updateField("plan_tier", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="starter">Starter</SelectItem>
                <SelectItem value="pro">Pro</SelectItem>
                <SelectItem value="enterprise">Enterprise</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}
    </div>
  );

  const renderFormContent = (isEdit: boolean, onSubmit: () => void, isPending: boolean) => (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="space-y-4">
      <Tabs defaultValue="branding" className="w-full">
        <TabsList className="w-full">
          <TabsTrigger value="branding" className="flex-1">Branding</TabsTrigger>
          <TabsTrigger value="email" className="flex-1">Email</TabsTrigger>
        </TabsList>
        <TabsContent value="branding" className="mt-4">
          {renderBrandingFields(isEdit)}
        </TabsContent>
        <TabsContent value="email" className="mt-4">
          {renderEmailConfig()}
        </TabsContent>
      </Tabs>
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {isEdit ? "Save Changes" : "Create Tenant"}
      </Button>
    </form>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">White-Label Tenants</h3>
          <p className="text-sm text-muted-foreground">Manage organizations using ChecksOps</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Add Tenant</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Create New Tenant</DialogTitle></DialogHeader>
            {renderFormContent(false, () => createTenant.mutate(form), createTenant.isPending)}
          </DialogContent>
        </Dialog>
      </div>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Edit Tenant</DialogTitle></DialogHeader>
          {renderFormContent(true, () => { if (editingId) updateTenant.mutate({ id: editingId, data: form }); }, updateTenant.isPending)}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Tenant</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This will permanently remove the tenant and all associated users, checks, and endorsement data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleteTarget) deleteTenant.mutate(deleteTarget.id); }}
            >
              {deleteTenant.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid gap-3">
          {tenants?.map((t) => (
            <Card key={t.id}>
              <CardContent className="p-4 flex items-center gap-4">
                <div className="p-2 rounded-lg bg-muted">
                  {t.logo_url ? (
                    <img src={t.logo_url} alt={t.name} className="h-5 w-5 object-contain" />
                  ) : (
                    <Building2 className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{t.name}</span>
                    {t.is_system_tenant && <Badge variant="outline" className="text-xs">System</Badge>}
                    <Badge className={`text-xs ${getStatusColor(t.subscription_status)}`}>
                      {t.subscription_status}
                    </Badge>
                    <Badge variant="outline" className="text-xs">{t.plan_tier}</Badge>
                    {t.email_provider && t.email_provider !== "none" && (
                      <Badge variant="outline" className="text-xs text-blue-400">✉ {t.email_provider}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                    <span>/wl/{t.slug}</span>
                    {t.custom_domain && (
                      <span className="flex items-center gap-1">
                        <ExternalLink className="h-3 w-3" /> {t.custom_domain}
                      </span>
                    )}
                  </div>
                </div>
                <div className="w-6 h-6 rounded-full border" style={{ backgroundColor: t.primary_color }} title={`Primary: ${t.primary_color}`} />
                <div className="flex items-center gap-1">
                  {!t.is_system_tenant && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title={t.subscription_status === "active" ? "Deactivate" : "Activate"}
                        onClick={() => toggleStatus.mutate({ id: t.id, currentStatus: t.subscription_status })}
                      >
                        <Power className={`h-4 w-4 ${t.subscription_status === "active" ? "text-emerald-400" : "text-muted-foreground"}`} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Delete"
                        onClick={() => setDeleteTarget({ id: t.id, name: t.name })}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    title="Manage Users"
                    onClick={() => setUsersTarget({ id: t.id, name: t.name })}
                  >
                    <Users className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" title="Edit" onClick={() => openEdit(t)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {usersTarget && (
        <TenantUserManagement
          tenantId={usersTarget.id}
          tenantName={usersTarget.name}
          isOpen={true}
          onClose={() => setUsersTarget(null)}
        />
      )}
    </div>
  );
}
