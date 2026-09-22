import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { KeyRound, Loader2, Eye, EyeOff } from "lucide-react";
import { SectionCard } from "./SectionCard";
import { isCognitoAuth } from "@/lib/awsStaging";

export function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const awsStaging = isCognitoAuth();

  if (awsStaging) {
    return (
      <SectionCard
        title="Change Password"
        icon={<KeyRound className="h-4 w-4 text-emerald-500" />}
        accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
        description="AWS staging password changes use Cognito confirmation codes via Forgot password — not an in-session password update."
      >
        <p className="text-sm text-muted-foreground pt-2">
          Use <a className="underline" href="/forgot-password">Forgot password</a> (Tester mailbox) or EMAIL_OTP / passkey sign-in on staging.
        </p>
      </SectionCard>
    );
  }

  const handleChangePassword = async () => {
    if (!newPassword || newPassword.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("New password and confirmation do not match");
      return;
    }

    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const email = userData.user?.email;
      if (!email) throw new Error("No authenticated user");

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      });
      if (signInError) {
        toast.error("Current password is incorrect");
        setSaving(false);
        return;
      }

      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;

      toast.success("Password updated successfully");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error: any) {
      console.error("Error changing password:", error);
      toast.error(error.message || "Failed to update password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Change Password"
      icon={<KeyRound className="h-4 w-4 text-emerald-500" />}
      accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
      description="Update the password used to sign in to your account"
    >
      <div className="space-y-4 pt-2">
        <div className="space-y-2">
          <Label htmlFor="current_password">Current Password</Label>
          <div className="relative">
            <Input
              id="current_password"
              type={showCurrent ? "text" : "password"}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              autoComplete="current-password"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
              onClick={() => setShowCurrent((v) => !v)}
              tabIndex={-1}
            >
              {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="new_password">New Password</Label>
            <div className="relative">
              <Input
                id="new_password"
                type={showNew ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                onClick={() => setShowNew((v) => !v)}
                tabIndex={-1}
              >
                {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm_password">Confirm New Password</Label>
            <Input
              id="confirm_password"
              type={showNew ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter new password"
              autoComplete="new-password"
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Use at least 8 characters. For best security, mix uppercase, lowercase, numbers, and symbols.
        </p>

        <div className="flex justify-end pt-2">
          <Button
            onClick={handleChangePassword}
            disabled={saving || !currentPassword || !newPassword || !confirmPassword}
          >
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {saving ? "Updating..." : "Update Password"}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
