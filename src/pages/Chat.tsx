import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bot, Send, Loader2, ArrowLeft, Sparkles, Search, CheckSquare, ClipboardList, Users, Paperclip, X, FileText as FileIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface AiMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  attachmentName?: string;
  evidenceUsed?: EvidenceUsed | null;
}

interface EvidenceUsed {
  decisionReason?: string;
  internal?: {
    knowledgeSourceCount?: number;
    knowledgeBaseUsed?: boolean;
    crossClaimUsed?: boolean;
    claimContextUsed?: boolean;
    uploadedDocumentUsed?: boolean;
  };
  web?: {
    searched?: boolean;
    status?: "not_requested" | "success" | "unavailable" | "failed";
  };
}

interface UploadedFile {
  file: File;
  name: string;
  extractedText?: string;
  uploading?: boolean;
}

const quickActions = [
  { icon: Search, label: "Find claim", prompt: "Find claim for " },
  { icon: CheckSquare, label: "My tasks", prompt: "What are my overdue tasks?" },
  { icon: ClipboardList, label: "Today's summary", prompt: "Give me a summary of my claims for today" },
  { icon: Users, label: "Inactive claims", prompt: "Which claims have been inactive for over 2 weeks?" },
];

async function extractTextFromFile(file: File): Promise<string> {
  // For text-based files, read directly
  const textTypes = [
    "text/plain", "text/csv", "text/html", "text/xml",
    "application/json", "application/xml",
  ];
  const textExtensions = [".txt", ".csv", ".json", ".xml", ".html", ".md", ".log"];
  const ext = file.name.toLowerCase().substring(file.name.lastIndexOf("."));

  if (textTypes.includes(file.type) || textExtensions.includes(ext)) {
    return await file.text();
  }

  // For PDF/DOCX/images, we can't extract client-side easily, return empty
  return "";
}

