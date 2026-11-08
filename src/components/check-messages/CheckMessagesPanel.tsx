import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Loader2, MessageSquare, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format, formatDistanceToNow } from "date-fns";
import { CheckMessageThread } from "./CheckMessageThread";
import { resolveMessageThreadTitle } from "@/lib/messageThreadTitle";
import { displayCase, displayCaseOrNull } from "@/lib/displayCase";
import { closeThreadParams, MESSAGE_THREAD_PARAM, openThreadParams } from "@/lib/messageThreadRoute";

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
  payee_line: string | null;
  case_id: string | null;
  claims: { claim_number: string | null; policyholder_name: string | null } | null;
  check_payees: { payee_name: string | null; payee_type: string | null }[] | null;
}

function claimFromEmbed(
  claims: CheckSummary["claims"] | CheckSummary["claims"][] | null | undefined,
): { claim_number: string | null; policyholder_name: string | null } | null {
  if (!claims) return null;
  if (Array.isArray(claims)) return claims[0] ?? null;
  return claims;
}

type CaseInsuredNames = Map<string, string | null>;
const EMPTY_CASE_NAMES: CaseInsuredNames = new Map();

// Subject is the insured name, never the payee line (see messageThreadTitle).
function threadTitleForCheck(check: CheckSummary, caseNames: CaseInsuredNames): string | null {
  const claim = claimFromEmbed(check.claims);
  return resolveMessageThreadTitle({
    payees: check.check_payees,
    caseInsuredName: check.case_id ? caseNames.get(check.case_id) : null,
    policyholderName: claim?.policyholder_name,
  });
}


interface CheckMessagesPanelProps {
  onOpenCheck?: (checkId: string) => void;
}

