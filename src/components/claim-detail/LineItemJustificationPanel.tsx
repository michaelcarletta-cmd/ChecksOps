import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  CheckCircle2,
  Loader2,
  Copy,
  FileText,
  XCircle,
  Printer,
  BookOpen,
  Database,
  Building2,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

// ── Types ───────────────────────────────────────────────────────

interface LineItemJustificationPanelProps {
  claimId: string;
  claim: any;
  lineItems: Array<{ description: string; quantity?: number; unit?: string; code?: string }>;
}

type ViewMode = "internal" | "carrier";
type ConfidenceLabel = "High" | "Medium" | "Low";
type ConfidenceLevel = "direct" | "inferred" | "needs_evidence";

interface SourceRef {
  type: "kb" | "code" | "manufacturer";
  label: string;
  content: string;
}

interface JustificationResult {
  normalizedItem: string;
  trade: string;
  system: string;
  whyRequired: string;
  manufacturer: {
    text: string;
    functionText: string;
    failureRisk: string;
    confidence: ConfidenceLevel;
    sourceName?: string;
  };
  code: {
    text: string;
    confidence: ConfidenceLevel;
    reference: string;
    sourceName?: string;
  };
  policy: {
    text: string;
    confidence: ConfidenceLevel;
  };
  missingEvidence: string[];
  confidenceScore: number;
  confidenceLabel: ConfidenceLabel;
  supportStrength: ConfidenceLevel;
  inlineNote: string;
  carrierFacingText: string;
  sources?: SourceRef[];
}

interface JustificationMetadata {
  kbChunksUsed: number;
  codeCitationsUsed: number;
  mfrSpecsUsed: number;
  itemsWithMfrData?: number;
  itemsWithCodeData?: number;
  totalItems?: number;
  stateCode: string | null;
  stateSupported: boolean;
  sourcesQueried?: string[];
}

// ── Sub-components ──────────────────────────────────────────────

const CONFIDENCE_STYLES: Record<ConfidenceLabel, { color: string; bg: string }> = {
  High: { color: "text-primary", bg: "bg-primary/10 border-primary/20" },
  Medium: { color: "text-secondary-foreground", bg: "bg-secondary border-secondary" },
  Low: { color: "text-destructive", bg: "bg-destructive/10 border-destructive/20" },
};

