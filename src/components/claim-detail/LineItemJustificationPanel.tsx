import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Shield,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CheckCircle,
  Loader2,
  Copy,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { justifyLineItems, type JustificationResult } from "@/lib/justification/justificationEngine";
import { supabase } from "@/integrations/supabase/client";

interface LineItemJustificationPanelProps {
  claimId: string;
  claim: any;
  lineItems: Array<{ description: string; quantity?: number; unit?: string; code?: string }>;
}

type ViewMode = "internal" | "carrier";

export function LineItemJustificationPanel({ claimId, claim, lineItems }: LineItemJustificationPanelProps) {
  const [results, setResults] = useState<JustificationResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("internal");

  const stateCode = claim?.property_state || claim?.policyholder_state || "NJ";

  const handleJustify = useCallback(async () => {
    if (!lineItems?.length) {
      toast.error("No line items to justify.");
      return;
    }
    setLoading(true);
    try {
      const justified = justifyLineItems(lineItems, {
        stateCode,
        manufacturer: claim?.manufacturer || null,
        policyText: claim?.policy_text || null,
        lossType: claim?.loss_type || null,
      });
      setResults(justified);

      // Persist to database
      for (const r of justified) {
        await supabase.from("claim_line_item_justifications" as any).upsert({
          claim_id: claimId,
          normalized_item: r.normalizedItem,
          manufacturer_support: { text: r.manufacturer.text, confidence: r.manufacturer.confidence },
          code_support: { text: r.code.text, confidence: r.code.confidence, reference: r.code.reference },
          policy_support: { text: r.policy.text, confidence: r.policy.confidence },
          support_strength: r.supportStrength,
          confidence_score: r.confidenceScore,
          missing_evidence_json: r.missingEvidence,
          carrier_facing_text: r.carrierFacingText,
          inline_note: r.inlineNote,
          output_mode: viewMode,
        } as any);
      }

      toast.success(`${justified.length} line items justified.`);
    } catch (err) {
      console.error("Justification error:", err);
      toast.error("Failed to generate justifications.");
    } finally {
      setLoading(false);
    }
  }, [lineItems, stateCode, claim, claimId, viewMode]);

  const toggleRow = (idx: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  const copyAllCarrier = () => {
    const text = results.map((r) => r.carrierFacingText).join("\n\n");
    navigator.clipboard.writeText(text);
    toast.success("Carrier-facing justifications copied.");
  };

  const confidenceBadge = (score: number) => {
    if (score >= 75) return <Badge variant="default" className="text-[10px]">{score}</Badge>;
    if (score >= 45) return <Badge variant="secondary" className="text-[10px]">{score}</Badge>;
    return <Badge variant="destructive" className="text-[10px]">{score}</Badge>;
  };

  const strengthIcon = (s: string) => {
    if (s === "direct") return <CheckCircle className="h-3.5 w-3.5 text-primary" />;
    if (s === "inferred") return <Shield className="h-3.5 w-3.5 text-muted-foreground" />;
    return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            Line Item Justification Engine
          </CardTitle>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <Label htmlFor="view-toggle" className="text-[11px] text-muted-foreground">
                {viewMode === "carrier" ? "Carrier Version" : "Internal Notes"}
              </Label>
              <Switch
                id="view-toggle"
                checked={viewMode === "carrier"}
                onCheckedChange={(v) => setViewMode(v ? "carrier" : "internal")}
              />
            </div>
            {results.length > 0 && viewMode === "carrier" && (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={copyAllCarrier}>
                <Copy className="h-3 w-3 mr-1" /> Copy All
              </Button>
            )}
            <Button size="sm" onClick={handleJustify} disabled={loading} className="h-7 text-[11px]">
              {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <FileText className="h-3 w-3 mr-1" />}
              Justify Lines
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {loading && (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {!loading && results.length === 0 && (
          <p className="text-xs text-muted-foreground py-4">
            Click "Justify Lines" to generate carrier-ready justifications for each line item using manufacturer, code, and policy authority.
          </p>
        )}

        {!loading && results.length > 0 && (
          <ScrollArea className="max-h-[500px]">
            <div className="space-y-1">
              {results.map((r, idx) => {
                const expanded = expandedRows.has(idx);
                return (
                  <Collapsible key={idx} open={expanded} onOpenChange={() => toggleRow(idx)}>
                    <CollapsibleTrigger className="w-full text-left">
                      <div className="flex items-center gap-2 p-2 rounded hover:bg-muted/50 text-xs">
                        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                        {strengthIcon(r.supportStrength)}
                        <span className="font-medium flex-1">{r.normalizedItem}</span>
                        <Badge variant="outline" className="text-[10px]">{r.trade}</Badge>
                        {confidenceBadge(r.confidenceScore)}
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-8 mr-2 mb-2 p-3 bg-muted/30 rounded text-xs space-y-2">
                        {viewMode === "internal" ? (
                          <>
                            <p><strong>Why Required:</strong> {r.whyRequired}</p>
                            <div className="grid gap-2 md:grid-cols-3">
                              <div>
                                <p className="font-semibold text-[11px] flex items-center gap-1">
                                  {strengthIcon(r.manufacturer.confidence)} Manufacturer
                                </p>
                                <p className="text-muted-foreground">{r.manufacturer.text}</p>
                              </div>
                              <div>
                                <p className="font-semibold text-[11px] flex items-center gap-1">
                                  {strengthIcon(r.code.confidence)} Code ({r.code.reference})
                                </p>
                                <p className="text-muted-foreground">{r.code.text}</p>
                              </div>
                              <div>
                                <p className="font-semibold text-[11px] flex items-center gap-1">
                                  {strengthIcon(r.policy.confidence)} Policy
                                </p>
                                <p className="text-muted-foreground">{r.policy.text}</p>
                              </div>
                            </div>
                            {r.missingEvidence.length > 0 && (
                              <div className="flex items-start gap-1.5 p-2 bg-destructive/10 rounded">
                                <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                                <div>
                                  <p className="font-semibold text-destructive">Missing Evidence</p>
                                  {r.missingEvidence.map((e, i) => (
                                    <p key={i} className="text-muted-foreground">{e}</p>
                                  ))}
                                </div>
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="leading-relaxed">{r.carrierFacingText}</p>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
