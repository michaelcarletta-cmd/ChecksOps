import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, Loader2, Mail, MessageSquare, Sparkles } from "lucide-react";

export interface CommunicationDraftRecipient {
  name: string;
  type: string;
  email?: string;
  phone?: string;
}

export interface CommunicationDraft {
  draftId: string;
  channel: "email" | "sms";
  claimId: string;
  claimReference: string;
  subject?: string;
  body: string;
  claimEmailCc?: string;
  photoEstimateEvidenceApplied?: boolean;
  recipients: CommunicationDraftRecipient[];
}

interface CommunicationDraftComposerProps {
  draft: CommunicationDraft;
  value: string;
  onChange: (value: string) => void;
  onReset: () => void;
  onApprove: () => void | Promise<void>;
  isSending: boolean;
  isSent: boolean;
}

export const CommunicationDraftComposer = ({
  draft,
  value,
  onChange,
  onReset,
  onApprove,
  isSending,
  isSent,
}: CommunicationDraftComposerProps) => {
  const isEmail = draft.channel === "email";
  const recipientLabel = draft.recipients
    .map((recipient) => {
      if (recipient.email) return `${recipient.name} <${recipient.email}>`;
      if (recipient.phone) return `${recipient.name} (${recipient.phone})`;
      return recipient.name;
    })
    .join(", ");

  return (
    <Card className="mt-3 border-primary/30 bg-background/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
          {isEmail ? (
            <>
              <Mail className="mr-1 h-3 w-3" />
              Email Draft
            </>
          ) : (
            <>
              <MessageSquare className="mr-1 h-3 w-3" />
              Text Draft
            </>
          )}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          Claim: {draft.claimReference}
        </Badge>
        {draft.photoEstimateEvidenceApplied && (
          <Badge variant="outline" className="text-[10px] text-primary border-primary/40">
            <Sparkles className="mr-1 h-3 w-3" />
            Photo + Estimate Evidence Applied
          </Badge>
        )}
        {isSent && (
          <Badge variant="outline" className="text-[10px] text-green-600 border-green-400/40">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            Sent
          </Badge>
        )}
      </div>

      <p className="mt-2 text-xs text-muted-foreground break-words">
        To: {recipientLabel || "Unknown recipient"}
      </p>
      {isEmail && draft.subject && (
        <p className="mt-1 text-xs text-muted-foreground break-words">
          Subject: {draft.subject}
        </p>
      )}

      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 min-h-[120px] text-sm"
        disabled={isSending || isSent}
      />

      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onReset}
          disabled={isSending || isSent}
        >
          Reset
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onApprove}
          disabled={isSending || isSent || !value.trim()}
        >
          {isSending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Sending...
            </>
          ) : isSent ? (
            "Sent"
          ) : (
            "Approve & Send"
          )}
        </Button>
      </div>
    </Card>
  );
};
