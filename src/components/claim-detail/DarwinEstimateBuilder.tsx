import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Trash2, Save, Loader2, Sparkles, Calculator,
  ChevronDown, ChevronRight, DollarSign, AlertCircle
} from "lucide-react";
import { cn } from "@/lib/utils";

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
  sort_order: number;
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
  const [collapsedTrades, setCollapsedTrades] = useState<Set<string>>(new Set());
  const [showDepreciation, setShowDepreciation] = useState(false);
  const [showOP, setShowOP] = useState(false);
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
      })));
      // Show columns if any line uses them
      if (data.some((d: any) => Number(d.depreciation_pct) > 0)) setShowDepreciation(true);
      if (data.some((d: any) => d.include_overhead || d.include_profit)) setShowOP(true);
    }
    setLoading(false);
  }, [claimId]);

  useEffect(() => { loadLines(); }, [loadLines]);

  // Computed totals
  const totals = useMemo(() => {
    const accepted = lines.filter((l) => l.is_accepted);
    const rcv = accepted.reduce((s, l) => s + l.quantity * l.unit_price, 0);
    const dep = accepted.reduce((s, l) => s + l.quantity * l.unit_price * (l.depreciation_pct / 100), 0);
    const acv = rcv - dep;
    const opLines = accepted.filter((l) => l.include_overhead || l.include_profit);
    const overhead = opLines.reduce((s, l) => s + (l.include_overhead ? l.quantity * l.unit_price * (l.overhead_pct / 100) : 0), 0);
    const profit = opLines.reduce((s, l) => s + (l.include_profit ? l.quantity * l.unit_price * (l.profit_pct / 100) : 0), 0);
    return { rcv, dep, acv, overhead, profit, grandTotal: rcv + overhead + profit };
  }, [lines]);

  // Group by trade
  const groupedByTrade = useMemo(() => {
    const groups: Record<string, EstimateLine[]> = {};
    lines.forEach((l) => {
      const trade = l.trade || l.category || "General";
      (groups[trade] = groups[trade] || []).push(l);
    });
    return groups;
  }, [lines]);

  const updateLine = (id: string, field: string, value: any) => {
    setLines((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l;
        const updated = { ...l, [field]: value };
        // Recompute derived values locally
        updated.rcv_total = updated.quantity * updated.unit_price;
        updated.depreciation_amount = updated.rcv_total * (updated.depreciation_pct / 100);
        updated.acv_total = updated.rcv_total - updated.depreciation_amount;
        return updated;
      })
    );
  };

  const addLine = () => {
    const newLine: EstimateLine = {
      id: `temp-${Date.now()}`,
      category: "General",
      trade: "General",
      description: "",
      quantity: 1,
      unit: "EA",
      unit_price: 0,
      rcv_total: 0,
      depreciation_pct: 0,
      depreciation_amount: 0,
      acv_total: 0,
      include_overhead: false,
      include_profit: false,
      overhead_pct: 10,
      profit_pct: 10,
      source: "manual",
      is_suggested: false,
      is_accepted: true,
      code_reference: null,
      notes: null,
      sort_order: lines.length,
    };
    setLines((prev) => [...prev, newLine]);
  };

  const removeLine = (id: string) => {
    setLines((prev) => prev.filter((l) => l.id !== id));
  };

  const saveAll = async () => {
    setSaving(true);
    try {
      // Separate new vs existing
      const toInsert = lines.filter((l) => l.id.startsWith("temp-"));
      const toUpdate = lines.filter((l) => !l.id.startsWith("temp-"));
      const existingIds = toUpdate.map((l) => l.id);

      // Delete removed lines
      const { data: dbLines } = await supabase
        .from("darwin_estimate_lines")
        .select("id")
        .eq("claim_id", claimId);
      const dbIds = dbLines?.map((d: any) => d.id) || [];
      const toDelete = dbIds.filter((id: string) => !existingIds.includes(id));

      const ops: Promise<any>[] = [];

      if (toDelete.length > 0) {
        ops.push(supabase.from("darwin_estimate_lines").delete().in("id", toDelete));
      }

      for (const line of toUpdate) {
        ops.push(
          supabase.from("darwin_estimate_lines").update({
            category: line.category,
            trade: line.trade,
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            unit_price: line.unit_price,
            depreciation_pct: line.depreciation_pct,
            include_overhead: line.include_overhead,
            include_profit: line.include_profit,
            overhead_pct: line.overhead_pct,
            profit_pct: line.profit_pct,
            is_accepted: line.is_accepted,
            code_reference: line.code_reference,
            notes: line.notes,
            sort_order: line.sort_order,
          }).eq("id", line.id)
        );
      }

      if (toInsert.length > 0) {
        ops.push(
          supabase.from("darwin_estimate_lines").insert(
            toInsert.map((l, i) => ({
              claim_id: claimId,
              category: l.category,
              trade: l.trade,
              description: l.description,
              quantity: l.quantity,
              unit: l.unit,
              unit_price: l.unit_price,
              depreciation_pct: l.depreciation_pct,
              include_overhead: l.include_overhead,
              include_profit: l.include_profit,
              overhead_pct: l.overhead_pct,
              profit_pct: l.profit_pct,
              source: l.source,
              is_suggested: l.is_suggested,
              is_accepted: l.is_accepted,
              code_reference: l.code_reference,
              notes: l.notes,
              sort_order: l.sort_order,
            }))
          )
        );
      }

      await Promise.all(ops);
      toast({ title: "Estimate saved" });
      loadLines();
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
          id: `temp-sug-${Date.now()}-${i}`,
          category: s.category || "General",
          trade: s.trade || "General",
          description: s.description || s.item || "Suggested item",
          quantity: Number(s.quantity) || 1,
          unit: s.unit || "EA",
          unit_price: Number(s.unit_price || s.price) || 0,
          rcv_total: Number(s.quantity || 1) * Number(s.unit_price || s.price || 0),
          depreciation_pct: Number(s.depreciation_pct) || 0,
          depreciation_amount: 0,
          acv_total: 0,
          include_overhead: false,
          include_profit: false,
          overhead_pct: 10,
          profit_pct: 10,
          source: "darwin_suggestion",
          is_suggested: true,
          is_accepted: false,
          code_reference: s.code_reference || null,
          notes: s.rationale || s.notes || null,
          sort_order: lines.length + i,
        }));
        setLines((prev) => [...prev, ...newLines]);
        toast({ title: `${newLines.length} items suggested`, description: "Review and accept the suggested items below." });
      } else {
        toast({ title: "No suggestions", description: "Darwin found no additional missing items." });
      }
    } catch (err: any) {
      toast({ title: "Suggestion failed", description: err.message, variant: "destructive" });
    } finally {
      setSuggesting(false);
    }
  };

  const toggleTrade = (trade: string) => {
    setCollapsedTrades((prev) => {
      const next = new Set(prev);
      if (next.has(trade)) next.delete(trade);
      else next.add(trade);
      return next;
    });
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Calculator className="h-4 w-4 text-primary" />
            Darwin Estimate Builder
            <Badge variant="secondary" className="text-[10px]">{lines.length} items</Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
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
        <div className="px-4 pb-2 flex gap-3 text-[10px]">
          <label className="flex items-center gap-1 cursor-pointer">
            <Checkbox checked={showDepreciation} onCheckedChange={(v) => setShowDepreciation(!!v)} className="h-3 w-3" />
            Show Depreciation
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <Checkbox checked={showOP} onCheckedChange={(v) => setShowOP(!!v)} className="h-3 w-3" />
            Show O&P
          </label>
        </div>

        <ScrollArea className="max-h-[500px]">
          {/* Table header */}
          <div className="grid gap-1 px-4 py-2 bg-muted/50 border-y text-[10px] font-medium text-muted-foreground uppercase tracking-wider"
            style={{ gridTemplateColumns: `28px 1fr 60px 50px 80px 80px ${showDepreciation ? '60px 80px ' : ''}${showOP ? '50px 50px ' : ''}28px` }}
          >
            <div></div>
            <div>Description</div>
            <div className="text-right">Qty</div>
            <div>Unit</div>
            <div className="text-right">Unit Price</div>
            <div className="text-right">RCV Total</div>
            {showDepreciation && <><div className="text-right">Dep%</div><div className="text-right">ACV</div></>}
            {showOP && <><div className="text-center">OH</div><div className="text-center">P</div></>}
            <div></div>
          </div>

          {/* Grouped by trade */}
          {Object.entries(groupedByTrade).map(([trade, tradeLines]) => {
            const isCollapsed = collapsedTrades.has(trade);
            const tradeRcv = tradeLines.filter((l) => l.is_accepted).reduce((s, l) => s + l.quantity * l.unit_price, 0);

            return (
              <div key={trade}>
                <button
                  className="flex items-center gap-2 w-full px-4 py-1.5 bg-muted/30 hover:bg-muted/50 transition-colors text-xs font-medium"
                  onClick={() => toggleTrade(trade)}
                >
                  {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  {trade}
                  <Badge variant="outline" className="text-[9px] ml-auto">{tradeLines.length} items</Badge>
                  <span className="text-[10px] text-muted-foreground">${tradeRcv.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </button>
                {!isCollapsed &&
                  tradeLines.map((line) => (
                    <div
                      key={line.id}
                      className={cn(
                        "grid gap-1 px-4 py-1 items-center border-b border-border/50 text-xs hover:bg-accent/30 transition-colors",
                        line.is_suggested && !line.is_accepted && "bg-warning/5 border-l-2 border-l-warning"
                      )}
                      style={{ gridTemplateColumns: `28px 1fr 60px 50px 80px 80px ${showDepreciation ? '60px 80px ' : ''}${showOP ? '50px 50px ' : ''}28px` }}
                    >
                      <div>
                        <Checkbox
                          checked={line.is_accepted}
                          onCheckedChange={(v) => updateLine(line.id, "is_accepted", !!v)}
                          className="h-3.5 w-3.5"
                        />
                      </div>
                      <div className="flex items-center gap-1">
                        <Input
                          value={line.description}
                          onChange={(e) => updateLine(line.id, "description", e.target.value)}
                          className="h-6 text-xs border-transparent hover:border-input focus:border-input bg-transparent px-1"
                        />
                        {line.is_suggested && !line.is_accepted && (
                          <Badge className="text-[8px] bg-warning/20 text-warning shrink-0">Suggested</Badge>
                        )}
                        {line.code_reference && (
                          <Badge variant="outline" className="text-[8px] shrink-0">{line.code_reference}</Badge>
                        )}
                      </div>
                      <Input
                        type="number"
                        value={line.quantity}
                        onChange={(e) => updateLine(line.id, "quantity", Number(e.target.value))}
                        className="h-6 text-xs text-right border-transparent hover:border-input focus:border-input bg-transparent px-1"
                      />
                      <Select value={line.unit} onValueChange={(v) => updateLine(line.id, "unit", v)}>
                        <SelectTrigger className="h-6 text-[10px] border-transparent hover:border-input bg-transparent px-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {UNITS.map((u) => <SelectItem key={u} value={u} className="text-xs">{u}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        step="0.01"
                        value={line.unit_price}
                        onChange={(e) => updateLine(line.id, "unit_price", Number(e.target.value))}
                        className="h-6 text-xs text-right border-transparent hover:border-input focus:border-input bg-transparent px-1"
                      />
                      <div className="text-right font-medium text-xs tabular-nums">
                        ${(line.quantity * line.unit_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </div>
                      {showDepreciation && (
                        <>
                          <Input
                            type="number"
                            step="0.1"
                            value={line.depreciation_pct}
                            onChange={(e) => updateLine(line.id, "depreciation_pct", Number(e.target.value))}
                            className="h-6 text-xs text-right border-transparent hover:border-input focus:border-input bg-transparent px-1"
                          />
                          <div className="text-right text-xs tabular-nums text-muted-foreground">
                            ${(line.quantity * line.unit_price * (1 - line.depreciation_pct / 100)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </div>
                        </>
                      )}
                      {showOP && (
                        <>
                          <div className="text-center">
                            <Checkbox
                              checked={line.include_overhead}
                              onCheckedChange={(v) => updateLine(line.id, "include_overhead", !!v)}
                              className="h-3 w-3"
                            />
                          </div>
                          <div className="text-center">
                            <Checkbox
                              checked={line.include_profit}
                              onCheckedChange={(v) => updateLine(line.id, "include_profit", !!v)}
                              className="h-3 w-3"
                            />
                          </div>
                        </>
                      )}
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-destructive/60 hover:text-destructive" onClick={() => removeLine(line.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
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
              <span className="text-muted-foreground">RCV Total</span>
              <span className="font-semibold tabular-nums">${totals.rcv.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
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
  );
};
