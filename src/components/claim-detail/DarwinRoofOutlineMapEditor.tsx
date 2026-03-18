import { useEffect, useMemo, useRef, useState } from "react";
import Map, { Layer, Source, MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RotateCcw, Save } from "lucide-react";
import "maplibre-gl/dist/maplibre-gl.css";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";

type LngLat = [number, number];

interface Props {
  roofMeasurementId: string;
  suggestedPolygon?: GeoJSON.Polygon | null;
  footprintPolygon?: GeoJSON.Polygon | null;
  roofPolygon?: GeoJSON.Polygon | null;
  userDrawnPolygon?: GeoJSON.Polygon | null;
  selectedFootprintSource?: string | null;
  onSaved?: () => void;
}

function extractRing(geojson: any): LngLat[] {
  if (!geojson?.coordinates?.[0]) return [];
  return geojson.coordinates[0] as LngLat[];
}

function getBoundsFromGeometry(polygons: Array<any | null | undefined>) {
  const coords = polygons
    .flatMap((g) => extractRing(g))
    .filter((p) => Array.isArray(p) && p.length === 2);

  if (coords.length === 0) return null;

  const lngs = coords.map((p) => p[0]);
  const lats = coords.map((p) => p[1]);

  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  const dLng = Math.max(maxLng - minLng, 0.0001);
  const dLat = Math.max(maxLat - minLat, 0.0001);

  return {
    minLng: minLng - dLng * 0.15,
    maxLng: maxLng + dLng * 0.15,
    minLat: minLat - dLat * 0.15,
    maxLat: maxLat + dLat * 0.15,
  };
}

function polygonFeature(geojson: any, id: string) {
  if (!geojson?.coordinates?.[0]) return null;
  return {
    type: "Feature" as const,
    id,
    properties: { layerId: id },
    geometry: geojson,
  };
}

const imageryOnlyStyle = {
  version: 8,
  sources: {
    esri: {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Esri World Imagery",
    },
  },
  layers: [
    {
      id: "esri-world-imagery",
      type: "raster",
      source: "esri",
      minzoom: 0,
      maxzoom: 22,
    },
  ],
};

const footprintFillLayer: any = {
  id: "footprint-fill",
  type: "fill",
  filter: ["==", ["get", "layerId"], "footprint"],
  paint: { "fill-color": "#ef4444", "fill-opacity": 0.08 },
};

const footprintLineLayer: any = {
  id: "footprint-line",
  type: "line",
  filter: ["==", ["get", "layerId"], "footprint"],
  paint: { "line-color": "#ef4444", "line-width": 2 },
};

const roofFillLayer: any = {
  id: "roof-fill",
  type: "fill",
  filter: ["==", ["get", "layerId"], "roof"],
  paint: { "fill-color": "#3b82f6", "fill-opacity": 0.1 },
};

const roofLineLayer: any = {
  id: "roof-line",
  type: "line",
  filter: ["==", ["get", "layerId"], "roof"],
  paint: { "line-color": "#3b82f6", "line-width": 2 },
};

const suggestedFillLayer: any = {
  id: "suggested-fill",
  type: "fill",
  filter: ["==", ["get", "layerId"], "suggested"],
  paint: { "fill-color": "#a855f7", "fill-opacity": 0.08 },
};

const suggestedLineLayer: any = {
  id: "suggested-line",
  type: "line",
  filter: ["==", ["get", "layerId"], "suggested"],
  paint: { "line-color": "#a855f7", "line-width": 2, "line-dasharray": [2, 2] },
};

const drawnFillLayer: any = {
  id: "drawn-fill",
  type: "fill",
  filter: ["==", ["get", "layerId"], "drawn"],
  paint: { "fill-color": "#22c55e", "fill-opacity": 0.14 },
};

const drawnLineLayer: any = {
  id: "drawn-line",
  type: "line",
  filter: ["==", ["get", "layerId"], "drawn"],
  paint: { "line-color": "#22c55e", "line-width": 3 },
};

