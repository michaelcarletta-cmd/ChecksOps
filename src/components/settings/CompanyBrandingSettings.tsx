import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Upload, Building2, Loader2, Sparkles, Image as ImageIcon, Layout } from "lucide-react";

function SectionCard({
  title,
  icon,
  accent,
  description,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  accent: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden border-border/60 shadow-sm">
      <div className={`h-1.5 ${accent}`} />
      <CardHeader className="flex flex-col gap-1 p-4 pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          {icon}
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-2">{children}</CardContent>
    </Card>
  );
}

export function CompanyBrandingSettings() {
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
  const [uploadingInvoice, setUploadingInvoice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [brandingId, setBrandingId] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    // 1. Get branding details from company_branding
    const { data: brandingData } = await supabase
      .from("company_branding" as any)
      .select("*")
      .limit(1)
      .maybeSingle();
    
    if (brandingData) {
      const branding = brandingData as any;
      setBrandingId(branding.id);
      setCompanyName(branding.company_name || "");
      setAddress(branding.company_address || "");
      setPhone(branding.company_phone || "");
      setEmail(branding.company_email || "");
      setLogoUrl(branding.logo_url || null);
      setLetterheadUrl(branding.letterhead_url || null);
    }

    // 2. Get invoice-specific settings from the current tenant
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: tenantUser } = await supabase
        .from("tenant_users")
        .select("tenant_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (tenantUser) {
        const { data: tenant } = await supabase
          .from("tenants")
          .select("invoice_letterhead_url, invoice_footer_note, invoice_default_terms")
          .eq("id", tenantUser.tenant_id)
          .maybeSingle();
        
        if (tenant) {
          const t = tenant as any;
          setInvoiceLetterheadUrl(t.invoice_letterhead_url || null);
          setInvoiceFooterNote(t.invoice_footer_note || "");
          setInvoiceDefaultTerms(t.invoice_default_terms || "");
        }
      }
    }
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
    setSaving(true);
    try {
      const brandingData = {
        company_name: companyName,
        company_address: address,
        company_phone: phone,
        company_email: email,
        logo_url: logoUrl,
        letterhead_url: letterheadUrl,
        updated_at: new Date().toISOString()
      };

      if (brandingId) {
        await supabase
          .from("company_branding" as any)
          .update(brandingData)
          .eq("id", brandingId);
      } else {
        const { data } = await supabase
          .from("company_branding" as any)
          .insert(brandingData)
          .select()
          .single();
        if (data) setBrandingId((data as any).id);
      }

      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: tenantUser } = await supabase
          .from("tenant_users")
          .select("tenant_id")
          .eq("user_id", user.id)
          .maybeSingle();
        
        if (tenantUser) {
          await supabase
            .from("tenants")
            .update({
              invoice_letterhead_url: invoiceLetterheadUrl,
              invoice_footer_note: invoiceFooterNote,
              invoice_default_terms: invoiceDefaultTerms,
            })
            .eq("id", tenantUser.tenant_id);
        }
      }

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
      <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/15 via-primary/5 to-background p-4 md:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="relative flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-xs font-bold uppercase tracking-widest text-primary">Identity & Branding</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Company Settings</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Configure your organization's visual identity, contact information, and invoice presentation.
          </p>
        </div>
      </div>

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
          title="Letterhead"
          icon={<ImageIcon className="h-4 w-4 text-violet-500" />}
          accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
          description="Upload your primary company letterhead image to use in generated reports and documents."
        >
          <div className="space-y-4">
            {letterheadUrl && (
              <div className="border rounded-lg p-4 bg-muted/50">
                <p className="text-sm text-muted-foreground mb-2">Current Letterhead:</p>
                <img src={letterheadUrl} alt="Company letterhead" className="max-h-32 object-contain" />
              </div>
            )}
            
            <div>
              <Label htmlFor="letterhead-upload" className="cursor-pointer">
                <div className="border-2 border-dashed rounded-lg p-6 text-center hover:bg-muted/50 transition-colors">
                  {uploading ? (
                    <Loader2 className="h-8 w-8 mx-auto mb-2 animate-spin text-muted-foreground" />
                  ) : (
                    <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  )}
                  <p className="text-sm text-muted-foreground">
                    {uploading ? "Uploading..." : "Click to upload letterhead image (PNG, JPG)"}
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
