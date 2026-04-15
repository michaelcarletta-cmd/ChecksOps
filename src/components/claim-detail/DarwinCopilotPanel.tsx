import { useState, useRef, useEffect, useCallback } from "react";
import { Brain, Send, Trash2, StopCircle, Maximize2, Minimize2, Bold, Italic, Underline, Type, Paperclip, X, FileText, RefreshCw, AlertTriangle, TrendingUp, Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useDarwinCopilot, type CopilotMessage } from "@/hooks/useDarwinCopilot";
import { DraftRenderer } from "./copilot/DraftRenderer";
import { supabase } from "@/integrations/supabase/client";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type CopilotMode = 'operational' | 'rebuttal' | 'estimate' | 'war_room' | 'training' | 'strategy' | 'draft' | 'search_web' | 'search_argue';

const MODE_LABELS: Record<CopilotMode, string> = {
  strategy: "Strategy",
  operational: "Ops",
  rebuttal: "Rebuttal",
  estimate: "Estimate",
  war_room: "War Room",
  training: "Training",
  draft: "Draft",
  search_web: "Search the Web",
  search_argue: "Search + Argue",
};

interface ClaimFile {
  id: string;
  file_name: string;
  file_path: string;
}

interface DarwinCopilotPanelProps {
  claimId: string;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}

