import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Loader2, Copy, ArrowLeftRight, AlertTriangle, CheckCircle2, MinusCircle, PlusCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useClaimFiles } from "@/hooks/useClaimFiles";
import { ClaimFileSelector } from "./ClaimFileSelector";
import { cn } from "@/lib/utils";

interface DarwinEstimateComparisonProps {
  claimId: string;
  claim: any;
}

interface ComparisonLineItem {
  code: string;
  description: string;
  carrier_qty: number | null;
  carrier_unit: string | null;
  carrier_total: number | null;
  our_qty: number | null;
  our_unit: string | null;
  our_total: number | null;
  status: 'missing_from_carrier' | 'missing_from_ours' | 'underpaid' | 'overpaid' | 'match' | 'qty_diff';
  difference: number | null;
  notes: string;
}

interface ComparisonResult {
  summary: {
    carrier_total: number;
    our_total: number;
    difference: number;
    missing_items_count: number;
    underpaid_items_count: number;
  };
  line_items: ComparisonLineItem[];
  policy_citations: string[];
  raw_analysis: string;
}

export const DarwinEstimateComparison = ({ claimId, claim }: DarwinEstimateComparisonProps) => {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [selectedCarrierId, setSelectedCarrierId] = useState<string | null>(null);
  const [selectedOurId, setSelectedOurId] = useState<string | null>(null);
  const { files: claimFiles, loading: loadingFiles, downloadFileAsBase64 } = useClaimFiles(claimId);

  const runComparison = async () => {
    if (!selectedCarrierId || !selectedOurId) {
      toast.error("Select both estimates to compare");
      return;
    }

    setLoading(true);
    try {
      const carrierFile = claimFiles.find(f => f.id === selectedCarrierId);
      const ourFile = claimFiles.find(f => f.id === selectedOurId);

      const [carrierBase64, ourBase64] = await Promise.all([
        downloadFileAsBase64(carrierFile!.file_path),
        downloadFileAsBase64(ourFile!.file_path),
      ]);

      if (!carrierBase64 || !ourBase64) throw new Error("Failed to download estimate files");

      const { data, error } = await supabase.functions.invoke('darwin-ai-analysis', {
        body: {
          claimId,
          analysisType: 'estimate_comparison',
          additionalContext: {
            carrierEstimatePdf: carrierBase64,
            carrierEstimateName: carrierFile!.file_name,
            ourEstimatePdf: ourBase64,
            ourEstimateName: ourFile!.file_name,
          }
        }
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setResult(data.result);

      const { data: userData } = await supabase.auth.getUser();
      await supabase.from('darwin_analysis_results').insert({
        claim_id: claimId,
        analysis_type: 'estimate_comparison',
        input_summary: `${carrierFile!.file_name} vs ${ourFile!.file_name}`,
        result: data.result,
        pdf_file_name: `${carrierFile!.file_name} vs ${ourFile!.file_name}`,
        created_by: userData.user?.id
      });

      // Trigger structured estimate intelligence in background (non-blocking)
      supabase.functions.invoke('darwin-estimate-intelligence', {
        body: {
          claimId,
          carrierEstimateText: data.result,
          contractorEstimateText: data.result,
          carrierFileId: selectedCarrierId,
          contractorFileId: selectedOurId,
        }
      }).catch(err => console.warn('Estimate intelligence background error:', err));

      toast.success("Estimate comparison complete");
    } catch (err: any) {
      console.error("Comparison error:", err);
      toast.error(err.message || "Comparison failed");
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    if (result) {
      navigator.clipboard.writeText(result);
      toast.success("Copied to clipboard");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4 text-primary" />
          Estimate Line-Item Comparison
        </CardTitle>
        <CardDescription>
          Side-by-side comparison of carrier estimate vs. your estimate — line by line
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* File Selectors */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-destructive">Carrier Estimate</label>
            <ClaimFileSelector
              files={claimFiles}
              loading={loadingFiles}
              selectedFileId={selectedCarrierId}
              onSelectFile={(f) => setSelectedCarrierId(f.id)}
              emptyMessage="No estimate PDFs found"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-primary">Our Estimate / Supplement</label>
            <ClaimFileSelector
              files={claimFiles}
              loading={loadingFiles}
              selectedFileId={selectedOurId}
              onSelectFile={(f) => setSelectedOurId(f.id)}
              emptyMessage="No estimate PDFs found"
            />
          </div>
        </div>

        <Button
          onClick={runComparison}
          disabled={loading || !selectedCarrierId || !selectedOurId}
          className="w-full gap-2"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Comparing line items...
            </>
          ) : (
            <>
              <ArrowLeftRight className="h-4 w-4" />
              Compare Estimates
            </>
          )}
        </Button>

        {/* Results */}
        {result && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Badge variant="secondary" className="gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Comparison Complete
              </Badge>
              <Button variant="outline" size="sm" onClick={copyToClipboard} className="gap-1">
                <Copy className="h-3 w-3" />
                Copy
              </Button>
            </div>
            <ScrollArea className="h-[500px] border rounded-md">
              <pre className="p-4 text-sm whitespace-pre-wrap font-mono bg-muted/30">
                {result}
              </pre>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default DarwinEstimateComparison;
