import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RefreshCw, ChevronDown, AlertTriangle, CheckCircle, XCircle, HelpCircle, Send, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";

const STATUS_COLORS: Record<string, string> = {
  task_created_assignment_verified: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  task_created_unverified: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  task_created_assignment_mismatch: "bg-destructive/15 text-destructive border-destructive/30",
  synced_note_only: "bg-primary/15 text-primary border-primary/30",
  notification_failed: "bg-destructive/15 text-destructive border-destructive/30",
  notification_preferences_unknown: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  none: "bg-muted text-muted-foreground border-border",
  sent: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  fallback_used: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
};

export function JobNimbusSyncDiagnostics() {
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  const { data: rows = [], isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["jn-sync-diagnostics"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("jobnimbus_sync_queue" as any)
        .select("*")
        .in("sync_type", ["note", "inspection", "file"])
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data || []) as any[];
    },
    staleTime: 10000,
  });

  const runNotificationTest = async () => {
    setTestRunning(true);
    setTestResult(null);
    try {
      // Get first mapped user
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, full_name, jobnimbus_user_id")
        .not("jobnimbus_user_id", "is", null)
        .limit(1);

      if (!profiles || profiles.length === 0) {
        toast.error("No users with JobNimbus IDs mapped");
        return;
      }

      const target = profiles[0];
      const { data, error } = await supabase.functions.invoke("process-jobnimbus-sync", {
        body: {
          test_notification: true,
          target_jn_user_id: (target as any).jobnimbus_user_id,
        },
      });

      if (error) throw error;
      setTestResult({ ...data, targetUser: (target as any).full_name });
      toast.success("Test completed — check results below");
    } catch (err: any) {
      toast.error(`Test failed: ${err.message}`);
      setTestResult({ test: "ERROR", error: err.message });
    } finally {
      setTestRunning(false);
    }
  };

  const getStatusIcon = (status: string) => {
    if (status?.includes("verified")) return <CheckCircle className="h-4 w-4 text-emerald-600" />;
    if (status?.includes("mismatch") || status?.includes("failed")) return <XCircle className="h-4 w-4 text-destructive" />;
    if (status?.includes("unverified")) return <AlertTriangle className="h-4 w-4 text-amber-600" />;
    return <HelpCircle className="h-4 w-4 text-muted-foreground" />;
  };

  return (
    <div className="space-y-6">
      {/* Test Panel */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">🔔 Notification Test</CardTitle>
          <CardDescription>
            Create a minimal test task assigned to a mapped JobNimbus user, then verify the assignment was stored correctly.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={runNotificationTest} disabled={testRunning} variant="outline">
            {testRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
            Run Notification Test
          </Button>

          {testResult && (
            <div className="rounded-md border p-4 bg-muted/30 space-y-2">
              <div className="flex items-center gap-2">
                {testResult.test === "COMPLETED" ? <CheckCircle className="h-5 w-5 text-emerald-600" /> : <XCircle className="h-5 w-5 text-destructive" />}
                <span className="font-medium">{testResult.test}</span>
                {testResult.targetUser && <span className="text-sm text-muted-foreground">— {testResult.targetUser}</span>}
              </div>

              {testResult.verification && (
                <div className="text-sm space-y-1">
                  <p>Created Task ID: <code className="bg-muted px-1 rounded">{testResult.created_task_id}</code></p>
                  <p>Owners match: <Badge variant="outline" className={testResult.verification.target_user_found_in_owners ? STATUS_COLORS.task_created_assignment_verified : STATUS_COLORS.task_created_assignment_mismatch}>
                    {testResult.verification.target_user_found_in_owners ? "✅ YES" : "❌ NO"}
                  </Badge></p>
                  <p>sales_rep_ids match: {testResult.verification.target_user_found_in_sales_rep_ids ? "✅" : "❌"}</p>
                  <p>assigned_to_ids match: {testResult.verification.target_user_found_in_assigned_to_ids ? "✅" : "❌"}</p>
                  <p>Record type: {testResult.verification.record_type_name}</p>
                </div>
              )}

              {testResult.recommendation && (
                <Alert className="mt-2">
                  <AlertTitle>Recommendation</AlertTitle>
                  <AlertDescription className="text-sm">{testResult.recommendation}</AlertDescription>
                </Alert>
              )}

              <Collapsible>
                <CollapsibleTrigger className="text-xs text-muted-foreground flex items-center gap-1 cursor-pointer">
                  <ChevronDown className="h-3 w-3" /> Raw response
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="text-xs bg-muted p-2 rounded mt-1 max-h-[200px] overflow-auto">
                    {JSON.stringify(testResult, null, 2)}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Troubleshooting Checklist */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">🔍 Troubleshooting Checklist</CardTitle>
          <CardDescription>If notifications are not appearing, verify each of these items.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="text-sm space-y-2 text-muted-foreground">
            <li>☐ The JobNimbus user has <strong>"Task Assigned"</strong> enabled in their Profile → Notification Preferences</li>
            <li>☐ They are checking the <strong>web bell icon</strong> (Notification Center) in JobNimbus</li>
            <li>☐ Their <strong>mobile/web/email channels</strong> are enabled in JN notification settings</li>
            <li>☐ The mapped <strong>JobNimbus User ID</strong> belongs to the correct person (verify in JN admin)</li>
            <li>☐ The verification GET confirms <strong>owners match = YES</strong> for the created task</li>
            <li>☐ The user is <strong>not the note author</strong> (self-notifications are skipped)</li>
          </ul>
        </CardContent>
      </Card>

      {/* Sync Queue Diagnostics Table */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Sync Queue — Notification Diagnostics</CardTitle>
              <CardDescription>Recent note & inspection syncs with notification verification details.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (
            <ScrollArea className="h-[500px] rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead className="w-[130px]">Time</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead>Target User</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                        No note/inspection sync records found
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row: any) => {
                      const details = row.notification_details || {};
                      const results = details.results || {};
                      const firstResult = Object.values(results)[0] as any;

                      return (
                        <TableRow key={row.id}>
                          <TableCell className="font-mono text-xs">
                            {row.created_at ? format(new Date(row.created_at), "MMM dd HH:mm") : "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">{row.sync_type}</Badge>
                          </TableCell>
                          <TableCell>
                            {details.noteCreated || details.noteJnId ? (
                              <span className="text-emerald-600 text-xs">✅ {details.noteJnId ? details.noteJnId.substring(0, 8) : "yes"}</span>
                            ) : row.sync_type === 'inspection' && details.taskCreated ? (
                              <span className="text-muted-foreground text-xs">n/a</span>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {firstResult?.taskId || details.taskJnId ? (
                              <span className="text-emerald-600 text-xs">✅ {(firstResult?.taskId || details.taskJnId || "").substring(0, 8)}</span>
                            ) : firstResult?.skipped ? (
                              <span className="text-muted-foreground text-xs">skipped</span>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs max-w-[140px] truncate">
                            {(details.targetUsers || []).map((u: any) => u.displayName).join(", ") || "—"}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              {getStatusIcon(row.notification_status)}
                              <Badge variant="outline" className={`text-xs ${STATUS_COLORS[row.notification_status] || ""}`}>
                                {row.notification_status || "unknown"}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Collapsible>
                              <CollapsibleTrigger className="text-xs text-primary cursor-pointer flex items-center gap-1">
                                <ChevronDown className="h-3 w-3" /> view
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <pre className="text-xs bg-muted p-2 rounded mt-1 max-w-[300px] max-h-[200px] overflow-auto whitespace-pre-wrap">
                                  {JSON.stringify(details, null, 2)}
                                </pre>
                              </CollapsibleContent>
                            </Collapsible>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
