import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/usePermissions";
import { useTenant } from "@/contexts/TenantContext";
import { Loader2, CreditCard, ShieldCheck, AlertTriangle, Eye, EyeOff, FlaskConical, Rocket, Database } from "lucide-react";

type Env = "test" | "production";

export function ActumSettings() {
  const { isAdmin } = usePermissions();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [showSecrets, setShowSecrets] = useState(true);
  const [form, setForm] = useState({
    actum_environment: "test" as Env,
    // production
    actum_parent_id: "",
    actum_sub_id_ppd: "",
    actum_sub_id_ccd: "",
    actum_syspass: "",
    actum_username: "",
    actum_password: "",
    // test
    actum_test_parent_id: "",
    actum_test_sub_id_ppd: "",
    actum_test_sub_id_ccd: "",
    actum_test_syspass: "",
    actum_test_username: "",
    actum_test_password: "",
    // shared
    actum_webhook_secret: "",
    actum_credits_only: false,
  });

  const { data: tenantDetails, isLoading } = useQuery({
    queryKey: ["tenant-actum-config", tenant?.id],
    queryFn: async () => {
      if (!tenant?.id) return null;
      const { data, error } = await supabase
        .from("tenants")
        .select(
          "actum_credits_only, actum_environment, actum_parent_id, actum_sub_id_ppd, actum_sub_id_ccd, actum_syspass, actum_username, actum_password, actum_test_parent_id, actum_test_sub_id_ppd, actum_test_sub_id_ccd, actum_test_syspass, actum_test_username, actum_test_password, actum_webhook_secret",
        )
        .eq("id", tenant.id)
        .single();
      if (error) throw error;
      return data as any;
    },
    enabled: !!tenant?.id && isAdmin,
  });

  useEffect(() => {
    if (tenantDetails) {
      setForm({
        actum_environment: (tenantDetails.actum_environment as Env) ?? "test",
        actum_parent_id: tenantDetails.actum_parent_id ?? "",
        actum_sub_id_ppd: tenantDetails.actum_sub_id_ppd ?? "",
        actum_sub_id_ccd: tenantDetails.actum_sub_id_ccd ?? "",
        actum_syspass: tenantDetails.actum_syspass ?? "",
        actum_username: tenantDetails.actum_username ?? "",
        actum_password: tenantDetails.actum_password ?? "",
        actum_test_parent_id: tenantDetails.actum_test_parent_id ?? "",
        actum_test_sub_id_ppd: tenantDetails.actum_test_sub_id_ppd ?? "",
        actum_test_sub_id_ccd: tenantDetails.actum_test_sub_id_ccd ?? "",
        actum_test_syspass: tenantDetails.actum_test_syspass ?? "",
        actum_test_username: tenantDetails.actum_test_username ?? "",
        actum_test_password: tenantDetails.actum_test_password ?? "",
        actum_webhook_secret: tenantDetails.actum_webhook_secret ?? "",
        actum_credits_only: (tenantDetails as any).actum_credits_only === true,
      });
    }
  }, [tenantDetails]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant?.id) throw new Error("No tenant selected");
      const { error } = await supabase
        .from("tenants")
        .update({
          actum_environment: form.actum_environment,
          actum_parent_id: form.actum_parent_id.trim() || null,
          actum_sub_id: null,
          actum_sub_id_ppd: form.actum_sub_id_ppd.trim() || null,
          actum_sub_id_ccd: form.actum_sub_id_ccd.trim() || null,
          actum_syspass: form.actum_syspass.trim() || null,
          actum_username: form.actum_username.trim() || null,
          actum_password: form.actum_password.trim() || null,
          actum_test_parent_id: form.actum_test_parent_id.trim() || null,
          actum_test_sub_id_ppd: form.actum_test_sub_id_ppd.trim() || null,
          actum_test_sub_id_ccd: form.actum_test_sub_id_ccd.trim() || null,
          actum_test_syspass: form.actum_test_syspass.trim() || null,
          actum_test_username: form.actum_test_username.trim() || null,
          actum_test_password: form.actum_test_password.trim() || null,
          actum_webhook_secret: form.actum_webhook_secret.trim() || null,
          actum_credits_only: form.actum_credits_only,
        } as any)
        .eq("id", tenant.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Actum settings saved" });
      qc.invalidateQueries({ queryKey: ["tenant-actum-config"] });
    },
    onError: (e: any) => {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    },
  });

  const fixEmailQueueAuth = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("setup-email-queue-secrets");
      if (error) {
        let msg = error.message ?? "Failed to configure email queue secrets";
        try { const b = await (error as any).context?.json?.(); if (b?.error) msg = b.error; } catch { /* ignore */ }
        throw new Error(msg);
      }
      if ((data as any)?.error) throw new Error((data as any).error);
      return (data as any)?.message as string;
    },
    onSuccess: (message) => toast({ title: "Email queue authentication fixed", description: message }),
    onError: (e: any) => toast({ title: "Fix failed", description: e.message, variant: "destructive" }),
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

  const prodConfigured = !!form.actum_parent_id && (!!form.actum_sub_id_ppd || !!form.actum_sub_id_ccd);
  const testConfigured = !!form.actum_test_parent_id && (!!form.actum_test_sub_id_ppd || !!form.actum_test_sub_id_ccd);
  const activeConfigured = form.actum_environment === "production" ? prodConfigured : testConfigured;

  const renderCredFields = (mode: Env) => {
    const isTest = mode === "test";
    const v = (k: keyof typeof form) => form[k] as string;
    const setK = (k: keyof typeof form, val: string) => setForm({ ...form, [k]: val });
    const prefix = isTest ? "actum_test_" : "actum_";
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Parent ID</Label>
          <Input
            placeholder={`${isTest ? "Test " : ""}Parent ID`}
            type={showSecrets ? "text" : "password"}
            value={v((prefix + "parent_id") as any)}
            onChange={(e) => setK((prefix + "parent_id") as any, e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Sub ID (PPD - Personal)</Label>
          <Input
            placeholder="PPD Sub ID"
            type={showSecrets ? "text" : "password"}
            value={v((prefix + "sub_id_ppd") as any)}
            onChange={(e) => setK((prefix + "sub_id_ppd") as any, e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Sub ID (CCD - Business)</Label>
          <Input
            placeholder="CCD Sub ID"
            type={showSecrets ? "text" : "password"}
            value={v((prefix + "sub_id_ccd") as any)}
            onChange={(e) => setK((prefix + "sub_id_ccd") as any, e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Syspass Secret (API Key)</Label>
          <Input
            placeholder="Syspass"
            type={showSecrets ? "text" : "password"}
            value={v((prefix + "syspass") as any)}
            onChange={(e) => setK((prefix + "syspass") as any, e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>API Username</Label>
          <Input
            placeholder="API Username"
            type={showSecrets ? "text" : "password"}
            value={v((prefix + "username") as any)}
            onChange={(e) => setK((prefix + "username") as any, e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>API Password</Label>
          <Input
            placeholder="API Password"
            type={showSecrets ? "text" : "password"}
            value={v((prefix + "password") as any)}
            onChange={(e) => setK((prefix + "password") as any, e.target.value)}
          />
        </div>
      </div>
    );
  };

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
                Configure your independent payment processing account. Manage Test and Production credentials separately.
              </CardDescription>
            </div>
            <Badge variant={activeConfigured ? "default" : "outline"}>
              {activeConfigured ? (
                <span className="flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3" /> {form.actum_environment === "production" ? "Production" : "Test"} configured
                </span>
              ) : (
                <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Incomplete</span>
              )}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <Label className="text-xs">Active environment</Label>
            <RadioGroup
              value={form.actum_environment}
              onValueChange={(val) => setForm({ ...form, actum_environment: val as Env })}
              className="flex flex-col sm:flex-row gap-3"
            >
              <label
                htmlFor="env-test"
                className={`flex-1 flex items-center gap-2 rounded-md border p-3 cursor-pointer ${
                  form.actum_environment === "test" ? "border-primary bg-primary/5" : ""
                }`}
              >
                <RadioGroupItem value="test" id="env-test" />
                <FlaskConical className="h-4 w-4 text-amber-500" />
                <div className="text-xs">
                  <div className="font-medium">Test / Sandbox</div>
                  <div className="text-muted-foreground">Use Actum-issued test ParentID + SubID for Authentecheck testing</div>
                </div>
              </label>
              <label
                htmlFor="env-prod"
                className={`flex-1 flex items-center gap-2 rounded-md border p-3 cursor-pointer ${
                  form.actum_environment === "production" ? "border-primary bg-primary/5" : ""
                }`}
              >
                <RadioGroupItem value="production" id="env-prod" />
                <Rocket className="h-4 w-4 text-emerald-500" />
                <div className="text-xs">
                  <div className="font-medium">Production</div>
                  <div className="text-muted-foreground">Live processing with real bank verifications and ACH</div>
                </div>
              </label>
            </RadioGroup>
          </div>

          <Tabs defaultValue={form.actum_environment} value={form.actum_environment} onValueChange={(v) => setForm({ ...form, actum_environment: v as Env })}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="test" className="flex items-center gap-2">
                <FlaskConical className="h-3.5 w-3.5" /> Test credentials
                {testConfigured && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
              </TabsTrigger>
              <TabsTrigger value="production" className="flex items-center gap-2">
                <Rocket className="h-3.5 w-3.5" /> Production credentials
                {prodConfigured && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="test" className="pt-4">{renderCredFields("test")}</TabsContent>
            <TabsContent value="production" className="pt-4">{renderCredFields("production")}</TabsContent>
          </Tabs>

          <div className="space-y-1.5">
            <Label htmlFor="actum_webhook_secret">Webhook Secret Key (shared across environments)</Label>
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

          <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="actum_credits_only">Credits-only merchant account</Label>
              <p className="text-xs text-muted-foreground">
                Enable when Actum has provisioned this merchant for ACH credits only. Disbursements
                will push funds to stakeholders without first debiting the primary funding account
                (a debit leg would be declined).
              </p>
            </div>
            <Switch
              id="actum_credits_only"
              checked={form.actum_credits_only}
              onCheckedChange={(v) => setForm({ ...form, actum_credits_only: v })}
            />
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
          <div>
            <Label className="text-xs text-muted-foreground">Authentecheck Postback URL</Label>
            <code className="block mt-1 rounded-md bg-muted px-3 py-2 text-xs font-mono break-all">
              {`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/actum-authentecheck-postback`}
            </code>
            <p className="text-[10px] text-muted-foreground mt-1 italic">
              Send this URL to Actum support to enable bank-verification postbacks (same URL for Test and Production).
            </p>
          </div>
          <div className="rounded-md bg-blue-500/10 border border-blue-500/20 p-3 text-xs text-blue-700 dark:text-blue-300">
            <p className="font-medium mb-1">Actum Order IDs</p>
            <p>Our system uses <code>payment_[ID]</code> for individual payments and <code>split_[ID]</code> for disbursement splits. Make sure your Actum account is configured to send these back in the <code>orderinfo</code> field.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            Email queue authentication (one-time fix)
          </CardTitle>
          <CardDescription>
            Scheduled jobs (transactional email dispatch, CheckAlt status polling) authenticate
            via vault-stored secrets that were never actually created for this project. This
            populates them using this function's own credentials — nothing needs to be typed
            or pasted anywhere. Safe to run more than once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            size="sm"
            variant="outline"
            onClick={() => fixEmailQueueAuth.mutate()}
            disabled={fixEmailQueueAuth.isPending}
          >
            {fixEmailQueueAuth.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Fix email queue authentication
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
