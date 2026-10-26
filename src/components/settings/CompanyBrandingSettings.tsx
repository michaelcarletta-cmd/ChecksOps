import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Upload, Building2, Loader2, Sparkles, Image as ImageIcon } from "lucide-react";

import { brandingPublicUrl } from "@/lib/brandingPublicUrl";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";

/**
 * Tenant Company Information + document letterhead (tenants columns, SQL 93).
 * Saved separately from the core branding update so a backend without these
 * columns yet still saves the logo and invoice fields.
 */
const TENANT_COMPANY_INFO_COLUMNS = "company_address, company_phone, company_email, letterhead_url";

/**
 * Each tenant edits its own branding within the tenant. Everything here is
 * stored on the current tenant's row; the platform-owner-only
 * `company_branding` table is never read or written.
 */
export function CompanyBrandingSettings() {
  // Route-scoped current organisation; never "whichever membership comes first".
  const { tenant, refreshTenant } = useTenant();
  const tenantId = tenant?.id ?? null;
  const [companyName, setCompanyName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [letterheadUrl, setLetterheadUrl] = useState<string | null>(null);
  const [invoiceLetterheadUrl, setInvoiceLetterheadUrl] = useState<string | null>(null);
  const [invoiceFooterNote, setInvoiceFooterNote] = useState("");
  const [invoiceDefaultTerms, setInvoiceDefaultTerms] = useState("");
  
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    loadSettings();
  }, [tenantId]);

  const loadSettings = async () => {
    if (!tenantId) return;
    // 1. Application/sidebar logo, company name and allowlisted invoice fields live on the current tenant.
    // The invoice fields have no editor here (invoice branding settings were retired); they are
    // loaded and saved back unchanged because public invoices still read them.
    const { data: tenantRow } = await supabase
      .from("tenants")
      .select("name, logo_url, invoice_letterhead_url, invoice_footer_note, invoice_default_terms")
      .eq("id", tenantId)
      .maybeSingle();

    if (tenantRow) {
      const t = tenantRow as any;
      setCompanyName(t.name || "");
      if (t.logo_url) setLogoUrl(t.logo_url);
      setInvoiceLetterheadUrl(t.invoice_letterhead_url || null);
      setInvoiceFooterNote(t.invoice_footer_note || "");
      setInvoiceDefaultTerms(t.invoice_default_terms || "");
    }

    // 2. The tenant's own Company Information + document letterhead.
    const { data: infoRow } = await supabase
      .from("tenants" as any)
      .select(TENANT_COMPANY_INFO_COLUMNS)
      .eq("id", tenantId)
      .maybeSingle();
    if (infoRow) {
      const info = infoRow as any;
      setAddress(info.company_address || "");
      setPhone(info.company_phone || "");
      setEmail(info.company_email || "");
      setLetterheadUrl(info.letterhead_url || null);
    }
  };

  const handleLetterheadUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Please upload an image file (PNG, JPG)", variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "File too large", description: "Letterhead must be under 5MB.", variant: "destructive" });
      return;
    }
    if (!tenantId) {
      toast({ title: "Upload failed", description: "No tenant is available to store this letterhead.", variant: "destructive" });
      return;
    }

    setUploading(true);
    try {
      // Same tenant-scoped branding path as the logo: tenant-logos/{tenantId}/...
      const ext = file.name.split(".").pop() || "png";
      const path = `${tenantId}/letterhead-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("tenant-logos").upload(path, file, {
        upsert: true,
        contentType: file.type,
      });

      if (error) throw error;

      const { data: urlData } = supabase.storage.from("tenant-logos").getPublicUrl(path);
      
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
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "File too large", description: "Logo must be under 5MB.", variant: "destructive" });
      return;
    }
    if (!tenantId) {
      toast({ title: "Upload failed", description: "No tenant is available to store this logo.", variant: "destructive" });
      return;
    }

    setUploadingLogo(true);
    try {
      const ext = file.name.split(".").pop() || "png";
      const path = `${tenantId}/logo-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("tenant-logos").upload(path, file, {
        upsert: true,
        contentType: file.type,
      });
      
      if (error) throw error;

      const { data: urlData } = supabase.storage.from("tenant-logos").getPublicUrl(path);
      
      setLogoUrl(urlData?.publicUrl || null);
      toast({ title: "Company logo uploaded successfully" });
    } catch (error: any) {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    } finally {
      setUploadingLogo(false);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      // Everything is stored on the current tenant's own row.
      const resolvedTenantId = tenantId;
      if (!resolvedTenantId) {
        if (logoUrl || letterheadUrl) throw new Error("Unable to persist company logo without a tenant.");
      } else {
        const trimmedName = companyName.trim();
        const { error: tenantError } = await supabase
          .from("tenants")
          .update({
            ...(trimmedName ? { name: trimmedName } : {}),
            logo_url: logoUrl,
            invoice_letterhead_url: invoiceLetterheadUrl,
            invoice_footer_note: invoiceFooterNote,
            invoice_default_terms: invoiceDefaultTerms,
          })
          .eq("id", resolvedTenantId);
        if (tenantError) throw tenantError;

        const { error: infoError } = await supabase
          .from("tenants" as any)
          .update({
            company_address: address,
            company_phone: phone,
            company_email: email,
            letterhead_url: letterheadUrl,
          })
          .eq("id", resolvedTenantId);
        await refreshTenant();
        if (infoError) throw infoError;
      }

      toast({ title: "Company settings saved" });
    } catch (error: any) {
      toast({ title: "Error saving settings", description: error.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const logoSrc = brandingPublicUrl(logoUrl, "tenant-logos") || logoUrl;
  const letterheadSrc = brandingPublicUrl(letterheadUrl, "tenant-logos") || letterheadUrl;

  return (
    <div className="space-y-6">
      {/* Hero Section */}
      <SettingsHero
        title="Company Settings"
        description="Configure your organization's visual identity and contact information."
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
                placeholder="Your Company Name"
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
                  placeholder="claims@yourcompany.com"
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
              
              {logoSrc && (
                <div className="border rounded-lg p-4 bg-muted/50 flex items-center justify-center">
                  <img src={logoSrc} alt="Company logo" className="h-12 w-auto object-contain" />
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
              
              {letterheadSrc && (
                <div className="border rounded-lg p-4 bg-muted/50 flex items-center justify-center">
                  <img src={letterheadSrc} alt="Company letterhead" className="h-12 w-auto object-contain" />
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
      </div>

      <div className="flex justify-end pt-4">
        <Button onClick={saveSettings} disabled={saving} size="lg">
          {saving ? "Saving..." : "Save Company Settings"}
        </Button>
      </div>
    </div>
  );
}
