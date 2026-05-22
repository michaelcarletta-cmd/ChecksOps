import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  ArrowRight, Building2, CheckCircle2, AlertTriangle, Clock,
  Send, RefreshCw, Banknote, XCircle, RotateCcw, FileCheck,
  Printer, ArrowDownToLine, Upload, ShieldAlert, Landmark,
  CircleDollarSign, BookCheck, Ban, FileWarning,
} from "lucide-react";

import { format } from "date-fns";
import { CheckImagesViewer } from "@/components/checks/CheckImagesViewer";
import { Eye } from "lucide-react";
import { DisbursementConsole } from "@/components/disbursement/DisbursementConsole";

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
  bank_reference: string | null;
  bank_confirmed_at: string | null;
  deposit_slip_number: string | null;
  variance_amount: number | null;
  variance_reason: string | null;
  return_reason: string | null;
  nsf_flag: boolean | null;
  accounting_synced_at: string | null;
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

interface ProviderConfig {
  provider: string;
  display_name: string;
  is_active: boolean;
  is_stubbed: boolean;
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

/* ------------------------------------------------------------------ */
/*  Main console                                                       */
/* ------------------------------------------------------------------ */

interface DepositOperationsConsoleProps {
  searchQuery?: string;
}

export function DepositOperationsConsole({ searchQuery = "" }: DepositOperationsConsoleProps = {}) {
  const { user } = useAuth();
  const { tenantId } = useTenantFilter();
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
  const [actionBankRef, setActionBankRef] = useState("");
  const [actionSlipNumber, setActionSlipNumber] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Fetch provider configs
  const { data: providerConfigs = [], isError: providerError } = useQuery({
    queryKey: ["deposit-provider-configs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_provider_config")
        .select("*")
        .order("provider");
      if (error) {
        console.error("[DepositOps] Provider config query error:", error.message);
        throw error;
      }
      console.log("[DepositOps] Loaded provider configs:", data?.length, data);
      return (data ?? []) as ProviderConfig[];
    },
    retry: 1,
  });

  const activeProviders = providerConfigs.filter((p) => p.is_active);
  const stubbedProviders = providerConfigs.filter((p) => p.is_stubbed);

