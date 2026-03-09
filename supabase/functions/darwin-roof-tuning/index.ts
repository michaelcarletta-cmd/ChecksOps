import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ValidationRow {
  id: string;
  darwin_roof_form: string | null;
  darwin_geometry_quality_score: number | null;
  darwin_confidence_score: number | null;
  overall_accuracy_score: number | null;
  accuracy_grade: string | null;
  failure_patterns: string[];
  pct_delta_footprint_area: number | null;
  pct_delta_roof_area: number | null;
  pct_delta_squares: number | null;
  pct_delta_ridge_lf: number | null;
  pct_delta_hip_lf: number | null;
  pct_delta_valley_lf: number | null;
  pct_delta_eave_lf: number | null;
  pct_delta_rake_lf: number | null;
  roof_form_match: boolean | null;
  pitch_match: boolean | null;
  estimate_id: string;
  source_type: string;
}

interface MeasurementRow {
  id: string;
  inferred_roof_form: string | null;
  geometry_quality_score: number | null;
  aspect_ratio: number | null;
  confidence_score: number | null;
  imagery_source: string | null;
}

interface SegmentBucket {
  key: string;
  roof_form: string | null;
  geometry_source: string | null;
  quality_band: string;
  aspect_ratio_band: string;
  confidence_band: string;
  validations: ValidationRow[];
  measurements: MeasurementRow[];
}

