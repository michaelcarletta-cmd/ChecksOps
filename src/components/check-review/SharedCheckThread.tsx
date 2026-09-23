import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Send, MessageSquare } from "lucide-react";
import { useAwsPollingFallback } from "@/hooks/useAwsPollingFallback";

interface SharedCheckThreadProps {
  checkId: string;
}

interface SharedMessage {
  id: string;
  check_id: string;
  sender_user_id: string;
  sender_tenant_id: string;
  body: string;
  created_at: string;
}

export function SharedCheckThread({ checkId }: SharedCheckThreadProps) {
  const { user } = useAuth();
  const { tenantId } = useTenantFilter();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: messages = [], isLoading } = useQuery({
    queryKey: ["shared-check-messages", checkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shared_check_messages")
        .select("*")
        .eq("check_id", checkId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SharedMessage[];
    },
    enabled: !!checkId,
  });

  const senderUserIds = Array.from(new Set(messages.map((m) => m.sender_user_id)));
  const senderTenantIds = Array.from(new Set(messages.map((m) => m.sender_tenant_id)));

  const { data: profiles = [] } = useQuery({
    queryKey: ["shared-thread-profiles", senderUserIds],
    queryFn: async () => {
      if (senderUserIds.length === 0) return [];
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", senderUserIds);
      return data ?? [];
    },
    enabled: senderUserIds.length > 0,
  });

  const { data: tenantNames = [] } = useQuery({
    queryKey: ["shared-thread-tenants", senderTenantIds],
    queryFn: async () => {
      if (senderTenantIds.length === 0) return [];
      const { data } = await supabase
        .from("tenants")
        .select("id, name")
        .in("id", senderTenantIds);
      return data ?? [];
    },
    enabled: senderTenantIds.length > 0,
  });

  const profileMap = new Map(profiles.map((p: any) => [p.id, p]));
  const tenantMap = new Map(tenantNames.map((t: any) => [t.id, t.name]));

  const invalidateThread = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["shared-check-messages", checkId] });
  }, [qc, checkId]);

  useAwsPollingFallback(!!checkId, invalidateThread, 12_000);

  useEffect(() => {
    const channel = supabase
      .channel(`shared-check-${checkId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "shared_check_messages", filter: `check_id=eq.${checkId}` },
        invalidateThread,
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [checkId, invalidateThread]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const postMutation = useMutation({
    mutationFn: async (text: string) => {
      if (!user || !tenantId) throw new Error("Not signed in");
      const { error } = await supabase.from("shared_check_messages").insert({
        check_id: checkId,
        sender_user_id: user.id,
        sender_tenant_id: tenantId,
        body: text.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: ["shared-check-messages", checkId] });
    },
    onError: (e: any) => {
      toast({ title: "Failed to send", description: e.message, variant: "destructive" });
    },
  });

  const handleSend = () => {
    const text = body.trim();
    if (!text || postMutation.isPending) return;
    postMutation.mutate(text);
  };

  return (
    <div className="flex flex-col h-[500px] border border-border/60 rounded-md bg-card/30">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Partner discussion</span>
        <span className="text-[10px] text-muted-foreground ml-auto">
          Visible to all partners with access to this check
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-xs gap-1">
            <MessageSquare className="h-6 w-6 opacity-40" />
            <span>No messages yet — start the conversation.</span>
          </div>
        ) : (
          messages.map((m) => {
            const isMe = m.sender_user_id === user?.id;
            const profile: any = profileMap.get(m.sender_user_id);
            const senderName = profile?.full_name || profile?.email || "Unknown user";
            const tenantName = tenantMap.get(m.sender_tenant_id) ?? "—";
            return (
              <div key={m.id} className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
                <div className="flex items-center gap-2 mb-0.5 text-[10px] text-muted-foreground">
                  <span className="font-medium text-foreground/80">{senderName}</span>
                  <span>·</span>
                  <span>{tenantName}</span>
                  <span>·</span>
                  <span>{formatDistanceToNow(new Date(m.created_at), { addSuffix: true })}</span>
                </div>
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                    isMe
                      ? "bg-primary/15 text-foreground border border-primary/30"
                      : "bg-muted/50 text-foreground border border-border/60"
                  }`}
                >
                  {m.body}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="border-t border-border/60 p-2 flex gap-2 items-end">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Message partners on this check… (⌘/Ctrl+Enter to send)"
          className="min-h-[44px] max-h-[120px] text-sm resize-none"
          disabled={postMutation.isPending}
        />
        <Button
          size="sm"
          onClick={handleSend}
          disabled={!body.trim() || postMutation.isPending}
          className="h-9"
        >
          {postMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
