import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Bug, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";

interface OverhangConfig {
  eave_overhang_ft: number;
  rake_overhang_ft: number;
  unknown_overhang_ft: number;
  source: "default" | "user" | "regional";
}

interface DebugEstimate {
  footprint_area_sqft: number | null;
  roof_planar_area_sqft: number | null;
  estimated_roof_area_sqft: number | null;
  squares: number | null;
  planar_area_gain_sqft: number | null;
  overhang_config: OverhangConfig | null;
  pitch_band: string | null;
  dominant_pitch: string | null;
  slope_factor_used: number | null;
  correction_factor_used: number | null;
  calibration_adjustment_factor: number | null;
  geometry_quality_score: number | null;
  selected_candidate_index: number | null;
  imagery_source: string | null;
  footprint_polygon: any | null;
  roof_polygon_geojson: any | null;
  geocoded_lat: number | null;
  geocoded_lng: number | null;
  inferred_roof_form: string | null;
  edge_classifications: any[] | null;
  roof_shape_conflict: boolean | null;
  roof_shape_conflict_reason: string | null;
  provisional_complexity_uplift_used: number | null;
  shape_conflicted_roof_area_sqft: number | null;
  shape_conflicted_squares: number | null;
}

interface CandidateDebugEntry {
  source: string;
  source_feature_id: string | null;
  geometry_quality_score: number;
  candidate_score_total: number;
  candidate_score_breakdown: {
    source_priority: number;
    centroid_offset: number;
    area_sanity: number;
    vertex_quality: number;
    shape_conflict: number;
  };
  area_sqft: number;
  centroid_offset_ft: number | null;
  vertex_count: number;
  selected: boolean;
  rejected_reason: string | null;
}

interface CandidateFetchSummary {
  microsoft_count: number;
  njgin_count: number;
  esri_count: number;
  osm_count: number;
  ai_count: number;
  selected_source: string | null;
  selected_score: number | null;
  guardrail_triggered: boolean;
  guardrail_reason: string | null;
  // Hard source filter fields
  raw_candidate_count?: number;
  effective_candidate_count?: number;
  authoritative_candidate_count?: number;
  weak_authoritative_count?: number;
  ai_candidates_removed?: number;
  hard_source_filter_triggered?: boolean;
  nearest_authoritative_distance_ft?: number | null;
  coordinate_source?: string | null;
}

interface Props {
  estimate: DebugEstimate;
  candidateDebugData?: {
    candidate_debug: CandidateDebugEntry[];
    candidate_fetch_summary: CandidateFetchSummary | null;
  } | null;
}

