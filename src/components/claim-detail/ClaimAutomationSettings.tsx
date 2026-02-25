import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Bot, Mail, MessageSquare, FileText, Sparkles, Send, Clock, RefreshCw, CheckCircle, XCircle, DollarSign } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface ClaimAutomationSettingsProps {
  claimId: string;
}

interface AutomationSettings {
  auto_respond_emails: boolean;
  auto_update_notes: boolean;
  auto_send_sms: boolean;
  notify_client_on_updates: boolean;
}

interface ClaimAutomation {
  id: string;
  claim_id: string;
  is_enabled: boolean;
  settings: AutomationSettings;
  follow_up_enabled: boolean;
  follow_up_interval_days: number;
  follow_up_max_count: number;
  follow_up_current_count: number;
  follow_up_last_sent_at: string | null;
  follow_up_next_at: string | null;
  follow_up_stopped_at: string | null;
  follow_up_stop_reason: string | null;
  // RD Follow-up fields
  rd_follow_up_enabled: boolean;
  rd_follow_up_interval_days: number;
  rd_follow_up_current_count: number;
  rd_follow_up_last_sent_at: string | null;
  rd_follow_up_next_at: string | null;
  rd_follow_up_stopped_at: string | null;
  rd_follow_up_stop_reason: string | null;
}

