import { useMemo, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Undo2, Trash2, Save, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

type LngLat = [number, number];

interface PolygonLayer {
  id: string;
  label: string;
  color: string;   // HSL token or raw
  fillOpacity: number;
  polygon: LngLat[] | null; // closed ring
  dashed?: boolean;
}

interface Props {
  roofMeasurementId: string;
  geocodedLat: number;
  geocodedLng: number;
  suggestedPolygon?: any | null;
  footprintPolygon?: any | null;
  roofPolygonGeojson?: any | null;
  userDrawnPolygon?: any | null;
  onSaved?: () => void;
}

// --- Geo helpers ---
const MAP_SPAN_DEG = 0.0018; // ~650ft across, enough for most residential roofs
const SVG_W = 1000;
const SVG_H = 700;

function lngLatToSvg(
  lng: number,
  lat: number,
  centerLng: number,
  centerLat: number,
): [number, number] {
  const x = ((lng - (centerLng - MAP_SPAN_DEG / 2)) / MAP_SPAN_DEG) * SVG_W;
  const y = ((centerLat + MAP_SPAN_DEG / 2 * (SVG_H / SVG_W) - lat) / (MAP_SPAN_DEG * (SVG_H / SVG_W))) * SVG_H;
  return [x, y];
}

function svgToLngLat(
  sx: number,
  sy: number,
  centerLng: number,
  centerLat: number,
): LngLat {
  const lng = centerLng - MAP_SPAN_DEG / 2 + (sx / SVG_W) * MAP_SPAN_DEG;
  const lat = centerLat + (MAP_SPAN_DEG / 2) * (SVG_H / SVG_W) - (sy / SVG_H) * MAP_SPAN_DEG * (SVG_H / SVG_W);
  return [lng, lat];
}

function extractRing(geojson: any): LngLat[] | null {
  if (!geojson) return null;
  const coords = geojson?.coordinates?.[0];
  if (!Array.isArray(coords) || coords.length < 3) return null;
  return coords as LngLat[];
}

function buildSatelliteUrl(lat: number, lng: number, zoom = 20, w = 640, h = 450) {
  // Use a free tile approach via Google Static Maps (unsigned, limited)
  return `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=${w}x${h}&maptype=satellite&key=`;
}

export function DarwinRoofOutlineEditor({
  roofMeasurementId,
  geocodedLat,
  geocodedLng,
  suggestedPolygon,
  footprintPolygon,
  roofPolygonGeojson,
  userDrawnPolygon,
  onSaved,
}: Props) {
  // Extract rings from geojson layers
  const footprintRing = useMemo(() => extractRing(footprintPolygon), [footprintPolygon]);
  const expandedRing = useMemo(() => extractRing(roofPolygonGeojson), [roofPolygonGeojson]);
  const suggestedRing = useMemo(() => extractRing(suggestedPolygon), [suggestedPolygon]);
  const existingUserRing = useMemo(() => extractRing(userDrawnPolygon), [userDrawnPolygon]);

  // User-drawn points (open ring, no closing duplicate)
  const [points, setPoints] = useState<LngLat[]>(() => {
    const ring = existingUserRing ?? suggestedRing;
    if (ring && ring.length >= 3) {
      // Remove closing point if same as first
      const pts = [...ring];
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (first[0] === last[0] && first[1] === last[1]) pts.pop();
      return pts;
    }
    return [];
  });

  const [saving, setSaving] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [history, setHistory] = useState<LngLat[][]>([]);

  // Layer visibility
  const [layers, setLayers] = useState({
    footprint: true,
    expanded: true,
    suggested: true,
    userDrawn: true,
  });

  const svgRef = useRef<SVGSVGElement>(null);

  // Push current state to history before mutation
  const pushHistory = useCallback(() => {
    setHistory((prev) => [...prev.slice(-30), points.map((p) => [...p] as LngLat)]);
  }, [points]);

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setPoints(last);
      return prev.slice(0, -1);
    });
  }, []);

  // Closed ring for saving/rendering
  const closedRing = useMemo<LngLat[]>(() => {
    if (points.length < 3) return [];
    return [...points, points[0]];
  }, [points]);

  // --- Coordinate conversion helpers ---
  const toSvg = useCallback(
    (lng: number, lat: number) => lngLatToSvg(lng, lat, geocodedLng, geocodedLat),
    [geocodedLng, geocodedLat],
  );

  const fromSvg = useCallback(
    (sx: number, sy: number) => svgToLngLat(sx, sy, geocodedLng, geocodedLat),
    [geocodedLng, geocodedLat],
  );

  const getSvgCoords = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) / rect.width) * SVG_W;
      const sy = ((e.clientY - rect.top) / rect.height) * SVG_H;
      return { sx, sy };
    },
    [],
  );

  // --- Interaction handlers ---
  const handleSvgClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (dragIndex !== null) return; // Ignore clicks during drag
      const coords = getSvgCoords(e);
      if (!coords) return;
      // Check if clicking near an existing vertex (for delete via right-click or just ignore)
      const [lng, lat] = fromSvg(coords.sx, coords.sy);
      pushHistory();
      setPoints((prev) => [...prev, [lng, lat]]);
    },
    [dragIndex, getSvgCoords, fromSvg, pushHistory],
  );

  const handleVertexMouseDown = useCallback(
    (idx: number, e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      pushHistory();
      setDragIndex(idx);
    },
    [pushHistory],
  );

  const handleSvgMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (dragIndex === null) return;
      const coords = getSvgCoords(e);
      if (!coords) return;
      const [lng, lat] = fromSvg(coords.sx, coords.sy);
      setPoints((prev) => {
        const next = [...prev];
        next[dragIndex] = [lng, lat];
        return next;
      });
    },
    [dragIndex, getSvgCoords, fromSvg],
  );

  const handleSvgMouseUp = useCallback(() => {
    setDragIndex(null);
  }, []);

  const deleteVertex = useCallback(
    (idx: number) => {
      pushHistory();
      setPoints((prev) => prev.filter((_, i) => i !== idx));
    },
    [pushHistory],
  );

  const clearAll = useCallback(() => {
    pushHistory();
    setPoints([]);
  }, [pushHistory]);

  const toggleLayer = (key: keyof typeof layers) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // --- Save ---
  const saveOutline = async () => {
    if (closedRing.length < 4) {
      toast.error("Draw at least 3 points");
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke("save-user-roof-outline", {
        body: {
          roof_measurement_id: roofMeasurementId,
          polygon_geojson: {
            type: "Polygon",
            coordinates: [closedRing],
          },
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success("Roof outline saved — authoritative values updated");
      onSaved?.();
    } catch (err: any) {
      toast.error(err.message || "Failed to save roof outline");
    } finally {
      setSaving(false);
    }
  };

  // --- Render helpers ---
  const ringToPath = useCallback(
    (ring: LngLat[]) => {
      if (ring.length < 3) return "";
      return (
        ring
          .map(([lng, lat], i) => {
            const [x, y] = toSvg(lng, lat);
            return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
          })
          .join(" ") + " Z"
      );
    },
    [toSvg],
  );

  const userPath = useMemo(() => ringToPath(closedRing), [closedRing, ringToPath]);
  const footprintPath = useMemo(() => (footprintRing ? ringToPath(footprintRing) : ""), [footprintRing, ringToPath]);
  const expandedPath = useMemo(() => (expandedRing ? ringToPath(expandedRing) : ""), [expandedRing, ringToPath]);
  const suggestedPath = useMemo(() => (suggestedRing ? ringToPath(suggestedRing) : ""), [suggestedRing, ringToPath]);

  // Satellite tile URL
  const tileUrl = useMemo(() => {
    // Construct an OpenStreetMap / Esri World Imagery tile at ~zoom 19
    // Using Esri World Imagery (free for visualization)
    const zoom = 19;
    const n = Math.pow(2, zoom);
    const tileX = Math.floor(((geocodedLng + 180) / 360) * n);
    const latRad = (geocodedLat * Math.PI) / 180;
    const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    // Return Esri World Imagery tile
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${tileY}/${tileX}`;
  }, [geocodedLat, geocodedLng]);

  // Layer config for legend
  const layerConfig: { key: keyof typeof layers; label: string; color: string; ring: LngLat[] | null }[] = [
    { key: "footprint", label: "Original Footprint", color: "hsl(var(--muted-foreground))", ring: footprintRing },
    { key: "expanded", label: "Expanded Roof Polygon", color: "hsl(200, 80%, 55%)", ring: expandedRing },
    { key: "suggested", label: "Suggested Outline", color: "hsl(45, 90%, 55%)", ring: suggestedRing },
    { key: "userDrawn", label: "User-Drawn (Editable)", color: "hsl(var(--primary))", ring: points.length > 0 ? closedRing : null },
  ];

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-sm">Roof Outline Tracing Tool</div>
          <div className="text-xs text-muted-foreground">
            Click to add points on the visible drip edge. Drag vertices to adjust. Right-click a vertex to delete.
          </div>
        </div>
        <Badge variant="outline" className="text-xs">
          {points.length} point{points.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {/* Layer toggles */}
      <div className="flex flex-wrap gap-2">
        {layerConfig.map((lc) => {
          if (!lc.ring && lc.key !== "userDrawn") return null;
          const visible = layers[lc.key];
          return (
            <button
              key={lc.key}
              type="button"
              onClick={() => toggleLayer(lc.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
                visible
                  ? "border-border bg-card text-card-foreground"
                  : "border-transparent bg-muted/40 text-muted-foreground line-through",
              )}
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full border"
                style={{
                  backgroundColor: visible ? lc.color : "transparent",
                  borderColor: lc.color,
                }}
              />
              {visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              {lc.label}
            </button>
          );
        })}
      </div>

      {/* Drawing canvas */}
      <div
        className="relative border border-border rounded-md overflow-hidden"
        style={{ width: "100%", height: 480 }}
      >
        {/* Satellite imagery background */}
        <img
          src={tileUrl}
          alt="Aerial imagery"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ opacity: 0.85 }}
          draggable={false}
          onError={(e) => {
            // Fallback to grey if tile fails
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
        <div className="absolute inset-0 bg-background/10" />

        <svg
          ref={svgRef}
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className="absolute inset-0 h-full w-full cursor-crosshair"
          onClick={handleSvgClick}
          onMouseMove={handleSvgMouseMove}
          onMouseUp={handleSvgMouseUp}
          onMouseLeave={handleSvgMouseUp}
        >
          {/* Original footprint layer */}
          {layers.footprint && footprintPath && (
            <path
              d={footprintPath}
              fill="none"
              stroke="hsl(var(--muted-foreground))"
              strokeWidth="1.5"
              strokeDasharray="6 3"
              opacity={0.7}
              pointerEvents="none"
            />
          )}

          {/* Expanded roof polygon layer */}
          {layers.expanded && expandedPath && (
            <path
              d={expandedPath}
              fill="hsla(200, 80%, 55%, 0.08)"
              stroke="hsl(200, 80%, 55%)"
              strokeWidth="1.5"
              strokeDasharray="4 2"
              opacity={0.8}
              pointerEvents="none"
            />
          )}

          {/* Suggested outline layer */}
          {layers.suggested && suggestedPath && (
            <path
              d={suggestedPath}
              fill="hsla(45, 90%, 55%, 0.1)"
              stroke="hsl(45, 90%, 55%)"
              strokeWidth="2"
              strokeDasharray="8 4"
              opacity={0.8}
              pointerEvents="none"
            />
          )}

          {/* User-drawn polygon */}
          {layers.userDrawn && userPath && (
            <path
              d={userPath}
              fill="hsl(var(--primary) / 0.15)"
              stroke="hsl(var(--primary))"
              strokeWidth="2.5"
              pointerEvents="none"
            />
          )}

          {/* Edge lines between consecutive user points (while drawing) */}
          {layers.userDrawn &&
            points.length >= 2 &&
            points.map(([lng, lat], i) => {
              if (i === 0) return null;
              const [x1, y1] = toSvg(points[i - 1][0], points[i - 1][1]);
              const [x2, y2] = toSvg(lng, lat);
              return (
                <line
                  key={`edge-${i}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="hsl(var(--primary))"
                  strokeWidth="2"
                  opacity={0.5}
                  pointerEvents="none"
                />
              );
            })}

          {/* User-drawn vertices */}
          {layers.userDrawn &&
            points.map(([lng, lat], i) => {
              const [x, y] = toSvg(lng, lat);
              return (
                <g key={`v-${i}`}>
                  {/* Larger invisible hit target */}
                  <circle
                    cx={x}
                    cy={y}
                    r={14}
                    fill="transparent"
                    className="cursor-grab"
                    onMouseDown={(e) => handleVertexMouseDown(i, e)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      deleteVertex(i);
                    }}
                  />
                  {/* Visible vertex */}
                  <circle
                    cx={x}
                    cy={y}
                    r={dragIndex === i ? 7 : 5}
                    fill="hsl(var(--primary))"
                    stroke="hsl(var(--primary-foreground))"
                    strokeWidth={2}
                    className="pointer-events-none"
                  />
                  {/* Index label */}
                  <text
                    x={x}
                    y={y - 10}
                    textAnchor="middle"
                    fill="hsl(var(--primary-foreground))"
                    fontSize="9"
                    fontWeight="bold"
                    className="pointer-events-none select-none"
                    style={{ textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}
                  >
                    {i + 1}
                  </text>
                </g>
              );
            })}
        </svg>

        {/* Empty state */}
        {points.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-background/80 rounded-md px-4 py-2 text-sm text-muted-foreground">
              Click to place points around the visible roof drip edge
            </div>
          </div>
        )}
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={undo}
          disabled={history.length === 0}
        >
          <Undo2 className="h-3.5 w-3.5 mr-1" /> Undo
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={clearAll}
          disabled={points.length === 0}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Clear
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={saveOutline}
          disabled={saving || points.length < 3}
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          {saving ? "Saving..." : "Save Authoritative Outline"}
        </Button>
        <span className="text-xs text-muted-foreground ml-auto">
          Drag vertices to adjust · Right-click to delete · {points.length} pts
        </span>
      </div>
    </div>
  );
}

