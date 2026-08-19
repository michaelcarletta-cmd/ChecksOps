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
import { Loader2, Mail, ShieldCheck, Globe, RefreshCw, Copy, CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";
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
  priority?: number;
  status?: string;
}

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
  dns_records: DnsRecord[] | null;
  last_verification_error: string | null;
  resend_domain_id: string | null;
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
  const [domain, setDomain] = useState("");
  const [fromLocal, setFromLocal] = useState("noreply");

  useEffect(() => {
    if (settings) {
      setFromName(settings.from_name || "");
      setReplyTo(settings.reply_to || "");
      if (settings.sending_domain) setDomain(settings.sending_domain);
      if (settings.from_address) {
        setFromLocal(settings.from_address.split("@")[0] || "noreply");
      }
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

  const registerDomain = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("tenant-domain-verify", {
        body: { tenantId, domain: domain.trim().toLowerCase(), fromLocalPart: fromLocal.trim().toLowerCase() },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: () => {
      toast.success("Domain registered. Add the DNS records below at your registrar.");
      qc.invalidateQueries({ queryKey: ["tenant-email-settings", tenantId] });
    },
    onError: (err: any) => toast.error(err?.message || "Failed to register domain"),
  });

  const checkDomain = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("tenant-domain-check", {
        body: { tenantId },
      });
      if (error) throw error;
      if ((data as any)?.error && (data as any)?.domainStatus !== "verified") {
        // still show the toast for failed states below
      }
      return data as { domainStatus: string; error?: string | null };
    },
    onSuccess: (data) => {
      if (data?.domainStatus === "verified") toast.success("Domain verified! Emails now send from your own domain.");
      else if (data?.domainStatus === "failed") toast.error(data.error || "Verification failed");
      else toast.info("Still pending — DNS may take up to 48 hours to propagate.");
      qc.invalidateQueries({ queryKey: ["tenant-email-settings", tenantId] });
    },
    onError: (err: any) => toast.error(err?.message || "Check failed"),
  });

  const disableCustom = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("No tenant");
      const { error } = await supabase
        .from("tenant_email_settings" as any)
        .update({
          sending_mode: "platform",
          provider: "lovable",
          domain_status: "unverified",
        })
        .eq("tenant_id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Reverted to platform sender");
      qc.invalidateQueries({ queryKey: ["tenant-email-settings", tenantId] });
    },
    onError: (err: any) => toast.error(err?.message || "Failed to revert"),
  });

  const isVerified =
    settings?.sending_mode === "custom" && settings?.domain_status === "verified";
  const previewFrom = isVerified
    ? `${fromName || tenant?.name || "ChecksOps"} <${settings!.from_address}>`
    : `${fromName || tenant?.name || "ChecksOps"} <${PLATFORM_FROM_ADDRESS}>`;

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
    <div className="space-y-6">
      <SettingsHero
        title="Email Sender"
        description="Control how outbound emails from this tenant appear to recipients."
        badge="Communication"
        icon={<Mail className="h-4 w-4 text-primary" />}
      />

      <div className="grid gap-6">
        <SectionCard
          title="Email Sender Configuration"
          icon={<Mail className="h-4 w-4 text-sky-500" />}
          accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
        >
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertTitle>
              {isVerified ? "Custom domain (active)" : "Platform sender (active)"}
            </AlertTitle>
            <AlertDescription>
              {isVerified ? (
                <>
                  Emails send from your verified domain{" "}
                  <code>{settings!.sending_domain}</code>. Your brand name and
                  Reply-To below still apply.
                </>
              ) : (
                <>
                  Emails are sent through the shared, verified ChecksOps domain
                  (<code>notify.checksops.com</code>). Your tenant&apos;s name
                  appears in the From line and replies route to your Reply-To
                  address.
                </>
              )}
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
                Displayed as the sender in recipients&apos; inboxes.
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
            <div>
              <span className="text-muted-foreground">From:</span> {previewFrom}
            </div>
            {replyTo && (
              <div>
                <span className="text-muted-foreground">Reply-To:</span> {replyTo}
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </SectionCard>

        <SectionCard
          title="Custom Sending Domain"
          icon={<Globe className="h-4 w-4 text-violet-500" />}
          accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
          description="Send from your own domain (e.g. mail.yourcompany.com)."
        >
            {settings?.sending_mode === "custom" && (
              <Badge
                variant={
                  settings.domain_status === "verified"
                    ? "default"
                    : settings.domain_status === "failed"
                    ? "destructive"
                    : "secondary"
                }
              >
                {settings.domain_status}
              </Badge>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
          <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
            <div className="space-y-2">
              <Label htmlFor="domain">Sending domain</Label>
              <Input
                id="domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="mail.yourcompany.com"
                disabled={isVerified}
              />
              <p className="text-xs text-muted-foreground">
                Use a subdomain like <code>mail.</code> or <code>notify.</code> — not your root domain.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="from-local">From address prefix</Label>
              <div className="flex items-center gap-1">
                <Input
                  id="from-local"
                  value={fromLocal}
                  onChange={(e) => setFromLocal(e.target.value)}
                  placeholder="noreply"
                  disabled={isVerified}
                />
                <span className="text-sm text-muted-foreground whitespace-nowrap">@{domain || "…"}</span>
              </div>
            </div>
          </div>

          {!isVerified && (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => registerDomain.mutate()}
                disabled={registerDomain.isPending || !domain.trim()}
              >
                {registerDomain.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {settings?.resend_domain_id ? "Re-register domain" : "Register domain"}
              </Button>
              {settings?.resend_domain_id && (
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
            </div>
          )}

          {isVerified && (
            <Alert>
              <CheckCircle2 className="h-4 w-4" />
              <AlertTitle>Verified</AlertTitle>
              <AlertDescription>
                Emails now send from <code>{settings!.from_address}</code>.{" "}
                <Button
                  variant="link"
                  className="h-auto p-0 text-destructive"
                  onClick={() => disableCustom.mutate()}
                >
                  Revert to platform sender
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {settings?.last_verification_error && settings.domain_status === "failed" && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Verification failed</AlertTitle>
              <AlertDescription>{settings.last_verification_error}</AlertDescription>
            </Alert>
          )}

          {settings?.dns_records && settings.dns_records.length > 0 && !isVerified && (
            <div className="space-y-2">
              <div className="text-sm font-medium">DNS records to add</div>
              <p className="text-xs text-muted-foreground">
                Add these at your DNS provider (Cloudflare, GoDaddy, etc.). Then click
                &quot;Check verification&quot;. Propagation can take a few minutes to 48 hours.
              </p>
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle className="text-sm">Using Cloudflare? Two things break verification</AlertTitle>
                <AlertDescription className="text-xs space-y-2 mt-2">
                  <div>
                    <strong>1. Turn OFF the proxy (grey cloud, not orange) on every record.</strong>{" "}
                    Resend's DKIM records are CNAMEs — if Cloudflare's orange cloud is on,
                    it flattens them and verification fails. Click each record → set to
                    <em> DNS only</em>.
                  </div>
                  <div>
                    <strong>2. In the Name field, enter ONLY the prefix</strong> (e.g. <code>send</code>,{" "}
                    <code>resend._domainkey</code>) — not the full domain. Cloudflare
                    auto-appends your root domain, so pasting <code>send.yourdomain.com</code>{" "}
                    becomes <code>send.yourdomain.com.yourdomain.com</code>.
                  </div>
                  <div className="pt-1">
                    Verify with{" "}
                    <a
                      href="https://mxtoolbox.com/SuperTool.aspx"
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      MXToolbox
                    </a>{" "}
                    — the returned value should match the Value column exactly.
                  </div>
                </AlertDescription>
              </Alert>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Name / Host</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead className="w-16">TTL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {settings.dns_records.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-xs">{r.type}</TableCell>
                        <TableCell className="font-mono text-xs break-all">{r.name}</TableCell>
                        <TableCell className="font-mono text-xs break-all">
                          <div className="flex items-start gap-2">
                            <span className="flex-1">{r.value}</span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 shrink-0"
                              onClick={() => {
                                navigator.clipboard.writeText(r.value);
                                toast.success("Copied");
                              }}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{r.ttl || "Auto"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

