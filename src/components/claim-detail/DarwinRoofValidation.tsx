import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { logAudit } from "@/hooks/useAuditLog";
import {
  Target, Plus, Save, X, ChevronDown, ChevronUp, TrendingUp,
  TrendingDown, Minus, FileCheck, AlertTriangle, BarChart3, Loader2
} from "lucide-react";

type RoofForm = "gable" | "hip" | "cross_gable" | "complex" | "unknown";

interface RoofEstimate {
  id: string;
  claim_id: string;
  footprint_area_sqft: number | null;
  estimated_roof_area_sqft: number | null;
  squares: number | null;
  dominant_pitch: string | null;
  ridge_lf: number | null;
  hip_lf: number | null;
  valley_lf: number | null;
  eave_lf: number | null;
  rake_lf: number | null;
  facet_count: number | null;
  confidence_score: number | null;
  geometry_quality_score: number | null;
  inferred_roof_form: RoofForm | null;
  imagery_source: string | null;
  selected_candidate_index: number | null;
  candidate_footprints: any[] | null;
}

interface Validation {
  id: string;
  claim_id: string;
  estimate_id: string;
  source_type: string;
  source_name: string | null;
  source_date: string | null;
  source_document_url: string | null;
  actual_footprint_area_sqft: number | null;
  actual_roof_area_sqft: number | null;
  actual_squares: number | null;
  actual_dominant_pitch: string | null;
  actual_ridge_lf: number | null;
  actual_hip_lf: number | null;
  actual_valley_lf: number | null;
  actual_eave_lf: number | null;
  actual_rake_lf: number | null;
  actual_facet_count: number | null;
  actual_roof_form: string | null;
  darwin_footprint_area_sqft: number | null;
  darwin_roof_area_sqft: number | null;
  darwin_squares: number | null;
  darwin_dominant_pitch: string | null;
  darwin_ridge_lf: number | null;
  darwin_hip_lf: number | null;
  darwin_valley_lf: number | null;
  darwin_eave_lf: number | null;
  darwin_rake_lf: number | null;
  darwin_facet_count: number | null;
  darwin_roof_form: string | null;
  darwin_confidence_score: number | null;
  darwin_geometry_quality_score: number | null;
  delta_footprint_area: number | null;
  delta_roof_area: number | null;
  delta_squares: number | null;
  delta_ridge_lf: number | null;
  delta_hip_lf: number | null;
  delta_valley_lf: number | null;
  delta_eave_lf: number | null;
  delta_rake_lf: number | null;
  pct_delta_footprint_area: number | null;
  pct_delta_roof_area: number | null;
  pct_delta_squares: number | null;
  pct_delta_ridge_lf: number | null;
  pct_delta_hip_lf: number | null;
  pct_delta_valley_lf: number | null;
  pct_delta_eave_lf: number | null;
  pct_delta_rake_lf: number | null;
  pitch_match: boolean | null;
  roof_form_match: boolean | null;
  facet_count_match: boolean | null;
  overall_accuracy_score: number | null;
  accuracy_grade: string | null;
  failure_patterns: string[];
  staff_notes: string | null;
  geometry_source: string | null;
  geometry_source_score: number | null;
  candidate_count: number | null;
  created_at: string;
}

interface Props {
  claimId: string;
  estimate: RoofEstimate;
}

interface ActualValues {
  source_type: string;
  source_name: string;
  source_date: string;
  actual_footprint_area_sqft: string;
  actual_roof_area_sqft: string;
  actual_squares: string;
  actual_dominant_pitch: string;
  actual_ridge_lf: string;
  actual_hip_lf: string;
  actual_valley_lf: string;
  actual_eave_lf: string;
  actual_rake_lf: string;
  actual_facet_count: string;
  actual_roof_form: string;
  staff_notes: string;
}

