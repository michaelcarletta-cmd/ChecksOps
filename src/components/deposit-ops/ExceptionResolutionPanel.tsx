import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, CheckCircle2, RotateCcw, Shield } from "lucide-react";
import { format } from "date-fns";

interface DepositException {
  id: string;
  deposit_item_id: string;
  exception_type: string;
  exception_code: string;
  description: string;
  severity: string;
  provider: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_notes: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  owner_id: string | null;
  created_at: string;
}

export function ExceptionResolutionPanel() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [actionDialog, setActionDialog] = useState<{ id: string; action: "resolve" | "reopen" } | null>(null);
  const [notes, setNotes] = useState("");
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");

  const { data: exceptions = [], isLoading } = useQuery({
    queryKey: ["all-deposit-exceptions", filter],
    queryFn: async () => {
      let query = supabase
        .from("deposit_exceptions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (filter === "open") query = query.is("resolved_at", null);
      if (filter === "resolved") query = query.not("resolved_at", "is", null);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as DepositException[];
    },
  });

  const mutation = useMutation({
    mutationFn: async (params: { id: string; action: string; notes: string }) => {
      const { data, error } = await supabase.rpc("resolve_deposit_exception", {
        p_exception_id: params.id,
        p_actor_id: user!.id,
        p_resolution_notes: params.notes,
        p_action: params.action,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast({ title: "Exception updated" });
      qc.invalidateQueries({ queryKey: ["all-deposit-exceptions"] });
      qc.invalidateQueries({ queryKey: ["deposit-exceptions"] });
      qc.invalidateQueries({ queryKey: ["deposit-aging-summary"] });
      qc.invalidateQueries({ queryKey: ["unresolved-deposit-exceptions"] });
      setActionDialog(null);
      setNotes("");
    },
    onError: (e: Error) => {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const severityColor = (s: string) =>
    s === "critical" ? "text-destructive border-destructive" : "text-amber-400 border-amber-500/50";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Shield className="h-4 w-4 text-destructive" />
              Exception Resolution Queue
            </CardTitle>
            <div className="flex gap-1">
              {(["open", "resolved", "all"] as const).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  variant={filter === f ? "default" : "outline"}
                  className="text-xs h-7"
                  onClick={() => setFilter(f)}
                >
                  {f === "open" ? "Open" : f === "resolved" ? "Resolved" : "All"}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[400px] overflow-y-auto scroll-smooth">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading...</div>
            ) : exceptions.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                {filter === "open" ? "No open exceptions 🎉" : "No exceptions found"}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exceptions.map((ex) => (
                    <TableRow key={ex.id}>
                      <TableCell>
                        <Badge variant="outline" className={`text-[10px] ${severityColor(ex.severity)}`}>
                          {ex.exception_code}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{ex.exception_type.replace(/_/g, " ")}</TableCell>
                      <TableCell className="text-xs max-w-[250px] truncate">{ex.description}</TableCell>
                      <TableCell>
                        <Badge variant={ex.severity === "critical" ? "destructive" : "outline"} className="text-[10px]">
                          {ex.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {format(new Date(ex.created_at), "MMM d HH:mm")}
                      </TableCell>
                      <TableCell>
                        {ex.resolved_at ? (
                          <div className="space-y-0.5">
                            <Badge variant="outline" className="text-[9px] text-emerald-400 border-emerald-500/50">
                              <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />Resolved
                            </Badge>
                            {ex.resolution_notes && (
                              <p className="text-[10px] text-muted-foreground truncate max-w-[120px]">{ex.resolution_notes}</p>
                            )}
                          </div>
                        ) : (
                          <Badge variant="outline" className="text-[9px] text-destructive border-destructive/50">Open</Badge>
                        )}
                        {ex.reopened_at && (
                          <p className="text-[9px] text-amber-400 mt-0.5">
                            Reopened {format(new Date(ex.reopened_at), "MMM d")}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {!ex.resolved_at ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs h-7"
                            onClick={() => { setActionDialog({ id: ex.id, action: "resolve" }); setNotes(""); }}
                          >
                            <CheckCircle2 className="h-3 w-3 mr-1" />Resolve
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs h-7 border-amber-500/50 text-amber-400"
                            onClick={() => { setActionDialog({ id: ex.id, action: "reopen" }); setNotes(""); }}
                          >
                            <RotateCcw className="h-3 w-3 mr-1" />Reopen
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!actionDialog} onOpenChange={() => { setActionDialog(null); setNotes(""); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="capitalize">
              {actionDialog?.action === "resolve" ? "Resolve Exception" : "Reopen Exception"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              placeholder={actionDialog?.action === "resolve" ? "Resolution notes (required)" : "Reopen reason (required)"}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActionDialog(null); setNotes(""); }}>Cancel</Button>
            <Button
              onClick={() => actionDialog && mutation.mutate({ id: actionDialog.id, action: actionDialog.action, notes })}
              disabled={mutation.isPending || !notes.trim()}
            >
              {mutation.isPending ? "Processing..." : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