  // Fetch deposit items scoped to the active tenant via the related check
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["deposit-items", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*, check_intake_items!inner(tenant_id)")
        .eq("check_intake_items.tenant_id", tenantId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as Array<DepositItem & { check_intake_items?: { tenant_id: string | null } | null }>).map(({ check_intake_items, ...item }) => item);
    },
    enabled: !!tenantId,
  });

  // Fetch approved checks not yet in pipeline
  const existingCheckIds = new Set(items.map((i) => i.check_id));
  const { data: approvedChecks = [] } = useQuery({
    queryKey: ["approved-checks-for-deposit", tenantId, existingCheckIds.size],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, check_number, carrier_name, amount, claim_id, status, reviewed_at")
        .eq("tenant_id", tenantId!)
        .eq("status", "approved_for_deposit")
        .order("reviewed_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as ApprovedCheck[]).filter((c) => !existingCheckIds.has(c.id));
    },
    enabled: !!tenantId && !isLoading,
  });

  // Reconciliation summary derived from tenant-scoped items
  const reconSummary = items.reduce<Record<string, number>>((acc, item) => {
    acc.in_flight_amount += ["pending_assignment", "provider_assigned", "submitted", "processing"].includes(item.status) ? item.amount ?? 0 : 0;
    acc.cleared_amount += item.status === "succeeded" ? item.amount ?? 0 : 0;
    acc.reconciled_amount += item.status === "reconciled" ? item.reconciled_amount ?? item.amount ?? 0 : 0;
    acc.failed_amount += ["failed", "returned"].includes(item.status) ? item.amount ?? 0 : 0;
    acc.succeeded += item.status === "succeeded" ? 1 : 0;
    acc.reconciled += item.status === "reconciled" ? 1 : 0;
    acc.unconfirmed_count += item.bank_confirmed_at ? 0 : 1;
    acc.total_variance += item.variance_amount ?? 0;
    acc.variance_count += item.variance_amount && item.variance_amount !== 0 ? 1 : 0;
    acc.nsf_count += item.nsf_flag ? 1 : 0;
    acc.unsynced_count += item.accounting_synced_at ? 0 : 1;
    return acc;
  }, {
    in_flight_amount: 0,
    cleared_amount: 0,
    reconciled_amount: 0,
    failed_amount: 0,
    succeeded: 0,
    reconciled: 0,
    unconfirmed_count: 0,
    total_variance: 0,
    variance_count: 0,
    nsf_count: 0,
    unsynced_count: 0,
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
      qc.invalidateQueries({ queryKey: ["deposit-attachments"] });
      resetDialog();
    },
    onError: (e: Error) => {
      toast({ title: "Action failed", description: e.message, variant: "destructive" });
    },
  });

  const resetDialog = () => {
    setActionDialog(null);
    setActionNotes("");
    setActionProvider("");
    setActionAmount("");
    setActionBankRef("");
    setActionSlipNumber("");
  };

  const q = (searchQuery ?? "").trim().toLowerCase();
  const baseFiltered = statusFilter === "all" ? items : items.filter((i) => i.status === statusFilter);
  const filteredItems = q
    ? baseFiltered.filter((i) =>
        [i.check_number, i.carrier_name, i.bank_reference, i.deposit_slip_number, i.provider_reference]
          .some((v) => v && v.toString().toLowerCase().includes(q))
      )
    : baseFiltered;

  const handleExecuteAction = () => {
    if (!actionDialog) return;
    const extra: Record<string, unknown> = {};
    if (actionBankRef) extra.bank_reference = actionBankRef;
    if (actionSlipNumber) extra.deposit_slip_number = actionSlipNumber;

    actionMutation.mutate({
      action: actionDialog.action,
      deposit_item_id: actionDialog.itemId,
      check_id: actionDialog.checkId,
      provider: actionProvider || undefined,
      amount: actionAmount ? parseFloat(actionAmount) : undefined,
      notes: actionNotes || undefined,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    });
  };

  const fmtMoney = (n: number | null) =>
    n != null ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—";

  const providerLabel = (p: string | null) => {
    if (!p) return "—";
    const cfg = providerConfigs.find((c) => c.provider === p);
    return cfg?.display_name ?? p;
  };

  return (
    <div className="space-y-4">
      {/* Provider Status Banner */}
      {stubbedProviders.length > 0 && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-3 flex items-center gap-3">
            <ShieldAlert className="h-5 w-5 text-amber-400 shrink-0" />
            <div className="text-xs">
              <span className="font-medium text-amber-400">Provider Status: </span>
              {activeProviders.map((p) => (
                <Badge key={p.provider} variant="outline" className="mr-1 text-[10px] border-emerald-500/50 text-emerald-400">
                  {p.display_name} ✓
                </Badge>
              ))}
              {stubbedProviders.map((p) => (
                <Badge key={p.provider} variant="outline" className="mr-1 text-[10px] border-muted text-muted-foreground">
                  {p.display_name} (not configured)
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        {[
          { label: "In Flight", value: reconSummary?.in_flight_amount, color: "text-amber-400" },
          { label: "Cleared", value: reconSummary?.cleared_amount, color: "text-emerald-400" },
          { label: "Reconciled", value: reconSummary?.reconciled_amount, color: "text-primary" },
          { label: "Failed", value: reconSummary?.failed_amount, color: "text-destructive" },
          { label: "Unconfirmed", value: reconSummary?.unconfirmed_amount, color: "text-orange-400" },
          { label: "Variance", value: reconSummary?.total_variance, color: "text-amber-400" },
          { label: "NSF", value: reconSummary?.nsf_count, color: "text-destructive", isCount: true },
          { label: "Unsynced", value: reconSummary?.unsynced_count, color: "text-muted-foreground", isCount: true },
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
            <div className="max-h-[400px] overflow-y-auto scroll-smooth">
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
                        <div className="flex gap-1">
                          <Button size="sm" onClick={() => setActionDialog({ action: "prepare_deposit", checkId: c.id })}>
                            <ArrowRight className="h-3 w-3 mr-1" />Prepare
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
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
            <div className="flex items-center gap-2">
              
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
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[400px] overflow-y-auto scroll-smooth">
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
                    <TableHead>Bank Ref</TableHead>
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
                          <span className="text-xs">{providerLabel(item.provider)}</span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Badge className={`text-[10px] gap-1 ${sc?.color ?? ""}`}>
                              <Icon className="h-3 w-3" />
                              {sc?.label ?? item.status}
                            </Badge>
                            {item.nsf_flag && <Badge variant="destructive" className="text-[10px]">NSF</Badge>}
                            {item.variance_amount != null && item.variance_amount !== 0 && (
                              <Badge variant="outline" className="text-[10px] border-amber-500/50 text-amber-400">Δ</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs text-muted-foreground">
                            {item.bank_reference || (item.bank_confirmed_at ? "Confirmed" : "—")}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1 flex-wrap">
                            {item.status === "pending_assignment" && (
                              <Button size="sm" variant="outline" className="text-xs h-7"
                                onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "assign_provider", itemId: item.id }); }}>
                                Assign
                              </Button>
                            )}
                            {item.status === "provider_assigned" && (item.provider === "manual_branch" || item.provider === "internal_ready") && (
                              <Button size="sm" variant="outline" className="text-xs h-7"
                                onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "mark_manual_deposit", itemId: item.id }); }}>
                                <Building2 className="h-3 w-3 mr-1" />Deposited
                              </Button>
                            )}
                            {item.status === "provider_assigned" && item.provider !== "manual_branch" && item.provider !== "internal_ready" && (
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
                            {item.status === "succeeded" && !item.bank_confirmed_at && (
                              <Button size="sm" variant="outline" className="text-xs h-7"
                                onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "bank_confirm", itemId: item.id }); }}>
                                <Landmark className="h-3 w-3 mr-1" />Confirm
                              </Button>
                            )}
                            {item.status === "succeeded" && (
                              <>
                                <Button size="sm" variant="outline" className="text-xs h-7"
                                  onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "reconcile", itemId: item.id }); }}>
                                  <FileCheck className="h-3 w-3 mr-1" />Reconcile
                                </Button>
                                <Button size="sm" variant="outline" className="text-xs h-7 border-destructive/50 text-destructive"
                                  onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "record_nsf", itemId: item.id }); }}>
                                  <Ban className="h-3 w-3 mr-1" />NSF
                                </Button>
                              </>
                            )}
                            {(item.status === "succeeded" || item.status === "reconciled") && !item.accounting_synced_at && (
                              <Button size="sm" variant="outline" className="text-xs h-7"
                                onClick={(e) => { e.stopPropagation(); setActionDialog({ action: "sync_accounting", itemId: item.id }); }}>
                                <BookCheck className="h-3 w-3 mr-1" />Sync
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
          </div>
        </CardContent>
      </Card>

      {/* Detail panel for selected item */}
      {selectedItemId && <DepositItemDetail itemId={selectedItemId} onAction={setActionDialog} />}

      {/* Action Dialog */}
      <Dialog open={!!actionDialog} onOpenChange={() => resetDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="capitalize">{actionDialog?.action.replace(/_/g, " ")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {actionDialog?.action === "assign_provider" && (
              <div className="space-y-2">
                <Label className="text-xs">Deposit Route</Label>
                <Select value={actionProvider} onValueChange={setActionProvider}>
                  <SelectTrigger><SelectValue placeholder="Select deposit route" /></SelectTrigger>
                  <SelectContent className="z-[200]" position="popper" sideOffset={4}>
                    {providerError ? (
                      <div className="px-2 py-1.5 text-xs text-destructive">Failed to load providers — check permissions</div>
                    ) : activeProviders.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">No active providers found</div>
                    ) : (
                      activeProviders.map((p) => (
                        <SelectItem key={p.provider} value={p.provider}>
                          {p.display_name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {stubbedProviders.length > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    {stubbedProviders.map((p) => p.display_name).join(", ")} — not configured yet
                  </p>
                )}
              </div>
            )}
            {actionDialog?.action === "mark_manual_deposit" && (
              <div className="space-y-2">
                <Label className="text-xs">Deposit Slip #</Label>
                <Input placeholder="Slip number (optional)" value={actionSlipNumber} onChange={(e) => setActionSlipNumber(e.target.value)} />
              </div>
            )}
            {actionDialog?.action === "bank_confirm" && (
              <div className="space-y-2">
                <Label className="text-xs">Bank Reference / Confirmation #</Label>
                <Input placeholder="Bank reference" value={actionBankRef} onChange={(e) => setActionBankRef(e.target.value)} />
                <Label className="text-xs">Confirmed Amount (leave blank if exact match)</Label>
                <Input type="number" step="0.01" placeholder="Confirmed amount" value={actionAmount} onChange={(e) => setActionAmount(e.target.value)} />
              </div>
            )}
            {(actionDialog?.action === "reconcile" || actionDialog?.action === "record_success") && (
              <div className="space-y-2">
                <Label className="text-xs">Confirmed Amount (leave blank if exact match)</Label>
                <Input type="number" step="0.01" placeholder="Confirmed amount (optional)" value={actionAmount} onChange={(e) => setActionAmount(e.target.value)} />
              </div>
            )}
            <Textarea placeholder="Notes (optional)" value={actionNotes} onChange={(e) => setActionNotes(e.target.value)} rows={2} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => resetDialog()}>Cancel</Button>
            <Button
              onClick={handleExecuteAction}
              disabled={actionMutation.isPending}
              variant={actionDialog?.action === "record_nsf" ? "destructive" : "default"}
            >
              {actionMutation.isPending ? "Processing..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Deposit Item Detail with attachments                               */
/* ------------------------------------------------------------------ */

function DepositItemDetail({
  itemId,
  onAction,
}: {
  itemId: string;
  onAction: (d: { action: string; itemId: string }) => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [imageViewerOpen, setImageViewerOpen] = useState(false);

  const { data: depositItem } = useQuery({
    queryKey: ["deposit-item", itemId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("id, check_id, check_number, carrier_name, amount")
        .eq("id", itemId)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const { data: checkData } = useQuery({
    queryKey: ["deposit-check-source", depositItem?.check_id],
    enabled: !!depositItem?.check_id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, front_image_path, back_image_path, check_number, carrier_name, amount, issue_date, payee_line, routing_number, account_number, funds_type, property_address, payment_classification, payee_address, check_payees(payee_name, payee_type, endorsement_status)")
        .eq("id", depositItem!.check_id!)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const { data: imageUrls } = useQuery({
    queryKey: ["deposit-check-images", checkData?.id],
    enabled: !!checkData?.front_image_path,
    queryFn: async () => {
      const [front, back] = await Promise.all([
        checkData!.front_image_path
          ? supabase.storage.from("check-images").createSignedUrl(checkData!.front_image_path, 3600).then(r => r.data?.signedUrl ?? null)
          : Promise.resolve(null),
        checkData!.back_image_path
          ? supabase.storage.from("check-images").createSignedUrl(checkData!.back_image_path, 3600).then(r => r.data?.signedUrl ?? null)
          : Promise.resolve(null),
      ]);
      return { front, back };
    },
  });

  const { data: attempts = [] } = useQuery({
    queryKey: ["deposit-attempts", itemId],
    queryFn: async () => {
      const { data, error } = await supabase.from("deposit_provider_attempts").select("*").eq("deposit_item_id", itemId).order("attempt_number", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: exceptions = [] } = useQuery({
    queryKey: ["deposit-exceptions", itemId],
    queryFn: async () => {
      const { data, error } = await supabase.from("deposit_exceptions").select("*").eq("deposit_item_id", itemId).order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: auditLog = [] } = useQuery({
    queryKey: ["deposit-audit", itemId],
    queryFn: async () => {
      const { data, error } = await supabase.from("deposit_audit_log").select("*").eq("deposit_item_id", itemId).order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: attachments = [] } = useQuery({
    queryKey: ["deposit-attachments", itemId],
    queryFn: async () => {
      const { data, error } = await supabase.from("deposit_attachments").select("*").eq("deposit_item_id", itemId).order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const handleUpload = async (file: File, type: string) => {
    if (!user) return;
    const path = `${itemId}/${Date.now()}_${file.name}`;
    const { error: upErr } = await supabase.storage.from("deposit-attachments").upload(path, file);
    if (upErr) { toast({ title: "Upload failed", description: upErr.message, variant: "destructive" }); return; }
    const { error: dbErr } = await supabase.from("deposit_attachments").insert({
      deposit_item_id: itemId,
      attachment_type: type,
      file_name: file.name,
      file_path: path,
      file_size: file.size,
      uploaded_by: user.id,
    });
    if (dbErr) { toast({ title: "Save failed", description: dbErr.message, variant: "destructive" }); return; }
    toast({ title: "Uploaded" });
    qc.invalidateQueries({ queryKey: ["deposit-attachments", itemId] });
  };

  const attachmentTypes = [
    { value: "deposit_slip", label: "Deposit Slip", icon: FileCheck },
    { value: "stamped_receipt", label: "Stamped Receipt", icon: CheckCircle2 },
    { value: "bank_confirmation", label: "Bank Confirmation", icon: Landmark },
  ];

  return (
    <div className="space-y-4">
      {/* ── Original Check Info + Image Viewer ───────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              Original Check
            </span>
            {checkData && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setImageViewerOpen(true)}
              >
                <Eye className="h-3 w-3 mr-1" />
                View Check Image
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {!checkData ? (
            <p className="text-xs text-muted-foreground">Loading check details...</p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <div><span className="text-muted-foreground">Check #</span><span className="ml-2 font-mono font-medium">{checkData.check_number ?? "—"}</span></div>
              <div><span className="text-muted-foreground">Amount</span><span className="ml-2 font-medium">{checkData.amount != null ? `$${Number(checkData.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}</span></div>
              <div>
                <span className="text-muted-foreground">{(checkData as any).check_source === "cash_job" ? "Property" : "Carrier"}</span>
                <span className="ml-2">{checkData.carrier_name ?? "—"}</span>
                {(checkData as any).check_source === "cash_job" && (
                  <Badge variant="outline" className="ml-2 text-[9px] border-amber-500/40 text-amber-500">CASH JOB</Badge>
                )}
              </div>
              <div><span className="text-muted-foreground">Issue Date</span><span className="ml-2">{checkData.issue_date ? format(new Date(checkData.issue_date), "MMM d, yyyy") : "—"}</span></div>
              <div className="col-span-2"><span className="text-muted-foreground">Payee Line</span><span className="ml-2">{checkData.payee_line ?? "—"}</span></div>
              {checkData.routing_number && (
                <div><span className="text-muted-foreground">Routing</span><span className="ml-2 font-mono">{checkData.routing_number}</span></div>
              )}
              {checkData.account_number && (
                <div><span className="text-muted-foreground">Account</span><span className="ml-2 font-mono">{checkData.account_number}</span></div>
              )}
              {checkData.funds_type && (
                <div><span className="text-muted-foreground">Funds Type</span><span className="ml-2">{checkData.funds_type}</span></div>
              )}
              {checkData.property_address && (
                <div className="col-span-2"><span className="text-muted-foreground">Property</span><span className="ml-2">{checkData.property_address}</span></div>
              )}
              {checkData.payee_address && (
                <div className="col-span-2"><span className="text-muted-foreground">Payee Address</span><span className="ml-2">{checkData.payee_address}</span></div>
              )}
              {(checkData.check_payees ?? []).length > 0 && (
                <div className="col-span-2 pt-1">
                  <span className="text-muted-foreground">Payees</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {(checkData.check_payees as Array<{ payee_name: string; payee_type: string; endorsement_status: string }>).map((p, i) => (
                      <Badge key={i} variant="outline" className="text-[10px]">
                        {p.payee_name}
                        {p.payee_type === "mortgage_company" && " (Mortgage)"}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Image viewer — full screen lightbox */}
      <CheckImagesViewer
        open={imageViewerOpen}
        frontUrl={imageUrls?.front ?? null}
        backUrl={imageUrls?.back ?? null}
        title={`Check #${checkData?.check_number ?? "—"} — ${checkData?.carrier_name ?? ""}`}
        onClose={() => setImageViewerOpen(false)}
      />

      {/* Disbursement (Actum ACH) */}
      {depositItem && (
        <DisbursementConsole
          depositItemId={depositItem.id}
          checkIntakeItemId={depositItem.check_id ?? undefined}
          checkAmount={Number(depositItem.amount ?? 0)}
          checkNumber={depositItem.check_number ?? undefined}
          carrierName={depositItem.carrier_name ?? undefined}
        />
      )}

      {/* Attachment uploads */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs flex items-center gap-1">
            <Upload className="h-3 w-3" />
            Deposit Attachments ({attachments.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {attachmentTypes.map((at) => {
              const existing = attachments.filter((a) => (a as Record<string, unknown>).attachment_type === at.value);
              return (
                <div key={at.value} className="space-y-1">
                  <Label className="text-[10px] flex items-center gap-1">
                    <at.icon className="h-3 w-3" />
                    {at.label}
                    {existing.length > 0 && <Badge variant="outline" className="text-[9px] ml-1">{existing.length}</Badge>}
                  </Label>
                  <Input
                    type="file"
                    className="h-7 text-[10px]"
                    accept="image/*,.pdf"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(f, at.value);
                      e.target.value = "";
                    }}
                  />
                </div>
              );
            })}
          </div>
          {attachments.length > 0 && (
            <div className="divide-y">
              {attachments.map((a) => {
                const att = a as Record<string, unknown>;
                return (
                  <div key={att.id as string} className="py-1 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[9px]">{(att.attachment_type as string).replace(/_/g, " ")}</Badge>
                      <span className="truncate max-w-[200px]">{att.file_name as string}</span>
                    </div>
                    <span className="text-muted-foreground">{format(new Date(att.created_at as string), "MMM d HH:mm")}</span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

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
                      <p className="text-muted-foreground">Key: <code>{(a.idempotency_key as string)?.slice(0, 12)}</code></p>
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
                      {e.resolved_at && <Badge variant="outline" className="text-[9px] text-emerald-400">Resolved</Badge>}
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
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Branch Deposit Manifest                                            */
/* ------------------------------------------------------------------ */

export function BranchDepositManifest() {
  const { tenantId } = useTenantFilter();

  const { data: branchItems = [] } = useQuery({
    queryKey: ["branch-deposit-items", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deposit_items")
        .select("*, check_intake_items!inner(tenant_id)")
        .eq("check_intake_items.tenant_id", tenantId!)
        .in("provider", ["manual_branch", "internal_ready"])
        .in("status", ["pending_assignment", "provider_assigned"])
        .order("created_at", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as Array<DepositItem & { check_intake_items?: { tenant_id: string | null } | null }>).map(({ check_intake_items, ...item }) => item);
    },
    enabled: !!tenantId,
  });

  const total = branchItems.reduce((sum, i) => sum + (i.amount ?? 0), 0);

  const handlePrint = () => window.print();

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Printer className="h-4 w-4" />
            Branch Deposit Manifest
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="font-bold tabular-nums">
              Total: ${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </span>
            {branchItems.length > 0 && (
              <Button size="sm" variant="outline" className="text-xs h-7" onClick={handlePrint}>
                <Printer className="h-3 w-3 mr-1" />Print
              </Button>
            )}
          </div>
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
                <TableHead>Route</TableHead>
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
                  <TableCell className="text-xs">{item.provider === "internal_ready" ? "Internal" : "Branch"}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    ${(item.amount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">{item.status.replace(/_/g, " ")}</Badge>
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="font-bold">
                <TableCell colSpan={4}>Total ({branchItems.length} items)</TableCell>
                <TableCell className="text-right tabular-nums">${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}</TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
