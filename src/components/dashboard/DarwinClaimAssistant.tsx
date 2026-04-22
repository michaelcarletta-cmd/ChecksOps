import { useState, useRef, useEffect } from "react";
import { Bot, X, Send, Copy, Mail, RefreshCw, ChevronRight, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useDarwinGuidedMode } from "@/hooks/useDarwinGuidedMode";
import { cn } from "@/lib/utils";

interface DarwinClaimAssistantProps {
  open: boolean;
  onClose: () => void;
}

export function DarwinClaimAssistant({ open, onClose }: DarwinClaimAssistantProps) {
  const [input, setInput] = useState("");
  const [selectedClaimId, setSelectedClaimId] = useState<string>("");
  const { draft, loading, error, generateDraft, regenerate, clear } = useDarwinGuidedMode();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const { data: claims } = useQuery({
    queryKey: ["darwin-assistant-claims"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claims")
        .select("id, claim_number, policyholder_name")
        .eq("is_closed", false)
        .order("updated_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
    enabled: open,
  });

  useEffect(() => {
    if (open && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 250);
    }
  }, [open]);

  const handleSubmit = () => {
    generateDraft(input, selectedClaimId || undefined);
  };

  const handleCopyAll = () => {
    if (!draft) return;
    const full = [
      draft.subject ? `Subject: ${draft.subject}` : "",
      draft.to ? `To: ${draft.to}` : "",
      "",
      draft.body,
      draft.recommendedAttachments?.length ? `\nRecommended Attachments: ${draft.recommendedAttachments.join(", ")}` : "",
      draft.clientSendNote ? `\nNote: ${draft.clientSendNote}` : "",
    ].filter(Boolean).join("\n");
    navigator.clipboard.writeText(full);
    toast.success("Email copied to clipboard — ready to paste");
  };

  const handleCopyBody = () => {
    if (!draft?.body) return;
    navigator.clipboard.writeText(draft.body);
    toast.success("Draft text copied");
  };

  const handleOpenEmail = () => {
    if (!draft) return;
    const subject = encodeURIComponent(draft.subject || "Claim Inquiry");
    const body = encodeURIComponent(draft.body);
    window.open(`mailto:?subject=${subject}&body=${body}`, "_blank");
    handleCopyAll();
  };

  return (
    <>
      {/* Overlay on mobile */}
      {open && (
        <div
          className="fixed inset-0 bg-black/30 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Panel */}
      <div
        ref={panelRef}
        className={cn(
          "fixed top-0 right-0 h-full z-50 flex flex-col bg-[hsl(var(--background))]",
          "border-l-[3px] border-l-primary shadow-2xl",
          "transition-transform duration-200 ease-out",
          "w-full lg:w-[35%] lg:min-w-[420px] lg:max-w-[560px]",
          open ? "translate-x-0" : "translate-x-full"
        )}
        style={{ backgroundColor: "#F9FAFB" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-card">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Bot className="h-4.5 w-4.5 text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground leading-tight">Darwin Claim Assistant</h2>
              <Badge variant="secondary" className="mt-0.5 text-[10px] px-1.5 py-0 bg-primary text-primary-foreground font-medium">
                Guided Claim Mode
              </Badge>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Context Selector */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Link to Claim</label>
            <Select value={selectedClaimId} onValueChange={setSelectedClaimId}>
              <SelectTrigger className="h-9 text-sm bg-card">
                <SelectValue placeholder="Select a claim (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No specific claim</SelectItem>
                {claims?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.claim_number || "No #"} — {c.policyholder_name || "Unknown"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Input Area */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Describe the Issue</label>
            <div className="relative">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Describe the carrier's position, estimate, or issue..."
                className={cn(
                  "min-h-[120px] text-sm bg-card resize-none pr-10",
                  error && !loading && "border-destructive"
                )}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
              />
              <Button
                size="icon"
                className="absolute bottom-2 right-2 h-7 w-7"
                onClick={handleSubmit}
                disabled={loading || !input.trim()}
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
            {error && !loading && (
              <p className="text-xs text-destructive mt-1">{error}</p>
            )}
          </div>

          {/* Loading State */}
          {loading && (
            <div className="space-y-3 py-4">
              <div className="h-4 w-3/4 bg-muted animate-pulse rounded" />
              <div className="h-4 w-full bg-muted animate-pulse rounded" style={{ animationDelay: "100ms" }} />
              <div className="h-4 w-5/6 bg-muted animate-pulse rounded" style={{ animationDelay: "200ms" }} />
              <p className="text-xs text-muted-foreground text-center mt-2">Preparing your response...</p>
            </div>
          )}

          {/* Empty State */}
          {!draft && !loading && !error && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
                <Bot className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">
                Describe a claim issue to prepare a response
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                ⌘ + Enter to generate
              </p>
            </div>
          )}

          {/* Draft Preview */}
          {draft && !loading && (
            <div className="space-y-3">
              {/* Email headers */}
              {(draft.subject || draft.to) && (
                <div className="bg-card rounded-lg p-3 border space-y-1.5">
                  {draft.subject && (
                    <div className="flex items-start gap-2">
                      <span className="text-xs font-medium text-muted-foreground min-w-[52px]">Subject:</span>
                      <span className="text-sm text-foreground">{draft.subject}</span>
                    </div>
                  )}
                  {draft.to && (
                    <div className="flex items-start gap-2">
                      <span className="text-xs font-medium text-muted-foreground min-w-[52px]">To:</span>
                      <span className="text-sm text-foreground">{draft.to}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Body */}
              <div className="bg-card rounded-lg p-4 border">
                <div className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                  {draft.body}
                </div>
              </div>

              {/* Recommended Attachments */}
              {draft.recommendedAttachments && draft.recommendedAttachments.length > 0 && (
                <div className="bg-card rounded-lg p-3 border">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">Recommended Attachments</span>
                  </div>
                  <ul className="space-y-1">
                    {draft.recommendedAttachments.map((a, i) => (
                      <li key={i} className="text-sm text-foreground flex items-center gap-1.5">
                        <ChevronRight className="h-3 w-3 text-primary" />
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Client Send Note */}
              {draft.clientSendNote && (
                <div className="bg-primary/5 rounded-lg p-3 border border-primary/20">
                  <p className="text-xs font-medium text-primary mb-1">Client Send Note</p>
                  <p className="text-sm text-foreground">{draft.clientSendNote}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Output Actions */}
        {draft && !loading && (
          <div className="border-t p-3 bg-card flex items-center gap-2">
            <Button onClick={handleOpenEmail} className="flex-1 h-9 text-sm gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              Open in Email App
            </Button>
            <Button variant="secondary" onClick={handleCopyBody} className="h-9 text-sm gap-1.5">
              <Copy className="h-3.5 w-3.5" />
              Copy Text
            </Button>
            <Button variant="ghost" onClick={regenerate} className="h-9 text-sm gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
