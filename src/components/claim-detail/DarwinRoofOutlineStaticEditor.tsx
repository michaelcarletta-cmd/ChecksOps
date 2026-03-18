import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type LngLat = [number, number];

interface Props {
  roofMeasurementId: string;
  geocodedLat: number;
  geocodedLng: number;
  suggestedPolygon?: any | null;
  footprintPolygon?: any | null;
  roofPolygon?: any | null;
  userDrawnPolygon?: any | null;
  selectedFootprintSource?: string | null;
  onSaved?: () => void;
}

function extractRing(geojson: any): LngLat[] {
  if (!geojson?.coordinates?.[0]) return [];
  return geojson.coordinates[0] as LngLat[];
}

function getBoundsFromGeometry(
  polygons: Array<any | null | undefined>,
  geocodedLat: number,
  geocodedLng: number
) {
  const coords = polygons
    .flatMap((g) => extractRing(g))
    .filter((p) => Array.isArray(p) && p.length === 2);

  if (coords.length === 0) {
    return {
      minLng: geocodedLng - 0.0008,
      maxLng: geocodedLng + 0.0008,
      minLat: geocodedLat - 0.0008,
      maxLat: geocodedLat + 0.0008,
    };
  }

  const lngs = coords.map((p) => p[0]);
  const lats = coords.map((p) => p[1]);

  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  const spanLng = maxLng - minLng;
  const spanLat = maxLat - minLat;
  const minSpan = 0.0016;

  const paddedSpanLng = Math.max(spanLng * 1.36, minSpan);
  const paddedSpanLat = Math.max(spanLat * 1.36, minSpan);

  const centerLng = (minLng + maxLng) / 2;
  const centerLat = (minLat + maxLat) / 2;

  return {
    minLng: centerLng - paddedSpanLng / 2,
    maxLng: centerLng + paddedSpanLng / 2,
    minLat: centerLat - paddedSpanLat / 2,
    maxLat: centerLat + paddedSpanLat / 2,
  };
}

