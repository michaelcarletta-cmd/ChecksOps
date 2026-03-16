import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Mail, Loader2, Copy, Send, Sparkles, AlertTriangle } from "lucide-react";
import { useDeclaredPosition } from "@/hooks/useDeclaredPosition";
import { PositionGateBanner } from "./PositionGateBanner";

interface DarwinCarrierEmailDrafterProps {
  claimId: string;
  claim: any;
}

const EMAIL_TYPES = [
  { value: "status_inquiry", label: "Status Inquiry", description: "Request update on claim status" },
  { value: "document_submission", label: "Document Submission", description: "Cover letter for submitted documents" },
  { value: "deadline_reminder", label: "Deadline Reminder", description: "Remind carrier of regulatory deadlines" },
  { value: "payment_follow_up", label: "Payment Follow-Up", description: "Follow up on pending payment" },
  { value: "dispute_response", label: "Dispute Response", description: "Respond to carrier dispute or denial" },
  { value: "inspection_request", label: "Inspection Request", description: "Request re-inspection or joint inspection" },
  { value: "supplement_submission", label: "Supplement Submission", description: "Submit supplemental claim documents" },
  { value: "bad_faith_warning", label: "Bad Faith Warning", description: "Formal notice of potential bad faith" },
];

async function logProvisionalOverride(claimId: string) {
  try {
    const { data: userData } = await supabase.auth.getUser();
    await supabase.from("darwin_declared_position_audit_logs" as any).insert({
      claim_id: claimId,
      user_id: userData.user?.id ?? null,
      action: "provisional_override_used",
      before_json: null,
      after_json: { source: "carrier_email_drafter" },
    } as any);
  } catch (err) {
    console.error("Provisional override audit log failed:", err);
  }
}