export function DarwinRoofOutlineMapEditor({
  roofMeasurementId,
  suggestedPolygon,
  footprintPolygon,
  roofPolygon,
  userDrawnPolygon,
  selectedFootprintSource,
  onSaved,
}: Props) {
  const mapRef = useRef<MapRef>(null);
  const drawRef = useRef<MapboxDraw | null>(null);

  const [saving, setSaving] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [currentDrawn, setCurrentDrawn] = useState<any>(userDrawnPolygon ?? null);
  const [showFootprint, setShowFootprint] = useState(true);
  const [showRoof, setShowRoof] = useState(true);
  const [showSuggested, setShowSuggested] = useState(true);
  const [showDrawn, setShowDrawn] = useState(true);

  const bounds = useMemo(() => {
    return getBoundsFromGeometry([
      userDrawnPolygon,
      suggestedPolygon,
      roofPolygon,
      footprintPolygon,
    ]);
  }, [userDrawnPolygon, suggestedPolygon, roofPolygon, footprintPolygon]);

  const overlayFeatures = useMemo(() => {
    return {
      type: "FeatureCollection" as const,
      features: [
        showFootprint ? polygonFeature(footprintPolygon, "footprint") : null,
        showRoof ? polygonFeature(roofPolygon, "roof") : null,
        showSuggested ? polygonFeature(suggestedPolygon, "suggested") : null,
        showDrawn ? polygonFeature(currentDrawn, "drawn") : null,
      ].filter(Boolean),
    };
  }, [
    footprintPolygon,
    roofPolygon,
    suggestedPolygon,
    currentDrawn,
    showFootprint,
    showRoof,
    showSuggested,
    showDrawn,
  ]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !mapLoaded || drawRef.current) return;

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      controls: {
        polygon: true,
        trash: true,
      },
      defaultMode: currentDrawn ? "simple_select" : "draw_polygon",
    });

    drawRef.current = draw;
    map.addControl(draw as any, "top-left");

    if (currentDrawn) {
      draw.add({
        type: "Feature",
        properties: {},
        geometry: currentDrawn,
      } as any);
    }

    const syncDrawn = () => {
      const data = draw.getAll();
      const first = data.features?.[0];
      if (first?.geometry?.type === "Polygon") {
        setCurrentDrawn(first.geometry as GeoJSON.Polygon);
      } else {
        setCurrentDrawn(null);
      }
    };

    map.on("draw.create", syncDrawn);
    map.on("draw.update", syncDrawn);
    map.on("draw.delete", syncDrawn);

    return () => {
      try {
        map.off("draw.create", syncDrawn);
        map.off("draw.update", syncDrawn);
        map.off("draw.delete", syncDrawn);
        map.removeControl(draw as any);
      } catch {
        // ignore cleanup issues
      }
      drawRef.current = null;
    };
  }, [mapLoaded, currentDrawn]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !bounds || !mapLoaded) return;

    map.fitBounds(
      [[bounds.minLng, bounds.minLat], [bounds.maxLng, bounds.maxLat]],
      { padding: 40, duration: 0 }
    );
  }, [bounds, mapLoaded]);

  const resetView = () => {
    const map = mapRef.current?.getMap();
    if (!map || !bounds) return;

    map.fitBounds(
      [[bounds.minLng, bounds.minLat], [bounds.maxLng, bounds.maxLat]],
      { padding: 40, duration: 300 }
    );
  };

  const saveOutline = async () => {
    if (!currentDrawn) {
      toast.error("Draw a roof polygon first");
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke("save-user-roof-outline", {
        body: {
          roof_measurement_id: roofMeasurementId,
          polygon_geojson: currentDrawn,
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

  const initialCenter = bounds
    ? { longitude: (bounds.minLng + bounds.maxLng) / 2, latitude: (bounds.minLat + bounds.maxLat) / 2 }
    : { longitude: -97.5, latitude: 35.5 };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Trace Roof Outline on Aerial Image</h3>
      <p className="text-xs text-muted-foreground">
        Draw directly over the visible roof. This editor uses real map coordinates.
      </p>

      {bounds && (
        <p className="text-[10px] text-muted-foreground font-mono">
          Bounds: lng {bounds.minLng.toFixed(6)} to {bounds.maxLng.toFixed(6)} · lat{" "}
          {bounds.minLat.toFixed(6)} to {bounds.maxLat.toFixed(6)} · source:{" "}
          {selectedFootprintSource || "unknown"}
        </p>
      )}

      {mapError && (
        <p className="text-xs text-destructive">
          Map failed to load: {mapError}
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

      <div className="rounded-lg overflow-hidden border border-border" style={{ height: 500 }}>
        <Map
          ref={mapRef}
          mapLib={maplibregl}
          initialViewState={{
            ...initialCenter,
            zoom: 20,
          }}
          style={{ width: "100%", height: "100%" }}
          mapStyle={imageryOnlyStyle as any}
          onLoad={() => {
            setMapLoaded(true);
            setMapError(null);
          }}
          onError={(e: any) => {
            const msg = e?.error?.message || e?.message || "Map data not available";
            setMapError(String(msg));
          }}
        >
          <Source id="overlays" type="geojson" data={overlayFeatures}>
            <Layer {...footprintFillLayer} />
            <Layer {...footprintLineLayer} />
            <Layer {...roofFillLayer} />
            <Layer {...roofLineLayer} />
            <Layer {...suggestedFillLayer} />
            <Layer {...suggestedLineLayer} />
            <Layer {...drawnFillLayer} />
            <Layer {...drawnLineLayer} />
          </Source>
        </Map>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={resetView}>
          <RotateCcw className="h-3 w-3 mr-1" />
          Reset View
        </Button>
        <Button size="sm" onClick={saveOutline} disabled={saving || !currentDrawn}>
          <Save className="h-3 w-3 mr-1" />
          {saving ? "Saving..." : "Save Roof Outline"}
        </Button>
      </div>
    </div>
  );
}
