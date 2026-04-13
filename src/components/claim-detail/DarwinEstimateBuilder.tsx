import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Trash2, Save, Loader2, Sparkles, Calculator,
  ChevronDown, ChevronRight, DollarSign, CheckCheck, XCircle,
  Info, ArrowRightLeft, Tag, BookOpen, Star, TrendingUp, Upload
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EstimateImportPreview } from "./EstimateImportPreview";

const REASON_TAGS = [
  { value: "code_required", label: "Code Required", color: "bg-chart-1/20 text-chart-1 border-chart-1/30" },
  { value: "omission", label: "Omission", color: "bg-destructive/20 text-destructive border-destructive/30" },
  { value: "dependency", label: "Dependency", color: "bg-chart-3/20 text-chart-3 border-chart-3/30" },
  { value: "pricing_variance", label: "Pricing Variance", color: "bg-warning/20 text-warning border-warning/30" },
  { value: "rebuttal_support", label: "Rebuttal Support", color: "bg-primary/20 text-primary border-primary/30" },
  { value: "quantity_dispute", label: "Qty Dispute", color: "bg-chart-5/20 text-chart-5 border-chart-5/30" },
] as const;

const REASON_TAG_MAP = Object.fromEntries(REASON_TAGS.map((r) => [r.value, r]));

interface EstimateLine {
  id: string;
  category: string;
  trade: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  rcv_total: number;
  depreciation_pct: number;
  depreciation_amount: number;
  acv_total: number;
  include_overhead: boolean;
  include_profit: boolean;
  overhead_pct: number;
  profit_pct: number;
  source: string;
  is_suggested: boolean;
  is_accepted: boolean;
  code_reference: string | null;
  notes: string | null;
  rationale: string | null;
  reason_tag: string | null;
  carrier_quantity: number | null;
  carrier_unit_price: number | null;
  carrier_total: number;
  variance_amount: number;
  sort_order: number;
  used_in_rebuttal: boolean;
  recovery_impact_rank: number | null;
  rebuttal_strength_score: number | null;
}

interface DarwinEstimateBuilderProps {
  claimId: string;
  claim: any;
}

const TRADES = [
  "Roofing", "Siding", "Gutters", "Interior", "Drywall", "Painting",
  "Flooring", "Electrical", "Plumbing", "HVAC", "Windows", "Doors",
  "Framing", "Insulation", "General", "Other"
];
const UNITS = ["EA", "SF", "LF", "SQ", "HR", "LS", "CY", "GAL"];

