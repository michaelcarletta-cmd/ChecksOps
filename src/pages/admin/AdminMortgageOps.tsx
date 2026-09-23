import { useEffect, useState, useCallback } from "react";
import { PLATFORM_OWNER_EMAIL, isPlatformOwner } from "@/lib/masterMerchant";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/aws/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Plus, RefreshCw, Trash2, Briefcase, ShieldAlert, KeyRound, Home } from "lucide-react";
import { goToChecksOpsHome } from "@/lib/goToChecksOpsHome";
import { isAwsStaging } from "@/lib/awsStaging";


const ALLOWED_EMAIL = PLATFORM_OWNER_EMAIL;

type AgentRow = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role_id: string;
  active_requests: number;
  in_progress_requests: number;
  completed_requests: number;
};

type RequestRow = {
  id: string;
  status: string;
  mortgage_company: string | null;
  loan_number: string | null;
  created_at: string;
  accepted_at: string | null;
  assigned_employee_id: string | null;
};

export default function AdminMortgageOps() {
  const navigate = useNavigate();
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AgentRow | null>(null);
  const [agentRequests, setAgentRequests] = useState<RequestRow[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !isPlatformOwner(user.email, user.id)) {
        toast.error("Not authorized");
        navigate("/");
        return;
      }
      setAuthorized(true);
      setChecking(false);
    })();
  }, [navigate]);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    const { data: roles, error: rolesErr } = await supabase
      .from("user_roles")
      .select("id, user_id")
      .eq("role", "mortgage_agent");
    if (rolesErr) {
      toast.error("Failed to load agents: " + rolesErr.message);
      setLoading(false);
      return;
    }
    // Only surface users with the mortgage_agent role. Admins who accepted a
    // request without the role would otherwise appear as duplicate "personnel"
    // rows alongside their real agent account.
    const userIds = (roles || []).map((r) => r.user_id);
    if (userIds.length === 0) {
      setAgents([]);
      setLoading(false);
      return;
    }
    const [{ data: profiles }, { data: reqs }] = await Promise.all([
      supabase.from("profiles").select("id, email, full_name").in("id", userIds),
      supabase
        .from("mortgage_handling_requests")
        .select("assigned_employee_id, status")
        .in("assigned_employee_id", userIds),
    ]);
    const profMap = new Map((profiles || []).map((p: any) => [p.id, p]));
    const counts = new Map<string, { active: number; in_progress: number; completed: number }>();
    (reqs || []).forEach((r: any) => {
      if (!r.assigned_employee_id) return;
      const c = counts.get(r.assigned_employee_id) || { active: 0, in_progress: 0, completed: 0 };
      if (r.status === "requested") c.active += 1;
      if (r.status === "in_progress") c.in_progress += 1;
      if (r.status === "completed") c.completed += 1;
      counts.set(r.assigned_employee_id, c);
    });
    const rows: AgentRow[] = (roles || []).map((r) => {
      const p: any = profMap.get(r.user_id);
      const c = counts.get(r.user_id) || { active: 0, in_progress: 0, completed: 0 };
      return {
        user_id: r.user_id,
        role_id: r.id,
        email: p?.email ?? null,
        full_name: p?.full_name ?? null,
        active_requests: c.active,
        in_progress_requests: c.in_progress,
        completed_requests: c.completed,
      };
    });
    rows.sort((a, b) => (a.full_name || a.email || "").localeCompare(b.full_name || b.email || ""));
    setAgents(rows);
    setLoading(false);
  }, []);



  useEffect(() => {
    if (authorized) loadAgents();
  }, [authorized, loadAgents]);

  const openAgent = async (agent: AgentRow) => {
    setSelectedAgent(agent);
    setRequestsLoading(true);
    const { data, error } = await supabase
      .from("mortgage_handling_requests")
      .select("id, status, mortgage_company, loan_number, created_at, accepted_at, assigned_employee_id")
      .or(`assigned_employee_id.eq.${agent.user_id},status.in.(requested,in_progress)`)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) toast.error(error.message);
    setAgentRequests((data as RequestRow[]) || []);
    setRequestsLoading(false);
  };

  const removeAgent = async (agent: AgentRow) => {
    if (!confirm(`Revoke mortgage ops access for ${agent.email || agent.user_id}?`)) return;
    const { error } = await supabase.from("user_roles").delete().eq("id", agent.role_id);
    if (error) return toast.error(error.message);
    toast.success("Access revoked");
    setSelectedAgent(null);
    loadAgents();
  };

  const sendPasswordReset = async (agent: AgentRow) => {
    if (!agent.email) return toast.error("No email on file for this agent");
    if (isAwsStaging()) {
      const { error } = await supabase.auth.resetPasswordForEmail(agent.email);
      if (error) return toast.error(error.message);
      toast.success(
        `AWS staging: Cognito reset requested for ${agent.email} (Tester mailbox delivery rules apply).`,
      );
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(agent.email, {
      redirectTo: `${window.location.origin}/mortgage-ops/login`,
    });
    if (error) return toast.error(error.message);
    toast.success(`Password reset email sent to ${agent.email}`);
  };

  const unassignRequest = async (req: RequestRow) => {
    const { error } = await supabase
      .from("mortgage_handling_requests")
      .update({ assigned_employee_id: null, status: "requested", accepted_at: null })
      .eq("id", req.id);
    if (error) return toast.error(error.message);
    toast.success("Unassigned — back in queue");
    if (selectedAgent) openAgent(selectedAgent);
    loadAgents();
  };

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }
  if (!authorized) return null;

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-card">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate("/admin/tenants")}>
              <ArrowLeft className="w-4 h-4 mr-1" /> Back
            </Button>
            <Button variant="ghost" size="sm" onClick={() => goToChecksOpsHome(navigate)}>
              <Home className="w-4 h-4 mr-1" /> Home
            </Button>

            <Briefcase className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-xl font-semibold">Mortgage Ops Management</h1>
              <p className="text-xs text-muted-foreground">Hire personnel and manage per-request access</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={loadAgents}>
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh
            </Button>
            <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
              <DialogTrigger asChild>
                <Button size="sm"><Plus className="w-4 h-4 mr-1" /> Hire Agent</Button>
              </DialogTrigger>
              <HireAgentDialog
                onDone={() => { setInviteOpen(false); loadAgents(); }}
              />
            </Dialog>
          </div>
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="w-4 h-4 text-amber-500" />
              How access works
            </CardTitle>
            <CardDescription>
              Mortgage ops agents can only view checks and claims that have an <strong>active</strong> mortgage handling
              request (requested or in progress). Access is automatically revoked when a request is marked completed or
              cancelled. Agents cannot also hold <code>staff</code> or <code>admin</code> roles.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Active Mortgage Ops Personnel ({agents.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : agents.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No mortgage ops agents yet. Click "Hire Agent" to grant access.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="text-center">Queued</TableHead>
                    <TableHead className="text-center">In Progress</TableHead>
                    <TableHead className="text-center">Completed</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((a) => (
                    <TableRow key={a.user_id}>
                      <TableCell className="font-medium">{a.full_name || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{a.email || a.user_id}</TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline">{a.active_requests}</Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge>{a.in_progress_requests}</Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary">{a.completed_requests}</Badge>
                      </TableCell>
                      <TableCell className="text-right space-x-2">
                        <Button size="sm" variant="outline" onClick={() => openAgent(a)}>Manage</Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => sendPasswordReset(a)}
                          title="Send password reset email"
                        >
                          <KeyRound className="w-4 h-4" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => removeAgent(a)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!selectedAgent} onOpenChange={(o) => !o && setSelectedAgent(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{selectedAgent?.full_name || selectedAgent?.email}</DialogTitle>
            <DialogDescription>
              Requests assigned to this agent (plus open queue items they can see).
            </DialogDescription>
          </DialogHeader>
          {requestsLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : agentRequests.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No requests visible to this agent.</div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mortgage Co.</TableHead>
                    <TableHead>Loan #</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Assigned</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agentRequests.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.mortgage_company || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{r.loan_number || "—"}</TableCell>
                      <TableCell><Badge variant="outline">{r.status}</Badge></TableCell>
                      <TableCell>
                        {r.assigned_employee_id === selectedAgent?.user_id ? (
                          <Badge>Assigned</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">Queue-visible</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.assigned_employee_id === selectedAgent?.user_id && r.status !== "completed" && (
                          <Button size="sm" variant="outline" onClick={() => unassignRequest(r)}>
                            Unassign
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <DialogFooter>
            <Button variant="destructive" onClick={() => selectedAgent && removeAgent(selectedAgent)}>
              <Trash2 className="w-4 h-4 mr-1" /> Revoke Access
            </Button>
            <Button variant="ghost" onClick={() => setSelectedAgent(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
        body: { full_name: cleanName, email: cleanEmail, password: password || undefined },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      const d = data as { email: string; temp_password: string | null; created: boolean };
      toast.success(
        d.created
          ? `Hired ${d.email} — mortgage ops only access granted`
          : `Granted mortgage ops access to ${d.email}`
      );
      setResult({ email: d.email, tempPassword: d.temp_password });
      setFullName("");
      setEmail("");
      setPassword("");
      // Keep dialog open if a temp password was generated so admin can copy it
      if (!d.temp_password) onDone();
    } catch (e: any) {
      toast.error(e.message || "Failed to hire agent");
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    setResult(null);
    onDone();
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Hire Mortgage Ops Agent</DialogTitle>
        <DialogDescription>
          Creates a <strong>mortgage-ops-only</strong> account. This user will <em>only</em> see checks and claims
          tied to active mortgage handling requests — they cannot access the rest of the platform.
        </DialogDescription>
      </DialogHeader>

      {result?.tempPassword ? (
        <div className="space-y-3 py-2">
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <p className="font-medium mb-2">Account created. Share these credentials securely:</p>
            <div className="font-mono text-xs space-y-1">
              <div><span className="text-muted-foreground">Email:</span> {result.email}</div>
              <div><span className="text-muted-foreground">Temp password:</span> {result.tempPassword}</div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              This password won't be shown again. Have the agent change it after first login.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                navigator.clipboard.writeText(
                  `Email: ${result.email}\nPassword: ${result.tempPassword}`
                ).then(() => toast.success("Copied"))
              }
            >
              Copy credentials
            </Button>
            <Button onClick={close}>Done</Button>
          </DialogFooter>
        </div>
      ) : (
        <>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="agent-name">Full name</Label>
              <Input
                id="agent-name"
                placeholder="Jane Smith"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="agent-email">Email</Label>
              <Input
                id="agent-email"
                type="email"
                placeholder="agent@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="agent-pass">Temporary password (optional)</Label>
              <Input
                id="agent-pass"
                type="text"
                placeholder="Leave blank to auto-generate"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Minimum 8 characters. If blank, one will be generated and shown to you once.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plus className="w-4 h-4 mr-1" />}
              Hire Agent
            </Button>
          </DialogFooter>
        </>
      )}
    </DialogContent>
  );
}
