import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { isAwsStaging } from "@/lib/awsStaging";

const invokeCompensation = async (body: Record<string, unknown>) => {
  const { data, error } = await supabase.functions.invoke("mortgage-agent-compensation", { body });
  if (error) throw error;
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as any;
};

const currentPeriod = () => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
};

const dollars = (cents: number) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

type AgentRow = {
  application_user_id: string;
  full_name: string | null;
  email: string | null;
  created_at: string | null;
  account_status: string;
  hired_at: string | null;
  deactivated_at: string | null;
  last_activity_at: string | null;
  queued_count: number;
  in_progress_count: number;
  completed_count: number;
};

type MonthlyRow = {
  agent_user_id: string;
  full_name: string | null;
  email: string | null;
  initial_count: number;
  additional_count: number;
  files_worked: number;
  gross_owed_cents: number;
  paid_cents: number;
  balance_cents: number;
};

type AdjustmentRow = {
  id: string;
  agent_user_id: string;
  amount_cents: number;
  adjustment_reason: string | null;
  status: string;
  pay_period: string;
  earned_at: string;
  created_at?: string;
  kind?: string;
  actor_id?: string | null;
};

type EntryRow = {
  id: string;
  agent_user_id: string;
  full_name: string | null;
  email: string | null;
  mortgage_request_id: string;
  check_intake_item_id: string | null;
  claim_id: string | null;
  tenant_name: string | null;
  homeowner_name: string | null;
  claim_number: string | null;
  mortgage_company: string | null;
  loan_number: string | null;
  classification: string;
  amount_cents: number;
  tenant_billing_event_id: string | null;
  tenant_billing_event_type: string | null;
  tenant_billing_amount_cents: number | null;
  accepted_at: string | null;
  completed_at: string | null;
  earned_at: string;
  pay_period: string;
  status: string;
  payment_date: string | null;
  payment_reference: string | null;
  payment_note: string | null;
  parent_entry_id?: string | null;
  adjustments?: AdjustmentRow[];
};

type InProgressRow = {
  id: string;
  status: string;
  assigned_employee_id: string;
  agent_name: string | null;
  agent_email: string | null;
  accepted_at: string | null;
  homeowner_name: string | null;
  claim_number: string | null;
  claim_id: string | null;
  check_intake_item_id: string | null;
  tenant_name: string | null;
  mortgage_company: string | null;
  loan_number: string | null;
  tenant_billing_event_id: string | null;
  tenant_billing_event_type: string | null;
  tenant_billing_amount_cents: number | null;
};

type AnomalyRow = {
  anomaly_type: string;
  mortgage_request_id: string | null;
  compensation_entry_id: string | null;
  tenant_billing_event_id: string | null;
  detail: Record<string, unknown> | null;
};

