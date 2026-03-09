import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  Ruler, Loader2, MapPin, AlertTriangle, CheckCircle2, RefreshCw,
  Lock, Unlock, Pencil, Save, X, Shield, Eye
} from "lucide-react";

type DerivationSource = "geometry" | "ai_estimated" | "user_override";
type FieldAuthority = "geometry_authoritative" | "ai_provisional" | "user_authoritative";

interface RoofEstimate {
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
  field_sources: Record<string, DerivationSource> | null;
  field_confidence: Record<string, number> | null;
  field_authority: Record<string, FieldAuthority> | null;
  footprint_polygon: any | null;
  footprint_perimeter_ft: number | null;
  imagery_source: string | null;
  imagery_date: string | null;
  created_at: string;
  updated_at: string;
}

interface Props {
  claimId: string;
  claim: any;
}

const SOURCE_LABELS: Record<DerivationSource, { label: string; color: string }> = {
  geometry: { label: "Geometry", color: "text-green-600" },
  ai_estimated: { label: "AI Est.", color: "text-amber-600" },
  user_override: { label: "Manual", color: "text-blue-600" },
};

const AUTHORITY_LABELS: Record<FieldAuthority, { label: string; icon: string; color: string }> = {
  geometry_authoritative: { label: "Geometry Auth.", icon: "📐", color: "text-green-700" },
  ai_provisional: { label: "Provisional", icon: "⏳", color: "text-amber-600" },
  user_authoritative: { label: "User Auth.", icon: "✓", color: "text-blue-700" },
};

const round = (v: number | null | undefined, decimals = 0): number | null => {
  if (v == null || isNaN(v)) return null;
  const factor = 10 ** decimals;
  return Math.round(v * factor) / factor;
};

const confidenceDot = (score: number) => {
  if (score >= 60) return "bg-green-500";
  if (score >= 30) return "bg-yellow-500";
  return "bg-red-500";
};

