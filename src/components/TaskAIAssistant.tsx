import { useState } from "react";
import { Brain, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { DarwinStructuredRenderer } from "@/components/darwin/DarwinStructuredRenderer";
import { DarwinModeToggle } from "@/components/darwin/DarwinModeToggle";
import type { DarwinMode, DarwinStructuredResult } from "@/components/darwin/types";

interface TaskAIAssistantProps {
  task: {
    id: string;
    title: string;
    description: string | null;
    due_date: string | null;
    status: string;
    priority: string;
    follow_up_enabled?: boolean | null;
    follow_up_interval_days?: number | null;
    follow_up_current_count?: number | null;
    follow_up_last_sent_at?: string | null;
  };
  claimId: string;
  onTaskUpdated?: () => void;
}

interface ClaimData {
  id: string;
  claim_number: string | null;
}

const parseStructuredResult = (value: unknown): DarwinStructuredResult | null => {
  const parsedValue =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        })()
      : value;

  if (!parsedValue || typeof parsedValue !== "object") return null;

  const candidate = parsedValue as Partial<DarwinStructuredResult>;
  if (typeof candidate.steelman_opponent !== "string") return null;
  if (!candidate.talking_points || typeof candidate.talking_points !== "object") return null;
  return parsedValue as DarwinStructuredResult;
};

const TaskAIAssistant = ({ task, claimId }: TaskAIAssistantProps) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<DarwinStructuredResult | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [claimData, setClaimData] = useState<ClaimData | null>(null);
  const [mode, setMode] = useState<DarwinMode>("scripts");
  const { toast } = useToast();

  const handleAnalyzeTask = async () => {
    setLoading(true);
    setAnalysis(null);

    try {
      const { data: claim, error: claimError } = await supabase
        .from("claims")
        .select("*")
        .eq("id", claimId)
        .single();

      if (claimError) throw claimError;
      setClaimData(claim);

      const { data, error } = await supabase.functions.invoke("darwin-ai-analysis", {
        body: {
          claimId,
          analysisType: "task_followup",
          additionalContext: {
            task: {
              title: task.title,
              description: task.description,
              due_date: task.due_date,
              status: task.status,
              priority: task.priority,
            },
            claim,
            customPrompt: customPrompt || undefined,
          },
          mode,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const structuredResult = parseStructuredResult(data?.result ?? data);
      if (!structuredResult) {
        throw new Error("Darwin returned an invalid structured response");
      }
      setAnalysis(structuredResult);
      toast({
        title: "Analysis complete",
        description: "Darwin generated structured task guidance",
      });
    } catch (error) {
      console.error("Error analyzing task:", error);
      toast({
        title: "Analysis failed",
        description: "Failed to analyze task",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title="AI Follow-up Assistant">
          <Brain className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            AI Task Follow-up Assistant
          </DialogTitle>
          <DialogDescription>
            Darwin will generate a structured strategy for: <strong>{task.title}</strong>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            <div className="font-medium">Task: {task.title}</div>
            {task.description && (
              <div className="mt-1 text-muted-foreground">{task.description}</div>
            )}
            <div className="mt-2 flex flex-wrap gap-4 text-muted-foreground">
              <span>Claim: {claimData?.claim_number || claimId.slice(0, 8)}</span>
              <span>Priority: {task.priority}</span>
              {task.due_date && <span>Due: {new Date(task.due_date).toLocaleDateString()}</span>}
            </div>
          </div>

          <DarwinModeToggle value={mode} onChange={setMode} />

          <div className="space-y-2">
            <label className="text-sm font-medium">Additional context (optional)</label>
            <Textarea
              placeholder="Add any specific instructions or context for the follow-up..."
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={3}
            />
          </div>

          <Button onClick={handleAnalyzeTask} disabled={loading} className="w-full">
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Brain className="mr-2 h-4 w-4" />
                Generate Follow-up Strategy
              </>
            )}
          </Button>

          {analysis && (
            <div className="space-y-2 border-t pt-4">
              <h4 className="font-medium">Structured Rebuttal Output</h4>
              <ScrollArea className="h-[460px] rounded-lg border p-4 bg-muted/30">
                <DarwinStructuredRenderer result={analysis} />
              </ScrollArea>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default TaskAIAssistant;
