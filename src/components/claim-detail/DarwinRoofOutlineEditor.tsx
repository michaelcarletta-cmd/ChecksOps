import { useMemo, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Undo2, Trash2, Save, Eye, EyeOff, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

type LngLat = [number, number];

interface Bounds {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
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

const SVG_W = 1000;
const SVG_H = 700;

function extractRing(geojson: any): LngLat[] | null {
  if (!geojson) return null;
  const coords = geojson?.coordinates?.[0];
  if (!Array.isArray(coords) || coords.length < 3) return null;
  return coords as LngLat[];
}

function getBoundsFromRings(rings: (LngLat[] | null)[]): Bounds | null {
  const pts = rings
    .filter((r): r is LngLat[] => !!r && r.length >= 3)
    .flat()
    .filter((p) => Array.isArray(p) && p.length === 2);

  if (pts.length === 0) return null;

  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);

  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  const dLng = Math.max(maxLng - minLng, 0.0001);
  const dLat = Math.max(maxLat - minLat, 0.0001);

  const padLng = dLng * 0.15;
  const padLat = dLat * 0.15;

  return {
    minLng: minLng - padLng,
    maxLng: maxLng + padLng,
    minLat: minLat - padLat,
    maxLat: maxLat + padLat,
  };
}

function fallbackBounds(lat: number, lng: number): Bounds {
  return {
    minLng: lng - 0.0006,
    maxLng: lng + 0.0006,
    minLat: lat - 0.0006,
    maxLat: lat + 0.0006,
  };
}

function lngLatToSvg(lng: number, lat: number, b: Bounds): [number, number] {
  const x = ((lng - b.minLng) / (b.maxLng - b.minLng)) * SVG_W;
  const y = ((b.maxLat - lat) / (b.maxLat - b.minLat)) * SVG_H;
  return [x, y];
}

function svgToLngLat(sx: number, sy: number, b: Bounds): LngLat {
  const lng = b.minLng + (sx / SVG_W) * (b.maxLng - b.minLng);
  const lat = b.maxLat - (sy / SVG_H) * (b.maxLat - b.minLat);
  return [lng, lat];
}

function buildTileUrl(b: Bounds) {
  const centerLat = (b.minLat + b.maxLat) / 2;
  const centerLng = (b.minLng + b.maxLng) / 2;
  const zoom = 19;
  const n = Math.pow(2, zoom);
  const tileX = Math.floor(((centerLng + 180) / 360) * n);
  const latRad = (centerLat * Math.PI) / 180;
  const tileY = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${tileY}/${tileX}`;
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
  const footprintRing = useMemo(() => extractRing(footprintPolygon), [footprintPolygon]);
  const expandedRing = useMemo(() => extractRing(roofPolygonGeojson), [roofPolygonGeojson]);
  const suggestedRing = useMemo(() => extractRing(suggestedPolygon), [suggestedPolygon]);
  const existingUserRing = useMemo(() => extractRing(userDrawnPolygon), [userDrawnPolygon]);

  const [points, setPoints] = useState<LngLat[]>(() => {
    const ring = existingUserRing ?? suggestedRing;
    if (ring && ring.length >= 3) {
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
  const [viewResetKey, setViewResetKey] = useState(0);

  const [layers, setLayers] = useState({
    footprint: true,
    expanded: true,
    suggested: true,
    userDrawn: true,
  });

  const svgRef = useRef<SVGSVGElement>(null);

  const closedRing = useMemo<LngLat[]>(() => {
    if (points.length < 3) return [];
    return [...points, points[0]];
  }, [points]);

  // Derive bounds from all available geometry, priority: user > suggested > expanded > footprint
  const bounds = useMemo<Bounds>(() => {
    const allRings = [
      existingUserRing,
      suggestedRing,
      expandedRing,
      footprintRing,
      closedRing.length >= 3 ? closedRing : null,
    ];

    return getBoundsFromRings(allRings) ?? fallbackBounds(geocodedLat, geocodedLng);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingUserRing, suggestedRing, expandedRing, footprintRing, closedRing, geocodedLat, geocodedLng, viewResetKey]);

  const tileUrl = useMemo(() => buildTileUrl(bounds), [bounds]);

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

  const toSvg = useCallback(
    (lng: number, lat: number) => lngLatToSvg(lng, lat, bounds),
    [bounds],
  );

  const fromSvg = useCallback(
    (sx: number, sy: number) => svgToLngLat(sx, sy, bounds),
    [bounds],
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

  const handleSvgClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (dragIndex !== null) return;
      const coords = getSvgCoords(e);
      if (!coords) return;
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
            Click to add points on the visible drip edge. Drag vertices to adjust. Right-click a vertex to delete. View is anchored to roof geometry.
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
        <img
          src={tileUrl}
          alt="Aerial imagery"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ opacity: 0.85 }}
          draggable={false}
          onError={(e) => {
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

          {layers.userDrawn && userPath && (
            <path
              d={userPath}
              fill="hsl(var(--primary) / 0.15)"
              stroke="hsl(var(--primary))"
              strokeWidth="2.5"
              pointerEvents="none"
            />
          )}

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

          {layers.userDrawn &&
            points.map(([lng, lat], i) => {
              const [x, y] = toSvg(lng, lat);
              return (
                <g key={`v-${i}`}>
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
                  <circle
                    cx={x}
                    cy={y}
                    r={dragIndex === i ? 7 : 5}
                    fill="hsl(var(--primary))"
                    stroke="hsl(var(--primary-foreground))"
                    strokeWidth={2}
                    className="pointer-events-none"
                  />
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
        <Button type="button" size="sm" variant="outline" onClick={undo} disabled={history.length === 0}>
          <Undo2 className="h-3.5 w-3.5 mr-1" /> Undo
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={clearAll} disabled={points.length === 0}>
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Clear
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setViewResetKey((k) => k + 1)}>
          <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset View
        </Button>
        <Button type="button" size="sm" onClick={saveOutline} disabled={saving || points.length < 3}>
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