export function MortgageAgentsPanel() {
  const [tab, setTab] = useState("roster");
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [period, setPeriod] = useState(currentPeriod());
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [totals, setTotals] = useState({
    initial_count: 0,
    additional_count: 0,
    files_worked: 0,
    gross_owed_cents: 0,
    paid_cents: 0,
    balance_cents: 0,
  });
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalyRow[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [payRef, setPayRef] = useState("");
  const [payNote, setPayNote] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [inProgress, setInProgress] = useState<InProgressRow[]>([]);
  const [returnTarget, setReturnTarget] = useState<InProgressRow | null>(null);
  const [returnReason, setReturnReason] = useState("");
  const [adjustTarget, setAdjustTarget] = useState<EntryRow | null>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustCounterparty, setAdjustCounterparty] = useState("none");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [roster, month, files, recon, work] = await Promise.all([
        invokeCompensation({ action: "roster" }),
        invokeCompensation({ action: "monthly", period }),
        invokeCompensation({
          action: "entries",
          period,
          agent_user_id: agentFilter === "all" ? null : agentFilter,
          status: statusFilter === "all" ? null : statusFilter,
          unpaid: statusFilter === "unpaid",
        }),
        invokeCompensation({ action: "reconciliation", period }),
        invokeCompensation({ action: "in_progress" }),
      ]);
      setAgents(roster.agents || []);
      setMonthly(month.rows || []);
      setTotals(month.totals || totals);
      setEntries(files.entries || []);
      setAnomalies(recon.anomalies || []);
      setInProgress(work.requests || []);
    } catch (error: any) {
      toast.error(error.message || "Failed to load Mortgage Agent compensation");
    } finally {
      setLoading(false);
    }
  }, [period, agentFilter, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const approve = async (ids: string[]) => {
    if (!ids.length) return toast.error("Select entries to approve");
    try {
      const result = await invokeCompensation({ action: "approve", entry_ids: ids });
      toast.success(`Approved ${result.updated || 0} entries`);
      setSelected([]);
      await load();
    } catch (error: any) {
      toast.error(error.message || "Approve failed");
    }
  };

  const markPaid = async (ids: string[]) => {
    if (!ids.length) return toast.error("Select entries to mark paid");
    try {
      const result = await invokeCompensation({
        action: "mark_paid",
        entry_ids: ids,
        payment_date: payDate,
        payment_reference: payRef || null,
        note: payNote || null,
      });
      toast.success(`Marked paid ${result.updated || 0} entries`);
      setSelected([]);
      setPayOpen(false);
      setPayRef("");
      setPayNote("");
      await load();
    } catch (error: any) {
      toast.error(error.message || "Mark paid failed");
    }
  };

  const setStatus = async (agent: AgentRow, status: "active" | "inactive") => {
    try {
      await invokeCompensation({
        action: "set_status",
        agent_user_id: agent.application_user_id,
        status,
        note: status === "inactive" ? "Deactivated from Tenant Management" : null,
      });
      toast.success(status === "inactive" ? "Agent deactivated" : "Agent reactivated");
      await load();
    } catch (error: any) {
      toast.error(error.message || "Status update failed");
    }
  };

  const returnToQueue = async () => {
    if (!returnTarget) return;
    const reason = returnReason.trim();
    if (!reason) return toast.error("A return reason is required");
    try {
      await invokeCompensation({
        action: "return_to_queue",
        request_id: returnTarget.id,
        reason,
      });
      toast.success("Request returned to queue. Tenant billing event retained.");
      setReturnTarget(null);
      setReturnReason("");
      await load();
    } catch (error: any) {
      toast.error(error.message || "Return to Queue failed");
    }
  };

  const submitAdjust = async () => {
    if (!adjustTarget) return;
    const reason = adjustReason.trim();
    const amount = Math.round(Number(adjustAmount) * 100);
    if (!reason) return toast.error("An adjustment reason is required");
    if (!Number.isInteger(amount) || amount === 0) return toast.error("Enter a nonzero dollar amount");
    try {
      await invokeCompensation({
        action: "adjust",
        parent_entry_id: adjustTarget.id,
        amount_cents: amount,
        reason,
        counterparty_agent_id: adjustCounterparty === "none" ? null : adjustCounterparty,
      });
      toast.success("Adjustment recorded. Parent compensation facts were not rewritten.");
      setAdjustTarget(null);
      setAdjustAmount("");
      setAdjustReason("");
      setAdjustCounterparty("none");
      await load();
    } catch (error: any) {
      toast.error(error.message || "Adjust failed");
    }
  };

  const drillAgent = (agentId: string) => {
    setAgentFilter(agentId);
    setTab("files");
  };

  const monthChoices = useMemo(() => {
    const values = new Set<string>([period, currentPeriod()]);
    entries.forEach((entry) => values.add(entry.pay_period));
    return [...values].sort().reverse();
  }, [period, entries]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="w-4 h-4 text-amber-500" />
            Dedicated Mortgage Agents
          </CardTitle>
          <CardDescription>
            Agents keep Cognito + <code>user_roles.mortgage_agent</code> identity. They are not tenant users.
            Deactivation blocks new Accepts and does not unassign work, delete the role, or rewrite compensation.
            Tenant $10/$5 receivables stay on Accept; agent $10/$5 payables are earned only at Complete.
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Label>Month</Label>
          <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-40" />
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="w-56"><SelectValue placeholder="All agents" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.application_user_id} value={agent.application_user_id}>
                  {agent.full_name || agent.email || agent.application_user_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="earned">Earned</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="unpaid">Unpaid</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw className="w-4 h-4 mr-1" /> Refresh</Button>
          <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="w-4 h-4 mr-1" /> Hire Agent</Button>
            </DialogTrigger>
            <HireAgentDialog onDone={() => { setInviteOpen(false); void load(); }} />
          </Dialog>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="roster">Roster</TabsTrigger>
          <TabsTrigger value="in-progress">In progress</TabsTrigger>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="reconciliation">Reconciliation</TabsTrigger>
        </TabsList>

        <TabsContent value="roster" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Agents ({agents.length})</CardTitle></CardHeader>
            <CardContent>
              {loading ? <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin" /></div> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>UUID</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Last activity</TableHead>
                      <TableHead className="text-center">Assigned</TableHead>
                      <TableHead className="text-center">In progress</TableHead>
                      <TableHead className="text-center">Completed</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agents.map((agent) => (
                      <TableRow key={agent.application_user_id}>
                        <TableCell className="font-medium">{agent.full_name || "—"}</TableCell>
                        <TableCell>{agent.email || "—"}</TableCell>
                        <TableCell>
                          <Badge variant={agent.account_status === "active" ? "default" : "secondary"}>
                            {agent.account_status}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{agent.application_user_id}</TableCell>
                        <TableCell className="text-xs">{agent.created_at ? new Date(agent.created_at).toLocaleDateString() : "—"}</TableCell>
                        <TableCell className="text-xs">{agent.last_activity_at ? new Date(agent.last_activity_at).toLocaleString() : "—"}</TableCell>
                        <TableCell className="text-center">{agent.queued_count}</TableCell>
                        <TableCell className="text-center">{agent.in_progress_count}</TableCell>
                        <TableCell className="text-center">{agent.completed_count}</TableCell>
                        <TableCell className="text-right space-x-2">
                          <Button size="sm" variant="outline" onClick={() => drillAgent(agent.application_user_id)}>Files</Button>
                          {agent.account_status === "active" ? (
                            <Button size="sm" variant="ghost" onClick={() => setStatus(agent, "inactive")}>Deactivate</Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => setStatus(agent, "active")}>Reactivate</Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="in-progress" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">In-progress Mortgage Ops work</CardTitle>
              <CardDescription>
                Return unfinished assigned work to the queue. The original tenant $10/$5 billing event is retained.
                The next agent must Accept normally. Return is not available in the Mortgage Agent queue.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin" /></div> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Homeowner</TableHead>
                      <TableHead>Claim</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>Accepted</TableHead>
                      <TableHead>Tenant event</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inProgress.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-sm text-muted-foreground">
                          No unfinished assigned requests.
                        </TableCell>
                      </TableRow>
                    ) : inProgress.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.homeowner_name || "—"}</TableCell>
                        <TableCell>
                          <div>{row.claim_number || "—"}</div>
                          <div className="font-mono text-xs text-muted-foreground">{row.claim_id || "—"}</div>
                        </TableCell>
                        <TableCell>{row.agent_name || row.agent_email || row.assigned_employee_id}</TableCell>
                        <TableCell className="text-xs">{formatWhen(row.accepted_at)}</TableCell>
                        <TableCell className="text-xs">
                          {row.tenant_billing_event_id
                            ? `${row.tenant_billing_event_type || "event"} ${row.tenant_billing_amount_cents === 0 ? "$0 promo" : dollars(row.tenant_billing_amount_cents || 0)}`
                            : "none"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="outline" onClick={() => { setReturnTarget(row); setReturnReason(""); }}>
                            Return to Queue
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="monthly" className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Summary label="Initial $10" value={String(totals.initial_count)} />
            <Summary label="Additional $5" value={String(totals.additional_count)} />
            <Summary label="Files Worked" value={String(totals.files_worked)} />
            <Summary label="Gross Owed" value={dollars(totals.gross_owed_cents)} />
            <Summary label="Paid" value={dollars(totals.paid_cents)} />
            <Summary label="Balance" value={dollars(totals.balance_cents)} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Monthly compensation {period}</CardTitle>
              <CardDescription>Pay period is the UTC month of earned_at / completion. Unused month choices: {monthChoices.join(", ")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Initial $10</TableHead>
                    <TableHead className="text-right">Additional $5</TableHead>
                    <TableHead className="text-right">Files Worked</TableHead>
                    <TableHead className="text-right">Gross Owed</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthly.map((row) => (
                    <TableRow key={row.agent_user_id} className="cursor-pointer" onClick={() => drillAgent(row.agent_user_id)}>
                      <TableCell className="font-medium">{row.full_name || row.email || row.agent_user_id}</TableCell>
                      <TableCell className="text-right">{row.initial_count}</TableCell>
                      <TableCell className="text-right">{row.additional_count}</TableCell>
                      <TableCell className="text-right">{row.files_worked}</TableCell>
                      <TableCell className="text-right">{dollars(row.gross_owed_cents)}</TableCell>
                      <TableCell className="text-right">{dollars(row.paid_cents)}</TableCell>
                      <TableCell className="text-right">{dollars(row.balance_cents)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell className="font-semibold">Totals</TableCell>
                    <TableCell className="text-right font-semibold">{totals.initial_count}</TableCell>
                    <TableCell className="text-right font-semibold">{totals.additional_count}</TableCell>
                    <TableCell className="text-right font-semibold">{totals.files_worked}</TableCell>
                    <TableCell className="text-right font-semibold">{dollars(totals.gross_owed_cents)}</TableCell>
                    <TableCell className="text-right font-semibold">{dollars(totals.paid_cents)}</TableCell>
                    <TableCell className="text-right font-semibold">{dollars(totals.balance_cents)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="files" className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => approve(selected)}>Approve selected</Button>
            <Button size="sm" variant="outline" onClick={() => approve(entries.filter((e) => e.status === "earned").map((e) => e.id))}>Approve month</Button>
            <Button size="sm" onClick={() => setPayOpen(true)}>Mark paid</Button>
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead />
                    <TableHead />
                    <TableHead>Homeowner</TableHead>
                    <TableHead>Claim</TableHead>
                    <TableHead>Class</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Completed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const open = expandedId === entry.id;
                    return (
                      <Fragment key={entry.id}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => setExpandedId(open ? null : entry.id)}
                        >
                          <TableCell onClick={(event) => event.stopPropagation()}>
                            <input type="checkbox" checked={selected.includes(entry.id)} onChange={() => toggle(entry.id)} />
                          </TableCell>
                          <TableCell className="w-8 text-muted-foreground">
                            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </TableCell>
                          <TableCell className="font-medium">{entry.homeowner_name || "—"}</TableCell>
                          <TableCell>
                            <div>{entry.claim_number || "—"}</div>
                            <div className="font-mono text-xs text-muted-foreground">{entry.claim_id || "—"}</div>
                          </TableCell>
                          <TableCell>{formatClassification(entry.classification)}</TableCell>
                          <TableCell className="text-right">{dollars(entry.amount_cents)}</TableCell>
                          <TableCell><Badge variant="outline">{entry.status}</Badge></TableCell>
                          <TableCell className="text-xs">{formatWhen(entry.completed_at)}</TableCell>
                        </TableRow>
                        {open ? (
                          <TableRow>
                            <TableCell colSpan={8}>
                              <EntryDrilldown
                                entry={entry}
                                onAdjust={() => {
                                  setAdjustTarget(entry);
                                  setAdjustAmount("");
                                  setAdjustReason("");
                                  setAdjustCounterparty("none");
                                }}
                              />
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reconciliation" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tenant charge ↔ agent pay</CardTitle>
              <CardDescription>
                Flags only. A legitimate tenant $0 promotional receivable is not treated as an agent-pay amount mismatch.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {anomalies.length === 0 ? (
                <p className="text-sm text-muted-foreground">No anomalies for {period}.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Anomaly</TableHead>
                      <TableHead>Request</TableHead>
                      <TableHead>Compensation</TableHead>
                      <TableHead>Tenant event</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {anomalies.map((row, idx) => (
                      <TableRow key={`${row.anomaly_type}-${row.mortgage_request_id}-${idx}`}>
                        <TableCell>{row.anomaly_type}</TableCell>
                        <TableCell className="font-mono text-xs">{row.mortgage_request_id || "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{row.compensation_entry_id || "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{row.tenant_billing_event_id || "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={!!returnTarget} onOpenChange={(open) => { if (!open) { setReturnTarget(null); setReturnReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Return to Queue</DialogTitle>
            <DialogDescription>
              This clears the current assignee and sets the request back to requested.
              accepted_at is preserved. The original tenant $10/$5 billing event is retained.
              Returning does not create a second tenant charge and does not assign the next agent.
              The next agent must Accept normally.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Reason (required)</Label>
              <Input value={returnReason} onChange={(e) => setReturnReason(e.target.value)} placeholder="Why is this returning to the queue?" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setReturnTarget(null); setReturnReason(""); }}>Cancel</Button>
            <Button onClick={() => void returnToQueue()} disabled={!returnReason.trim()}>
              Confirm return
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!adjustTarget} onOpenChange={(open) => { if (!open) { setAdjustTarget(null); setAdjustReason(""); setAdjustAmount(""); setAdjustCounterparty("none"); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust compensation</DialogTitle>
            <DialogDescription>
              Append-only bookkeeping. The original compensation entry stays unchanged.
              Wrong-agent correction creates a paired negative child for the original agent and a positive child for the replacement agent in one transaction.
              ChecksOps will not move money.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Signed amount (dollars)</Label>
              <Input value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} placeholder="10.00 or -5.00" />
            </div>
            <div>
              <Label>Reason (required)</Label>
              <Input value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)} placeholder="Why is this adjustment needed?" />
            </div>
            <div>
              <Label>Wrong-agent counterparty (optional)</Label>
              <Select value={adjustCounterparty} onValueChange={setAdjustCounterparty}>
                <SelectTrigger><SelectValue placeholder="Same agent" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Same agent (single signed child)</SelectItem>
                  {agents.filter((agent) => agent.application_user_id !== adjustTarget?.agent_user_id).map((agent) => (
                    <SelectItem key={agent.application_user_id} value={agent.application_user_id}>
                      {agent.full_name || agent.email || agent.application_user_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setAdjustTarget(null); setAdjustReason(""); setAdjustAmount(""); setAdjustCounterparty("none"); }}>Cancel</Button>
            <Button onClick={() => void submitAdjust()} disabled={!adjustReason.trim()}>Record adjustment</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record payment</DialogTitle>
            <DialogDescription>Bookkeeping only. ChecksOps will not move money.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Payment date</Label><Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} /></div>
            <div><Label>Reference</Label><Input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="Check / ACH / memo" /></div>
            <div><Label>Note</Label><Input value={payNote} onChange={(e) => setPayNote(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPayOpen(false)}>Cancel</Button>
            <Button onClick={() => markPaid(selected.length ? selected : entries.filter((e) => e.status !== "paid").map((e) => e.id))}>
              Mark paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="py-3"><CardDescription>{label}</CardDescription></CardHeader>
      <CardContent className="pt-0 text-xl font-semibold">{value}</CardContent>
    </Card>
  );
}

function formatWhen(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatClassification(value: string) {
  if (value === "initial") return "Initial";
  if (value === "additional") return "Additional";
  return value || "—";
}

function DrillField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="break-all text-sm">{value || "—"}</div>
    </div>
  );
}

function EntryDrilldown({
  entry,
  onAdjust,
}: {
  entry: EntryRow;
  onAdjust: () => void;
}) {
  const adjustments = entry.adjustments || [];
  return (
    <div className="space-y-4" data-testid="compensation-entry-drilldown">
      <div className="grid gap-3 rounded-md border bg-muted/30 p-3 sm:grid-cols-2 lg:grid-cols-3">
        <DrillField label="Homeowner" value={entry.homeowner_name} />
        <DrillField label="Claim number" value={entry.claim_number} />
        <DrillField label="Claim ID" value={entry.claim_id} />
        <DrillField label="Check ID" value={entry.check_intake_item_id} />
        <DrillField label="Mortgage company" value={entry.mortgage_company} />
        <DrillField label="Accepted date" value={formatWhen(entry.accepted_at)} />
        <DrillField label="Completed date" value={formatWhen(entry.completed_at)} />
        <DrillField label="Classification" value={formatClassification(entry.classification)} />
        <DrillField label="Compensation amount" value={dollars(entry.amount_cents)} />
        <DrillField label="Compensation status" value={entry.status} />
        <DrillField label="Payment date" value={entry.payment_date ? formatWhen(entry.payment_date) : "—"} />
        <DrillField label="Payment reference" value={entry.payment_reference} />
        <DrillField label="Bookkeeping / payment note" value={entry.payment_note} />
        <DrillField label="Agent" value={entry.full_name || entry.email} />
        <DrillField label="Tenant" value={entry.tenant_name} />
        <DrillField
          label="Tenant event"
          value={entry.tenant_billing_event_id
            ? `${entry.tenant_billing_event_type || "event"} ${entry.tenant_billing_amount_cents === 0 ? "$0 promo" : dollars(entry.tenant_billing_amount_cents || 0)}`
            : "none"}
        />
      </div>
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Adjustment history</div>
        <Button size="sm" variant="outline" onClick={onAdjust}>Adjust</Button>
      </div>
      {adjustments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No adjustments. This is the original compensation entry.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Booked</TableHead>
              <TableHead>Actor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {adjustments.map((row) => (
              <TableRow key={row.id} data-testid="compensation-adjustment-row">
                <TableCell><Badge variant="secondary">Adjustment</Badge></TableCell>
                <TableCell className="text-right">{dollars(row.amount_cents)}</TableCell>
                <TableCell>{row.adjustment_reason || "—"}</TableCell>
                <TableCell>{row.status}</TableCell>
                <TableCell className="text-xs">{formatWhen(row.earned_at || row.created_at || null)}</TableCell>
                <TableCell className="font-mono text-xs">{row.actor_id || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function HireAgentDialog({ onDone }: { onDone: () => void }) {
  const passwordlessHire = isAwsStaging();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ email: string; tempPassword: string | null } | null>(null);

  const submit = async () => {
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = fullName.trim();
    if (!cleanName) return toast.error("Enter the agent's name");
    if (!cleanEmail) return toast.error("Enter an email");
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("hire-mortgage-agent", {
        body: passwordlessHire
          ? { full_name: cleanName, email: cleanEmail }
          : { full_name: cleanName, email: cleanEmail, password: password || undefined },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const d = data as { email: string; temp_password: string | null; created: boolean };
      toast.success(d.created ? `Hired ${d.email}` : `Granted mortgage ops access to ${d.email}`);
      setResult({ email: d.email, tempPassword: passwordlessHire ? null : d.temp_password });
      if (passwordlessHire || !d.temp_password) onDone();
    } catch (e: any) {
      toast.error(e.message || "Failed to hire agent");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Hire Mortgage Agent</DialogTitle>
        <DialogDescription>
          Creates dedicated Mortgage Ops identity only. No tenant_users membership.
          {passwordlessHire ? " AWS staging hire is passwordless Cognito EMAIL_OTP. No password is set or returned." : ""}
        </DialogDescription>
      </DialogHeader>
      {result ? (
        <div className="space-y-2 text-sm">
          <p>Hired {result.email}.</p>
          {result.tempPassword ? <p>Temporary password: <code>{result.tempPassword}</code></p> : null}
        </div>
      ) : (
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
          <div><Label>Email</Label><Input value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          {passwordlessHire ? null : (
            <div><Label>Optional password</Label><Input value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          )}
        </div>
      )}
      <DialogFooter>
        {result ? <Button onClick={onDone}>Done</Button> : (
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Hire"}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
