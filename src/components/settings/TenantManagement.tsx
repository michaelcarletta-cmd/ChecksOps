import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Building2, ExternalLink, Loader2, Pencil, Power } from "lucide-react";

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
};

export function TenantManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<TenantForm>(defaultForm);
  const [editingId, setEditingId] = useState<string | null>(null);

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
        subscription_status: data.subscription_status,
        plan_tier: data.plan_tier,
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

  const toggleStatus = useMutation({
    mutationFn: async ({ id, currentStatus }: { id: string; currentStatus: string }) => {
      const newStatus = currentStatus === "active" ? "inactive" : "active";
      const { error } = await supabase.from("tenants").update({ subscription_status: newStatus }).eq("id", id);
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

  const TenantFormFields = ({ isEdit }: { isEdit?: boolean }) => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Organization Name</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </div>
        <div className="space-y-2">
          <Label>URL Slug</Label>
          <Input
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
            placeholder="my-company"
            required
            disabled={isEdit}
          />
          {!isEdit && <p className="text-xs text-muted-foreground">Used in the URL: /wl/my-company</p>}
        </div>
      </div>
      <div className="space-y-2">
        <Label>Logo URL</Label>
        <Input value={form.logo_url} onChange={(e) => setForm({ ...form, logo_url: e.target.value })} placeholder="https://example.com/logo.png" />
        <p className="text-xs text-muted-foreground">
          A direct link to an image file (PNG, JPG, SVG). Upload your logo to any image host and paste the URL here.
        </p>
        {form.logo_url && (
          <div className="mt-2 p-2 border border-border rounded-md bg-muted/30 flex items-center gap-2">
            <img src={form.logo_url} alt="Logo preview" className="h-8 max-w-[120px] object-contain" onError={(e) => (e.currentTarget.style.display = "none")} />
            <span className="text-xs text-muted-foreground">Preview</span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Primary Color</Label>
          <div className="flex gap-2">
            <Input type="color" value={form.primary_color} onChange={(e) => setForm({ ...form, primary_color: e.target.value })} className="w-12 h-10 p-1" />
            <Input value={form.primary_color} onChange={(e) => setForm({ ...form, primary_color: e.target.value })} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Secondary Color</Label>
          <div className="flex gap-2">
            <Input type="color" value={form.secondary_color} onChange={(e) => setForm({ ...form, secondary_color: e.target.value })} className="w-12 h-10 p-1" />
            <Input value={form.secondary_color} onChange={(e) => setForm({ ...form, secondary_color: e.target.value })} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Custom Domain</Label>
          <Input value={form.custom_domain} onChange={(e) => setForm({ ...form, custom_domain: e.target.value })} placeholder="checks.company.com" />
        </div>
        <div className="space-y-2">
          <Label>Max Checks/Month</Label>
          <Input type="number" value={form.max_checks_per_month} onChange={(e) => setForm({ ...form, max_checks_per_month: parseInt(e.target.value) || 100 })} />
        </div>
      </div>
      {isEdit && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={form.subscription_status} onValueChange={(v) => setForm({ ...form, subscription_status: v })}>
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
            <Select value={form.plan_tier} onValueChange={(v) => setForm({ ...form, plan_tier: v })}>
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">White-Label Tenants</h3>
          <p className="text-sm text-muted-foreground">Manage organizations using the Check Command Center</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Add Tenant</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Create New Tenant</DialogTitle></DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); createTenant.mutate(form); }} className="space-y-4">
              <TenantFormFields />
              <Button type="submit" className="w-full" disabled={createTenant.isPending}>
                {createTenant.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Tenant
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Tenant</DialogTitle></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); if (editingId) updateTenant.mutate({ id: editingId, data: form }); }} className="space-y-4">
            <TenantFormFields isEdit />
            <Button type="submit" className="w-full" disabled={updateTenant.isPending}>
              {updateTenant.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </form>
        </DialogContent>
      </Dialog>

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
                  <Building2 className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{t.name}</span>
                    {t.is_system_tenant && <Badge variant="outline" className="text-xs">System</Badge>}
                    <Badge className={`text-xs ${getStatusColor(t.subscription_status)}`}>
                      {t.subscription_status}
                    </Badge>
                    <Badge variant="outline" className="text-xs">{t.plan_tier}</Badge>
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
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      title={t.subscription_status === "active" ? "Deactivate" : "Activate"}
                      onClick={() => toggleStatus.mutate({ id: t.id, currentStatus: t.subscription_status })}
                    >
                      <Power className={`h-4 w-4 ${t.subscription_status === "active" ? "text-emerald-400" : "text-muted-foreground"}`} />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8" title="Edit" onClick={() => openEdit(t)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
