import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { 
  FileText, 
  ChevronDown, 
  ChevronUp, 
  Loader2, 
  Copy, 
  Scale,
  AlertTriangle,
  Sparkles
} from "lucide-react";
import { toast } from "sonner";
import { DarwinRefinementChat } from "./DarwinRefinementChat";

interface Regulation {
  id: string;
  state_code: string;
  state_name: string;
  regulation_type: string;
  regulation_title: string;
  regulation_citation: string;
  deadline_days: number | null;
  description: string;
  consequence_description: string | null;
}

interface DarwinDOBILetterDrafterProps {
  claimId: string;
  claim: any;
}

export const DarwinDOBILetterDrafter = ({ claimId, claim }: DarwinDOBILetterDrafterProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [regulations, setRegulations] = useState<Regulation[]>([]);
  const [selectedRegulations, setSelectedRegulations] = useState<Set<string>>(new Set());
  const [additionalContext, setAdditionalContext] = useState("");
  const [draftedLetter, setDraftedLetter] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [loadingRegs, setLoadingRegs] = useState(true);

  // Detect state from claim
  const detectedState = (() => {
    const address = (claim?.policyholder_address || "").toUpperCase();
    if (address.includes("NJ") || address.includes("NEW JERSEY")) return "NJ";
    if (address.includes("TX") || address.includes("TEXAS")) return "TX";
    if (address.includes("FL") || address.includes("FLORIDA")) return "FL";
    return "PA"; // Default to PA
  })();

  useEffect(() => {
    const fetchRegulations = async () => {
      const { data, error } = await supabase
        .from("state_insurance_regulations")
        .select("*")
        .eq("state_code", detectedState)
        .order("regulation_type", { ascending: true });

      if (!error && data) {
        setRegulations(data);
      }
      setLoadingRegs(false);
    };

    if (isOpen) fetchRegulations();
  }, [isOpen, detectedState]);

  const toggleRegulation = (id: string) => {
    setSelectedRegulations(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const typeLabels: Record<string, string> = {
    insurer_response: "Insurer Response Deadlines",
    bad_faith: "Bad Faith Laws",
    pol_deadline: "Proof of Loss Requirements",
    unfair_claims: "Unfair Claims Practices",
  };

  const generateLetter = async () => {
    if (selectedRegulations.size === 0) {
      toast.error("Please select at least one regulation violation to cite");
      return;
    }

    setIsGenerating(true);
    setDraftedLetter("");

    const selectedRegs = regulations.filter(r => selectedRegulations.has(r.id));

    try {
      // Fetch canonical timeline to provide verified chronology context
      let timelineContext: any[] = [];
      try {
        const { data: tlData } = await supabase.functions.invoke("get-claim-timeline", {
          body: { claimId },
        });
        if (tlData?.events) {
          timelineContext = (tlData.events as any[])
            .filter((e: any) => e.is_verified || e.supports_escalation || e.supports_rebuttal)
            .slice(0, 60)
            .map((e: any) => ({
              date: e.occurred_at?.split("T")[0],
              type: e.event_type,
              summary: e.summary,
              is_verified: e.is_verified,
              date_source: e.date_source,
              supports_escalation: e.supports_escalation,
              supports_rebuttal: e.supports_rebuttal,
            }));
        }
      } catch { /* timeline fetch is optional enhancement */ }

      const { data, error } = await supabase.functions.invoke("darwin-ai-analysis", {
        body: {
          analysisType: "dobi_letter",
          claimId,
          additionalContext: {
            violations: selectedRegs.map(r => ({
              citation: r.regulation_citation,
              title: r.regulation_title,
              description: r.description,
              type: r.regulation_type,
              deadlineDays: r.deadline_days,
              consequence: r.consequence_description,
            })),
            state: detectedState,
            userContext: additionalContext,
            canonicalTimeline: timelineContext,
          },
        },
      });

      if (error) throw error;

      setDraftedLetter(data?.result || data?.analysis || "Failed to generate letter.");
    } catch (err: any) {
      console.error("Error generating DOBI letter:", err);
      toast.error("Failed to generate DOBI letter");
    } finally {
      setIsGenerating(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(draftedLetter);
    toast.success("DOBI letter copied to clipboard");
  };

  const groupedRegulations = regulations.reduce((acc, reg) => {
    if (!acc[reg.regulation_type]) acc[reg.regulation_type] = [];
    acc[reg.regulation_type].push(reg);
    return acc;
  }, {} as Record<string, Regulation[]>);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Scale className="h-5 w-5 text-red-600" />
                DOBI Complaint Letter Drafter
                <Badge variant="secondary" className="ml-1">{detectedState}</Badge>
              </CardTitle>
              {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="space-y-5">
            <p className="text-sm text-muted-foreground">
              Draft a formal complaint letter to the {
                detectedState === "NJ" ? "NJ Department of Banking & Insurance (DOBI)" :
                detectedState === "TX" ? "Texas Department of Insurance (TDI)" :
                detectedState === "FL" ? "Florida Office of Insurance Regulation" :
                "PA Insurance Department"
              }. 
              Select the specific regulations the carrier is violating and Darwin will draft a detailed complaint letter citing the violations, 
              policy conditions, carrier misconduct, and what relief you are requesting.
            </p>

            {/* Regulation Selection */}
            {loadingRegs ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-4">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  Select Regulation Violations to Cite
                </h4>
                <ScrollArea className="h-[280px] border rounded-lg p-3">
                  <div className="space-y-4">
                    {Object.entries(groupedRegulations).map(([type, regs]) => (
                      <div key={type} className="space-y-2">
                        <p className="text-sm font-medium text-muted-foreground">
                          {typeLabels[type] || type}
                        </p>
                        {regs.map(reg => (
                          <div
                            key={reg.id}
                            className={`flex items-start gap-3 p-2 rounded-md border transition-colors ${
                              selectedRegulations.has(reg.id)
                                ? "bg-primary/5 border-primary/30"
                                : "bg-muted/20 border-transparent hover:border-border"
                            }`}
                          >
                            <Checkbox
                              id={`reg-${reg.id}`}
                              checked={selectedRegulations.has(reg.id)}
                              onCheckedChange={() => toggleRegulation(reg.id)}
                              className="mt-0.5"
                            />
                            <Label htmlFor={`reg-${reg.id}`} className="cursor-pointer flex-1 space-y-0.5">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium">{reg.regulation_title}</span>
                                <Badge variant="outline" className="text-xs">{reg.regulation_citation}</Badge>
                                {reg.deadline_days && (
                                  <Badge variant="secondary" className="text-xs">{reg.deadline_days} days</Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground">{reg.description}</p>
                            </Label>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
                <p className="text-xs text-muted-foreground">
                  {selectedRegulations.size} regulation{selectedRegulations.size !== 1 ? "s" : ""} selected
                </p>
              </div>
            )}

            {/* Additional Context */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">
                Additional Context <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              <Textarea
                value={additionalContext}
                onChange={e => setAdditionalContext(e.target.value)}
                placeholder="Describe specific carrier actions, missed deadlines, or other facts you want included in the complaint..."
                className="min-h-[80px]"
              />
            </div>

            {/* Generate Button */}
            <Button
              onClick={generateLetter}
              disabled={isGenerating || selectedRegulations.size === 0}
              className="w-full gap-2"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Drafting DOBI Letter...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Draft DOBI Complaint Letter
                </>
              )}
            </Button>

            {/* Generated Letter */}
            {draftedLetter && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    Draft Complaint Letter
                  </h4>
                  <Button variant="outline" size="sm" onClick={copyToClipboard} className="gap-1">
                    <Copy className="h-3 w-3" />
                    Copy
                  </Button>
                </div>
                <ScrollArea className="h-[400px] border rounded-lg">
                  <div className="p-4 whitespace-pre-wrap text-sm font-mono leading-relaxed">
                    {draftedLetter}
                  </div>
                </ScrollArea>
                <DarwinRefinementChat
                  currentDocument={draftedLetter}
                  onDocumentUpdated={(revised) => setDraftedLetter(revised)}
                  claimId={claimId}
                  documentLabel="DOBI complaint letter"
                />
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
};