const DebugRow = ({ label, value, warn, formula }: { label: string; value: React.ReactNode; warn?: boolean; formula?: string }) => (
  <div className={`flex items-center justify-between py-1 px-2 text-xs ${warn ? "bg-destructive/10" : "even:bg-muted/30"}`}>
    <span className="text-muted-foreground flex items-center gap-1">
      {label}
      {formula && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[9px] text-muted-foreground/60 cursor-help">ƒ</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[10px] font-mono max-w-[300px]">{formula}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </span>
    <span className={`font-mono tabular-nums ${warn ? "text-destructive font-semibold" : ""}`}>{value}</span>
  </div>
);

function PolygonOverlay({ footprintGeoJson, roofGeoJson }: { footprintGeoJson: any; roofGeoJson: any }) {
  const extractRing = (geojson: any): [number, number][] => {
    if (!geojson?.coordinates?.[0]) return [];
    return geojson.coordinates[0].map((c: number[]) => [c[0], c[1]]);
  };

  const fpRing = extractRing(footprintGeoJson);
  const roofRing = extractRing(roofGeoJson);

  if (fpRing.length < 3 && roofRing.length < 3) return null;

  const allPts = [...fpRing, ...roofRing];
  const lngs = allPts.map(p => p[0]);
  const lats = allPts.map(p => p[1]);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  const pad = 0.15;
  const dLng = (maxLng - minLng) || 0.0001;
  const dLat = (maxLat - minLat) || 0.0001;
  const svgW = 320;
  const svgH = 240;

  const toSvg = (lng: number, lat: number): [number, number] => {
    const x = ((lng - minLng) / dLng) * (1 - 2 * pad) * svgW + pad * svgW;
    const y = ((maxLat - lat) / dLat) * (1 - 2 * pad) * svgH + pad * svgH;
    return [x, y];
  };

  const toPath = (ring: [number, number][]): string => {
    if (ring.length < 3) return "";
    const pts = ring.map(([lng, lat]) => toSvg(lng, lat));
    return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") + " Z";
  };

  return (
    <div className="mt-2">
      <div className="text-[10px] font-medium text-muted-foreground mb-1">Polygon Overlay</div>
      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full max-w-[400px] h-auto border rounded bg-background" style={{ aspectRatio: `${svgW}/${svgH}` }}>
        {[0.25, 0.5, 0.75].map(f => (
          <line key={`h${f}`} x1={0} y1={f * svgH} x2={svgW} y2={f * svgH} stroke="hsl(var(--border))" strokeWidth={0.5} strokeDasharray="4 4" />
        ))}
        {[0.25, 0.5, 0.75].map(f => (
          <line key={`v${f}`} x1={f * svgW} y1={0} x2={f * svgW} y2={svgH} stroke="hsl(var(--border))" strokeWidth={0.5} strokeDasharray="4 4" />
        ))}
        {roofRing.length >= 3 && (
          <path d={toPath(roofRing)} fill="hsl(var(--primary) / 0.15)" stroke="hsl(var(--primary))" strokeWidth={2} strokeDasharray="6 3" />
        )}
        {fpRing.length >= 3 && (
          <path d={toPath(fpRing)} fill="hsl(var(--destructive) / 0.1)" stroke="hsl(var(--destructive))" strokeWidth={1.5} />
        )}
        {fpRing.slice(0, -1).map((p, i) => {
          const [x, y] = toSvg(p[0], p[1]);
          return <circle key={`fp${i}`} cx={x} cy={y} r={2.5} fill="hsl(var(--destructive))" />;
        })}
        {roofRing.slice(0, -1).map((p, i) => {
          const [x, y] = toSvg(p[0], p[1]);
          return <circle key={`rp${i}`} cx={x} cy={y} r={2.5} fill="hsl(var(--primary))" />;
        })}
      </svg>
      <div className="flex gap-4 mt-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-destructive" /> Original Footprint
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 bg-primary" style={{ borderBottom: "1px dashed" }} /> Expanded Roof Polygon
        </span>
      </div>
    </div>
  );
}

function CandidateDebugPanel({ candidates, summary }: { candidates: CandidateDebugEntry[]; summary: CandidateFetchSummary | null }) {
  const effectiveSummary = summary ?? {
    microsoft_count: 0,
    njgin_count: 0,
    esri_count: 0,
    osm_count: 0,
    ai_count: 0,
    selected_source: null,
    selected_score: null,
    guardrail_triggered: false,
    guardrail_reason: null,
  };

  const sourceColor = (src: string) => {
    if (src.includes("Microsoft") || src.includes("Local DB")) return "text-green-600";
    if (src.includes("NJGIN")) return "text-blue-600";
    if (src.includes("Esri")) return "text-cyan-600";
    if (src.includes("OpenStreetMap")) return "text-amber-600";
    if (src.includes("AI Vision")) return "text-destructive";
    return "text-muted-foreground";
  };

  const hardFilterTriggered = effectiveSummary.hard_source_filter_triggered === true;
  const authCount = effectiveSummary.authoritative_candidate_count ?? 0;
  const aiRemoved = effectiveSummary.ai_candidates_removed ?? 0;
  const selectedIsAiVision = (effectiveSummary.selected_source ?? "").includes("AI Vision") || (effectiveSummary.selected_source ?? "").includes("Default Residential");
  const bugDetected = authCount > 0 && selectedIsAiVision;

  const warnings: string[] = [];
  if (effectiveSummary.microsoft_count === 0) warnings.push("No Microsoft footprint found");
  if (effectiveSummary.njgin_count === 0) warnings.push("No NJGIN footprint found");
  if (effectiveSummary.osm_count === 0) warnings.push("No OSM footprint found");
  if (selectedIsAiVision && authCount === 0 && effectiveSummary.ai_count > 0) {
    warnings.push("AI Vision remained selected — no authoritative candidate was available or passed sanity checks");
  }
  if (!summary && candidates.length === 0) {
    warnings.push("No candidate debug payload is available for this run yet");
  }
  // If the building_footprints table has data globally but no authoritative candidate was nearby
  if ((effectiveSummary.raw_candidate_count ?? 0) > 0 && authCount === 0 && effectiveSummary.microsoft_count === 0 && effectiveSummary.njgin_count === 0) {
    warnings.push("Microsoft footprint dataset is populated, but no nearby authoritative footprint was found for this property.");
  }

  return (
    <div className="rounded border border-cyan-500/40 overflow-hidden">
      <div className="bg-cyan-500/10 px-2 py-1 text-[10px] font-semibold uppercase text-cyan-700">
        Footprint Candidate Debug
      </div>

      {/* Hard source filter badges */}
      {hardFilterTriggered && (
        <div className="px-2 py-1.5 bg-green-500/10 border-b border-green-500/30">
          <div className="flex items-start gap-1.5 text-[10px]">
            <span className="text-green-700 font-semibold">✓ HARD SOURCE FILTER ACTIVE</span>
          </div>
          <div className="text-[9px] text-green-600 mt-0.5">
            AI Vision candidates were removed because {authCount} authoritative footprint{authCount !== 1 ? "s" : ""} {authCount !== 1 ? "were" : "was"} available. ({aiRemoved} AI candidate{aiRemoved !== 1 ? "s" : ""} removed)
          </div>
        </div>
      )}

      {bugDetected && (
        <div className="px-2 py-1.5 bg-destructive/10 border-b border-destructive/30">
          <div className="flex items-start gap-1.5 text-[10px]">
            <AlertTriangle className="h-3 w-3 text-destructive mt-0.5 shrink-0" />
            <span className="text-destructive font-semibold">BUG: AI Vision selected even though authoritative candidates existed.</span>
          </div>
        </div>
      )}

      {selectedIsAiVision && !bugDetected && authCount === 0 && (
        <div className="px-2 py-1.5 bg-amber-500/10 border-b border-amber-500/30">
          <div className="flex items-start gap-1.5 text-[10px]">
            <AlertTriangle className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
            <span className="text-amber-700 font-medium">Authoritative footprint data is still not available for this property.</span>
          </div>
        </div>
      )}

      <div className="border-b border-border/50">
        <DebugRow label="Raw Candidates" value={effectiveSummary.raw_candidate_count ?? candidates.length} />
        <DebugRow label="Effective Candidates" value={effectiveSummary.effective_candidate_count ?? candidates.length} warn={(effectiveSummary.effective_candidate_count ?? candidates.length) === 0} />
        <DebugRow label="Authoritative Candidates" value={authCount} warn={authCount === 0} />
        <DebugRow label="AI Candidates Removed" value={aiRemoved} />
        <DebugRow label="Microsoft (DB)" value={effectiveSummary.microsoft_count} warn={effectiveSummary.microsoft_count === 0} />
        <DebugRow label="NJGIN" value={effectiveSummary.njgin_count} warn={effectiveSummary.njgin_count === 0} />
        <DebugRow label="Esri/MS" value={effectiveSummary.esri_count} />
        <DebugRow label="OSM" value={effectiveSummary.osm_count} warn={effectiveSummary.osm_count === 0} />
        <DebugRow label="AI Vision" value={effectiveSummary.ai_count} />
        <DebugRow
          label="Selected Source"
          value={<span className={sourceColor(effectiveSummary.selected_source ?? "")}>{effectiveSummary.selected_source ?? "none"}</span>}
          warn={selectedIsAiVision}
        />
        <DebugRow label="Selected Score" value={effectiveSummary.selected_score ?? "—"} />
        <DebugRow label="Hard Filter" value={hardFilterTriggered ? "YES ✓" : "No"} />
        <DebugRow label="Guardrail Triggered" value={effectiveSummary.guardrail_triggered ? "YES ✓" : "No"} />
        {effectiveSummary.guardrail_triggered && effectiveSummary.guardrail_reason && (
          <DebugRow label="Guardrail Reason" value={effectiveSummary.guardrail_reason} />
        )}
      </div>

      {warnings.length > 0 && (
        <div className="px-2 py-1.5 space-y-1">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5 text-[10px]">
              <AlertTriangle className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
              <span className="text-amber-700">{w}</span>
            </div>
          ))}
        </div>
      )}

      {candidates.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="bg-muted/50 text-muted-foreground">
                <th className="px-1.5 py-1 text-left font-medium">Source</th>
                <th className="px-1.5 py-1 text-right font-medium">Score</th>
                <th className="px-1.5 py-1 text-right font-medium">Area</th>
                <th className="px-1.5 py-1 text-right font-medium">Offset</th>
                <th className="px-1.5 py-1 text-right font-medium">Vtx</th>
                <th className="px-1.5 py-1 text-right font-medium">Qual</th>
                <th className="px-1.5 py-1 text-center font-medium">Sel</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c, i) => (
                <tr key={i} className={`border-t border-border/30 ${c.selected ? "bg-primary/5" : ""}`}>
                  <td className={`px-1.5 py-1 font-mono ${sourceColor(c.source)} truncate max-w-[120px]`} title={c.source}>
                    {c.source.replace("Building Footprints", "").replace("(satellite imagery)", "").replace("Estimate ", "").trim()}
                  </td>
                  <td className="px-1.5 py-1 text-right font-mono">{c.candidate_score_total}</td>
                  <td className="px-1.5 py-1 text-right font-mono">{c.area_sqft?.toLocaleString()}</td>
                  <td className="px-1.5 py-1 text-right font-mono">{c.centroid_offset_ft != null ? `${Math.round(c.centroid_offset_ft)}ft` : "—"}</td>
                  <td className="px-1.5 py-1 text-right font-mono">{c.vertex_count}</td>
                  <td className="px-1.5 py-1 text-right font-mono">{c.geometry_quality_score}</td>
                  <td className="px-1.5 py-1 text-center">
                    {c.selected ? <span className="text-green-600 font-bold">✓</span> : c.rejected_reason ? <span className="text-destructive" title={c.rejected_reason}>✗</span> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {candidates.filter(c => c.selected).map((c, i) => (
            <div key={i} className="px-2 py-1 bg-muted/20 text-[9px] font-mono text-muted-foreground">
              Score breakdown: src={c.candidate_score_breakdown.source_priority} offset={c.candidate_score_breakdown.centroid_offset} area={c.candidate_score_breakdown.area_sanity} vtx={c.candidate_score_breakdown.vertex_quality} conflict={c.candidate_score_breakdown.shape_conflict}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DarwinRoofAreaDebug({ estimate, candidateDebugData }: Props) {
  const [expanded, setExpanded] = useState(false);

  const e = estimate;
  const hasPipeline = e.footprint_area_sqft != null && e.footprint_area_sqft > 0;

  const expectedArea = (e.roof_planar_area_sqft ?? 0) * (e.slope_factor_used ?? 1) * (e.correction_factor_used ?? 1) * (e.calibration_adjustment_factor ?? 1);
  const actualArea = e.estimated_roof_area_sqft ?? 0;
  const areaDelta = Math.abs(expectedArea - actualArea);
  const areaMatch = areaDelta <= 1;

  const edgeCls = e.edge_classifications || [];
  const eaveCount = edgeCls.filter((ec: any) => ec.classification === "likely_eave").length;
  const rakeCount = edgeCls.filter((ec: any) => ec.classification === "likely_rake").length;
  const unknownCount = edgeCls.filter((ec: any) => ec.classification === "unknown").length;
  const totalEdges = edgeCls.length;

  return (
    <div className="rounded-lg border border-dashed border-amber-500/50 bg-amber-50/5">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <Bug className="h-4 w-4 text-amber-600" />
          <span>Roof Area Debug</span>
          {!areaMatch && hasPipeline && (
            <Badge variant="destructive" className="text-[9px]">
              MISMATCH Δ{Math.round(areaDelta)} sqft
            </Badge>
          )}
          {areaMatch && hasPipeline && (
            <Badge variant="outline" className="text-[9px] border-green-500/50 text-green-600">
              Pipeline Verified ✓
            </Badge>
          )}
        </div>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Candidate Debug Panel — shown first for diagnosis */}
          <CandidateDebugPanel
            candidates={candidateDebugData?.candidate_debug ?? []}
            summary={candidateDebugData?.candidate_fetch_summary ?? null}
          />

          {/* Pipeline Step-Through */}
          <div className="rounded border overflow-hidden">
            <div className="bg-muted/50 px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
              1. Footprint Selection (Source Ladder)
            </div>
            <DebugRow label="Selected Source" value={
              <span className={
                (e.imagery_source || "").includes("Microsoft") || (e.imagery_source || "").includes("Local DB")
                  ? "text-green-600 font-bold"
                  : (e.imagery_source || "").includes("NJGIN")
                    ? "text-blue-600 font-bold"
                    : (e.imagery_source || "").includes("AI Vision")
                      ? "text-destructive font-bold"
                      : ""
              }>
                {e.imagery_source ?? "none"}
              </span>
            } warn={!e.imagery_source || (e.imagery_source || "").includes("AI Vision")} />
            <DebugRow label="Source Priority" value={
              (e.imagery_source || "").includes("Local DB") ? "100 (MS DB)" :
              (e.imagery_source || "").includes("NJGIN") ? "90 (State GIS)" :
              (e.imagery_source || "").includes("Esri") ? "80 (Esri/MS)" :
              (e.imagery_source || "").includes("OpenStreetMap") ? "60 (OSM)" :
              (e.imagery_source || "").includes("AI Vision") ? "20 (AI fallback)" :
              "—"
            } />
            <DebugRow label="Candidate Index" value={e.selected_candidate_index ?? "—"} />
            <DebugRow label="Geometry Quality" value={`${e.geometry_quality_score ?? "—"}/100`} warn={(e.geometry_quality_score ?? 0) < 40} />
            <DebugRow label="Footprint Area (raw)" value={`${e.footprint_area_sqft?.toLocaleString() ?? "—"} sqft`} warn={!e.footprint_area_sqft} />

            <div className="bg-muted/50 px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
              2. Edge Classification
            </div>
            <DebugRow label="Total Edges" value={totalEdges || "—"} />
            <DebugRow label="Eave / Rake / Unknown" value={`${eaveCount} / ${rakeCount} / ${unknownCount}`} warn={unknownCount > totalEdges * 0.4} />

            <div className="bg-muted/50 px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
              3. Overhang Expansion
            </div>
            <DebugRow
              label="Overhang Config"
              value={e.overhang_config ? `eave=${e.overhang_config.eave_overhang_ft}ft  rake=${e.overhang_config.rake_overhang_ft}ft  unk=${e.overhang_config.unknown_overhang_ft}ft` : "—"}
            />
            <DebugRow label="Original Footprint Area" value={`${e.footprint_area_sqft?.toLocaleString() ?? "—"} sqft`} />
            <DebugRow label="Expanded Planar Area" value={`${e.roof_planar_area_sqft?.toLocaleString() ?? "—"} sqft`} />
            <DebugRow
              label="Planar Area Gain"
              value={`+${e.planar_area_gain_sqft?.toLocaleString() ?? "—"} sqft`}
              formula="expanded_planar - original_footprint"
            />

            <div className="bg-muted/50 px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
              4. Pitch & Slope
            </div>
            <DebugRow label="Pitch Band" value={e.pitch_band ?? "unknown"} warn={e.pitch_band === "unknown"} />
            <DebugRow label="Dominant Pitch" value={e.dominant_pitch ?? "—"} />
            <DebugRow label="Slope Factor Used" value={e.slope_factor_used?.toFixed(4) ?? "—"} warn={!e.slope_factor_used} />

            <div className="bg-muted/50 px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
              5. Validation Correction
            </div>
            <DebugRow label="Correction Factor" value={e.correction_factor_used?.toFixed(4) ?? "—"} warn={e.correction_factor_used != null && e.correction_factor_used !== 1.0} formula="validation-derived area correction" />
            <DebugRow label="Calibration Adjustment" value={(e.calibration_adjustment_factor ?? 1).toFixed(4)} warn={e.calibration_adjustment_factor != null && e.calibration_adjustment_factor !== 1.0} formula="complexity/source/quality tuning factor" />
            <DebugRow label="Inferred Roof Form" value={e.inferred_roof_form ?? "unknown"} />

            <div className="bg-muted/50 px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
              6. Final Calculation
            </div>
            <DebugRow
              label="Expected Area"
              value={`${Math.round(expectedArea).toLocaleString()} sqft`}
              formula={`${e.roof_planar_area_sqft ?? 0} × ${(e.slope_factor_used ?? 1).toFixed(4)} × ${(e.correction_factor_used ?? 1).toFixed(4)} × ${(e.calibration_adjustment_factor ?? 1).toFixed(4)}`}
            />
            <DebugRow
              label="Actual Area (stored)"
              value={`${actualArea.toLocaleString()} sqft`}
              warn={!areaMatch && hasPipeline}
            />
            <DebugRow
              label="Delta"
              value={areaMatch ? "0 (match ✓)" : `${Math.round(areaDelta)} sqft ⚠️`}
              warn={!areaMatch && hasPipeline}
            />
            <DebugRow
              label="Final Squares"
              value={e.squares != null ? e.squares.toFixed(1) : "—"}
              formula="final_area / 100"
            />
          </div>

          {/* Shape Conflict Section */}
          {e.roof_shape_conflict && (
            <div className="rounded border border-yellow-500/40 overflow-hidden">
              <div className="bg-yellow-500/20 px-2 py-1 text-[10px] font-semibold uppercase text-yellow-700">
                7. Shape Conflict
              </div>
              <DebugRow label="Conflict" value="YES ⚠️" warn />
              <DebugRow label="Reason" value={e.roof_shape_conflict_reason ?? "—"} warn />
              <DebugRow
                label="Uplift Factor"
                value={e.provisional_complexity_uplift_used != null ? `×${e.provisional_complexity_uplift_used}` : "none"}
                warn={e.provisional_complexity_uplift_used != null && e.provisional_complexity_uplift_used > 1.0}
              />
              <DebugRow
                label="Uplifted Area"
                value={e.shape_conflicted_roof_area_sqft != null ? `${e.shape_conflicted_roof_area_sqft.toLocaleString()} sqft` : "—"}
              />
              <DebugRow
                label="Uplifted Squares"
                value={e.shape_conflicted_squares != null ? e.shape_conflicted_squares.toFixed(1) : "—"}
              />
            </div>
          )}

          {/* Polygon overlay */}
          {(e.footprint_polygon || e.roof_polygon_geojson) && (
            <PolygonOverlay
              footprintGeoJson={e.footprint_polygon}
              roofGeoJson={e.roof_polygon_geojson}
            />
          )}

          {/* Geocode verification */}
          <div className="text-[10px] text-muted-foreground font-mono">
            Geocode: {e.geocoded_lat?.toFixed(6)}, {e.geocoded_lng?.toFixed(6)}
          </div>
        </div>
      )}
    </div>
  );
}
