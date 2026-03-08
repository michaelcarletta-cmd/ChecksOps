import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  ArrowRight, Building2, CheckCircle2, AlertTriangle, Clock,
  Send, RefreshCw, Banknote, XCircle, RotateCcw, FileCheck,
  Printer, ArrowDownToLine,
} from "lucide-react";
import { format } from "date-fns";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface DepositItem {
  id: string;
  check_id: string;
  batch_id: string | null;
  provider: string | null;
  status: string;
  amount: number;
  check_number: string | null;
  carrier_name: string | null;
  claim_id: string | null;
  idempotency_key: string;
  provider_reference: string | null;
  exception_reason: string | null;
  exception_code: string | null;
  reconciled_amount: number | null;
  reconciled_at: string | null;
  submitted_at: string | null;
  cleared_at: string | null;
  created_at: string;
}

interface ApprovedCheck {
  id: string;
  check_number: string | null;
  carrier_name: string | null;
  amount: number | null;
  claim_id: string | null;
  status: string;
  reviewed_at: string | null;
}

/* ------------------------------------------------------------------ */
/*  Status config                                                      */
/* ------------------------------------------------------------------ */

const statusConfig: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  pending_assignment: { label: "Pending Assignment", color: "bg-muted text-muted-foreground", icon: Clock },
  provider_assigned: { label: "Provider Assigned", color: "bg-blue-500/20 text-blue-400", icon: ArrowRight },
  submitted: { label: "Submitted", color: "bg-amber-500/20 text-amber-400", icon: Send },
  processing: { label: "Processing", color: "bg-blue-500/20 text-blue-400", icon: RefreshCw },
  succeeded: { label: "Cleared", color: "bg-emerald-500/20 text-emerald-400", icon: CheckCircle2 },
  failed: { label: "Failed", color: "bg-destructive/20 text-destructive", icon: XCircle },
  returned: { label: "Returned", color: "bg-orange-500/20 text-orange-400", icon: RotateCcw },
  reconciled: { label: "Reconciled", color: "bg-primary/20 text-primary", icon: FileCheck },
  exception: { label: "Exception", color: "bg-destructive/20 text-destructive", icon: AlertTriangle },
};

const providerLabels: Record<string, string> = {
  manual_branch: "Manual / Branch",
  internal_ready: "Internal Ready",
  synctera: "Synctera",
  treasury_prime: "Treasury Prime",
};

/* ------------------------------------------------------------------ */
/*  Main console                                                       */
/* ------------------------------------------------------------------ */