export const DarwinEstimateBuilder = ({ claimId, claim }: DarwinEstimateBuilderProps) => {
  const [lines, setLines] = useState<EstimateLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [collapsedTrades, setCollapsedTrades] = useState<Set<string>>(new Set());
  const [showDepreciation, setShowDepreciation] = useState(false);
  const [showOP, setShowOP] = useState(false);
  const [showCarrier, setShowCarrier] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const loadLines = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("darwin_estimate_lines")
      .select("*")
      .eq("claim_id", claimId)
      .order("sort_order", { ascending: true });
    if (!error && data) {
      setLines(data.map((d: any) => ({
        ...d,
        quantity: Number(d.quantity),
        unit_price: Number(d.unit_price),
        rcv_total: Number(d.rcv_total),
        depreciation_pct: Number(d.depreciation_pct),
        depreciation_amount: Number(d.depreciation_amount),
        acv_total: Number(d.acv_total),
        overhead_pct: Number(d.overhead_pct),
        profit_pct: Number(d.profit_pct),
        carrier_quantity: d.carrier_quantity != null ? Number(d.carrier_quantity) : null,
        carrier_unit_price: d.carrier_unit_price != null ? Number(d.carrier_unit_price) : null,
        carrier_total: Number(d.carrier_total || 0),
        variance_amount: Number(d.variance_amount || 0),
        used_in_rebuttal: d.used_in_rebuttal || false,
        recovery_impact_rank: d.recovery_impact_rank ?? null,
        rebuttal_strength_score: d.rebuttal_strength_score ?? null,
      })));
      if (data.some((d: any) => Number(d.depreciation_pct) > 0)) setShowDepreciation(true);
      if (data.some((d: any) => d.include_overhead || d.include_profit)) setShowOP(true);
      if (data.some((d: any) => d.carrier_quantity != null || d.carrier_unit_price != null)) setShowCarrier(true);
    }
    setLoading(false);
  }, [claimId]);

  useEffect(() => { loadLines(); }, [loadLines]);

  const pendingSuggestions = useMemo(() => lines.filter((l) => l.is_suggested && !l.is_accepted), [lines]);

  // Compute recovery impact ranking on accepted lines with variance
  const rankedLines = useMemo(() => {
    const withVariance = lines
      .filter((l) => l.is_accepted && l.carrier_quantity != null && l.carrier_unit_price != null)
      .map((l) => ({ id: l.id, variance: Math.abs(l.quantity * l.unit_price - (l.carrier_quantity! * l.carrier_unit_price!)) }))
      .sort((a, b) => b.variance - a.variance);
    const rankMap = new Map<string, number>();
    withVariance.forEach((v, i) => rankMap.set(v.id, i + 1));
    return rankMap;
  }, [lines]);

  // Top 5 disputes
  const top5Ids = useMemo(() => {
    const sorted = lines
      .filter((l) => l.is_accepted && l.carrier_quantity != null && l.carrier_unit_price != null)
      .map((l) => ({ id: l.id, variance: Math.abs(l.quantity * l.unit_price - (l.carrier_quantity! * l.carrier_unit_price!)) }))
      .sort((a, b) => b.variance - a.variance)
      .slice(0, 5)
      .map((v) => v.id);
    return new Set(sorted);
  }, [lines]);

  const rebuttalLines = useMemo(() => lines.filter((l) => l.used_in_rebuttal), [lines]);

  const totals = useMemo(() => {
    const accepted = lines.filter((l) => l.is_accepted);
    const rcv = accepted.reduce((s, l) => s + l.quantity * l.unit_price, 0);
    const dep = accepted.reduce((s, l) => s + l.quantity * l.unit_price * (l.depreciation_pct / 100), 0);
    const acv = rcv - dep;
    const opLines = accepted.filter((l) => l.include_overhead || l.include_profit);
    const overhead = opLines.reduce((s, l) => s + (l.include_overhead ? l.quantity * l.unit_price * (l.overhead_pct / 100) : 0), 0);
    const profit = opLines.reduce((s, l) => s + (l.include_profit ? l.quantity * l.unit_price * (l.profit_pct / 100) : 0), 0);
    const carrierTotal = accepted.reduce((s, l) => s + (l.carrier_quantity != null && l.carrier_unit_price != null ? (l.carrier_quantity * l.carrier_unit_price) : 0), 0);
    const totalVariance = rcv - carrierTotal;
    return { rcv, dep, acv, overhead, profit, grandTotal: rcv + overhead + profit, carrierTotal, totalVariance };
  }, [lines]);

  const groupedByTrade = useMemo(() => {
    const groups: Record<string, EstimateLine[]> = {};
    lines.forEach((l) => {
      const trade = l.trade || l.category || "General";
      (groups[trade] = groups[trade] || []).push(l);
    });
    // Sort lines within each trade by recovery impact (top disputes first)
    Object.values(groups).forEach((tradeLines) => {
      tradeLines.sort((a, b) => {
        const aRank = rankedLines.get(a.id) ?? 9999;
        const bRank = rankedLines.get(b.id) ?? 9999;
        return aRank - bRank;
      });
    });
    return groups;
  }, [lines, rankedLines]);

  const updateLine = (id: string, field: string, value: any) => {
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const updated = { ...l, [field]: value };
        updated.rcv_total = updated.quantity * updated.unit_price;
        updated.depreciation_amount = updated.rcv_total * (updated.depreciation_pct / 100);
        updated.acv_total = updated.rcv_total - updated.depreciation_amount;
        if (updated.carrier_quantity != null && updated.carrier_unit_price != null) {
          updated.carrier_total = updated.carrier_quantity * updated.carrier_unit_price;
          updated.variance_amount = updated.rcv_total - updated.carrier_total;
        }
        return updated;
      })
    );
  };

  const addLine = () => {
    setLines((prev) => [...prev, {
      id: `temp-${Date.now()}`, category: "General", trade: "General", description: "",
      quantity: 1, unit: "EA", unit_price: 0, rcv_total: 0, depreciation_pct: 0,
      depreciation_amount: 0, acv_total: 0, include_overhead: false, include_profit: false,
      overhead_pct: 10, profit_pct: 10, source: "manual", is_suggested: false, is_accepted: true,
      code_reference: null, notes: null, rationale: null, reason_tag: null,
      carrier_quantity: null, carrier_unit_price: null, carrier_total: 0, variance_amount: 0,
      sort_order: prev.length, used_in_rebuttal: false, recovery_impact_rank: null, rebuttal_strength_score: null,
    }]);
  };

  const removeLine = (id: string) => setLines((prev) => prev.filter((l) => l.id !== id));

  const acceptAllSuggestions = () => {
    setLines((prev) => prev.map((l) => (l.is_suggested && !l.is_accepted) ? { ...l, is_accepted: true } : l));
    toast({ title: `${pendingSuggestions.length} suggestions accepted` });
  };

  const rejectAllSuggestions = () => {
    setLines((prev) => prev.filter((l) => !(l.is_suggested && !l.is_accepted)));
    toast({ title: `${pendingSuggestions.length} suggestions removed` });
  };

  const refreshOrchestrator = async () => {
    try {
      await supabase.functions.invoke("darwin-intelligence-orchestrator", {
        body: { claimId, triggerEvent: "estimate_updated" },
      });
    } catch { /* silent */ }
  };

  const saveAll = async () => {
    setSaving(true);
    try {
      const toInsert = lines.filter((l) => l.id.startsWith("temp-"));
      const toUpdate = lines.filter((l) => !l.id.startsWith("temp-"));
      const existingIds = toUpdate.map((l) => l.id);

      const { data: dbLines } = await supabase.from("darwin_estimate_lines").select("id").eq("claim_id", claimId);
      const dbIds = dbLines?.map((d: any) => d.id) || [];
      const toDelete = dbIds.filter((id: string) => !existingIds.includes(id));

      if (toDelete.length > 0) await supabase.from("darwin_estimate_lines").delete().in("id", toDelete);

      for (const line of toUpdate) {
        await supabase.from("darwin_estimate_lines").update({
          category: line.category, trade: line.trade, description: line.description,
          quantity: line.quantity, unit: line.unit, unit_price: line.unit_price,
          depreciation_pct: line.depreciation_pct, include_overhead: line.include_overhead,
          include_profit: line.include_profit, overhead_pct: line.overhead_pct,
          profit_pct: line.profit_pct, is_accepted: line.is_accepted,
          code_reference: line.code_reference, notes: line.notes, sort_order: line.sort_order,
          reason_tag: line.reason_tag, rationale: line.rationale,
          carrier_quantity: line.carrier_quantity, carrier_unit_price: line.carrier_unit_price,
          used_in_rebuttal: line.used_in_rebuttal,
          recovery_impact_rank: rankedLines.get(line.id) ?? null,
          rebuttal_strength_score: line.rebuttal_strength_score,
        }).eq("id", line.id);
      }

      if (toInsert.length > 0) {
        await supabase.from("darwin_estimate_lines").insert(
          toInsert.map((l, i) => ({
            claim_id: claimId, category: l.category, trade: l.trade, description: l.description,
            quantity: l.quantity, unit: l.unit, unit_price: l.unit_price,
            depreciation_pct: l.depreciation_pct, include_overhead: l.include_overhead,
            include_profit: l.include_profit, overhead_pct: l.overhead_pct,
            profit_pct: l.profit_pct, source: l.source, is_suggested: l.is_suggested,
            is_accepted: l.is_accepted, code_reference: l.code_reference, notes: l.notes,
            sort_order: l.sort_order, reason_tag: l.reason_tag, rationale: l.rationale,
            carrier_quantity: l.carrier_quantity, carrier_unit_price: l.carrier_unit_price,
            used_in_rebuttal: l.used_in_rebuttal,
          }))
        );
      }

      toast({ title: "Estimate saved" });
      loadLines();
      refreshOrchestrator();
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const suggestMissingItems = async () => {
    setSuggesting(true);
    try {
      const { data, error } = await supabase.functions.invoke("darwin-estimate-intelligence", {
        body: { claimId, action: "suggest_missing_items" },
      });
      if (error) throw error;

      const suggestions = data?.suggestions || data?.findings || [];
      if (Array.isArray(suggestions) && suggestions.length > 0) {
        const newLines: EstimateLine[] = suggestions.map((s: any, i: number) => ({
          id: `temp-sug-${Date.now()}-${i}`, category: s.category || "General",
          trade: s.trade || "General",
          description: s.description || s.item || "Suggested item",
          quantity: Number(s.quantity) || 1, unit: s.unit || "EA",
          unit_price: Number(s.unit_price || s.price) || 0,
          rcv_total: Number(s.quantity || 1) * Number(s.unit_price || s.price || 0),
          depreciation_pct: Number(s.depreciation_pct) || 0, depreciation_amount: 0, acv_total: 0,
          include_overhead: false, include_profit: false, overhead_pct: 10, profit_pct: 10,
          source: "darwin_suggestion", is_suggested: true, is_accepted: false,
          code_reference: s.code_reference || null,
          notes: null,
          rationale: s.rationale || s.reason || s.notes || "AI-identified gap",
          reason_tag: s.reason_tag || s.tag || "omission",
          carrier_quantity: s.carrier_quantity != null ? Number(s.carrier_quantity) : null,
          carrier_unit_price: s.carrier_unit_price != null ? Number(s.carrier_unit_price) : null,
          carrier_total: 0, variance_amount: 0,
          sort_order: lines.length + i,
          used_in_rebuttal: false, recovery_impact_rank: null, rebuttal_strength_score: null,
        }));
        setLines((prev) => [...prev, ...newLines]);
        toast({ title: `${newLines.length} items suggested`, description: "Review rationale and accept or reject." });
      } else {
        toast({ title: "No suggestions", description: "Darwin found no additional missing items." });
      }
    } catch (err: any) {
      toast({ title: "Suggestion failed", description: err.message, variant: "destructive" });
    } finally {
      setSuggesting(false);
    }
  };

  const handleImportEstimate = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = "";

    setImporting(true);
    try {
      let extractedText = "";

      // Text-based extraction for common formats
      if (file.type === "text/csv" || file.name.endsWith(".csv") || file.type === "text/plain" || file.name.endsWith(".txt")) {
        extractedText = await file.text();
      } else if (file.type.includes("spreadsheet") || file.name.endsWith(".xlsx") || file.name.endsWith(".xls")) {
        // Use xlsx library for spreadsheets
        const { read, utils } = await import("xlsx");
        const buffer = await file.arrayBuffer();
        const wb = read(buffer);
        const allText: string[] = [];
        wb.SheetNames.forEach((name: string) => {
          const ws = wb.Sheets[name];
          allText.push(utils.sheet_to_csv(ws));
        });
        extractedText = allText.join("\n\n");
      } else {
        // For PDFs and other binary docs, send full base64 for multimodal vision extraction
        const buffer = await file.arrayBuffer();
        const uint8 = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 32768;
        for (let i = 0; i < uint8.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, Array.from(uint8.slice(i, i + chunkSize)));
        }
        const base64 = btoa(binary);
        
        const { data: extractData, error: extractError } = await supabase.functions.invoke("darwin-estimate-import", {
          body: {
            claimId,
            base64Data: base64,
            mimeType: file.type || "application/pdf",
            fileName: file.name,
          },
        });
        if (extractError) throw extractError;
        if (extractData?.error) throw new Error(extractData.error);

        toast({
          title: `${extractData?.imported || 0} line items imported`,
          description: `From ${file.name} (${extractData?.document_type || "estimate"})`,
        });
        loadLines();
        if (extractData?.document_type === "carrier_estimate") setShowCarrier(true);
        refreshOrchestrator();
        setImporting(false);
        return;
      }

      if (!extractedText.trim()) {
        toast({ title: "No text extracted", description: "Could not read content from this file.", variant: "destructive" });
        setImporting(false);
        return;
      }

      const { data, error } = await supabase.functions.invoke("darwin-estimate-import", {
        body: {
          claimId,
          extractedText,
          fileName: file.name,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast({
        title: `${data?.imported || 0} line items imported`,
        description: `From ${file.name} (${data?.document_type || "estimate"})`,
      });
      loadLines();
      if (data?.document_type === "carrier_estimate") setShowCarrier(true);
      refreshOrchestrator();
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setImporting(false);
    }
  };

  const toggleTrade = (trade: string) => {
    setCollapsedTrades((prev) => {
      const next = new Set(prev);
      next.has(trade) ? next.delete(trade) : next.add(trade);
      return next;
    });
  };

  // Dynamic grid columns — add rebuttal column
  const gridCols = useMemo(() => {
    let cols = "28px 1fr 60px 50px 80px 80px";
    if (showCarrier) cols += " 60px 80px 80px";
    if (showDepreciation) cols += " 60px 80px";
    if (showOP) cols += " 50px 50px";
    cols += " 70px 28px 28px";
    return cols;
  }, [showCarrier, showDepreciation, showOP]);

  if (loading) {
    return <Card><CardContent className="p-6 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></CardContent></Card>;
  }

  return (
    <TooltipProvider>
      <Card>
        <CardHeader className="py-3 px-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Calculator className="h-4 w-4 text-primary" />
              Darwin Estimate Builder
              <Badge variant="secondary" className="text-[10px]">{lines.length} items</Badge>
              {totals.totalVariance > 0 && showCarrier && (
                <Badge className="text-[10px] bg-success/20 text-success">+${totals.totalVariance.toLocaleString(undefined, { maximumFractionDigits: 0 })} variance</Badge>
              )}
              {top5Ids.size > 0 && (
                <Badge className="text-[10px] bg-warning/20 text-warning">
                  <Star className="h-2.5 w-2.5 mr-0.5" />Top {top5Ids.size} disputes
                </Badge>
              )}
              {rebuttalLines.length > 0 && (
                <Badge className="text-[10px] bg-chart-2/20 text-chart-2">
                  <BookOpen className="h-2.5 w-2.5 mr-0.5" />{rebuttalLines.length} in rebuttal
                </Badge>
              )}
            </CardTitle>
            <div className="flex items-center gap-1.5 flex-wrap">
              {pendingSuggestions.length > 0 && (
                <div className="flex items-center gap-1 mr-2">
                  <Badge variant="outline" className="text-[10px] border-warning text-warning">{pendingSuggestions.length} pending</Badge>
                  <Button size="sm" variant="outline" className="h-6 text-[10px] gap-0.5 border-success/50 text-success hover:bg-success/10" onClick={acceptAllSuggestions}>
                    <CheckCheck className="h-3 w-3" /> Accept All
                  </Button>
                  <Button size="sm" variant="outline" className="h-6 text-[10px] gap-0.5 border-destructive/50 text-destructive hover:bg-destructive/10" onClick={rejectAllSuggestions}>
                    <XCircle className="h-3 w-3" /> Reject All
                  </Button>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.xlsx,.xls,.csv,.txt"
                className="hidden"
                onChange={handleImportEstimate}
              />
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => fileInputRef.current?.click()} disabled={importing}>
                {importing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                Import Estimate
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={suggestMissingItems} disabled={suggesting}>
                {suggesting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                Suggest Missing
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={addLine}>
                <Plus className="h-3 w-3" /> Add Line
              </Button>
              <Button size="sm" className="h-7 text-xs gap-1" onClick={saveAll} disabled={saving}>
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* Column toggles */}
          <div className="px-4 pb-2 flex gap-3 text-[10px] flex-wrap">
            <label className="flex items-center gap-1 cursor-pointer">
              <Checkbox checked={showCarrier} onCheckedChange={(v) => setShowCarrier(!!v)} className="h-3 w-3" />
              Carrier Comparison
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <Checkbox checked={showDepreciation} onCheckedChange={(v) => setShowDepreciation(!!v)} className="h-3 w-3" />
              Depreciation
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <Checkbox checked={showOP} onCheckedChange={(v) => setShowOP(!!v)} className="h-3 w-3" />
              O&P
            </label>
          </div>

          <ScrollArea className="max-h-[500px]">
            {/* Table header */}
            <div className="grid gap-1 px-4 py-2 bg-muted/50 border-y text-[10px] font-medium text-muted-foreground uppercase tracking-wider"
              style={{ gridTemplateColumns: gridCols }}>
              <div></div>
              <div>Description</div>
              <div className="text-right">Qty</div>
              <div>Unit</div>
              <div className="text-right">Unit Price</div>
              <div className="text-right">RCV Total</div>
              {showCarrier && (
                <>
                  <div className="text-right">C.Qty</div>
                  <div className="text-right">C.Price</div>
                  <div className="text-right flex items-center gap-0.5 justify-end"><ArrowRightLeft className="h-2.5 w-2.5" />Var.</div>
                </>
              )}
              {showDepreciation && <><div className="text-right">Dep%</div><div className="text-right">ACV</div></>}
              {showOP && <><div className="text-center">OH</div><div className="text-center">P</div></>}
              <div className="text-center"><Tag className="h-2.5 w-2.5 inline" /></div>
              <div className="text-center"><BookOpen className="h-2.5 w-2.5 inline" /></div>
              <div></div>
            </div>

            {/* Grouped by trade */}
            {Object.entries(groupedByTrade).map(([trade, tradeLines]) => {
              const isCollapsed = collapsedTrades.has(trade);
              const tradeRcv = tradeLines.filter((l) => l.is_accepted).reduce((s, l) => s + l.quantity * l.unit_price, 0);
              const tradeCarrier = showCarrier ? tradeLines.filter((l) => l.is_accepted).reduce((s, l) => s + (l.carrier_quantity != null && l.carrier_unit_price != null ? l.carrier_quantity * l.carrier_unit_price : 0), 0) : 0;

              return (
                <div key={trade}>
                  <button className="flex items-center gap-2 w-full px-4 py-1.5 bg-muted/30 hover:bg-muted/50 transition-colors text-xs font-medium" onClick={() => toggleTrade(trade)}>
                    {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    {trade}
                    <Badge variant="outline" className="text-[9px] ml-auto">{tradeLines.length} items</Badge>
                    {showCarrier && tradeCarrier > 0 && (
                      <span className="text-[10px] text-muted-foreground">C: ${tradeCarrier.toLocaleString(undefined, { minimumFractionDigits: 0 })}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground">${tradeRcv.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    {showCarrier && tradeRcv > tradeCarrier && tradeCarrier > 0 && (
                      <Badge className="text-[8px] bg-success/20 text-success">+${(tradeRcv - tradeCarrier).toLocaleString(undefined, { maximumFractionDigits: 0 })}</Badge>
                    )}
                  </button>
                  {!isCollapsed && tradeLines.map((line) => {
                    const reasonMeta = line.reason_tag ? REASON_TAG_MAP[line.reason_tag] : null;
                    const localVariance = line.carrier_quantity != null && line.carrier_unit_price != null
                      ? (line.quantity * line.unit_price) - (line.carrier_quantity * line.carrier_unit_price) : null;
                    const isTopDispute = top5Ids.has(line.id);
                    const rank = rankedLines.get(line.id);

                    return (
                      <div
                        key={line.id}
                        className={cn(
                          "grid gap-1 px-4 py-1 items-center border-b border-border/50 text-xs hover:bg-accent/30 transition-colors",
                          line.is_suggested && !line.is_accepted && "bg-warning/5 border-l-2 border-l-warning",
                          isTopDispute && "bg-chart-1/5 border-l-2 border-l-chart-1",
                          line.used_in_rebuttal && "ring-1 ring-inset ring-chart-2/30"
                        )}
                        style={{ gridTemplateColumns: gridCols }}
                      >
                        <div>
                          <Checkbox checked={line.is_accepted} onCheckedChange={(v) => updateLine(line.id, "is_accepted", !!v)} className="h-3.5 w-3.5" />
                        </div>
                        <div className="flex items-center gap-1 min-w-0">
                          {isTopDispute && rank && (
                            <Tooltip>
                              <TooltipTrigger>
                                <div className="flex items-center gap-0.5 shrink-0">
                                  <TrendingUp className="h-3 w-3 text-chart-1" />
                                  <span className="text-[9px] font-bold text-chart-1">#{rank}</span>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent className="text-xs">Recovery impact rank #{rank} — top dispute</TooltipContent>
                            </Tooltip>
                          )}
                          <Input
                            value={line.description}
                            onChange={(e) => updateLine(line.id, "description", e.target.value)}
                            className="h-6 text-xs border-transparent hover:border-input focus:border-input bg-transparent px-1 flex-1 min-w-0"
                          />
                          {line.is_suggested && !line.is_accepted && (
                            <Badge className="text-[8px] bg-warning/20 text-warning shrink-0">Suggested</Badge>
                          )}
                          {line.code_reference && (
                            <Badge variant="outline" className="text-[8px] shrink-0">{line.code_reference}</Badge>
                          )}
                          {line.rationale && (
                            <Tooltip>
                              <TooltipTrigger><Info className="h-3 w-3 text-muted-foreground shrink-0" /></TooltipTrigger>
                              <TooltipContent className="text-xs max-w-[250px]">{line.rationale}</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <Input type="number" value={line.quantity} onChange={(e) => updateLine(line.id, "quantity", Number(e.target.value))}
                          className="h-6 text-xs text-right border-transparent hover:border-input focus:border-input bg-transparent px-1" />
                        <Select value={line.unit} onValueChange={(v) => updateLine(line.id, "unit", v)}>
                          <SelectTrigger className="h-6 text-[10px] border-transparent hover:border-input bg-transparent px-1"><SelectValue /></SelectTrigger>
                          <SelectContent>{UNITS.map((u) => <SelectItem key={u} value={u} className="text-xs">{u}</SelectItem>)}</SelectContent>
                        </Select>
                        <Input type="number" step="0.01" value={line.unit_price} onChange={(e) => updateLine(line.id, "unit_price", Number(e.target.value))}
                          className="h-6 text-xs text-right border-transparent hover:border-input focus:border-input bg-transparent px-1" />
                        <div className="text-right font-medium text-xs tabular-nums">
                          ${(line.quantity * line.unit_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </div>

                        {showCarrier && (
                          <>
                            <Input type="number" value={line.carrier_quantity ?? ""} placeholder="—"
                              onChange={(e) => updateLine(line.id, "carrier_quantity", e.target.value ? Number(e.target.value) : null)}
                              className="h-6 text-xs text-right border-transparent hover:border-input focus:border-input bg-transparent px-1" />
                            <Input type="number" step="0.01" value={line.carrier_unit_price ?? ""} placeholder="—"
                              onChange={(e) => updateLine(line.id, "carrier_unit_price", e.target.value ? Number(e.target.value) : null)}
                              className="h-6 text-xs text-right border-transparent hover:border-input focus:border-input bg-transparent px-1" />
                            <div className={cn("text-right text-xs tabular-nums font-medium",
                              localVariance != null && localVariance > 0 ? "text-success" :
                              localVariance != null && localVariance < 0 ? "text-destructive" : "text-muted-foreground"
                            )}>
                              {localVariance != null ? `${localVariance >= 0 ? '+' : ''}$${localVariance.toLocaleString(undefined, { minimumFractionDigits: 0 })}` : "—"}
                            </div>
                          </>
                        )}

                        {showDepreciation && (
                          <>
                            <Input type="number" step="0.1" value={line.depreciation_pct} onChange={(e) => updateLine(line.id, "depreciation_pct", Number(e.target.value))}
                              className="h-6 text-xs text-right border-transparent hover:border-input focus:border-input bg-transparent px-1" />
                            <div className="text-right text-xs tabular-nums text-muted-foreground">
                              ${(line.quantity * line.unit_price * (1 - line.depreciation_pct / 100)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </div>
                          </>
                        )}
                        {showOP && (
                          <>
                            <div className="text-center"><Checkbox checked={line.include_overhead} onCheckedChange={(v) => updateLine(line.id, "include_overhead", !!v)} className="h-3 w-3" /></div>
                            <div className="text-center"><Checkbox checked={line.include_profit} onCheckedChange={(v) => updateLine(line.id, "include_profit", !!v)} className="h-3 w-3" /></div>
                          </>
                        )}

                        {/* Reason tag */}
                        <div>
                          <Select value={line.reason_tag || "none"} onValueChange={(v) => updateLine(line.id, "reason_tag", v === "none" ? null : v)}>
                            <SelectTrigger className={cn("h-5 text-[9px] px-1 border-transparent", reasonMeta?.color)}>
                              <SelectValue placeholder="—" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none" className="text-xs">None</SelectItem>
                              {REASON_TAGS.map((r) => (
                                <SelectItem key={r.value} value={r.value} className="text-xs">{r.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {/* Used in rebuttal toggle */}
                        <div className="text-center">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => updateLine(line.id, "used_in_rebuttal", !line.used_in_rebuttal)}>
                                <BookOpen className={cn("h-3 w-3", line.used_in_rebuttal ? "text-chart-2" : "text-muted-foreground/40")} />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">{line.used_in_rebuttal ? "Used in rebuttal" : "Mark as used in rebuttal"}</TooltipContent>
                          </Tooltip>
                        </div>

                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive/60 hover:text-destructive" onClick={() => removeLine(line.id)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {lines.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-8">
                No line items yet. Add manually or let Darwin suggest items.
              </div>
            )}
          </ScrollArea>

          {/* Totals footer */}
          {lines.length > 0 && (
            <div className="border-t bg-muted/30 p-4 space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">RCV Total (Darwin)</span>
                <span className="font-semibold tabular-nums">${totals.rcv.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
              {showCarrier && totals.carrierTotal > 0 && (
                <>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">RCV Total (Carrier)</span>
                    <span className="tabular-nums">${totals.carrierTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground font-medium">Variance</span>
                    <span className={cn("font-bold tabular-nums", totals.totalVariance > 0 ? "text-success" : "text-destructive")}>
                      {totals.totalVariance >= 0 ? '+' : ''}${totals.totalVariance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </>
              )}
              {showDepreciation && (
                <>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Depreciation</span>
                    <span className="tabular-nums text-destructive">-${totals.dep.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">ACV Total</span>
                    <span className="font-semibold tabular-nums">${totals.acv.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                </>
              )}
              {showOP && (totals.overhead > 0 || totals.profit > 0) && (
                <>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Overhead</span>
                    <span className="tabular-nums">${totals.overhead.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Profit</span>
                    <span className="tabular-nums">${totals.profit.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between text-sm font-bold pt-1 border-t">
                <span>Grand Total</span>
                <span className="tabular-nums text-primary">
                  <DollarSign className="h-3.5 w-3.5 inline" />
                  {totals.grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  );
};