export function CheckMessagesPanel({ onOpenCheck }: CheckMessagesPanelProps = {}) {
  const [search, setSearch] = useState("");
  // The open conversation lives in the URL (?thread=<check id>): it fills the screen, and Back (the
  // button, the browser's, Android's) returns to all messages.
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const selectedId = searchParams.get(MESSAGE_THREAD_PARAM);
  const openThread = useCallback(
    (checkId: string) =>
      setSearchParams((prev) => openThreadParams(prev, checkId), { state: { messageThreadPushed: true } }),
    [setSearchParams],
  );
  const closeThread = useCallback(() => {
    if ((location.state as { messageThreadPushed?: boolean } | null)?.messageThreadPushed) navigate(-1);
    else setSearchParams((prev) => closeThreadParams(prev), { replace: true });
  }, [location.state, navigate, setSearchParams]);

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
    queryKey: ["check-messages-checks", "insured-title", checkIds.sort().join(",")],
    queryFn: async () => {
      if (checkIds.length === 0) return [] as CheckSummary[];
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, check_number, carrier_name, amount, status, payee_line, case_id, claims(claim_number, policyholder_name), check_payees(payee_name, payee_type)")
        .in("id", checkIds);
      if (error) throw error;
      return (data ?? []) as unknown as CheckSummary[];
    },
    enabled: checkIds.length > 0,
  });

  const caseIds = Array.from(
    new Set(checks.map((c) => c.case_id).filter((id): id is string => Boolean(id))),
  ).sort();

  // Insured name from the check's case, for checks whose payees are untyped.
  const { data: caseNames = EMPTY_CASE_NAMES } = useQuery({
    queryKey: ["check-messages-case-insured", caseIds.join(",")],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_cases")
        .select("id, insured_name")
        .in("id", caseIds);
      if (error) throw error;
      const map: CaseInsuredNames = new Map();
      for (const row of (data ?? []) as { id: string; insured_name: string | null }[]) {
        map.set(row.id, row.insured_name);
      }
      return map;
    },
    enabled: caseIds.length > 0,
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
        const threadTitle = threadTitleForCheck(c, caseNames) ?? "";
        const claim = claimFromEmbed(c.claims);
        return (
          (c.check_number ?? "").toLowerCase().includes(q) ||
          (c.carrier_name ?? "").toLowerCase().includes(q) ||
          (c.payee_line ?? "").toLowerCase().includes(q) ||
          threadTitle.toLowerCase().includes(q) ||
          (claim?.policyholder_name ?? "").toLowerCase().includes(q) ||
          (claim?.claim_number ?? "").toLowerCase().includes(q)
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
  }, [mergedRows, checks, caseNames, search]);

  const isLoading = unreadLoading || sharedLoading || checksLoading;
  const selected = selectedId ? rows.find((r) => r.check_id === selectedId) : undefined;

  // While a conversation fills the screen: Escape goes back, and the page behind does not scroll.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeThread();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [selectedId, closeThread]);


  return (
    <div>
      {/* Conversations list */}
      <Card className="bg-card border-border h-[70vh] flex flex-col">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <MessageSquare className="h-4 w-4" /> Conversations
          </CardTitle>
          <div className="relative mt-2">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search check #, insured, payee, carrier, claim…"
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
              const isActive = selectedId === r.check_id;
              const threadTitle = displayCaseOrNull(threadTitleForCheck(c, caseNames));
              const claimNumber = claimFromEmbed(c.claims)?.claim_number;
              return (
                <button
                  key={r.check_id}
                  type="button"
                  onClick={() => openThread(r.check_id)}
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
                        {claimNumber && (
                          <Badge variant="outline" className="text-[9px] h-4 px-1">
                            {claimNumber}
                          </Badge>
                        )}
                      </div>
                      {threadTitle && (
                        <div className="text-[11px] font-medium text-foreground truncate" title={threadTitle}>
                          {threadTitle}
                        </div>
                      )}
                      {c.carrier_name && (
                        <div className="text-[10px] text-muted-foreground truncate">
                          {displayCase(c.carrier_name)}
                        </div>
                      )}

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

      {/* The open conversation fills the screen; Back returns to all messages. */}
      {selectedId &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Conversation"
            className="message-thread-screen fixed inset-0 z-50 flex max-w-none flex-col bg-background text-foreground"
            style={{ paddingTop: "var(--app-safe-top, 0px)", paddingBottom: "var(--app-safe-bottom, 0px)" }}
          >
            <header className="flex items-center gap-2 border-b border-border px-2 py-2 sm:px-4">
              <Button variant="ghost" size="sm" onClick={closeThread} className="gap-1 shrink-0">
                <ArrowLeft className="h-4 w-4" /> All messages
              </Button>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate">
                  {selected?.check
                    ? [
                        `Check #${selected.check.check_number || "—"}`,
                        displayCaseOrNull(threadTitleForCheck(selected.check, caseNames)),
                      ].filter(Boolean).join(" • ")
                    : "Conversation"}
                </div>
                {selected?.check && (
                  <div className="text-[11px] text-muted-foreground truncate">
                    {claimFromEmbed(selected.check.claims)?.claim_number
                      ? `Claim ${claimFromEmbed(selected.check.claims)!.claim_number} • `
                      : ""}
                    {selected.check.amount != null &&
                      `$${Number(selected.check.amount).toLocaleString()} • `}
                    {selected.check.status}
                  </div>
                )}
              </div>
              {selected?.check && onOpenCheck && (
                <button
                  type="button"
                  onClick={() => {
                    const checkId = selected.check_id;
                    setSearchParams((prev) => closeThreadParams(prev), { replace: true });
                    onOpenCheck(checkId);
                  }}
                  className="text-[11px] font-medium text-primary hover:underline whitespace-nowrap shrink-0"
                >
                  Open check file →
                </button>
              )}
            </header>
            <div className="mx-auto flex w-full max-w-4xl min-h-0 flex-1 flex-col p-3">
              {selected?.check ? (
                <CheckMessageThread checkId={selected.check_id} className="flex-1 min-h-0" />
              ) : isLoading ? (
                <div className="flex flex-1 items-center justify-center">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                  This conversation isn&apos;t available.
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
