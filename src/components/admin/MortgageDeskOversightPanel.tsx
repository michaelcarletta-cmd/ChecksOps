/**
 * Tenant Management → Mortgage Desk (SQL 158). Every tenant's Desk requests by status with their age: queued
 * (assign an agent; assigning starts the request), in progress and completed (message the assigned agent: an email
 * and a private note), plus the agent directory with each agent's in-progress count.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, RefreshCw, UserPlus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import type { MortgageDeskFunctionsClient } from "@/lib/mortgageDeskEsign";
import {
  MORTGAGE_DESK_AGENT_NOTE_MAX,
  MORTGAGE_DESK_OVERSIGHT_PAGE,
  assignDeskAgent,
  canAssignDeskRequest,
  canMessageDeskAgent,
  deskAgeIsLate,
  deskAgentNoteError,
  deskNoteEmailLabel,
  deskOversightStatusLabel,
  deskRequestLabel,
  formatDeskAge,
  loadDeskAgentNotes,
  loadDeskAssignableAgents,
  loadDeskOverview,
  messageDeskAgent,
  type MortgageDeskAgentNote,
  type MortgageDeskAssignableAgent,
  type MortgageDeskOverviewRow,
  type MortgageDeskOversightStatus,
} from "@/lib/mortgageDeskOversight";

const client = supabase as unknown as MortgageDeskFunctionsClient;

type ListState = { rows: MortgageDeskOverviewRow[]; total: number; loading: boolean; error: string | null };
const EMPTY: ListState = { rows: [], total: 0, loading: true, error: null };

function useDeskList(status: MortgageDeskOversightStatus) {
  const [state, setState] = useState<ListState>(EMPTY);
  const load = useCallback(async (append = false, offset = 0) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const { data, error } = await loadDeskOverview(client, { status, limit: MORTGAGE_DESK_OVERSIGHT_PAGE, offset });
    setState((s) => (error || !data
      ? { ...s, loading: false, error: error || "Could not load requests" }
      : { rows: append ? [...s.rows, ...data.rows] : data.rows, total: data.total, loading: false, error: null }));
  }, [status]);
  useEffect(() => { void load(); }, [load]);
  return { ...state, reload: () => load(false, 0), more: () => load(true, state.rows.length) };
}

function AgeCell({ row }: { row: MortgageDeskOverviewRow }) {
  const late = deskAgeIsLate(row);
  return (
    <span className={late ? "font-medium text-destructive" : undefined} title={row.status_since ? new Date(row.status_since).toLocaleString() : undefined}>
      {formatDeskAge(row.seconds_in_status)}
    </span>
  );
}

function RequestList({
  title,
  description,
  list,
  agents,
  onAssigned,
  onMessage,
}: {
  title: string;
  description: string;
  list: ReturnType<typeof useDeskList>;
  agents: MortgageDeskAssignableAgent[];
  onAssigned: () => void;
  onMessage: (row: MortgageDeskOverviewRow) => void;
}) {
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const assign = async (row: MortgageDeskOverviewRow) => {
    const agentId = choice[row.request_id];
    if (!agentId) return;
    setBusy(row.request_id);
    const { data, error } = await assignDeskAgent(client, row.request_id, agentId);
    setBusy(null);
    if (error || !data) {
      toast({ title: "Not assigned", description: error || "Try again.", variant: "destructive" });
      return;
    }
    toast({
      title: "Assigned and started",
      description: data.noticeStatus === "sent" ? "The agent was emailed." : "The request is assigned; the notice email was not sent.",
    });
    onAssigned();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">{title} <span className="text-muted-foreground font-normal">({list.total})</span></CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={list.reload} disabled={list.loading} aria-label={`Refresh ${title}`}>
          <RefreshCw className={`h-4 w-4 ${list.loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {list.error ? (
          <p className="text-sm text-destructive">{list.error}</p>
        ) : list.loading && list.rows.length === 0 ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : list.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing here.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Mortgage company / loan</TableHead>
                  <TableHead>Homeowner</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>{list.rows[0]?.status === "completed" ? "Completed" : "Age"}</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.rows.map((row) => (
                  <TableRow key={row.request_id}>
                    <TableCell className="font-medium">{row.tenant_name || "—"}</TableCell>
                    <TableCell>
                      <div>{row.mortgage_company || "—"}</div>
                      {row.loan_number && <div className="text-xs text-muted-foreground">Loan {row.loan_number}</div>}
                    </TableCell>
                    <TableCell>{row.homeowner_name || "—"}</TableCell>
                    <TableCell>{row.assigned_agent_name || (row.assigned_agent_id ? "Agent" : <Badge variant="outline">Unassigned</Badge>)}</TableCell>
                    <TableCell>
                      {row.status === "completed" ? (
                        <span title="Created to completed">
                          {formatDeskAge(row.turnaround_seconds)} turnaround
                          <div className="text-xs text-muted-foreground">{formatDeskAge(row.seconds_in_status)} ago</div>
                        </span>
                      ) : <AgeCell row={row} />}
                    </TableCell>
                    <TableCell>{row.note_count ? row.note_count : "—"}</TableCell>
                    <TableCell className="text-right">
                      {canAssignDeskRequest(row) ? (
                        <div className="flex items-center justify-end gap-2">
                          <Select value={choice[row.request_id] ?? ""} onValueChange={(v) => setChoice((c) => ({ ...c, [row.request_id]: v }))}>
                            <SelectTrigger className="w-44" aria-label="Choose an agent"><SelectValue placeholder="Choose agent" /></SelectTrigger>
                            <SelectContent>
                              {agents.map((a) => (
                                <SelectItem key={a.agent_id} value={a.agent_id}>
                                  {a.agent_name || "Unnamed agent"} ({a.in_progress_count ?? 0} open)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button size="sm" disabled={!choice[row.request_id] || busy === row.request_id} onClick={() => void assign(row)}>
                            {busy === row.request_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4 mr-1" />} Assign
                          </Button>
                        </div>
                      ) : canMessageDeskAgent(row) ? (
                        <Button size="sm" variant="outline" onClick={() => onMessage(row)}>
                          <MessageSquare className="h-4 w-4 mr-1" /> Message agent
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {list.rows.length < list.total && !list.error && (
          <div className="pt-3 flex justify-center">
            <Button variant="outline" size="sm" onClick={list.more} disabled={list.loading}>
              {list.loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Load more ({list.rows.length} of {list.total})
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MessageAgentDialog({ row, onClose, onSent }: { row: MortgageDeskOverviewRow | null; onClose: () => void; onSent: () => void }) {
  const [body, setBody] = useState("");
  const [notes, setNotes] = useState<MortgageDeskAgentNote[] | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setBody("");
    setNotes(null);
    setNotesError(null);
    if (!row) return;
    void loadDeskAgentNotes(client, row.request_id).then(({ data, error }) => {
      if (error) setNotesError(error);
      else setNotes(data ?? []);
    });
  }, [row]);

  const invalid = deskAgentNoteError(body);
  const send = async () => {
    if (!row || invalid) return;
    setSending(true);
    const { data, error } = await messageDeskAgent(client, row.request_id, body);
    setSending(false);
    if (error || !data) {
      toast({ title: "Message not sent", description: error || "Try again.", variant: "destructive" });
      return;
    }
    toast({
      title: "Message saved",
      description: data.emailStatus === "sent" ? "The agent was emailed." : `Saved on the request; ${deskNoteEmailLabel(data.emailStatus).toLowerCase()}.`,
    });
    onSent();
    onClose();
  };

  return (
    <Dialog open={!!row} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Message {row?.assigned_agent_name || "the agent"}</DialogTitle>
          <DialogDescription>
            {row ? deskRequestLabel(row) : ""}. The agent gets it by email and on the request. Only you and the assigned agent can read it; the check thread never shows it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="max-h-48 overflow-y-auto space-y-2">
            {notesError ? (
              <p className="text-xs text-destructive">{notesError}</p>
            ) : notes === null ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : notes.length === 0 ? (
              <p className="text-xs text-muted-foreground">No messages yet.</p>
            ) : notes.map((n) => (
              <div key={n.note_id} className="rounded-md border border-border p-2 text-sm">
                <div className="whitespace-pre-wrap break-words">{n.body}</div>
                <div className="text-[11px] text-muted-foreground mt-1">
                  {new Date(n.created_at).toLocaleString()} · {deskNoteEmailLabel(n.email_status)}
                </div>
              </div>
            ))}
          </div>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={MORTGAGE_DESK_AGENT_NOTE_MAX}
            rows={4}
            placeholder="Write to the assigned agent"
            aria-label="Message to the agent"
          />
          <div className="text-[11px] text-muted-foreground text-right">{body.trim().length} / {MORTGAGE_DESK_AGENT_NOTE_MAX}</div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void send()} disabled={!!invalid || sending}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <MessageSquare className="h-4 w-4 mr-1" />} Send email and note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MortgageDeskOversightPanel() {
  const queued = useDeskList("requested");
  const inProgress = useDeskList("in_progress");
  const completed = useDeskList("completed");
  const [agents, setAgents] = useState<MortgageDeskAssignableAgent[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [messaging, setMessaging] = useState<MortgageDeskOverviewRow | null>(null);

  const loadAgents = useCallback(async () => {
    const { data, error } = await loadDeskAssignableAgents(client);
    if (error) setAgentsError(error);
    else { setAgents(data ?? []); setAgentsError(null); }
  }, []);
  useEffect(() => { void loadAgents(); }, [loadAgents]);

  const afterAssign = () => { queued.reload(); inProgress.reload(); void loadAgents(); };

  return (
    <div className="space-y-4">
      <Tabs defaultValue="queued" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="queued">{deskOversightStatusLabel("requested")} ({queued.total})</TabsTrigger>
          <TabsTrigger value="in_progress">{deskOversightStatusLabel("in_progress")} ({inProgress.total})</TabsTrigger>
          <TabsTrigger value="completed">{deskOversightStatusLabel("completed")} ({completed.total})</TabsTrigger>
          <TabsTrigger value="agents">Agents ({agents.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="queued">
          <RequestList
            title="Queued"
            description="Waiting for an agent, oldest first. Assigning starts the request for that agent and emails them."
            list={queued}
            agents={agents}
            onAssigned={afterAssign}
            onMessage={setMessaging}
          />
        </TabsContent>
        <TabsContent value="in_progress">
          <RequestList
            title="In progress"
            description="Being worked, oldest first. The age is time since the agent started."
            list={inProgress}
            agents={agents}
            onAssigned={afterAssign}
            onMessage={setMessaging}
          />
        </TabsContent>
        <TabsContent value="completed">
          <RequestList
            title="Completed"
            description="Newest first, with the turnaround from request to completion."
            list={completed}
            agents={agents}
            onAssigned={afterAssign}
            onMessage={setMessaging}
          />
        </TabsContent>
        <TabsContent value="agents">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Agents</CardTitle>
              <CardDescription>Active Mortgage Desk agents and how many requests each has in progress.</CardDescription>
            </CardHeader>
            <CardContent>
              {agentsError ? (
                <p className="text-sm text-destructive">{agentsError}</p>
              ) : agents.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active agents.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Agent</TableHead><TableHead className="text-right">In progress</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {agents.map((a) => (
                      <TableRow key={a.agent_id}>
                        <TableCell>{a.agent_name || "Unnamed agent"}</TableCell>
                        <TableCell className="text-right">{a.in_progress_count ?? 0}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <MessageAgentDialog
        row={messaging}
        onClose={() => setMessaging(null)}
        onSent={() => { inProgress.reload(); completed.reload(); }}
      />
    </div>
  );
}
