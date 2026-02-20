import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Mail, Loader2, Sparkles, History } from "lucide-react";
import { DarwinStructuredRenderer } from "@/components/darwin/DarwinStructuredRenderer";
import { DarwinModeToggle } from "@/components/darwin/DarwinModeToggle";
import type { DarwinMode, DarwinStructuredResult } from "@/components/darwin/types";

interface DarwinCorrespondenceAnalyzerProps {
  claimId: string;
  claim: any;
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

export const DarwinCorrespondenceAnalyzer = ({ claimId }: DarwinCorrespondenceAnalyzerProps) => {
  const [correspondence, setCorrespondence] = useState("");
  const [previousResponses, setPreviousResponses] = useState("");
  const [analysis, setAnalysis] = useState<DarwinStructuredResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastAnalyzed, setLastAnalyzed] = useState<Date | null>(null);
  const [mode, setMode] = useState<DarwinMode>("rebuttal");
  const { toast } = useToast();

  // Load previous analysis on mount
  useEffect(() => {
    const loadPreviousAnalysis = async () => {
      const { data } = await supabase
        .from('darwin_analysis_results')
        .select('*')
        .eq('claim_id', claimId)
        .eq('analysis_type', 'correspondence')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (data) {
        const previousResult = parseStructuredResult(data.result);
        if (previousResult) {
          setAnalysis(previousResult);
        }
        setLastAnalyzed(new Date(data.created_at));
      }
    };

    loadPreviousAnalysis();
  }, [claimId]);

  const handleAnalyze = async () => {
    if (!correspondence.trim()) {
      toast({
        title: "Content required",
        description: "Please paste the adjuster correspondence to analyze",
        variant: "destructive"
      });
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('darwin-ai-analysis', {
        body: {
          claimId,
          analysisType: 'correspondence',
          content: correspondence,
          additionalContext: { previousResponses },
          mode,
        }
      });

      if (error) throw error;

      if (data?.error) {
        throw new Error(data.error);
      }

      const structuredResult = parseStructuredResult(data?.result ?? data);
      if (!structuredResult) {
        throw new Error("Darwin returned an invalid structured response");
      }
      setAnalysis(structuredResult);
      setLastAnalyzed(new Date());

      // Save the analysis result
      const { data: userData } = await supabase.auth.getUser();
      await supabase.from('darwin_analysis_results').insert({
        claim_id: claimId,
        analysis_type: 'correspondence',
        input_summary: correspondence.substring(0, 200),
        result: JSON.stringify(structuredResult, null, 2),
        created_by: userData.user?.id
      });

      toast({
        title: "Analysis complete",
        description: "Darwin has analyzed the correspondence"
      });
    } catch (error: any) {
      console.error("Correspondence analysis error:", error);
      toast({
        title: "Analysis failed",
        description: error.message || "Failed to analyze correspondence",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-blue-600" />
          Adjuster Correspondence Analyzer
        </CardTitle>
        <CardDescription>
          Analyze adjuster emails to understand tactics and get strategic response recommendations
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DarwinModeToggle value={mode} onChange={setMode} />

        {lastAnalyzed && (
          <div className="p-3 bg-muted/50 rounded-md text-sm text-muted-foreground flex items-center gap-2">
            <History className="h-4 w-4" />
            Previous analysis from {lastAnalyzed.toLocaleString()}
          </div>
        )}

        <div className="space-y-2">
          <label className="text-sm font-medium">Adjuster Email/Correspondence</label>
          <Textarea
            value={correspondence}
            onChange={(e) => setCorrespondence(e.target.value)}
            placeholder="Paste the adjuster's email or correspondence here..."
            className="min-h-[150px]"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Previous Responses (optional)</label>
          <Textarea
            value={previousResponses}
            onChange={(e) => setPreviousResponses(e.target.value)}
            placeholder="Paste any previous responses for context..."
            className="min-h-[80px]"
          />
        </div>

        <Button 
          onClick={handleAnalyze} 
          disabled={loading || !correspondence.trim()}
          className="w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Analyzing...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4 mr-2" />
              Analyze & Generate Response
            </>
          )}
        </Button>

        {analysis && (
          <div className="space-y-3 pt-4 border-t">
            <h4 className="font-medium">Structured Rebuttal Output</h4>
            <ScrollArea className="h-[520px] border rounded-md p-4 bg-muted/30">
              <DarwinStructuredRenderer result={analysis} />
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
};