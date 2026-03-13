import { useState, useRef, useEffect } from "react";
import { Brain, Send, Trash2, StopCircle, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useDarwinCopilot, type CopilotMessage } from "@/hooks/useDarwinCopilot";

type CopilotMode = 'operational' | 'rebuttal' | 'estimate' | 'war_room' | 'training' | 'strategy';

const MODE_LABELS: Record<CopilotMode, string> = {
  strategy: "Strategy",
  operational: "Ops",
  rebuttal: "Rebuttal",
  estimate: "Estimate",
  war_room: "War Room",
  training: "Training",
};

interface DarwinCopilotPanelProps {
  claimId: string;
}

export function DarwinCopilotPanel({ claimId }: DarwinCopilotPanelProps) {
  const { messages, loading, mode, setMode, askCopilot, clearConversation, stopGeneration } = useDarwinCopilot(claimId);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setInput("");
    askCopilot(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const QUICK_PROMPTS = [
    "What's the strongest argument against the carrier?",
    "What evidence am I missing?",
    "Draft rebuttal language for the top dispute",
    "Explain the carrier's weakest position",
    "What should I do next on this claim?",
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b bg-gradient-to-r from-primary/5 to-transparent">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Darwin Copilot</span>
          </div>
          <div className="flex gap-1">
            {messages.length > 0 && (
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={clearConversation} title="Clear conversation">
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
        {/* Mode selector */}
        <div className="flex flex-wrap gap-1">
          {(Object.keys(MODE_LABELS) as CopilotMode[]).map(m => (
            <Badge
              key={m}
              variant={mode === m ? "default" : "outline"}
              className={cn("cursor-pointer text-[10px] px-1.5 py-0", mode === m && "bg-primary text-primary-foreground")}
              onClick={() => setMode(m)}
            >
              {MODE_LABELS[m]}
            </Badge>
          ))}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground text-center pt-4">
              Ask Darwin about claim strategy, disputes, evidence, or rebuttal paths.
            </p>
            <div className="space-y-1.5">
              {QUICK_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  className="w-full text-left text-[11px] px-2.5 py-1.5 rounded-md border border-border/50 hover:bg-accent/50 hover:border-primary/30 transition-colors text-muted-foreground"
                  onClick={() => { setInput(""); askCopilot(prompt); }}
                  disabled={loading}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <MessageBubble key={idx} message={msg} />
          ))
        )}
        {loading && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div className="animate-pulse flex gap-1">
              <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
            Darwin is thinking…
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t p-2 space-y-2">
        {loading && (
          <Button variant="ghost" size="sm" className="w-full h-6 text-xs gap-1 text-muted-foreground" onClick={stopGeneration}>
            <StopCircle className="h-3 w-3" /> Stop generating
          </Button>
        )}
        <div className="flex gap-1.5">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about strategy, disputes, evidence…"
            className="min-h-[36px] max-h-[100px] text-xs resize-none"
            rows={1}
            disabled={loading}
          />
          <Button
            size="sm"
            className="h-9 w-9 p-0 shrink-0"
            onClick={handleSend}
            disabled={!input.trim() || loading}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: CopilotMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div className={cn(
        "max-w-[95%] rounded-lg px-3 py-2 text-xs",
        isUser
          ? "bg-primary text-primary-foreground"
          : "bg-muted/80 text-foreground"
      )}>
        <div className="whitespace-pre-wrap break-words leading-relaxed">
          {message.content || (
            <span className="text-muted-foreground italic">Generating…</span>
          )}
        </div>
      </div>
    </div>
  );
}
