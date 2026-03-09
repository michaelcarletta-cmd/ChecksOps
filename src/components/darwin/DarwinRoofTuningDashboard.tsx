import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  Settings2, RefreshCw, Loader2, Shield, AlertTriangle, TrendingDown,
  TrendingUp, Eye, EyeOff, ChevronDown, ChevronUp, Activity, Zap, Ban
} from "lucide-react";

interface Heuristic {
  id: string;
  heuristic_key: string;
  heuristic_type: string;
  segment_roof_form: string | null;
  segment_geometry_source: string | null;
  segment_quality_score_min: number | null;
  segment_quality_score_max: number | null;
  segment_aspect_ratio_min: number | null;
  segment_aspect_ratio_max: number | null;
  segment_confidence_min: number | null;
  segment_confidence_max: number | null;
  action_type: string;
  adjustment_field: string | null;
  adjustment_factor: number | null;
  suppress_field: string | null;
  suppress_below_confidence: number | null;
  sample_size: number;
  avg_accuracy_score: number | null;
  avg_pct_delta: number | null;
  median_pct_delta: number | null;
  failure_rate: number | null;
  common_failures: string[];
  evidence_summary: string | null;
  is_active: boolean;
  auto_derived: boolean;
  manually_overridden: boolean;
  last_computed_at: string | null;
  created_at: string;
}

const TYPE_ICONS: Record<string, typeof Settings2> = {
  adjustment: TrendingDown,
  suppression: Ban,
};

const ACTION_LABELS: Record<string, string> = {
  adjust_value: "Value Adjustment",
  adjust_confidence: "Confidence Adjustment",
  suppress_field: "Field Suppression",
};

const qualityBandLabel = (min: number | null, max: number | null): string => {
  if (min == null) return "All";
  if (min === 0 && (max ?? 0) < 40) return "Low (0-39)";
  if ((min ?? 0) >= 40 && (max ?? 0) < 70) return "Medium (40-69)";
  if ((min ?? 0) >= 70) return "High (70-100)";
  return `${min}-${max}`;
};

const arBandLabel = (min: number | null, max: number | null): string => {
  if (min == null) return "All";
  if ((max ?? 0) < 1.3) return "Compact (<1.3)";
  if ((min ?? 0) >= 1.3 && (max ?? 0) < 2) return "Rectangular (1.3-2.0)";
  if ((min ?? 0) >= 2) return "Elongated (≥2.0)";
  return `${min}-${max}`;
};