export const ClaimAutomationSettings = ({ claimId }: ClaimAutomationSettingsProps) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [smsRecipient, setSmsRecipient] = useState("policyholder");

  const { data: automation, isLoading } = useQuery({
    queryKey: ["claim-automation", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_automations")
        .select("*")
        .eq("claim_id", claimId)
        .maybeSingle();

      if (error) throw error;
      if (!data) return null;
      
      return {
        ...data,
        settings: data.settings as unknown as AutomationSettings,
      } as ClaimAutomation;
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from("claim_automations")
        .insert({
          claim_id: claimId,
          is_enabled: true,
          settings: {
            auto_respond_emails: true,
            auto_update_notes: true,
            auto_send_sms: false,
          } as any,
          follow_up_enabled: false,
          follow_up_interval_days: 3,
          follow_up_max_count: 3,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-automation", claimId] });
      toast({
        title: "AI Automation Enabled",
        description: "This claim now has AI-powered automation active.",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (updates: Record<string, any>) => {
      const { error } = await supabase
        .from("claim_automations")
        .update(updates)
        .eq("id", automation?.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-automation", claimId] });
    },
  });

  const handleToggleEnabled = () => {
    if (automation) {
      updateMutation.mutate({ is_enabled: !automation.is_enabled });
    }
  };

  const draftSmsMutation = useMutation({
    mutationFn: async (recipientType: string) => {
      const { data, error } = await supabase.functions.invoke("process-claim-ai-action", {
        body: {
          action: "draft_sms",
          claimId,
          recipientType,
        },
      });

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({
        title: "SMS Draft Created",
        description: "Check the Inbox > AI Approvals tab to review and send.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to draft SMS",
        variant: "destructive",
      });
    },
  });

  const handleSettingChange = (key: keyof AutomationSettings, value: boolean) => {
    if (automation) {
      const currentSettings = automation.settings || {};
      updateMutation.mutate({
        settings: {
          ...currentSettings,
          [key]: value,
        },
      });
    }
  };

  const handleEnableFollowUp = () => {
    if (automation) {
      const nextAt = new Date();
      nextAt.setDate(nextAt.getDate() + (automation.follow_up_interval_days || 3));
      
      updateMutation.mutate({
        follow_up_enabled: true,
        follow_up_current_count: 0,
        follow_up_next_at: nextAt.toISOString(),
        follow_up_stopped_at: null,
        follow_up_stop_reason: null,
      });
      
      toast({
        title: "Follow-ups Enabled",
        description: `First follow-up will be sent in ${automation.follow_up_interval_days || 3} days if no response.`,
      });
    }
  };

  const handleDisableFollowUp = () => {
    if (automation) {
      updateMutation.mutate({
        follow_up_enabled: false,
        follow_up_stopped_at: new Date().toISOString(),
        follow_up_stop_reason: 'manual',
      });
    }
  };

  const handleResetFollowUp = () => {
    if (automation) {
      const nextAt = new Date();
      nextAt.setDate(nextAt.getDate() + (automation.follow_up_interval_days || 3));
      
      updateMutation.mutate({
        follow_up_enabled: true,
        follow_up_current_count: 0,
        follow_up_next_at: nextAt.toISOString(),
        follow_up_stopped_at: null,
        follow_up_stop_reason: null,
      });
      
      toast({
        title: "Follow-ups Reset",
        description: "Follow-up counter has been reset and re-enabled.",
      });
    }
  };

  const handleUpdateFollowUpSettings = (field: string, value: number) => {
    if (automation) {
      const updates: Record<string, any> = { [field]: value };
      
      // Recalculate next follow-up date if interval changed
      if (field === 'follow_up_interval_days' && automation.follow_up_enabled && !automation.follow_up_stopped_at) {
        const nextAt = new Date();
        nextAt.setDate(nextAt.getDate() + value);
        updates.follow_up_next_at = nextAt.toISOString();
      }
      
      // Recalculate next RD follow-up date if interval changed
      if (field === 'rd_follow_up_interval_days' && automation.rd_follow_up_enabled && !automation.rd_follow_up_stopped_at) {
        const nextAt = new Date();
        nextAt.setDate(nextAt.getDate() + value);
        updates.rd_follow_up_next_at = nextAt.toISOString();
      }
      
      updateMutation.mutate(updates);
    }
  };

  // RD Follow-up handlers
  const handleEnableRDFollowUp = () => {
    if (automation) {
      const nextAt = new Date();
      nextAt.setDate(nextAt.getDate() + (automation.rd_follow_up_interval_days || 3));
      
      updateMutation.mutate({
        rd_follow_up_enabled: true,
        rd_follow_up_current_count: 0,
        rd_follow_up_next_at: nextAt.toISOString(),
        rd_follow_up_stopped_at: null,
        rd_follow_up_stop_reason: null,
      });
      
      toast({
        title: "RD Follow-ups Enabled",
        description: `Darwin will follow up every ${automation.rd_follow_up_interval_days || 3} days to track recoverable depreciation release.`,
      });
    }
  };

  const handleDisableRDFollowUp = () => {
    if (automation) {
      updateMutation.mutate({
        rd_follow_up_enabled: false,
        rd_follow_up_stopped_at: new Date().toISOString(),
        rd_follow_up_stop_reason: 'manual',
        rd_check_tracking_enabled: false,
      });
    }
  };

  const handleResetRDFollowUp = () => {
    if (automation) {
      const nextAt = new Date();
      nextAt.setDate(nextAt.getDate() + (automation.rd_follow_up_interval_days || 3));
      
      updateMutation.mutate({
        rd_follow_up_enabled: true,
        rd_follow_up_current_count: 0,
        rd_follow_up_next_at: nextAt.toISOString(),
        rd_follow_up_stopped_at: null,
        rd_follow_up_stop_reason: null,
      });
      
      toast({
        title: "RD Follow-ups Reset",
        description: "RD follow-up counter has been reset and re-enabled.",
      });
    }
  };

  const handleMarkRDReleased = () => {
    if (automation) {
      updateMutation.mutate({
        rd_follow_up_enabled: false,
        rd_follow_up_stopped_at: new Date().toISOString(),
        rd_follow_up_stop_reason: 'rd_released',
      });
      
      toast({
        title: "RD Released",
        description: "Recoverable Depreciation marked as released. Follow-ups stopped.",
      });
    }
  };

  if (isLoading) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  const settings = automation?.settings;

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Bot className="h-5 w-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-lg">AI Claim Automation</CardTitle>
            <CardDescription>
              Enable AI-powered automation for this specific claim
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {!automation ? (
          <div className="text-center py-6">
            <Sparkles className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="font-medium text-foreground mb-2">Enable AI Automation</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Let AI automatically process inbound emails, draft responses for your approval,
              and keep notes updated for this claim.
            </p>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={createMutation.isPending}
              className="bg-primary hover:bg-primary/90"
            >
              {createMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Bot className="h-4 w-4 mr-2" />
              )}
              Enable AI Automation
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Switch
                  checked={automation.is_enabled}
                  onCheckedChange={handleToggleEnabled}
                  id="automation-enabled"
                />
                <Label htmlFor="automation-enabled" className="text-base font-medium">
                  {automation.is_enabled ? "Automation Active" : "Automation Paused"}
                </Label>
              </div>
              <span
                className={`px-2 py-1 text-xs rounded ${
                  automation.is_enabled
                    ? "bg-green-500/20 text-green-500"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {automation.is_enabled ? "Active" : "Paused"}
              </span>
            </div>

            {automation.is_enabled && (
              <div className="space-y-4 pt-4 border-t border-border">
                <h4 className="text-sm font-medium text-muted-foreground">Automation Actions</h4>

                <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-3">
                    <Mail className="h-5 w-5 text-primary" />
                    <div>
                      <Label className="text-sm font-medium">Auto-Draft Email Responses</Label>
                      <p className="text-xs text-muted-foreground">
                        AI drafts replies to inbound emails for your approval
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={settings?.auto_respond_emails ?? true}
                    onCheckedChange={(v) => handleSettingChange("auto_respond_emails", v)}
                  />
                </div>

                <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-3">
                    <FileText className="h-5 w-5 text-primary" />
                    <div>
                      <Label className="text-sm font-medium">Auto-Update Notes</Label>
                      <p className="text-xs text-muted-foreground">
                        AI logs observations and summaries to claim activity
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={settings?.auto_update_notes ?? true}
                    onCheckedChange={(v) => handleSettingChange("auto_update_notes", v)}
                  />
                </div>

                <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-3">
                    <MessageSquare className="h-5 w-5 text-primary" />
                    <div>
                      <Label className="text-sm font-medium">SMS Notifications</Label>
                      <p className="text-xs text-muted-foreground">
                        AI can send SMS updates (requires approval)
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={settings?.auto_send_sms ?? false}
                    onCheckedChange={(v) => handleSettingChange("auto_send_sms", v)}
                  />
                </div>

                <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
                  <div className="flex items-center gap-3">
                    <Send className="h-5 w-5 text-primary" />
                    <div>
                      <Label className="text-sm font-medium">Auto-Notify Client on Updates</Label>
                      <p className="text-xs text-muted-foreground">
                        Automatically email client when claim status or key info changes
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={settings?.notify_client_on_updates ?? false}
                    onCheckedChange={(v) => handleSettingChange("notify_client_on_updates", v)}
                  />
                </div>

                {/* Automated Follow-ups Section */}
                <div className="pt-4 border-t border-border">
                  <h4 className="text-sm font-medium text-muted-foreground mb-3">Automated Follow-ups</h4>
                  
                  <div className="p-3 bg-muted/30 rounded-lg space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Clock className="h-5 w-5 text-primary" />
                        <div>
                          <Label className="text-sm font-medium">Auto Follow-up Emails</Label>
                          <p className="text-xs text-muted-foreground">
                            Send follow-up emails if no response is received
                          </p>
                        </div>
                      </div>
                      {!automation.follow_up_enabled ? (
                        <Button
                          size="sm"
                          onClick={handleEnableFollowUp}
                          disabled={updateMutation.isPending}
                        >
                          Enable
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleDisableFollowUp}
                          disabled={updateMutation.isPending}
                        >
                          Disable
                        </Button>
                      )}
                    </div>

                    {automation.follow_up_enabled && (
                      <div className="space-y-3 pt-3 border-t border-border/50">
                        {/* Follow-up Status */}
                        <div className="flex items-center gap-2">
                          {automation.follow_up_stopped_at ? (
                            <Badge variant="secondary" className="flex items-center gap-1">
                              <XCircle className="h-3 w-3" />
                              Stopped: {automation.follow_up_stop_reason === 'response_received' 
                                ? 'Response Received' 
                                : automation.follow_up_stop_reason === 'max_count_reached'
                                ? 'Max Reached'
                                : 'Manually Stopped'}
                            </Badge>
                          ) : (
                            <Badge className="flex items-center gap-1 bg-green-500/20 text-green-500 hover:bg-green-500/30">
                              <CheckCircle className="h-3 w-3" />
                              Active - {automation.follow_up_current_count}/{automation.follow_up_max_count} sent
                            </Badge>
                          )}
                        </div>

                        {/* Settings */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground">Send every</Label>
                            <Select 
                              value={automation.follow_up_interval_days?.toString() || "3"}
                              onValueChange={(v) => handleUpdateFollowUpSettings('follow_up_interval_days', parseInt(v))}
                            >
                              <SelectTrigger className="h-8 text-sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="1">1 day</SelectItem>
                                <SelectItem value="2">2 days</SelectItem>
                                <SelectItem value="3">3 days</SelectItem>
                                <SelectItem value="5">5 days</SelectItem>
                                <SelectItem value="7">1 week</SelectItem>
                                <SelectItem value="14">2 weeks</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Max follow-ups</Label>
                            <Select 
                              value={automation.follow_up_max_count?.toString() || "3"}
                              onValueChange={(v) => handleUpdateFollowUpSettings('follow_up_max_count', parseInt(v))}
                            >
                              <SelectTrigger className="h-8 text-sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="1">1</SelectItem>
                                <SelectItem value="2">2</SelectItem>
                                <SelectItem value="3">3</SelectItem>
                                <SelectItem value="5">5</SelectItem>
                                <SelectItem value="10">10</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        {/* Next follow-up or reset button */}
                        {automation.follow_up_stopped_at ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            onClick={handleResetFollowUp}
                            disabled={updateMutation.isPending}
                          >
                            <RefreshCw className="h-4 w-4 mr-2" />
                            Reset & Re-enable
                          </Button>
                        ) : automation.follow_up_next_at && (
                          <p className="text-xs text-muted-foreground">
                            Next follow-up: {new Date(automation.follow_up_next_at).toLocaleDateString()} at {new Date(automation.follow_up_next_at).toLocaleTimeString()}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Recoverable Depreciation Follow-ups Section */}
                <div className="pt-4 border-t border-border">
                  <h4 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                    <DollarSign className="h-4 w-4" />
                    Recoverable Depreciation Follow-ups
                  </h4>
                  
                  <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <DollarSign className="h-5 w-5 text-amber-500" />
                        <div>
                          <Label className="text-sm font-medium">RD Release Tracking</Label>
                          <p className="text-xs text-muted-foreground">
                            Automatically follow up on invoice receipt and RD release
                          </p>
                        </div>
                      </div>
                      {!automation.rd_follow_up_enabled ? (
                        <Button
                          size="sm"
                          onClick={handleEnableRDFollowUp}
                          disabled={updateMutation.isPending}
                          className="bg-amber-500 hover:bg-amber-600 text-white"
                        >
                          Enable
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={handleDisableRDFollowUp}
                          disabled={updateMutation.isPending}
                        >
                          Disable
                        </Button>
                      )}
                    </div>

                    {automation.rd_follow_up_enabled && (
                      <div className="space-y-3 pt-3 border-t border-amber-500/20">
                        {/* RD Follow-up Status */}
                        <div className="flex items-center gap-2 flex-wrap">
                          {automation.rd_follow_up_stopped_at ? (
                            <Badge variant="secondary" className="flex items-center gap-1">
                              <XCircle className="h-3 w-3" />
                              {automation.rd_follow_up_stop_reason === 'rd_released' 
                                ? 'RD Released ✓' 
                                : automation.rd_follow_up_stop_reason === 'max_count_reached'
                                ? 'Max Reached'
                                : 'Manually Stopped'}
                            </Badge>
                          ) : (
                            <Badge className="flex items-center gap-1 bg-amber-500/20 text-amber-600 hover:bg-amber-500/30">
                              <CheckCircle className="h-3 w-3" />
                              Active - {automation.rd_follow_up_current_count} sent
                            </Badge>
                          )}
                          {!automation.rd_follow_up_stopped_at && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={handleMarkRDReleased}
                              disabled={updateMutation.isPending}
                              className="text-xs h-6 border-green-500 text-green-600 hover:bg-green-500/10"
                            >
                              <CheckCircle className="h-3 w-3 mr-1" />
                              Mark RD Released
                            </Button>
                          )}
                        </div>

                        {/* RD Settings */}
                        <div>
                          <Label className="text-xs text-muted-foreground">Follow up every</Label>
                          <Select 
                            value={automation.rd_follow_up_interval_days?.toString() || "3"}
                            onValueChange={(v) => handleUpdateFollowUpSettings('rd_follow_up_interval_days', parseInt(v))}
                          >
                            <SelectTrigger className="h-8 text-sm w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="1">1 day</SelectItem>
                              <SelectItem value="2">2 days</SelectItem>
                              <SelectItem value="3">3 days</SelectItem>
                              <SelectItem value="5">5 days</SelectItem>
                              <SelectItem value="7">1 week</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground mt-1">
                            Continues until status changes to "Waiting on RD"
                          </p>
                        </div>

                        {/* Next RD follow-up or reset button */}
                        {automation.rd_follow_up_stopped_at ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full"
                            onClick={handleResetRDFollowUp}
                            disabled={updateMutation.isPending}
                          >
                            <RefreshCw className="h-4 w-4 mr-2" />
                            Reset & Re-enable RD Follow-ups
                          </Button>
                        ) : automation.rd_follow_up_next_at && (
                          <p className="text-xs text-muted-foreground">
                            Next RD follow-up: {new Date(automation.rd_follow_up_next_at).toLocaleDateString()} at {new Date(automation.rd_follow_up_next_at).toLocaleTimeString()}
                          </p>
                        )}

                        <p className="text-xs text-amber-600/80 bg-amber-500/5 p-2 rounded">
                          💡 Darwin will contact the adjuster to confirm invoices were received and track when recoverable depreciation will be released.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="pt-4 border-t border-border">
                  <h4 className="text-sm font-medium text-muted-foreground mb-3">Manual AI Actions</h4>
                  <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg">
                    <MessageSquare className="h-5 w-5 text-primary" />
                    <div className="flex-1">
                      <Label className="text-sm font-medium">Draft SMS with AI</Label>
                      <p className="text-xs text-muted-foreground">
                        Generate an SMS draft for approval
                      </p>
                    </div>
                    <Select value={smsRecipient} onValueChange={setSmsRecipient}>
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="policyholder">Policyholder</SelectItem>
                        <SelectItem value="adjuster">Adjuster</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => draftSmsMutation.mutate(smsRecipient)}
                      disabled={draftSmsMutation.isPending}
                    >
                      {draftSmsMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
