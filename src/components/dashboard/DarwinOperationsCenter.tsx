import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { 
  Bot, 
  Zap, 
  Eye, 
  AlertTriangle, 
  CheckCircle, 
  XCircle,
  Mail,
  CheckSquare,
  Clock,
  TrendingUp,
  Loader2,
  ExternalLink,
  Pause,
  Play,
  FileText,
  RefreshCw,
  Activity
} from "lucide-react";
import { format } from "date-fns";
import { Link } from "react-router-dom";

interface AutonomousClaim {
  id: string;
  claim_number: string;
  policyholder_name: string;
  status: string;
  autonomy_level: string;
  is_enabled: boolean;
}

interface ActionLog {
  id: string;
  claim_id: string;
  action_type: string;
  action_details: Record<string, any>;
  was_auto_executed: boolean;
  executed_at: string;
  result: string;
  error_message: string | null;
  claims?: {
    claim_number: string;
    policyholder_name: string;
  };
}

interface ActionStats {
  emails_sent: number;
  tasks_completed: number;
  follow_ups_scheduled: number;
  escalations: number;
  documents_processed: number;
}

export const DarwinOperationsCenter = () => {
  const [activeTab, setActiveTab] = useState("overview");

  const [bulkSyncRunning, setBulkSyncRunning] = useState(false);
  const [bulkSyncProgress, setBulkSyncProgress] = useState({ current: 0, total: 0, healthy: 0, attention: 0, errors: 0 });

  // Fetch autonomous claims
  const { data: autonomousClaims, isLoading: claimsLoading } = useQuery({
    queryKey: ["autonomous-claims"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_automations")
        .select(`
          id,
          claim_id,
          is_enabled,
          autonomy_level,
          claims!inner(
            id,
            claim_number,
            policyholder_name,
            status
          )
        `)
        .in("autonomy_level", ["semi_autonomous", "fully_autonomous"])
        .eq("is_enabled", true);

      if (error) throw error;

      return data?.map((item: any) => ({
        id: item.claims.id,
        claim_number: item.claims.claim_number,
        policyholder_name: item.claims.policyholder_name,
        status: item.claims.status,
        autonomy_level: item.autonomy_level,
        is_enabled: item.is_enabled,
      })) as AutonomousClaim[];
    },
  });

  // Fetch recent action logs
  const { data: actionLogs, isLoading: logsLoading } = useQuery({
    queryKey: ["darwin-all-action-logs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("darwin_action_log")
        .select(`
          *,
          claims(claim_number, policyholder_name)
        `)
        .order("executed_at", { ascending: false })
        .limit(100);

      if (error) throw error;
      return data as ActionLog[];
    },
  });

  // Fetch today's stats
  const { data: todayStats } = useQuery({
    queryKey: ["darwin-today-stats"],
    queryFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const { data, error } = await supabase
        .from("darwin_action_log")
        .select("action_type, was_auto_executed")
        .gte("executed_at", today.toISOString())
        .eq("was_auto_executed", true);

      if (error) throw error;

      const stats: ActionStats = {
        emails_sent: 0,
        tasks_completed: 0,
        follow_ups_scheduled: 0,
        escalations: 0,
        documents_processed: 0,
      };

      data?.forEach((log: any) => {
        switch (log.action_type) {
          case "email_sent":
            stats.emails_sent++;
            break;
          case "task_completed":
            stats.tasks_completed++;
            break;
          case "follow_up_scheduled":
            stats.follow_ups_scheduled++;
            break;
          case "escalation":
            stats.escalations++;
            break;
          case "document_classified":
            stats.documents_processed++;
            break;
        }
      });

      return stats;
    },
  });

  // Fetch pending escalations
  const { data: escalations } = useQuery({
    queryKey: ["darwin-escalations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("darwin_action_log")
        .select(`
          *,
          claims(claim_number, policyholder_name)
        `)
        .eq("action_type", "escalation")
        .order("executed_at", { ascending: false })
        .limit(20);

      if (error) throw error;
      return data as ActionLog[];
    },
  });

  const getAutonomyBadge = (level: string) => {
    if (level === "semi_autonomous") {
      return (
        <Badge className="bg-amber-500/20 text-amber-500">
          <Zap className="h-3 w-3 mr-1" />
          Semi
        </Badge>
      );
    }
    return (
      <Badge className="bg-green-500/20 text-green-500">
        <Bot className="h-3 w-3 mr-1" />
        Full
      </Badge>
    );
  };

  const getActionIcon = (actionType: string) => {
    switch (actionType) {
      case "email_sent":
        return <Mail className="h-4 w-4 text-blue-500" />;
      case "task_completed":
        return <CheckSquare className="h-4 w-4 text-green-500" />;
      case "follow_up_scheduled":
        return <Clock className="h-4 w-4 text-amber-500" />;
      case "escalation":
        return <AlertTriangle className="h-4 w-4 text-red-500" />;
      case "document_classified":
        return <FileText className="h-4 w-4 text-purple-500" />;
      default:
        return <Zap className="h-4 w-4 text-primary" />;
    }
  };

  const runBulkHealthChecks = useCallback(async () => {
    setBulkSyncRunning(true);
    setBulkSyncProgress({ current: 0, total: 0, healthy: 0, attention: 0, errors: 0 });

    try {
      // Fetch all claim IDs
      const { data: allClaims, error: fetchErr } = await supabase
        .from("claims")
        .select("id, claim_number")
        .eq("is_closed", false)
        .order("created_at", { ascending: false });

      if (fetchErr) throw fetchErr;
      if (!allClaims || allClaims.length === 0) {
        toast.info("No open claims to process");
        setBulkSyncRunning(false);
        return;
      }

      const total = allClaims.length;
      setBulkSyncProgress(p => ({ ...p, total }));
      toast.info(`Starting health checks on ${total} claims...`);

      let healthy = 0;
      let attention = 0;
      let errors = 0;

      for (let i = 0; i < allClaims.length; i++) {
        const claim = allClaims[i];
        try {
          const { data, error } = await supabase.functions.invoke("darwin-health-check", {
            body: { claimId: claim.id },
          });
          if (error) {
            errors++;
            console.error(`Health check failed for ${claim.claim_number}:`, error);
          } else if (data?.status === "Healthy") {
            healthy++;
          } else {
            attention++;
          }
        } catch {
          errors++;
        }
        setBulkSyncProgress({ current: i + 1, total, healthy, attention, errors });
      }

      toast.success(`Bulk sync complete: ${healthy} healthy, ${attention} need attention, ${errors} errors`);
    } catch (err) {
      console.error("Bulk sync error:", err);
      toast.error("Bulk sync failed");
    } finally {
      setBulkSyncRunning(false);
    }
  }, []);

  if (claimsLoading || logsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Bulk Sync Card */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">Bulk Health Check Sync</CardTitle>
            </div>
            <Button
              onClick={runBulkHealthChecks}
              disabled={bulkSyncRunning}
              size="sm"
            >
              {bulkSyncRunning ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              {bulkSyncRunning ? "Running..." : "Sync All Claims"}
            </Button>
          </div>
          <CardDescription>Run health checks on all open claims to refresh expert detection, timeline, and denial analysis</CardDescription>
        </CardHeader>
        {(bulkSyncRunning || bulkSyncProgress.total > 0) && (
          <CardContent className="pt-0">
            <Progress
              value={bulkSyncProgress.total > 0 ? (bulkSyncProgress.current / bulkSyncProgress.total) * 100 : 0}
              className="h-2 mb-2"
            />
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{bulkSyncProgress.current} / {bulkSyncProgress.total} claims processed</span>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <CheckCircle className="h-3 w-3 text-green-500" /> {bulkSyncProgress.healthy}
                </span>
                <span className="flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 text-amber-500" /> {bulkSyncProgress.attention}
                </span>
                {bulkSyncProgress.errors > 0 && (
                  <span className="flex items-center gap-1">
                    <XCircle className="h-3 w-3 text-red-500" /> {bulkSyncProgress.errors}
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Claims on Autopilot</p>
                <p className="text-3xl font-bold">{autonomousClaims?.length || 0}</p>
              </div>
              <div className="p-3 bg-primary/10 rounded-full">
                <Bot className="h-6 w-6 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Emails Sent Today</p>
                <p className="text-3xl font-bold">{todayStats?.emails_sent || 0}</p>
              </div>
              <div className="p-3 bg-blue-500/10 rounded-full">
                <Mail className="h-6 w-6 text-blue-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Tasks Completed</p>
                <p className="text-3xl font-bold">{todayStats?.tasks_completed || 0}</p>
              </div>
              <div className="p-3 bg-green-500/10 rounded-full">
                <CheckCircle className="h-6 w-6 text-green-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Docs Processed</p>
                <p className="text-3xl font-bold">{todayStats?.documents_processed || 0}</p>
              </div>
              <div className="p-3 bg-purple-500/10 rounded-full">
                <FileText className="h-6 w-6 text-purple-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Needs Attention</p>
                <p className="text-3xl font-bold">{escalations?.length || 0}</p>
              </div>
              <div className="p-3 bg-red-500/10 rounded-full">
                <AlertTriangle className="h-6 w-6 text-red-500" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-muted/50 w-full justify-start flex-row">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="claims">Managed Claims</TabsTrigger>
          <TabsTrigger value="actions">Action Log</TabsTrigger>
          <TabsTrigger value="escalations">
            Escalations
            {(escalations?.length || 0) > 0 && (
              <Badge variant="destructive" className="ml-2 h-5 px-1.5">
                {escalations?.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent Actions */}
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-primary" />
                  Recent Actions
                </CardTitle>
                <CardDescription>Latest autonomous operations</CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[300px]">
                  <div className="space-y-3">
                    {actionLogs?.slice(0, 10).map((log) => (
                      <div
                        key={log.id}
                        className="flex items-start gap-3 p-2 rounded-lg bg-muted/30"
                      >
                        {getActionIcon(log.action_type)}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium capitalize">
                              {log.action_type.replace(/_/g, " ")}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(log.executed_at), "h:mm a")}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            {log.claims?.claim_number} - {log.claims?.policyholder_name}
                          </p>
                        </div>
                        {log.was_auto_executed && (
                          <Badge variant="secondary" className="text-xs">
                            <Zap className="h-3 w-3" />
                          </Badge>
                        )}
                      </div>
                    ))}
                    {(!actionLogs || actionLogs.length === 0) && (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No actions recorded yet
                      </p>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Active Autonomous Claims */}
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Bot className="h-5 w-5 text-primary" />
                  Active Autonomous Claims
                </CardTitle>
                <CardDescription>Claims running on autopilot</CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[300px]">
                  <div className="space-y-3">
                    {autonomousClaims?.map((claim) => (
                      <Link
                        key={claim.id}
                        to={`/claims/${claim.id}`}
                        className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
                      >
                        <div>
                          <div className="font-medium text-sm">{claim.claim_number}</div>
                          <div className="text-xs text-muted-foreground">
                            {claim.policyholder_name}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {getAutonomyBadge(claim.autonomy_level)}
                          <ExternalLink className="h-4 w-4 text-muted-foreground" />
                        </div>
                      </Link>
                    ))}
                    {(!autonomousClaims || autonomousClaims.length === 0) && (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        No claims in autonomous mode
                      </p>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="claims" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" />
                All Managed Claims
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <div className="space-y-2">
                  {autonomousClaims?.map((claim) => (
                    <div
                      key={claim.id}
                      className="flex items-center justify-between p-4 rounded-lg bg-muted/30"
                    >
                      <div className="flex items-center gap-4">
                        <div>
                          <div className="font-medium">{claim.claim_number}</div>
                          <div className="text-sm text-muted-foreground">
                            {claim.policyholder_name}
                          </div>
                        </div>
                        <Badge variant="outline">{claim.status}</Badge>
                      </div>
                      <div className="flex items-center gap-3">
                        {getAutonomyBadge(claim.autonomy_level)}
                        <Link to={`/claims/${claim.id}`}>
                          <Button size="sm" variant="outline">
                            <ExternalLink className="h-4 w-4 mr-2" />
                            View
                          </Button>
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="actions" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-primary" />
                Complete Action Log
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px]">
                <div className="space-y-2">
                  {actionLogs?.map((log) => (
                    <div
                      key={log.id}
                      className={`p-4 rounded-lg ${
                        log.error_message
                          ? "bg-red-500/10 border border-red-500/20"
                          : "bg-muted/30"
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3">
                          {getActionIcon(log.action_type)}
                          <div>
                            <div className="font-medium capitalize">
                              {log.action_type.replace(/_/g, " ")}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {log.claims?.claim_number} - {log.claims?.policyholder_name}
                            </div>
                            {log.result && (
                              <p className="text-sm mt-1">{log.result}</p>
                            )}
                            {log.error_message && (
                              <p className="text-sm text-red-500 mt-1">{log.error_message}</p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {log.was_auto_executed && (
                            <Badge className="bg-green-500/20 text-green-500">
                              <Zap className="h-3 w-3 mr-1" />
                              Auto
                            </Badge>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(log.executed_at), "MMM d, h:mm a")}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="escalations" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-red-500" />
                Items Needing Attention
              </CardTitle>
              <CardDescription>
                Darwin flagged these items for human review
              </CardDescription>
            </CardHeader>
            <CardContent>
              {escalations && escalations.length > 0 ? (
                <ScrollArea className="h-[500px]">
                  <div className="space-y-3">
                    {escalations.map((esc) => (
                      <div
                        key={esc.id}
                        className="p-4 rounded-lg bg-red-500/10 border border-red-500/20"
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="font-medium">
                              {esc.claims?.claim_number}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {esc.claims?.policyholder_name}
                            </div>
                            <p className="text-sm mt-2">{esc.result}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(esc.executed_at), "MMM d, h:mm a")}
                            </span>
                            <Link to={`/claims/${esc.claim_id}`}>
                              <Button size="sm">
                                <ExternalLink className="h-4 w-4 mr-2" />
                                Review
                              </Button>
                            </Link>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <div className="text-center py-12">
                  <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
                  <h3 className="font-medium text-lg">All Clear!</h3>
                  <p className="text-muted-foreground">
                    No items need your attention right now
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
};
