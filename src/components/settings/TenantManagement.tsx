import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Building2, ExternalLink, Users, Loader2 } from "lucide-react";

interface TenantForm {
  name: string;
  slug: string;
  logo_url: string;
  primary_color: string;
  secondary_color: string;
  custom_domain: string;
  max_checks_per_month: number;
}

const defaultForm: TenantForm = {
  name: "",
  slug: "",
  logo_url: "",
  primary_color: "#3B82F6",
  secondary_color: "#1E293B",
  custom_domain: "",
  max_checks_per_month: 100,
};

export function TenantManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<TenantForm>(defaultForm);

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
    mutationFn: async (form: TenantForm) => {
      const { error } = await supabase.from("tenants").insert({
        name: form.name,
        slug: form.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        logo_url: form.logo_url || null,
        primary_color: form.primary_color,
        secondary_color: form.secondary_color,
        custom_domain: form.custom_domain || null,
        max_checks_per_month: form.max_checks_per_month,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      setOpen(false);
      setForm(defaultForm);
      toast({ title: "Tenant Created", description: "New white-label tenant has been created." });
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case "active": return "bg-emerald-500/10 text-emerald-400";
      case "trial": return "bg-blue-500/10 text-blue-400";
      default: return "bg-muted text-muted-foreground";
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">White-Label Tenants</h3>
          <p className="text-sm text-muted-foreground">
            Manage organizations using the Check Command Center
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Add Tenant</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Tenant</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createTenant.mutate(form);
              }}
              className="space-y-4"
            >
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
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Logo URL</Label>
                <Input value={form.logo_url} onChange={(e) => setForm({ ...form, logo_url: e.target.value })} placeholder="https://..." />
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
              <Button type="submit" className="w-full" disabled={createTenant.isPending}>
                {createTenant.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Tenant
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

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
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                    <span>/wl/{t.slug}</span>
                    {t.custom_domain && (
                      <span className="flex items-center gap-1">
                        <ExternalLink className="h-3 w-3" /> {t.custom_domain}
                      </span>
                    )}
                    <span>{t.plan_tier}</span>
                  </div>
                </div>
                <div
                  className="w-6 h-6 rounded-full border"
                  style={{ backgroundColor: t.primary_color }}
                  title={`Primary: ${t.primary_color}`}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
