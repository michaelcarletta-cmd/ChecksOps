import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { useAuth } from "@/hooks/useAuth";
import { isAwsAuth } from "@/lib/awsStaging";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import { Loader2, Mail, ShieldCheck, Globe, RefreshCw, Copy, CheckCircle2, AlertTriangle, Ban } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
  dnsRecords?: DnsRecord[] | null;
  dns_records?: DnsRecord[] | null;
  mailFromRecords?: DnsRecord[] | null;
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

const STATUS_LABELS: Record<string, string> = {
  not_configured: "Not configured",
  unverified: "Not configured",
  pending: "Pending DNS",
  verifying: "Verifying",
  verified: "Verified",
  failed: "Failed",
  disabled: "Disabled",
};

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

function copyText(value: string) {
  void navigator.clipboard.writeText(value);
  toast.success("Copied");
}

export function EmailSenderSettings() {
  const { tenantId } = useTenantFilter();
  const { user, userRole } = useAuth();
  const qc = useQueryClient();
  const aws = isAwsAuth();

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
  const [domain, setDomain] = useState("");
  const [fromLocal, setFromLocal] = useState("noreply");

  useEffect(() => {
    if (settings) {
      setFromName(settings.fromName || settings.from_name || "");
      setReplyTo(settings.replyTo || settings.reply_to || "");
      const sending = settings.sendingDomain || settings.sending_domain;
      if (sending) setDomain(sending);
      const addr = settings.fromAddress || settings.from_address;
      if (addr) setFromLocal(String(addr).split("@")[0] || "noreply");
      else if (settings.fromLocalPart) setFromLocal(settings.fromLocalPart);
    } else if (tenant && !isLoading) {
      setFromName(tenant.name || "");
      setReplyTo("");
    }
  }, [settings, tenant, isLoading]);

  const status = String(settings?.domainStatus || settings?.domain_status || "not_configured");
  const isVerified = (settings?.sendingMode || settings?.sending_mode) === "custom" && status === "verified";
  const tenantName = tenant?.name || settings?.tenantName || "ChecksOps";
  const fallbackFrom = `${tenantName} via ChecksOps <${PLATFORM_FROM_ADDRESS}>`;
  const customFrom = `${fromName || tenantName} <${fromLocal || "noreply"}@${domain || "notify.yourdomain.com"}>`;
  const previewFrom = isVerified ? customFrom : fallbackFrom;
  const allDns = useMemo<DnsRecord[]>(() => {
    const dkim = settings?.dnsRecords || settings?.dns_records || [];
    const mailFrom = settings?.mailFromRecords || [];
    return [...dkim, ...mailFrom];
  }, [settings]);
  const logoUrl = settings?.logoUrl || tenant?.logo_url || null;
  const primaryColor = settings?.primaryColor || tenant?.primary_color || "#1a56db";

  const { data: preview } = useQuery({
    queryKey: ["tenant-email-preview", tenantId, aws, isVerified, fromName],
    enabled: aws && !!tenantId,
    queryFn: () => invokeFunction<EmailPreview>("tenant-email-preview", { tenantId }),
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
          fromLocalPart: fromLocal.trim().toLowerCase(),
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

  const registerDomain = useMutation({
    mutationFn: async () => {
      if (!canConfigure) throw new Error("Not authorized");
      return invokeFunction<FunctionErrorBody>("tenant-domain-verify", {
        tenantId,
        domain: domain.trim().toLowerCase(),
        fromLocalPart: fromLocal.trim().toLowerCase(),
        fromName: fromName.trim(),
        replyTo: replyTo.trim(),
      });
    },
    onSuccess: () => {
      toast.success("Domain submitted. Add the DKIM CNAME records below. DNS can take time.");
      qc.invalidateQueries({ queryKey: ["tenant-email-settings", tenantId] });
    },
    onError: (err) => toast.error(errorMessage(err, "Failed to start domain verification")),
  });

  const checkDomain = useMutation({
    mutationFn: async () => {
      if (!canConfigure) throw new Error("Not authorized");
      return invokeFunction<FunctionErrorBody>("tenant-domain-check", { tenantId });
    },
    onSuccess: (data) => {
      const next = data?.status || data?.domainStatus;
      if (data?.verified || next === "verified") toast.success("Domain verified. Custom From is now active.");
      else if (next === "failed") toast.error(data.error || "Verification failed");
      else toast.info("Still pending. DNS changes may take minutes to 48 hours.");
      qc.invalidateQueries({ queryKey: ["tenant-email-settings", tenantId] });
      qc.invalidateQueries({ queryKey: ["tenant-email-preview", tenantId] });
    },
    onError: (err) => toast.error(errorMessage(err, "Check failed")),
  });

  const disableCustom = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("No tenant");
      if (!canConfigure) throw new Error("Not authorized");
      if (aws) {
        return invokeFunction<FunctionErrorBody>("tenant-domain-disable", { tenantId });
      }
      const { error } = await supabase
        .from("tenant_email_settings")
        .update({ sending_mode: "platform" })
        .eq("tenant_id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Custom sending disabled. Mail uses the ChecksOps platform From.");
      qc.invalidateQueries({ queryKey: ["tenant-email-settings", tenantId] });
      qc.invalidateQueries({ queryKey: ["tenant-email-preview", tenantId] });
    },
    onError: (err) => toast.error(errorMessage(err, "Failed to disable custom sending")),
  });

  const statusLabel = settings?.domainStatusLabel || STATUS_LABELS[status] || "Not configured";
  const badgeVariant = status === "verified" ? "default" : status === "failed" ? "destructive" : "secondary";

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
        description="Send branded ChecksOps application emails from a verified tenant subdomain."
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
              {isVerified ? "Custom sending domain (active)" : "Platform sender (active)"}
            </AlertTitle>
            <AlertDescription>
              {isVerified ? (
                <>
                  Emails send from your verified subdomain <code>{settings?.sendingDomain || settings?.sending_domain}</code>.
                  Reply-To stays your operational mailbox. ChecksOps remains the delivery platform.
                </>
              ) : (
                <>
                  Until the subdomain is verified, mail is sent as{" "}
                  <code>{fallbackFrom}</code>. Your logo, color, company name, and Reply-To still apply.
                  DNS changes can take minutes to 48 hours.
                </>
              )}
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
              You can view branding. Only tenant administrators or platform administrators can change the sending domain.
            </p>
          )}
        </SectionCard>

        <SectionCard
          title="Sending subdomain"
          icon={<Globe className="h-4 w-4 text-violet-500" />}
          accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
          description="Verify a subdomain such as notify.yourcompany.com. Do not use your inbound MX hostname."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={badgeVariant}>{statusLabel}</Badge>
            {aws && payload?.settings && payload.settings.domainFeatureEnabled === false && (
              <span className="text-xs text-muted-foreground">SES domain APIs are not enabled in this environment.</span>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
            <div className="space-y-2">
              <Label htmlFor="domain">Sending subdomain</Label>
              <Input
                id="domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="notify.yourcompany.com"
                disabled={!canConfigure || isVerified}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="from-local">From local part</Label>
              <div className="flex items-center gap-1">
                <Input
                  id="from-local"
                  value={fromLocal}
                  onChange={(e) => setFromLocal(e.target.value)}
                  placeholder="noreply"
                  disabled={!canConfigure || isVerified}
                />
                <span className="whitespace-nowrap text-sm text-muted-foreground">@{domain || "…"}</span>
              </div>
            </div>
          </div>

          {canConfigure && (
            <div className="flex flex-wrap gap-2">
              {!isVerified && (
                <Button
                  onClick={() => registerDomain.mutate()}
                  disabled={registerDomain.isPending || !domain.trim()}
                >
                  {registerDomain.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Start domain verification
                </Button>
              )}
              {status !== "not_configured" && status !== "disabled" && (
                <Button
                  variant="outline"
                  onClick={() => checkDomain.mutate()}
                  disabled={checkDomain.isPending}
                >
                  {checkDomain.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  Check verification
                </Button>
              )}
              {(isVerified || status === "pending" || status === "verifying" || status === "failed") && (
                <Button
                  variant="outline"
                  onClick={() => disableCustom.mutate()}
                  disabled={disableCustom.isPending}
                >
                  {disableCustom.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Ban className="mr-2 h-4 w-4" />
                  )}
                  Disable custom sending
                </Button>
              )}
            </div>
          )}

          {isVerified && (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertTitle>Verified</AlertTitle>
              <AlertDescription>
                From: <code>{settings?.fromAddress || customFrom}</code>
              </AlertDescription>
            </Alert>
          )}

          {(settings?.lastVerificationError || settings?.last_verification_error) && status === "failed" && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Verification failed</AlertTitle>
              <AlertDescription>
                {settings.lastVerificationError || settings.last_verification_error}
              </AlertDescription>
            </Alert>
          )}

          {allDns.length > 0 && (
            <div className="space-y-2">
              <div className="text-sm font-medium">DKIM DNS records</div>
              <p className="text-xs text-muted-foreground">
                Add these CNAME records at your DNS host. Do not change your existing inbound MX records.
                Propagation often takes a few minutes and can take up to 48 hours. Then click Check verification.
                Only ChecksOps can mark the domain verified after Amazon SES confirms DKIM signing.
              </p>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Name / host</TableHead>
                      <TableHead>Value / target</TableHead>
                      <TableHead className="w-16">TTL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {allDns.map((r, i) => (
                      <TableRow key={`${r.name}-${i}`}>
                        <TableCell className="font-mono text-xs">{r.type}</TableCell>
                        <TableCell className="break-all font-mono text-xs">
                          <div className="flex items-start gap-2">
                            <span className="flex-1">{r.name}</span>
                            <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => copyText(r.name)}>
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="break-all font-mono text-xs">
                          <div className="flex items-start gap-2">
                            <span className="flex-1">{r.value}</span>
                            <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => copyText(r.value)}>
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{r.ttl || "600"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
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
