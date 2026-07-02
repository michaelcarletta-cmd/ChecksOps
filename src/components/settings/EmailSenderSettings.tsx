import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import { Loader2, Mail, ShieldCheck, Info } from "lucide-react";

interface TenantEmailSettingsRow {
  id: string;
  tenant_id: string;
  from_name: string | null;
  reply_to: string | null;
  sending_mode: "platform" | "custom";
  provider: "lovable" | "resend" | "mailgun";
  sending_domain: string | null;
  from_address: string | null;
  domain_status: "unverified" | "pending" | "verified" | "failed";
}

const PLATFORM_FROM_ADDRESS = "noreply@checksops.com";

export function EmailSenderSettings() {
  const { tenantId } = useTenantFilter();
  const qc = useQueryClient();

  const { data: tenant } = useQuery({
    queryKey: ["tenant-name-for-email", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("tenants")
        .select("id,name")
        .eq("id", tenantId!)
        .maybeSingle();
      return data;
    },
  });

  const { data: settings, isLoading } = useQuery({
    queryKey: ["tenant-email-settings", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_email_settings" as any)
        .select("*")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return (data as unknown as TenantEmailSettingsRow) || null;
    },
  });

  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");

  useEffect(() => {
    if (settings) {
      setFromName(settings.from_name || "");
      setReplyTo(settings.reply_to || "");
    } else if (tenant && !isLoading) {
      setFromName(tenant.name || "");
      setReplyTo("");
    }
  }, [settings, tenant, isLoading]);

  const save = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("No tenant");
      const payload = {
        tenant_id: tenantId,
        from_name: fromName.trim() || null,
        reply_to: replyTo.trim() || null,
      };
      const { error } = await supabase
        .from("tenant_email_settings" as any)
        .upsert(payload, { onConflict: "tenant_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Email sender settings saved");
      qc.invalidateQueries({ queryKey: ["tenant-email-settings", tenantId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || "Failed to save email settings");
    },
  });

  const previewFrom = `${fromName || tenant?.name || "ChecksOps"} <${PLATFORM_FROM_ADDRESS}>`;

  if (!tenantId) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Select a tenant to configure email sender settings.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Email sender</CardTitle>
              <CardDescription>
                Control how outbound emails from this tenant appear to recipients.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>Platform sender (active)</AlertTitle>
            <AlertDescription>
              Emails are sent through the shared, verified ChecksOps domain
              (<code>notify.checksops.com</code>). Your tenant's name appears in the
              From line and replies route to your Reply-To address.
            </AlertDescription>
          </Alert>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="from-name">From name</Label>
              <Input
                id="from-name"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                placeholder={tenant?.name || "Your company name"}
                maxLength={120}
              />
              <p className="text-xs text-muted-foreground">
                Displayed as the sender in recipients' inboxes.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reply-to">Reply-To address</Label>
              <Input
                id="reply-to"
                type="email"
                value={replyTo}
                onChange={(e) => setReplyTo(e.target.value)}
                placeholder="claims@yourcompany.com"
                maxLength={254}
              />
              <p className="text-xs text-muted-foreground">
                Where replies land. Leave blank to disable Reply-To.
              </p>
            </div>
          </div>

          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Preview</div>
            <div><span className="text-muted-foreground">From:</span> {previewFrom}</div>
            {replyTo && (
              <div><span className="text-muted-foreground">Reply-To:</span> {replyTo}</div>
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Custom sending domain</CardTitle>
              <CardDescription>
                Send mail from your own domain (e.g. <code>mail.yourcompany.com</code>).
              </CardDescription>
            </div>
            <Badge variant="secondary">Coming soon</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              We'll add a self-serve flow to verify your own sending domain via DNS
              records (SPF, DKIM, DMARC). Until then, mail sends from the shared
              ChecksOps sender with your brand name and Reply-To above.
              {settings?.domain_status && settings.domain_status !== "unverified" && (
                <div className="mt-2">
                  Current status: <Badge variant="outline">{settings.domain_status}</Badge>
                </div>
              )}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
