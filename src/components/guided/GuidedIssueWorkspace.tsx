import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, Copy, Check, Mail, ExternalLink, CheckCircle2, AlertCircle } from "lucide-react";

interface Props {
  claimId: string;
  taskType: string;
  onBack: () => void;
}

interface DraftData {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  short_body?: string;
  recommended_attachments: string[];
  issue_summary: string;
  assumptions: string[];
  verify_before_sending: string[];
}

interface AnalysisData {
  analysis: string;
}

const TASK_LABELS: Record<string, string> = {
  respond_to_email: "Respond to Carrier Email",
  challenge_estimate: "Challenge Estimate / Scope",
  respond_to_denial: "Respond to Denial",
  repairability_issue: "Explain Repairability Issue",
  send_contractor_estimate: "Send Contractor Estimate",
  request_reconsideration: "Request Reconsideration",
  request_reinspect: "Request Reinspection",
  follow_up_delay: "Follow Up on Delay",
  respond_to_engineer: "Respond to Engineer Report",
};

type WorkspaceStep = "context" | "analysis" | "draft" | "pre_send" | "sent";

export function GuidedIssueWorkspace({ claimId, taskType, onBack }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState<WorkspaceStep>("context");
  const [context, setContext] = useState("");
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftData | null>(null);
  const [editedBody, setEditedBody] = useState("");
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [attachmentChecks, setAttachmentChecks] = useState<Record<string, boolean>>({});
  const [sentTo, setSentTo] = useState("");
  const [commId, setCommId] = useState<string | null>(null);

  const handleAnalyze = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("darwin-guided-mode", {
        body: { action: "analyze_issue", claimId, taskType, context },
      });
      if (error) throw error;
      setAnalysis(data.analysis || JSON.stringify(data, null, 2));
      setStep("analysis");
    } catch (err: any) {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleDraft = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("darwin-guided-mode", {
        body: { action: "draft_communication", claimId, taskType, context },
      });
      if (error) throw error;

      const draftData: DraftData = {
        to: data.to || "User must fill in",
        cc: data.cc || undefined,
        subject: data.subject || `Re: Claim ${taskType}`,
        body: data.body || data.raw_text || "",
        short_body: data.short_body || undefined,
        recommended_attachments: data.recommended_attachments || [],
        issue_summary: data.issue_summary || "",
        assumptions: data.assumptions || [],
        verify_before_sending: data.verify_before_sending || [],
      };

      setDraft(draftData);
      setEditedBody(draftData.body);
      setSentTo(draftData.to);

      // Save as guided communication
      const { data: comm } = await supabase.from("guided_communications").insert({
        claim_id: claimId,
        user_id: user!.id,
        comm_type: "email",
        recipient_email: draftData.to,
        cc_email: draftData.cc,
        subject: draftData.subject,
        body: draftData.body,
        short_body: draftData.short_body,
        status: "drafted",
        recommended_attachments: draftData.recommended_attachments,
        issue_summary: draftData.issue_summary,
        task_type: taskType,
        analysis: { assumptions: draftData.assumptions, verify: draftData.verify_before_sending },
      }).select().single();

      if (comm) setCommId(comm.id);

      setStep("draft");
    } catch (err: any) {
      toast({ title: "Draft failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(editing ? editedBody : (draft?.body || ""));
      setCopied(true);
      toast({ title: "Copied", description: "Email body copied to clipboard." });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  const handleOpenInEmail = () => {
    if (!draft) return;
    const body = editing ? editedBody : draft.body;
    const isLong = body.length > 1500;

    if (isLong) {
      toast({
        title: "Long message",
        description: "This draft may not prefill cleanly in all email apps. Copy and paste may work better.",
      });
    }

    const mailto = `mailto:${encodeURIComponent(draft.to)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(body)}${draft.cc ? `&cc=${encodeURIComponent(draft.cc)}` : ""}`;
    window.open(mailto, "_blank");
    setStep("pre_send");
  };

  const handleMarkAsSent = async () => {
    if (commId) {
      await supabase.from("guided_communications").update({
        status: "sent",
        sent_to: sentTo,
        sent_at: new Date().toISOString(),
        marked_sent_at: new Date().toISOString(),
        actual_attachments: Object.entries(attachmentChecks).filter(([, v]) => v).map(([k]) => k),
        body: editing ? editedBody : draft?.body,
      }).eq("id", commId);
    }
    setStep("sent");
    toast({ title: "Marked as sent", description: "Darwin will track this and guide your next step." });
  };

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h2 className="text-lg font-bold text-foreground">{TASK_LABELS[taskType] || taskType}</h2>
          <p className="text-xs text-muted-foreground">Darwin Guided Claim Mode</p>
        </div>
      </div>

      {/* Step: Context */}
      {step === "context" && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-base text-foreground">Describe the Issue</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              value={context}
              onChange={e => setContext(e.target.value)}
              placeholder="Tell Darwin what's happening. For example: 'The carrier denied my roof claim saying the damage is from wear and tear, but we had a documented hail storm on March 15th...' The more detail you provide, the stronger the communication."
              rows={5}
            />
            <Button onClick={handleAnalyze} disabled={loading} className="w-full">
              {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Analyze Issue
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step: Analysis */}
      {step === "analysis" && analysis && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-base text-foreground flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-primary" />
              Darwin's Analysis
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="prose prose-sm prose-invert max-w-none text-sm text-foreground whitespace-pre-wrap bg-muted/30 rounded-lg p-4 border border-border">
              {analysis}
            </div>
            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep("context")}>Revise Context</Button>
              <Button onClick={handleDraft} disabled={loading} className="flex-1">
                {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Generate Draft Communication
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Draft */}
      {step === "draft" && draft && (
        <div className="space-y-4">
          {/* Microcopy */}
          <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
            <p className="text-xs text-foreground">
              <strong>Send this yourself.</strong> Darwin prepared this message for you. It will open in your own email app so you can review, attach documents, and send it as the policyholder.
            </p>
          </div>

          {/* Draft card */}
          <Card className="border-border bg-card">
            <CardHeader>
              <div className="space-y-2">
                <div className="flex gap-2 text-xs">
                  <span className="text-muted-foreground w-16">To:</span>
                  <span className="text-foreground">{draft.to}</span>
                </div>
                {draft.cc && (
                  <div className="flex gap-2 text-xs">
                    <span className="text-muted-foreground w-16">CC:</span>
                    <span className="text-foreground">{draft.cc}</span>
                  </div>
                )}
                <div className="flex gap-2 text-xs">
                  <span className="text-muted-foreground w-16">Subject:</span>
                  <span className="text-foreground font-medium">{draft.subject}</span>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {editing ? (
                <Textarea
                  value={editedBody}
                  onChange={e => setEditedBody(e.target.value)}
                  className="min-h-[200px] text-sm"
                />
              ) : (
                <div className="text-sm whitespace-pre-wrap leading-relaxed bg-muted/20 rounded-lg p-4 border border-border text-foreground">
                  {draft.body}
                </div>
              )}

              {/* Assumptions */}
              {draft.assumptions.length > 0 && (
                <div className="border border-warning/30 bg-warning/10 rounded p-3">
                  <p className="text-xs font-medium text-warning mb-1">Assumptions Used</p>
                  {draft.assumptions.map((a, i) => (
                    <p key={i} className="text-xs text-foreground">• {a}</p>
                  ))}
                </div>
              )}

              {/* Verify before sending */}
              {draft.verify_before_sending.length > 0 && (
                <div className="border border-primary/30 bg-primary/5 rounded p-3">
                  <p className="text-xs font-medium text-primary mb-1">Verify Before Sending</p>
                  {draft.verify_before_sending.map((v, i) => (
                    <p key={i} className="text-xs text-foreground">✓ {v}</p>
                  ))}
                </div>
              )}

              {/* Recommended attachments */}
              {draft.recommended_attachments.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">Recommended Attachments</p>
                  <div className="space-y-1">
                    {draft.recommended_attachments.map((att, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Checkbox
                          checked={attachmentChecks[att] || false}
                          onCheckedChange={checked => setAttachmentChecks(prev => ({ ...prev, [att]: !!checked }))}
                        />
                        <span className="text-xs text-foreground">{att}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Button onClick={handleOpenInEmail} className="gap-1">
                  <ExternalLink className="h-3 w-3" />
                  Open in Email
                </Button>
                <Button variant="outline" onClick={handleCopy} className="gap-1">
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setEditing(!editing); if (editing) setEditedBody(draft.body); }}
                >
                  {editing ? "Cancel Edit" : "Edit"}
                </Button>
                <Button variant="outline" onClick={() => setStep("analysis")}>
                  Back
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Step: Pre-send confirmation */}
      {step === "pre_send" && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-base text-foreground">Mark as Sent</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Once you've sent it, mark it here so Darwin can track the claim and guide the next step.
            </p>

            <div className="space-y-3">
              <div className="space-y-2">
                <Label className="text-xs">Sent To</Label>
                <Input value={sentTo} onChange={e => setSentTo(e.target.value)} placeholder="recipient@email.com" />
              </div>

              {draft?.recommended_attachments && draft.recommended_attachments.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2">Attachments Included</p>
                  {draft.recommended_attachments.map((att, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Checkbox
                        checked={attachmentChecks[att] || false}
                        onCheckedChange={checked => setAttachmentChecks(prev => ({ ...prev, [att]: !!checked }))}
                      />
                      <span className="text-xs text-foreground">{att}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep("draft")}>Back to Draft</Button>
              <Button onClick={handleMarkAsSent} className="flex-1">
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Mark as Sent
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Sent confirmation */}
      {step === "sent" && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="py-12 text-center space-y-4">
            <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
            <div>
              <h3 className="text-lg font-bold text-foreground">Communication Sent</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Darwin is tracking this. When the carrier responds, upload their reply so Darwin can help with your next step.
              </p>
            </div>
            <Button onClick={onBack}>Return to Claim Dashboard</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
