import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Save } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { TenantLogo } from "@/components/branding/TenantLogo";
import { resolveTenantLogoUrl } from "@/lib/tenantLogoUrl";
import { SignatureRequestEmailPreview } from "@/components/settings/SignatureRequestEmailPreview";

type TenantBranding = {
  id: string;
  name?: string | null;
  logo_url?: string | null;
  primary_color?: string | null;
  secondary_color?: string | null;
  email_reply_to?: string | null;
};

export function TenantBrandingSettings({ tenant }: { tenant: TenantBranding }) {
  const { toast } = useToast();
  const [primaryColor, setPrimaryColor] = useState(tenant.primary_color || "#3B82F6");
  const [secondaryColor, setSecondaryColor] = useState(tenant.secondary_color || "#1E40AF");
  const [logoUrl, setLogoUrl] = useState(tenant.logo_url || "");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const handleLogoUpload = async (file: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Invalid file", description: "Please choose an image file (PNG, JPG, SVG).", variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "File too large", description: "Logo must be under 5MB.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop() || "png";
      const path = `${tenant.id}/logo-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("tenant-logos")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from("tenant-logos").getPublicUrl(path);
      setLogoUrl(data.publicUrl);
      toast({ title: "Logo uploaded", description: "Click Save to apply." });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    const { error } = await supabase
      .from("tenants")
      .update({
        primary_color: primaryColor,
        secondary_color: secondaryColor,
        logo_url: logoUrl || null,
      })
      .eq("id", tenant.id);
    setSaving(false);
    if (error) {
      toast({ title: "Failed to save", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Branding updated", description: "Refresh to see changes." });
    }
  };

  const previewSrc = resolveTenantLogoUrl(logoUrl);

  return (
    <Card data-testid="tenant-branding-settings">
      <CardHeader>
        <CardTitle className="text-sm">Branding & Appearance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs">Logo</Label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="logo-upload-input"
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleLogoUpload(f);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => document.getElementById("logo-upload-input")?.click()}
            >
              {uploading ? "Uploading..." : logoUrl ? "Replace logo" : "Upload logo"}
            </Button>
            {logoUrl && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setLogoUrl("")}>
                Remove
              </Button>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">Or paste a URL</Label>
            <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://..." />
          </div>
          {previewSrc && (
            <div className="mt-2 p-3 border border-border/60 rounded-md inline-block bg-white">
              <TenantLogo src={logoUrl} alt="Logo preview" className="h-10 object-contain" />
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-xs">Primary Color</Label>
            <div className="flex items-center gap-2">
              <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="h-8 w-8 rounded cursor-pointer" />
              <Input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="font-mono text-xs" />
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Secondary Color</Label>
            <div className="flex items-center gap-2">
              <input type="color" value={secondaryColor} onChange={(e) => setSecondaryColor(e.target.value)} className="h-8 w-8 rounded cursor-pointer" />
              <Input value={secondaryColor} onChange={(e) => setSecondaryColor(e.target.value)} className="font-mono text-xs" />
            </div>
          </div>
        </div>
        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
          Save Branding
        </Button>
        <SignatureRequestEmailPreview
          tenantName={tenant.name || ""}
          logoUrl={logoUrl}
          primaryColor={primaryColor}
          replyTo={tenant.email_reply_to}
        />
      </CardContent>
    </Card>
  );
}
