import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { mortgageSupabase as supabase } from "@/integrations/supabase/mortgageClient";
import { useMortgageAuth } from "@/hooks/useMortgageAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Building2, LogOut, Inbox, CheckCircle2, Loader2, Clock, Eye, BookUser } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { MortgageOpsRequestDetail } from "./MortgageOpsRequestDetail";
import { MortgageOpsDirectory } from "./MortgageOpsDirectory";
import mortgageOpsLogo from "@/assets/mortgage-ops-logo.png";
import { SettingsPageShell } from "@/components/settings/SettingsPageShell";
import { SettingsHero } from "@/components/settings/SettingsHero";
import { useAwsPollingFallback } from "@/hooks/useAwsPollingFallback";

interface Request {
  id: string;
  tenant_id: string;
  check_intake_item_id: string | null;
  claim_id: string | null;
  mortgage_company: string | null;
  mortgage_servicer: string | null;
  loan_number: string | null;
  status: string;
  assigned_employee_id: string | null;
  requested_by: string | null;
  flat_fee_cents: number | null;
  notes: string | null;
  work_notes: string | null;
  created_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  homeowner_name: string | null;
  insurance_company: string | null;
  tenant_name?: string | null;
  check_amount?: number | null;
}

export default function MortgageOpsQueue() {
  const { user, userRole, signOut, loading: authLoading } = useMortgageAuth();
  const navigate = useNavigate();
  const [available, setAvailable] = useState<Request[]>([]);
  const [mine, setMine] = useState<Request[]>([]);
  const [completed, setCompleted] = useState<Request[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      navigate("/mortgage-ops/login", { replace: true });
      return;
    }
    if (userRole !== "mortgage_agent" && userRole !== "admin") {
      navigate("/mortgage-ops/login", { replace: true });
    }
  }, [user, userRole, authLoading, navigate]);

  const fetchQueues = useCallback(async () => {
    const { data, error } = await supabase
      .from("mortgage_handling_requests")
      .select("*, tenants:tenant_id(name), check:check_intake_item_id(amount)")
      .in("status", ["requested", "in_progress", "completed"])
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      toast.error("Failed to load queue");
      setLoading(false);
      return;
    }
    const rows: Request[] = (data || []).map((r: any) => ({
      ...r,
      tenant_name: r.tenants?.name ?? null,
      check_amount: r.check?.amount ?? null,
    }));
    // Queued = every unassigned 'requested' row (accurate global count)
    setAvailable(
      rows
        .filter((r) => r.status === "requested" && !r.assigned_employee_id)
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
    );
    // In progress = only rows I personally accepted. Each request has exactly
    // one handler (assigned_employee_id), so other agents' work should NOT
    // appear in my "In progress" list.
    setMine(
      rows
        .filter((r) => r.status === "in_progress" && r.assigned_employee_id === user?.id)
        .sort((a, b) => new Date(b.accepted_at ?? b.created_at).getTime() - new Date(a.accepted_at ?? a.created_at).getTime()),
    );
    // Completed = only tasks I closed out.
    setCompleted(
      rows
        .filter((r) => r.status === "completed" && r.assigned_employee_id === user?.id)
        .sort((a, b) => new Date(b.completed_at ?? b.created_at).getTime() - new Date(a.completed_at ?? a.created_at).getTime()),
    );

    setLoading(false);
  }, [user?.id]);

  useEffect(() => {
    if (!user) return;
    void fetchQueues();
    const channel = supabase
      .channel("mortgage-ops-queue")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "mortgage_handling_requests" },
        () => void fetchQueues()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, fetchQueues]);

  useAwsPollingFallback(!!user, fetchQueues, 15_000);

  const handleAccept = async (id: string) => {
    setBusyId(id);
    const { error } = await supabase.rpc("accept_mortgage_handling_request", { _request_id: id });
    setBusyId(null);
    if (error) {
      if (error.message.includes("already_taken")) {
        toast.error("Already taken by another agent");
      } else if (error.message.includes("not_authorized")) {
        toast.error("Not authorized");
      } else {
        toast.error(error.message);
      }
      void fetchQueues();
      return;
    }
    toast.success("Task accepted");
    void fetchQueues();
  };

  const handleStatus = async (id: string, status: "completed" | "cancelled") => {
    setBusyId(id);
    const notes = notesById[id]?.trim() || null;
    const { error } = await supabase.rpc("update_mortgage_handling_request_status", {
      _request_id: id,
      _status: status,
      _notes: notes,
    });
    if (error) {
      setBusyId(null);
      toast.error(error.message);
      return;
    }
    setNotesById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

    if (status === "completed") {
      // Notify the tenant thread + homeowner timeline (best-effort, never blocks)
      const row = [...mine, ...available, ...completed].find((r) => r.id === id);
      if (row?.check_intake_item_id) {
        void supabase.from("check_messages").insert({
          check_id: row.check_intake_item_id,
          sender_id: user?.id ?? null,
          body: `✅ ChecksOps Mortgage Desk completed work with ${row.mortgage_company || row.mortgage_servicer || "the mortgage company"}.${notes ? ` Notes: ${notes}` : ""}`,
        } as any);
        void supabase.from("homeowner_ledger_events").insert({
          check_intake_item_id: row.check_intake_item_id,
          claim_id: row.claim_id,
          event_type: "mortgage_update",
          title: "Mortgage company step complete",
          description: "Our mortgage team finished working with your mortgage company on this check.",
        } as any);
      }
      setBusyId(null);
      toast.success("Marked complete");
    } else {
      setBusyId(null);
      toast.success("Cancelled");
    }
    void fetchQueues();
  };


  const handleAppendNote = async (id: string) => {
    const notes = notesById[id]?.trim();
    if (!notes) return;
    setBusyId(id);
    const { error } = await supabase.rpc("update_mortgage_handling_request_status", {
      _request_id: id,
      _status: "in_progress",
      _notes: notes,
    });
    setBusyId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    setNotesById((prev) => ({ ...prev, [id]: "" }));
    toast.success("Note added");
    void fetchQueues();
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/mortgage-ops/login", { replace: true });
  };

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img
              src={mortgageOpsLogo}
              alt="Mortgage Ops"
              className="h-12 sm:h-16 w-auto object-contain select-none"
              draggable={false}
            />
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground hidden sm:inline">{user.email}</span>
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              <LogOut className="h-4 w-4 mr-1" /> Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="px-4">
        <SettingsPageShell className="max-w-6xl">
        <SettingsHero
          title="Mortgage Ops Desk"
          description="Accept queued loss draft tasks, track work in progress, and look up mortgage servicer contacts — all in one place."
          badge="Mortgage Ops"
          icon={<Building2 className="h-4 w-4 text-primary" />}
        />
        <Tabs defaultValue="available">

          <TabsList>
            <TabsTrigger value="available" className="gap-2">
              <Inbox className="h-4 w-4" /> Queued
              <Badge variant="secondary" className="ml-1">{available.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="mine" className="gap-2">
              <Clock className="h-4 w-4" /> In progress
              <Badge variant="secondary" className="ml-1">{mine.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="completed" className="gap-2">
              <CheckCircle2 className="h-4 w-4" /> Completed
              <Badge variant="secondary" className="ml-1">{completed.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="directory" className="gap-2">
              <BookUser className="h-4 w-4" /> Directory
            </TabsTrigger>
          </TabsList>

          <TabsContent value="available" className="mt-4 space-y-3">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : available.length === 0 ? (
              <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
                No pending requests. New tasks appear here in real time.
              </CardContent></Card>
            ) : (
              available.map((r) => (
                <Card
                  key={r.id}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setDetailId(r.id)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <CardTitle className="text-base">
                          {r.mortgage_company || r.mortgage_servicer || "Mortgage company"}
                        </CardTitle>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Tenant: <span className="font-medium">{r.tenant_name || r.tenant_id.slice(0, 8)}</span>
                          {" · "}
                          Requested {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                        </p>
                      </div>
                      <Badge>Requested</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3" onClick={(e) => e.stopPropagation()}>
                    <div className="text-sm grid grid-cols-2 gap-x-3 gap-y-1.5">
                      {r.loan_number && <div><span className="text-muted-foreground">Loan #:</span> {r.loan_number}</div>}
                      {r.check_amount != null && (
                        <div><span className="text-muted-foreground">Check:</span> ${Number(r.check_amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      )}
                      {r.homeowner_name && <div className="truncate"><span className="text-muted-foreground">Homeowner:</span> {r.homeowner_name}</div>}
                      {r.insurance_company && <div className="truncate"><span className="text-muted-foreground">Insurance:</span> {r.insurance_company}</div>}
                    </div>
                    {r.notes && (
                      <p className="text-xs bg-muted/40 rounded p-2 whitespace-pre-wrap">{r.notes}</p>
                    )}
                    <div className="flex gap-2 flex-wrap">
                      <Button
                        onClick={() => handleAccept(r.id)}
                        disabled={busyId === r.id}
                        size="sm"
                      >
                        {busyId === r.id ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                        Accept task
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setDetailId(r.id)}>
                        <Eye className="h-4 w-4 mr-1" /> View details
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="mine" className="mt-4 space-y-3">
            {mine.length === 0 ? (
              <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
                Nothing assigned to you yet.
              </CardContent></Card>
            ) : (
              mine.map((r) => (
                <Card
                  key={r.id}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setDetailId(r.id)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <CardTitle className="text-base">
                          {r.mortgage_company || r.mortgage_servicer || "Mortgage company"}
                        </CardTitle>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Tenant: <span className="font-medium">{r.tenant_name || r.tenant_id.slice(0, 8)}</span>
                          {r.accepted_at && (
                            <> · accepted {formatDistanceToNow(new Date(r.accepted_at), { addSuffix: true })}</>
                          )}
                        </p>
                      </div>
                      <Badge variant="secondary">In progress</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3" onClick={(e) => e.stopPropagation()}>
                    <div className="text-sm grid grid-cols-2 gap-x-3 gap-y-1.5">
                      {r.loan_number && <div><span className="text-muted-foreground">Loan #:</span> {r.loan_number}</div>}
                      {r.check_amount != null && (
                        <div><span className="text-muted-foreground">Check:</span> ${Number(r.check_amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      )}
                      {r.homeowner_name && <div className="truncate"><span className="text-muted-foreground">Homeowner:</span> {r.homeowner_name}</div>}
                      {r.insurance_company && <div className="truncate"><span className="text-muted-foreground">Insurance:</span> {r.insurance_company}</div>}
                    </div>
                    {r.notes && (
                      <p className="text-xs bg-muted/40 rounded p-2 whitespace-pre-wrap">
                        <span className="font-medium text-muted-foreground">Tenant note: </span>{r.notes}
                      </p>
                    )}
                    {r.work_notes && (
                      <div className="text-xs bg-muted/60 rounded p-2 whitespace-pre-wrap max-h-40 overflow-auto">
                        {r.work_notes}
                      </div>
                    )}
                    <Textarea
                      placeholder="Add a work note…"
                      value={notesById[r.id] || ""}
                      onChange={(e) => setNotesById((prev) => ({ ...prev, [r.id]: e.target.value }))}
                      rows={2}
                    />
                    <div className="flex gap-2 flex-wrap">
                      <Button variant="outline" size="sm" onClick={() => setDetailId(r.id)}>
                        <Eye className="h-4 w-4 mr-1" /> View details
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyId === r.id || !(notesById[r.id]?.trim())}
                        onClick={() => handleAppendNote(r.id)}
                      >
                        Add note
                      </Button>
                      <Button
                        size="sm"
                        disabled={busyId === r.id}
                        onClick={() => handleStatus(r.id, "completed")}
                      >
                        <CheckCircle2 className="h-4 w-4 mr-1" /> Mark complete
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === r.id}
                        onClick={() => handleStatus(r.id, "cancelled")}
                      >
                        Cancel
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="completed" className="mt-4 space-y-3">
            {completed.length === 0 ? (
              <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
                No completed tasks yet.
              </CardContent></Card>
            ) : (
              completed.map((r) => (
                <Card
                  key={r.id}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setDetailId(r.id)}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <CardTitle className="text-base">
                          {r.mortgage_company || r.mortgage_servicer || "Mortgage company"}
                        </CardTitle>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Tenant: <span className="font-medium">{r.tenant_name || r.tenant_id.slice(0, 8)}</span>
                          {r.completed_at && (
                            <> · completed {formatDistanceToNow(new Date(r.completed_at), { addSuffix: true })}</>
                          )}
                        </p>
                      </div>
                      <Badge variant="outline" className="gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Completed
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2" onClick={(e) => e.stopPropagation()}>
                    <div className="text-sm grid grid-cols-2 gap-x-3 gap-y-1.5">
                      {r.loan_number && <div><span className="text-muted-foreground">Loan #:</span> {r.loan_number}</div>}
                      {r.check_amount != null && (
                        <div><span className="text-muted-foreground">Check:</span> ${Number(r.check_amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      )}
                      {r.homeowner_name && <div className="truncate"><span className="text-muted-foreground">Homeowner:</span> {r.homeowner_name}</div>}
                      {r.insurance_company && <div className="truncate"><span className="text-muted-foreground">Insurance:</span> {r.insurance_company}</div>}
                    </div>
                    {r.work_notes && (
                      <div className="text-xs bg-muted/60 rounded p-2 whitespace-pre-wrap max-h-32 overflow-auto">
                        {r.work_notes}
                      </div>
                    )}
                    <Button variant="outline" size="sm" onClick={() => setDetailId(r.id)}>
                      <Eye className="h-4 w-4 mr-1" /> View details
                    </Button>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="directory" className="mt-4">
            <MortgageOpsDirectory />
          </TabsContent>
        </Tabs>
        </SettingsPageShell>
      </main>


      <MortgageOpsRequestDetail
        requestId={detailId}
        open={!!detailId}
        onOpenChange={(o) => { if (!o) setDetailId(null); }}
        onAction={fetchQueues}
      />
    </div>
  );
}
