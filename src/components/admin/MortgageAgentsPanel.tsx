import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Loader2, Plus, RefreshCw, ShieldAlert } from "lucide-react";
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
  mortgage_company: string | null;
  loan_number: string | null;
  claim_number: string | null;
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
  const [inviteOpen, setInviteOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [payRef, setPayRef] = useState("");
  const [payNote, setPayNote] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [roster, month, files, recon] = await Promise.all([
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
      ]);
      setAgents(roster.agents || []);
      setMonthly(month.rows || []);
      setTotals(month.totals || totals);
      setEntries(files.entries || []);
      setAnomalies(recon.anomalies || []);
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

        <TabsContent value="monthly" className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Summary label="Initial ($10)" value={String(totals.initial_count)} />
            <Summary label="Additional ($5)" value={String(totals.additional_count)} />
            <Summary label="Files worked" value={String(totals.files_worked)} />
            <Summary label="Gross owed" value={dollars(totals.gross_owed_cents)} />
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
                    <TableHead className="text-right">Initial ($10)</TableHead>
                    <TableHead className="text-right">Additional ($5)</TableHead>
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
                    <TableHead>Agent</TableHead>
                    <TableHead>Tenant</TableHead>
                    <TableHead>Homeowner</TableHead>
                    <TableHead>Claim</TableHead>
                    <TableHead>Check</TableHead>
                    <TableHead>Loan / company</TableHead>
                    <TableHead>Class</TableHead>
                    <TableHead className="text-right">Agent $</TableHead>
                    <TableHead>Tenant event</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Accepted</TableHead>
                    <TableHead>Completed</TableHead>
                    <TableHead>Paid</TableHead>
                    <TableHead>Payment ref</TableHead>
                    <TableHead>Payment note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>
                        <input type="checkbox" checked={selected.includes(entry.id)} onChange={() => toggle(entry.id)} />
                      </TableCell>
                      <TableCell>{entry.full_name || entry.email}</TableCell>
                      <TableCell>{entry.tenant_name || "—"}</TableCell>
                      <TableCell>{entry.homeowner_name || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.claim_number || entry.claim_id || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.check_intake_item_id || "—"}</TableCell>
                      <TableCell>{entry.loan_number || "—"} / {entry.mortgage_company || "—"}</TableCell>
                      <TableCell>{entry.classification}</TableCell>
                      <TableCell className="text-right">{dollars(entry.amount_cents)}</TableCell>
                      <TableCell className="text-xs">
                        {entry.tenant_billing_event_id
                          ? `${entry.tenant_billing_event_type || "event"} ${entry.tenant_billing_amount_cents === 0 ? "$0 promo" : dollars(entry.tenant_billing_amount_cents || 0)}`
                          : "none"}
                      </TableCell>
                      <TableCell><Badge variant="outline">{entry.status}</Badge></TableCell>
                      <TableCell className="text-xs">{entry.accepted_at ? new Date(entry.accepted_at).toLocaleString() : "—"}</TableCell>
                      <TableCell className="text-xs">{entry.completed_at ? new Date(entry.completed_at).toLocaleString() : "—"}</TableCell>
                      <TableCell className="text-xs">{entry.payment_date || "—"}</TableCell>
                      <TableCell className="text-xs">{entry.payment_reference || "—"}</TableCell>
                      <TableCell className="text-xs">{entry.payment_note || "—"}</TableCell>
                    </TableRow>
                  ))}
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

function HireAgentDialog({ onDone }: { onDone: () => void }) {
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
        body: {
          full_name: cleanName,
          email: cleanEmail,
          ...(isAwsStaging() || !password ? {} : { password }),
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const d = data as { email: string; temp_password: string | null; created: boolean };
      toast.success(d.created ? `Hired ${d.email}` : `Granted mortgage ops access to ${d.email}`);
      setResult({ email: d.email, tempPassword: d.temp_password });
      if (!d.temp_password) onDone();
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
          {isAwsStaging() ? " AWS staging uses Cognito + identity_accounts." : ""}
        </DialogDescription>
      </DialogHeader>
      {result ? (
        <div className="space-y-2 text-sm">
          <p>Hired {result.email}.</p>
          {result.tempPassword && !isAwsStaging() ? <p>Temporary password: <code>{result.tempPassword}</code></p> : null}
        </div>
      ) : (
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={fullName} onChange={(e) => setFullName(e.target.value)} /></div>
          <div><Label>Email</Label><Input value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          {!isAwsStaging() && (
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