export const DarwinCarrierEmailDrafter = ({ claimId, claim }: DarwinCarrierEmailDrafterProps) => {
  const { toast } = useToast();
  const [emailType, setEmailType] = useState("");
  const [additionalContext, setAdditionalContext] = useState("");
  const [generatedSubject, setGeneratedSubject] = useState("");
  const [generatedBody, setGeneratedBody] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [provisionalOverride, setProvisionalOverride] = useState(false);

  const {
    position,
    loading: positionLoading,
    isLocked,
    isStrategicLocked,
    isLitigationGrade,
  } = useDeclaredPosition(claimId);

  const canGenerate = isStrategicLocked || isLitigationGrade;
  const isProvisionalMode = !canGenerate && provisionalOverride;

  const buildPositionPayload = () => {
    if (!position) return null;
    return {
      lock_status: position.lock_status,
      observed_damage_condition: position.observed_damage_condition,
      primary_loss_mechanism: position.primary_loss_mechanism,
      coverage_trigger_theory: position.coverage_trigger_theory,
      specific_carrier_failure: position.specific_carrier_failure,
      decisive_contradiction: position.decisive_contradiction,
      requested_remedy: position.requested_remedy,
      master_position_statement: position.master_position_statement,
      position_strength_score: position.position_strength_score,
      position_strength_label: position.position_strength_label,
      drift_risk: position.drift_risk,
      known_weaknesses: position.known_weaknesses,
      missing_proof_needed: position.missing_proof_needed,
      key_supporting_evidence: position.key_supporting_evidence,
      policy_standard_support: position.policy_standard_support,
      carrier_evidence_rebutted: position.carrier_evidence_rebutted,
      provisional_override: isProvisionalMode,
      provisional_reason: isProvisionalMode
        ? "Strategic lock bypassed by adjuster for urgent output."
        : null,
      // Legacy fields for backwards compat
      primary_cause_of_loss: position.primary_loss_mechanism || position.primary_cause_of_loss,
      primary_coverage_theory: position.coverage_trigger_theory || position.primary_coverage_theory,
      primary_carrier_error: position.specific_carrier_failure || position.primary_carrier_error,
      carrier_dependency_statement: position.decisive_contradiction || position.carrier_dependency_statement,
    };
  };

  const handleGenerate = async () => {
    if (!emailType) {
      toast({ title: "Select email type", description: "Please select the type of email you want to generate", variant: "destructive" });
      return;
    }

    // Log provisional override before invoking
    if (isProvisionalMode) {
      await logProvisionalOverride(claimId);
    }

    setIsGenerating(true);
    try {
      const declaredPositionPayload = buildPositionPayload();

      const { data, error } = await supabase.functions.invoke("darwin-ai-analysis", {
        body: {
          claimId,
          analysisType: "carrier_email_draft",
          additionalContext: {
            emailType,
            userContext: additionalContext,
            emailTypeLabel: EMAIL_TYPES.find(t => t.value === emailType)?.label,
            declaredPosition: declaredPositionPayload,
            provisionalPosition: isProvisionalMode,
          },
          claim,
        },
      });

      if (error) throw error;

      if (data?.result) {
        const result = data.result;
        const subjectMatch = result.match(/SUBJECT:\s*(.+?)(?:\n|$)/i);
        const bodyMatch = result.match(/BODY:\s*([\s\S]+)/i);

        let subject = subjectMatch ? subjectMatch[1].trim() : "";
        let body = bodyMatch ? bodyMatch[1].trim() : result;

        // Prepend provisional markers
        if (isProvisionalMode) {
          subject = `[PROVISIONAL] ${subject}`;
          body = `PROVISIONAL DRAFT — generated without strategic lock. Use with caution and review before sending.\n\n${body}`;
        }

        setGeneratedSubject(subject);
        setGeneratedBody(body);

        toast({ title: "Email drafted", description: "Darwin has generated your carrier communication" });
      }
    } catch (error: any) {
      console.error("Error generating email:", error);
      toast({ title: "Generation failed", description: error.message || "Failed to generate email", variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = () => {
    const fullEmail = `Subject: ${generatedSubject}\n\n${generatedBody}`;
    navigator.clipboard.writeText(fullEmail);
    toast({ title: "Copied", description: "Email copied to clipboard" });
  };

  const handleSendToComposer = () => {
    sessionStorage.setItem("draftEmail", JSON.stringify({
      subject: generatedSubject,
      body: generatedBody,
      to: claim.adjuster_email || claim.insurance_email || "",
    }));
    toast({ title: "Ready to send", description: "Email loaded into composer. Navigate to Communications to send." });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-primary" />
          AI Carrier Email Drafter
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canGenerate && !provisionalOverride && (
          <PositionGateBanner
            lockStatus={position?.lock_status || "draft"}
            loading={positionLoading}
            onProceedProvisional={() => setProvisionalOverride(true)}
            allowProvisional
          />
        )}

        {isProvisionalMode && (
          <Alert className="border-orange-500/50 bg-orange-50 dark:bg-orange-950/20">
            <AlertTriangle className="h-4 w-4 text-orange-600" />
            <AlertDescription className="text-xs">
              <strong>Provisional Mode Active</strong> — Output will be marked as provisional.
              Strategic lock is bypassed. Review carefully before sending to carrier.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Email Type</Label>
            <Select value={emailType} onValueChange={setEmailType}>
              <SelectTrigger>
                <SelectValue placeholder="Select email type..." />
              </SelectTrigger>
              <SelectContent>
                {EMAIL_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    <div className="flex flex-col">
                      <span>{type.label}</span>
                      <span className="text-xs text-muted-foreground">{type.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Additional Context (optional)</Label>
            <Textarea
              placeholder="Any specific points to address, deadlines to reference, or tone preferences..."
              value={additionalContext}
              onChange={(e) => setAdditionalContext(e.target.value)}
              className="h-20"
            />
          </div>
        </div>

        <Button onClick={handleGenerate} disabled={isGenerating || !emailType} className="w-full">
          {isGenerating ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Darwin is drafting...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4 mr-2" />
              Generate Email
            </>
          )}
        </Button>

        {generatedSubject && (
          <div className="space-y-4 pt-4 border-t">
            <div className="space-y-2">
              <Label>Subject</Label>
              <Input value={generatedSubject} onChange={(e) => setGeneratedSubject(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Body</Label>
              <Textarea
                value={generatedBody}
                onChange={(e) => setGeneratedBody(e.target.value)}
                className="min-h-[300px] font-mono text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleCopy}>
                <Copy className="h-4 w-4 mr-2" />
                Copy to Clipboard
              </Button>
              <Button onClick={handleSendToComposer}>
                <Send className="h-4 w-4 mr-2" />
                Load into Composer
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