function ringToPath(
  ring: LngLat[],
  bounds: { minLng: number; maxLng: number; minLat: number; maxLat: number },
  width: number,
  height: number
) {
  if (!ring || ring.length < 3) return "";
  return (
    ring
      .map(([lng, lat], i) => {
        const x = ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * width;
        const y = ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * height;
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ") + " Z"
  );
}

function svgToLngLat(
  x: number,
  y: number,
  bounds: { minLng: number; maxLng: number; minLat: number; maxLat: number },
  width: number,
  height: number
): LngLat {
  const lng = bounds.minLng + (x / width) * (bounds.maxLng - bounds.minLng);
  const lat = bounds.maxLat - (y / height) * (bounds.maxLat - bounds.minLat);
  return [lng, lat];
}

export function DarwinRoofOutlineStaticEditor({
  roofMeasurementId,
  geocodedLat,
  geocodedLng,
  suggestedPolygon,
  footprintPolygon,
  roofPolygon,
  userDrawnPolygon,
  selectedFootprintSource,
  onSaved,
}: Props) {
  const width = 1000;
  const height = 700;

  const bounds = useMemo(
    () =>
      getBoundsFromGeometry(
        [userDrawnPolygon, suggestedPolygon, roofPolygon, footprintPolygon],
        geocodedLat,
        geocodedLng
      ),
    [userDrawnPolygon, suggestedPolygon, roofPolygon, footprintPolygon, geocodedLat, geocodedLng]
  );

  const initialPoints = useMemo(() => {
    const user = extractRing(userDrawnPolygon).slice(0, -1);
    if (user.length > 0) return user;
    const suggested = extractRing(suggestedPolygon).slice(0, -1);
    if (suggested.length > 0) return suggested;
    return [];
  }, [userDrawnPolygon, suggestedPolygon]);

  const [points, setPoints] = useState<LngLat[]>(initialPoints);
  const [saving, setSaving] = useState(false);
  const [loadingImage, setLoadingImage] = useState(true);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);

  const [showFootprint, setShowFootprint] = useState(true);
  const [showRoof, setShowRoof] = useState(true);
  const [showSuggested, setShowSuggested] = useState(true);
  const [showDrawn, setShowDrawn] = useState(true);

  const closedRing = useMemo(() => {
    if (points.length < 3) return [];
    return [...points, points[0]];
  }, [points]);

  useEffect(() => {
    let cancelled = false;

    const extractInvokeErrorMessage = (error: any) => {
      const context = error?.context;
      if (typeof context === "string" && context.trim().length > 0) {
        try {
          const parsed = JSON.parse(context);
          if (parsed?.error) return String(parsed.error);
          return context;
        } catch {
          return context;
        }
      }
      return error?.message || "Failed to load aerial image";
    };

    const loadImage = async () => {
      setLoadingImage(true);
      setImageError(null);
      setImageDataUrl(null);

      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Aerial image request timed out")), 15000)
        );

        const invokePromise = supabase.functions.invoke("fetch-aerial-image", {
          body: {
            minLng: bounds.minLng,
            minLat: bounds.minLat,
            maxLng: bounds.maxLng,
            maxLat: bounds.maxLat,
            width: 900,
            height: 650,
          },
        });

        const result: any = await Promise.race([invokePromise, timeoutPromise]);

        if (result?.error) {
          throw new Error(extractInvokeErrorMessage(result.error));
        }
        if (result?.data?.error) throw new Error(result.data.error);
        if (!result?.data?.data_url) throw new Error("No aerial image returned");

        if (!cancelled) {
          setImageDataUrl(result.data.data_url);
        }
      } catch (err: any) {
        if (!cancelled) {
          setImageError(err?.message || "Failed to load aerial image");
        }
      } finally {
        if (!cancelled) {
          setLoadingImage(false);
        }
      }
    };

    loadImage();

    return () => {
      cancelled = true;
    };
  }, [bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat]);

  const addPoint = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width;
    const y = ((e.clientY - rect.top) / rect.height) * height;
    const ll = svgToLngLat(x, y, bounds, width, height);
    setPoints((prev) => [...prev, ll]);
  };

  const undoLast = () => setPoints((prev) => prev.slice(0, -1));
  const clearAll = () => setPoints([]);

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

      toast.success("Roof outline saved");
      onSaved?.();
    } catch (err: any) {
      toast.error(err.message || "Failed to save roof outline");
    } finally {
      setSaving(false);
    }
  };

  const footprintPath = showFootprint
    ? ringToPath(extractRing(footprintPolygon), bounds, width, height)
    : "";
  const roofPath = showRoof
    ? ringToPath(extractRing(roofPolygon), bounds, width, height)
    : "";
  const suggestedPath = showSuggested
    ? ringToPath(extractRing(suggestedPolygon), bounds, width, height)
    : "";
  const drawnPath = showDrawn ? ringToPath(closedRing, bounds, width, height) : "";

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Trace Roof Outline on Aerial Image</h3>
      <p className="text-xs text-muted-foreground">
        Static aerial editor. Same geographic bounds are used for image, overlays, and clicks.
      </p>

      <p className="text-[10px] text-muted-foreground font-mono">
        Bounds: lng {bounds.minLng.toFixed(6)} to {bounds.maxLng.toFixed(6)} · lat{" "}
        {bounds.minLat.toFixed(6)} to {bounds.maxLat.toFixed(6)} · source:{" "}
        {selectedFootprintSource || "unknown"}
      </p>
      <div className="text-xs text-muted-foreground">
        Image request size: 900 × 650
      </div>

      {imageError && (
        <p className="text-xs text-destructive">
          Failed to load aerial image: {imageError}
        </p>
      )}

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showFootprint} onChange={(e) => setShowFootprint(e.target.checked)} />
          <span className="text-red-500">■</span> Footprint
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showRoof} onChange={(e) => setShowRoof(e.target.checked)} />
          <span className="text-blue-500">■</span> Roof Polygon
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showSuggested} onChange={(e) => setShowSuggested(e.target.checked)} />
          <span className="text-purple-500">■</span> Suggested
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showDrawn} onChange={(e) => setShowDrawn(e.target.checked)} />
          <span className="text-green-500">■</span> Drawn
        </label>
      </div>

      <div className="rounded-lg overflow-hidden border border-border relative" style={{ aspectRatio: `${width}/${height}` }}>
        {loadingImage && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/50 z-10">
            <span className="text-xs text-muted-foreground">Loading aerial imagery...</span>
          </div>
        )}

        {imageDataUrl && (
          <img src={imageDataUrl} alt="Aerial imagery" className="absolute inset-0 w-full h-full object-cover" />
        )}

        {imageError && !loadingImage && (
          <div className="absolute inset-0 grid place-items-center text-sm text-red-400 bg-black/10">
            Failed to load aerial imagery: {imageError}
          </div>
        )}

        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="absolute inset-0 w-full h-full cursor-crosshair"
          onClick={addPoint}
        >
          {roofPath && <path d={roofPath} fill="rgba(59,130,246,0.10)" stroke="#3b82f6" strokeWidth="2" />}
          {footprintPath && <path d={footprintPath} fill="rgba(239,68,68,0.08)" stroke="#ef4444" strokeWidth="2" />}
          {suggestedPath && <path d={suggestedPath} fill="rgba(168,85,247,0.08)" stroke="#a855f7" strokeWidth="2" strokeDasharray="6 4" />}
          {drawnPath && <path d={drawnPath} fill="rgba(34,197,94,0.14)" stroke="#22c55e" strokeWidth="3" />}

          {points.map(([lng, lat], i) => {
            const x = ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * width;
            const y = ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * height;
            return <circle key={i} cx={x} cy={y} r={5} fill="#22c55e" stroke="#fff" strokeWidth={2} />;
          })}
        </svg>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={undoLast} disabled={points.length === 0}>
          Undo
        </Button>
        <Button variant="outline" size="sm" onClick={clearAll} disabled={points.length === 0}>
          Clear
        </Button>
        <Button size="sm" onClick={saveOutline} disabled={saving || closedRing.length < 4}>
          {saving ? "Saving..." : "Save Roof Outline"}
        </Button>
        <span className="text-xs text-muted-foreground ml-2">
          {points.length} point{points.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}
