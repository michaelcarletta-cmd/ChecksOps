import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BUILDING_FOOTPRINT_REFRESH_STORAGE_KEY,
  type NearbyFootprintRow,
  type PendingFootprintRefresh,
} from "@/lib/buildingFootprints";
import { AlertTriangle, Loader2, MapPin, Radar } from "lucide-react";
import { toast } from "sonner";

interface TargetedDiagnostics {
  address: string | null;
  lat: number;
  lng: number;
  search_radius_ft: number;
  nearby_footprint_count: number;
  nearest_centroid_distance_ft: number | null;
  nearest_candidate: Pick<NearbyFootprintRow, "source" | "area_sqft" | "vertex_count" | "source_id"> | null;
  nearby_rows: NearbyFootprintRow[];
}

interface TargetedIngestResponse {
  inserted_count: number;
  parsed_count: number;
  fetched_count: number;
  skipped_count: number;
  error_count: number;
  errors: string[];
  targeted_diagnostics: TargetedDiagnostics | null;
}

interface Props {
  onComplete?: () => Promise<void> | void;
}

const DEFAULT_TARGET = {
  address: "118 Don Connor Blvd, Jackson, NJ 08527",
  lat: "40.1081531",
  lng: "-74.3485179",
  bboxRadiusFt: "500",
};

export function TargetPropertyIngestPanel({ onComplete }: Props) {
  const [address, setAddress] = useState(DEFAULT_TARGET.address);
  const [lat, setLat] = useState(DEFAULT_TARGET.lat);
  const [lng, setLng] = useState(DEFAULT_TARGET.lng);
  const [bboxRadiusFt, setBboxRadiusFt] = useState(DEFAULT_TARGET.bboxRadiusFt);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TargetedIngestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTargetedIngest = async () => {
    const targetLat = Number(lat);
    const targetLng = Number(lng);
    const radiusFeet = Number(bboxRadiusFt);

    if (!address.trim()) {
      setError("Address is required.");
      return;
    }

    if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) {
      setError("Valid latitude and longitude are required.");
      return;
    }

    if (!Number.isFinite(radiusFeet) || radiusFeet <= 0) {
      setError("BBox radius must be greater than 0 feet.");
      return;
    }

    setRunning(true);
    setError(null);

    try {
      // Auto-detect state from address
      const addrLower = address.toLowerCase();
      const detectedState = addrLower.includes(", pa ") || addrLower.includes(", pa,") || addrLower.includes("pennsylvania") ? "PA" : "NJ";
      
      const { data, error: invokeError } = await supabase.functions.invoke("ingest-building-footprints", {
        body: {
          state: detectedState,
          address: address.trim(),
          target_lat: targetLat,
          target_lng: targetLng,
          bbox_radius_ft: radiusFeet,
          target_limit: 250,
          id_batch_size: 100,
        },
      });

      if (invokeError) throw new Error(invokeError.message);
      if (data?.error) throw new Error(data.error);

      const parsed = data as TargetedIngestResponse;
      setResult(parsed);

      const refreshPayload: PendingFootprintRefresh = {
        address: address.trim(),
        lat: targetLat,
        lng: targetLng,
        bboxRadiusFt: radiusFeet,
        timestamp: new Date().toISOString(),
      };
      window.localStorage.setItem(BUILDING_FOOTPRINT_REFRESH_STORAGE_KEY, JSON.stringify(refreshPayload));

      toast.success(`Targeted ingest complete — inserted ${parsed.inserted_count} row${parsed.inserted_count === 1 ? "" : "s"}`);
      await onComplete?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Targeted ingest failed";
      setError(message);
      toast.error(message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Target Property Ingest</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="target-address">Address</Label>
            <div className="relative">
              <MapPin className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                id="target-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                className="pl-9"
                placeholder="118 Don Connor Blvd, Jackson, NJ 08527"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="target-lat">Latitude</Label>
            <Input id="target-lat" value={lat} onChange={(event) => setLat(event.target.value)} inputMode="decimal" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="target-lng">Longitude</Label>
            <Input id="target-lng" value={lng} onChange={(event) => setLng(event.target.value)} inputMode="decimal" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="target-radius">BBox Radius (feet)</Label>
            <Input id="target-radius" value={bboxRadiusFt} onChange={(event) => setBboxRadiusFt(event.target.value)} inputMode="numeric" />
          </div>

          <div className="flex items-end">
            <Button className="w-full" onClick={runTargetedIngest} disabled={running}>
              {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Radar className="mr-2 h-4 w-4" />}
              Run Target Property Ingest
            </Button>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && (
          <div className="space-y-4 rounded-lg border border-border p-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Nearby footprint count</div>
                <div className="text-xl font-semibold">{result.targeted_diagnostics?.nearby_footprint_count ?? 0}</div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Nearest centroid distance</div>
                <div className="text-xl font-semibold">
                  {result.targeted_diagnostics?.nearest_centroid_distance_ft != null
                    ? `${Math.round(result.targeted_diagnostics.nearest_centroid_distance_ft)} ft`
                    : "—"}
                </div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Nearest source</div>
                <div className="text-sm font-semibold">{result.targeted_diagnostics?.nearest_candidate?.source ?? "—"}</div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs text-muted-foreground">Nearest area / vertices</div>
                <div className="text-sm font-semibold">
                  {result.targeted_diagnostics?.nearest_candidate
                    ? `${result.targeted_diagnostics.nearest_candidate.area_sqft.toLocaleString()} sqft / ${result.targeted_diagnostics.nearest_candidate.vertex_count ?? "—"}`
                    : "—"}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">Fetched: {result.fetched_count}</Badge>
              <Badge variant="secondary">Parsed: {result.parsed_count}</Badge>
              <Badge variant="secondary">Inserted: {result.inserted_count}</Badge>
              <Badge variant="secondary">Skipped: {result.skipped_count}</Badge>
              <Badge variant={result.error_count > 0 ? "destructive" : "secondary"}>Errors: {result.error_count}</Badge>
            </div>

            {result.errors?.length > 0 && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(result.errors, null, 2)}</pre>
                </AlertDescription>
              </Alert>
            )}

            {result.targeted_diagnostics?.nearby_rows?.length ? (
              <div className="overflow-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="p-2 text-left">Source</th>
                      <th className="p-2 text-right">Distance</th>
                      <th className="p-2 text-right">Area</th>
                      <th className="p-2 text-right">Vertices</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.targeted_diagnostics.nearby_rows.map((row, index) => (
                      <tr key={`${row.source}-${row.source_id ?? index}`} className="border-b last:border-b-0">
                        <td className="p-2">{row.source}</td>
                        <td className="p-2 text-right">{Math.round(row.distance_ft)} ft</td>
                        <td className="p-2 text-right">{row.area_sqft.toLocaleString()}</td>
                        <td className="p-2 text-right">{row.vertex_count ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}