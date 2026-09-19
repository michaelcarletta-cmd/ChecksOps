import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { useAuth } from "@/hooks/useAuth";
import { isAwsStaging } from "@/lib/awsStaging";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import { Loader2, Mail, ShieldCheck, RefreshCw } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";

interface DnsRecord {
  record?: string;
  name: string;
  type: string;
  value: string;
  ttl?: string | number;
  purpose?: string;
}

interface EmailSettings {
  fromName?: string | null;
  from_name?: string | null;
  replyTo?: string | null;
  reply_to?: string | null;
  logoUrl?: string | null;
  primaryColor?: string | null;
  tenantName?: string | null;
  canConfigure?: boolean;
}

interface FunctionErrorBody {
  error?: string;
  status?: string;
  domainStatus?: string;
  verified?: boolean;
}

interface BrandingPayload extends FunctionErrorBody {
  settings?: EmailSettings | null;
  branding?: Record<string, unknown> | null;
}

interface EmailPreview extends FunctionErrorBody {
  html?: string;
  from?: string;
  replyTo?: string;
  fallbackFrom?: string;
  customFromReason?: string | null;
}

async function invokeFunction<T extends FunctionErrorBody>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw error;
  const payload = (data || {}) as T;
  if (payload.error && !payload.status && payload.verified !== true) {
    throw new Error(payload.error);
  }
  return payload;
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback;
}

export function EmailSenderSettings() {
  const { tenantId } = useTenantFilter();
  const { user, userRole } = useAuth();
  const qc = useQueryClient();
  const aws = isAwsStaging();

  const { data: tenant } = useQuery({
    queryKey: ["tenant-branding-for-email", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("tenants")
        .select("id,name,logo_url,primary_color")
        .eq("id", tenantId!)
        .maybeSingle();
      return data;
    },
  });

  const { data: membership } = useQuery({
    queryKey: ["tenant-email-membership", tenantId, user?.id],
    enabled: !!tenantId && !!user?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("tenant_users")
        .select("role")
        .eq("tenant_id", tenantId!)
        .eq("user_id", user!.id)
        .maybeSingle();
      return data;
    },
  });

  const { data: payload, isLoading } = useQuery({
    queryKey: ["tenant-email-settings", tenantId, aws],
    enabled: !!tenantId,
    queryFn: async () => {
      if (aws) {
        return invokeFunction<BrandingPayload>("tenant-email-branding-get", { tenantId });
      }
      const { data, error } = await supabase
        .from("tenant_email_settings")
        .select("*")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return { settings: (data as unknown as EmailSettings | null), branding: null };
    },
  });

  const settings = payload?.settings || null;
  const platformAdmin = userRole === "admin";
  const canConfigure = aws
    ? Boolean(payload?.settings?.canConfigure)
    : platformAdmin || membership?.role === "admin";

  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");

  useEffect(() => {
    if (settings) {
      setFromName(settings.fromName || settings.from_name || "");
      setReplyTo(settings.replyTo || settings.reply_to || "");
    } else if (tenant && !isLoading) {
      setFromName(tenant.name || "");
      setReplyTo("");
    }
  }, [settings, tenant, isLoading]);

  const tenantName = tenant?.name || settings?.tenantName || "ChecksOps";
  const logoUrl = settings?.logoUrl || tenant?.logo_url || null;
  const primaryColor = settings?.primaryColor || tenant?.primary_color || "#1a56db";

  const { data: preview } = useQuery({
    queryKey: ["tenant-email-preview", tenantId, aws, fromName, replyTo, logoUrl, primaryColor],
    enabled: aws && !!tenantId,
    queryFn: () =>
      invokeFunction<EmailPreview>("tenant-email-preview", {
        tenantId,
        overrides: { fromName, replyTo, logoUrl, primaryColor },
      }),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("No tenant");
      if (!canConfigure) throw new Error("Not authorized");
      if (aws) {
        return invokeFunction<BrandingPayload>("tenant-email-branding-save", {
          tenantId,
          fromName: fromName.trim(),
          replyTo: replyTo.trim(),
          fromLocalPart: "noreply",
        });
      }
      const { error } = await supabase
        .from("tenant_email_settings")
        .upsert(
          {
            tenant_id: tenantId,
            from_name: fromName.trim() || null,
            reply_to: replyTo.trim() || null,
          },
          { onConflict: "tenant_id" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Email branding saved");
      qc.invalidateQueries({ queryKey: ["tenant-email-settings", tenantId] });
      qc.invalidateQueries({ queryKey: ["tenant-email-preview", tenantId] });
    },
    onError: (err) => toast.error(errorMessage(err, "Failed to save email settings")),
  });

  if (!tenantId) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Select a tenant to configure email branding.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsHero
        title="Email Branding"
        description="ChecksOps sends from the platform domain. Tenant branding applies via display name, logo/color, and Reply-To."
        badge="Communication"
        icon={<Mail className="h-4 w-4 text-primary" />}
      />

      <div className="grid gap-6">
        <SectionCard
          title="Sender identity"
          icon={<Mail className="h-4 w-4 text-sky-500" />}
          accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
        >
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>
              Platform sender (active)
            </AlertTitle>
            <AlertDescription>
              ChecksOps sends email from the platform domain. Your logo, color, company name, and Reply-To apply.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-4 rounded-md border bg-muted/30 p-3">
            {logoUrl ? (
              <img src={logoUrl} alt={`${tenantName} logo`} className="h-10 max-w-[180px] object-contain" />
            ) : (
              <div className="text-xs text-muted-foreground">No tenant logo yet — ChecksOps logo is used in mail.</div>
            )}
            <div className="flex items-center gap-2 text-sm">
              <span
                className="h-6 w-6 rounded-full border"
                style={{ backgroundColor: primaryColor }}
                aria-label="Primary brand color"
              />
              <code className="text-xs">{primaryColor}</code>
            </div>
            <div className="text-sm font-medium">{tenantName}</div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="from-name">From display name</Label>
              <Input
                id="from-name"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                placeholder={tenantName}
                maxLength={120}
                disabled={!canConfigure}
              />
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
                disabled={!canConfigure}
              />
              <p className="text-xs text-muted-foreground">
                Operational mailbox such as claims@yourcompany.com. This may differ from the sending subdomain.
              </p>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} disabled={save.isPending || !canConfigure}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save branding
            </Button>
          </div>
          {!canConfigure && (
            <p className="text-xs text-muted-foreground">
              You can view branding. Only tenant administrators or platform administrators can change sender identity fields.
            </p>
          )}
        </SectionCard>

        <SectionCard
          title="Email preview"
          icon={<Mail className="h-4 w-4 text-emerald-500" />}
          accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
        >
          <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
            <div>
              <span className="text-muted-foreground">From:</span> {preview?.from || "—"}
            </div>
            <div>
              <span className="text-muted-foreground">Reply-To:</span> {preview?.replyTo || replyTo || "support@checksops.com"}
            </div>
            {preview?.customFromReason && (
              <div className="text-xs text-muted-foreground">Note: tenant custom From is retired ({preview.customFromReason}).</div>
            )}
          </div>
          {preview?.html ? (
            <iframe
              title="ChecksOps email preview"
              className="h-[520px] w-full rounded-md border bg-white"
              sandbox=""
              srcDoc={preview.html}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Preview uses the shared ChecksOps application-email layout (logo, title, body, button, support footer).
            </p>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
