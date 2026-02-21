import { useState } from "react";
import { MessageSquare, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";

interface DarwinCommandBarProps {
  claimId: string;
  claim?: { claim_number?: string } | null;
  placeholder?: string;
  className?: string;
}

type CommandState = "idle" | "loading" | "success" | "error";

export function DarwinCommandBar({
  claimId,
  claim,
  placeholder = "Hey Darwin… run an analysis, write a case study, or ask a financial question…",
  className,
}: DarwinCommandBarProps) {
  const { user } = useAuth();
  const [input, setInput] = useState("");
  const [state, setState] = useState<CommandState>("idle");
  const [response, setResponse] = useState<{
    intent?: string;
    answer?: string;
    result?: string;
    message?: string;
    error?: string;
    assetId?: string | null;
    redacted?: boolean;
  } | null>(null);

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text) return;
    setState("loading");
    setResponse(null);
    try {
      const { data, error } = await supabase.functions.invoke("darwin-command", {
        body: { commandText: text, claimId, createdBy: user?.id },
      });
      if (error) throw error;
      setResponse(data ?? null);
      setState(data?.error ? "error" : "success");
      if (data?.error) toast.error(data.error);
      else if (data?.assetId) toast.success("Saved to knowledge base.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Command failed";
      setResponse({ error: msg });
      setState("error");
      toast.error(msg);
    }
  };

  const displayText =
    response?.answer ??
    (response?.result && response.result.length > 0 ? response.result : null) ??
    response?.message ??
    response?.error;

  return (
    <Card className={className}>
      <CardContent className="p-3">
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={placeholder}
            className="min-h-[72px] resize-none"
            disabled={state === "loading"}
            rows={2}
          />
          <Button
            onClick={handleSubmit}
            disabled={state === "loading" || !input.trim()}
            className="shrink-0 self-end"
          >
            {state === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <MessageSquare className="h-4 w-4" />
            )}
          </Button>
        </div>
        {state !== "idle" && (
          <div className="mt-3 rounded-md border bg-muted/30 p-3 text-sm">
            {state === "loading" && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Running command…
              </div>
            )}
            {state === "success" && displayText && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-primary">
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  {response?.intent && (
                    <span className="font-medium capitalize">{response.intent.replace(/_/g, " ")}</span>
                  )}
                </div>
                <div className="text-muted-foreground whitespace-pre-wrap break-words">
                  {displayText}
                </div>
                {response?.assetId && (
                  <p className="text-xs text-muted-foreground">
                    Saved to Knowledge Base. Asset ID: {response.assetId}
                  </p>
                )}
              </div>
            )}
            {state === "error" && displayText && (
              <div className="flex items-start gap-2 text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{displayText}</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
