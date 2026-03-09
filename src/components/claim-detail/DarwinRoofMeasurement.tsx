import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Ruler, Loader2, MapPin, AlertTriangle, CheckCircle2, RefreshCw,
  TriangleAlert, Pencil, Save, X, Home, ArrowUpRight
} from "lucide-react";

interface RoofMeasurement {
  id: string;
  claim_id: string;
  address: string;
  geocoded_lat: number | null;
  geocoded_lng: number | null;
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
  review_required: boolean;
  manually_confirmed: boolean;
  overlay_image_url: string | null;
  raw_geojson: any | null;
  ai_notes: string | null;
  data_sources: string[] | null;
  created_at: string;
  updated_at: string;
}

interface Props {
  claimId: string;
  claim: any;
}

export const DarwinRoofMeasurement = ({ claimId, claim }: Props) => {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [measurement, setMeasurement] = useState<RoofMeasurement | null>(null);
  const [fetchingExisting, setFetchingExisting] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Partial<RoofMeasurement>>({});
  const [error, setError] = useState<string | null>(null);

  // Load existing measurement
  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("claim_roof_measurements")
        .select("*")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (data && data.length > 0) {
        setMeasurement(data[0] as unknown as RoofMeasurement);
      }
      setFetchingExisting(false);
    };
    load();
  }, [claimId]);

  // Pre-fill address from claim
  useEffect(() => {
    if (claim) {
      const parts = [
        claim.property_address,
        claim.property_city,
        claim.property_state,
        claim.property_zip,
      ].filter(Boolean);
      if (parts.length > 0) setAddress(parts.join(", "));
    }
  }, [claim]);

  const runMeasurement = useCallback(async () => {
    if (!address.trim()) {
      toast.error("Enter a property address");
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const { data, error: fnErr } = await supabase.functions.invoke("darwin-roof-measurement", {
        body: { claim_id: claimId, address: address.trim() },
      });

      if (fnErr) throw new Error(fnErr.message);
      if (data?.error) throw new Error(data.error);

      setMeasurement(data.measurement as RoofMeasurement);
      toast.success("Roof measurement estimate generated");
    } catch (err: any) {
      setError(err.message || "Measurement failed");
      toast.error(err.message || "Measurement failed");
    } finally {
      setLoading(false);
    }
  }, [claimId, address]);

  const startEditing = () => {
    if (!measurement) return;
    setEditValues({
      footprint_area_sqft: measurement.footprint_area_sqft,
      estimated_roof_area_sqft: measurement.estimated_roof_area_sqft,
      squares: measurement.squares,
      dominant_pitch: measurement.dominant_pitch,
      ridge_lf: measurement.ridge_lf,
      hip_lf: measurement.hip_lf,
      valley_lf: measurement.valley_lf,
      eave_lf: measurement.eave_lf,
      rake_lf: measurement.rake_lf,
      facet_count: measurement.facet_count,
    });
    setEditing(true);
  };

  const saveEdits = async () => {
    if (!measurement) return;
    const { error: updateErr } = await supabase
      .from("claim_roof_measurements")
      .update({
        ...editValues,
        manually_confirmed: true,
        confirmed_at: new Date().toISOString(),
        review_required: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", measurement.id);

    if (updateErr) {
      toast.error("Failed to save changes");
      return;
    }

    setMeasurement({
      ...measurement,
      ...editValues,
      manually_confirmed: true,
      review_required: false,
    } as RoofMeasurement);
    setEditing(false);
    toast.success("Measurements updated and confirmed");
  };

  const confirmMeasurement = async () => {
    if (!measurement) return;
    const { error: updateErr } = await supabase
      .from("claim_roof_measurements")
      .update({
        manually_confirmed: true,
        confirmed_at: new Date().toISOString(),
        review_required: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", measurement.id);

    if (updateErr) {
      toast.error("Failed to confirm");
      return;
    }

    setMeasurement({ ...measurement, manually_confirmed: true, review_required: false });
    toast.success("Measurement confirmed");
  };

  const confidenceColor = (score: number | null) => {
    if (!score) return "text-muted-foreground";
    if (score >= 60) return "text-green-600";
    if (score >= 35) return "text-yellow-600";
    return "text-red-500";
  };

  const confidenceBadge = (score: number | null) => {
    if (!score) return "outline";
    if (score >= 60) return "default" as const;
    if (score >= 35) return "secondary" as const;
    return "destructive" as const;
  };

  if (fetchingExisting) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
          <span className="text-sm text-muted-foreground">Loading measurements...</span>
        </CardContent>
      </Card>
    );
  }

  const MeasurementField = ({
    label, value, unit, editKey,
  }: {
    label: string; value: number | string | null; unit?: string; editKey?: keyof RoofMeasurement;
  }) => (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      {editing && editKey ? (
        <Input
          type={typeof value === "string" ? "text" : "number"}
          className="w-28 h-7 text-sm text-right"
          value={(editValues as any)[editKey] ?? ""}
          onChange={(e) =>
            setEditValues((prev) => ({
              ...prev,
              [editKey]: typeof value === "string" ? e.target.value : Number(e.target.value),
            }))
          }
        />
      ) : (
        <span className="text-sm font-medium tabular-nums">
          {value != null ? `${value}${unit ? ` ${unit}` : ""}` : "—"}
        </span>
      )}
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Ruler className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Roof Measurement</CardTitle>
          </div>
          {measurement && (
            <div className="flex items-center gap-2">
              {measurement.manually_confirmed ? (
                <Badge variant="default" className="gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Confirmed
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1">
                  <TriangleAlert className="h-3 w-3" /> Estimated
                </Badge>
              )}
            </div>
          )}
        </div>
        <CardDescription>
          Zero-cost roof measurement using public geospatial data + AI estimation
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Address Input */}
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <MapPin className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Enter property address..."
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="pl-9"
              disabled={loading}
            />
          </div>
          <Button onClick={runMeasurement} disabled={loading || !address.trim()}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Measuring...
              </>
            ) : measurement ? (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                Re-measure
              </>
            ) : (
              <>
                <Ruler className="h-4 w-4 mr-2" />
                Measure Roof
              </>
            )}
          </Button>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && (
          <div className="rounded-lg border border-dashed p-6 text-center space-y-2">
            <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
            <p className="text-sm text-muted-foreground">
              Geocoding → Pulling parcel data → Fetching elevation → AI estimation...
            </p>
          </div>
        )}

        {/* Results */}
        {measurement && !loading && (
          <div className="space-y-4">
            {/* Warning Banner */}
            {!measurement.manually_confirmed && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <strong>AI-Estimated Measurements</strong> — These values are generated from public data and AI modeling.
                  They should be verified by field inspection before use in estimates or supplements.
                </AlertDescription>
              </Alert>
            )}

            {/* Confidence & Summary */}
            <div className="flex items-center gap-4 p-3 rounded-lg bg-muted/50">
              <div className="text-center">
                <div className={`text-2xl font-bold tabular-nums ${confidenceColor(measurement.confidence_score)}`}>
                  {measurement.confidence_score ?? 0}%
                </div>
                <div className="text-xs text-muted-foreground">Confidence</div>
              </div>
              <Separator orientation="vertical" className="h-10" />
              <div className="text-center">
                <div className="text-2xl font-bold tabular-nums">
                  {measurement.squares?.toFixed(1) ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">Squares</div>
              </div>
              <Separator orientation="vertical" className="h-10" />
              <div className="text-center">
                <div className="text-2xl font-bold tabular-nums">
                  {measurement.dominant_pitch ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">Pitch</div>
              </div>
              <Separator orientation="vertical" className="h-10" />
              <div className="text-center">
                <div className="text-2xl font-bold tabular-nums">
                  {measurement.facet_count ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">Facets</div>
              </div>
            </div>

            {/* Detail Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-0">
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">Area</h4>
                <MeasurementField label="Footprint Area" value={measurement.footprint_area_sqft} unit="sqft" editKey="footprint_area_sqft" />
                <MeasurementField label="Roof Area (slope-adjusted)" value={measurement.estimated_roof_area_sqft} unit="sqft" editKey="estimated_roof_area_sqft" />
                <MeasurementField label="Squares" value={measurement.squares} editKey="squares" />
                <MeasurementField label="Dominant Pitch" value={measurement.dominant_pitch} editKey="dominant_pitch" />
              </div>
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">Linear</h4>
                <MeasurementField label="Ridge" value={measurement.ridge_lf} unit="LF" editKey="ridge_lf" />
                <MeasurementField label="Hip" value={measurement.hip_lf} unit="LF" editKey="hip_lf" />
                <MeasurementField label="Valley" value={measurement.valley_lf} unit="LF" editKey="valley_lf" />
                <MeasurementField label="Eave" value={measurement.eave_lf} unit="LF" editKey="eave_lf" />
                <MeasurementField label="Rake" value={measurement.rake_lf} unit="LF" editKey="rake_lf" />
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              {editing ? (
                <>
                  <Button size="sm" onClick={saveEdits}>
                    <Save className="h-4 w-4 mr-1" /> Save & Confirm
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                    <X className="h-4 w-4 mr-1" /> Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="outline" onClick={startEditing}>
                    <Pencil className="h-4 w-4 mr-1" /> Edit Measurements
                  </Button>
                  {!measurement.manually_confirmed && (
                    <Button size="sm" onClick={confirmMeasurement}>
                      <CheckCircle2 className="h-4 w-4 mr-1" /> Confirm As-Is
                    </Button>
                  )}
                </>
              )}
            </div>

            {/* AI Notes */}
            {measurement.ai_notes && (
              <div className="text-xs text-muted-foreground p-3 rounded bg-muted/30 border">
                <strong>AI Notes:</strong> {measurement.ai_notes}
              </div>
            )}

            {/* Data Sources */}
            {measurement.data_sources && measurement.data_sources.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {measurement.data_sources.map((s, i) => (
                  <Badge key={i} variant="outline" className="text-xs">
                    {s}
                  </Badge>
                ))}
              </div>
            )}

            {/* Geocode info */}
            {measurement.geocoded_lat && measurement.geocoded_lng && (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {measurement.address} ({measurement.geocoded_lat.toFixed(5)}, {measurement.geocoded_lng.toFixed(5)})
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
