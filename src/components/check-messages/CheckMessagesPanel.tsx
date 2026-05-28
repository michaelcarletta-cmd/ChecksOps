import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, MessageSquare, Search } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { CheckMessageThread } from "./CheckMessageThread";

interface UnreadRow {
  check_id: string;
  unread_count: number;
  last_message_at: string | null;
}

interface CheckSummary {
  id: string;
  check_number: string | null;
  carrier_name: string | null;
  amount: number | null;
  status: string | null;
  claims: { claim_number: string | null; policyholder_name: string | null } | null;
}

interface CheckMessagesPanelProps {
  onOpenCheck?: (checkId: string) => void;
}

export function CheckMessagesPanel({ onOpenCheck }: CheckMessagesPanelProps = {}) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Internal check_messages — unread + last activity (per current user)
  const { data: unreadRows = [], isLoading: unreadLoading } = useQuery({
    queryKey: ["check-unread-counts"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_check_unread_counts");
      if (error) throw error;
      return (data ?? []) as UnreadRow[];
    },
    refetchInterval: 15000,
  });

  // Shared partner discussion messages — show every check that has any message
  const { data: sharedRows = [], isLoading: sharedLoading } = useQuery({
    queryKey: ["shared-check-message-summaries"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shared_check_messages")
        .select("check_id, created_at")
        .order("created_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      const map = new Map<string, { check_id: string; last_message_at: string }>();
      for (const row of (data ?? []) as { check_id: string; created_at: string }[]) {
        if (!map.has(row.check_id)) {
          map.set(row.check_id, { check_id: row.check_id, last_message_at: row.created_at });
        }
      }
      return Array.from(map.values());
    },
    refetchInterval: 15000,
  });

  // Merge both sources by check_id
  const mergedRows: UnreadRow[] = useMemo(() => {
    const map = new Map<string, UnreadRow>();
    for (const r of unreadRows) {
      map.set(r.check_id, { ...r });
    }
    for (const s of sharedRows) {
      const existing = map.get(s.check_id);
      if (existing) {
        const a = existing.last_message_at ? new Date(existing.last_message_at).getTime() : 0;
        const b = new Date(s.last_message_at).getTime();
        if (b > a) existing.last_message_at = s.last_message_at;
      } else {
        map.set(s.check_id, {
          check_id: s.check_id,
          unread_count: 0,
          last_message_at: s.last_message_at,
        });
      }
    }
    return Array.from(map.values());
  }, [unreadRows, sharedRows]);

  const checkIds = mergedRows.map((r) => r.check_id);

  const { data: checks = [], isLoading: checksLoading } = useQuery({
    queryKey: ["check-messages-checks", checkIds.sort().join(",")],
    queryFn: async () => {
      if (checkIds.length === 0) return [] as CheckSummary[];
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, check_number, carrier_name, amount, status, claims(claim_number, policyholder_name)")
        .in("id", checkIds);
      if (error) throw error;
      return (data ?? []) as unknown as CheckSummary[];
    },
    enabled: checkIds.length > 0,
  });

  const rows = useMemo(() => {
    const checkMap = new Map(checks.map((c) => [c.id, c]));
    return mergedRows
      .map((u) => ({ ...u, check: checkMap.get(u.check_id) }))
      .filter((r) => r.check)
      .filter((r) => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        const c = r.check!;
        return (
          (c.check_number ?? "").toLowerCase().includes(q) ||
          (c.carrier_name ?? "").toLowerCase().includes(q) ||
          (c.claims?.policyholder_name ?? "").toLowerCase().includes(q) ||
          (c.claims?.claim_number ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        // Unread first, then most recent
        if ((b.unread_count > 0 ? 1 : 0) !== (a.unread_count > 0 ? 1 : 0)) {
          return (b.unread_count > 0 ? 1 : 0) - (a.unread_count > 0 ? 1 : 0);
        }
        const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
        const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
        return bt - at;
      });
  }, [mergedRows, checks, search]);

  const isLoading = unreadLoading || sharedLoading || checksLoading;
  const selected = rows.find((r) => r.check_id === selectedId) ?? rows[0];


  return (
    <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-3">
      {/* Conversations list */}
      <Card className="bg-card border-border h-[70vh] flex flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquare className="h-4 w-4" /> Conversations
          </CardTitle>
          <div className="relative mt-2">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search check #, carrier, claim…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-7 text-xs"
            />
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-6 px-3">
              No conversations yet. Open any check and start a discussion.
            </div>
          ) : (
            rows.map((r) => {
              const c = r.check!;
              const isActive = (selected?.check_id ?? "") === r.check_id;
              return (
                <button
                  key={r.check_id}
                  type="button"
                  onClick={() => setSelectedId(r.check_id)}
                  className={`w-full text-left p-2 rounded-md transition-colors border ${
                    isActive
                      ? "bg-primary/10 border-primary/40"
                      : "border-transparent hover:bg-muted/50"
                  }`}


                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-semibold truncate">
                          #{c.check_number || "—"}
                        </span>
                        {c.claims?.claim_number && (
                          <Badge variant="outline" className="text-[9px] h-4 px-1">
                            {c.claims.claim_number}
                          </Badge>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {c.claims?.policyholder_name || c.carrier_name || "Unknown"}
                      </div>
                      {r.last_message_at && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {formatDistanceToNow(new Date(r.last_message_at), { addSuffix: true })}
                        </div>
                      )}
                    </div>
                    {r.unread_count > 0 && (
                      <Badge variant="destructive" className="h-5 min-w-5 text-[10px] px-1.5">
                        {r.unread_count}
                      </Badge>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </CardContent>
      </Card>

      {/* Active thread */}
      <Card className="bg-card border-border h-[70vh] flex flex-col">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-sm">
                {selected?.check
                  ? `Check #${selected.check.check_number || "—"} • ${
                      selected.check.claims?.policyholder_name || selected.check.carrier_name || "Unknown"
                    }`
                  : "Select a conversation"}
              </CardTitle>
              {selected?.check && (
                <div className="text-[11px] text-muted-foreground">
                  {selected.check.claims?.claim_number && `Claim ${selected.check.claims.claim_number} • `}
                  {selected.check.amount != null &&
                    `$${Number(selected.check.amount).toLocaleString()} • `}
                  {selected.check.status}
                </div>
              )}
            </div>
            {selected?.check && onOpenCheck && (
              <button
                type="button"
                onClick={() => onOpenCheck(selected.check_id)}
                className="text-[11px] font-medium text-primary hover:underline whitespace-nowrap"
              >
                Open check file →
              </button>
            )}
          </div>
        </CardHeader>

        <CardContent className="flex-1 p-3 pt-0">
          {selected?.check ? (
            <CheckMessageThread checkId={selected.check_id} />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
              Pick a conversation on the left, or open a check to start one.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