export const DarwinRoofTuningDashboard = () => {
  const [heuristics, setHeuristics] = useState<Heuristic[]>([]);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const fetchHeuristics = useCallback(async () => {
    const { data, error } = await supabase
      .from("darwin_roof_tuning_heuristics")
      .select("*")
      .order("is_active", { ascending: false })
      .order("sample_size", { ascending: false });

    if (error) {
      toast.error("Failed to load tuning heuristics");
      return;
    }
    setHeuristics((data || []) as unknown as Heuristic[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchHeuristics(); }, [fetchHeuristics]);

  const recompute = async () => {
    setRecomputing(true);
    try {
      const { data, error } = await supabase.functions.invoke("darwin-roof-tuning", {
        body: { action: "recompute" },
      });
      if (error) throw new Error(error.message);
      toast.success(`Tuning recomputed: ${data.heuristics_derived} heuristics from ${data.total_validations} validations (${data.buckets_analyzed} segments)`);
      fetchHeuristics();
    } catch (err: any) {
      toast.error(err.message || "Recompute failed");
    } finally {
      setRecomputing(false);
    }
  };

  const toggleHeuristic = async (id: string, active: boolean) => {
    try {
      const { error } = await supabase.functions.invoke("darwin-roof-tuning", {
        body: { action: "toggle", heuristic_id: id, is_active: active },
      });
      if (error) throw new Error(error.message);
      setHeuristics(prev => prev.map(h => h.id === id ? { ...h, is_active: active, manually_overridden: true } : h));
      toast.success(`Heuristic ${active ? "activated" : "deactivated"}`);
    } catch (err: any) {
      toast.error(err.message || "Toggle failed");
    }
  };

  const activeHeuristics = heuristics.filter(h => h.is_active);
  const inactiveHeuristics = heuristics.filter(h => !h.is_active);
  const displayed = showInactive ? heuristics : activeHeuristics;

  // Summary stats
  const totalActive = activeHeuristics.length;
  const totalAdjustments = activeHeuristics.filter(h => h.action_type.startsWith("adjust")).length;
  const totalSuppressions = activeHeuristics.filter(h => h.action_type === "suppress_field").length;
  const avgSampleSize = heuristics.length > 0
    ? Math.round(heuristics.reduce((s, h) => s + h.sample_size, 0) / heuristics.length)
    : 0;

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
          <span className="text-sm text-muted-foreground">Loading tuning heuristics...</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Settings2 className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">Darwin Roof Tuning</CardTitle>
              <Badge variant="outline" className="text-[10px]">
                {totalActive} active / {heuristics.length} total
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowInactive(!showInactive)}>
                {showInactive ? <EyeOff className="h-4 w-4 mr-1" /> : <Eye className="h-4 w-4 mr-1" />}
                {showInactive ? "Hide Inactive" : "Show All"}
              </Button>
              <Button size="sm" onClick={recompute} disabled={recomputing}>
                {recomputing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                Recompute from Validations
              </Button>
            </div>
          </div>
          <CardDescription>
            Heuristics derived from validation outcomes. Active rules adjust Darwin estimates before presentation. Toggle individually or recompute from latest validation data.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Summary Stats */}
          <div className="grid grid-cols-4 gap-3">
            <div className="rounded-lg border p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-primary">{totalActive}</div>
              <div className="text-xs text-muted-foreground">Active Rules</div>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <div className="text-2xl font-bold tabular-nums">{totalAdjustments}</div>
              <div className="text-xs text-muted-foreground">Adjustments</div>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <div className="text-2xl font-bold tabular-nums">{totalSuppressions}</div>
              <div className="text-xs text-muted-foreground">Suppressions</div>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <div className="text-2xl font-bold tabular-nums">{avgSampleSize}</div>
              <div className="text-xs text-muted-foreground">Avg Sample Size</div>
            </div>
          </div>

          {displayed.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <Settings2 className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No {showInactive ? "" : "active "}tuning heuristics found.</p>
              <p className="text-xs mt-1">Add validations to claims and recompute to generate heuristics.</p>
            </div>
          )}

          {/* Heuristic Cards */}
          {displayed.map((h) => {
            const expanded = expandedId === h.id;
            const Icon = TYPE_ICONS[h.heuristic_type] || Zap;

            return (
              <div
                key={h.id}
                className={`rounded-lg border p-3 space-y-2 transition-colors ${
                  h.is_active ? "border-primary/30 bg-primary/5" : "opacity-60"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Icon className={`h-4 w-4 shrink-0 ${h.is_active ? "text-primary" : "text-muted-foreground"}`} />
                    <span className="text-sm font-medium truncate">{h.heuristic_key}</span>
                    <Badge variant="outline" className="text-[9px] shrink-0">
                      {ACTION_LABELS[h.action_type] || h.action_type}
                    </Badge>
                    {h.manually_overridden && (
                      <Badge variant="secondary" className="text-[9px] shrink-0">Manual Override</Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={`text-[9px] shrink-0 ${h.sample_size >= 5 ? "border-green-500/50" : h.sample_size >= 3 ? "border-yellow-500/50" : "border-red-500/50"}`}
                    >
                      n={h.sample_size}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={h.is_active}
                      onCheckedChange={(checked) => toggleHeuristic(h.id, checked)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={() => setExpandedId(expanded ? null : h.id)}
                    >
                      {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </Button>
                  </div>
                </div>

                {/* Summary line */}
                <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
                  {h.segment_roof_form && (
                    <span>Form: <strong>{h.segment_roof_form}</strong></span>
                  )}
                  {h.segment_geometry_source && (
                    <span>Source: <strong>{h.segment_geometry_source}</strong></span>
                  )}
                  <span>Quality: <strong>{qualityBandLabel(h.segment_quality_score_min, h.segment_quality_score_max)}</strong></span>
                  <span>AR: <strong>{arBandLabel(h.segment_aspect_ratio_min, h.segment_aspect_ratio_max)}</strong></span>
                  {h.adjustment_field && (
                    <span>
                      Field: <strong>{h.adjustment_field}</strong>
                      {h.adjustment_factor != null && ` ×${h.adjustment_factor}`}
                    </span>
                  )}
                  {h.suppress_field && (
                    <span>Suppress: <strong>{h.suppress_field}</strong> below {h.suppress_below_confidence}%</span>
                  )}
                  {h.failure_rate != null && (
                    <span className={h.failure_rate > 0.5 ? "text-red-500" : ""}>
                      Fail rate: <strong>{Math.round(h.failure_rate * 100)}%</strong>
                    </span>
                  )}
                </div>

                {/* Expanded details */}
                {expanded && (
                  <div className="mt-2 space-y-3 border-t pt-3">
                    {h.evidence_summary && (
                      <div className="text-xs bg-muted/50 rounded p-2">
                        <strong>Evidence:</strong> {h.evidence_summary}
                      </div>
                    )}

                    <div className="grid grid-cols-4 gap-3 text-xs">
                      <div>
                        <span className="text-muted-foreground">Avg Accuracy:</span>{" "}
                        <span className="font-medium tabular-nums">{h.avg_accuracy_score != null ? `${Math.round(h.avg_accuracy_score)}%` : "—"}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Avg Δ:</span>{" "}
                        <span className={`font-medium tabular-nums ${(h.avg_pct_delta ?? 0) > 0 ? "text-red-500" : "text-green-600"}`}>
                          {h.avg_pct_delta != null ? `${h.avg_pct_delta > 0 ? "+" : ""}${h.avg_pct_delta}%` : "—"}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Median Δ:</span>{" "}
                        <span className="font-medium tabular-nums">
                          {h.median_pct_delta != null ? `${h.median_pct_delta > 0 ? "+" : ""}${h.median_pct_delta}%` : "—"}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Last Computed:</span>{" "}
                        <span className="font-medium">
                          {h.last_computed_at ? new Date(h.last_computed_at).toLocaleDateString() : "—"}
                        </span>
                      </div>
                    </div>

                    {h.common_failures && (h.common_failures as string[]).length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        <span className="text-[10px] text-muted-foreground">Failures:</span>
                        {(h.common_failures as string[]).map((f, i) => (
                          <Badge key={i} variant="destructive" className="text-[9px] h-4">
                            {f}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {h.action_type === "adjust_value" && h.adjustment_factor != null && (
                      <div className="flex items-center gap-2 text-xs rounded bg-primary/10 p-2">
                        <Activity className="h-3.5 w-3.5 text-primary" />
                        <span>
                          When active, Darwin multiplies <strong>{h.adjustment_field}</strong> by <strong>{h.adjustment_factor}</strong> before presenting results.
                          {h.avg_pct_delta != null && ` Corrects for ~${Math.abs(Math.round(h.avg_pct_delta))}% systematic ${h.avg_pct_delta > 0 ? "over" : "under"}estimation.`}
                        </span>
                      </div>
                    )}

                    {h.action_type === "adjust_confidence" && (
                      <div className="flex items-center gap-2 text-xs rounded bg-yellow-500/10 p-2">
                        <AlertTriangle className="h-3.5 w-3.5 text-yellow-600" />
                        <span>
                          When active, <strong>{h.adjustment_field}</strong> is multiplied by <strong>{h.adjustment_factor}</strong>, reducing displayed confidence to reflect validation evidence.
                        </span>
                      </div>
                    )}

                    {h.action_type === "suppress_field" && (
                      <div className="flex items-center gap-2 text-xs rounded bg-red-500/10 p-2">
                        <Ban className="h-3.5 w-3.5 text-red-500" />
                        <span>
                          When active, <strong>{h.suppress_field}</strong> is suppressed (hidden/zeroed) when its confidence falls below <strong>{h.suppress_below_confidence}%</strong>.
                          Field is too unreliable in this segment for useful inference.
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {!showInactive && inactiveHeuristics.length > 0 && (
            <div className="text-center text-xs text-muted-foreground pt-2">
              {inactiveHeuristics.length} inactive heuristic(s) hidden.{" "}
              <button className="underline" onClick={() => setShowInactive(true)}>Show all</button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
