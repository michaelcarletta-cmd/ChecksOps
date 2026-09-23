import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Bell, Mail, MessageSquare, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

interface NotificationPreferences {
  in_app_enabled: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
}

export default function NotificationPreferencesSettings() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences>({
    in_app_enabled: true,
    email_enabled: true,
    sms_enabled: false,
  });

  useEffect(() => {
    if (user) {
      fetchPreferences();
    }
  }, [user]);

  const fetchPreferences = async () => {
    try {
      // Use the RPC function to get or create preferences
      const { data, error } = await supabase.rpc('get_or_create_notification_preferences', {
        p_user_id: user!.id
      });

      if (error) throw error;

      if (data) {
        setPreferences({
          in_app_enabled: data.in_app_enabled,
          email_enabled: data.email_enabled,
          sms_enabled: data.sms_enabled,
        });
      }
    } catch (error) {
      console.error("Error fetching notification preferences:", error);
      toast.error("Failed to load notification preferences");
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!user) return;
    
    setSaving(true);
    try {
      const { error } = await supabase
        .from("notification_preferences")
        .update({
          in_app_enabled: preferences.in_app_enabled,
          email_enabled: preferences.email_enabled,
          sms_enabled: preferences.sms_enabled,
        })
        .eq("user_id", user.id);

      if (error) throw error;

      toast.success("Notification preferences saved");
    } catch (error) {
      console.error("Error saving notification preferences:", error);
      toast.error("Failed to save notification preferences");
    } finally {
      setSaving(false);
    }
  };

  const togglePreference = (key: keyof NotificationPreferences) => {
    setPreferences(prev => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Notification Preferences</CardTitle>
          <CardDescription>
            Choose how you want to receive notifications for tasks, claim updates, and other alerts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between p-4 rounded-lg border border-border bg-card">
            <div className="flex items-center gap-4">
              <div className="p-2 rounded-md bg-primary/10">
                <Bell className="h-5 w-5 text-primary" />
              </div>
              <div>
                <Label htmlFor="in-app" className="text-base font-medium">
                  In-App Notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  Receive notifications within the application
                </p>
              </div>
            </div>
            <Switch
              id="in-app"
              checked={preferences.in_app_enabled}
              onCheckedChange={() => togglePreference("in_app_enabled")}
            />
          </div>

          <div className="flex items-center justify-between p-4 rounded-lg border border-border bg-card">
            <div className="flex items-center gap-4">
              <div className="p-2 rounded-md bg-primary/10">
                <Mail className="h-5 w-5 text-primary" />
              </div>
              <div>
                <Label htmlFor="email" className="text-base font-medium">
                  Email Notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  Receive notifications via email
                </p>
              </div>
            </div>
            <Switch
              id="email"
              checked={preferences.email_enabled}
              onCheckedChange={() => togglePreference("email_enabled")}
            />
          </div>

          <div className="flex items-center justify-between p-4 rounded-lg border border-border bg-card">
            <div className="flex items-center gap-4">
              <div className="p-2 rounded-md bg-primary/10">
                <MessageSquare className="h-5 w-5 text-primary" />
              </div>
              <div>
                <Label htmlFor="sms" className="text-base font-medium">
                  SMS Notifications
                </Label>
                <p className="text-sm text-muted-foreground">
                  Receive notifications via text message
                </p>
              </div>
            </div>
            <Switch
              id="sms"
              checked={preferences.sms_enabled}
              onCheckedChange={() => togglePreference("sms_enabled")}
            />
          </div>

          <div className="pt-4">
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Preferences
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notification Types</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="text-sm text-muted-foreground space-y-2">
            <li>• <strong>Tasks:</strong> Due date reminders, overdue alerts, and new task assignments</li>
            <li>• <strong>Claims:</strong> Status updates, new activity, and portal notifications</li>
            <li>• <strong>Inspections:</strong> Scheduled inspection reminders</li>
            <li>• <strong>Signatures:</strong> Document signing requests and completions</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