export default function Chat() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [attachedFile, setAttachedFile] = useState<UploadedFile | null>(null);
  const [processingFile, setProcessingFile] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 20MB limit
    if (file.size > 20 * 1024 * 1024) {
      toast.error("File must be under 20MB");
      return;
    }

    setProcessingFile(true);
    try {
      const extractedText = await extractTextFromFile(file);
      setAttachedFile({ file, name: file.name, extractedText });
    } catch {
      toast.error("Failed to process file");
    } finally {
      setProcessingFile(false);
      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const removeAttachment = () => {
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const uploadFileToStorage = async (file: File): Promise<{ path: string } | null> => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const timestamp = Date.now();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = `chat-uploads/${user.id}/${timestamp}_${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from("claim-files")
        .upload(filePath, file, {
          contentType: file.type,
          upsert: false,
        });

      if (uploadError) throw uploadError;

      // Don't set extractedText — let the edge function handle PDF/image/Office extraction server-side
      return { path: filePath };
    } catch (err) {
      console.error("Upload error:", err);
      return null;
    }
  };

  const handleSend = async (customMessage?: string) => {
    const messageText = customMessage || message;
    if (!messageText.trim() && !attachedFile) return;

    let documentContent = "";
    let attachmentName = attachedFile?.name;
    let documentFilePath = "";

    // Process attached file
    if (attachedFile) {
      if (attachedFile.extractedText && attachedFile.extractedText.trim().length > 0) {
        // Text file - send content directly
        documentContent = attachedFile.extractedText;
      } else {
        // Binary file (PDF, images, Office docs) - upload to storage
        // Edge function will download and extract text server-side
        const uploaded = await uploadFileToStorage(attachedFile.file);
        if (uploaded) {
          documentFilePath = uploaded.path;
          // Do NOT set documentContent — let edge function extract it
        } else {
          toast.error("Failed to upload file");
          return;
        }
      }
    }

    const displayContent = attachmentName
      ? `📎 ${attachmentName}\n\n${messageText}`
      : messageText;

    const userMessage: AiMessage = {
      role: "user",
      content: displayContent,
      timestamp: new Date(),
      attachmentName,
    };

    setMessages((prev) => [...prev, userMessage]);
    setMessage("");
    setAttachedFile(null);
    setLoading(true);

    try {
      const conversationHistory = messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      const { data, error } = await supabase.functions.invoke("claims-ai-assistant", {
        body: {
          question: messageText || `Analyze this document: ${attachmentName}`,
          messages: conversationHistory,
          mode: "general",
          documentContent: documentContent || undefined,
          documentName: attachmentName || undefined,
          documentFilePath: documentFilePath || undefined,
        },
      });

      if (error) throw error;

      if (data.tasksCreated && data.tasksCreated.length > 0) {
        const taskCount = data.tasksCreated.length;
        toast.success(`${taskCount} task${taskCount > 1 ? "s" : ""} created`);
      }

      const hasBulkOperation = data.answer && (
        data.answer.includes("Bulk Status Update:") ||
        data.answer.includes("Claims Closed:") ||
        data.answer.includes("Claims Reopened:") ||
        data.answer.includes("Staff Assigned:")
      );

      if (hasBulkOperation) {
        toast.success("Bulk operation completed");
        queryClient.invalidateQueries({ queryKey: ["claims"] });
      }

      if (Array.isArray(data.emailsSent) && data.emailsSent.length > 0) {
        const recipientCount = data.emailsSent.reduce(
          (total: number, item: any) => total + (Array.isArray(item?.recipients) ? item.recipients.length : 0),
          0
        );
        toast.success(
          recipientCount > 0
            ? `Email sent to ${recipientCount} recipient${recipientCount > 1 ? "s" : ""}`
            : "Email sent"
        );
        queryClient.invalidateQueries({ queryKey: ["emails"] });
      }

      if (Array.isArray(data.smsSent) && data.smsSent.length > 0) {
        const recipientCount = data.smsSent.reduce(
          (total: number, item: any) => total + (Array.isArray(item?.recipients) ? item.recipients.length : 0),
          0
        );
        toast.success(
          recipientCount > 0
            ? `SMS sent to ${recipientCount} recipient${recipientCount > 1 ? "s" : ""}`
            : "SMS sent"
        );
      }

      const assistantMessage: AiMessage = {
        role: "assistant",
        content: data.answer,
        timestamp: new Date(),
        evidenceUsed: data.evidenceUsed || null,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error: any) {
      console.error("Error:", error);
      toast.error(error.message || "Failed to get response");
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleQuickAction = (prompt: string) => {
    if (prompt.endsWith(" ")) {
      setMessage(prompt);
      inputRef.current?.focus();
    } else {
      handleSend(prompt);
    }
  };

  const clearChat = () => {
    setMessages([]);
  };

  const getEvidenceSummary = (evidence?: EvidenceUsed | null) => {
    if (!evidence) return null;
    const internalUsed =
      Boolean(evidence.internal?.knowledgeBaseUsed) ||
      Boolean(evidence.internal?.crossClaimUsed) ||
      Boolean(evidence.internal?.claimContextUsed) ||
      Boolean(evidence.internal?.uploadedDocumentUsed);
    const webUsed = Boolean(evidence.web?.searched && evidence.web?.status === "success");

    let label = "Internal";
    if (internalUsed && webUsed) label = "Internal + Web";
    else if (!internalUsed && webUsed) label = "Web";

    return {
      label,
      kbSources: evidence.internal?.knowledgeSourceCount || 0,
      webStatus: evidence.web?.status || "not_requested",
      reason: evidence.decisionReason || "",
    };
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-background">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="shrink-0">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="h-9 w-9 rounded-full bg-primary flex items-center justify-center shrink-0">
            <Bot className="h-5 w-5 text-primary-foreground" />
          </div>
          <div className="min-w-0">
            <h1 className="font-semibold text-base truncate">Claims Assistant</h1>
            <p className="text-xs text-muted-foreground">Ask anything · Upload estimates & letters for analysis</p>
          </div>
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearChat} className="shrink-0 text-xs">
            Clear
          </Button>
        )}
      </header>

      {/* Messages Area */}
      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
              <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <Sparkles className="h-8 w-8 text-primary" />
              </div>
              <h2 className="text-lg font-semibold mb-2">How can I help?</h2>
              <p className="text-sm text-muted-foreground text-center mb-6 max-w-xs">
                Upload an estimate or denial letter and ask if the claim is underpaid, has missing items, or if we can overturn a denial.
              </p>
              
              {/* Quick Actions */}
              <div className="grid grid-cols-2 gap-2 w-full max-w-sm">
                {quickActions.map((action) => (
                  <Card
                    key={action.label}
                    className="p-3 cursor-pointer hover:bg-accent transition-colors active:scale-95"
                    onClick={() => handleQuickAction(action.prompt)}
                  >
                    <div className="flex items-center gap-2">
                      <action.icon className="h-4 w-4 text-primary shrink-0" />
                      <span className="text-sm font-medium truncate">{action.label}</span>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, index) => (
                <div
                  key={index}
                  className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
                >
                  <Avatar className="h-8 w-8 shrink-0">
                    <AvatarFallback
                      className={
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted"
                      }
                    >
                      {msg.role === "user" ? "U" : <Bot className="h-4 w-4" />}
                    </AvatarFallback>
                  </Avatar>
                  <div
                    className={`max-w-[80%] p-3 rounded-2xl text-sm ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-br-md"
                        : "bg-muted rounded-bl-md"
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                    {msg.role === "assistant" && (() => {
                      const evidence = getEvidenceSummary(msg.evidenceUsed);
                      if (!evidence) return null;
                      return (
                        <div className="mt-2 space-y-1 rounded-md border bg-background/60 p-2">
                          <div className="flex flex-wrap gap-1.5">
                            <Badge variant="secondary" className="text-[10px]">
                              Evidence: {evidence.label}
                            </Badge>
                            <Badge variant="outline" className="text-[10px]">
                              KB sources: {evidence.kbSources}
                            </Badge>
                            <Badge variant="outline" className="text-[10px]">
                              Web: {evidence.webStatus}
                            </Badge>
                          </div>
                          {evidence.reason && (
                            <p className="text-[11px] text-muted-foreground">
                              Decision: {evidence.reason}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                    <p className={`text-[10px] mt-1 ${
                      msg.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground"
                    }`}>
                      {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex gap-2">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="bg-muted">
                      <Bot className="h-4 w-4" />
                    </AvatarFallback>
                  </Avatar>
                  <div className="bg-muted p-3 rounded-2xl rounded-bl-md">
                    <div className="flex items-center gap-1">
                      <div className="h-2 w-2 bg-foreground/40 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <div className="h-2 w-2 bg-foreground/40 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <div className="h-2 w-2 bg-foreground/40 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {/* Attachment Preview */}
      {attachedFile && (
        <div className="px-3 pt-2">
          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted border text-sm">
            <FileIcon className="h-4 w-4 text-primary shrink-0" />
            <span className="truncate flex-1">{attachedFile.name}</span>
            <Badge variant="secondary" className="text-[10px] shrink-0">
              {(attachedFile.file.size / 1024).toFixed(0)}KB
            </Badge>
            <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={removeAttachment}>
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}

      {/* Input Area */}
      <div className="border-t bg-background p-3 pb-safe">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex gap-2 items-center"
        >
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.doc,.docx,.txt,.csv,.xls,.xlsx,.jpg,.jpeg,.png,.webp"
            onChange={handleFileSelect}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0"
            onClick={() => fileInputRef.current?.click()}
            disabled={loading || processingFile}
          >
            {processingFile ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Paperclip className="h-5 w-5" />
            )}
          </Button>
          <Input
            ref={inputRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={attachedFile ? "Ask about this document..." : "Message..."}
            className="flex-1 rounded-full bg-muted border-0 px-4 h-11"
            disabled={loading}
          />
          <Button
            type="submit"
            size="icon"
            className="h-11 w-11 rounded-full shrink-0"
            disabled={loading || (!message.trim() && !attachedFile)}
          >
            {loading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Send className="h-5 w-5" />
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}