const EMPTY_FORM: ActualValues = {
  source_type: "field_measurement",
  source_name: "",
  source_date: "",
  actual_footprint_area_sqft: "",
  actual_roof_area_sqft: "",
  actual_squares: "",
  actual_dominant_pitch: "",
  actual_ridge_lf: "",
  actual_hip_lf: "",
  actual_valley_lf: "",
  actual_eave_lf: "",
  actual_rake_lf: "",
  actual_facet_count: "",
  actual_roof_form: "",
  staff_notes: "",
};

const SOURCE_TYPES = [
  { value: "field_measurement", label: "Field Measurement" },
  { value: "vendor_report", label: "Vendor Report" },
  { value: "eagleview", label: "EagleView" },
  { value: "hover", label: "HOVER" },
  { value: "other", label: "Other" },
];

const ROOF_FORMS = [
  { value: "gable", label: "Gable" },
  { value: "hip", label: "Hip" },
  { value: "cross_gable", label: "Cross-Gable" },
  { value: "complex", label: "Complex" },
  { value: "unknown", label: "Unknown" },
];

function computeDeltas(actual: number | null, darwin: number | null) {
  if (actual == null || darwin == null) return { abs: null, pct: null };
  const abs = Math.round(darwin - actual);
  const pct = actual !== 0 ? Math.round(((darwin - actual) / actual) * 100) : null;
  return { abs, pct };
}

function computeOverallAccuracy(v: Partial<Validation>): { score: number; grade: string; failures: string[] } {
  const failures: string[] = [];
  const weights: { field: string; pct: number | null; weight: number }[] = [
    { field: "footprint_area", pct: v.pct_delta_footprint_area ?? null, weight: 20 },
    { field: "roof_area", pct: v.pct_delta_roof_area ?? null, weight: 20 },
    { field: "squares", pct: v.pct_delta_squares ?? null, weight: 15 },
    { field: "eave_lf", pct: v.pct_delta_eave_lf ?? null, weight: 10 },
    { field: "rake_lf", pct: v.pct_delta_rake_lf ?? null, weight: 10 },
    { field: "ridge_lf", pct: v.pct_delta_ridge_lf ?? null, weight: 10 },
    { field: "hip_lf", pct: v.pct_delta_hip_lf ?? null, weight: 5 },
    { field: "valley_lf", pct: v.pct_delta_valley_lf ?? null, weight: 5 },
  ];

  let totalWeight = 0;
  let totalScore = 0;

  for (const w of weights) {
    if (w.pct == null) continue;
    totalWeight += w.weight;
    const absPct = Math.abs(w.pct);
    // Score: 100 if exact, 0 if >=50% off
    const fieldScore = Math.max(0, 100 - absPct * 2);
    totalScore += fieldScore * w.weight;

    if (absPct > 20) {
      failures.push(`${w.field}: ${w.pct > 0 ? "+" : ""}${w.pct}% deviation`);
    }
  }

  // Boolean matches
  if (v.pitch_match === false) {
    failures.push("pitch_mismatch");
    totalWeight += 5;
    // 0 score for mismatch
  } else if (v.pitch_match === true) {
    totalWeight += 5;
    totalScore += 100 * 5;
  }

  if (v.roof_form_match === false) {
    failures.push("roof_form_mismatch");
    totalWeight += 5;
  } else if (v.roof_form_match === true) {
    totalWeight += 5;
    totalScore += 100 * 5;
  }

  const score = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;
  let grade = "F";
  if (score >= 90) grade = "A";
  else if (score >= 75) grade = "B";
  else if (score >= 60) grade = "C";
  else if (score >= 40) grade = "D";

  return { score, grade, failures };
}

const gradeColor = (grade: string | null) => {
  switch (grade) {
    case "A": return "text-green-600 border-green-500/50";
    case "B": return "text-blue-600 border-blue-500/50";
    case "C": return "text-yellow-600 border-yellow-500/50";
    case "D": return "text-orange-600 border-orange-500/50";
    case "F": return "text-red-600 border-red-500/50";
    default: return "text-muted-foreground";
  }
};

