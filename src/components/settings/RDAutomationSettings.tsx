import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Loader2, DollarSign, Clock, Mail, Save } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";

interface RDSettings {
  rd_request_interval_days: number;
  rd_request_max_count: number;
  rd_check_expected_days: number;
  rd_check_alert_after_days: number;
  rd_check_follow_up_interval_days: number;
  rd_check_max_follow_ups: number;
}

const DEFAULT_SETTINGS: RDSettings = {
  rd_request_interval_days: 3,
  rd_request_max_count: 10,
  rd_check_expected_days: 10,
  rd_check_alert_after_days: 14,
  rd_check_follow_up_interval_days: 3,
  rd_check_max_follow_ups: 5,
};

export const RDAutomationSettings = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<RDSettings>(DEFAULT_SETTINGS);
  const [hasChanges, setHasChanges] = useState(false);

  const { data: savedSettings, isLoading } = useQuery({
    queryKey: ["global-rd-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("global_automation_settings")
        .select("*")
        .eq("setting_key", "rd_follow_up_defaults")
        .maybeSingle();

      if (error) throw error;
      if (!data?.setting_value) return null;
      
      // Parse the JSON value safely
      const value = data.setting_value as Record<string, unknown>;
      return {
        rd_request_interval_days: Number(value.rd_request_interval_days) || DEFAULT_SETTINGS.rd_request_interval_days,
        rd_request_max_count: Number(value.rd_request_max_count) || DEFAULT_SETTINGS.rd_request_max_count,
        rd_check_expected_days: Number(value.rd_check_expected_days) || DEFAULT_SETTINGS.rd_check_expected_days,
        rd_check_alert_after_days: Number(value.rd_check_alert_after_days) || DEFAULT_SETTINGS.rd_check_alert_after_days,
        rd_check_follow_up_interval_days: Number(value.rd_check_follow_up_interval_days) || DEFAULT_SETTINGS.rd_check_follow_up_interval_days,
        rd_check_max_follow_ups: Number(value.rd_check_max_follow_ups) || DEFAULT_SETTINGS.rd_check_max_follow_ups,
      } as RDSettings;
    },
  });

  useEffect(() => {
    if (savedSettings) {
      setSettings({ ...DEFAULT_SETTINGS, ...savedSettings });
    }
  }, [savedSettings]);

  const saveMutation = useMutation({
    mutationFn: async (newSettings: RDSettings) => {
      const { error } = await supabase
        .from("global_automation_settings")
        .upsert({
          setting_key: "rd_follow_up_defaults",
          setting_value: newSettings as any,
          description: "Default settings for Recoverable Depreciation tracking",
          updated_at: new Date().toISOString(),
        }, {
          onConflict: "setting_key",
        });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["global-rd-settings"] });
      setHasChanges(false);
      toast({
        title: "Settings Saved",
        description: "RD automation settings have been updated.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to save settings",
        variant: "destructive",
      });
    },
  });

  const handleChange = (key: keyof RDSettings, value: number) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSave = () => {
    saveMutation.mutate(settings);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-500/10 rounded-lg">
              <DollarSign className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <CardTitle>Recoverable Depreciation Automation</CardTitle>
              <CardDescription>
                Configure global settings for RD tracking and follow-ups
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* RD Request Follow-ups Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-primary" />
              <h3 className="font-medium">RD Request Follow-ups</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              When Darwin is tracking RD release (after invoices submitted), he will follow up with the carrier until the claim status changes to "Waiting on Recoverable Depreciation".
            </p>
            
            <div className="space-y-2">
              <Label>Follow-up Interval</Label>
              <Select 
                value={settings.rd_request_interval_days.toString()}
                onValueChange={(v) => handleChange('rd_request_interval_days', parseInt(v))}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Every 1 day</SelectItem>
                  <SelectItem value="2">Every 2 days</SelectItem>
                  <SelectItem value="3">Every 3 days</SelectItem>
                  <SelectItem value="5">Every 5 days</SelectItem>
                  <SelectItem value="7">Every 7 days</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Follow-ups continue until claim enters "Waiting on RD" status (no max limit)
              </p>
            </div>
          </div>

          <Separator />

          {/* RD Check Receipt Tracking Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" />
              <h3 className="font-medium">RD Check Receipt Tracking</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              After the carrier releases the RD check, how long should we wait before following up with the policyholder?
            </p>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Expected Delivery (business days)</Label>
                <Select 
                  value={settings.rd_check_expected_days.toString()}
                  onValueChange={(v) => handleChange('rd_check_expected_days', parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5 days</SelectItem>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="10">10 days</SelectItem>
                    <SelectItem value="14">14 days</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  First check-in after this many days
                </p>
              </div>
              <div className="space-y-2">
                <Label>Alert as Overdue After</Label>
                <Select 
                  value={settings.rd_check_alert_after_days.toString()}
                  onValueChange={(v) => handleChange('rd_check_alert_after_days', parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 days</SelectItem>
                    <SelectItem value="14">14 days</SelectItem>
                    <SelectItem value="21">21 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Mark as overdue and escalate after this
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Check-in Interval</Label>
                <Select 
                  value={settings.rd_check_follow_up_interval_days.toString()}
                  onValueChange={(v) => handleChange('rd_check_follow_up_interval_days', parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2">Every 2 days</SelectItem>
                    <SelectItem value="3">Every 3 days</SelectItem>
                    <SelectItem value="5">Every 5 days</SelectItem>
                    <SelectItem value="7">Every 7 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Maximum Check-ins</Label>
                <Select 
                  value={settings.rd_check_max_follow_ups.toString()}
                  onValueChange={(v) => handleChange('rd_check_max_follow_ups', parseInt(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">3 check-ins</SelectItem>
                    <SelectItem value="5">5 check-ins</SelectItem>
                    <SelectItem value="10">10 check-ins</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="pt-4 flex justify-end">
            <Button 
              onClick={handleSave} 
              disabled={!hasChanges || saveMutation.isPending}
              className="bg-primary hover:bg-primary/90"
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Settings
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-muted/30">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-blue-500/10 rounded-lg">
              <DollarSign className="h-4 w-4 text-blue-500" />
            </div>
            <div className="space-y-1">
              <h4 className="text-sm font-medium">How RD Tracking Works</h4>
              <div className="text-sm text-muted-foreground space-y-2">
                <p><strong>RD Request Follow-ups:</strong> When a claim enters "Recoverable Depreciation Requested" status with RD tracking enabled, Darwin will automatically email the adjuster to confirm invoice receipt and track RD release. Follow-ups continue until the claim status changes to "Waiting on Recoverable Depreciation".</p>
                <p><strong>RD Check Receipt:</strong> Once the carrier releases the check, Darwin tracks delivery and checks in with both the policyholder and insurance company to confirm receipt. If overdue, we'll request a trace or reissue from the carrier.</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
