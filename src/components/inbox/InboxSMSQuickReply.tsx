import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Send } from "lucide-react";
import { MergeFieldButtons } from "@/components/MergeFieldButtons";
import { useInsertAtCursor } from "@/hooks/useInsertAtCursor";

interface InboxSMSQuickReplyProps {
  claimId: string;
  toNumber: string;
  onSent: () => void;
}

export const InboxSMSQuickReply = ({ claimId, toNumber, onSent }: InboxSMSQuickReplyProps) => {
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const { toast } = useToast();
  const { textareaRef, insertAtCursor } = useInsertAtCursor(message, setMessage);

  const handleSend = async () => {
    if (!message.trim()) return;
    
    setIsSending(true);
    try {
      const { error } = await supabase.functions.invoke("send-sms", {
        body: {
          toNumber,
          messageBody: message.trim(),
          claimId,
        },
      });

      if (error) throw error;

      toast({
        title: "SMS sent",
        description: "Your reply has been sent successfully.",
      });
      setMessage("");
      onSent();
    } catch (error: any) {
      toast({
        title: "Failed to send SMS",
        description: error.message || "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="space-y-2 mt-3">
      <MergeFieldButtons compact onInsert={insertAtCursor} />
      <div className="flex gap-2">
        <Textarea
          ref={textareaRef}
          placeholder="Type your reply..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="min-h-[60px] resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <Button
          onClick={handleSend}
          disabled={isSending || !message.trim()}
          size="icon"
          className="h-[60px] w-[60px]"
        >
          {isSending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
};