export const DarwinRoofEstimate = ({ claimId, claim }: Props) => {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [estimate, setEstimate] = useState<RoofEstimate | null>(null);
  const [fetchingExisting, setFetchingExisting] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Partial<RoofEstimate>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("claim_roof_measurements")
        .select("*")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (data && data.length > 0) {
        setEstimate(data[0] as unknown as RoofEstimate);
      }
      setFetchingExisting(false);
    };
    load();
  }, [claimId]);

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

  const runEstimate = useCallback(async () => {
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

      setEstimate(data.measurement as RoofEstimate);
      const fpMsg = data.footprintExtracted
        ? " — building footprint extracted from geometry"
        : " — no footprint geometry found, using AI estimation";
      toast.success("Roof estimate generated" + fpMsg);
    } catch (err: any) {
      setError(err.message || "Estimate failed");
      toast.error(err.message || "Estimate failed");
    } finally {
      setLoading(false);
    }
  }, [claimId, address]);

  const startEditing = () => {
    if (!estimate) return;
    setEditValues({
      footprint_area_sqft: estimate.footprint_area_sqft,
      estimated_roof_area_sqft: estimate.estimated_roof_area_sqft,
      squares: estimate.squares,
      dominant_pitch: estimate.dominant_pitch,
      ridge_lf: estimate.ridge_lf,
      hip_lf: estimate.hip_lf,
      valley_lf: estimate.valley_lf,
      eave_lf: estimate.eave_lf,
      rake_lf: estimate.rake_lf,
      facet_count: estimate.facet_count,
    });
    setEditing(true);
  };

  const saveEdits = async () => {
    if (!estimate) return;

    const existingSources = (estimate.field_sources || {}) as Record<string, DerivationSource>;
    const updatedSources: Record<string, DerivationSource> = { ...existingSources };
    const existingConf = (estimate.field_confidence || {}) as Record<string, number>;
    const updatedConf: Record<string, number> = { ...existingConf };
    const existingAuth = (estimate.field_authority || {}) as Record<string, FieldAuthority>;
    const updatedAuth: Record<string, FieldAuthority> = { ...existingAuth };

    const numericKeys = [
      "footprint_area_sqft", "estimated_roof_area_sqft", "squares",
      "ridge_lf", "hip_lf", "valley_lf", "eave_lf", "rake_lf", "facet_count",
    ];
    for (const key of numericKeys) {
      const oldVal = (estimate as any)[key];
      const newVal = (editValues as any)[key];
      if (newVal !== oldVal) {
        updatedSources[key] = "user_override";
        updatedAuth[key] = "user_authoritative";
        // confidence stays as-is — user authority ≠ automatic 100% confidence
      }
    }
    if (editValues.dominant_pitch !== estimate.dominant_pitch) {
      updatedSources["dominant_pitch"] = "user_override";
      updatedAuth["dominant_pitch"] = "user_authoritative";
    }

    const rounded: Record<string, any> = {};
    for (const key of numericKeys) {
      const v = (editValues as any)[key];
      rounded[key] = key === "squares" ? round(v, 1) : round(v);
    }
    rounded.dominant_pitch = editValues.dominant_pitch;

    const { error: updateErr } = await supabase
      .from("claim_roof_measurements")
      .update({
        ...rounded,
        field_sources: updatedSources,
        field_confidence: updatedConf,
        field_authority: updatedAuth,
        manually_confirmed: true,
        confirmed_at: new Date().toISOString(),
        review_required: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", estimate.id);

    if (updateErr) {
      toast.error("Failed to save changes");
      return;
    }

    setEstimate({
      ...estimate,
      ...rounded,
      field_sources: updatedSources,
      field_confidence: updatedConf,
      field_authority: updatedAuth,
      manually_confirmed: true,
      review_required: false,
    } as RoofEstimate);
    setEditing(false);
    toast.success("Estimate updated and confirmed for use");
  };

  const confirmEstimate = async () => {
    if (!estimate) return;
    const { error: updateErr } = await supabase
      .from("claim_roof_measurements")
      .update({
        manually_confirmed: true,
        confirmed_at: new Date().toISOString(),
        review_required: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", estimate.id);

    if (updateErr) {
      toast.error("Failed to confirm");
      return;
    }

    setEstimate({ ...estimate, manually_confirmed: true, review_required: false });
    toast.success("Estimate confirmed — now available for downstream workflows");
  };

  const overallConfidenceColor = (score: number | null) => {
    if (!score) return "text-muted-foreground";
    if (score >= 60) return "text-green-600";
    if (score >= 35) return "text-yellow-600";
    return "text-red-500";
  };

  const getFieldSource = (key: string): DerivationSource =>
    (estimate?.field_sources as any)?.[key] ?? "ai_estimated";

  const getFieldConfidence = (key: string): number =>
    (estimate?.field_confidence as any)?.[key] ?? 0;

  const getFieldAuthority = (key: string): FieldAuthority =>
    (estimate?.field_authority as any)?.[key] ?? "ai_provisional";

  if (fetchingExisting) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
          <span className="text-sm text-muted-foreground">Loading roof estimates...</span>
        </CardContent>
      </Card>
    );
  }

  const SourceTag = ({ source }: { source: DerivationSource }) => {
    const meta = SOURCE_LABELS[source];
    return (
      <span className={`text-[10px] font-medium ${meta.color} ml-1`}>
        [{meta.label}]
      </span>
    );
  };

  const AuthorityBadge = ({ fieldKey }: { fieldKey: string }) => {
    const auth = getFieldAuthority(fieldKey);
    const meta = AUTHORITY_LABELS[auth];
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`text-[9px] font-medium ${meta.color} ml-1`}>
              {meta.icon}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Authority: {meta.label}
            {auth === "ai_provisional" && " — requires confirmation"}
            {auth === "geometry_authoritative" && " — derived from building geometry"}
            {auth === "user_authoritative" && " — user-overridden, workflow-authoritative"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  const ConfidencePip = ({ fieldKey }: { fieldKey: string }) => {
    const conf = getFieldConfidence(fieldKey);
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center ml-1.5 gap-0.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${confidenceDot(conf)}`} />
              <span className="text-[9px] tabular-nums text-muted-foreground">{conf}%</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            Field confidence: {conf}%
            {conf < 30 && " — prioritize review"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  const EstimateField = ({
    label, value, unit, editKey, fieldKey,
  }: {
    label: string; value: number | string | null; unit?: string; editKey?: keyof RoofEstimate; fieldKey: string;
  }) => (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-muted-foreground">
        {label}
        {!editing && <SourceTag source={getFieldSource(fieldKey)} />}
        {!editing && <AuthorityBadge fieldKey={fieldKey} />}
        {!editing && <ConfidencePip fieldKey={fieldKey} />}
      </span>
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
          {value != null ? `${typeof value === "number" ? (editKey === "squares" ? (value as number).toFixed(1) : Math.round(value as number)) : value}${unit ? ` ${unit}` : ""}` : "—"}
        </span>
      )}
    </div>
  );

  const hasFootprintGeometry = !!estimate?.footprint_polygon;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Ruler className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Roof Estimate</CardTitle>
            <Badge variant="outline" className="text-[10px] font-normal">
              {hasFootprintGeometry ? "Phase 2A" : "Preliminary"}
            </Badge>
          </div>
          {estimate && (
            <div className="flex items-center gap-2">
              {estimate.manually_confirmed ? (
                <Badge variant="default" className="gap-1">
                  <Unlock className="h-3 w-3" /> Confirmed for Use
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <Lock className="h-3 w-3" /> Unconfirmed — Not for Use
                </Badge>
              )}
            </div>
          )}
        </div>
        <CardDescription>
          {hasFootprintGeometry
            ? "Footprint extracted from building geometry. Pitch and linear estimates are AI-modeled."
            : "AI-estimated roof dimensions from public data. All values are preliminary until manually confirmed."}
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
          <Button onClick={runEstimate} disabled={loading || !address.trim()}>
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Estimating...
              </>
            ) : estimate ? (
              <>
                <RefreshCw className="h-4 w-4 mr-2" />
                Re-estimate
              </>
            ) : (
              <>
                <Ruler className="h-4 w-4 mr-2" />
                Run Estimate
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
              Geocoding → Extracting footprint → Pulling parcel data → Fetching elevation → AI estimation...
            </p>
          </div>
        )}

        {/* Results */}
        {estimate && !loading && (
          <div className="space-y-4">
            {/* Confirmation Gate */}
            {!estimate.manually_confirmed && (
              <Alert variant="destructive">
                <Lock className="h-4 w-4" />
                <AlertDescription>
                  <strong>Unconfirmed Estimate — Blocked from Downstream Use</strong>
                  <br />
                  This estimate <em>cannot</em> feed the estimate builder, material calculator, or supplement engine.
                  Review per-field confidence and authority, then confirm or override values before production use.
                </AlertDescription>
              </Alert>
            )}

            {/* Footprint geometry notice */}
            {hasFootprintGeometry && (
              <Alert>
                <Shield className="h-4 w-4" />
                <AlertDescription>
                  <strong>Building footprint extracted</strong> from {estimate.imagery_source || "geometry source"}.
                  Footprint area ({estimate.footprint_area_sqft?.toLocaleString()} sqft) and perimeter ({estimate.footprint_perimeter_ft?.toLocaleString()} ft)
                  are geometry-derived. {estimate.imagery_date && `Imagery date: ${estimate.imagery_date}.`}
                </AlertDescription>
              </Alert>
            )}

            {/* Confidence & Summary */}
            <div className="flex items-center gap-4 p-3 rounded-lg bg-muted/50">
              <div className="text-center">
                <div className={`text-2xl font-bold tabular-nums ${overallConfidenceColor(estimate.confidence_score)}`}>
                  {estimate.confidence_score ?? 0}%
                </div>
                <div className="text-xs text-muted-foreground">Overall</div>
              </div>
              <Separator orientation="vertical" className="h-10" />
              <div className="text-center">
                <div className="text-2xl font-bold tabular-nums">
                  {estimate.squares != null ? round(estimate.squares, 1) : "—"}
                </div>
                <div className="text-xs text-muted-foreground">Squares</div>
              </div>
              <Separator orientation="vertical" className="h-10" />
              <div className="text-center">
                <div className="text-2xl font-bold tabular-nums">
                  {estimate.dominant_pitch ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">Pitch</div>
              </div>
              <Separator orientation="vertical" className="h-10" />
              <div className="text-center">
                <div className="text-2xl font-bold tabular-nums">
                  {estimate.facet_count ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">Facets</div>
              </div>
              {hasFootprintGeometry && (
                <>
                  <Separator orientation="vertical" className="h-10" />
                  <div className="text-center">
                    <div className="text-2xl font-bold tabular-nums text-green-600">
                      {estimate.footprint_perimeter_ft?.toLocaleString() ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">Perimeter ft</div>
                  </div>
                </>
              )}
            </div>

            {/* Legend */}
            <div className="flex gap-3 text-[10px] text-muted-foreground flex-wrap">
              <span><strong>Source:</strong></span>
              <span className="text-green-600 font-medium">[Geometry]</span> = measured
              <span className="text-amber-600 font-medium ml-2">[AI Est.]</span> = modeled
              <span className="text-blue-600 font-medium ml-2">[Manual]</span> = user-entered
              <span className="ml-3"><strong>Authority:</strong></span>
              <span>📐 Geometry Auth.</span>
              <span>⏳ Provisional</span>
              <span>✓ User Auth.</span>
              <span className="ml-3">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" /> ≥60%
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 ml-1" /> 30-59%
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 ml-1" /> &lt;30% confidence
              </span>
            </div>

            {/* Detail Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-0">
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">Area</h4>
                <EstimateField label="Footprint Area" value={estimate.footprint_area_sqft} unit="sqft" editKey="footprint_area_sqft" fieldKey="footprint_area_sqft" />
                <EstimateField label="Roof Area (slope-adjusted)" value={estimate.estimated_roof_area_sqft} unit="sqft" editKey="estimated_roof_area_sqft" fieldKey="estimated_roof_area_sqft" />
                <EstimateField label="Squares" value={estimate.squares} editKey="squares" fieldKey="squares" />
                <EstimateField label="Dominant Pitch" value={estimate.dominant_pitch} editKey="dominant_pitch" fieldKey="dominant_pitch" />
              </div>
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">Linear</h4>
                <EstimateField label="Ridge" value={estimate.ridge_lf} unit="LF" editKey="ridge_lf" fieldKey="ridge_lf" />
                <EstimateField label="Hip" value={estimate.hip_lf} unit="LF" editKey="hip_lf" fieldKey="hip_lf" />
                <EstimateField label="Valley" value={estimate.valley_lf} unit="LF" editKey="valley_lf" fieldKey="valley_lf" />
                <EstimateField label="Eave" value={estimate.eave_lf} unit="LF" editKey="eave_lf" fieldKey="eave_lf" />
                <EstimateField label="Rake" value={estimate.rake_lf} unit="LF" editKey="rake_lf" fieldKey="rake_lf" />
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
                    <Pencil className="h-4 w-4 mr-1" /> Edit Values
                  </Button>
                  {!estimate.manually_confirmed && (
                    <Button size="sm" onClick={confirmEstimate}>
                      <CheckCircle2 className="h-4 w-4 mr-1" /> Confirm for Use
                    </Button>
                  )}
                </>
              )}
            </div>

            {/* AI Notes */}
            {estimate.ai_notes && (
              <div className="text-xs text-muted-foreground p-3 rounded bg-muted/30 border">
                <strong>AI Methodology:</strong> {estimate.ai_notes}
              </div>
            )}

            {/* Data Sources */}
            {estimate.data_sources && estimate.data_sources.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {estimate.data_sources.map((s, i) => (
                  <Badge key={i} variant="outline" className="text-xs">
                    {s}
                  </Badge>
                ))}
              </div>
            )}

            {/* Geocode info */}
            {estimate.geocoded_lat && estimate.geocoded_lng && (
              <div className="text-xs text-muted-foreground flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {estimate.address} ({estimate.geocoded_lat.toFixed(5)}, {estimate.geocoded_lng.toFixed(5)})
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

/**
 * Downstream gate: returns confirmed roof estimate data or null.
 * Any estimate builder, material calculator, or supplement engine
 * MUST use this function instead of querying claim_roof_measurements directly.
 */
export async function getConfirmedRoofEstimate(claimId: string): Promise<RoofEstimate | null> {
  const { data } = await supabase
    .from("claim_roof_measurements")
    .select("*")
    .eq("claim_id", claimId)
    .eq("manually_confirmed", true)
    .order("created_at", { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return null;
  return data[0] as unknown as RoofEstimate;
}
