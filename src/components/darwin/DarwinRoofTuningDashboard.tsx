
import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  Settings2, RefreshCw, Loader2, AlertTriangle,
  Eye, EyeOff, ChevronDown, ChevronUp, Activity, Zap, Ban,
  Shield, Clock, ShieldAlert, ShieldCheck, ShieldX
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
  // Governance
  min_sample_size: number | null;
  effective_from: string | null;
  expires_at: string | null;
  last_validation_support_at: string | null;
  staleness_days: number | null;
  max_adjustment_factor: number | null;
  min_adjustment_factor: number | null;
  max_confidence_penalty: number | null;
  priority: number | null;
  conflict_group: string | null;
  governance_status: string | null;
  governance_notes: string | null;
  // Shadow mode
  shadow_mode: boolean;
  shadow_mode_hits: number;
  shadow_mode_min_hits: number;
  shadow_mode_predicted_impacts: any[] | null;
  shadow_mode_promoted_at: string | null;
}

const TYPE_ICONS: Record<string, typeof Settings2> = {
  adjustment: Activity,
  suppression: Ban,
};

const ACTION_LABELS: Record<string, string> = {
  adjust_value: "Value Adjustment",
  adjust_confidence: "Confidence Adjustment",
  suppress_field: "Field Suppression",
};

