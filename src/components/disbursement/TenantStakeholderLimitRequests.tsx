import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Check, X, Users } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type Row = {
  id: string;
  tenant_id: string;
  category: string;
  requested_limit: number;
  reason: string | null;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  review_notes: string | null;
  requested_by: string;
};

const CATEGORY_LABEL: Record<string, string> = {
  sales_rep: "Sales Reps",
  subcontractor: "Subcontractors",
  vendor: "Vendors",
};

export function TenantStakeholderLimitRequests() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"pending" | "reviewed">("pending");
  const [decisionRow, setDecisionRow] = useState<Row | null>(null);
  const [decisionKind, setDecisionKind] = useState<"approve" | "deny">("approve");
  const [approvedLimit, setApprovedLimit] = useState<number>(0);
  const [notes, setNotes] = useState("");

  const { data: role } = useQuery({
    queryKey: ["tenant-user-role", tenant?.id, user?.id],
    enabled: !!tenant?.id && !!user?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("tenant_users")
        .select("role")
        .eq("tenant_id", tenant!.id)
        .eq("user_id", user!.id)
        .maybeSingle();
      return (data?.role ?? null) as string | null;
    },
  });

  const canApprove = role === "owner" || role === "admin";

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["tenant-stakeholder-limit-requests", tenant?.id, tab],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const q = supabase
        .from("stakeholder_limit_requests")
        .select("id, tenant_id, category, requested_limit, reason, status, created_at, reviewed_at, review_notes, requested_by")
        .eq("tenant_id", tenant!.id)
        .order("created_at", { ascending: false });
      const { data, error } = tab === "pending"
        ? await q.eq("status", "pending")
        : await q.neq("status", "pending");
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const decideMut = useMutation({
    mutationFn: async () => {
      if (!decisionRow) return;
      const { error } = await supabase.rpc("decide_stakeholder_limit_request", {
        _request_id: decisionRow.id,
        _decision: decisionKind === "approve" ? "approved" : "denied",
        _approved_limit: decisionKind === "approve" ? approvedLimit : decisionRow.requested_limit,
        _notes: notes || null,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: decisionKind === "approve" ? "Request approved" : "Request denied" });
      qc.invalidateQueries({ queryKey: ["tenant-stakeholder-limit-requests"] });
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
      setDecisionRow(null);
      setNotes("");
    },
    onError: (e: any) => toast({ title: "Couldn't save decision", description: e.message, variant: "destructive" }),
  });

  const openDecision = (row: Row, kind: "approve" | "deny") => {
    setDecisionRow(row);
    setDecisionKind(kind);
    setApprovedLimit(row.requested_limit);
    setNotes("");
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2"><Users className="h-4 w-4" /> Cap-Increase Requests</CardTitle>
        <CardDescription className="text-xs">
          {canApprove
            ? "Review and approve your team's requests to raise sales rep or subcontractor caps."
            : "Requests your team has submitted. Only tenant owners and admins can approve."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList className="mb-3 h-8">
            <TabsTrigger value="pending" className="text-xs">Pending</TabsTrigger>
            <TabsTrigger value="reviewed" className="text-xs">Reviewed</TabsTrigger>
          </TabsList>
          <TabsContent value={tab}>
            {isLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin" /></div>
            ) : rows.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">No {tab} requests.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Category</TableHead>
                    <TableHead className="text-xs">Requested</TableHead>
                    <TableHead className="text-xs">Reason</TableHead>
                    <TableHead className="text-xs">Submitted</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-right text-xs">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell><Badge variant="outline" className="text-xs">{CATEGORY_LABEL[r.category] ?? r.category}</Badge></TableCell>
                      <TableCell className="font-mono text-xs">{r.requested_limit}</TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={r.reason ?? ""}>{r.reason || "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</TableCell>
                      <TableCell>
                        <Badge variant={r.status === "pending" ? "secondary" : r.status === "approved" ? "default" : "destructive"} className="text-xs">{r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {r.status === "pending" && canApprove ? (
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openDecision(r, "approve")}>
                              <Check className="h-3 w-3 mr-1" /> Approve
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 text-xs text-destructive" onClick={() => openDecision(r, "deny")}>
                              <X className="h-3 w-3 mr-1" /> Deny
                            </Button>
                          </div>
                        ) : r.status === "pending" ? (
                          <span className="text-xs text-muted-foreground italic">owner/admin only</span>
                        ) : (
                          <span className="text-xs text-muted-foreground" title={r.review_notes ?? ""}>
                            {r.reviewed_at ? formatDistanceToNow(new Date(r.reviewed_at), { addSuffix: true }) : "—"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>

      <Dialog open={!!decisionRow} onOpenChange={(o) => !o && setDecisionRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{decisionKind === "approve" ? "Approve" : "Deny"} limit request</DialogTitle>
          </DialogHeader>
          {decisionRow && (
            <div className="space-y-3 text-sm">
              <div>
                <span className="text-muted-foreground">Category:</span> {CATEGORY_LABEL[decisionRow.category] ?? decisionRow.category}
              </div>
              <div>
                <span className="text-muted-foreground">Requested:</span> {decisionRow.requested_limit}
              </div>
              {decisionRow.reason && (
                <div>
                  <span className="text-muted-foreground">Reason:</span>
                  <p className="mt-1 text-xs bg-muted p-2 rounded">{decisionRow.reason}</p>
                </div>
              )}
              {decisionKind === "approve" && (
                <div>
                  <label className="text-xs font-medium">New cap to grant</label>
                  <Input type="number" min={1} value={approvedLimit} onChange={(e) => setApprovedLimit(Number(e.target.value))} />
                </div>
              )}
              <div>
                <label className="text-xs font-medium">Review notes (optional)</label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDecisionRow(null)}>Cancel</Button>
            <Button
              variant={decisionKind === "approve" ? "default" : "destructive"}
              onClick={() => decideMut.mutate()}
              disabled={decideMut.isPending}
            >
              {decideMut.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Confirm {decisionKind}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
