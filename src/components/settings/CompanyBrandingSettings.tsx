import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Upload, Building2, Loader2, Image as ImageIcon, Layout } from "lucide-react";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { useQueryClient } from "@tanstack/react-query";
import { TenantLogo } from "@/components/branding/TenantLogo";
import { persistableLogoField } from "@/lib/tenantLogoUrl";

import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";

async function uploadTenantAsset(
  tenantId: string,
  file: File,
  kind: string,
  bucket: "tenant-logos" | "company-branding" = "tenant-logos",
) {
  const ext = file.name.split(".").pop() || "png";
  const path = `${tenantId}/${kind}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  return persistableLogoField(path) || path;
}

export function CompanyBrandingSettings() {
  const { tenantId } = useTenantFilter();
  const qc = useQueryClient();
  const [companyName, setCompanyName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [letterheadUrl, setLetterheadUrl] = useState<string | null>(null);
  const [invoiceLetterheadUrl, setInvoiceLetterheadUrl] = useState<string | null>(null);
  const [invoiceFooterNote, setInvoiceFooterNote] = useState("");
  const [invoiceDefaultTerms, setInvoiceDefaultTerms] = useState("");
  const [invoiceAccentColor, setInvoiceAccentColor] = useState("#3B82F6");
  const [invoiceTheme, setInvoiceTheme] = useState<"light" | "dark">("light");
  
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (tenantId) void loadSettings();
  }, [tenantId]);

  const applyTenant = (tenant: any) => {
    if (!tenant) return;
    setCompanyName(tenant.name || "");
    setAddress(tenant.business_address || "");
    setPhone(tenant.business_phone || "");
    setEmail(tenant.email_reply_to || "");
    setLogoUrl(persistableLogoField(tenant.logo_url) || tenant.logo_url || null);
    setLetterheadUrl(persistableLogoField(tenant.invoice_letterhead_url) || tenant.invoice_letterhead_url || null);
    setInvoiceLetterheadUrl(persistableLogoField(tenant.invoice_letterhead_url) || tenant.invoice_letterhead_url || null);
    setInvoiceFooterNote(tenant.invoice_footer_note || "");
    setInvoiceDefaultTerms(tenant.invoice_default_terms || "");
    setInvoiceAccentColor(tenant.invoice_accent_color || tenant.primary_color || "#3B82F6");
    setInvoiceTheme(tenant.invoice_theme === "dark" ? "dark" : "light");
  };

  const loadSettings = async () => {
    if (!tenantId) return;
    const { data: tenant, error } = await supabase
      .from("tenants")
      .select("name, business_address, business_phone, email_reply_to, logo_url, invoice_letterhead_url, invoice_footer_note, invoice_default_terms, invoice_accent_color, invoice_theme, primary_color")
      .eq("id", tenantId)
      .maybeSingle();
    if (error) {
      toast({ title: "Could not load branding", description: error.message, variant: "destructive" });
      return;
    }
    applyTenant(tenant);
  };

  const handleLetterheadUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Please upload an image file (PNG, JPG)", variant: "destructive" });
      return;
    }

    setUploading(true);
    try {
      if (!tenantId) throw new Error("Select a tenant first");
      const url = await uploadTenantAsset(tenantId, file, "letterhead", "company-branding");
      setLetterheadUrl(url);
      setInvoiceLetterheadUrl(url);
      toast({ title: "Letterhead uploaded successfully" });
    } catch (error: any) {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };
  
  const handleInvoiceLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Please upload an image file (PNG, JPG)", variant: "destructive" });
      return;
    }

    setUploading(true);
    try {
      if (!tenantId) throw new Error("Select a tenant first");
      const url = await uploadTenantAsset(tenantId, file, "invoice-logo", "company-branding");
      setInvoiceLetterheadUrl(url);
      setLetterheadUrl(url);
      toast({ title: "Invoice logo uploaded successfully" });
    } catch (error: any) {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Please upload an image file (PNG, JPG)", variant: "destructive" });
      return;
    }

    setUploadingLogo(true);
    try {
      if (!tenantId) throw new Error("Select a tenant first");
      const url = await uploadTenantAsset(tenantId, file, "logo", "tenant-logos");
      setLogoUrl(url);
      toast({ title: "Company logo uploaded successfully" });
    } catch (error: any) {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    } finally {
      setUploadingLogo(false);
    }
  };

  const saveSettings = async () => {
    if (!tenantId) {
      toast({ title: "Select a tenant first", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const persistLogo = persistableLogoField(logoUrl);
      const persistInvoice = persistableLogoField(invoiceLetterheadUrl || letterheadUrl);
      const { data, error } = await supabase.functions.invoke("tenant-company-branding-save", {
        body: {
          tenant_id: tenantId,
          company_name: companyName,
          company_address: address,
          company_phone: phone,
          company_email: email,
          ...(persistLogo ? { logo_url: persistLogo } : {}),
          ...(persistInvoice ? { invoice_letterhead_url: persistInvoice } : {}),
          invoice_footer_note: invoiceFooterNote,
          invoice_default_terms: invoiceDefaultTerms,
          invoice_accent_color: invoiceAccentColor,
          invoice_theme: invoiceTheme,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).message || (data as any).error);
      applyTenant((data as any)?.tenant);
      qc.invalidateQueries({ queryKey: ["tenant-branding-for-email", tenantId] });
      qc.invalidateQueries({ queryKey: ["tenant-email-settings", tenantId] });
      qc.invalidateQueries({ queryKey: ["tenant-email-preview", tenantId] });
      toast({ title: "Company settings saved" });
    } catch (error: any) {
      toast({ title: "Error saving settings", description: error.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Hero Section */}
      <SettingsHero
        title="Company Settings"
        description="Configure your organization's visual identity, contact information, and invoice presentation."
        badge="Identity & Branding"
      />

      <div className="grid gap-6">
        <SectionCard
          title="Company Information"
          icon={<Building2 className="h-4 w-4 text-sky-500" />}
          accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
          description="This information will appear on generated reports, demand letters, and invoices."
        >
          <div className="space-y-4">
            <div>
              <Label>Company Name</Label>
              <Input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Freedom Claims Adjusting"
              />
            </div>

            <div>
              <Label>Address</Label>
              <Textarea
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="123 Main Street&#10;Suite 100&#10;Philadelphia, PA 19103"
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Phone</Label>
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(555) 123-4567"
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="claims@freedomclaims.com"
                />
              </div>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Logos & Brand Assets"
          icon={<ImageIcon className="h-4 w-4 text-violet-500" />}
          accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
          description="Manage your company logo for the application sidebar and letterhead for generated documents."
        >
          <div className="grid md:grid-cols-2 gap-6">
            {/* Sidebar Logo */}
            <div className="space-y-4">
              <Label className="text-sm font-medium">Application Sidebar Logo</Label>
              <p className="text-xs text-muted-foreground">This logo appears in the top-left corner of the dashboard sidebar.</p>
              
              {logoUrl && (
                <div className="border rounded-lg p-4 bg-muted/50 flex items-center justify-center">
                  <TenantLogo src={logoUrl} alt="Company logo" className="h-12 w-auto object-contain" tenantId={tenantId} />
                </div>
              )}
              
              <div>
                <Label htmlFor="logo-upload" className="cursor-pointer">
                  <div className="border-2 border-dashed rounded-lg p-4 text-center hover:bg-muted/50 transition-colors">
                    {uploadingLogo ? (
                      <Loader2 className="h-6 w-6 mx-auto mb-2 animate-spin text-muted-foreground" />
                    ) : (
                      <Upload className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
                    )}
                    <p className="text-xs text-muted-foreground">
                      {uploadingLogo ? "Uploading..." : "Click to upload square or horizontal logo"}
                    </p>
                  </div>
                </Label>
                <Input
                  id="logo-upload"
                  type="file"
                  accept="image/*"
                  onChange={handleLogoUpload}
                  className="hidden"
                  disabled={uploadingLogo}
                />
              </div>
            </div>

            {/* Document Letterhead */}
            <div className="space-y-4">
              <Label className="text-sm font-medium">Document Letterhead</Label>
              <p className="text-xs text-muted-foreground">Used at the top of generated reports, demand letters, and claim documents.</p>
              
              {letterheadUrl && (
                <div className="border rounded-lg p-4 bg-muted/50 flex items-center justify-center">
                  <TenantLogo src={letterheadUrl} alt="Company letterhead" className="h-12 w-auto object-contain" assetBucket="company-branding" />
                </div>
              )}
              
              <div>
                <Label htmlFor="letterhead-upload" className="cursor-pointer">
                  <div className="border-2 border-dashed rounded-lg p-4 text-center hover:bg-muted/50 transition-colors">
                    {uploading ? (
                      <Loader2 className="h-6 w-6 mx-auto mb-2 animate-spin text-muted-foreground" />
                    ) : (
                      <Upload className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
                    )}
                    <p className="text-xs text-muted-foreground">
                      {uploading ? "Uploading..." : "Click to upload wide letterhead image"}
                    </p>
                  </div>
                </Label>
                <Input
                  id="letterhead-upload"
                  type="file"
                  accept="image/*"
                  onChange={handleLetterheadUpload}
                  className="hidden"
                  disabled={uploading}
                />
              </div>
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Invoice Branding"
          icon={<Layout className="h-4 w-4 text-emerald-500" />}
          accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
          description="Invoice logo is stored independently. Invoice preview uses this logo when set, otherwise the company logo."
        >
          <div className="space-y-4">
            <div>
              <Label>Invoice logo</Label>
              <p className="text-xs text-muted-foreground mt-1 mb-2">
                Persists to the invoice letterhead field. Leave blank to keep the existing invoice logo and fall back to the company logo on invoices.
              </p>
              {(invoiceLetterheadUrl || logoUrl) && (
                <div className="inline-flex items-center rounded-md border bg-white p-3 mb-2">
                  <TenantLogo
                    src={invoiceLetterheadUrl || logoUrl}
                    alt="Invoice logo"
                    className="max-h-16 object-contain"
                    assetBucket={invoiceLetterheadUrl ? "company-branding" : "tenant-logos"}
                    tenantId={invoiceLetterheadUrl ? undefined : tenantId}
                    fallback={<p className="text-sm text-muted-foreground">No invoice logo yet — company logo will be used.</p>}
                  />
                </div>
              )}
              <Label htmlFor="invoice-logo-upload" className="cursor-pointer">
                <div className="border-2 border-dashed rounded-lg p-4 text-center hover:bg-muted/50 transition-colors">
                  {uploading ? (
                    <Loader2 className="h-6 w-6 mx-auto mb-2 animate-spin text-muted-foreground" />
                  ) : (
                    <Upload className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
                  )}
                  <p className="text-xs text-muted-foreground">
                    {uploading ? "Uploading..." : "Click to upload an independent invoice logo"}
                  </p>
                </div>
              </Label>
              <Input
                id="invoice-logo-upload"
                type="file"
                accept="image/*"
                onChange={handleInvoiceLogoUpload}
                className="hidden"
                disabled={uploading}
              />
            </div>

            <div>
              <Label>Invoice Footer Note</Label>
              <Textarea
                value={invoiceFooterNote}
                onChange={(e) => setInvoiceFooterNote(e.target.value)}
                placeholder="Thank you for your business!"
                rows={2}
              />
              <p className="text-xs text-muted-foreground mt-1">Appears at the bottom of the invoice</p>
            </div>

            <div>
              <Label>Default Payment Terms</Label>
              <Textarea
                value={invoiceDefaultTerms}
                onChange={(e) => setInvoiceDefaultTerms(e.target.value)}
                placeholder="Payment is due within 30 days. Please make checks payable to..."
                rows={3}
              />
              <p className="text-xs text-muted-foreground mt-1">Default terms added to every new invoice</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Invoice Accent Color</Label>
                <div className="mt-2 flex items-center gap-3">
                  <input
                    type="color"
                    aria-label="Invoice accent color"
                    value={invoiceAccentColor}
                    onChange={(e) => setInvoiceAccentColor(e.target.value)}
                    className="h-10 w-14 cursor-pointer rounded-md border border-border bg-transparent p-1"
                  />
                  <Input
                    value={invoiceAccentColor}
                    onChange={(e) => setInvoiceAccentColor(e.target.value)}
                    placeholder="#3B82F6"
                    className="font-mono"
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Used for headings, totals, and the Pay now button
                </p>
              </div>

              <div>
                <Label>Invoice Theme</Label>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(["light", "dark"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setInvoiceTheme(mode)}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        invoiceTheme === mode
                          ? "border-primary ring-1 ring-primary"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <div
                        className={`mb-2 h-10 rounded-md border ${
                          mode === "light" ? "bg-white border-neutral-200" : "bg-neutral-900 border-neutral-700"
                        }`}
                        style={{ borderTopColor: invoiceAccentColor, borderTopWidth: 4 }}
                      />
                      <span className="text-sm capitalize">{mode}</span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Applies to the customer-facing invoice page
                </p>
              </div>
            </div>
          </div>
        </SectionCard>
      </div>

      <div className="flex justify-end pt-4">
        <Button onClick={saveSettings} disabled={saving} size="lg">
          {saving ? "Saving..." : "Save Company Settings"}
        </Button>
      </div>
    </div>
  );
}
