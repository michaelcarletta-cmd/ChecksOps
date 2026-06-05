import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/usePermissions";
import { useTenant } from "@/contexts/TenantContext";
import { Loader2, CreditCard, ShieldCheck, AlertTriangle, Eye, EyeOff } from "lucide-react";

export function ActumSettings() {
  const { isAdmin } = usePermissions();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [showSecrets, setShowSecrets] = useState(false);
  const [form, setForm] = useState({
    actum_parent_id: "",
    actum_sub_id: "",
    actum_syspass: "",
    actum_username: "",
    actum_password: "",
    actum_webhook_secret: "",
  });

  const { data: tenantDetails, isLoading } = useQuery({
    queryKey: ["tenant-actum-config", tenant?.id],
    queryFn: async () => {
      if (!tenant?.id) return null;
      const { data, error } = await supabase
        .from("tenants")
        .select("actum_parent_id, actum_sub_id, actum_syspass, actum_username, actum_password, actum_webhook_secret")
        .eq("id", tenant.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!tenant?.id && isAdmin,
  });

  useEffect(() => {
    if (tenantDetails) {
      setForm({
        actum_parent_id: tenantDetails.actum_parent_id ?? "",
        actum_sub_id: tenantDetails.actum_sub_id ?? "",
        actum_syspass: (tenantDetails as any).actum_syspass ?? "",
        actum_username: (tenantDetails as any).actum_username ?? "",
        actum_password: (tenantDetails as any).actum_password ?? "",
        actum_webhook_secret: tenantDetails.actum_webhook_secret ?? "",
      });
    }
  }, [tenantDetails]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant?.id) throw new Error("No tenant selected");
      const { error } = await supabase
        .from("tenants")
        .update({
          actum_parent_id: form.actum_parent_id.trim() || null,
          actum_sub_id: form.actum_sub_id.trim() || null,
          actum_syspass: form.actum_syspass.trim() || null,
          actum_username: form.actum_username.trim() || null,
          actum_password: form.actum_password.trim() || null,
          actum_webhook_secret: form.actum_webhook_secret.trim() || null,
        })
        .eq("id", tenant.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Actum settings saved" });
      qc.invalidateQueries({ queryKey: ["tenant-actum-config"] });
    },
    onError: (e: any) => {
      toast({
        title: "Save failed",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Actum settings are restricted to administrators.
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isConfigured = !!form.actum_parent_id && !!form.actum_sub_id;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-primary" />
                Actum Processing API Integration
              </CardTitle>
              <CardDescription>
                Configure your independent payment processing account.
              </CardDescription>
            </div>
            <Badge variant={isConfigured ? "default" : "outline"}>
              {isConfigured ? (
                <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> Configured</span>
              ) : (
                <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Incomplete</span>
              )}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="actum_parent_id">Parent ID</Label>
              <Input
                id="actum_parent_id"
                placeholder="Actum Parent ID"
                type={showSecrets ? "text" : "password"}
                value={form.actum_parent_id}
                onChange={(e) => setForm({ ...form, actum_parent_id: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="actum_sub_id">Sub ID</Label>
              <Input
                id="actum_sub_id"
                placeholder="Actum Sub ID"
                type={showSecrets ? "text" : "password"}
                value={form.actum_sub_id}
                onChange={(e) => setForm({ ...form, actum_sub_id: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="actum_syspass">Syspass Secret (API Key)</Label>
              <Input
                id="actum_syspass"
                placeholder="Actum Syspass"
                type={showSecrets ? "text" : "password"}
                value={form.actum_syspass}
                onChange={(e) => setForm({ ...form, actum_syspass: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="actum_username">API Username</Label>
              <Input
                id="actum_username"
                placeholder="Actum API Username"
                type={showSecrets ? "text" : "password"}
                value={form.actum_username}
                onChange={(e) => setForm({ ...form, actum_username: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="actum_password">API Password</Label>
              <Input
                id="actum_password"
                placeholder="Actum API Password"
                type={showSecrets ? "text" : "password"}
                value={form.actum_password}
                onChange={(e) => setForm({ ...form, actum_password: e.target.value })}
              />
            </div>
            <div className="hidden md:block"></div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="actum_webhook_secret">Webhook Secret Key</Label>
              <div className="relative">
                <Input
                  id="actum_webhook_secret"
                  placeholder="Key used to validate incoming webhooks"
                  type={showSecrets ? "text" : "password"}
                  value={form.actum_webhook_secret}
                  onChange={(e) => setForm({ ...form, actum_webhook_secret: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                  onClick={() => setShowSecrets(!showSecrets)}
                >
                  {showSecrets ? <EyeOff className="h-4 w-4 text-muted-foreground" /> : <Eye className="h-4 w-4 text-muted-foreground" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                This should match the secret configured in your Actum Dashboard for webhooks.
              </p>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Save settings
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Technical Integration details</CardTitle>
          <CardDescription>
            Register this webhook URL in your Actum Dashboard to receive payment status updates.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">Postback (Callback) URL</Label>
            <code className="block mt-1 rounded-md bg-muted px-3 py-2 text-xs font-mono break-all">
              {`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/actum-webhook?secret=${form.actum_webhook_secret}`}
            </code>
            <p className="text-[10px] text-muted-foreground mt-1 italic">
              Use this for "Postback URL" or "Callback URL" in your Actum portal to receive real-time updates.
            </p>
          </div>
          <div className="rounded-md bg-blue-500/10 border border-blue-500/20 p-3 text-xs text-blue-700 dark:text-blue-300">
            <p className="font-medium mb-1">Actum Order IDs</p>
            <p>Our system uses <code>payment_[ID]</code> for individual payments and <code>split_[ID]</code> for disbursement splits. Make sure your Actum account is configured to send these back in the <code>orderinfo</code> field.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
