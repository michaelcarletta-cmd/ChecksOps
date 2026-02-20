import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Compass, Loader2, RefreshCw, Target, History } from "lucide-react";
import { DarwinStructuredRenderer } from "@/components/darwin/DarwinStructuredRenderer";
import { DarwinModeToggle } from "@/components/darwin/DarwinModeToggle";
import type { DarwinMode, DarwinStructuredResult } from "@/components/darwin/types";

interface DarwinNextStepsProps {
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

export const DarwinNextSteps = ({ claimId, claim }: DarwinNextStepsProps) => {
  const [analysis, setAnalysis] = useState<DarwinStructuredResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastAnalyzed, setLastAnalyzed] = useState<Date | null>(null);
  const [claimAmount, setClaimAmount] = useState<number | null>(null);
  const [mode, setMode] = useState<DarwinMode>("rebuttal");
  const { toast } = useToast();

  // Load previous analysis and settlement data on mount
  useEffect(() => {
    const loadData = async () => {
      // Load previous Darwin analysis
      const { data: previousAnalysis } = await supabase
        .from('darwin_analysis_results')
        .select('*')
        .eq('claim_id', claimId)
        .eq('analysis_type', 'next_steps')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (previousAnalysis) {
        const previousResult = parseStructuredResult(previousAnalysis.result);
        if (previousResult) {
          setAnalysis(previousResult);
        }
        setLastAnalyzed(new Date(previousAnalysis.created_at));
      }

      // Load settlement data for claim amount
      const { data: settlement } = await supabase
        .from('claim_settlements')
        .select('total_settlement, replacement_cost_value')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (settlement) {
        // Use total_settlement if available, otherwise replacement_cost_value
        setClaimAmount(settlement.total_settlement || settlement.replacement_cost_value || null);
      } else {
        setClaimAmount(claim.claim_amount || null);
      }
    };

    loadData();
  }, [claimId, claim.claim_amount]);

  const handleAnalyze = async () => {
    setLoading(true);
    try {
      // Fetch timeline data to provide context
      const [tasksResult, inspectionsResult, emailsResult, checksResult] = await Promise.all([
        supabase.from('tasks').select('*').eq('claim_id', claimId).order('due_date'),
        supabase.from('inspections').select('*').eq('claim_id', claimId),
        supabase.from('emails').select('*').eq('claim_id', claimId).order('created_at', { ascending: false }).limit(5),
        supabase.from('claim_checks').select('*').eq('claim_id', claimId)
      ]);

      const timeline = {
        tasks: tasksResult.data || [],
        inspections: inspectionsResult.data || [],
        recentEmails: emailsResult.data || [],
        checksReceived: checksResult.data || []
      };

      const { data, error } = await supabase.functions.invoke('darwin-ai-analysis', {
        body: {
          claimId,
          analysisType: 'next_steps',
          additionalContext: { timeline },
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
        analysis_type: 'next_steps',
        result: JSON.stringify(structuredResult, null, 2),
        created_by: userData.user?.id
      });

      toast({
        title: "Analysis complete",
        description: "Darwin has analyzed your claim and provided recommendations"
      });
    } catch (error: any) {
      console.error("Next steps analysis error:", error);
      toast({
        title: "Analysis failed",
        description: error.message || "Failed to analyze claim",
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  const formatClaimAmount = () => {
    if (claimAmount !== null) {
      return `$${claimAmount.toLocaleString()}`;
    }
    return 'TBD';
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Compass className="h-5 w-5 text-primary" />
          Next Step Predictor
        </CardTitle>
        <CardDescription>
          AI-powered analysis of optimal next actions based on claim status, timeline, and industry knowledge
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DarwinModeToggle value={mode} onChange={setMode} />

        <div className="flex items-center justify-between">
          <div className="space-y-1">
            {lastAnalyzed && (
              <p className="text-sm text-muted-foreground flex items-center gap-1">
                <History className="h-3 w-3" />
                Last analyzed: {lastAnalyzed.toLocaleString()}
              </p>
            )}
            {!lastAnalyzed && (
              <p className="text-sm text-muted-foreground">
                Click analyze to get AI recommendations
              </p>
            )}
          </div>
          <Button onClick={handleAnalyze} disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                {analysis ? "Refresh Analysis" : "Analyze Claim"}
              </>
            )}
          </Button>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="p-3 bg-muted/50 rounded-lg text-center">
            <div className="text-2xl font-bold text-primary">{claim.status || 'N/A'}</div>
            <div className="text-xs text-muted-foreground">Current Status</div>
          </div>
          <div className="p-3 bg-muted/50 rounded-lg text-center">
            <div className="text-2xl font-bold">{claim.loss_date ? Math.floor((Date.now() - new Date(claim.loss_date).getTime()) / (1000 * 60 * 60 * 24)) : 'N/A'}</div>
            <div className="text-xs text-muted-foreground">Days Since Loss</div>
          </div>
          <div className="p-3 bg-muted/50 rounded-lg text-center">
            <div className="text-2xl font-bold">{claim.created_at ? Math.floor((Date.now() - new Date(claim.created_at).getTime()) / (1000 * 60 * 60 * 24)) : 'N/A'}</div>
            <div className="text-xs text-muted-foreground">Days Open</div>
          </div>
          <div className="p-3 bg-muted/50 rounded-lg text-center">
            <div className="text-2xl font-bold">{formatClaimAmount()}</div>
            <div className="text-xs text-muted-foreground">Claim Amount</div>
          </div>
        </div>

        {analysis && (
          <div className="space-y-3 pt-4 border-t">
            <h4 className="font-medium flex items-center gap-2">
              <Target className="h-4 w-4" />
              AI Recommendations
            </h4>
            <ScrollArea className="h-[520px] border rounded-md p-4 bg-muted/30">
              <DarwinStructuredRenderer result={analysis} />
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
};