const GOV_STATUS_CONFIG: Record<string, { icon: typeof Shield; color: string; label: string }> = {
  active: { icon: ShieldCheck, color: "text-green-600", label: "Active" },
  expired: { icon: ShieldX, color: "text-red-500", label: "Expired" },
  stale: { icon: Clock, color: "text-yellow-600", label: "Stale" },
  insufficient_evidence: { icon: ShieldAlert, color: "text-orange-500", label: "Low Evidence" },
  capped: { icon: Shield, color: "text-blue-500", label: "Capped" },
  conflict_suppressed: { icon: ShieldX, color: "text-muted-foreground", label: "Conflict Suppressed" },
  shadow_mode: { icon: Eye, color: "text-purple-500", label: "Shadow" },
  estimate_cap: { icon: Shield, color: "text-amber-500", label: "Estimate Cap" },
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

const GovernanceStatusBadge = ({ status }: { status: string | null }) => {
  const config = GOV_STATUS_CONFIG[status || "active"] || GOV_STATUS_CONFIG.active;
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={`text-[9px] shrink-0 gap-0.5 ${config.color}`}>
      <Icon className="h-2.5 w-2.5" />
      {config.label}
    </Badge>
  );
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
      const parts = [
        `${data.heuristics_derived} heuristics from ${data.total_validations} validations`,
        data.heuristics_expired > 0 ? `${data.heuristics_expired} expired` : null,
        data.heuristics_stale > 0 ? `${data.heuristics_stale} stale` : null,
        data.heuristics_shadow > 0 ? `${data.heuristics_shadow} shadow` : null,
        data.heuristics_promoted > 0 ? `${data.heuristics_promoted} promoted` : null,
      ].filter(Boolean).join(", ");
      toast.success(`Tuning recomputed: ${parts}`);
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
      setHeuristics(prev => prev.map(h => h.id === id ? { ...h, is_active: active, manually_overridden: true, governance_status: active ? "active" : "conflict_suppressed" } : h));
      toast.success(`Heuristic ${active ? "activated" : "deactivated"}`);
    } catch (err: any) {
      toast.error(err.message || "Toggle failed");
    }
  };

  const activeHeuristics = heuristics.filter(h => h.is_active && !h.shadow_mode);
  const shadowHeuristics = heuristics.filter(h => h.shadow_mode);
  const inactiveHeuristics = heuristics.filter(h => !h.is_active && !h.shadow_mode);
  const displayed = showInactive ? heuristics : [...activeHeuristics, ...shadowHeuristics];

  const totalActive = activeHeuristics.length;
  const totalShadow = shadowHeuristics.length;
  const totalAdjustments = activeHeuristics.filter(h => h.action_type.startsWith("adjust")).length;
  const totalSuppressions = activeHeuristics.filter(h => h.action_type === "suppress_field").length;
  const avgSampleSize = heuristics.length > 0
    ? Math.round(heuristics.reduce((s, h) => s + h.sample_size, 0) / heuristics.length)
    : 0;

  // Governance summary
  const expiredCount = heuristics.filter(h => h.governance_status === "expired").length;
  const staleCount = heuristics.filter(h => h.governance_status === "stale").length;
  const cappedCount = heuristics.filter(h => h.governance_status === "capped").length;
  const insufficientCount = heuristics.filter(h => h.governance_status === "insufficient_evidence").length;

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
                {totalActive} active / {totalShadow} shadow / {heuristics.length} total
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
            Governed heuristics derived from validation outcomes. Rules enforce minimum evidence, adjustment caps, expiration dates, and conflict resolution.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Summary Stats */}
          <div className="grid grid-cols-5 gap-3">
            <div className="rounded-lg border p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-primary">{totalActive}</div>
              <div className="text-xs text-muted-foreground">Active Rules</div>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-purple-500">{totalShadow}</div>
              <div className="text-xs text-muted-foreground">Shadow Mode</div>
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

          {/* Governance Health */}
          {(expiredCount > 0 || staleCount > 0 || cappedCount > 0 || insufficientCount > 0) && (
            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
              <div className="flex items-center gap-2 mb-2">
                <Shield className="h-4 w-4 text-yellow-600" />
                <span className="text-sm font-medium">Governance Alerts</span>
              </div>
              <div className="flex gap-3 text-xs flex-wrap">
                {expiredCount > 0 && (
                  <span className="text-red-500"><strong>{expiredCount}</strong> expired</span>
                )}
                {staleCount > 0 && (
                  <span className="text-yellow-600"><strong>{staleCount}</strong> stale (no recent validation support)</span>
                )}
                {insufficientCount > 0 && (
                  <span className="text-orange-500"><strong>{insufficientCount}</strong> insufficient evidence</span>
                )}
                {cappedCount > 0 && (
                  <span className="text-blue-500"><strong>{cappedCount}</strong> governance-capped</span>
                )}
              </div>
            </div>
          )}

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
                  h.shadow_mode ? "border-purple-500/30 bg-purple-500/5" :
                  h.is_active ? "border-primary/30 bg-primary/5" : "opacity-60"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Icon className={`h-4 w-4 shrink-0 ${h.shadow_mode ? "text-purple-500" : h.is_active ? "text-primary" : "text-muted-foreground"}`} />
                    <span className="text-sm font-medium truncate">{h.heuristic_key}</span>
                    <Badge variant="outline" className="text-[9px] shrink-0">
                      {ACTION_LABELS[h.action_type] || h.action_type}
                    </Badge>
                    {h.shadow_mode ? (
                      <Badge variant="outline" className="text-[9px] shrink-0 text-purple-500 border-purple-500/50 gap-0.5">
                        <Eye className="h-2.5 w-2.5" />
                        Shadow {h.shadow_mode_hits}/{h.shadow_mode_min_hits}
                      </Badge>
                    ) : (
                      <GovernanceStatusBadge status={h.governance_status} />
                    )}
                    {h.manually_overridden && (
                      <Badge variant="secondary" className="text-[9px] shrink-0">Manual</Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={`text-[9px] shrink-0 ${h.sample_size >= (h.min_sample_size ?? 3) ? "border-green-500/50" : "border-red-500/50"}`}
                    >
                      n={h.sample_size}{h.min_sample_size ? `/${h.min_sample_size}` : ""}
                    </Badge>
                    {h.priority != null && h.priority !== 100 && (
                      <Badge variant="outline" className="text-[9px] shrink-0">P{h.priority}</Badge>
                    )}
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

                    {/* Governance details */}
                    <div className="rounded bg-muted/30 p-2 space-y-1">
                      <div className="flex items-center gap-1 text-xs font-medium">
                        <Shield className="h-3 w-3" />
                        Governance
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <span className="text-muted-foreground">Adjustment Caps:</span>{" "}
                          <span className="font-medium tabular-nums">{h.min_adjustment_factor ?? 0.65}–{h.max_adjustment_factor ?? 1.35}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Conf. Floor:</span>{" "}
                          <span className="font-medium tabular-nums">×{h.max_confidence_penalty ?? 0.40}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Min Evidence:</span>{" "}
                          <span className="font-medium tabular-nums">{h.min_sample_size ?? 3}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Effective:</span>{" "}
                          <span className="font-medium">{h.effective_from ? new Date(h.effective_from).toLocaleDateString() : "—"}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Expires:</span>{" "}
                          <span className={`font-medium ${h.expires_at && new Date(h.expires_at) < new Date() ? "text-red-500" : ""}`}>
                            {h.expires_at ? new Date(h.expires_at).toLocaleDateString() : "Never"}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Stale After:</span>{" "}
                          <span className="font-medium tabular-nums">{h.staleness_days ?? 90}d</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Last Support:</span>{" "}
                          <span className={`font-medium ${
                            h.last_validation_support_at && 
                            (Date.now() - new Date(h.last_validation_support_at).getTime()) / 86400000 > (h.staleness_days ?? 90)
                              ? "text-yellow-600" : ""
                          }`}>
                            {h.last_validation_support_at ? new Date(h.last_validation_support_at).toLocaleDateString() : "—"}
                          </span>
                        </div>
                        {h.conflict_group && (
                          <div className="col-span-2">
                            <span className="text-muted-foreground">Conflict Group:</span>{" "}
                            <span className="font-mono text-[10px]">{h.conflict_group}</span>
                          </div>
                        )}
                      </div>
                      {h.governance_notes && (
                        <div className="text-[10px] text-muted-foreground mt-1 italic">{h.governance_notes}</div>
                      )}
                    </div>

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
                          Multiplies <strong>{h.adjustment_field}</strong> by <strong>{h.adjustment_factor}</strong>
                          {h.adjustment_factor < (h.min_adjustment_factor ?? 0.65) || h.adjustment_factor > (h.max_adjustment_factor ?? 1.35)
                            ? " (would be governance-capped at application)" : ""}.
                          {h.avg_pct_delta != null && ` Corrects ~${Math.abs(Math.round(h.avg_pct_delta))}% systematic ${h.avg_pct_delta > 0 ? "over" : "under"}estimation.`}
                        </span>
                      </div>
                    )}

                    {h.action_type === "adjust_confidence" && (
                      <div className="flex items-center gap-2 text-xs rounded bg-yellow-500/10 p-2">
                        <AlertTriangle className="h-3.5 w-3.5 text-yellow-600" />
                        <span>
                          <strong>{h.adjustment_field}</strong> multiplied by <strong>{h.adjustment_factor}</strong>
                          {h.adjustment_factor != null && h.adjustment_factor < (h.max_confidence_penalty ?? 0.40)
                            ? ` (capped at ×${h.max_confidence_penalty ?? 0.40})` : ""}.
                        </span>
                      </div>
                    )}

                    {h.action_type === "suppress_field" && (
                      <div className="flex items-center gap-2 text-xs rounded bg-red-500/10 p-2">
                        <Ban className="h-3.5 w-3.5 text-red-500" />
                        <span>
                          <strong>{h.suppress_field}</strong> suppressed when confidence &lt; <strong>{h.suppress_below_confidence}%</strong>.
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
