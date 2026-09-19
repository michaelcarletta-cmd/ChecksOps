import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { isAwsStaging } from "@/lib/awsStaging";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { SettingsHero } from "./SettingsHero";
import { SectionCard } from "./SectionCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Mail, Palette, FileText, Upload, RefreshCw } from "lucide-react";

type FunctionErrorBody = { error?: string; statusCode?: number; status?: string };

type EmailBrandingGet = FunctionErrorBody & {
  settings?: {
    fromName?: string | null;
    replyTo?: string | null;
    canConfigure?: boolean;
  } | null;
};

type EmailPreview = FunctionErrorBody & {
  html?: string;
  from?: string;
  replyTo?: string;
  fallbackFrom?: string;
  customFromReason?: string | null;
};

async function invokeFunction<T extends FunctionErrorBody>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw error;
  const payload = (data || {}) as T;
  if (payload.error) throw new Error(payload.error);
  return payload;
}

const isSafeHex = (value: string) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());

export function TenantBrandingEmailsSettings() {
  const { tenant, refreshTenant } = useTenant();
  const { user, userRole } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const aws = isAwsStaging();

  const tenantId = tenant?.id ?? null;

  const logoInputRef = useRef<HTMLInputElement>(null);
  const letterheadInputRef = useRef<HTMLInputElement>(null);

  const { data: tenantRow, isLoading: loadingTenant } = useQuery({
    queryKey: ["tenant-branding-record", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select(
          "id,name,logo_url,primary_color,secondary_color,invoice_letterhead_url,invoice_footer_note,invoice_default_terms,invoice_accent_color,invoice_theme",
        )
        .eq("id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data as any;
    },
  });

  const { data: membership } = useQuery({
    queryKey: ["tenant-my-role", tenantId, user?.id],
    enabled: !!tenantId && !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_users")
        .select("role")
        .eq("tenant_id", tenantId!)
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as { role?: string } | null;
    },
  });

  const canConfigure = useMemo(() => {
    if (!tenantId) return false;
    if (userRole === "admin") return true;
    const role = String(membership?.role || "").toLowerCase();
    return role === "admin" || role === "owner";
  }, [membership?.role, tenantId, userRole]);

  const { data: emailSettings, isLoading: loadingEmail } = useQuery({
    queryKey: ["tenant-email-branding-settings", tenantId, aws],
    enabled: !!tenantId,
    queryFn: async () => {
      if (aws) {
        const payload = await invokeFunction<EmailBrandingGet>("tenant-email-branding-get", { tenantId });
        return payload.settings ?? null;
      }
      const { data, error } = await supabase
        .from("tenant_email_settings")
        .select("from_name,reply_to")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return {
        fromName: (data as any)?.from_name ?? null,
        replyTo: (data as any)?.reply_to ?? null,
      } as EmailBrandingGet["settings"];
    },
  });

  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [primaryColor, setPrimaryColor] = useState("#3B82F6");
  const [secondaryColor, setSecondaryColor] = useState("#1E293B");

  const [invoiceLetterheadUrl, setInvoiceLetterheadUrl] = useState<string | null>(null);
  const [invoiceFooterNote, setInvoiceFooterNote] = useState("");
  const [invoiceDefaultTerms, setInvoiceDefaultTerms] = useState("");
  const [invoiceAccentColor, setInvoiceAccentColor] = useState("#3B82F6");
  const [invoiceTheme, setInvoiceTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    if (!tenantRow) return;
    setLogoUrl(tenantRow.logo_url ?? null);
    setPrimaryColor(tenantRow.primary_color || "#3B82F6");
    setSecondaryColor(tenantRow.secondary_color || "#1E293B");
    setInvoiceLetterheadUrl(tenantRow.invoice_letterhead_url ?? null);
    setInvoiceFooterNote(tenantRow.invoice_footer_note || "");
    setInvoiceDefaultTerms(tenantRow.invoice_default_terms || "");
    setInvoiceAccentColor(tenantRow.invoice_accent_color || tenantRow.primary_color || "#3B82F6");
    setInvoiceTheme(tenantRow.invoice_theme === "dark" ? "dark" : "light");
  }, [tenantRow]);

  useEffect(() => {
    if (!tenantRow) return;
    setFromName(emailSettings?.fromName || tenantRow.name || "");
    setReplyTo(emailSettings?.replyTo || "");
  }, [emailSettings?.fromName, emailSettings?.replyTo, tenantRow]);

  const previewOverrides = useDebouncedValue(
    {
      fromName,
      replyTo,
      logoUrl,
      primaryColor,
    },
    250,
  );

  const { data: preview, isFetching: fetchingPreview, refetch: refetchPreview } = useQuery({
    queryKey: ["tenant-email-preview", tenantId, aws, previewOverrides],
    enabled: aws && !!tenantId,
    queryFn: async () => {
      return invokeFunction<EmailPreview>("tenant-email-preview", {
        tenantId,
        overrides: previewOverrides,
      });
    },
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      if (!tenantId) throw new Error("No tenant");
      if (!file.type.startsWith("image/")) throw new Error("Please upload an image file.");
      if (file.size > 5 * 1024 * 1024) throw new Error("Logo must be under 5MB.");

      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `${tenantId}/branding/logo-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("tenant-logos")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from("tenant-logos").getPublicUrl(path);
      return data.publicUrl;
    },
    onSuccess: (url) => {
      setLogoUrl(url);
      toast({ title: "Logo uploaded", description: "Preview updated. Click Save to persist." });
    },
    onError: (err: any) => toast({ title: "Upload failed", description: err.message || String(err), variant: "destructive" }),
  });

  const uploadInvoiceLetterhead = useMutation({
    mutationFn: async (file: File) => {
      if (!tenantId) throw new Error("No tenant");
      if (!file.type.startsWith("image/")) throw new Error("Please upload an image file.");
      if (file.size > 8 * 1024 * 1024) throw new Error("Letterhead must be under 8MB.");

      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `${tenantId}/branding/invoice-letterhead-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("tenant-logos")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from("tenant-logos").getPublicUrl(path);
      return data.publicUrl;
    },
    onSuccess: (url) => {
      setInvoiceLetterheadUrl(url);
      toast({ title: "Invoice letterhead uploaded", description: "Click Save to persist." });
    },
    onError: (err: any) => toast({ title: "Upload failed", description: err.message || String(err), variant: "destructive" }),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("No tenant");
      if (!canConfigure) throw new Error("Not authorized");
      if (!isSafeHex(primaryColor)) throw new Error("Primary color must be a hex value like #3B82F6.");
      if (!isSafeHex(secondaryColor)) throw new Error("Secondary color must be a hex value like #1E293B.");
      if (!isSafeHex(invoiceAccentColor)) throw new Error("Invoice accent color must be a hex value like #3B82F6.");

      const tenantPatch: Record<string, unknown> = {
        logo_url: logoUrl || null,
        primary_color: primaryColor.trim(),
        secondary_color: secondaryColor.trim(),
        invoice_letterhead_url: invoiceLetterheadUrl || null,
        invoice_footer_note: invoiceFooterNote.trim() || null,
        invoice_default_terms: invoiceDefaultTerms.trim() || null,
        invoice_accent_color: invoiceAccentColor.trim() || null,
        invoice_theme: invoiceTheme,
      };

      const { error: tenantErr } = await supabase.from("tenants").update(tenantPatch).eq("id", tenantId);
      if (tenantErr) throw tenantErr;

      if (aws) {
        await invokeFunction("tenant-email-branding-save", {
          tenantId,
          fromName: fromName.trim(),
          replyTo: replyTo.trim(),
          fromLocalPart: "noreply",
        });
      } else {
        const { error: emailErr } = await supabase
          .from("tenant_email_settings")
          .upsert(
            {
              tenant_id: tenantId,
              from_name: fromName.trim() || null,
              reply_to: replyTo.trim() || null,
            },
            { onConflict: "tenant_id" },
          );
        if (emailErr) throw emailErr;
      }
    },
    onSuccess: async () => {
      toast({ title: "Branding saved" });
      qc.invalidateQueries({ queryKey: ["tenant-branding-record", tenantId] });
      qc.invalidateQueries({ queryKey: ["tenant-email-branding-settings", tenantId] });
      qc.invalidateQueries({ queryKey: ["tenant-email-preview", tenantId] });
      await refreshTenant();
    },
    onError: (err: any) => toast({ title: "Save failed", description: err.message || String(err), variant: "destructive" }),
  });

  if (!tenantId) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">Select a tenant to edit Branding & Emails.</CardContent>
      </Card>
    );
  }

  const busy = loadingTenant || loadingEmail;

  return (
    <div className="space-y-6">
      <SettingsHero
        title="Branding & Emails"
        description="Edit your sender identity, email branding, and invoice appearance. Changes are tenant-scoped."
        badge="Communication"
        icon={<Palette className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Email branding"
        icon={<Mail className="h-4 w-4 text-sky-500" />}
        accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
        description="ChecksOps sends from the platform domain. Your logo/colors and Reply-To are applied."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="from-name">Sender display name</Label>
            <Input
              id="from-name"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              maxLength={120}
              disabled={!canConfigure || busy}
              placeholder={tenantRow?.name || "Your company"}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="reply-to">Reply-To</Label>
            <Input
              id="reply-to"
              type="email"
              value={replyTo}
              onChange={(e) => setReplyTo(e.target.value)}
              maxLength={254}
              disabled={!canConfigure || busy}
              placeholder="claims@yourcompany.com"
            />
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Logo</Label>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadLogo.mutate(f);
                e.target.value = "";
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canConfigure || uploadLogo.isPending}
                onClick={() => logoInputRef.current?.click()}
              >
                {uploadLogo.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                {logoUrl ? "Replace logo" : "Upload logo"}
              </Button>
              {logoUrl && (
                <Button type="button" size="sm" variant="ghost" disabled={!canConfigure} onClick={() => setLogoUrl(null)}>
                  Remove
                </Button>
              )}
            </div>
            {logoUrl && (
              <div className="rounded-md border bg-white p-3 inline-flex">
                <img src={logoUrl} alt="Tenant logo preview" className="h-10 max-w-[200px] object-contain" />
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Primary brand color</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Primary brand color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded-md border border-border bg-transparent p-1"
                  disabled={!canConfigure}
                />
                <Input
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="font-mono text-xs"
                  disabled={!canConfigure}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Secondary brand color</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Secondary brand color"
                  value={secondaryColor}
                  onChange={(e) => setSecondaryColor(e.target.value)}
                  className="h-9 w-12 cursor-pointer rounded-md border border-border bg-transparent p-1"
                  disabled={!canConfigure}
                />
                <Input
                  value={secondaryColor}
                  onChange={(e) => setSecondaryColor(e.target.value)}
                  className="font-mono text-xs"
                  disabled={!canConfigure}
                />
              </div>
              <p className="text-xs text-muted-foreground">Email uses primary color; secondary is used where supported in the app and invoices.</p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          {aws && (
            <Button type="button" variant="outline" size="sm" onClick={() => void refetchPreview()} disabled={fetchingPreview}>
              {fetchingPreview ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh preview
            </Button>
          )}
          <Button onClick={() => save.mutate()} disabled={!canConfigure || save.isPending || busy}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>

        {!canConfigure && (
          <p className="text-xs text-muted-foreground">
            Only tenant administrators (or platform admins) can edit Branding & Emails.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="Email preview"
        icon={<Mail className="h-4 w-4 text-emerald-500" />}
        accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
        description={aws ? "Preview renders through the same ChecksOps email layout used by transactional emails." : "Preview is available in AWS email mode."}
      >
        {aws ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="secondary">From</Badge>
              <span className="break-all">{preview?.from || "—"}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="secondary">Reply-To</Badge>
              <span className="break-all">{preview?.replyTo || replyTo || "—"}</span>
            </div>
            {preview?.customFromReason && (
              <p className="text-xs text-muted-foreground">
                Note: tenant custom From is retired ({preview.customFromReason}).
              </p>
            )}
            {preview?.html ? (
              <iframe title="Email preview" className="h-[560px] w-full rounded-md border bg-white" sandbox="" srcDoc={preview.html} />
            ) : (
              <p className="text-xs text-muted-foreground">Preview unavailable.</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Switch to AWS staging email mode to view the live preview.</p>
        )}
      </SectionCard>

      <SectionCard
        title="Invoice branding"
        icon={<FileText className="h-4 w-4 text-violet-500" />}
        accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
        description="Separate what affects Moov-hosted invoices vs the ChecksOps-hosted invoice page."
      >
        <div className="grid gap-6">
          <div className="rounded-md border p-4 space-y-3">
            <div className="font-medium">Moov-hosted invoice</div>
            <p className="text-xs text-muted-foreground">
              Only <code>invoice_footer_note</code> is currently passed into the Moov invoice payload in ChecksOps.
            </p>
            <div className="space-y-2">
              <Label>Footer note (applies to Moov invoice payload)</Label>
              <Textarea
                value={invoiceFooterNote}
                onChange={(e) => setInvoiceFooterNote(e.target.value)}
                rows={2}
                disabled={!canConfigure}
                placeholder="Thank you for your business."
              />
            </div>
          </div>

          <div className="rounded-md border p-4 space-y-4">
            <div className="font-medium">ChecksOps-hosted invoice page</div>

            <div className="space-y-2">
              <Label>Invoice letterhead</Label>
              <input
                ref={letterheadInputRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadInvoiceLetterhead.mutate(f);
                  e.target.value = "";
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canConfigure || uploadInvoiceLetterhead.isPending}
                  onClick={() => letterheadInputRef.current?.click()}
                >
                  {uploadInvoiceLetterhead.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="mr-2 h-4 w-4" />
                  )}
                  {invoiceLetterheadUrl ? "Replace letterhead" : "Upload letterhead"}
                </Button>
                {invoiceLetterheadUrl && (
                  <Button type="button" size="sm" variant="ghost" disabled={!canConfigure} onClick={() => setInvoiceLetterheadUrl(null)}>
                    Remove
                  </Button>
                )}
              </div>
              {invoiceLetterheadUrl && (
                <div className="rounded-md border bg-white p-3 inline-flex">
                  <img src={invoiceLetterheadUrl} alt="Invoice letterhead preview" className="h-14 max-w-[320px] object-contain" />
                </div>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Invoice accent color</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Invoice accent color"
                    value={invoiceAccentColor}
                    onChange={(e) => setInvoiceAccentColor(e.target.value)}
                    className="h-9 w-12 cursor-pointer rounded-md border border-border bg-transparent p-1"
                    disabled={!canConfigure}
                  />
                  <Input
                    value={invoiceAccentColor}
                    onChange={(e) => setInvoiceAccentColor(e.target.value)}
                    className="font-mono text-xs"
                    disabled={!canConfigure}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Invoice theme</Label>
                <div className="flex gap-2">
                  {(["light", "dark"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setInvoiceTheme(mode)}
                      disabled={!canConfigure}
                      className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                        invoiceTheme === mode ? "border-primary ring-1 ring-primary" : "border-border"
                      } ${!canConfigure ? "opacity-60" : "hover:bg-muted/40"}`}
                    >
                      {mode === "light" ? "Light" : "Dark"}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Default terms</Label>
              <Textarea
                value={invoiceDefaultTerms}
                onChange={(e) => setInvoiceDefaultTerms(e.target.value)}
                rows={3}
                disabled={!canConfigure}
                placeholder="Payment is due within 30 days..."
              />
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

