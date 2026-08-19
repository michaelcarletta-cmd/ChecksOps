import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Shield, Search, RefreshCw, Download, Eye, FileText, User, Clock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { usePermissions } from "@/hooks/usePermissions";

interface AuditLog {
  id: string;
  user_id: string | null;
  action: string;
  record_type: string;
  record_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const ACTION_COLORS: Record<string, string> = {
  create: "bg-success/20 text-success-foreground border-success/30",
  update: "bg-primary/20 text-primary-foreground border-primary/30",
  delete: "bg-destructive/20 text-destructive-foreground border-destructive/30",
  reveal_pii: "bg-warning/20 text-warning-foreground border-warning/30",
  login: "bg-secondary/50 text-secondary-foreground",
  logout: "bg-secondary/50 text-secondary-foreground",
  export: "bg-accent/50 text-accent-foreground",
};

export function AuditLogSettings() {
  const { can } = usePermissions();
  const [searchQuery, setSearchQuery] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [recordTypeFilter, setRecordTypeFilter] = useState("all");

  const { data: logs = [], isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["audit-logs", actionFilter, recordTypeFilter],
    queryFn: async () => {
      let query = supabase
        .from("audit_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);

      if (actionFilter !== "all") {
        query = query.eq("action", actionFilter);
      }
      if (recordTypeFilter !== "all") {
        query = query.eq("record_type", recordTypeFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as AuditLog[];
    },
    enabled: can("view_audit_logs"),
    staleTime: 30000,
  });

  const { data: userMap = {} } = useQuery({
    queryKey: ["audit-log-users"],
    queryFn: async () => {
      const userIds = [...new Set(logs.map(l => l.user_id).filter(Boolean))];
      if (userIds.length === 0) return {};
      
      const { data } = await supabase
        .from("profiles")
        .select("id, email, full_name")
        .in("id", userIds as string[]);
      
      return (data || []).reduce((acc, u) => {
        acc[u.id] = u.full_name || u.email || "Unknown";
        return acc;
      }, {} as Record<string, string>);
    },
    enabled: logs.length > 0,
  });

  // Filter logs by search query
  const filteredLogs = logs.filter(log => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      log.action.toLowerCase().includes(query) ||
      log.record_type.toLowerCase().includes(query) ||
      (log.record_id && log.record_id.toLowerCase().includes(query)) ||
      (userMap[log.user_id || ""] || "").toLowerCase().includes(query)
    );
  });

  // Get unique values for filters
  const uniqueActions = ["all", ...new Set(logs.map(l => l.action))];
  const uniqueRecordTypes = ["all", ...new Set(logs.map(l => l.record_type))];

  const handleExport = () => {
    const csv = [
      ["Timestamp", "User", "Action", "Record Type", "Record ID", "Details"].join(","),
      ...filteredLogs.map(log => [
        format(new Date(log.created_at), "yyyy-MM-dd HH:mm:ss"),
        userMap[log.user_id || ""] || log.user_id || "System",
        log.action,
        log.record_type,
        log.record_id || "",
        JSON.stringify(log.metadata || {}).replace(/,/g, ";"),
      ].join(","))
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-logs-${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!can("view_audit_logs")) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Shield className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground">You don't have permission to view audit logs.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Audit Logs
              </CardTitle>
              <CardDescription>
                Security audit trail of all system actions
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => refetch()}
                disabled={isRefetching}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button 
                variant="outline" 
                size="sm"
                onClick={handleExport}
                disabled={filteredLogs.length === 0}
              >
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search logs..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by action" />
              </SelectTrigger>
              <SelectContent>
                {uniqueActions.map(action => (
                  <SelectItem key={action} value={action}>
                    {action === "all" ? "All Actions" : action}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={recordTypeFilter} onValueChange={setRecordTypeFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                {uniqueRecordTypes.map(type => (
                  <SelectItem key={type} value={type}>
                    {type === "all" ? "All Types" : type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="p-4">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Total Logs</span>
              </div>
              <p className="text-2xl font-bold mt-1">{logs.length}</p>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-warning" />
                <span className="text-sm text-muted-foreground">PII Reveals</span>
              </div>
              <p className="text-2xl font-bold mt-1">
                {logs.filter(l => l.action === "reveal_pii").length}
              </p>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Unique Users</span>
              </div>
              <p className="text-2xl font-bold mt-1">
                {new Set(logs.map(l => l.user_id).filter(Boolean)).size}
              </p>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Last 24h</span>
              </div>
              <p className="text-2xl font-bold mt-1">
                {logs.filter(l => new Date(l.created_at) > new Date(Date.now() - 86400000)).length}
              </p>
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
                    <TableHead className="w-[180px]">Timestamp</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Record Type</TableHead>
                    <TableHead>Record ID</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLogs.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        No audit logs found
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredLogs.map(log => (
                      <TableRow key={log.id}>
                        <TableCell className="font-mono text-xs">
                          {format(new Date(log.created_at), "MMM dd, HH:mm:ss")}
                        </TableCell>
                        <TableCell className="text-sm">
                          {userMap[log.user_id || ""] || "System"}
                        </TableCell>
                        <TableCell>
                          <Badge 
                            variant="outline" 
                            className={ACTION_COLORS[log.action] || ""}
                          >
                            {log.action}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{log.record_type}</TableCell>
                        <TableCell className="font-mono text-xs max-w-[150px] truncate">
                          {log.record_id || "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                          {log.metadata ? JSON.stringify(log.metadata) : "—"}
                        </TableCell>
                      </TableRow>
                    ))
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