export function DarwinCopilotPanel({ claimId, isExpanded, onToggleExpand }: DarwinCopilotPanelProps) {
  const { messages, loading, mode, setMode, askCopilot, clearConversation, stopGeneration } = useDarwinCopilot(claimId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [attachedFiles, setAttachedFiles] = useState<ClaimFile[]>([]);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [claimFiles, setClaimFiles] = useState<ClaimFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [nudges, setNudges] = useState<Array<{ id: string; severity: string; title: string; message: string; warning_type: string }>>([]);
  const [dismissedNudgeIds, setDismissedNudgeIds] = useState<Set<string>>(new Set());
  const [nudgesCollapsed, setNudgesCollapsed] = useState(false);

  // Load active warnings/nudges for this claim
  useEffect(() => {
    const fetchNudges = async () => {
      const { data } = await supabase
        .from('claim_warnings_log')
        .select('id, severity, title, message, warning_type')
        .eq('claim_id', claimId)
        .eq('is_dismissed', false)
        .eq('is_resolved', false)
        .order('created_at', { ascending: false })
        .limit(5);
      if (data) setNudges(data);
    };
    fetchNudges();

    const channel = supabase
      .channel(`copilot_nudges_${claimId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'claim_warnings_log',
        filter: `claim_id=eq.${claimId}`,
      }, () => { fetchNudges(); })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [claimId]);

  const handleDismissNudge = async (nudgeId: string) => {
    setDismissedNudgeIds(prev => new Set([...prev, nudgeId]));
    await supabase
      .from('claim_warnings_log')
      .update({ is_dismissed: true, dismissed_at: new Date().toISOString() })
      .eq('id', nudgeId);
  };

  const visibleNudges = nudges.filter(n => !dismissedNudgeIds.has(n.id));

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Load claim files when picker opens
  useEffect(() => {
    if (showFilePicker && claimFiles.length === 0) {
      setFilesLoading(true);
      supabase
        .from("claim_files")
        .select("id, file_name, file_path")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .then(({ data }) => {
          setClaimFiles(data || []);
          setFilesLoading(false);
        });
    }
  }, [showFilePicker, claimId]);

  const getEditorContent = useCallback(() => {
    return editorRef.current?.innerHTML || "";
  }, []);

  const getEditorText = useCallback(() => {
    return editorRef.current?.innerText?.trim() || "";
  }, []);

  const clearEditor = useCallback(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = "";
    }
  }, []);

  const execCommand = useCallback((command: string, value?: string) => {
    document.execCommand(command, false, value);
    editorRef.current?.focus();
  }, []);

  const handleSend = () => {
    const text = getEditorText();
    if (!text || loading) return;

    // Build message with file context
    let messageContent = getEditorContent();
    if (attachedFiles.length > 0) {
      const fileNames = attachedFiles.map(f => f.file_name).join(", ");
      messageContent += `\n\n[Attached files: ${fileNames}]`;
    }

    clearEditor();
    setAttachedFiles([]);

    // Send with HTML content and file references
    askCopilot(text, undefined, {
      htmlContent: messageContent,
      attachedFileIds: attachedFiles.map(f => f.id),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  const toggleFile = (file: ClaimFile) => {
    setAttachedFiles(prev =>
      prev.find(f => f.id === file.id)
        ? prev.filter(f => f.id !== file.id)
        : [...prev, file]
    );
  };

  const QUICK_PROMPTS = [
    "Draft an SMS update for the client",
    "Draft a client update email",
    "What's the strongest argument against the carrier?",
    "What evidence am I missing?",
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
            {onToggleExpand && (
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onToggleExpand} title={isExpanded ? "Collapse" : "Expand"}>
                {isExpanded ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
              </Button>
            )}
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
                  onClick={() => { clearEditor(); askCopilot(prompt); }}
                  disabled={loading}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <MessageBubble key={idx} message={msg} onRetry={msg.isError ? () => {
              // Retry: resend the last user message
              const lastUser = [...messages].reverse().find(m => m.role === 'user');
              if (lastUser) askCopilot(lastUser.content);
            } : undefined} />
          ))
        )}
        {loading && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-5/6" />
            <p className="text-[10px] text-muted-foreground mt-1">Darwin is thinking…</p>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="border-t p-2 space-y-1.5">
        {loading && (
          <Button variant="ghost" size="sm" className="w-full h-6 text-xs gap-1 text-muted-foreground" onClick={stopGeneration}>
            <StopCircle className="h-3 w-3" /> Stop generating
          </Button>
        )}

        {/* Attached files pills */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-1 px-1">
            {attachedFiles.map(f => (
              <Badge key={f.id} variant="secondary" className="text-[10px] gap-1 pr-1">
                <FileText className="h-2.5 w-2.5" />
                <span className="max-w-[100px] truncate">{f.file_name}</span>
                <button onClick={() => setAttachedFiles(prev => prev.filter(p => p.id !== f.id))} className="hover:text-destructive">
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        {/* Rich text toolbar */}
        <div className="flex items-center gap-0.5 px-1">
          <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => execCommand('bold')} title="Bold" disabled={loading}>
            <Bold className="h-3 w-3" />
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => execCommand('italic')} title="Italic" disabled={loading}>
            <Italic className="h-3 w-3" />
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => execCommand('underline')} title="Underline" disabled={loading}>
            <Underline className="h-3 w-3" />
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" title="Font Size" disabled={loading}>
                <Type className="h-3 w-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1" side="top">
              <div className="flex flex-col gap-0.5">
                <Button type="button" variant="ghost" size="sm" className="justify-start px-2 py-0.5 h-auto text-xs" onClick={() => execCommand('fontSize', '2')}>Small</Button>
                <Button type="button" variant="ghost" size="sm" className="justify-start px-2 py-0.5 h-auto text-sm" onClick={() => execCommand('fontSize', '3')}>Normal</Button>
                <Button type="button" variant="ghost" size="sm" className="justify-start px-2 py-0.5 h-auto text-base" onClick={() => execCommand('fontSize', '4')}>Large</Button>
              </div>
            </PopoverContent>
          </Popover>

          <div className="w-px h-4 bg-border mx-0.5" />

          {/* Attach file from claim */}
          <Popover open={showFilePicker} onOpenChange={setShowFilePicker}>
            <PopoverTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="h-6 w-6 p-0" title="Attach claim file" disabled={loading}>
                <Paperclip className="h-3 w-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-2" side="top" align="start">
              <p className="text-xs font-medium mb-1.5">Attach files from claim</p>
              {filesLoading ? (
                <p className="text-xs text-muted-foreground py-2 text-center">Loading…</p>
              ) : claimFiles.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2 text-center">No files found</p>
              ) : (
                <div className="max-h-[200px] overflow-y-auto space-y-0.5">
                  {claimFiles.map(file => {
                    const isAttached = attachedFiles.some(f => f.id === file.id);
                    return (
                      <button
                        key={file.id}
                        className={cn(
                          "w-full text-left text-[11px] px-2 py-1.5 rounded flex items-center gap-1.5 transition-colors",
                          isAttached
                            ? "bg-primary/10 text-primary"
                            : "hover:bg-accent/50 text-muted-foreground"
                        )}
                        onClick={() => toggleFile(file)}
                      >
                        <FileText className="h-3 w-3 shrink-0" />
                        <span className="truncate">{file.file_name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </PopoverContent>
          </Popover>
        </div>

        {/* Editable input + send */}
        <div className="flex gap-1.5">
          <div
            ref={editorRef}
            contentEditable={!loading}
            className={cn(
              "flex-1 min-h-[36px] max-h-[120px] overflow-y-auto rounded-md border border-input bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring prose prose-sm max-w-none",
              loading && "opacity-50 cursor-not-allowed"
            )}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            data-placeholder="Ask about strategy, disputes, evidence…"
          />
          <Button
            size="sm"
            className="h-9 w-9 p-0 shrink-0"
            onClick={handleSend}
            disabled={loading}
          >
            <Send className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <style>{`
        [contenteditable]:empty:before {
          content: attr(data-placeholder);
          color: hsl(var(--muted-foreground));
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}

function MessageBubble({ message, onRetry }: { message: CopilotMessage; onRetry?: () => void }) {
  const isUser = message.role === 'user';

  // If this is a draft response, render the DraftRenderer
  if (!isUser && message.draftData) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[95%] w-full">
          <DraftRenderer draftData={message.draftData} />
        </div>
      </div>
    );
  }

  const metaLabel = !isUser && message.meta?.model
    ? `${message.meta.model}${message.meta.cached ? ' • cached' : ''}${message.meta.usedSearch ? ` • search${message.meta.searchCount && message.meta.searchCount > 1 ? ` (×${message.meta.searchCount})` : ''}` : ''}`
    : null;

  const sources = !isUser && message.meta?.sources?.length ? message.meta.sources : null;

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div className={cn(
        "max-w-[95%] rounded-lg px-3 py-2 text-xs",
        isUser
          ? "bg-primary text-primary-foreground"
          : message.isError
            ? "bg-destructive/10 text-destructive border border-destructive/20"
            : "bg-muted/80 text-foreground"
      )}>
        <div className="whitespace-pre-wrap break-words leading-relaxed" dangerouslySetInnerHTML={isUser ? { __html: message.content } : undefined}>
          {!isUser ? (message.content || (
            <span className="text-muted-foreground italic">Generating…</span>
          )) : undefined}
        </div>
        {sources && (
          <div className="mt-2 pt-1.5 border-t border-border/30 space-y-0.5">
            <p className="text-[9px] font-medium text-muted-foreground/70 mb-0.5">Sources ({sources.length})</p>
            {sources.map((s, i) => (
              <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="block text-[9px] text-primary/70 hover:text-primary truncate">
                [{i + 1}] {s.title}
              </a>
            ))}
          </div>
        )}
        {message.isError && onRetry && (
          <Button variant="ghost" size="sm" className="mt-1.5 h-6 text-[10px] gap-1 text-destructive hover:text-destructive" onClick={onRetry}>
            <RefreshCw className="h-3 w-3" /> Retry
          </Button>
        )}
        {metaLabel && (
          <p className="text-[9px] text-muted-foreground/60 mt-1 select-none">{metaLabel}</p>
        )}
      </div>
    </div>
  );
}
