import { useState } from "react";
import { Copy, Check, Mail, MessageSquare, AlertCircle, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { DraftData } from "@/hooks/useDarwinCopilot";
import { toast } from "sonner";

interface DraftRendererProps {
  draftData: DraftData;
}

export function DraftRenderer({ draftData }: DraftRendererProps) {
  const { type, facts, draft } = draftData;
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedDraft, setEditedDraft] = useState(draft);
  const [showFacts, setShowFacts] = useState(true);

  const isSms = type === 'sms';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(editing ? editedDraft : draft);
      setCopied(true);
      toast.success(`${isSms ? 'SMS' : 'Email'} draft copied to clipboard`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  };

  const noCorrespondence = !facts.has_correspondence && !facts.has_notes;

  // Key facts to display
  const factItems = [
    { label: "Claim Status", value: facts.claim_status, highlight: true },
    { label: "Carrier", value: facts.carrier },
    { label: "Property", value: facts.property_address },
    { label: "Loss Date", value: facts.loss_date },
    { label: "Last Contact", value: facts.last_contact_date !== 'No recent contact' ? `${facts.last_contact_date} — ${facts.last_contact_with}` : null },
    { label: "Last Subject", value: facts.last_contact_subject !== 'N/A' ? facts.last_contact_subject : null },
    { label: "Latest Note", value: facts.latest_note !== 'No notes' ? facts.latest_note : null },
    { label: "Next Action", value: facts.next_action },
  ].filter(item => item.value && item.value !== 'N/A');

  const pendingDeadlines = facts.pending_deadlines || [];

  return (
    <div className="space-y-2">
      {/* Facts Card */}
      <Card className="border-primary/20 bg-primary/5">
        <CardHeader className="py-2 px-3 cursor-pointer" onClick={() => setShowFacts(!showFacts)}>
          <div className="flex items-center justify-between">
            <CardTitle className="text-[11px] font-semibold flex items-center gap-1.5">
              <AlertCircle className="h-3 w-3 text-primary" />
              Claim Analysis
            </CardTitle>
            <div className="flex items-center gap-1">
              <Badge variant="secondary" className="text-[9px] px-1 py-0">
                {facts.claim_number}
              </Badge>
              {showFacts ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </div>
          </div>
        </CardHeader>
        {showFacts && (
          <CardContent className="px-3 pb-2 pt-0">
            <div className="space-y-1">
              {factItems.map((item, i) => (
                <div key={i} className="flex gap-2 text-[10px]">
                  <span className="text-muted-foreground shrink-0 w-[80px]">{item.label}:</span>
                  <span className={cn(
                    "flex-1 break-words",
                    item.highlight && "font-medium text-primary"
                  )}>
                    {item.value}
                  </span>
                </div>
              ))}
              {pendingDeadlines.length > 0 && (
                <div className="flex gap-2 text-[10px]">
                  <span className="text-muted-foreground shrink-0 w-[80px]">Deadlines:</span>
                  <span className="flex-1 text-destructive font-medium">
                    {pendingDeadlines.join('; ')}
                  </span>
                </div>
              )}
            </div>

            {noCorrespondence && (
              <div className="mt-2 p-1.5 rounded bg-destructive/10 border border-destructive/20">
                <p className="text-[10px] text-destructive">
                  No recent correspondence found. Draft is based on claim metadata and status only. Consider adding notes with specific context for a more accurate draft.
                </p>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Draft Card */}
      <Card className="border-muted">
        <CardHeader className="py-2 px-3">
          <CardTitle className="text-[11px] font-semibold flex items-center gap-1.5">
            {isSms ? <MessageSquare className="h-3 w-3" /> : <Mail className="h-3 w-3" />}
            {isSms ? 'SMS Draft' : 'Email Draft'}
            {isSms && (
              <Badge variant="outline" className="text-[9px] px-1 py-0 ml-auto">
                {(editing ? editedDraft : draft).length}/320 chars
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-2 pt-0">
          {editing ? (
            <Textarea
              value={editedDraft}
              onChange={(e) => setEditedDraft(e.target.value)}
              className="text-[11px] min-h-[80px] resize-y"
              maxLength={isSms ? 320 : undefined}
            />
          ) : (
            <div className="text-[11px] whitespace-pre-wrap leading-relaxed bg-muted/30 rounded p-2 border border-border/50">
              {draft}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-1.5 mt-2">
            <Button
              size="sm"
              variant="default"
              className="h-6 text-[10px] gap-1 flex-1"
              onClick={handleCopy}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied!' : 'Copy to Clipboard'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[10px] gap-1"
              onClick={() => {
                if (editing) setEditedDraft(draft); // reset on cancel
                setEditing(!editing);
              }}
            >
              {editing ? 'Cancel' : 'Edit'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
