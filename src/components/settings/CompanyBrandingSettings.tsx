import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Upload, Building2, Loader2, Sparkles, Image as ImageIcon, Layout } from "lucide-react";
import { useTenant } from "@/contexts/TenantContext";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import {
  TENANT_BRANDING_READ_COLUMNS,
  tenantBrandingFromRow,
  tenantBrandingWritePayload,
  type TenantBrandingRow,
} from "@/lib/tenantBranding";

import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";

export function CompanyBrandingSettings() {
  const { tenant } = useTenant();
  const { tenantId } = useTenantFilter();
  const activeTenantId = tenant?.id || tenantId || null;
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
  const [uploadingInvoice, setUploadingInvoice] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    void loadSettings();
    // Reload when the white-label tenant or isolated tenant filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTenantId]);

  const loadSettings = async () => {
    if (!activeTenantId) {
      setCompanyName("");
      setAddress("");
      setPhone("");
      setEmail("");
      setLogoUrl(null);
      setLetterheadUrl(null);
      setInvoiceLetterheadUrl(null);
      return;
    }
    const { data, error } = await supabase
      .from("tenants")
      .select(TENANT_BRANDING_READ_COLUMNS)
      .eq("id", activeTenantId)
      .maybeSingle();
    if (error) {
      toast({ title: "Could not load branding", description: error.message, variant: "destructive" });
      return;
    }
    const branding = tenantBrandingFromRow(data as TenantBrandingRow | null);
    setCompanyName(branding.companyName);
    setAddress(branding.address);
    setPhone(branding.phone);
    setEmail(branding.email);
    setLogoUrl(branding.logoUrl);
    setInvoiceLetterheadUrl(branding.invoiceLetterheadUrl);
    setInvoiceFooterNote(branding.invoiceFooterNote);
    setInvoiceDefaultTerms(branding.invoiceDefaultTerms);
    setInvoiceAccentColor(branding.invoiceAccentColor);
    setInvoiceTheme(branding.invoiceTheme);
  };

  const handleInvoiceLetterheadUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Please upload an image file (PNG, JPG)", variant: "destructive" });
      return;
    }

    setUploadingInvoice(true);
    try {
      const path = `invoice_letterhead_${Date.now()}.${file.name.split(".").pop()}`;
      const { error } = await supabase.storage.from("company-branding").upload(path, file);
      
      if (error) throw error;

      const { data: urlData } = supabase.storage.from("company-branding").getPublicUrl(path);
      
      setInvoiceLetterheadUrl(urlData?.publicUrl || null);
      toast({ title: "Invoice letterhead uploaded successfully" });
    } catch (error: any) {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    } finally {
      setUploadingInvoice(false);
    }
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
      const path = `letterhead_${Date.now()}.${file.name.split(".").pop()}`;
      const { error } = await supabase.storage.from("company-branding").upload(path, file);
      
      if (error) throw error;

      const { data: urlData } = supabase.storage.from("company-branding").getPublicUrl(path);
      
      setLetterheadUrl(urlData?.publicUrl || null);
      toast({ title: "Letterhead uploaded successfully" });
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
      const path = `logo_${Date.now()}.${file.name.split(".").pop()}`;
      const { error } = await supabase.storage.from("company-branding").upload(path, file);
      
      if (error) throw error;

      const { data: urlData } = supabase.storage.from("company-branding").getPublicUrl(path);
      
      setLogoUrl(urlData?.publicUrl || null);
      toast({ title: "Company logo uploaded successfully" });
    } catch (error: any) {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    } finally {
      setUploadingLogo(false);
    }
  };

  const saveSettings = async () => {
    if (!activeTenantId) {
      toast({ title: "No tenant selected", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = tenantBrandingWritePayload({
        companyName,
        address,
        phone,
        email,
        logoUrl,
        invoiceLetterheadUrl,
        invoiceFooterNote,
        invoiceDefaultTerms,
        invoiceAccentColor,
        invoiceTheme,
      });
      const { error } = await supabase
        .from("tenants")
        .update(payload)
        .eq("id", activeTenantId);
      if (error) throw error;
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
                placeholder="Company name"
              />
            </div>

            <div>
              <Label>Address</Label>
              <Textarea
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Street address"
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Phone</Label>
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Phone"
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email"
                  readOnly
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
                  <img src={logoUrl} alt="Company logo" className="h-12 w-auto object-contain" />
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
                  <img src={letterheadUrl} alt="Company letterhead" className="h-12 w-auto object-contain" />
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
          description="Customize the visual presentation and default terms of your customer-facing invoices."
        >
          <div className="space-y-4">
            <div>
              <Label>Invoice Letterhead</Label>
              <div className="mt-2">
                <Label
                  htmlFor="invoice-letterhead-upload"
                  className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-lg cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    {invoiceLetterheadUrl ? (
                      <img src={invoiceLetterheadUrl} alt="Invoice Letterhead Preview" className="h-20 object-contain mb-2" />
                    ) : (
                      <Upload className="h-8 w-8 text-muted-foreground mb-2" />
                    )}
                    <p className="text-sm text-muted-foreground">
                      {uploadingInvoice ? "Uploading..." : "Click to upload invoice letterhead"}
                    </p>
                  </div>
                </Label>
                <Input
                  id="invoice-letterhead-upload"
                  type="file"
                  accept="image/*"
                  onChange={handleInvoiceLetterheadUpload}
                  className="hidden"
                  disabled={uploadingInvoice}
                />
              </div>
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
