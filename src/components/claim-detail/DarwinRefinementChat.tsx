import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, Send, RotateCcw } from "lucide-react";
import { toast } from "sonner";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface DarwinRefinementChatProps {
  /** The current full text of the document being refined */
  currentDocument: string;
  /** Called when Darwin produces a revised version */
  onDocumentUpdated: (newDocument: string) => void;
  /** The claim ID for context */
  claimId: string;
  /** Label for the document type, e.g. "rebuttal" or "DOBI complaint letter" */
  documentLabel: string;
}

export const DarwinRefinementChat = ({
  currentDocument,
  onDocumentUpdated,
  claimId,
  documentLabel,
}: DarwinRefinementChatProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isRefining, setIsRefining] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    const instruction = input.trim();
    if (!instruction || isRefining) return;

    const userMsg: ChatMessage = { role: "user", content: instruction };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsRefining(true);

    try {
      const { data, error } = await supabase.functions.invoke("darwin-ai-analysis", {
        body: {
          claimId,
          analysisType: "refine_document",
          additionalContext: {
            currentDocument,
            instruction,
            documentLabel,
            conversationHistory: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          },
        },
      });

      if (error) throw error;

      const revised = data?.result;
      if (revised) {
        onDocumentUpdated(revised);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `I've updated the ${documentLabel} based on your instructions. The changes have been applied above.`,
          },
        ]);
        toast.success(`${documentLabel.charAt(0).toUpperCase() + documentLabel.slice(1)} updated`);
      } else {
        throw new Error("No revised document returned");
      }
    } catch (err: any) {
      console.error("Refinement error:", err);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Sorry, I couldn't apply that change. ${err.message || "Please try again."}` },
      ]);
      toast.error("Failed to refine document");
    } finally {
      setIsRefining(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleReset = () => {
    setMessages([]);
  };

  return (
    <div className="border rounded-lg bg-card">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
        <span className="text-sm font-medium text-foreground">
          Refine this {documentLabel}
        </span>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={handleReset} className="h-7 text-xs gap-1">
            <RotateCcw className="h-3 w-3" />
            Clear chat
          </Button>
        )}
      </div>

      {messages.length > 0 && (
        <ScrollArea className="max-h-[200px] px-3 py-2">
          <div ref={scrollRef} className="space-y-2">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`text-sm rounded-lg px-3 py-2 max-w-[85%] ${
                  msg.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {msg.content}
              </div>
            ))}
            {isRefining && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                Darwin is revising the {documentLabel}...
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      <div className="flex items-end gap-2 p-3 border-t">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`e.g. "Remove the second paragraph" or "Add that the adjuster promised a callback on 3/15"`}
          className="min-h-[44px] max-h-[120px] resize-none text-sm"
          disabled={isRefining}
        />
        <Button
          size="icon"
          onClick={handleSend}
          disabled={!input.trim() || isRefining}
          className="shrink-0"
        >
          {isRefining ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
};
