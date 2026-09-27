import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Send, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { displayCheckMessageBody } from "@/lib/mortgageDeskReturn";

interface Props {
  checkId: string;
  /** When true, polls every 15s. Set false when offscreen. */
  active?: boolean;
  className?: string;
}

interface InternalMsg {
  id: string;
  check_id: string;
  sender_id: string;
  body: string;
  is_deleted: boolean;
  created_at: string;
}

interface SharedMsg {
  id: string;
  check_id: string;
  sender_user_id: string;
  sender_tenant_id: string | null;
  body: string;
  created_at: string;
}

interface MergedMsg {
  id: string;
  source: "internal" | "shared";
  sender_id: string;
  sender_tenant_id: string | null;
  body: string;
  created_at: string;
}

export function CheckMessageThread({ checkId, active = true, className }: Props) {
  const { user } = useAuth();
  const { tenantId } = useTenantFilter();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: internal = [], isLoading: internalLoading } = useQuery({
    queryKey: ["check-messages", checkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_messages")
        .select("id, check_id, sender_id, body, is_deleted, created_at")
        .eq("check_id", checkId)
        .eq("is_deleted", false)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as InternalMsg[];
    },
    refetchInterval: active ? 15000 : false,
  });

  const { data: shared = [], isLoading: sharedLoading } = useQuery({
    queryKey: ["shared-check-messages", checkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shared_check_messages")
        .select("id, check_id, sender_user_id, sender_tenant_id, body, created_at")
        .eq("check_id", checkId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SharedMsg[];
    },
    refetchInterval: active ? 15000 : false,
  });

  const messages: MergedMsg[] = useMemo(() => {
    const a: MergedMsg[] = internal.map((m) => ({
      id: `i-${m.id}`,
      source: "internal",
      sender_id: m.sender_id,
      sender_tenant_id: null,
      body: m.body,
      created_at: m.created_at,
    }));
    const b: MergedMsg[] = shared.map((m) => ({
      id: `s-${m.id}`,
      source: "shared",
      sender_id: m.sender_user_id,
      sender_tenant_id: m.sender_tenant_id,
      body: m.body,
      created_at: m.created_at,
    }));
    return [...a, ...b].sort(
      (x, y) => new Date(x.created_at).getTime() - new Date(y.created_at).getTime(),
    );
  }, [internal, shared]);

  const isLoading = internalLoading || sharedLoading;
  const preferShared = shared.length > 0 && internal.length === 0;

  // Map sender_id -> profile (best-effort)
  const senderIds = Array.from(new Set(messages.map((m) => m.sender_id)));
  const { data: profiles = {} } = useQuery({
    queryKey: ["check-message-profiles", senderIds.sort().join(",")],
    queryFn: async () => {
      if (senderIds.length === 0) return {} as Record<string, { name: string | null; email: string | null }>;
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", senderIds);
      const map: Record<string, { name: string | null; email: string | null }> = {};
      (data ?? []).forEach((p: any) => {
        map[p.id] = { name: p.full_name ?? null, email: p.email ?? null };
      });
      return map;
    },
    enabled: senderIds.length > 0,
  });

  const tenantIds = Array.from(new Set(messages.map((m) => m.sender_tenant_id).filter(Boolean) as string[]));
  const { data: tenants = {} } = useQuery({
    queryKey: ["check-message-tenants", tenantIds.sort().join(",")],
    queryFn: async () => {
      if (tenantIds.length === 0) return {} as Record<string, string>;
      const { data } = await supabase.from("tenants").select("id, name").in("id", tenantIds);
      const map: Record<string, string> = {};
      (data ?? []).forEach((t: any) => {
        map[t.id] = t.name;
      });
      return map;
    },
    enabled: tenantIds.length > 0,
  });

  // Mark thread as read whenever messages load/change
  useEffect(() => {
    if (!user?.id || messages.length === 0) return;
    supabase
      .from("check_message_reads")
      .upsert(
        { user_id: user.id, check_id: checkId, last_read_at: new Date().toISOString() },
        { onConflict: "user_id,check_id" },
      )
      .then(() => {
        qc.invalidateQueries({ queryKey: ["check-unread-counts"] });
        qc.invalidateQueries({ queryKey: ["check-unread-total"] });
      });
  }, [messages.length, user?.id, checkId, qc]);

  // Auto scroll to bottom on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const sendMutation = useMutation({
    mutationFn: async (body: string) => {
      if (!user?.id) throw new Error("Not authenticated");
      const trimmed = body.trim();
      if (!trimmed) throw new Error("Message is empty");
      if (trimmed.length > 5000) throw new Error("Message too long");
      // If the existing conversation is in the shared/partner thread, post there
      // so replies stay in the same thread the user is reading.
      if (preferShared && tenantId) {
        const { error } = await supabase.from("shared_check_messages").insert({
          check_id: checkId,
          sender_user_id: user.id,
          sender_tenant_id: tenantId,
          body: trimmed,
        });
        if (error) throw error;
        return "shared" as const;
      }
      const { error } = await supabase.from("check_messages").insert({
        check_id: checkId,
        sender_id: user.id,
        body: trimmed,
      });
      if (error) throw error;
      return "internal" as const;
    },
    onSuccess: (kind) => {
      setDraft("");
      if (kind === "shared") {
        qc.invalidateQueries({ queryKey: ["shared-check-messages", checkId] });
        qc.invalidateQueries({ queryKey: ["shared-check-message-summaries"] });
      } else {
        qc.invalidateQueries({ queryKey: ["check-messages", checkId] });
        qc.invalidateQueries({ queryKey: ["check-unread-counts"] });
      }
    },
    onError: (e: any) => toast({ title: "Couldn't send message", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (mergedId: string) => {
      if (mergedId.startsWith("i-")) {
        const realId = mergedId.slice(2);
        const { error } = await supabase
          .from("check_messages")
          .update({ is_deleted: true })
          .eq("id", realId);
        if (error) throw error;
      } else {
        throw new Error("Shared messages can't be deleted from here");
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["check-messages", checkId] }),
    onError: (e: any) => toast({ title: "Couldn't delete", description: e.message, variant: "destructive" }),
  });

  return (
    <div className={`flex flex-col h-full min-h-[300px] ${className ?? ""}`}>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-2 p-3 bg-muted/30 rounded-md border border-border"
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">
            No messages yet. Start the discussion.
          </p>
        ) : (
          messages.map((m) => {
            const isMe = m.sender_id === user?.id;
            const profile = profiles[m.sender_id];
            const tenantName = m.sender_tenant_id ? tenants[m.sender_tenant_id] : null;
            const displayName = profile?.name || profile?.email || (isMe ? "You" : "Teammate");
            return (
              <div key={m.id} className={`flex ${isMe ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    isMe
                      ? "bg-primary text-primary-foreground"
                      : "bg-card border border-border text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-[10px] font-medium opacity-80">{displayName}</span>
                    {tenantName && (
                      <span className="text-[10px] opacity-70">· {tenantName}</span>
                    )}
                    {m.source === "shared" && (
                      <span className="text-[9px] uppercase tracking-wide opacity-60">Partner</span>
                    )}
                    <span className="text-[10px] opacity-60">
                      {format(new Date(m.created_at), "MMM d, h:mm a")}
                    </span>
                    {isMe && m.source === "internal" && (
                      <button
                        type="button"
                        onClick={() => deleteMutation.mutate(m.id)}
                        className="opacity-50 hover:opacity-100"
                        title="Delete"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap break-words">{displayCheckMessageBody(m.body)}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendMutation.mutate(draft);
        }}
        className="mt-2 flex gap-2 items-end"
      >
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={preferShared ? "Reply in partner discussion…" : "Type a message…"}
          rows={2}
          maxLength={5000}
          className="resize-none text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              sendMutation.mutate(draft);
            }
          }}
        />
        <Button
          type="submit"
          size="sm"
          disabled={sendMutation.isPending || !draft.trim()}
          className="h-9"
        >
          {sendMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </form>
    </div>
  );
}
