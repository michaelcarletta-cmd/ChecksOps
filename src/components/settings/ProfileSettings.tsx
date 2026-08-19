import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Save, User, Bell, Mail, ChevronDown, Loader2, Upload, Building2, X, Sparkles, Key, Award, KeyRound } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";
import { formatPhoneNumber } from "@/lib/utils";
import { LicensesSettings } from "./LicensesSettings";
import { ChangePasswordCard } from "./ChangePasswordCard";

interface ProfileData {
  full_name: string | null;
  email: string;
  phone: string | null;
  title: string | null;
  license_number: string | null;
  license_state: string | null;
  email_signature: string | null;
  logo_url: string | null;
}

export function ProfileSettings() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<ProfileData>({
    full_name: "",
    email: "",
    phone: "",
    title: "",
    license_number: "",
    license_state: "",
    email_signature: "",
    logo_url: null,
  });

  useEffect(() => {
    if (user) {
      fetchProfile();
    }
  }, [user]);

  const fetchProfile = async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .single();

      if (error) throw error;

      setProfile({
        full_name: data.full_name || "",
        email: data.email || "",
        phone: data.phone || "",
        title: (data as any).title || "",
        license_number: (data as any).license_number || "",
        license_state: (data as any).license_state || "",
        email_signature: (data as any).email_signature || "",
        logo_url: (data as any).logo_url || null,
      });
    } catch (error) {
      console.error("Error fetching profile:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!user) return;
    
    setSaving(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({
          full_name: profile.full_name,
          phone: profile.phone,
          title: profile.title,
          license_number: profile.license_number,
          license_state: profile.license_state,
          email_signature: profile.email_signature,
          logo_url: profile.logo_url,
        } as any)
        .eq("id", user.id);

      if (error) throw error;

      toast.success("Profile updated successfully");
    } catch (error) {
      console.error("Error updating profile:", error);
      toast.error("Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please upload an image file');
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      toast.error('Logo must be less than 2MB');
      return;
    }

    setUploadingLogo(true);
    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${user.id}/logo.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('company-branding')
        .upload(fileName, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('company-branding')
        .getPublicUrl(fileName);

      const logoUrl = urlData.publicUrl;
      setProfile(prev => ({ ...prev, logo_url: logoUrl }));
      
      await supabase
        .from("profiles")
        .update({ logo_url: logoUrl } as any)
        .eq("id", user.id);

      toast.success('Logo uploaded successfully');
    } catch (error: any) {
      console.error('Error uploading logo:', error);
      toast.error(error.message || 'Failed to upload logo');
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleRemoveLogo = async () => {
    if (!user) return;
    
    try {
      await supabase
        .from("profiles")
        .update({ logo_url: null } as any)
        .eq("id", user.id);

      setProfile(prev => ({ ...prev, logo_url: null }));
      toast.success('Logo removed');
    } catch (error) {
      console.error('Error removing logo:', error);
      toast.error('Failed to remove logo');
    }
  };

  if (loading) {
    return <div className="text-muted-foreground">Loading profile...</div>;
  }

  return (
    <div className="space-y-6 pt-0">
      <SettingsHero
        title="Profile Settings"
        description="Manage your personal information, security, and notification preferences."
        badge="Personal Settings"
        icon={<User className="h-4 w-4 text-primary" />}
      />

      <div className="grid gap-6">
        <SectionCard
          title="Personal Information"
          icon={<User className="h-4 w-4 text-sky-500" />}
          accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
          description="Update your profile details and contact information"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="full_name">Full Name</Label>
              <Input
                id="full_name"
                value={profile.full_name || ""}
                onChange={(e) => setProfile({ ...profile, full_name: e.target.value })}
                placeholder="John Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={profile.title || ""}
                onChange={(e) => setProfile({ ...profile, title: e.target.value })}
                placeholder="Public Adjuster"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                value={profile.email}
                disabled
                className="bg-muted"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number</Label>
              <Input
                id="phone"
                type="tel"
                value={profile.phone || ""}
                onChange={(e) => setProfile({ ...profile, phone: formatPhoneNumber(e.target.value) })}
                placeholder="123-456-7890"
              />
            </div>
          </div>
        </SectionCard>

        <SectionCard
          title="Company Logo"
          icon={<Building2 className="h-4 w-4 text-violet-500" />}
          accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
          description="Upload your company logo for invoices and documents"
        >
          <div className="flex items-start gap-6">
            {profile.logo_url ? (
              <div className="relative">
                <img 
                  src={profile.logo_url} 
                  alt="Company logo" 
                  className="h-24 w-auto max-w-[200px] object-contain border rounded-lg p-2 bg-white"
                />
                <Button
                  variant="destructive"
                  size="icon"
                  className="absolute -top-2 -right-2 h-6 w-6"
                  onClick={handleRemoveLogo}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="h-24 w-32 border-2 border-dashed rounded-lg flex items-center justify-center bg-muted/50">
                <Building2 className="h-8 w-8 text-muted-foreground" />
              </div>
            )}
            <div className="space-y-2">
              <input
                ref={logoInputRef}
                type="file"
                accept="image/*"
                onChange={handleLogoUpload}
                className="hidden"
              />
              <Button
                variant="outline"
                onClick={() => logoInputRef.current?.click()}
                disabled={uploadingLogo}
              >
                {uploadingLogo ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                {uploadingLogo ? 'Uploading...' : 'Upload Logo'}
              </Button>
              <p className="text-xs text-muted-foreground">
                PNG, JPG, or SVG. Max 2MB. Used on invoices.
              </p>
            </div>
          </div>
        </SectionCard>

        <LicensesSettings />

        <SectionCard
          title="Email Signature"
          icon={<Mail className="h-4 w-4 text-emerald-500" />}
          accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
          description="This signature will be appended to emails sent from the CRM"
        >
          <div className="space-y-2">
            <Label htmlFor="email_signature">Signature</Label>
            <Textarea
              id="email_signature"
              value={profile.email_signature || ""}
              onChange={(e) => setProfile({ ...profile, email_signature: e.target.value })}
              placeholder="Best regards,&#10;John Doe&#10;Public Adjuster&#10;License #PA-12345&#10;Phone: (555) 123-4567"
              rows={6}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Tip: Include your name, title, license number, and contact information.
          </p>
        </SectionCard>

        <ChangePasswordCard />

        <SectionCard
          title="Account Actions"
          icon={<Save className="h-4 w-4 text-emerald-500" />}
          accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
          description="Save or update your profile changes"
        >
          <div className="flex justify-end pt-4">
            <Button onClick={handleSave} disabled={saving} size="lg" className="px-8">
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              {saving ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
