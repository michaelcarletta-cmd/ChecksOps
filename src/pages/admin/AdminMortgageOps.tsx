import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Plus, RefreshCw, Trash2, Briefcase, ShieldAlert } from "lucide-react";

const ALLOWED_EMAIL = "mcarletta@freedomadj.com";

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
      if (!user || user.email !== ALLOWED_EMAIL) {
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
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const clean = email.trim().toLowerCase();
    if (!clean) return toast.error("Enter an email");
    setSubmitting(true);
    try {
      const { data: profile, error: pErr } = await supabase
        .from("profiles")
        .select("id, email")
        .ilike("email", clean)
        .maybeSingle();
      if (pErr) throw pErr;
      if (!profile) {
        toast.error("No account found with that email. Ask them to sign up first.");
        setSubmitting(false);
        return;
      }
      // Guardrail: block if they also have staff/admin
      const { data: existing } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", profile.id);
      const conflict = (existing || []).some((r: any) => r.role === "staff" || r.role === "admin");
      if (conflict) {
        toast.error("This user has staff/admin role. Remove those first — mortgage_agent must be scoped-only.");
        setSubmitting(false);
        return;
      }
      const already = (existing || []).some((r: any) => r.role === "mortgage_agent");
      if (already) {
        toast.info("User already has mortgage ops access.");
        setSubmitting(false);
        onDone();
        return;
      }
      const { error: insErr } = await supabase
        .from("user_roles")
        .insert({ user_id: profile.id, role: "mortgage_agent" });
      if (insErr) throw insErr;
      toast.success(`Granted mortgage ops access to ${profile.email}`);
      setEmail("");
      onDone();
    } catch (e: any) {
      toast.error(e.message || "Failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Hire Mortgage Ops Agent</DialogTitle>
        <DialogDescription>
          Grants the <code>mortgage_agent</code> role. The user must already have an account. Access is automatically
          scoped to checks/claims with active mortgage handling requests only.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3 py-2">
        <Label htmlFor="agent-email">Email</Label>
        <Input
          id="agent-email"
          type="email"
          placeholder="agent@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={submitting}>
          {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Plus className="w-4 h-4 mr-1" />}
          Grant Access
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
