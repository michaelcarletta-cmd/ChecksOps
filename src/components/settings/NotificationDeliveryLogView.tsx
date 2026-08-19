import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Bell, Search, RefreshCw, Download, AlertTriangle, CheckCircle, XCircle, Clock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";

interface DeliveryLog {
  id: string;
  task_id: string;
  user_id: string;
  channel: string;
  notification_type: string;
  escalation_level: number;
  delivery_status: string;
  provider_response: Record<string, unknown> | null;
  created_at: string;
}

const STATUS_STYLES: Record<string, string> = {
  sent: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  delivered: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  queued: "bg-primary/15 text-primary border-primary/30",
  failed: "bg-destructive/15 text-destructive border-destructive/30",
  skipped_fallback: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  acknowledged: "bg-primary/15 text-primary border-primary/30",
};

const CHANNEL_ICONS: Record<string, string> = {
  in_app: "🔔",
  push: "📱",
  sms: "💬",
  email: "📧",
};

export function NotificationDeliveryLogView() {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");

  const { data: logs = [], isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["notification-delivery-logs", statusFilter, channelFilter],
    queryFn: async () => {
      let query = supabase
        .from("notification_delivery_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);

      if (statusFilter !== "all") {
        query = query.eq("delivery_status", statusFilter);
      }
      if (channelFilter !== "all") {
        query = query.eq("channel", channelFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as DeliveryLog[];
    },
    staleTime: 15000,
  });

  const { data: taskMap = {} } = useQuery({
    queryKey: ["notif-log-tasks", logs.length],
    queryFn: async () => {
      const taskIds = [...new Set(logs.map(l => l.task_id))];
      if (taskIds.length === 0) return {};
      const { data } = await supabase
        .from("tasks")
        .select("id, title")
        .in("id", taskIds.slice(0, 50));
      return (data || []).reduce((acc, t) => {
        acc[t.id] = t.title;
        return acc;
      }, {} as Record<string, string>);
    },
    enabled: logs.length > 0,
  });

  const filteredLogs = logs.filter(log => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      log.channel.toLowerCase().includes(q) ||
      log.delivery_status.toLowerCase().includes(q) ||
      log.notification_type.toLowerCase().includes(q) ||
      (taskMap[log.task_id] || "").toLowerCase().includes(q)
    );
  });

  const sentCount = logs.filter(l => l.delivery_status === "sent" || l.delivery_status === "delivered").length;
  const failedCount = logs.filter(l => l.delivery_status === "failed").length;
  const skippedCount = logs.filter(l => l.delivery_status === "skipped_fallback").length;

  const handleExport = () => {
    const csv = [
      ["Timestamp", "Task", "Channel", "Type", "Escalation", "Status", "Response"].join(","),
      ...filteredLogs.map(log => [
        format(new Date(log.created_at), "yyyy-MM-dd HH:mm:ss"),
        (taskMap[log.task_id] || log.task_id).replace(/,/g, ";"),
        log.channel,
        log.notification_type,
        log.escalation_level,
        log.delivery_status,
        JSON.stringify(log.provider_response || {}).replace(/,/g, ";"),
      ].join(","))
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `notification-logs-${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <SettingsHero
        title="Notification Logs"
        description="Audit trail for all automated notification delivery attempts across all channels."
        badge="Communication"
        icon={<Bell className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Delivery Logs"
        icon={<Bell className="h-4 w-4 text-sky-500" />}
        accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
        description="Monitor notification status and provider responses for all system alerts."
        headerActions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching} className="h-8">
              <RefreshCw className={`h-3 w-3 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={filteredLogs.length === 0} className="h-8">
              <Download className="h-3 w-3 mr-2" />
              Export
            </Button>
          </div>
        }
      >
        <div className="space-y-6 pt-4">
          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by task, channel, status..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="delivered">Delivered</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="skipped_fallback">Skipped / Fallback</SelectItem>
                <SelectItem value="queued">Queued</SelectItem>
                <SelectItem value="acknowledged">Acknowledged</SelectItem>
              </SelectContent>
            </Select>
            <Select value={channelFilter} onValueChange={setChannelFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Channel" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Channels</SelectItem>
                <SelectItem value="in_app">🔔 In-App</SelectItem>
                <SelectItem value="push">📱 Push</SelectItem>
                <SelectItem value="sms">💬 SMS</SelectItem>
                <SelectItem value="email">📧 Email</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="p-4 bg-muted/20 border-border/40">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Total</span>
              </div>
              <p className="text-2xl font-bold mt-1">{logs.length}</p>
            </Card>
            <Card className="p-4 bg-muted/20 border-border/40">
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-emerald-600" />
                <span className="text-sm text-muted-foreground">Sent</span>
              </div>
              <p className="text-2xl font-bold mt-1">{sentCount}</p>
            </Card>
            <Card className="p-4 bg-muted/20 border-border/40">
              <div className="flex items-center gap-2">
                <XCircle className="h-4 w-4 text-destructive" />
                <span className="text-sm text-muted-foreground">Failed</span>
              </div>
              <p className="text-2xl font-bold mt-1">{failedCount}</p>
            </Card>
            <Card className="p-4 bg-muted/20 border-border/40">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <span className="text-sm text-muted-foreground">Skipped</span>
              </div>
              <p className="text-2xl font-bold mt-1">{skippedCount}</p>
            </Card>
          </div>

          {/* Table */}
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4, 5].map(i => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <ScrollArea className="h-[500px] rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead className="w-[150px]">Timestamp</TableHead>
                    <TableHead>Task</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Strategy</TableHead>
                    <TableHead>Escalation</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLogs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                        No notification delivery logs found
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredLogs.map(log => (
                      <TableRow key={log.id}>
                        <TableCell className="font-mono text-xs">
                          {format(new Date(log.created_at), "MMM dd, HH:mm:ss")}
                        </TableCell>
                        <TableCell className="text-sm max-w-[200px] truncate">
                          {taskMap[log.task_id] || log.task_id.slice(0, 8)}
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">
                            {CHANNEL_ICONS[log.channel] || ""} {log.channel}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {log.notification_type}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            L{log.escalation_level}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={STATUS_STYLES[log.delivery_status] || ""}>
                            {log.delivery_status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[180px] truncate">
                          {log.provider_response ? JSON.stringify(log.provider_response) : "—"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </div>
      </SectionCard>
    </div>
  );
}