export function DepositOperationsConsole() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [actionDialog, setActionDialog] = useState<{
    action: string;
    itemId?: string;
    checkId?: string;
  } | null>(null);
  const [actionNotes, setActionNotes] = useState("");
  const [actionProvider, setActionProvider] = useState<string>("");
  const [actionAmount, setActionAmount] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Fetch deposit items
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["deposit-items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as DepositItem[];
    },
  });

  // Fetch approved checks not yet in pipeline
  const { data: approvedChecks = [] } = useQuery({
    queryKey: ["approved-checks-for-deposit"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, check_number, carrier_name, amount, claim_id, status, reviewed_at")
        .eq("status", "approved_for_deposit")
        .order("reviewed_at", { ascending: false });
      if (error) throw error;
      // Exclude checks already in pipeline
      const existingCheckIds = new Set(items.map((i) => i.check_id));
      return ((data ?? []) as ApprovedCheck[]).filter((c) => !existingCheckIds.has(c.id));
    },
    enabled: items !== undefined,
  });

  // Reconciliation summary
  const { data: reconSummary } = useQuery({
    queryKey: ["deposit-recon-summary"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_deposit_reconciliation_summary");
      if (error) throw error;
      return data as Record<string, number>;
    },
  });

  // Deposit action mutation
  const actionMutation = useMutation({
    mutationFn: async (params: {
      action: string;
      deposit_item_id?: string;
      check_id?: string;
      provider?: string;
      amount?: number;
      notes?: string;
      extra?: Record<string, unknown>;
    }) => {
      const { data, error } = await supabase.rpc("deposit_action", {
        p_action: params.action,
        p_actor_id: user!.id,
        p_deposit_item_id: params.deposit_item_id ?? null,
        p_check_id: params.check_id ?? null,
        p_provider: params.provider ?? null,
        p_amount: params.amount ?? null,
        p_notes: params.notes ?? null,
        p_extra: (params.extra ?? {}) as Record<string, string>,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({ title: "Action completed" });
      qc.invalidateQueries({ queryKey: ["deposit-items"] });
      qc.invalidateQueries({ queryKey: ["deposit-recon-summary"] });
      qc.invalidateQueries({ queryKey: ["approved-checks-for-deposit"] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      setActionDialog(null);
      setActionNotes("");
      setActionProvider("");
      setActionAmount("");
    },
    onError: (e: Error) => {
      toast({ title: "Action failed", description: e.message, variant: "destructive" });
    },
  });

  const filteredItems = statusFilter === "all" ? items : items.filter((i) => i.status === statusFilter);

  const handleExecuteAction = () => {
    if (!actionDialog) return;
    actionMutation.mutate({
      action: actionDialog.action,
      deposit_item_id: actionDialog.itemId,
      check_id: actionDialog.checkId,
      provider: actionProvider || undefined,
      amount: actionAmount ? parseFloat(actionAmount) : undefined,
      notes: actionNotes || undefined,
    });
  };

  const fmtMoney = (n: number | null) =>
    n != null ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—";

  return (
    <div className="space-y-4">
      {/* Reconciliation Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
        {[
          { label: "In Flight", value: reconSummary?.in_flight_amount, color: "text-amber-400" },
          { label: "Cleared", value: reconSummary?.cleared_amount, color: "text-emerald-400" },
          { label: "Reconciled", value: reconSummary?.reconciled_amount, color: "text-primary" },
          { label: "Failed", value: reconSummary?.failed_amount, color: "text-destructive" },
          { label: "Unreconciled", value: reconSummary?.unreconciled_amount, color: "text-orange-400" },
          { label: "Exceptions", value: reconSummary?.exceptions, color: "text-destructive", isCount: true },
          { label: "Returned", value: reconSummary?.returned, color: "text-orange-400", isCount: true },
        ].map((card) => (
          <Card key={card.label}>
            <CardContent className="p-3 text-center">
              <p className={`text-lg font-bold tabular-nums ${card.color}`}>
                {card.isCount ? (card.value ?? 0) : fmtMoney(card.value ?? 0)}
              </p>
              <p className="text-[10px] text-muted-foreground">{card.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Approved checks ready to enter pipeline */}
      {approvedChecks.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <ArrowDownToLine className="h-4 w-4 text-emerald-400" />
              Approved Checks — Ready for Deposit ({approvedChecks.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-48">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Check #</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {approvedChecks.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-sm">#{c.check_number || "—"}</TableCell>
                      <TableCell className="text-sm">{c.carrier_name || "—"}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(c.amount)}</TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          onClick={() => setActionDialog({ action: "prepare_deposit", checkId: c.id })}
                        >
                          <ArrowRight className="h-3 w-3 mr-1" />Prepare
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Deposit Pipeline */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Banknote className="h-4 w-4" />
              Deposit Pipeline ({items.length})
            </CardTitle>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-48 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                {Object.entries(statusConfig).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[calc(100vh-600px)] min-h-[300px]">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading...</div>
            ) : filteredItems.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">No deposit items</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Check #</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Idempotency</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.map((item) => {
                    const sc = statusConfig[item.status];
                    const Icon = sc?.icon ?? Clock;
                    return (
                      <TableRow
                        key={item.id}
                        className={`cursor-pointer ${selectedItemId === item.id ? "bg-accent/50" : ""}`}
                        onClick={() => setSelectedItemId(item.id)}
                      >
                        <TableCell className="font-mono text-sm">#{item.check_number || "—"}</TableCell>
                        <TableCell className="text-sm max-w-[120px] truncate">{item.carrier_name || "—"}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">{fmtMoney(item.amount)}</TableCell>
                        <TableCell>
                          <span className="text-xs">{item.provider ? providerLabels[item.provider] || item.provider : "—"}</span>
                        </TableCell>
                        <TableCell>
                          <Badge className={`text-[10px] gap-1 ${sc?.color ?? ""}`}>
                            <Icon className="h-3 w-3" />
                            {sc?.label ?? item.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <code className="text-[10px] text-muted-foreground">{item.idempotency_key.slice(0, 8)}</code>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {item.status === "pending_assignment" && (
                              <Button size="sm" variant="outline" className="text-xs h-7"
                                onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "assign_provider", itemId: item.id }); }}>
                                Assign
                              </Button>
                            )}
                            {item.status === "provider_assigned" && item.provider === "manual_branch" && (
                              <Button size="sm" variant="outline" className="text-xs h-7"
                                onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "mark_manual_deposit", itemId: item.id }); }}>
                                <Building2 className="h-3 w-3 mr-1" />Deposited
                              </Button>
                            )}
                            {item.status === "provider_assigned" && item.provider !== "manual_branch" && (
                              <Button size="sm" variant="outline" className="text-xs h-7"
                                onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "record_submission", itemId: item.id }); }}>
                                <Send className="h-3 w-3 mr-1" />Submit
                              </Button>
                            )}
                            {(item.status === "submitted" || item.status === "processing") && (
                              <>
                                <Button size="sm" variant="outline" className="text-xs h-7"
                                  onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "record_success", itemId: item.id }); }}>
                                  <CheckCircle2 className="h-3 w-3" />
                                </Button>
                                <Button size="sm" variant="outline" className="text-xs h-7"
                                  onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "record_failure", itemId: item.id }); }}>
                                  <XCircle className="h-3 w-3" />
                                </Button>
                              </>
                            )}
                            {item.status === "succeeded" && (
                              <Button size="sm" variant="outline" className="text-xs h-7"
                                onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "reconcile", itemId: item.id }); }}>
                                <FileCheck className="h-3 w-3 mr-1" />Reconcile
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Detail panel for selected item */}
      {selectedItemId && (
        <DepositItemDetail itemId={selectedItemId} />
      )}

      {/* Action Dialog */}
      <Dialog open={!!actionDialog} onOpenChange={() => setActionDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="capitalize">{actionDialog?.action.replace(/_/g, " ")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {actionDialog?.action === "assign_provider" && (
              <Select value={actionProvider} onValueChange={setActionProvider}>
                <SelectTrigger><SelectValue placeholder="Select provider" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual_branch">Manual / Branch</SelectItem>
                  <SelectItem value="internal_ready">Internal Ready</SelectItem>
                  <SelectItem value="synctera">Synctera</SelectItem>
                  <SelectItem value="treasury_prime">Treasury Prime</SelectItem>
                </SelectContent>
              </Select>
            )}
            {(actionDialog?.action === "reconcile" || actionDialog?.action === "record_success") && (
              <Input
                type="number"
                step="0.01"
                placeholder="Confirmed amount (optional)"
                value={actionAmount}
                onChange={(e) => setActionAmount(e.target.value)}
              />
            )}
            <Textarea
              placeholder="Notes (optional)"
              value={actionNotes}
              onChange={(e) => setActionNotes(e.target.value)}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)}>Cancel</Button>
            <Button onClick={handleExecuteAction} disabled={actionMutation.isPending}>
              {actionMutation.isPending ? "Processing..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Deposit Item Detail                                                */
/* ------------------------------------------------------------------ */

function DepositItemDetail({ itemId }: { itemId: string }) {
  const { data: attempts = [] } = useQuery({
    queryKey: ["deposit-attempts", itemId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_provider_attempts")
        .select("*")
        .eq("deposit_item_id", itemId)
        .order("attempt_number", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: exceptions = [] } = useQuery({
    queryKey: ["deposit-exceptions", itemId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_exceptions")
        .select("*")
        .eq("deposit_item_id", itemId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: auditLog = [] } = useQuery({
    queryKey: ["deposit-audit", itemId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_audit_log")
        .select("*")
        .eq("deposit_item_id", itemId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {/* Provider Attempts */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">Provider Attempts ({attempts.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="max-h-48">
            {attempts.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">No attempts yet</p>
            ) : (
              <div className="divide-y">
                {attempts.map((a: Record<string, unknown>) => (
                  <div key={a.id as string} className="p-3 text-xs space-y-1">
                    <div className="flex justify-between">
                      <span className="font-medium">Attempt #{a.attempt_number as number}</span>
                      <Badge variant="outline" className="text-[10px]">{a.status as string}</Badge>
                    </div>
                    <p className="text-muted-foreground">Key: <code>{(a.idempotency_key as string).slice(0, 12)}</code></p>
                    {a.response_code && <p>Response: {a.response_code as number}</p>}
                    {a.error_message && <p className="text-destructive">{a.error_message as string}</p>}
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Exceptions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs flex items-center gap-1">
            <AlertTriangle className="h-3 w-3 text-destructive" />
            Exceptions ({exceptions.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="max-h-48">
            {exceptions.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">No exceptions</p>
            ) : (
              <div className="divide-y">
                {exceptions.map((e: Record<string, unknown>) => (
                  <div key={e.id as string} className="p-3 text-xs space-y-1">
                    <div className="flex justify-between">
                      <Badge variant="outline" className={`text-[10px] ${(e.severity as string) === "critical" ? "border-destructive text-destructive" : ""}`}>
                        {e.exception_code as string}
                      </Badge>
                      <span className="text-muted-foreground">{format(new Date(e.created_at as string), "MMM d HH:mm")}</span>
                    </div>
                    <p>{e.description as string}</p>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Audit Log */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">Audit Trail ({auditLog.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="max-h-48">
            {auditLog.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">No entries</p>
            ) : (
              <div className="divide-y">
                {auditLog.map((entry: Record<string, unknown>) => (
                  <div key={entry.id as string} className="p-3 text-xs space-y-1">
                    <div className="flex justify-between">
                      <span className="font-medium capitalize">{(entry.action as string).replace(/_/g, " ")}</span>
                      <span className="text-muted-foreground">{format(new Date(entry.created_at as string), "MMM d HH:mm")}</span>
                    </div>
                    {entry.amount && <p className="text-muted-foreground">Amount: ${(entry.amount as number).toLocaleString()}</p>}
                    {entry.notes && <p className="text-muted-foreground">{entry.notes as string}</p>}
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Branch Deposit Manifest                                            */
/* ------------------------------------------------------------------ */

export function BranchDepositManifest() {
  const { data: branchItems = [] } = useQuery({
    queryKey: ["branch-deposit-items"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*")
        .eq("provider", "manual_branch")
        .in("status", ["pending_assignment", "provider_assigned"])
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const total = branchItems.reduce((sum, i) => sum + (i.amount ?? 0), 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Printer className="h-4 w-4" />
            Branch Deposit Manifest
          </CardTitle>
          <span className="font-bold tabular-nums">
            Total: ${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {branchItems.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No checks pending branch deposit</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Check #</TableHead>
                <TableHead>Carrier</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {branchItems.map((item, idx) => (
                <TableRow key={item.id}>
                  <TableCell className="text-xs">{idx + 1}</TableCell>
                  <TableCell className="font-mono text-sm">#{item.check_number || "—"}</TableCell>
                  <TableCell className="text-sm">{item.carrier_name || "—"}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    ${(item.amount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">{item.status.replace(/_/g, " ")}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
