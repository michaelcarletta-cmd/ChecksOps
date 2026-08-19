import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Upload, Building2, FileText, Loader2, Mail, Eye, EyeOff, Palette, FileCheck, Sparkles, Image as ImageIcon, Type, Layout, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";

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

const MERGE_FIELDS = [
  { field: "{signer.name}", label: "Signer Name" },
  { field: "{signer.email}", label: "Signer Email" },
  { field: "{document.name}", label: "Document Name" },
  { field: "{claim.number}", label: "Claim #" },
  { field: "{claim.policyholder}", label: "Policyholder" },
  { field: "{claim.policy_number}", label: "Policy #" },
  { field: "{company.name}", label: "Company Name" },
  { field: "{company.email}", label: "Company Email" },
  { field: "{company.phone}", label: "Company Phone" },
  { field: "{sign.expiry_hours}", label: "Link Expiry (hrs)" },
];

const ENDORSEMENT_MERGE_FIELDS = [
  { field: "{payee.name}", label: "Payee Name" },
  { field: "{check.number}", label: "Check #" },
  { field: "{check.carrier}", label: "Carrier" },
  { field: "{check.amount}", label: "Amount" },
  { field: "{company.name}", label: "Company Name" },
  { field: "{company.email}", label: "Company Email" },
  { field: "{company.phone}", label: "Company Phone" },
];