const DeltaIndicator = ({ abs, pct, unit = "" }: { abs: number | null; pct: number | null; unit?: string }) => {
  if (abs == null) return <span className="text-muted-foreground text-xs">—</span>;
  const absPct = pct != null ? Math.abs(pct) : 0;
  const color = absPct <= 5 ? "text-green-600" : absPct <= 15 ? "text-yellow-600" : "text-red-500";
  const Icon = abs > 0 ? TrendingUp : abs < 0 ? TrendingDown : Minus;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${color}`}>
      <Icon className="h-3 w-3" />
      {abs > 0 ? "+" : ""}{abs}{unit}
      {pct != null && <span className="text-[10px] ml-0.5">({pct > 0 ? "+" : ""}{pct}%)</span>}
    </span>
  );
};

export const DarwinRoofValidation = ({ claimId, estimate }: Props) => {
  const [validations, setValidations] = useState<Validation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ActualValues>(EMPTY_FORM);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchValidations = useCallback(async () => {
    const { data } = await supabase
      .from("claim_roof_validations")
      .select("*")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false });
    setValidations((data || []) as unknown as Validation[]);
    setLoading(false);
  }, [claimId]);

  useEffect(() => { fetchValidations(); }, [fetchValidations]);

  const parseNum = (s: string): number | null => {
    if (!s.trim()) return null;
    const n = Number(s);
    return isNaN(n) ? null : n;
  };

  const handleSave = async () => {
    if (!form.source_type) {
      toast.error("Select a source type");
      return;
    }
    // Must have at least one actual value
    const hasValue = [
      form.actual_footprint_area_sqft, form.actual_roof_area_sqft, form.actual_squares,
      form.actual_ridge_lf, form.actual_hip_lf, form.actual_valley_lf,
      form.actual_eave_lf, form.actual_rake_lf, form.actual_facet_count,
    ].some(v => v.trim() !== "");
    if (!hasValue && !form.actual_dominant_pitch && !form.actual_roof_form) {
      toast.error("Enter at least one actual measurement");
      return;
    }

    setSaving(true);
    try {
      const actual = {
        actual_footprint_area_sqft: parseNum(form.actual_footprint_area_sqft),
        actual_roof_area_sqft: parseNum(form.actual_roof_area_sqft),
        actual_squares: parseNum(form.actual_squares),
        actual_dominant_pitch: form.actual_dominant_pitch || null,
        actual_ridge_lf: parseNum(form.actual_ridge_lf),
        actual_hip_lf: parseNum(form.actual_hip_lf),
        actual_valley_lf: parseNum(form.actual_valley_lf),
        actual_eave_lf: parseNum(form.actual_eave_lf),
        actual_rake_lf: parseNum(form.actual_rake_lf),
        actual_facet_count: parseNum(form.actual_facet_count) != null ? Math.round(parseNum(form.actual_facet_count)!) : null,
        actual_roof_form: form.actual_roof_form || null,
      };

      // Snapshot Darwin values
      const darwin = {
        darwin_footprint_area_sqft: estimate.footprint_area_sqft,
        darwin_roof_area_sqft: estimate.estimated_roof_area_sqft,
        darwin_squares: estimate.squares,
        darwin_dominant_pitch: estimate.dominant_pitch,
        darwin_ridge_lf: estimate.ridge_lf,
        darwin_hip_lf: estimate.hip_lf,
        darwin_valley_lf: estimate.valley_lf,
        darwin_eave_lf: estimate.eave_lf,
        darwin_rake_lf: estimate.rake_lf,
        darwin_facet_count: estimate.facet_count,
        darwin_roof_form: estimate.inferred_roof_form,
        darwin_confidence_score: estimate.confidence_score,
        darwin_geometry_quality_score: estimate.geometry_quality_score,
      };

      // Compute deltas
      const d_foot = computeDeltas(actual.actual_footprint_area_sqft, darwin.darwin_footprint_area_sqft);
      const d_roof = computeDeltas(actual.actual_roof_area_sqft, darwin.darwin_roof_area_sqft);
      const d_sq = computeDeltas(actual.actual_squares, darwin.darwin_squares);
      const d_ridge = computeDeltas(actual.actual_ridge_lf, darwin.darwin_ridge_lf);
      const d_hip = computeDeltas(actual.actual_hip_lf, darwin.darwin_hip_lf);
      const d_valley = computeDeltas(actual.actual_valley_lf, darwin.darwin_valley_lf);
      const d_eave = computeDeltas(actual.actual_eave_lf, darwin.darwin_eave_lf);
      const d_rake = computeDeltas(actual.actual_rake_lf, darwin.darwin_rake_lf);

      const pitchMatch = actual.actual_dominant_pitch && darwin.darwin_dominant_pitch
        ? actual.actual_dominant_pitch === darwin.darwin_dominant_pitch
        : null;
      const formMatch = actual.actual_roof_form && darwin.darwin_roof_form
        ? actual.actual_roof_form === darwin.darwin_roof_form
        : null;
      const facetMatch = actual.actual_facet_count != null && darwin.darwin_facet_count != null
        ? actual.actual_facet_count === darwin.darwin_facet_count
        : null;

      const partialValidation = {
        pct_delta_footprint_area: d_foot.pct,
        pct_delta_roof_area: d_roof.pct,
        pct_delta_squares: d_sq.pct,
        pct_delta_ridge_lf: d_ridge.pct,
        pct_delta_hip_lf: d_hip.pct,
        pct_delta_valley_lf: d_valley.pct,
        pct_delta_eave_lf: d_eave.pct,
        pct_delta_rake_lf: d_rake.pct,
        pitch_match: pitchMatch,
        roof_form_match: formMatch,
      };

      const { score, grade, failures } = computeOverallAccuracy(partialValidation);

      const row = {
        claim_id: claimId,
        estimate_id: estimate.id,
        source_type: form.source_type,
        source_name: form.source_name || null,
        source_date: form.source_date || null,
        geometry_source: estimate.imagery_source || null,
        geometry_source_score: estimate.geometry_quality_score || null,
        candidate_count: estimate.candidate_footprints?.length ?? null,
        ...actual,
        ...darwin,
        delta_footprint_area: d_foot.abs,
        delta_roof_area: d_roof.abs,
        delta_squares: d_sq.abs,
        delta_ridge_lf: d_ridge.abs,
        delta_hip_lf: d_hip.abs,
        delta_valley_lf: d_valley.abs,
        delta_eave_lf: d_eave.abs,
        delta_rake_lf: d_rake.abs,
        pct_delta_footprint_area: d_foot.pct,
        pct_delta_roof_area: d_roof.pct,
        pct_delta_squares: d_sq.pct,
        pct_delta_ridge_lf: d_ridge.pct,
        pct_delta_hip_lf: d_hip.pct,
        pct_delta_valley_lf: d_valley.pct,
        pct_delta_eave_lf: d_eave.pct,
        pct_delta_rake_lf: d_rake.pct,
        pitch_match: pitchMatch,
        roof_form_match: formMatch,
        facet_count_match: facetMatch,
        overall_accuracy_score: score,
        accuracy_grade: grade,
        failure_patterns: failures,
        staff_notes: form.staff_notes || null,
      };

      const { error } = await supabase
        .from("claim_roof_validations")
        .insert(row as any);

      if (error) throw error;

      logAudit({
        action: "create",
        recordType: "roof_validation",
        recordId: claimId,
        newValues: { source_type: form.source_type, accuracy_grade: grade, overall_accuracy_score: score },
        metadata: { failure_count: failures.length },
      });

      toast.success(`Validation saved — Grade: ${grade} (${score}%)`);
      setForm(EMPTY_FORM);
      setShowForm(false);
      fetchValidations();
    } catch (err: any) {
      toast.error(err.message || "Failed to save validation");
    } finally {
      setSaving(false);
    }
  };

  const updateField = (key: keyof ActualValues, value: string) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const MeasurementInput = ({ label, field, unit = "" }: { label: string; field: keyof ActualValues; unit?: string }) => (
    <div className="space-y-1">
      <Label className="text-xs">{label} {unit && <span className="text-muted-foreground">({unit})</span>}</Label>
      <Input
        type="number"
        className="h-8 text-sm"
        placeholder={`Darwin: ${(estimate as any)[field.replace("actual_", "")] ?? "—"}`}
        value={form[field]}
        onChange={(e) => updateField(field, e.target.value)}
      />
    </div>
  );

  // Aggregate stats across all validations
  const aggregateStats = validations.length > 0 ? {
    avgScore: Math.round(validations.reduce((s, v) => s + (v.overall_accuracy_score ?? 0), 0) / validations.length),
    gradeDistribution: validations.reduce((acc, v) => {
      const g = v.accuracy_grade || "?";
      acc[g] = (acc[g] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    commonFailures: validations
      .flatMap(v => (v.failure_patterns as string[]) || [])
      .reduce((acc, f) => { acc[f] = (acc[f] || 0) + 1; return acc; }, {} as Record<string, number>),
  } : null;

  // Source-level accuracy breakdown
  const sourceAccuracy = validations.length > 0 ? (() => {
    const bySource: Record<string, {
      count: number;
      totalScore: number;
      avgQuality: number;
      totalQuality: number;
      pctDeltaSquares: number[];
      pctDeltaRoofArea: number[];
      pctDeltaEave: number[];
      pctDeltaRake: number[];
      grades: Record<string, number>;
    }> = {};

    for (const v of validations) {
      const src = v.geometry_source || "Unknown";
      if (!bySource[src]) {
        bySource[src] = { count: 0, totalScore: 0, avgQuality: 0, totalQuality: 0, pctDeltaSquares: [], pctDeltaRoofArea: [], pctDeltaEave: [], pctDeltaRake: [], grades: {} };
      }
      const b = bySource[src];
      b.count++;
      b.totalScore += v.overall_accuracy_score ?? 0;
      b.totalQuality += v.geometry_source_score ?? 0;
      if (v.pct_delta_squares != null) b.pctDeltaSquares.push(Math.abs(v.pct_delta_squares));
      if (v.pct_delta_roof_area != null) b.pctDeltaRoofArea.push(Math.abs(v.pct_delta_roof_area));
      if (v.pct_delta_eave_lf != null) b.pctDeltaEave.push(Math.abs(v.pct_delta_eave_lf));
      if (v.pct_delta_rake_lf != null) b.pctDeltaRake.push(Math.abs(v.pct_delta_rake_lf));
      const g = v.accuracy_grade || "?";
      b.grades[g] = (b.grades[g] || 0) + 1;
    }

    return Object.entries(bySource).map(([source, data]) => ({
      source,
      count: data.count,
      avgScore: Math.round(data.totalScore / data.count),
      avgQuality: data.totalQuality > 0 ? Math.round(data.totalQuality / data.count) : null,
      avgPctDeltaSquares: data.pctDeltaSquares.length > 0 ? Math.round(data.pctDeltaSquares.reduce((a, b) => a + b, 0) / data.pctDeltaSquares.length * 10) / 10 : null,
      avgPctDeltaRoofArea: data.pctDeltaRoofArea.length > 0 ? Math.round(data.pctDeltaRoofArea.reduce((a, b) => a + b, 0) / data.pctDeltaRoofArea.length * 10) / 10 : null,
      avgPctDeltaEave: data.pctDeltaEave.length > 0 ? Math.round(data.pctDeltaEave.reduce((a, b) => a + b, 0) / data.pctDeltaEave.length * 10) / 10 : null,
      avgPctDeltaRake: data.pctDeltaRake.length > 0 ? Math.round(data.pctDeltaRake.reduce((a, b) => a + b, 0) / data.pctDeltaRake.length * 10) / 10 : null,
      grades: data.grades,
    })).sort((a, b) => b.avgScore - a.avgScore);
  })() : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Target className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Benchmarking & Validation</CardTitle>
            <Badge variant="outline" className="text-[10px]">
              {validations.length} validation{validations.length !== 1 ? "s" : ""}
            </Badge>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowForm(!showForm)}>
            {showForm ? <X className="h-4 w-4 mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
            {showForm ? "Cancel" : "Add Validation"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Aggregate Stats */}
        {aggregateStats && (
          <div className="rounded-lg border p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <BarChart3 className="h-4 w-4 text-primary" />
              Aggregate Performance
            </div>
            <div className="flex items-center gap-4">
              <div className="text-center">
                <div className={`text-2xl font-bold tabular-nums ${aggregateStats.avgScore >= 75 ? "text-green-600" : aggregateStats.avgScore >= 50 ? "text-yellow-600" : "text-red-500"}`}>
                  {aggregateStats.avgScore}%
                </div>
                <div className="text-[10px] text-muted-foreground">Avg Accuracy</div>
              </div>
              <Separator orientation="vertical" className="h-10" />
              <div className="flex gap-2">
                {Object.entries(aggregateStats.gradeDistribution).sort().map(([grade, count]) => (
                  <Badge key={grade} variant="outline" className={`text-xs ${gradeColor(grade)}`}>
                    {grade}: {count}
                  </Badge>
                ))}
              </div>
              {Object.keys(aggregateStats.commonFailures).length > 0 && (
                <>
                  <Separator orientation="vertical" className="h-10" />
                  <div className="text-xs">
                    <span className="text-muted-foreground">Top failures: </span>
                    {Object.entries(aggregateStats.commonFailures)
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 3)
                      .map(([f, c]) => (
                        <Badge key={f} variant="outline" className="text-[9px] ml-1 text-red-500 border-red-500/30">
                          {f} ×{c}
                        </Badge>
                      ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Input Form */}
        {showForm && (
          <div className="rounded-lg border p-4 space-y-4 bg-muted/20">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FileCheck className="h-4 w-4" />
              Attach Field Measurements / Vendor Report
            </div>

            {/* Source Info */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Source Type</Label>
                <Select value={form.source_type} onValueChange={(v) => updateField("source_type", v)}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_TYPES.map(s => (
                      <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Source Name</Label>
                <Input
                  className="h-8 text-sm"
                  placeholder="e.g. EagleView Premium Report"
                  value={form.source_name}
                  onChange={(e) => updateField("source_name", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Measurement Date</Label>
                <Input
                  type="date"
                  className="h-8 text-sm"
                  value={form.source_date}
                  onChange={(e) => updateField("source_date", e.target.value)}
                />
              </div>
            </div>

            {/* Measurement Fields */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MeasurementInput label="Footprint Area" field="actual_footprint_area_sqft" unit="sqft" />
              <MeasurementInput label="Roof Area" field="actual_roof_area_sqft" unit="sqft" />
              <MeasurementInput label="Squares" field="actual_squares" />
              <div className="space-y-1">
                <Label className="text-xs">Dominant Pitch</Label>
                <Input
                  className="h-8 text-sm"
                  placeholder={`Darwin: ${estimate.dominant_pitch ?? "—"}`}
                  value={form.actual_dominant_pitch}
                  onChange={(e) => updateField("actual_dominant_pitch", e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <MeasurementInput label="Ridge" field="actual_ridge_lf" unit="LF" />
              <MeasurementInput label="Hip" field="actual_hip_lf" unit="LF" />
              <MeasurementInput label="Valley" field="actual_valley_lf" unit="LF" />
              <MeasurementInput label="Eave" field="actual_eave_lf" unit="LF" />
              <MeasurementInput label="Rake" field="actual_rake_lf" unit="LF" />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Facet Count</Label>
                <Input
                  type="number"
                  className="h-8 text-sm"
                  placeholder={`Darwin: ${estimate.facet_count ?? "—"}`}
                  value={form.actual_facet_count}
                  onChange={(e) => updateField("actual_facet_count", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Roof Form</Label>
                <Select value={form.actual_roof_form} onValueChange={(v) => updateField("actual_roof_form", v)}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue placeholder={`Darwin: ${estimate.inferred_roof_form ?? "—"}`} />
                  </SelectTrigger>
                  <SelectContent>
                    {ROOF_FORMS.map(f => (
                      <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Staff Notes</Label>
              <Textarea
                className="text-sm min-h-[60px]"
                placeholder="Observations about Darwin's accuracy, notable discrepancies, or conditions affecting the comparison..."
                value={form.staff_notes}
                onChange={(e) => updateField("staff_notes", e.target.value)}
              />
            </div>

            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                Score & Save Validation
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}>
                <X className="h-4 w-4 mr-1" /> Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Existing Validations */}
        {loading ? (
          <div className="text-center text-sm text-muted-foreground py-4">Loading validations...</div>
        ) : validations.length === 0 && !showForm ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            <Target className="h-8 w-8 mx-auto mb-2 opacity-40" />
            No validations yet. Attach field measurements or vendor reports to benchmark Darwin's accuracy.
          </div>
        ) : (
          <div className="space-y-2">
            {validations.map((v) => {
              const isExpanded = expandedId === v.id;
              return (
                <div key={v.id} className="rounded-lg border">
                  {/* Summary Row */}
                  <button
                    className="w-full flex items-center justify-between p-3 text-left hover:bg-muted/30 transition-colors"
                    onClick={() => setExpandedId(isExpanded ? null : v.id)}
                  >
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className={`text-sm font-bold ${gradeColor(v.accuracy_grade)}`}>
                        {v.accuracy_grade}
                      </Badge>
                      <div>
                        <div className="text-sm font-medium">
                          {v.source_name || SOURCE_TYPES.find(s => s.value === v.source_type)?.label || v.source_type}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {v.source_date && `${v.source_date} · `}
                          Score: {v.overall_accuracy_score}% · 
                          {(v.failure_patterns as string[])?.length || 0} failure pattern{((v.failure_patterns as string[])?.length || 0) !== 1 ? "s" : ""}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {v.pitch_match === false && (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <AlertTriangle className="h-4 w-4 text-red-500" />
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">Pitch mismatch</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      {v.roof_form_match === false && (
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <AlertTriangle className="h-4 w-4 text-orange-500" />
                            </TooltipTrigger>
                            <TooltipContent className="text-xs">Roof form mismatch</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </div>
                  </button>

                  {/* Expanded Detail */}
                  {isExpanded && (
                    <div className="border-t p-3 space-y-3">
                      {/* Comparison Table */}
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b">
                              <th className="text-left py-1.5 pr-4 font-medium text-muted-foreground">Metric</th>
                              <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Darwin</th>
                              <th className="text-right py-1.5 px-2 font-medium text-muted-foreground">Actual</th>
                              <th className="text-right py-1.5 pl-2 font-medium text-muted-foreground">Delta</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[
                              { label: "Footprint Area", unit: "sqft", darwin: v.darwin_footprint_area_sqft, actual: v.actual_footprint_area_sqft, abs: v.delta_footprint_area, pct: v.pct_delta_footprint_area },
                              { label: "Roof Area", unit: "sqft", darwin: v.darwin_roof_area_sqft, actual: v.actual_roof_area_sqft, abs: v.delta_roof_area, pct: v.pct_delta_roof_area },
                              { label: "Squares", unit: "", darwin: v.darwin_squares, actual: v.actual_squares, abs: v.delta_squares, pct: v.pct_delta_squares },
                              { label: "Ridge", unit: "LF", darwin: v.darwin_ridge_lf, actual: v.actual_ridge_lf, abs: v.delta_ridge_lf, pct: v.pct_delta_ridge_lf },
                              { label: "Hip", unit: "LF", darwin: v.darwin_hip_lf, actual: v.actual_hip_lf, abs: v.delta_hip_lf, pct: v.pct_delta_hip_lf },
                              { label: "Valley", unit: "LF", darwin: v.darwin_valley_lf, actual: v.actual_valley_lf, abs: v.delta_valley_lf, pct: v.pct_delta_valley_lf },
                              { label: "Eave", unit: "LF", darwin: v.darwin_eave_lf, actual: v.actual_eave_lf, abs: v.delta_eave_lf, pct: v.pct_delta_eave_lf },
                              { label: "Rake", unit: "LF", darwin: v.darwin_rake_lf, actual: v.actual_rake_lf, abs: v.delta_rake_lf, pct: v.pct_delta_rake_lf },
                            ].map((row) => (
                              <tr key={row.label} className="border-b border-border/50">
                                <td className="py-1.5 pr-4 font-medium">{row.label}</td>
                                <td className="py-1.5 px-2 text-right tabular-nums">{row.darwin != null ? `${Math.round(row.darwin)} ${row.unit}` : "—"}</td>
                                <td className="py-1.5 px-2 text-right tabular-nums">{row.actual != null ? `${Math.round(row.actual)} ${row.unit}` : "—"}</td>
                                <td className="py-1.5 pl-2 text-right"><DeltaIndicator abs={row.abs} pct={row.pct} /></td>
                              </tr>
                            ))}
                            {/* Boolean comparisons */}
                            <tr className="border-b border-border/50">
                              <td className="py-1.5 pr-4 font-medium">Pitch</td>
                              <td className="py-1.5 px-2 text-right">{v.darwin_dominant_pitch ?? "—"}</td>
                              <td className="py-1.5 px-2 text-right">{v.actual_dominant_pitch ?? "—"}</td>
                              <td className="py-1.5 pl-2 text-right">
                                {v.pitch_match == null ? <span className="text-muted-foreground">—</span> :
                                  v.pitch_match ? <Badge variant="outline" className="text-[9px] text-green-600 border-green-500/30">Match</Badge> :
                                    <Badge variant="outline" className="text-[9px] text-red-500 border-red-500/30">Mismatch</Badge>}
                              </td>
                            </tr>
                            <tr className="border-b border-border/50">
                              <td className="py-1.5 pr-4 font-medium">Roof Form</td>
                              <td className="py-1.5 px-2 text-right capitalize">{v.darwin_roof_form ?? "—"}</td>
                              <td className="py-1.5 px-2 text-right capitalize">{v.actual_roof_form ?? "—"}</td>
                              <td className="py-1.5 pl-2 text-right">
                                {v.roof_form_match == null ? <span className="text-muted-foreground">—</span> :
                                  v.roof_form_match ? <Badge variant="outline" className="text-[9px] text-green-600 border-green-500/30">Match</Badge> :
                                    <Badge variant="outline" className="text-[9px] text-red-500 border-red-500/30">Mismatch</Badge>}
                              </td>
                            </tr>
                            <tr>
                              <td className="py-1.5 pr-4 font-medium">Facet Count</td>
                              <td className="py-1.5 px-2 text-right">{v.darwin_facet_count ?? "—"}</td>
                              <td className="py-1.5 px-2 text-right">{v.actual_facet_count ?? "—"}</td>
                              <td className="py-1.5 pl-2 text-right">
                                {v.facet_count_match == null ? <span className="text-muted-foreground">—</span> :
                                  v.facet_count_match ? <Badge variant="outline" className="text-[9px] text-green-600 border-green-500/30">Match</Badge> :
                                    <Badge variant="outline" className="text-[9px] text-red-500 border-red-500/30">Mismatch</Badge>}
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>

                      {/* Failure Patterns */}
                      {(v.failure_patterns as string[])?.length > 0 && (
                        <div>
                          <div className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Failure Patterns</div>
                          <div className="flex flex-wrap gap-1">
                            {(v.failure_patterns as string[]).map((f, i) => (
                              <Badge key={i} variant="outline" className="text-[9px] text-red-500 border-red-500/30">
                                {f}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Darwin Context at Validation Time */}
                      <div className="text-[10px] text-muted-foreground">
                        Darwin confidence at validation: {v.darwin_confidence_score ?? "—"}% · 
                        Geometry quality: {v.darwin_geometry_quality_score ?? "—"}/100 · 
                        Validated: {new Date(v.created_at).toLocaleString()}
                      </div>

                      {/* Staff Notes */}
                      {v.staff_notes && (
                        <div className="text-xs text-muted-foreground p-2 rounded bg-muted/30 border">
                          <strong>Notes:</strong> {v.staff_notes}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

// Need to import Loader2 at usage but it's already in lucide imports above
