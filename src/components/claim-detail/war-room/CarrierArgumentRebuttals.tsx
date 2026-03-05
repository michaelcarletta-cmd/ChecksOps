import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { supabase } from "@/integrations/supabase/client";
import {
  Shield, ChevronDown, ChevronRight, FileText, AlertTriangle,
  CheckCircle2, Copy, BookOpen, Quote
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface CarrierArgumentRebuttal {
  id: string;
  argument_type: string;
  carrier_position: string;
  warranty_scope: string | null;
  damage_mechanism: string | null;
  loss_trigger: string | null;
  exclusion_invoked: string | null;
  storm_date: string | null;
  collateral_hits: string | null;
  pattern_notes: string | null;
  expert_support: string | null;
  principle: string;
  why_different: string;
  what_proves_damage: string;
  documentation_checklist: string[];
  carrier_ready_paragraph: string;
  citations: Array<{ file_name: string; snippet: string; needs_review?: boolean }>;
  source_file_name: string | null;
  confidence: number;
  needs_review: boolean;
  created_at: string;
}

interface CarrierArgumentRebuttalsProps {
  claimId: string;
}

const ARGUMENT_LABELS: Record<string, { label: string; color: string }> = {
  warranty_language_misuse: { label: "Warranty Misuse", color: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
  granule_loss_cosmetic: { label: "Cosmetic / Granule Loss", color: "bg-amber-500/20 text-amber-400 border-amber-500/30" },
  wear_and_tear: { label: "Wear & Tear", color: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  no_direct_physical_loss: { label: "No Direct Physical Loss", color: "bg-red-500/20 text-red-400 border-red-500/30" },
  maintenance: { label: "Maintenance / Pre-Existing", color: "bg-slate-500/20 text-slate-400 border-slate-500/30" },
};

export const CarrierArgumentRebuttals = ({ claimId }: CarrierArgumentRebuttalsProps) => {
  const [rebuttals, setRebuttals] = useState<CarrierArgumentRebuttal[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    loadRebuttals();
  }, [claimId]);

  const loadRebuttals = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("carrier_argument_rebuttals")
      .select("*")
      .eq("claim_id", claimId)
      .order("confidence", { ascending: false });

    if (!error && data) {
      setRebuttals(data as any);
    }
    setLoading(false);
  };

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied to clipboard" });
  };

  if (loading) {
    return (
      <div className="text-xs text-muted-foreground flex items-center gap-2 py-2">
        <Shield className="h-3 w-3 animate-pulse" />
        Loading carrier argument detection...
      </div>
    );
  }

  if (rebuttals.length === 0) {
    return null; // Don't render anything if no arguments detected
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Shield className="h-4 w-4 text-primary" />
        <h4 className="text-sm font-semibold">
          Carrier Arguments Detected ({rebuttals.length})
        </h4>
      </div>

      <div className="space-y-2">
        {rebuttals.map((r) => {
          const argMeta = ARGUMENT_LABELS[r.argument_type] || { label: r.argument_type, color: "bg-muted text-muted-foreground" };
          const isOpen = expanded.has(r.id);
          const checklist = Array.isArray(r.documentation_checklist) ? r.documentation_checklist : [];
          const citations = Array.isArray(r.citations) ? r.citations : [];

          return (
            <Card key={r.id} className="border-border overflow-hidden">
              <Collapsible open={isOpen} onOpenChange={() => toggleExpand(r.id)}>
                <CollapsibleTrigger asChild>
                  <div className="flex items-center gap-2 p-3 cursor-pointer hover:bg-accent/50 transition-colors">
                    {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                    <Badge variant="outline" className={`text-[10px] ${argMeta.color}`}>
                      {argMeta.label}
                    </Badge>
                    <span className="text-xs text-muted-foreground truncate flex-1">
                      {r.carrier_position.substring(0, 80)}...
                    </span>
                    {r.needs_review && (
                      <Badge variant="outline" className="text-[10px] border-warning/50 text-warning">
                        <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                        Needs Review
                      </Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {Math.round((r.confidence || 0) * 100)}%
                    </span>
                  </div>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <CardContent className="p-3 pt-0 space-y-3 border-t border-border">
                    {/* Carrier Position */}
                    <div>
                      <div className="text-[10px] font-semibold text-destructive uppercase tracking-wider mb-1">
                        Carrier Position
                      </div>
                      <p className="text-xs text-muted-foreground">{r.carrier_position}</p>
                    </div>

                    {/* Principle */}
                    <div className="bg-primary/5 rounded p-2 border border-primary/20">
                      <div className="text-[10px] font-semibold text-primary uppercase tracking-wider mb-1">
                        ⚡ Rebuttal Principle
                      </div>
                      <p className="text-xs font-medium">{r.principle}</p>
                    </div>

                    {/* Why It's Different */}
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider mb-1">
                        Why It's Different
                      </div>
                      <p className="text-xs text-muted-foreground">{r.why_different}</p>
                    </div>

                    {/* What Proves Damage */}
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider mb-1">
                        What Proves Functional Damage
                      </div>
                      <p className="text-xs text-muted-foreground">{r.what_proves_damage}</p>
                    </div>

                    {/* Structured Evidence Fields */}
                    {(r.exclusion_invoked || r.damage_mechanism || r.loss_trigger) && (
                      <div className="grid grid-cols-2 gap-2">
                        {r.exclusion_invoked && (
                          <div className="text-xs">
                            <span className="font-medium text-destructive">Exclusion: </span>
                            <span className="text-muted-foreground">{r.exclusion_invoked}</span>
                          </div>
                        )}
                        {r.damage_mechanism && (
                          <div className="text-xs">
                            <span className="font-medium">Mechanism: </span>
                            <span className="text-muted-foreground">{r.damage_mechanism}</span>
                          </div>
                        )}
                        {r.loss_trigger && (
                          <div className="text-xs">
                            <span className="font-medium">Loss Trigger: </span>
                            <span className="text-muted-foreground">{r.loss_trigger}</span>
                          </div>
                        )}
                        {r.collateral_hits && (
                          <div className="text-xs">
                            <span className="font-medium">Collateral: </span>
                            <span className="text-muted-foreground">{r.collateral_hits}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Documentation Checklist */}
                    {checklist.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3 text-success" />
                          Documentation Checklist
                        </div>
                        <div className="space-y-1">
                          {checklist.map((item, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                              <span className="text-[10px] bg-muted rounded px-1.5 py-0.5 shrink-0">{i + 1}</span>
                              <span>{typeof item === 'string' ? item : JSON.stringify(item)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Citations */}
                    {citations.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wider mb-1 flex items-center gap-1">
                          <Quote className="h-3 w-3" />
                          Citations
                        </div>
                        <div className="space-y-1">
                          {citations.map((c, i) => (
                            <div key={i} className={`text-xs p-1.5 rounded border ${c.needs_review ? "border-warning/30 bg-warning/5" : "border-border bg-muted/30"}`}>
                              <span className="font-medium">{c.file_name}: </span>
                              <span className="text-muted-foreground italic">"{c.snippet}"</span>
                              {c.needs_review && (
                                <Badge variant="outline" className="text-[9px] ml-1 border-warning/50 text-warning">Needs Review</Badge>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Carrier-Ready Paragraph */}
                    <div className="bg-success/5 rounded p-2 border border-success/20">
                      <div className="flex items-center justify-between mb-1">
                        <div className="text-[10px] font-semibold text-success uppercase tracking-wider flex items-center gap-1">
                          <FileText className="h-3 w-3" />
                          Carrier-Ready Response
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 px-1.5 text-[10px]"
                          onClick={() => copyToClipboard(r.carrier_ready_paragraph)}
                        >
                          <Copy className="h-2.5 w-2.5 mr-0.5" />
                          Copy
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground italic leading-relaxed">
                        {r.carrier_ready_paragraph}
                      </p>
                    </div>

                    {/* Source file */}
                    {r.source_file_name && (
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <BookOpen className="h-2.5 w-2.5" />
                        Source: {r.source_file_name}
                      </div>
                    )}
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          );
        })}
      </div>
    </div>
  );
};