export function CompanyBrandingSettings() {
  const [companyName, setCompanyName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [letterheadUrl, setLetterheadUrl] = useState<string | null>(null);
  const [invoiceLetterheadUrl, setInvoiceLetterheadUrl] = useState<string | null>(null);
  const [invoiceFooterNote, setInvoiceFooterNote] = useState("");
  const [invoiceDefaultTerms, setInvoiceDefaultTerms] = useState("");
  const [signnowWebhookUrl, setSignnowWebhookUrl] = useState("");
  const [esignEmailSubject, setEsignEmailSubject] = useState("Action Required: Sign {document.name}");
  const [esignEmailBody, setEsignEmailBody] = useState("You have been requested to electronically sign a document. Please review the details below and click the button to proceed.");
  const [esignHeaderColor, setEsignHeaderColor] = useState("#1a56db");
  const [esignButtonColor, setEsignButtonColor] = useState("#1a56db");
  // Endorsement email settings
  const [endorseEmailSubject, setEndorseEmailSubject] = useState("Endorsement Required — Check #{check.number}");
  const [endorseEmailBody, setEndorseEmailBody] = useState("An insurance check requires your endorsement before it can be processed. Please review the details below and complete your endorsement.");
  const [endorseReminderSubject, setEndorseReminderSubject] = useState("Reminder: Endorsement Required — Check #{check.number}");
  const [endorseReminderBody, setEndorseReminderBody] = useState("This is a reminder that your endorsement is still needed for the check below. Please take a moment to review and endorse.");
  const [endorseHeaderColor, setEndorseHeaderColor] = useState("#1e293b");
  const [endorseButtonColor, setEndorseButtonColor] = useState("#2563eb");
  const [vendorCap, setVendorCap] = useState(5);
  const [salesRepCap, setSalesRepCap] = useState(5);
  const [subcontractorCap, setSubcontractorCap] = useState(5);
  const [showEndorsePreview, setShowEndorsePreview] = useState(false);
  const [sigCoords, setSigCoords] = useState({ page: 1, x: 100, y: 600, w: 200, h: 50 });
  const [ocwBankAccountId, setOcwBankAccountId] = useState("");
  const [dateCoords, setDateCoords] = useState({ page: 1, x: 350, y: 600, w: 100, h: 25 });
  const [uploading, setUploading] = useState(false);
  const [uploadingInvoice, setUploadingInvoice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [brandingId, setBrandingId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    // 1. Get branding details from company_branding
    const { data: brandingData, error: brandingError } = await supabase
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
      setLetterheadUrl(branding.letterhead_url || null);
      setSignnowWebhookUrl(branding.zapier_webhook_url || "");
      setEsignEmailSubject(branding.esign_email_subject || "Action Required: Sign {document.name}");
      setEsignEmailBody(branding.esign_email_body || "You have been requested to electronically sign a document. Please review the details below and click the button to proceed.");
      setEsignHeaderColor(branding.esign_email_header_color || "#1a56db");
      setEsignButtonColor(branding.esign_email_button_color || "#1a56db");
      setEndorseEmailSubject(branding.endorsement_email_subject || "Endorsement Required — Check #{check.number}");
      setEndorseEmailBody(branding.endorsement_email_body || "An insurance check requires your endorsement before it can be processed. Please review the details below and complete your endorsement.");
      setEndorseReminderSubject(branding.endorsement_reminder_subject || "Reminder: Endorsement Required — Check #{check.number}");
      setEndorseReminderBody(branding.endorsement_reminder_body || "This is a reminder that your endorsement is still needed for the check below. Please take a moment to review and endorse.");
      setEndorseHeaderColor(branding.endorsement_email_header_color || "#1e293b");
      setEndorseButtonColor(branding.endorsement_email_button_color || "#2563eb");
      setSigCoords({ page: branding.esign_signature_page || 1, x: branding.esign_signature_x || 100, y: branding.esign_signature_y || 600, w: branding.esign_signature_width || 200, h: branding.esign_signature_height || 50 });
      setDateCoords({ page: branding.esign_date_page || 1, x: branding.esign_date_x || 350, y: branding.esign_date_y || 600, w: branding.esign_date_width || 100, h: branding.esign_date_height || 25 });
      setOcwBankAccountId(branding.online_check_writer_bank_account_id || "");
    }

    // 2. Get invoice-specific settings from the current tenant
    // We fetch the current user first to resolve their tenant
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
          .select("invoice_letterhead_url, invoice_footer_note, invoice_default_terms, vendor_cap, sales_rep_cap, subcontractor_cap")
          .eq("id", tenantUser.tenant_id)
          .maybeSingle();
        
        if (tenant) {
          const t = tenant as any;
          setInvoiceLetterheadUrl(t.invoice_letterhead_url || null);
          setInvoiceFooterNote(t.invoice_footer_note || "");
          setInvoiceDefaultTerms(t.invoice_default_terms || "");
          setVendorCap(t.vendor_cap ?? 5);
          setSalesRepCap(t.sales_rep_cap ?? 5);
          setSubcontractorCap(t.subcontractor_cap ?? 5);
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

  const saveSettings = async () => {
    setSaving(true);
    try {
      const brandingData = {
        company_name: companyName,
        company_address: address,
        company_phone: phone,
        company_email: email,
        letterhead_url: letterheadUrl,
        zapier_webhook_url: signnowWebhookUrl || null,
        esign_email_subject: esignEmailSubject,
        esign_email_body: esignEmailBody,
        esign_email_header_color: esignHeaderColor,
        esign_email_button_color: esignButtonColor,
        endorsement_email_subject: endorseEmailSubject,
        endorsement_email_body: endorseEmailBody,
        endorsement_reminder_subject: endorseReminderSubject,
        endorsement_reminder_body: endorseReminderBody,
        endorsement_email_header_color: endorseHeaderColor,
        endorsement_email_button_color: endorseButtonColor,
        esign_signature_page: sigCoords.page,
        esign_signature_x: sigCoords.x,
        esign_signature_y: sigCoords.y,
        esign_signature_width: sigCoords.w,
        esign_signature_height: sigCoords.h,
        esign_date_page: dateCoords.page,
        esign_date_x: dateCoords.x,
        esign_date_y: dateCoords.y,
        esign_date_width: dateCoords.w,
        esign_date_height: dateCoords.h,
        online_check_writer_bank_account_id: ocwBankAccountId || null,
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
              vendor_cap: vendorCap,
              sales_rep_cap: salesRepCap,
              subcontractor_cap: subcontractorCap,
            })
            .eq("id", tenantUser.tenant_id);
        }
      }

      toast({ title: "Company branding saved" });
    } catch (error: any) {
      toast({ title: "Error saving branding", description: error.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const insertMergeField = (field: string, target: "subject" | "body") => {
    if (target === "subject") {
      setEsignEmailSubject((prev) => prev + field);
    } else {
      setEsignEmailBody((prev) => prev + field);
    }
  };

  const previewSubject = esignEmailSubject
    .replace(/\{signer\.name\}/g, "John Smith")
    .replace(/\{signer\.email\}/g, "john@example.com")
    .replace(/\{document\.name\}/g, "Authorization to Represent")
    .replace(/\{claim\.number\}/g, "CLM-2025-0042")
    .replace(/\{claim\.policyholder\}/g, "Jane Doe")
    .replace(/\{claim\.policy_number\}/g, "POL-12345")
    .replace(/\{company\.name\}/g, companyName || "Freedom Claims")
    .replace(/\{company\.email\}/g, email)
    .replace(/\{company\.phone\}/g, phone)
    .replace(/\{sign\.expiry_hours\}/g, "72");

  const previewBody = esignEmailBody
    .replace(/\{signer\.name\}/g, "John Smith")
    .replace(/\{signer\.email\}/g, "john@example.com")
    .replace(/\{document\.name\}/g, "Authorization to Represent")
    .replace(/\{claim\.number\}/g, "CLM-2025-0042")
    .replace(/\{claim\.policyholder\}/g, "Jane Doe")
    .replace(/\{claim\.policy_number\}/g, "POL-12345")
    .replace(/\{company\.name\}/g, companyName || "Freedom Claims")
    .replace(/\{company\.email\}/g, email)
    .replace(/\{company\.phone\}/g, phone)
    .replace(/\{sign\.expiry_hours\}/g, "72");

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
            Configure your organization's visual identity, contact information, and document presentation across the platform.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
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
        </SectionCard>

        <SectionCard
          title="Signature Request Email Template"
          icon={<Mail className="h-4 w-4 text-amber-500" />}
          accent="bg-gradient-to-r from-amber-500/60 to-amber-500/10"
          description="Customize the email sent to signers when a signature is requested. Use merge fields to personalize each email."
        >
          <div className="space-y-5">
          {/* Merge fields reference */}
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">Available Merge Fields (click to insert into body)</Label>
            <div className="flex flex-wrap gap-1.5">
              {MERGE_FIELDS.map((mf) => (
                <Badge
                  key={mf.field}
                  variant="outline"
                  className="cursor-pointer hover:bg-accent text-[11px] font-mono"
                  onClick={() => insertMergeField(mf.field, "body")}
                >
                  {mf.field}
                </Badge>
              ))}
            </div>
          </div>

          <div>
            <Label>Email Subject</Label>
            <Input
              value={esignEmailSubject}
              onChange={(e) => setEsignEmailSubject(e.target.value)}
              placeholder="Action Required: Sign {document.name}"
            />
            <p className="text-xs text-muted-foreground mt-1">Merge fields work in the subject line too.</p>
          </div>

          <div>
            <Label>Email Body</Label>
            <Textarea
              value={esignEmailBody}
              onChange={(e) => setEsignEmailBody(e.target.value)}
              placeholder="You have been requested to electronically sign a document..."
              rows={4}
            />
            <p className="text-xs text-muted-foreground mt-1">
              The document details table and sign button are added automatically below your message.
            </p>
          </div>

          {/* Color customization */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="flex items-center gap-1.5">
                <Palette className="h-3.5 w-3.5" />
                Header Color
              </Label>
              <div className="flex gap-2 items-center mt-1">
                <input
                  type="color"
                  value={esignHeaderColor}
                  onChange={(e) => setEsignHeaderColor(e.target.value)}
                  className="w-10 h-9 rounded border border-border cursor-pointer"
                />
                <Input
                  value={esignHeaderColor}
                  onChange={(e) => setEsignHeaderColor(e.target.value)}
                  className="flex-1 font-mono text-sm"
                  placeholder="#1a56db"
                />
              </div>
            </div>
            <div>
              <Label className="flex items-center gap-1.5">
                <Palette className="h-3.5 w-3.5" />
                Button Color
              </Label>
              <div className="flex gap-2 items-center mt-1">
                <input
                  type="color"
                  value={esignButtonColor}
                  onChange={(e) => setEsignButtonColor(e.target.value)}
                  className="w-10 h-9 rounded border border-border cursor-pointer"
                />
                <Input
                  value={esignButtonColor}
                  onChange={(e) => setEsignButtonColor(e.target.value)}
                  className="flex-1 font-mono text-sm"
                  placeholder="#1a56db"
                />
              </div>
            </div>
          </div>

          {/* Live Preview */}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowPreview(!showPreview)}
              className="mb-3"
            >
              {showPreview ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
              {showPreview ? "Hide Preview" : "Show Email Preview"}
            </Button>

            {showPreview && (
              <div className="border rounded-lg overflow-hidden bg-[#f0f2f5]">
                <div className="p-4 max-h-[500px] overflow-y-auto">
                  {/* Preview container */}
                  <div className="max-w-[480px] mx-auto bg-white rounded-lg overflow-hidden shadow-sm">
                    {/* Header */}
                    <div style={{ backgroundColor: esignHeaderColor }} className="py-5 px-8 text-center">
                      {letterheadUrl ? (
                        <img src={letterheadUrl} alt="Logo" className="max-h-10 mx-auto object-contain" />
                      ) : (
                        <span className="text-white font-bold text-lg">{companyName || "Freedom Claims"}</span>
                      )}
                    </div>
                    {/* Body */}
                    <div className="p-6 text-sm">
                      <p className="font-semibold text-gray-900 mb-1">Hello John Smith,</p>
                      <p className="text-gray-600 leading-relaxed mb-4 whitespace-pre-line">{previewBody}</p>
                      
                      <div className="bg-gray-50 rounded-lg p-4 mb-5 text-xs">
                        <div className="grid grid-cols-[100px_1fr] gap-y-1.5">
                          <span className="text-gray-500">Document</span>
                          <span className="font-semibold text-gray-900">Authorization to Represent</span>
                          <span className="text-gray-500">Claim #</span>
                          <span className="font-semibold text-gray-900">CLM-2025-0042</span>
                          <span className="text-gray-500">Policyholder</span>
                          <span className="font-semibold text-gray-900">Jane Doe</span>
                          <span className="text-gray-500">Policy #</span>
                          <span className="font-semibold text-gray-900">POL-12345</span>
                        </div>
                      </div>

                      <div className="text-center mb-4">
                        <span
                          style={{ backgroundColor: esignButtonColor }}
                          className="inline-block text-white px-8 py-3 rounded-md font-semibold text-sm"
                        >
                          Review & Sign Document
                        </span>
                      </div>

                      <p className="text-center text-[11px] text-gray-400">This link expires in 72 hours.</p>
                    </div>
                    {/* Footer */}
                    <div className="border-t bg-gray-50 px-6 py-4">
                      <p className="text-[11px] text-gray-500">
                        {companyName || "Freedom Claims"}{phone ? ` • ${phone}` : ""}{email ? ` • ${email}` : ""}
                      </p>
                      <p className="text-[10px] text-gray-400">This is an automated message. Please do not reply directly to this email.</p>
                    </div>
                  </div>
                  {/* Subject preview */}
                  <p className="text-center text-xs text-gray-500 mt-3">
                    <strong>Subject:</strong> {previewSubject}
                  </p>
                </div>
              </div>
            )}
          </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Check Endorsement Email Template"
          icon={<Mail className="h-4 w-4 text-sky-500" />}
          accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
          description="Customize the email sent to payees when a check endorsement is required. Reminder emails use a separate subject and body."
        >
          <div className="space-y-5">
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">Available Merge Fields (click to insert)</Label>
            <div className="flex flex-wrap gap-1.5">
              {ENDORSEMENT_MERGE_FIELDS.map((mf) => (
                <Badge
                  key={mf.field}
                  variant="outline"
                  className="cursor-pointer hover:bg-accent text-[11px] font-mono"
                  onClick={() => setEndorseEmailBody((prev) => prev + mf.field)}
                >
                  {mf.field}
                </Badge>
              ))}
            </div>
          </div>

          <div className="space-y-4 border rounded-lg p-4">
            <p className="text-sm font-medium">Initial Request Email</p>
            <div>
              <Label>Subject</Label>
              <Input
                value={endorseEmailSubject}
                onChange={(e) => setEndorseEmailSubject(e.target.value)}
                placeholder="Endorsement Required — Check #{check.number}"
              />
            </div>
            <div>
              <Label>Body</Label>
              <Textarea
                value={endorseEmailBody}
                onChange={(e) => setEndorseEmailBody(e.target.value)}
                rows={3}
              />
              <p className="text-xs text-muted-foreground mt-1">Check details table and endorsement button are added automatically.</p>
            </div>
          </div>

          <div className="space-y-4 border rounded-lg p-4">
            <p className="text-sm font-medium">Reminder Email</p>
            <div>
              <Label>Subject</Label>
              <Input
                value={endorseReminderSubject}
                onChange={(e) => setEndorseReminderSubject(e.target.value)}
                placeholder="Reminder: Endorsement Required — Check #{check.number}"
              />
            </div>
            <div>
              <Label>Body</Label>
              <Textarea
                value={endorseReminderBody}
                onChange={(e) => setEndorseReminderBody(e.target.value)}
                rows={3}
              />
            </div>
          </div>

          {/* Colors */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="flex items-center gap-1.5">
                <Palette className="h-3.5 w-3.5" />
                Header Color
              </Label>
              <div className="flex gap-2 items-center mt-1">
                <input type="color" value={endorseHeaderColor} onChange={(e) => setEndorseHeaderColor(e.target.value)} className="w-10 h-9 rounded border border-border cursor-pointer" />
                <Input value={endorseHeaderColor} onChange={(e) => setEndorseHeaderColor(e.target.value)} className="flex-1 font-mono text-sm" />
              </div>
            </div>
            <div>
              <Label className="flex items-center gap-1.5">
                <Palette className="h-3.5 w-3.5" />
                Button Color
              </Label>
              <div className="flex gap-2 items-center mt-1">
                <input type="color" value={endorseButtonColor} onChange={(e) => setEndorseButtonColor(e.target.value)} className="w-10 h-9 rounded border border-border cursor-pointer" />
                <Input value={endorseButtonColor} onChange={(e) => setEndorseButtonColor(e.target.value)} className="flex-1 font-mono text-sm" />
              </div>
            </div>
          </div>

          {/* Preview */}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowEndorsePreview(!showEndorsePreview)} className="mb-3">
              {showEndorsePreview ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
              {showEndorsePreview ? "Hide Preview" : "Show Email Preview"}
            </Button>

            {showEndorsePreview && (
              <div className="border rounded-lg overflow-hidden bg-[#f0f2f5]">
                <div className="p-4 max-h-[500px] overflow-y-auto">
                  <div className="max-w-[480px] mx-auto bg-white rounded-lg overflow-hidden shadow-sm">
                    <div style={{ backgroundColor: endorseHeaderColor }} className="py-5 px-8 text-center">
                      {letterheadUrl ? (
                        <img src={letterheadUrl} alt="Logo" className="max-h-10 mx-auto object-contain" />
                      ) : (
                        <span className="text-white font-bold text-lg">{companyName || "Freedom Claims"}</span>
                      )}
                    </div>
                    <div className="p-6 text-sm">
                      <p className="font-semibold text-gray-900 mb-1">Hello John Smith,</p>
                      <p className="text-gray-600 leading-relaxed mb-4 whitespace-pre-line">
                        {endorseEmailBody
                          .replace(/\{payee\.name\}/g, "John Smith")
                          .replace(/\{check\.number\}/g, "10042")
                          .replace(/\{check\.carrier\}/g, "State Farm")
                          .replace(/\{check\.amount\}/g, "$12,450.00")
                          .replace(/\{company\.name\}/g, companyName || "Freedom Claims")
                          .replace(/\{company\.email\}/g, email)
                          .replace(/\{company\.phone\}/g, phone)}
                      </p>
                      <div className="bg-gray-50 rounded-lg overflow-hidden mb-5 text-xs">
                        <div className="grid grid-cols-2">
                          <span className="px-4 py-3 text-gray-500 border-b border-gray-200">Carrier</span>
                          <span className="px-4 py-3 font-semibold text-gray-900 text-right border-b border-gray-200">State Farm</span>
                          <span className="px-4 py-3 text-gray-500 border-b border-gray-200">Check #</span>
                          <span className="px-4 py-3 font-semibold text-gray-900 text-right border-b border-gray-200">10042</span>
                          <span className="px-4 py-3 text-gray-500">Amount</span>
                          <span className="px-4 py-3 font-bold text-green-600 text-right">$12,450.00</span>
                        </div>
                      </div>
                      <div className="text-center mb-4">
                        <span style={{ backgroundColor: endorseButtonColor }} className="inline-block text-white px-8 py-3 rounded-md font-semibold text-sm">
                          Review & Endorse Check
                        </span>
                      </div>
                      <p className="text-center text-[11px] text-gray-400">This link expires in 30 days.</p>
                    </div>
                    <div className="border-t bg-gray-50 px-6 py-4">
                      <p className="text-[11px] text-gray-500">{companyName || "Freedom Claims"}{phone ? ` • ${phone}` : ""}{email ? ` • ${email}` : ""}</p>
                      <p className="text-[10px] text-gray-400">This is an automated message. Please do not reply directly to this email.</p>
                    </div>
                  </div>
                  <p className="text-center text-xs text-gray-500 mt-3">
                    <strong>Subject:</strong> {endorseEmailSubject.replace(/\{check\.number\}/g, "10042")}
                  </p>
                </div>
              </div>
            )}
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Online Check Writer"
          icon={<FileCheck className="h-4 w-4 text-blue-500" />}
          accent="bg-gradient-to-r from-blue-500/60 to-blue-500/10"
          description="Configure your Online Check Writer bank account for sending checks."
        >
          <div>
            <Label>Bank Account ID</Label>
            <Input
              value={ocwBankAccountId}
              onChange={(e) => setOcwBankAccountId(e.target.value)}
              placeholder="e.g. QEmZGE7O27jaw3v"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Find this in your Online Check Writer developer settings at{" "}
              <a href="https://live.onlinecheckwriter.com/manage/developer/index" target="_blank" rel="noopener noreferrer" className="underline">
                live.onlinecheckwriter.com/manage/developer
              </a>
            </p>
          </div>
        </SectionCard>

        <SectionCard
          title="Zapier Webhook Integration"
          icon={<FileText className="h-4 w-4 text-orange-500" />}
          accent="bg-gradient-to-r from-orange-500/60 to-orange-500/10"
          description="Configure a Zapier webhook URL for external document signing or automation workflows."
        >
        
          <div>
            <Label>Zapier Webhook URL</Label>
            <Input
              value={signnowWebhookUrl}
              onChange={(e) => setSignnowWebhookUrl(e.target.value)}
              placeholder="https://hooks.zapier.com/hooks/catch/..."
            />
            <p className="text-xs text-muted-foreground mt-1">
              Create a Zap with a Webhooks by Zapier trigger and paste the webhook URL here.
              Documents sent for signature will trigger this webhook.
            </p>
          </div>
          <div className="bg-muted/50 rounded-lg p-4 text-sm space-y-2">
            <p className="font-medium">Callback URL for signed documents:</p>
            <code className="block bg-background p-2 rounded text-xs break-all">
              {import.meta.env.VITE_SUPABASE_URL}/functions/v1/signature-webhook
            </code>
            <p className="text-muted-foreground text-xs">
              Configure SignNow/Make to POST to this URL when documents are signed.
            </p>
          </div>
          <div className="mt-4 space-y-3">
            <p className="font-medium text-sm">Signature Field Coordinates</p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <div><Label className="text-xs">Page</Label><Input type="number" value={sigCoords.page} onChange={(e) => setSigCoords({...sigCoords, page: +e.target.value})} /></div>
              <div><Label className="text-xs">X</Label><Input type="number" value={sigCoords.x} onChange={(e) => setSigCoords({...sigCoords, x: +e.target.value})} /></div>
              <div><Label className="text-xs">Y</Label><Input type="number" value={sigCoords.y} onChange={(e) => setSigCoords({...sigCoords, y: +e.target.value})} /></div>
              <div><Label className="text-xs">Width</Label><Input type="number" value={sigCoords.w} onChange={(e) => setSigCoords({...sigCoords, w: +e.target.value})} /></div>
              <div><Label className="text-xs">Height</Label><Input type="number" value={sigCoords.h} onChange={(e) => setSigCoords({...sigCoords, h: +e.target.value})} /></div>
            </div>
            <p className="font-medium text-sm">Date Field Coordinates</p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <div><Label className="text-xs">Page</Label><Input type="number" value={dateCoords.page} onChange={(e) => setDateCoords({...dateCoords, page: +e.target.value})} /></div>
              <div><Label className="text-xs">X</Label><Input type="number" value={dateCoords.x} onChange={(e) => setDateCoords({...dateCoords, x: +e.target.value})} /></div>
              <div><Label className="text-xs">Y</Label><Input type="number" value={dateCoords.y} onChange={(e) => setDateCoords({...dateCoords, y: +e.target.value})} /></div>
              <div><Label className="text-xs">Width</Label><Input type="number" value={dateCoords.w} onChange={(e) => setDateCoords({...dateCoords, w: +e.target.value})} /></div>
              <div><Label className="text-xs">Height</Label><Input type="number" value={dateCoords.h} onChange={(e) => setDateCoords({...dateCoords, h: +e.target.value})} /></div>
            </div>
          </div>
        </SectionCard>
      </div>

      <div className="flex justify-end pt-4">
        <Button onClick={saveSettings} disabled={saving}>
          {saving ? "Saving..." : "Save Company Branding"}
        </Button>
      </div>
    </div>
  );
}