const SOURCE_STYLES: Record<string, { icon: typeof BookOpen; color: string; bg: string; label: string }> = {
  kb: { icon: Database, color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", label: "Knowledge Base" },
  code: { icon: Building2, color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20", label: "Building Code" },
  manufacturer: { icon: BookOpen, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", label: "Manufacturer" },
};

function ConfidenceBadge({ label }: { label: ConfidenceLabel }) {
  const style = CONFIDENCE_STYLES[label];
  return (
    <Badge variant="outline" className={`text-[10px] px-2 py-0.5 font-semibold ${style.bg} ${style.color}`}>
      {label}
    </Badge>
  );
}

function StrengthIcon({ confidence }: { confidence: string }) {
  if (confidence === "direct") return <CheckCircle2 className="h-3.5 w-3.5 text-primary" />;
  if (confidence === "inferred") return <Shield className="h-3.5 w-3.5 text-muted-foreground" />;
  return <XCircle className="h-3.5 w-3.5 text-destructive" />;
}

function SourceBadge({ source }: { source: SourceRef }) {
  const style = SOURCE_STYLES[source.type] || SOURCE_STYLES.kb;
  const Icon = style.icon;
  return (
    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${style.bg} ${style.color} gap-1`}>
      <Icon className="h-2.5 w-2.5" />
      {source.label.length > 40 ? source.label.slice(0, 40) + "…" : source.label}
    </Badge>
  );
}

function SourceSection({ sources }: { sources: SourceRef[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!sources?.length) return null;

  return (
    <div className="space-y-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
        View Sources ({sources.length})
      </button>
      <div className="flex flex-wrap gap-1">
        {sources.map((s, i) => (
          <SourceBadge key={i} source={s} />
        ))}
      </div>
      {expanded && (
        <div className="space-y-1.5 mt-1">
          {sources.map((s, i) => {
            const style = SOURCE_STYLES[s.type] || SOURCE_STYLES.kb;
            return (
              <div key={i} className={`p-2 rounded border text-[10px] ${style.bg}`}>
                <p className={`font-semibold ${style.color} mb-0.5`}>{s.label}</p>
                <p className="text-muted-foreground leading-relaxed">{s.content}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AuthoritySection({
  title,
  icon,
  text,
  subText,
}: {
  title: string;
  icon: React.ReactNode;
  text: string;
  subText?: string;
}) {
  return (
    <div className="space-y-1">
      <p className="font-semibold text-[11px] flex items-center gap-1.5">
        {icon} {title}
      </p>
      <p className="text-muted-foreground leading-relaxed">{text}</p>
      {subText && <p className="text-muted-foreground/70 italic text-[10px]">{subText}</p>}
    </div>
  );
}

function MetadataBanner({ metadata }: { metadata: JustificationMetadata | null }) {
  if (!metadata) return null;
  return (
    <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground pb-2 border-b border-border mb-2">
      <span className="flex items-center gap-1">
        <Database className="h-3 w-3 text-blue-400" /> {metadata.kbChunksUsed} KB chunks
      </span>
      <span className="flex items-center gap-1">
        <Building2 className="h-3 w-3 text-orange-400" /> {metadata.codeCitationsUsed} code refs
        {metadata.itemsWithCodeData !== undefined && metadata.totalItems && (
          <span className="text-muted-foreground/60">({metadata.itemsWithCodeData}/{metadata.totalItems} items matched)</span>
        )}
      </span>
      <span className="flex items-center gap-1">
        <BookOpen className="h-3 w-3 text-emerald-400" /> {metadata.mfrSpecsUsed} mfr specs
        {metadata.itemsWithMfrData !== undefined && metadata.totalItems && (
          <span className="text-muted-foreground/60">({metadata.itemsWithMfrData}/{metadata.totalItems} items matched)</span>
        )}
      </span>
      {metadata.stateCode && (
        <Badge variant="outline" className="text-[9px] px-1.5 py-0">
          {metadata.stateCode} codes
        </Badge>
      )}
      {!metadata.stateSupported && (
        <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-destructive/10 text-destructive border-destructive/20">
          State not in NJ/PA/SC — codes skipped
        </Badge>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────

export function LineItemJustificationPanel({ claimId, claim, lineItems }: LineItemJustificationPanelProps) {
  const [results, setResults] = useState<JustificationResult[]>([]);
  const [metadata, setMetadata] = useState<JustificationMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("internal");
  const [industryStandards, setIndustryStandards] = useState("");
  const printRef = useRef<HTMLDivElement>(null);

  const stateCode = claim?.state_code || claim?.property_state || claim?.policyholder_state || "";

  const handlePrint = useCallback(() => {
    if (!results.length) return;
    setExpandedRows(new Set(results.map((_, i) => i)));
    setTimeout(() => window.print(), 100);
  }, [results]);

  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const abortRef = useRef(false);

  const handleJustify = useCallback(async () => {
    if (!lineItems?.length) {
      toast.error("No line items to justify.");
      return;
    }
    setLoading(true);
    setResults([]);
    setMetadata(null);
    abortRef.current = false;

    const BATCH_SIZE = 5;
    const batches: typeof lineItems[] = [];
    for (let i = 0; i < lineItems.length; i += BATCH_SIZE) {
      batches.push(lineItems.slice(i, i + BATCH_SIZE));
    }
    setProgress({ done: 0, total: lineItems.length });

    const allJustifications: JustificationResult[] = [];
    let mergedMeta: JustificationMetadata | null = null;
    let batchErrors = 0;

    try {
      for (let b = 0; b < batches.length; b++) {
        if (abortRef.current) break;

        const batch = batches[b];
        const { data, error } = await supabase.functions.invoke("darwin-justify-line-items", {
          body: {
            claimId,
            lineItems: batch,
            stateCode,
            manufacturer: claim?.manufacturer || null,
            lossType: claim?.loss_type || null,
            viewMode,
            industryStandards: industryStandards.trim() || null,
          },
        });

        if (error || !data || data.ok === false) {
          console.error(`Batch ${b + 1} failed:`, error || data?.error);
          batchErrors++;
          setProgress((p) => ({ ...p, done: p.done + batch.length }));
          continue;
        }

        const batchResults = data.justifications || [];
        allJustifications.push(...batchResults);
        setResults((prev) => [...prev, ...batchResults]);
        setProgress((p) => ({ ...p, done: p.done + batch.length }));

        // Merge metadata
        if (data.metadata) {
          if (!mergedMeta) {
            mergedMeta = { ...data.metadata };
          } else {
            mergedMeta.kbChunksUsed = Math.max(mergedMeta.kbChunksUsed, data.metadata.kbChunksUsed || 0);
            mergedMeta.codeCitationsUsed += data.metadata.codeCitationsUsed || 0;
            mergedMeta.mfrSpecsUsed += data.metadata.mfrSpecsUsed || 0;
            mergedMeta.itemsWithMfrData = (mergedMeta.itemsWithMfrData || 0) + (data.metadata.itemsWithMfrData || 0);
            mergedMeta.itemsWithCodeData = (mergedMeta.itemsWithCodeData || 0) + (data.metadata.itemsWithCodeData || 0);
            mergedMeta.totalItems = (mergedMeta.totalItems || 0) + (data.metadata.totalItems || 0);
          }
        }
      }

      setMetadata(mergedMeta);
      if (batchErrors > 0 && allJustifications.length > 0) {
        toast.warning(`${allJustifications.length} items justified, ${batchErrors} batch(es) failed.`);
      } else if (batchErrors > 0) {
        toast.error("All batches failed. Try again or reduce line items.");
      } else {
        toast.success(`${allJustifications.length} line items justified with real source data.`);
      }
    } catch (err: any) {
      console.error("Justification error:", err);
      toast.error(err.message || "Failed to generate justifications.");
    } finally {
      setLoading(false);
    }
  }, [lineItems, stateCode, claim, claimId, viewMode, industryStandards]);

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

  return (
    <Card ref={printRef} className="print-justification-panel">
      <CardHeader className="pb-3 print:pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            Line Item Justification Engine
          </CardTitle>
          <div className="flex items-center gap-3 print:hidden">
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
            {results.length > 0 && (
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={handlePrint}>
                <Printer className="h-3 w-3 mr-1" /> Print
              </Button>
            )}
            <Button size="sm" onClick={handleJustify} disabled={loading} className="h-7 text-[11px]">
              {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <FileText className="h-3 w-3 mr-1" />}
              {loading ? "Analyzing Sources…" : "Justify Lines"}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="space-y-1.5 print:hidden">
          <Label htmlFor="industry-standards" className="text-xs font-medium">Industry Standards</Label>
          <Textarea
            id="industry-standards"
            value={industryStandards}
            onChange={(e) => setIndustryStandards(e.target.value)}
            placeholder="e.g., ASTM D3737 for wood flooring, NFPA 101 for fire safety"
            className="min-h-[60px] text-xs"
            rows={2}
          />
          <p className="text-[10px] text-muted-foreground">Standards relevant to replacement/repair of this item type</p>
        </div>
        {loading && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {progress.total > 0
                ? `Processing batch ${Math.min(Math.ceil(progress.done / 5) + 1, Math.ceil(progress.total / 5))} of ${Math.ceil(progress.total / 5)} (${progress.done}/${progress.total} items)…`
                : "Querying knowledge base, building codes & manufacturer specs…"}
            </div>
            {progress.total > 0 && (
              <div className="w-full bg-muted rounded-full h-1.5">
                <div
                  className="bg-primary h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </div>
            )}
            {results.length === 0 && Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {!loading && results.length === 0 && (
          <p className="text-xs text-muted-foreground py-4">
            Click "Justify Lines" to generate source-backed justifications using your knowledge base, building codes (NJ/PA/SC), and manufacturer specifications.
          </p>
        )}

        {results.length > 0 && (
          <div className="overflow-y-auto max-h-[calc(100vh-200px)] scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-gray-100 pr-2">
            <MetadataBanner metadata={metadata} />
            <div className="space-y-1">
              {results.map((r, idx) => {
                const expanded = expandedRows.has(idx);
                return (
                  <Collapsible key={idx} open={expanded} onOpenChange={() => toggleRow(idx)}>
                    <CollapsibleTrigger className="w-full text-left">
                      <div className="flex items-center gap-2 p-2 rounded hover:bg-muted/50 text-xs">
                        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                        <StrengthIcon confidence={r.supportStrength} />
                        <span className="font-medium flex-1">{r.normalizedItem}</span>
                        <Badge variant="outline" className="text-[10px]">{r.trade}</Badge>
                        <ConfidenceBadge label={r.confidenceLabel} />
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-8 mr-2 mb-2 p-3 bg-muted/30 rounded text-xs space-y-3">
                        {viewMode === "internal" ? (
                          <>
                            <div className="space-y-1">
                              <p className="font-semibold text-[11px]">System Function</p>
                              <p className="text-muted-foreground leading-relaxed">{r.whyRequired}</p>
                            </div>

                            <div className="grid gap-3 md:grid-cols-3">
                              <AuthoritySection
                                title="Manufacturer"
                                icon={<StrengthIcon confidence={r.manufacturer.confidence} />}
                                text={r.manufacturer.functionText || r.manufacturer.text}
                                subText={r.manufacturer.failureRisk}
                              />
                              <AuthoritySection
                                title={`Code (${r.code.reference})`}
                                icon={<StrengthIcon confidence={r.code.confidence} />}
                                text={r.code.text}
                              />
                              <AuthoritySection
                                title="Policy"
                                icon={<StrengthIcon confidence={r.policy.confidence} />}
                                text={r.policy.text}
                              />
                            </div>

                            {r.sources && r.sources.length > 0 && (
                              <SourceSection sources={r.sources} />
                            )}

                            {r.missingEvidence && r.missingEvidence.length > 0 && (
                              <div className="flex items-start gap-1.5 p-2.5 bg-destructive/10 border border-destructive/20 rounded">
                                <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                                <div>
                                  <p className="font-semibold text-destructive text-[11px]">Missing Evidence ({r.missingEvidence.length})</p>
                                  {r.missingEvidence.map((e, i) => (
                                    <p key={i} className="text-muted-foreground mt-0.5">{e}</p>
                                  ))}
                                </div>
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <p className="leading-relaxed">{r.carrierFacingText}</p>
                            {r.sources && r.sources.length > 0 && (
                              <SourceSection sources={r.sources} />
                            )}
                          </>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
