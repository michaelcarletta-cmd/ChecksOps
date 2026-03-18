import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Undo2, Trash2, Save } from "lucide-react";

type LngLat = [number, number];

interface Props {
  roofMeasurementId: string;
  geocodedLat: number;
  geocodedLng: number;
  suggestedPolygon?: any | null;
  onSaved?: () => void;
}

export function DarwinRoofOutlineEditor({
  roofMeasurementId,
  geocodedLat,
  geocodedLng,
  suggestedPolygon,
  onSaved,
}: Props) {
  const [points, setPoints] = useState<LngLat[]>(
    suggestedPolygon?.coordinates?.[0]?.slice(0, -1) ?? []
  );
  const [saving, setSaving] = useState(false);

  const closedRing = useMemo(() => {
    if (points.length < 3) return [];
    return [...points, points[0]];
  }, [points]);

  const addPoint = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    const lng = geocodedLng + (x - 0.5) * 0.0012;
    const lat = geocodedLat + (0.5 - y) * 0.0012;
    setPoints((prev) => [...prev, [lng, lat]]);
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

      toast.success("Roof outline saved — authoritative values updated");
      onSaved?.();
    } catch (err: any) {
      toast.error(err.message || "Failed to save roof outline");
    } finally {
      setSaving(false);
    }
  };

  const toSvgPoint = (lng: number, lat: number): [number, number] => {
    const x = ((lng - (geocodedLng - 0.0006)) / 0.0012) * 1000;
    const y = ((geocodedLat + 0.0006 - lat) / 0.0012) * 700;
    return [x, y];
  };

  const pathD =
    closedRing.length >= 4
      ? closedRing
          .map(([lng, lat], i) => {
            const [x, y] = toSvgPoint(lng, lat);
            return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
          })
          .join(" ") + " Z"
      : "";

  return (
    <div className="rounded-md border border-border p-3 space-y-3">
      <div className="font-medium text-sm">Draw Roof Outline</div>
      <div className="text-xs text-muted-foreground">
        Click around the visible outer roof drip edge to define the roof polygon. Save when complete.
      </div>

      <div
        className="relative border border-border rounded-md overflow-hidden cursor-crosshair"
        style={{ width: "100%", height: 420 }}
        onClick={addPoint}
      >
        <div className="absolute inset-0 bg-muted/30" />
        <svg viewBox="0 0 1000 700" className="absolute inset-0 h-full w-full">
          {pathD && (
            <path
              d={pathD}
              fill="hsl(var(--primary) / 0.15)"
              stroke="hsl(var(--primary))"
              strokeWidth="2"
            />
          )}
          {points.map(([lng, lat], i) => {
            const [x, y] = toSvgPoint(lng, lat);
            return (
              <circle
                key={i}
                cx={x}
                cy={y}
                r={5}
                fill="hsl(var(--primary))"
                stroke="hsl(var(--background))"
                strokeWidth={1.5}
              />
            );
          })}
        </svg>
        {points.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm pointer-events-none">
            Click to place points
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={undoLast} disabled={points.length === 0}>
          <Undo2 className="h-3.5 w-3.5 mr-1" /> Undo
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={clearAll} disabled={points.length === 0}>
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Clear
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={saveOutline}
          disabled={saving || points.length < 3}
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          {saving ? "Saving..." : "Save Roof Outline"}
        </Button>
        <span className="text-xs text-muted-foreground ml-auto">
          {points.length} point{points.length !== 1 ? "s" : ""}
        </span>
      </div>
    </div>
  );
}
