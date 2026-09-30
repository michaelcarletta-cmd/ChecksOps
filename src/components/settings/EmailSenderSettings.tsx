import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { useAuth } from "@/hooks/useAuth";
import { isAwsStaging } from "@/lib/awsStaging";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import { Loader2, Mail, ShieldCheck, Upload } from "lucide-react";
import { persistableLogoField, resolveTenantLogoUrl } from "@/lib/tenantLogoUrl";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";

interface EmailSettings {
  fromName?: string | null;
  from_name?: string | null;
  replyTo?: string | null;
  reply_to?: string | null;
  sendingDomain?: string | null;
  sending_domain?: string | null;
  fromAddress?: string | null;
  from_address?: string | null;
  fromLocalPart?: string | null;
  sendingMode?: string | null;
  sending_mode?: string | null;
  domainStatus?: string | null;
  domain_status?: string | null;
  domainStatusLabel?: string | null;
  logoUrl?: string | null;
  primaryColor?: string | null;
  tenantName?: string | null;
  canConfigure?: boolean;
  domainFeatureEnabled?: boolean;
  lastVerificationError?: string | null;
  last_verification_error?: string | null;
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
  usingCustomFrom?: boolean;
  fallbackFrom?: string;
}

const PLATFORM_FROM_ADDRESS = "noreply@checksops.com";

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
  const [primaryColorEdit, setPrimaryColorEdit] = useState("#1a56db");
  const [logoUrlEdit, setLogoUrlEdit] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  useEffect(() => {
    if (settings) {
      setFromName(settings.fromName || settings.from_name || "");
      setReplyTo(settings.replyTo || settings.reply_to || "");
      setPrimaryColorEdit(settings.primaryColor || tenant?.primary_color || "#1a56db");
      setLogoUrlEdit(settings.logoUrl || tenant?.logo_url || null);
    } else if (tenant && !isLoading) {
      setFromName(tenant.name || "");
      setReplyTo("");
      setPrimaryColorEdit(tenant.primary_color || "#1a56db");
      setLogoUrlEdit(tenant.logo_url || null);
    }
  }, [settings, tenant, isLoading]);

  const status = String(settings?.domainStatus || settings?.domain_status || "not_configured");
  const isVerified = (settings?.sendingMode || settings?.sending_mode) === "custom" && status === "verified";
  const tenantName = tenant?.name || settings?.tenantName || "ChecksOps";
  const fallbackFrom = `${tenantName} via ChecksOps <${PLATFORM_FROM_ADDRESS}>`;
  const previewFrom = isVerified
    ? `${fromName || tenantName} <${settings?.fromAddress || PLATFORM_FROM_ADDRESS}>`
    : fallbackFrom;
  const logoUrl = logoUrlEdit || settings?.logoUrl || tenant?.logo_url || null;
  const primaryColor = primaryColorEdit || settings?.primaryColor || tenant?.primary_color || "#1a56db";

  const { data: preview } = useQuery({
    queryKey: ["tenant-email-preview", tenantId, aws, isVerified, fromName, primaryColor, logoUrl],
    enabled: aws && !!tenantId,
    queryFn: () => invokeFunction<EmailPreview>("tenant-email-preview", { tenantId }),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("No tenant");
      if (!canConfigure) throw new Error("Not authorized");
      const persistLogo = persistableLogoField(logoUrlEdit);
      return invokeFunction<BrandingPayload>("tenant-email-branding-save", {
        tenantId,
        fromName: fromName.trim(),
        replyTo: replyTo.trim(),
        primaryColor: primaryColorEdit,
        ...(persistLogo ? { logoUrl: persistLogo } : {}),
      });
    },
    onSuccess: () => {
      toast.success("Email branding saved");
      qc.invalidateQueries({ queryKey: ["tenant-email-settings", tenantId] });
      qc.invalidateQueries({ queryKey: ["tenant-email-preview", tenantId] });
      qc.invalidateQueries({ queryKey: ["tenant-branding-for-email", tenantId] });
    },
    onError: (err) => toast.error(errorMessage(err, "Failed to save email settings")),
  });

  const uploadLogo = async (file: File) => {
    if (!tenantId) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please upload an image file");
      return;
    }
    setUploadingLogo(true);
    try {
      const ext = file.name.split(".").pop() || "png";
      const path = `${tenantId}/email-logo-${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from("tenant-logos")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (error) throw error;
      const stored = persistableLogoField(path) || path;
      setLogoUrlEdit(stored);
      toast.success("Logo uploaded — click Save branding to apply");
    } catch (err) {
      toast.error(errorMessage(err, "Logo upload failed"));
    } finally {
      setUploadingLogo(false);
    }
  };

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
        description="Logo, color theme, and sender identity used by ChecksOps application emails."
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
            <AlertTitle>Platform sender (active)</AlertTitle>
            <AlertDescription>
              Mail is sent as <code>{preview?.from || previewFrom}</code>. Your logo, color theme, company name, and Reply-To apply to the preview and the live email layout. Existing SES delivery is unchanged.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap items-center gap-4 rounded-md border bg-muted/30 p-3">
            {logoUrl ? (
              <img src={resolveTenantLogoUrl(logoUrl) || logoUrl} alt={`${tenantName} logo`} className="h-10 max-w-[180px] object-contain" />
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
              <Label>Email logo</Label>
              <div className="flex items-center gap-3">
                {logoUrl ? (
                  <img src={resolveTenantLogoUrl(logoUrl) || logoUrl} alt={`${tenantName} logo`} className="h-10 max-w-[160px] object-contain" />
                ) : (
                  <span className="text-xs text-muted-foreground">No logo</span>
                )}
                <Label htmlFor="email-logo-upload" className="cursor-pointer">
                  <div className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                    {uploadingLogo ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                    Upload
                  </div>
                </Label>
                <Input
                  id="email-logo-upload"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={!canConfigure || uploadingLogo}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadLogo(file);
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="email-color">Color theme</Label>
              <div className="flex items-center gap-3">
                <input
                  id="email-color"
                  type="color"
                  aria-label="Email brand color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColorEdit(e.target.value)}
                  className="h-10 w-14 cursor-pointer rounded-md border border-border bg-transparent p-1"
                  disabled={!canConfigure}
                />
                <Input
                  value={primaryColor}
                  onChange={(e) => setPrimaryColorEdit(e.target.value)}
                  placeholder="#1a56db"
                  className="font-mono"
                  disabled={!canConfigure}
                />
              </div>
            </div>
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
                Operational mailbox such as claims@yourcompany.com.
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
              You can view branding. Only tenant administrators or platform administrators can save changes.
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
              <span className="text-muted-foreground">From:</span> {preview?.from || previewFrom}
            </div>
            <div>
              <span className="text-muted-foreground">Reply-To:</span> {preview?.replyTo || replyTo || "support@checksops.com"}
            </div>
            {!isVerified && (
              <div className="text-xs text-muted-foreground">
                Pending fallback: {preview?.fallbackFrom || fallbackFrom}
              </div>
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
