import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Loader2, DollarSign, Clock, RefreshCw, CheckCircle, XCircle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface RecoverableDepreciationFollowUpsProps {
  claimId: string;
}

interface RDAutomation {
  id: string;
  claim_id: string;
  is_enabled: boolean;
  rd_follow_up_enabled: boolean;
  rd_follow_up_interval_days: number;
  rd_follow_up_current_count: number;
  rd_follow_up_last_sent_at: string | null;
  rd_follow_up_next_at: string | null;
  rd_follow_up_stopped_at: string | null;
  rd_follow_up_stop_reason: string | null;
  rd_check_tracking_enabled: boolean;
}

export const RecoverableDepreciationFollowUps = ({ claimId }: RecoverableDepreciationFollowUpsProps) => {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: automation, isLoading } = useQuery({
    queryKey: ["claim-rd-automation", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_automations")
        .select("id, claim_id, is_enabled, rd_follow_up_enabled, rd_follow_up_interval_days, rd_follow_up_current_count, rd_follow_up_last_sent_at, rd_follow_up_next_at, rd_follow_up_stopped_at, rd_follow_up_stop_reason, rd_check_tracking_enabled")
        .eq("claim_id", claimId)
        .maybeSingle();

      if (error) throw error;
      return data as RDAutomation | null;
    },
  });

  const ensureAndUpdate = useMutation({
    mutationFn: async (updates: Record<string, any>) => {
      if (!automation?.id) {
        // Create automation record first, then apply RD settings
        const { data, error } = await supabase
          .from("claim_automations")
          .insert({
            claim_id: claimId,
            is_enabled: true,
            settings: {} as any,
            ...updates,
          })
          .select()
          .single();
        if (error) throw error;
        return data;
      } else {
        const { error } = await supabase
          .from("claim_automations")
          .update(updates)
          .eq("id", automation.id);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["claim-rd-automation", claimId] });
      queryClient.invalidateQueries({ queryKey: ["claim-automation-autonomy", claimId] });
    },
  });

  const handleEnableRDFollowUp = () => {
    const nextAt = new Date();
    nextAt.setDate(nextAt.getDate() + (automation?.rd_follow_up_interval_days || 3));

    ensureAndUpdate.mutate({
      rd_follow_up_enabled: true,
      rd_follow_up_current_count: 0,
      rd_follow_up_next_at: nextAt.toISOString(),
      rd_follow_up_stopped_at: null,
      rd_follow_up_stop_reason: null,
    });

    toast({
      title: "RD Follow-ups Enabled",
      description: `Darwin will follow up every ${automation?.rd_follow_up_interval_days || 3} days to track recoverable depreciation release.`,
    });
  };

  const handleDisableRDFollowUp = () => {
    ensureAndUpdate.mutate({
      rd_follow_up_enabled: false,
      rd_follow_up_stopped_at: new Date().toISOString(),
      rd_follow_up_stop_reason: 'manual',
      rd_check_tracking_enabled: false,
    });
  };

  const handleResetRDFollowUp = () => {
    const nextAt = new Date();
    nextAt.setDate(nextAt.getDate() + (automation?.rd_follow_up_interval_days || 3));

    ensureAndUpdate.mutate({
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
  };

  const handleMarkRDReleased = () => {
    ensureAndUpdate.mutate({
      rd_follow_up_enabled: false,
      rd_follow_up_stopped_at: new Date().toISOString(),
      rd_follow_up_stop_reason: 'rd_released',
    });

    toast({
      title: "RD Released",
      description: "Recoverable Depreciation marked as released. Follow-ups stopped.",
    });
  };

  const handleUpdateInterval = (value: number) => {
    const updates: Record<string, any> = { rd_follow_up_interval_days: value };
    if (automation?.rd_follow_up_enabled && !automation?.rd_follow_up_stopped_at) {
      const nextAt = new Date();
      nextAt.setDate(nextAt.getDate() + value);
      updates.rd_follow_up_next_at = nextAt.toISOString();
    }
    ensureAndUpdate.mutate(updates);
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

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-amber-500/10 rounded-lg">
            <DollarSign className="h-5 w-5 text-amber-500" />
          </div>
          <div>
            <CardTitle className="text-lg">Recoverable Depreciation Follow-ups</CardTitle>
            <CardDescription>
              Automatically follow up on invoice receipt and RD release
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
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
            {!automation?.rd_follow_up_enabled ? (
              <Button
                size="sm"
                onClick={handleEnableRDFollowUp}
                disabled={ensureAndUpdate.isPending}
                className="bg-amber-500 hover:bg-amber-600 text-white"
              >
                Enable
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={handleDisableRDFollowUp}
                disabled={ensureAndUpdate.isPending}
              >
                Disable
              </Button>
            )}
          </div>

          {automation?.rd_follow_up_enabled && (
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
                    disabled={ensureAndUpdate.isPending}
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
                  onValueChange={(v) => handleUpdateInterval(parseInt(v))}
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
                  disabled={ensureAndUpdate.isPending}
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
      </CardContent>
    </Card>
  );
};

export default RecoverableDepreciationFollowUps;
