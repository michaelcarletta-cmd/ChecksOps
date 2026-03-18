import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Bug, ChevronDown, ChevronUp } from "lucide-react";

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
  // Shape conflict
  roof_shape_conflict: boolean | null;
  roof_shape_conflict_reason: string | null;
  provisional_complexity_uplift_used: number | null;
  shape_conflicted_roof_area_sqft: number | null;
  shape_conflicted_squares: number | null;
}

interface Props {
  estimate: DebugEstimate;
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

/**
 * Renders an SVG overlay of the original footprint and expanded roof polygon
 * side-by-side for visual comparison.
 */
function PolygonOverlay({ footprintGeoJson, roofGeoJson }: { footprintGeoJson: any; roofGeoJson: any }) {
  const extractRing = (geojson: any): [number, number][] => {
    if (!geojson?.coordinates?.[0]) return [];
    return geojson.coordinates[0].map((c: number[]) => [c[0], c[1]]);
  };

  const fpRing = extractRing(footprintGeoJson);
  const roofRing = extractRing(roofGeoJson);

  if (fpRing.length < 3 && roofRing.length < 3) return null;

  // Compute combined bounds
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
    // Flip Y since lat increases upward
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
        {/* Grid lines for reference */}
        {[0.25, 0.5, 0.75].map(f => (
          <line key={`h${f}`} x1={0} y1={f * svgH} x2={svgW} y2={f * svgH} stroke="hsl(var(--border))" strokeWidth={0.5} strokeDasharray="4 4" />
        ))}
        {[0.25, 0.5, 0.75].map(f => (
          <line key={`v${f}`} x1={f * svgW} y1={0} x2={f * svgW} y2={svgH} stroke="hsl(var(--border))" strokeWidth={0.5} strokeDasharray="4 4" />
        ))}

        {/* Expanded roof polygon (drawn first so footprint overlays) */}
        {roofRing.length >= 3 && (
          <path
            d={toPath(roofRing)}
            fill="hsl(var(--primary) / 0.15)"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            strokeDasharray="6 3"
          />
        )}

        {/* Original footprint polygon */}
        {fpRing.length >= 3 && (
          <path
            d={toPath(fpRing)}
            fill="hsl(var(--destructive) / 0.1)"
            stroke="hsl(var(--destructive))"
            strokeWidth={1.5}
          />
        )}

        {/* Vertex dots for footprint */}
        {fpRing.slice(0, -1).map((p, i) => {
          const [x, y] = toSvg(p[0], p[1]);
          return <circle key={`fp${i}`} cx={x} cy={y} r={2.5} fill="hsl(var(--destructive))" />;
        })}

        {/* Vertex dots for roof polygon */}
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

export function DarwinRoofAreaDebug({ estimate }: Props) {
  const [expanded, setExpanded] = useState(false);

  const e = estimate;
  const hasPipeline = e.footprint_area_sqft != null && e.footprint_area_sqft > 0;

  // Compute verification: does planar × slope × correction = final?
  const expectedArea = (e.roof_planar_area_sqft ?? 0) * (e.slope_factor_used ?? 1) * (e.correction_factor_used ?? 1);
  const actualArea = e.estimated_roof_area_sqft ?? 0;
  const areaDelta = Math.abs(expectedArea - actualArea);
  const areaMatch = areaDelta <= 1; // within rounding

  // Edge classification summary
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
          {/* Pipeline Step-Through */}
          <div className="rounded border overflow-hidden">
            <div className="bg-muted/50 px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
              1. Footprint Selection
            </div>
            <DebugRow label="Source" value={e.imagery_source ?? "none"} warn={!e.imagery_source} />
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
            <DebugRow label="Correction Factor" value={e.correction_factor_used?.toFixed(4) ?? "—"} warn={e.correction_factor_used != null && e.correction_factor_used !== 1.0} />
            <DebugRow label="Inferred Roof Form" value={e.inferred_roof_form ?? "unknown"} />

            <div className="bg-muted/50 px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">
              6. Final Calculation
            </div>
            <DebugRow
              label="Expected Area"
              value={`${Math.round(expectedArea).toLocaleString()} sqft`}
              formula={`${e.roof_planar_area_sqft ?? 0} × ${e.slope_factor_used?.toFixed(4) ?? "?"} × ${e.correction_factor_used?.toFixed(4) ?? "?"}`}
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
