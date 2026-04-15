import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bot, Send, Loader2, Sparkles, Brain, Globe, Database } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQueryClient } from "@tanstack/react-query";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CommunicationDraftComposer, type CommunicationDraft } from "@/components/CommunicationDraftComposer";

type SourceMode = "internal_only" | "hybrid";

interface AiMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  evidenceUsed?: EvidenceUsed | null;
  communicationDrafts?: CommunicationDraft[];
}

interface EvidenceUsed {
  sourceModeRequested?: "internal_only" | "hybrid";
  strategy?: string;
  decisionReason?: string;
  internal?: {
    knowledgeBaseUsed?: boolean;
    knowledgeSourceCount?: number;
    crossClaimUsed?: boolean;
    claimContextUsed?: boolean;
    uploadedDocumentUsed?: boolean;
  };
  web?: {
    searched?: boolean;
    status?: "not_requested" | "success" | "unavailable" | "failed";
  };
}

interface ClaimsAIAssistantProps {
  claimId?: string;
  claimNumber?: string;
  policyholderName?: string;
}

export const ClaimsAIAssistant = ({ claimId, claimNumber, policyholderName }: ClaimsAIAssistantProps) => {
  const [open, setOpen] = useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiMessages, setAiMessages] = useState<AiMessage[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [sourceMode, setSourceMode] = useState<SourceMode>("hybrid");
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [sendingDraftIds, setSendingDraftIds] = useState<Record<string, boolean>>({});
  const [sentDraftIds, setSentDraftIds] = useState<Record<string, boolean>>({});
  const queryClient = useQueryClient();

  // Clear messages when switching between claims
  useEffect(() => {
    setAiMessages([]);
    setDraftEdits({});
    setSendingDraftIds({});
    setSentDraftIds({});
  }, [claimId]);

  const isClaimContext = !!claimId;

  const handleAskAI = async () => {
    if (!aiQuestion.trim()) return;

    const userMessage: AiMessage = {
      role: "user",
      content: aiQuestion,
      timestamp: new Date(),
    };

    setAiMessages((prev) => [...prev, userMessage]);
    setAiQuestion("");
    setAiLoading(true);

    try {
      const conversationHistory = aiMessages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

      const { data, error } = await supabase.functions.invoke("claims-ai-assistant", {
        body: {
          question: userMessage.content,
          messages: conversationHistory,
          mode: isClaimContext ? "claim" : "general",
          claimId: claimId || undefined,
          sourceMode,
        },
      });

      if (error) throw error;

      // Show toast for created tasks
      if (data.tasksCreated && data.tasksCreated.length > 0) {
        const taskCount = data.tasksCreated.length;
        toast.success(`${taskCount} task${taskCount > 1 ? 's' : ''} created successfully`);
        // Invalidate tasks query to refresh the list
        if (claimId) {
          queryClient.invalidateQueries({ queryKey: ["claim-tasks", claimId] });
        }
      }

      // Check for task management operations in the response
      const hasTaskOps = data.answer && (
        data.answer.includes("Task updated:") ||
        data.answer.includes("Task completed:") ||
        data.answer.includes("Task reopened:") ||
        data.answer.includes("Task deleted:") ||
        data.answer.includes("Tasks for") ||
        data.answer.includes("Bulk Task Processing Complete") ||
        data.answer.includes("task(s) processed")
      );
      if (hasTaskOps) {
        if (claimId) {
          queryClient.invalidateQueries({ queryKey: ["claim-tasks", claimId] });
        }
        queryClient.invalidateQueries({ queryKey: ["claim-tasks"] });
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
      }

      // Check if bulk operations were performed (detect by response content)
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
        if (claimId) {
          queryClient.invalidateQueries({ queryKey: ["emails", claimId] });
        }
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
        if (claimId) {
          queryClient.invalidateQueries({ queryKey: ["darwin-sms-activity", claimId] });
        }
      }

      if (Array.isArray(data.portalNotificationsSent) && data.portalNotificationsSent.length > 0) {
        const recipientCount = data.portalNotificationsSent.reduce(
          (total: number, item: any) => total + (Array.isArray(item?.recipientIds) ? item.recipientIds.length : 0),
          0
        );
        toast.success(
          recipientCount > 0
            ? `Portal notification sent to ${recipientCount} recipient${recipientCount > 1 ? "s" : ""}`
            : "Portal notification sent"
        );
        queryClient.invalidateQueries({ queryKey: ["claim-notifications"] });
        queryClient.invalidateQueries({ queryKey: ["unread-claim-notifications"] });
      }

      if (Array.isArray(data.lettersCreated) && data.lettersCreated.length > 0) {
        const letterCount = data.lettersCreated.length;
        toast.success(`Created ${letterCount} claim letter${letterCount > 1 ? "s" : ""}`);
        if (claimId) {
          queryClient.invalidateQueries({ queryKey: ["claim-files", claimId] });
        }
        queryClient.invalidateQueries({ queryKey: ["claim-files"] });
      }

      if (Array.isArray(data.callsScheduled) && data.callsScheduled.length > 0) {
        const callCount = data.callsScheduled.length;
        toast.success(`Scheduled ${callCount} call${callCount > 1 ? "s" : ""}`);
        if (claimId) {
          queryClient.invalidateQueries({ queryKey: ["claim-tasks", claimId] });
        }
        queryClient.invalidateQueries({ queryKey: ["claim-tasks"] });
      }

      const assistantMessage: AiMessage = {
        role: "assistant",
        content: data.answer,
        timestamp: new Date(),
        evidenceUsed: data.evidenceUsed || null,
        communicationDrafts: Array.isArray(data.communicationDrafts) ? data.communicationDrafts : [],
      };

      setAiMessages((prev) => [...prev, assistantMessage]);
    } catch (error: any) {
      console.error("Error asking AI:", error);
      toast.error(error.message || "Failed to get AI response");
    } finally {
      setAiLoading(false);
    }
  };

  const getDraftBody = (draft: CommunicationDraft) => draftEdits[draft.draftId] ?? draft.body;

  const resetDraftBody = (draftId: string) => {
    setDraftEdits((prev) => {
      if (!(draftId in prev)) return prev;
      const next = { ...prev };
      delete next[draftId];
      return next;
    });
  };

  const handleApproveAndSendDraft = async (draft: CommunicationDraft) => {
    if (sendingDraftIds[draft.draftId] || sentDraftIds[draft.draftId]) return;

    const body = getDraftBody(draft).trim();
    if (!body) {
      toast.error("Draft body cannot be empty");
      return;
    }

    setSendingDraftIds((prev) => ({ ...prev, [draft.draftId]: true }));

    try {
      if (draft.channel === "email") {
        const recipients = draft.recipients
          .filter((recipient) => Boolean(recipient.email))
          .map((recipient) => ({
            email: String(recipient.email),
            name: recipient.name || String(recipient.email),
            type: recipient.type || "manual",
          }));

        if (recipients.length === 0) {
          throw new Error("This draft has no valid email recipients.");
        }

        const { data, error } = await supabase.functions.invoke("send-email", {
          body: {
            recipients,
            subject: draft.subject || claimNumber || draft.claimReference,
            body,
            claimId: draft.claimId,
            claimEmailCc: draft.claimEmailCc,
          },
        });

        if (error) throw error;
        if (data?.error) throw new Error(String(data.error));

        toast.success(`Email sent to ${recipients.length} recipient${recipients.length > 1 ? "s" : ""}`);
        if (draft.claimId) {
          queryClient.invalidateQueries({ queryKey: ["emails", draft.claimId] });
        }
        queryClient.invalidateQueries({ queryKey: ["emails"] });
      } else {
        const recipients = draft.recipients.filter((recipient) => Boolean(recipient.phone));
        if (recipients.length === 0) {
          throw new Error("This draft has no valid phone recipients.");
        }

        for (const recipient of recipients) {
          const { data, error } = await supabase.functions.invoke("send-sms", {
            body: {
              claimId: draft.claimId,
              toNumber: recipient.phone,
              messageBody: body,
            },
          });
          if (error) throw error;
          if (data?.error) throw new Error(String(data.error));
        }

        toast.success(`SMS sent to ${recipients.length} recipient${recipients.length > 1 ? "s" : ""}`);
        if (draft.claimId) {
          queryClient.invalidateQueries({ queryKey: ["darwin-sms-activity", draft.claimId] });
        }
      }

      setSentDraftIds((prev) => ({ ...prev, [draft.draftId]: true }));
    } catch (error: any) {
      toast.error(error.message || "Failed to send draft");
    } finally {
      setSendingDraftIds((prev) => ({ ...prev, [draft.draftId]: false }));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAskAI();
    }
  };

  const clearChat = () => {
    setAiMessages([]);
    setDraftEdits({});
    setSendingDraftIds({});
    setSentDraftIds({});
  };

  const getPlaceholder = () => {
    if (isClaimContext) {
      return `Ask Darwin about ${claimNumber || 'this claim'}...`;
    }
    return "Ask about claims, follow-ups, strategies...";
  };

  const getTitle = () => {
    if (isClaimContext) {
      return "Darwin — Claims Operations";
    }
    return "Darwin AI";
  };

  const getIcon = () => {
    if (isClaimContext) {
      return <Brain className="h-5 w-5 text-primary" />;
    }
    return <Bot className="h-5 w-5 text-primary" />;
  };

  const getHelpContent = () => {
    if (isClaimContext) {
      return (
        <Card className="p-6 bg-primary/5 border-primary/20 max-w-sm">
          <div className="text-center space-y-3">
            <Brain className="h-12 w-12 text-primary mx-auto" />
            <h3 className="font-semibold">Darwin — Claims Operations Assistant</h3>
            <p className="text-sm text-muted-foreground">
              Document-aware intelligence for <strong>{policyholderName || claimNumber}</strong>
            </p>
            <ul className="text-sm text-muted-foreground space-y-1 text-left">
              <li>• Upload a document for structured analysis</li>
              <li>• "Does this denial hold up?"</li>
              <li>• "What evidence do we need?"</li>
              <li>• "How do we rebut this?"</li>
              <li>• "Is this repair feasible?"</li>
              <li>• Coverage-first strategic guidance</li>
              <li>• Every response ends with a next step</li>
            </ul>
          </div>
        </Card>
      );
    }

    return (
      <Card className="p-6 bg-primary/5 border-primary/20 max-w-sm">
        <div className="text-center space-y-3">
          <Bot className="h-12 w-12 text-primary mx-auto" />
          <h3 className="font-semibold">Darwin AI</h3>
          <p className="text-sm text-muted-foreground">
            Claims operations & workflow assistant
          </p>
          <ul className="text-sm text-muted-foreground space-y-1 text-left">
            <li>• Analyze documents & carrier positions</li>
            <li>• Create tasks with due dates</li>
            <li>• Bulk update statuses & assign staff</li>
            <li>• Search communications & history</li>
            <li>• Find leads by storm activity</li>
            <li>• Draft, edit, approve, and send claim emails/SMS</li>
          </ul>
        </div>
      </Card>
    );
  };

  const getEvidenceSummary = (evidence?: EvidenceUsed | null) => {
    if (!evidence) return null;

    const internalUsed =
      Boolean(evidence.internal?.knowledgeBaseUsed) ||
      Boolean(evidence.internal?.crossClaimUsed) ||
      Boolean(evidence.internal?.claimContextUsed) ||
      Boolean(evidence.internal?.uploadedDocumentUsed);
    const webUsed = Boolean(evidence.web?.searched && evidence.web?.status === "success");

    const kbSources = evidence.internal?.knowledgeSourceCount || 0;
    const claimFileCount = (evidence.internal as any)?.claimFileCount || 0;
    const externalSourceCount = (evidence.web as any)?.externalSourceCount || (webUsed ? 1 : 0);

    return {
      kbSources,
      claimFileCount,
      externalSourceCount,
      reason: evidence.decisionReason || "",
    };
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-lg z-50"
          size="icon"
        >
          {isClaimContext ? <Brain className="h-6 w-6" /> : <Sparkles className="h-6 w-6" />}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl w-[calc(100vw-2rem)] h-[600px] flex flex-col p-0">
        <DialogHeader className="px-6 py-4 border-b">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              {getIcon()}
              {getTitle()}
              {isClaimContext && claimNumber && (
                <span className="text-xs font-normal text-muted-foreground">
                  ({claimNumber})
                </span>
              )}
            </DialogTitle>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Toggle
                    size="sm"
                    pressed={sourceMode === "hybrid"}
                    onPressedChange={(pressed) => setSourceMode(pressed ? "hybrid" : "internal_only")}
                    className="h-7 px-2 data-[state=on]:bg-primary/10"
                  >
                    {sourceMode === "hybrid" ? (
                      <Globe className="h-3.5 w-3.5 mr-1" />
                    ) : (
                      <Database className="h-3.5 w-3.5 mr-1" />
                    )}
                    <span className="text-[10px]">{sourceMode === "hybrid" ? "Hybrid" : "Internal"}</span>
                  </Toggle>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs max-w-[200px]">
                    {sourceMode === "hybrid"
                      ? "Using internal claim docs + external knowledge base + web sources"
                      : "Using ONLY internal claim documents and database — no external sources"}
                  </p>
                </TooltipContent>
              </Tooltip>
              {aiMessages.length > 0 && (
                <Button variant="ghost" size="sm" onClick={clearChat}>
                  Clear
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 flex flex-col overflow-hidden">
          {aiMessages.length === 0 ? (
            <div className="flex-1 flex items-center justify-center p-6">
              {getHelpContent()}
            </div>
          ) : (
            <ScrollArea className="flex-1 p-4">
              <div className="space-y-4">
                {aiMessages.map((message, index) => (
                  <div
                    key={index}
                    className={`flex gap-3 ${
                      message.role === "user" ? "flex-row-reverse" : ""
                    }`}
                  >
                    <Avatar className="h-8 w-8 flex-shrink-0">
                      <AvatarFallback
                        className={
                          message.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted"
                        }
                      >
                        {message.role === "user" ? "U" : isClaimContext ? <Brain className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                      </AvatarFallback>
                    </Avatar>
                    <div
                      className={`max-w-[85%] p-4 rounded-lg text-sm ${
                        message.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted font-sans leading-relaxed"
                      }`}
                      style={{ overflowWrap: "break-word", wordBreak: "break-word" }}
                    >
                      {message.role === "user" ? (
                        <p className="whitespace-pre-wrap">{message.content}</p>
                      ) : (
                        <div className="space-y-3 text-[15px] text-foreground/95 font-normal">
                          {message.content.trim()
                            ? message.content
                                .split(/\n\n+/)
                                .filter((p) => p.trim())
                                .map((para, i) => (
                                  <p key={i} className="whitespace-pre-wrap mb-0 indent-0 first:mt-0 last:mb-0">
                                    {para.replace(/\*\*([^*]+)\*\*/g, "$1").trim()}
                                  </p>
                                ))
                            : ["No response."].map((t, i) => (
                                <p key={i} className="mb-0">{t}</p>
                              ))}
                          {Array.isArray(message.communicationDrafts) && message.communicationDrafts.length > 0 && (
                            <div className="space-y-2">
                              {message.communicationDrafts.map((draft) => (
                                <CommunicationDraftComposer
                                  key={draft.draftId}
                                  draft={draft}
                                  value={getDraftBody(draft)}
                                  onChange={(value) =>
                                    setDraftEdits((prev) => ({
                                      ...prev,
                                      [draft.draftId]: value,
                                    }))
                                  }
                                  onReset={() => resetDraftBody(draft.draftId)}
                                  onApprove={() => handleApproveAndSendDraft(draft)}
                                  isSending={Boolean(sendingDraftIds[draft.draftId])}
                                  isSent={Boolean(sentDraftIds[draft.draftId])}
                                />
                              ))}
                            </div>
                          )}
                          {(() => {
                            const evidence = getEvidenceSummary(message.evidenceUsed);
                            if (!evidence) return null;
                            return (
                              <div className="mt-3 space-y-1 rounded-md border bg-background/60 p-2">
                                <p className="text-[10px] font-medium text-muted-foreground mb-1">Evidence Sources</p>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Badge variant="secondary" className="text-[10px]">
                                    Internal KB: {evidence.kbSources}
                                  </Badge>
                                  <Badge variant="outline" className="text-[10px]">
                                    Claim Files: {evidence.claimFileCount}
                                  </Badge>
                                  <Badge variant="outline" className="text-[10px]">
                                    External Sources: {evidence.externalSourceCount}
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
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {aiLoading && (
                  <div className="flex gap-3">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-muted">
                        {isClaimContext ? <Brain className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                      </AvatarFallback>
                    </Avatar>
                    <div className="max-w-[85%] p-3 rounded-lg bg-muted" style={{ overflowWrap: "break-word", wordBreak: "break-word" }}>
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          )}

          <div className="p-4 border-t">
            <div className="flex gap-2">
              <Textarea
                placeholder={getPlaceholder()}
                value={aiQuestion}
                onChange={(e) => setAiQuestion(e.target.value)}
                onKeyDown={handleKeyDown}
                className="min-h-[60px] max-h-[120px] resize-none"
                disabled={aiLoading}
              />
              <Button
                onClick={handleAskAI}
                disabled={aiLoading || !aiQuestion.trim()}
                size="icon"
                className="h-[60px] w-[60px]"
              >
                {aiLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Send className="h-5 w-5" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};