function qualityBand(score: number | null): string {
  if (score == null) return "unknown";
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function aspectRatioBand(ratio: number | null): string {
  if (ratio == null) return "unknown";
  if (ratio >= 2.0) return "elongated";
  if (ratio >= 1.3) return "rectangular";
  return "compact";
}

function confidenceBand(score: number | null): string {
  if (score == null) return "unknown";
  if (score >= 45) return "high";
  if (score >= 25) return "medium";
  return "low";
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function deriveHeuristics(bucket: SegmentBucket): {
  heuristic_key: string;
  heuristic_type: string;
  action_type: string;
  adjustment_field: string | null;
  adjustment_factor: number | null;
  adjustment_absolute: number | null;
  suppress_field: string | null;
  suppress_below_confidence: number | null;
  avg_accuracy_score: number;
  avg_pct_delta: number;
  median_pct_delta: number;
  failure_rate: number;
  common_failures: string[];
  evidence_summary: string;
  should_activate: boolean;
}[] {
  const heuristics: ReturnType<typeof deriveHeuristics> = [];
  const vals = bucket.validations;
  const n = vals.length;
  if (n < 2) return heuristics; // Need min 2 validations

  const avgAccuracy = vals.reduce((s, v) => s + (v.overall_accuracy_score ?? 0), 0) / n;
  const failCount = vals.filter(v => (v.overall_accuracy_score ?? 0) < 60).length;
  const failureRate = failCount / n;

  // Collect all failure patterns
  const failureFreq: Record<string, number> = {};
  for (const v of vals) {
    for (const f of (v.failure_patterns || [])) {
      failureFreq[f] = (failureFreq[f] || 0) + 1;
    }
  }
  const topFailures = Object.entries(failureFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([f]) => f);

  // Check per-field deviations
  const fieldChecks: { field: string; deltaKey: keyof ValidationRow }[] = [
    { field: "squares", deltaKey: "pct_delta_squares" },
    { field: "footprint_area", deltaKey: "pct_delta_footprint_area" },
    { field: "roof_area", deltaKey: "pct_delta_roof_area" },
    { field: "ridge_lf", deltaKey: "pct_delta_ridge_lf" },
    { field: "hip_lf", deltaKey: "pct_delta_hip_lf" },
    { field: "valley_lf", deltaKey: "pct_delta_valley_lf" },
    { field: "eave_lf", deltaKey: "pct_delta_eave_lf" },
    { field: "rake_lf", deltaKey: "pct_delta_rake_lf" },
  ];

  for (const fc of fieldChecks) {
    const deltas = vals
      .map(v => v[fc.deltaKey] as number | null)
      .filter((d): d is number => d != null);
    if (deltas.length < 2) continue;

    const avgDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
    const medDelta = median(deltas);
    const absAvgDelta = Math.abs(avgDelta);

    // If consistent overestimation/underestimation > 15%
    if (absAvgDelta > 15) {
      const direction = avgDelta > 0 ? "overestimating" : "underestimating";
      const correctionFactor = 1 / (1 + avgDelta / 100); // Inverse correction

      heuristics.push({
        heuristic_key: `${bucket.key}_${fc.field}_bias`,
        heuristic_type: "adjustment",
        action_type: "adjust_value",
        adjustment_field: fc.field,
        adjustment_factor: Math.round(correctionFactor * 1000) / 1000,
        adjustment_absolute: null,
        suppress_field: null,
        suppress_below_confidence: null,
        avg_accuracy_score: avgAccuracy,
        avg_pct_delta: Math.round(avgDelta * 10) / 10,
        median_pct_delta: Math.round(medDelta * 10) / 10,
        failure_rate: Math.round(failureRate * 100) / 100,
        common_failures: topFailures,
        evidence_summary: `Darwin is consistently ${direction} ${fc.field} by ~${Math.round(absAvgDelta)}% for ${bucket.key} (n=${deltas.length}, median=${Math.round(medDelta)}%). Correction factor: ${correctionFactor.toFixed(3)}.`,
        should_activate: n >= 3 && absAvgDelta > 20,
      });
    }

    // If field has very high variance (unreliable), suppress it
    if (deltas.length >= 3) {
      const variance = deltas.reduce((s, d) => s + (d - avgDelta) ** 2, 0) / deltas.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev > 30 && absAvgDelta > 10) {
        heuristics.push({
          heuristic_key: `${bucket.key}_${fc.field}_suppress`,
          heuristic_type: "suppression",
          action_type: "suppress_field",
          adjustment_field: null,
          adjustment_factor: null,
          adjustment_absolute: null,
          suppress_field: fc.field,
          suppress_below_confidence: 30,
          avg_accuracy_score: avgAccuracy,
          avg_pct_delta: Math.round(avgDelta * 10) / 10,
          median_pct_delta: Math.round(medDelta * 10) / 10,
          failure_rate: Math.round(failureRate * 100) / 100,
          common_failures: topFailures,
          evidence_summary: `${fc.field} is unreliable for ${bucket.key}: avg delta ${Math.round(avgDelta)}%, stddev ${Math.round(stdDev)}% (n=${deltas.length}). Recommend suppressing when field confidence < 30%.`,
          should_activate: n >= 4,
        });
      }
    }
  }

  // Roof form mismatch check
  const formMismatches = vals.filter(v => v.roof_form_match === false).length;
  const formMatchTotal = vals.filter(v => v.roof_form_match != null).length;
  if (formMatchTotal >= 2 && formMismatches / formMatchTotal > 0.5) {
    heuristics.push({
      heuristic_key: `${bucket.key}_form_confidence_reduction`,
      heuristic_type: "adjustment",
      action_type: "adjust_confidence",
      adjustment_field: "roof_form_confidence",
      adjustment_factor: 0.5,
      adjustment_absolute: null,
      suppress_field: null,
      suppress_below_confidence: null,
      avg_accuracy_score: avgAccuracy,
      avg_pct_delta: 0,
      median_pct_delta: 0,
      failure_rate: Math.round((formMismatches / formMatchTotal) * 100) / 100,
      common_failures: ["roof_form_mismatch", ...topFailures],
      evidence_summary: `Roof form classification is wrong ${Math.round((formMismatches / formMatchTotal) * 100)}% of the time for ${bucket.key} (${formMismatches}/${formMatchTotal}). Halving roof_form_confidence.`,
      should_activate: formMatchTotal >= 3,
    });
  }

  // Overall confidence adjustment if failure rate is high
  if (failureRate > 0.4 && n >= 3) {
    heuristics.push({
      heuristic_key: `${bucket.key}_overall_confidence_penalty`,
      heuristic_type: "adjustment",
      action_type: "adjust_confidence",
      adjustment_field: "confidence_score",
      adjustment_factor: Math.max(0.5, 1 - failureRate),
      adjustment_absolute: null,
      suppress_field: null,
      suppress_below_confidence: null,
      avg_accuracy_score: avgAccuracy,
      avg_pct_delta: 0,
      median_pct_delta: 0,
      failure_rate: Math.round(failureRate * 100) / 100,
      common_failures: topFailures,
      evidence_summary: `${Math.round(failureRate * 100)}% of validations fail for ${bucket.key} (n=${n}). Applying ${Math.round((1 - Math.max(0.5, 1 - failureRate)) * 100)}% confidence penalty.`,
      should_activate: true,
    });
  }

  return heuristics;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: roleData } = await supabase
      .from("user_roles").select("role").eq("user_id", user.id).in("role", ["staff", "admin"]);
    if (!roleData || roleData.length === 0) {
      return new Response(JSON.stringify({ error: "Insufficient permissions" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || "recompute";

    if (action === "recompute") {
      // Fetch all validations
      const { data: validations, error: vErr } = await supabase
        .from("claim_roof_validations")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);

      if (vErr) throw new Error(`Failed to fetch validations: ${vErr.message}`);
      if (!validations || validations.length === 0) {
        return new Response(JSON.stringify({ success: true, message: "No validations to analyze", heuristics_count: 0 }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Fetch corresponding measurements for segmentation
      const estimateIds = [...new Set(validations.map((v: any) => v.estimate_id).filter(Boolean))];
      const { data: measurements } = await supabase
        .from("claim_roof_measurements")
        .select("id, inferred_roof_form, geometry_quality_score, aspect_ratio, confidence_score, imagery_source")
        .in("id", estimateIds);

      const measMap = new Map((measurements || []).map((m: any) => [m.id, m]));

      // Build segment buckets
      const buckets = new Map<string, SegmentBucket>();

      for (const v of validations as any[]) {
        const meas = measMap.get(v.estimate_id) as MeasurementRow | undefined;
        const roofForm = v.darwin_roof_form || meas?.inferred_roof_form || "unknown";
        const geoSource = meas?.imagery_source || "unknown";
        const qBand = qualityBand(v.darwin_geometry_quality_score ?? meas?.geometry_quality_score);
        const arBand = aspectRatioBand(meas?.aspect_ratio);
        const cBand = confidenceBand(v.darwin_confidence_score ?? meas?.confidence_score);

        // Primary bucket: roof_form + quality_band
        const primaryKey = `${roofForm}_q${qBand}`;
        if (!buckets.has(primaryKey)) {
          buckets.set(primaryKey, {
            key: primaryKey,
            roof_form: roofForm,
            geometry_source: null,
            quality_band: qBand,
            aspect_ratio_band: "all",
            confidence_band: "all",
            validations: [],
            measurements: [],
          });
        }
        buckets.get(primaryKey)!.validations.push(v);
        if (meas) buckets.get(primaryKey)!.measurements.push(meas);

        // Secondary bucket: roof_form + aspect_ratio_band
        const arKey = `${roofForm}_ar${arBand}`;
        if (!buckets.has(arKey)) {
          buckets.set(arKey, {
            key: arKey,
            roof_form: roofForm,
            geometry_source: null,
            quality_band: "all",
            aspect_ratio_band: arBand,
            confidence_band: "all",
            validations: [],
            measurements: [],
          });
        }
        buckets.get(arKey)!.validations.push(v);
        if (meas) buckets.get(arKey)!.measurements.push(meas);

        // Tertiary bucket: source-specific
        if (geoSource && geoSource !== "unknown") {
          const srcKey = `src_${geoSource.replace(/\s+/g, "_").toLowerCase()}`;
          if (!buckets.has(srcKey)) {
            buckets.set(srcKey, {
              key: srcKey,
              roof_form: null,
              geometry_source: geoSource,
              quality_band: "all",
              aspect_ratio_band: "all",
              confidence_band: "all",
              validations: [],
              measurements: [],
            });
          }
          buckets.get(srcKey)!.validations.push(v);
          if (meas) buckets.get(srcKey)!.measurements.push(meas);
        }
      }

      // Derive heuristics from each bucket
      const allHeuristics: any[] = [];
      for (const bucket of buckets.values()) {
        const derived = deriveHeuristics(bucket);
        for (const h of derived) {
          allHeuristics.push({
            ...h,
            segment_roof_form: bucket.roof_form,
            segment_geometry_source: bucket.geometry_source,
            segment_quality_score_min: bucket.quality_band === "low" ? 0 : bucket.quality_band === "medium" ? 40 : bucket.quality_band === "high" ? 70 : null,
            segment_quality_score_max: bucket.quality_band === "low" ? 39 : bucket.quality_band === "medium" ? 69 : bucket.quality_band === "high" ? 100 : null,
            segment_aspect_ratio_min: bucket.aspect_ratio_band === "compact" ? 0 : bucket.aspect_ratio_band === "rectangular" ? 1.3 : bucket.aspect_ratio_band === "elongated" ? 2.0 : null,
            segment_aspect_ratio_max: bucket.aspect_ratio_band === "compact" ? 1.29 : bucket.aspect_ratio_band === "rectangular" ? 1.99 : bucket.aspect_ratio_band === "elongated" ? 10 : null,
            sample_size: bucket.validations.length,
            validation_ids: bucket.validations.map(v => v.id),
            is_active: h.should_activate,
            last_computed_at: new Date().toISOString(),
            created_by: user.id,
          });
        }
      }

      // Upsert heuristics (don't overwrite manually_overridden ones)
      let upserted = 0;
      let skipped = 0;
      for (const h of allHeuristics) {
        const { data: existing } = await supabase
          .from("darwin_roof_tuning_heuristics")
          .select("id, manually_overridden")
          .eq("heuristic_key", h.heuristic_key)
          .maybeSingle();

        if (existing?.manually_overridden) {
          skipped++;
          continue;
        }

        const { heuristic_key, should_activate, ...rest } = h;
        await supabase
          .from("darwin_roof_tuning_heuristics")
          .upsert({
            ...rest,
            heuristic_key,
            updated_at: new Date().toISOString(),
          }, { onConflict: "heuristic_key" });

        upserted++;
      }

      // Audit log
      await supabase.from("audit_logs").insert({
        user_id: user.id,
        action: "create",
        record_type: "darwin_tuning_recompute",
        record_id: user.id,
        new_values: {
          total_validations: validations.length,
          buckets_analyzed: buckets.size,
          heuristics_derived: allHeuristics.length,
          heuristics_upserted: upserted,
          heuristics_skipped_manual: skipped,
        },
      });

      return new Response(JSON.stringify({
        success: true,
        total_validations: validations.length,
        buckets_analyzed: buckets.size,
        heuristics_derived: allHeuristics.length,
        heuristics_upserted: upserted,
        heuristics_skipped_manual: skipped,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    } else if (action === "toggle") {
      // Toggle active state of a heuristic
      const { heuristic_id, is_active } = body;
      if (!heuristic_id) throw new Error("heuristic_id required");

      const isAdmin = roleData.some((r: any) => r.role === "admin");
      if (!isAdmin) {
        return new Response(JSON.stringify({ error: "Only admins can toggle heuristics" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { error: updErr } = await supabase
        .from("darwin_roof_tuning_heuristics")
        .update({
          is_active: !!is_active,
          manually_overridden: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", heuristic_id);

      if (updErr) throw new Error(updErr.message);

      return new Response(JSON.stringify({ success: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    } else {
      throw new Error(`Unknown action: ${action}`);
    }
  } catch (err) {
    console.error("Darwin tuning error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
