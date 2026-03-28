import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import {
  Ruler, Loader2, MapPin, AlertTriangle, CheckCircle2, RefreshCw,
  Lock, Unlock, Pencil, Save, X, Shield, Eye, Layers, Home, Settings2
} from "lucide-react";
import { logAudit } from "@/hooks/useAuditLog";
import { DarwinRoofValidation } from "./DarwinRoofValidation";
import { RoofConfirmationDialog, type ConfirmationLevel, type ConfirmationBasis } from "./RoofConfirmationDialog";
import { DarwinRoofAreaDebug } from "./DarwinRoofAreaDebug";
import { DarwinRoofOutlineStaticEditor } from "./DarwinRoofOutlineStaticEditor";
import {
  BUILDING_FOOTPRINT_REFRESH_STORAGE_KEY,
  buildCentroidBounds,
  haversineDistanceFeet,
  isAiVisionSource,
  type NearbyFootprintRow,
  type PendingFootprintRefresh,
} from "@/lib/buildingFootprints";

type DerivationSource = "geometry" | "ai_estimated" | "user_override";
type FieldAuthority = "geometry_authoritative" | "ai_provisional" | "user_authoritative" | "unknown_insufficient_geometry";
type RoofForm = "gable" | "hip" | "cross_gable" | "complex" | "unknown";
type PitchBand = "flat" | "low" | "moderate" | "steep" | "very_steep" | "unknown";
type PitchType = "band" | "exact";

interface EdgeClassification {
  segment_index: number;
  start: [number, number];
  end: [number, number];
  length_ft: number;
  bearing_deg: number;
  classification: "likely_eave" | "likely_rake" | "unknown";
  classification_reason: string;
}

interface CandidateFootprint {
  polygon: number[][];
  area_sqft: number;
  perimeter_ft: number;
  source: string;
  source_feature_id: string | null;
  imagery_date: string | null;
  geometry_quality_score: number;
}

interface GeometryMetadata {
  source_name: string;
  source_feature_id: string | null;
  retrieval_time: string;
  centroid_offset_ft: number;
  raw_polygon_hash: string;
  vertex_count: number;
}

interface RidgeCandidate {
  length_ft: number;
  bearing_deg: number;
  confidence: number;
  reasoning: string;
}

interface HipValleyCandidate {
  type: "hip" | "valley";
  length_ft: number;
  bearing_deg: number;
  confidence: number;
  reasoning: string;
}

interface RoofEstimate {
  id: string;
  claim_id: string;
  address: string;
  geocoded_lat: number | null;
  geocoded_lng: number | null;
  footprint_area_sqft: number | null;
  roof_planar_area_sqft: number | null;
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
  geometry_quality_score: number | null;
  edge_classifications: EdgeClassification[] | null;
  geometry_metadata: GeometryMetadata | null;
  candidate_footprints: CandidateFootprint[] | null;
  selected_candidate_index: number | null;
  // Phase 2C
  inferred_roof_form: RoofForm | null;
  roof_form_confidence: number | null;
  roof_form_reasoning: string | null;
  dominant_axis_bearing: number | null;
  dominant_axis_length_ft: number | null;
  perpendicular_axis_length_ft: number | null;
  aspect_ratio: number | null;
  ridge_candidates: RidgeCandidate[] | null;
  hip_valley_candidates: HipValleyCandidate[] | null;
  // Phase 2D
  tuning_applied: { key: string; field: string; action: string; before: number; after: number }[] | null;
  pre_tuning_values: Record<string, number> | null;
  // Phase 2F: Vision classifications
  pitch_band: PitchBand | null;
  pitch_type: PitchType | null;
  vision_classifications: any | null;
  suppression_records: { rule: string; field: string; reason: string; action: string; before_confidence: number; after_confidence: number }[] | null;
  // Evidence-based confirmation
  confirmation_level: ConfirmationLevel | null;
  confirmation_basis: ConfirmationBasis | null;
  confirmation_notes: string | null;
  confirmation_strength_score: number | null;
  confirmation_attachments: { name: string; path: string; type: string }[] | null;
  // Phase 3: Roof polygon expansion
  planar_area_gain_sqft: number | null;
  overhang_config: {
    eave_overhang_ft: number;
    rake_overhang_ft: number;
    unknown_overhang_ft: number;
    source: "default" | "user" | "regional";
  } | null;
  roof_polygon_geojson: any | null;
  // Debug: intermediate calculation values
  slope_factor_used: number | null;
  correction_factor_used: number | null;
  // Shape conflict
  roof_shape_conflict: boolean | null;
  roof_shape_conflict_reason: string | null;
  provisional_complexity_uplift_used: number | null;
  shape_conflicted_roof_area_sqft: number | null;
  shape_conflicted_squares: number | null;
  user_drawn_roof_polygon_geojson: any | null;
  // New fields
  suggested_roof_polygon_geojson: any | null;
  suggested_roof_polygon_source: string | null;
  suggested_roof_polygon_confidence: number | null;
  suggested_roof_outline_notes: string | null;
  user_drawn_planar_area_sqft: number | null;
  user_drawn_roof_area_sqft: number | null;
  user_drawn_squares: number | null;
  user_drawn_at: string | null;
  user_drawn_by: string | null;
  roof_mass_count: number | null;
  roof_mass_polygons: any[] | null;
  imagery_analysis: any | null;
  calibration_adjustment_factor: number | null;
  facet_decomposition: {
    facets: {
      id: string;
      label: string;
      area_sqft: number;
      slope_area_sqft: number;
      edges: { type: string; length_ft: number; bearing_deg: number }[];
      pitch: string | null;
      slope_factor: number;
    }[];
    total_eave_lf: number;
    total_rake_lf: number;
    total_ridge_lf: number;
    total_hip_lf: number;
    total_valley_lf: number;
    total_slope_area_sqft: number;
    total_squares: number;
    roof_type_used: string;
    decomposition_notes: string[];
  } | null;
  created_at: string;
  updated_at: string;
}

interface Props {
  claimId: string;
  claim: any;
}

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  geometry: { label: "Geometry", color: "text-green-600" },
  ai_estimated: { label: "AI Est.", color: "text-amber-600" },
  user_override: { label: "Manual", color: "text-blue-600" },
  satellite_imagery: { label: "Satellite", color: "text-purple-600" },
};

const PITCH_BAND_LABELS: Record<PitchBand, string> = {
  flat: "Flat (0-2/12)",
  low: "Low (2-4/12)",
  moderate: "Moderate (5-7/12)",
  steep: "Steep (8-10/12)",
  very_steep: "Very Steep (11+/12)",
  unknown: "Unknown",
};

const AUTHORITY_LABELS: Record<FieldAuthority, { label: string; icon: string; color: string }> = {
  geometry_authoritative: { label: "Geometry Auth.", icon: "📐", color: "text-green-700" },
  ai_provisional: { label: "Provisional", icon: "⏳", color: "text-amber-600" },
  user_authoritative: { label: "User Auth.", icon: "✓", color: "text-blue-700" },
  unknown_insufficient_geometry: { label: "Unknown", icon: "⊘", color: "text-red-500" },
};

const ROOF_FORM_ICONS: Record<RoofForm, string> = {
  gable: "⛺",
  hip: "🏠",
  cross_gable: "✝️",
  complex: "🏗️",
  unknown: "❓",
};

const ROOF_FORM_LABELS: Record<RoofForm, string> = {
  gable: "Gable",
  hip: "Hip",
  cross_gable: "Cross-Gable",
  complex: "Complex",
  unknown: "Unknown",
};

const EDGE_COLORS: Record<string, string> = {
  likely_eave: "bg-blue-500",
  likely_rake: "bg-orange-500",
  unknown: "bg-muted-foreground",
};

const PITCH_SLOPE_FACTORS: Record<string, number> = {
  "2/12": 1.014, "3/12": 1.031, "4/12": 1.054, "5/12": 1.083,
  "6/12": 1.118, "7/12": 1.158, "8/12": 1.202, "9/12": 1.250,
  "10/12": 1.302, "11/12": 1.357, "12/12": 1.414, "14/12": 1.537,
  "16/12": 1.667, "18/12": 1.803,
};

const PITCH_OPTIONS = Object.keys(PITCH_SLOPE_FACTORS);

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

const qualityColor = (score: number) => {
  if (score >= 70) return "text-green-600";
  if (score >= 40) return "text-yellow-600";
  return "text-red-500";
};

export const DarwinRoofEstimate = ({ claimId, claim }: Props) => {
  const [address, setAddress] = useState("");
  const [exactPitch, setExactPitch] = useState<string>("");
  const [roofType, setRoofType] = useState<string>("auto");
  const [showFacetDetail, setShowFacetDetail] = useState(false);
  const [loading, setLoading] = useState(false);
  const [estimate, setEstimate] = useState<RoofEstimate | null>(null);
  const [candidateDebugData, setCandidateDebugData] = useState<any>(null);
  const [fetchingExisting, setFetchingExisting] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState<Partial<RoofEstimate>>({});
  const [error, setError] = useState<string | null>(null);
  const [showEdgeDetail, setShowEdgeDetail] = useState(false);
  const [showRidgeCandidates, setShowRidgeCandidates] = useState(false);
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [footprintTableEmpty, setFootprintTableEmpty] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [refreshAttemptedAfterIngest, setRefreshAttemptedAfterIngest] = useState(false);
  const [autoRefreshHandled, setAutoRefreshHandled] = useState(false);
  const [checkingNearbyFootprints, setCheckingNearbyFootprints] = useState(false);
  const [nearbyDebugRows, setNearbyDebugRows] = useState<NearbyFootprintRow[]>([]);
  const [nearbyDebugError, setNearbyDebugError] = useState<string | null>(null);
  // Auto-unlock if claim has no property address
  const claimHasAddress = !!(claim?.property_address);
  const [lockToClaim, setLockToClaim] = useState(claimHasAddress);
  const [lastAnalysisMode, setLastAnalysisMode] = useState<string | null>(null);

  // Derive claim address for override detection
  const claimAddress = (() => {
    if (!claim) return "";
    return [claim.property_address, claim.property_city, claim.property_state, claim.property_zip]
      .filter(Boolean).join(", ");
  })();

  // Detect if current address differs from claim address
  const normalizeAddr = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "").trim();
  const isAddressOverride = !lockToClaim && normalizeAddr(address) !== normalizeAddr(claimAddress) && normalizeAddr(address).length > 0;

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

    // Check if building_footprints table has data
    const checkFootprints = async () => {
      const { count } = await supabase.from("building_footprints").select("*", { count: "exact", head: true });
      setFootprintTableEmpty(count === 0 || count === null);
    };
    const checkAdmin = async () => {
      const { data: authData } = await supabase.auth.getUser();
      if (!authData.user) return;

      const { data: roles } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", authData.user.id)
        .eq("role", "admin")
        .limit(1);

      setIsAdmin((roles?.length ?? 0) > 0);
    };
    checkFootprints();
    checkAdmin();
  }, [claimId]);

  useEffect(() => {
    if (claim && lockToClaim) {
      const fullClaimAddress = claim.policyholder_address?.trim();
      if (fullClaimAddress) {
        setAddress(fullClaimAddress);
        return;
      }

      const parts = [
        claim.property_address,
        claim.property_city,
        claim.property_state,
        claim.property_zip,
      ].filter(Boolean);

      if (parts.length > 0) setAddress(parts.join(", "));
    }
  }, [claim, lockToClaim]);

  const runEstimate = useCallback(async (candidateIndex?: number, options?: { forceFreshCandidates?: boolean }) => {
    if (!address.trim()) {
      toast.error("Enter a property address");
      return;
    }
    const forceFreshCandidates = options?.forceFreshCandidates === true;
    setLoading(true);
    setError(null);
    if (forceFreshCandidates) {
      setCandidateDebugData(null);
      setRefreshAttemptedAfterIngest(true);
    }

    try {
      const body: Record<string, any> = {
        claim_id: claimId,
        address: address.trim(),
        force_fresh_candidates: forceFreshCandidates,
      };
      if (exactPitch && PITCH_SLOPE_FACTORS[exactPitch]) body.exact_pitch = exactPitch;
      if (roofType && roofType !== "auto") body.roof_type = roofType;
      if (candidateIndex !== undefined && !forceFreshCandidates) body.selected_candidate_index = candidateIndex;

      const { data, error: fnErr } = await supabase.functions.invoke("darwin-roof-measurement", { body });

      if (fnErr) throw new Error(fnErr.message);
      if (data?.error) throw new Error(data.error);

      setEstimate(data.measurement as RoofEstimate);
      setCandidateDebugData({
        candidate_debug: data.candidate_debug ?? [],
        candidate_fetch_summary: data.candidate_fetch_summary ?? null,
      });
      setLastAnalysisMode(data.analysis_mode ?? null);
      const candidateCount = data.candidateCount || 0;
      const modeLabel = data.is_override ? " [EXTERNAL PROPERTY]" : "";
      const roofForm = data.roofFormInferred ? ` — roof form inferred` : "";
      const visionInfo = data.visionClassified
        ? ` — 🛰️ vision classified (pitch band: ${data.visionPitchBand ?? "?"}, ${data.suppressionCount || 0} suppression${data.suppressionCount !== 1 ? "s" : ""})`
        : "";
      const abstentions = data.visionAbstentions?.length > 0 ? ` [abstained: ${data.visionAbstentions.join(", ")}]` : "";
      const fpMsg = data.footprintExtracted
        ? ` — footprint extracted (${candidateCount} candidate${candidateCount > 1 ? "s" : ""})${roofForm}${visionInfo}${abstentions}`
        : ` — no footprint geometry found${visionInfo}`;
      toast.success("Roof estimate generated" + modeLabel + fpMsg);
    } catch (err: any) {
      setError(err.message || "Estimate failed");
      toast.error(err.message || "Estimate failed");
    } finally {
      setLoading(false);
    }
  }, [claimId, address, exactPitch, roofType]);

  useEffect(() => {
    if (fetchingExisting || loading || autoRefreshHandled || !address.trim()) return;

    const raw = window.localStorage.getItem(BUILDING_FOOTPRINT_REFRESH_STORAGE_KEY);
    if (!raw) return;

    try {
      const pending = JSON.parse(raw) as PendingFootprintRefresh;
      const estimateLat = Number(estimate?.geocoded_lat);
      const estimateLng = Number(estimate?.geocoded_lng);
      const claimLat = Number(claim?.latitude);
      const claimLng = Number(claim?.longitude);
      const currentLat = Number.isFinite(estimateLat) ? estimateLat : claimLat;
      const currentLng = Number.isFinite(estimateLng) ? estimateLng : claimLng;
      const addressMatches = pending.address.trim().toLowerCase() === address.trim().toLowerCase();
      const coordsMatch = Number.isFinite(currentLat) && Number.isFinite(currentLng)
        ? haversineDistanceFeet({ lat: currentLat, lng: currentLng }, { lat: pending.lat, lng: pending.lng }) <= Math.max(pending.bboxRadiusFt * 2, 150)
        : false;

      if (!addressMatches && !coordsMatch) return;

      setAutoRefreshHandled(true);
      window.localStorage.removeItem(BUILDING_FOOTPRINT_REFRESH_STORAGE_KEY);
      toast.message("Fresh footprint ingest detected — reloading authoritative candidates");
      void runEstimate(undefined, { forceFreshCandidates: true });
    } catch {
      window.localStorage.removeItem(BUILDING_FOOTPRINT_REFRESH_STORAGE_KEY);
    }
  }, [address, autoRefreshHandled, claim?.latitude, claim?.longitude, estimate?.geocoded_lat, estimate?.geocoded_lng, fetchingExisting, loading, runEstimate]);

  const handleCheckNearbyAuthoritativeFootprints = async () => {
    const lat = Number(estimate?.geocoded_lat ?? claim?.latitude);
    const lng = Number(estimate?.geocoded_lng ?? claim?.longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      toast.error("No property coordinates are available yet.");
      return;
    }

    setCheckingNearbyFootprints(true);
    setNearbyDebugError(null);

    try {
      const pendingRaw = window.localStorage.getItem(BUILDING_FOOTPRINT_REFRESH_STORAGE_KEY);
      const pending = pendingRaw ? (JSON.parse(pendingRaw) as PendingFootprintRefresh) : null;
      const radiusFeet = pending?.bboxRadiusFt ?? 250;
      const bounds = buildCentroidBounds(lat, lng, radiusFeet);

      const { data, error: nearbyError } = await supabase
        .from("building_footprints")
        .select("source, source_id, centroid_lat, centroid_lng, area_sqft, vertex_count")
        .gte("centroid_lat", bounds.minLat)
        .lte("centroid_lat", bounds.maxLat)
        .gte("centroid_lng", bounds.minLng)
        .lte("centroid_lng", bounds.maxLng)
        .order("area_sqft", { ascending: false })
        .limit(25);

      if (nearbyError) throw new Error(nearbyError.message);

      const rows = (((data as Omit<NearbyFootprintRow, "distance_ft">[] | null) ?? [])
        .map((row) => ({
          ...row,
          distance_ft: Math.round(
            haversineDistanceFeet(
              { lat, lng },
              { lat: Number(row.centroid_lat), lng: Number(row.centroid_lng) },
            ),
          ),
        }))
        .sort((a, b) => a.distance_ft - b.distance_ft));

      setNearbyDebugRows(rows);
      toast.success(rows.length > 0 ? `Found ${rows.length} nearby authoritative footprint${rows.length === 1 ? "" : "s"}` : "No nearby authoritative footprints found");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load nearby authoritative footprints";
      setNearbyDebugError(message);
      toast.error(message);
    } finally {
      setCheckingNearbyFootprints(false);
    }
  };

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
      }
    }
    if (editValues.dominant_pitch !== estimate.dominant_pitch) {
      updatedSources["dominant_pitch"] = "user_override";
      updatedAuth["dominant_pitch"] = "user_authoritative";
      // If pitch changed and triggered auto-recalc, also mark area fields
      if (PITCH_SLOPE_FACTORS[editValues.dominant_pitch as string]) {
        updatedSources["estimated_roof_area_sqft"] = "user_override";
        updatedAuth["estimated_roof_area_sqft"] = "user_authoritative";
        updatedConf["estimated_roof_area_sqft"] = 85;
        updatedSources["squares"] = "user_override";
        updatedAuth["squares"] = "user_authoritative";
        updatedConf["squares"] = 85;
        updatedConf["dominant_pitch"] = 95;
      }
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
    } as RoofEstimate);
    setEditing(false);
    toast.success("Values saved — open confirmation dialog to authorize for downstream use");
    setConfirmDialogOpen(true);
  };

  const handleConfirmationComplete = (update: {
    confirmation_level: ConfirmationLevel;
    confirmation_basis: ConfirmationBasis;
    confirmation_notes: string | null;
    confirmation_strength_score: number;
    confirmation_attachments: { name: string; path: string; type: string }[] | null;
    manually_confirmed: boolean;
  }) => {
    if (!estimate) return;
    setEstimate({
      ...estimate,
      ...update,
      review_required: false,
    });
  };

  const handleCandidateSelect = (indexStr: string) => {
    const idx = parseInt(indexStr, 10);
    // Log the re-selection audit event client-side
    logAudit({
      action: "update",
      recordType: "roof_footprint_selection",
      recordId: claimId,
      oldValues: {
        selected_candidate_index: estimate?.selected_candidate_index,
      },
      newValues: {
        selected_candidate_index: idx,
      },
      metadata: {
        event: "footprint_candidate_reselected_ui",
        note: "Staff manually re-selected a footprint candidate from UI. Triggering re-estimation with new geometry.",
      },
    });
    runEstimate(idx);
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
    const meta = SOURCE_LABELS[source] ?? { label: source, color: "text-muted-foreground" };
    return (
      <span className={`text-[10px] font-medium ${meta.color} ml-1`}>
        [{meta.label}]
      </span>
    );
  };

  const AuthorityBadge = ({ fieldKey }: { fieldKey: string }) => {
    const auth = getFieldAuthority(fieldKey);
    const meta = AUTHORITY_LABELS[auth] ?? { label: auth, icon: "?", color: "text-muted-foreground" };
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
            {auth === "unknown_insufficient_geometry" && " — geometry insufficient; value is null until confirmed by measurement report or manual entry"}
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

  const ProxyTag = ({ fieldKey }: { fieldKey: string }) => {
    const source = getFieldSource(fieldKey);
    if (source !== "geometry") return null;
    if (!["eave_lf", "rake_lf"].includes(fieldKey)) return null;
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[9px] font-medium text-orange-500 ml-1">[Proxy]</span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs max-w-[200px]">
            Footprint-proxy measurement — derived from perimeter edge classification, not exact roof-edge measurement.
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
        {!editing && <ProxyTag fieldKey={fieldKey} />}
        {!editing && <AuthorityBadge fieldKey={fieldKey} />}
        {!editing && <ConfidencePip fieldKey={fieldKey} />}
      </span>
      {editing && editKey ? (
        editKey === "dominant_pitch" ? (
          <div className="flex items-center gap-1.5">
            <Select
              value={(editValues as any).dominant_pitch ?? ""}
              onValueChange={(pitch) => {
                const slopeFactor = PITCH_SLOPE_FACTORS[pitch];
                const roofPlanar = (editValues as any).roof_planar_area_sqft ?? estimate?.roof_planar_area_sqft ?? (editValues as any).footprint_area_sqft ?? estimate?.footprint_area_sqft;
                if (slopeFactor && roofPlanar) {
                  const newRoofArea = Math.round(roofPlanar * slopeFactor);
                  const newSquares = Math.round((newRoofArea / 100) * 10) / 10;
                  setEditValues((prev) => ({
                    ...prev,
                    dominant_pitch: pitch,
                    estimated_roof_area_sqft: newRoofArea,
                    squares: newSquares,
                  }));
                } else {
                  setEditValues((prev) => ({ ...prev, dominant_pitch: pitch }));
                }
              }}
            >
              <SelectTrigger className="w-28 h-7 text-sm">
                <SelectValue placeholder="Select pitch" />
              </SelectTrigger>
              <SelectContent>
                {PITCH_OPTIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p} ({PITCH_SLOPE_FACTORS[p].toFixed(3)}×)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {PITCH_SLOPE_FACTORS[(editValues as any).dominant_pitch] && (
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                auto-recalc
              </span>
            )}
          </div>
        ) : (
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
        )
      ) : (
        <span className={`text-sm font-medium tabular-nums ${getFieldAuthority(fieldKey) === "unknown_insufficient_geometry" ? "text-muted-foreground italic" : ""}`}>
           {value != null ? `${typeof value === "number" ? (editKey === "squares" ? (value as number).toFixed(1) : Math.round(value as number)) : value}${unit ? ` ${unit}` : ""}` : (
            <span className="text-muted-foreground italic text-xs">Unknown — insufficient geometry</span>
           )}
        </span>
      )}
    </div>
  );

  const hasFootprintGeometry = !!estimate?.footprint_polygon;
  const candidates = (estimate?.candidate_footprints as CandidateFootprint[] | null) || [];
  const edgeClassifications = (estimate?.edge_classifications as EdgeClassification[] | null) || [];
  const geoMeta = estimate?.geometry_metadata as GeometryMetadata | null;
  const ridgeCandidates = (estimate?.ridge_candidates as RidgeCandidate[] | null) || [];
  const hipValleyCandidates = (estimate?.hip_valley_candidates as HipValleyCandidate[] | null) || [];
  const tuningApplied = (estimate?.tuning_applied as { key: string; field: string; action: string; before: number; after: number }[] | null) || [];

  const edgeSummary = edgeClassifications.reduce(
    (acc, e) => {
      acc[e.classification] = (acc[e.classification] || 0) + e.length_ft;
      return acc;
    },
    {} as Record<string, number>,
  );

  const hasSatelliteData = estimate?.data_sources?.some((s: string) => s.toLowerCase().includes("satellite") || s.toLowerCase().includes("vision"));
  const hasSuppressions = (estimate?.suppression_records as any[] | null)?.length ?? 0;
  const pitchBand = estimate?.pitch_band as PitchBand | null;
  const pitchType = (estimate?.pitch_type as PitchType | null) ?? "band";
  const phaseLabel = tuningApplied.length > 0 ? "Phase 2D" : hasSatelliteData ? "Phase 2F 🛰️" : estimate?.inferred_roof_form ? "Phase 2C" : hasFootprintGeometry ? "Phase 2B" : "Preliminary";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Ruler className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Roof Estimate</CardTitle>
            <Badge variant="outline" className="text-[10px] font-normal">
              {phaseLabel}
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
          {estimate?.inferred_roof_form
            ? `Footprint extracted with edge classification and roof form inference (${ROOF_FORM_LABELS[estimate.inferred_roof_form]}). All perimeter-derived values are footprint-proxy estimates.`
            : hasFootprintGeometry
            ? "Footprint extracted from building geometry with edge classification. Perimeter-derived eave/rake values are footprint-proxy estimates."
            : "AI-estimated roof dimensions from public data. All values are preliminary until manually confirmed."}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Empty footprint table warning */}
        {footprintTableEmpty && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Microsoft footprint dataset has not been ingested yet. Darwin is using fallback geometry. 
              <a href="/admin/building-footprints" className="underline ml-1 font-medium">Run ingestion →</a>
            </AlertDescription>
          </Alert>
        )}
        {refreshAttemptedAfterIngest && isAiVisionSource(estimate?.imagery_source) && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>Authoritative footprint data is still not available for this property.</AlertDescription>
          </Alert>
        )}
        {/* Analysis Mode Toggle */}
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border transition-colors ${lockToClaim
              ? "bg-primary/10 border-primary/30 text-primary font-medium"
              : "bg-muted border-border text-muted-foreground hover:bg-accent"
            }`}
            onClick={() => {
              if (!claimHasAddress) return;
              setLockToClaim(true);
              // Reset address to claim address
              if (claimAddress) setAddress(claimAddress);
            }}
            disabled={!claimHasAddress}
          >
            <Lock className="h-3.5 w-3.5" />
            Lock to Claim Property
          </button>
          <button
            type="button"
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border transition-colors ${!lockToClaim
              ? "bg-primary/10 border-primary/30 text-primary font-medium"
              : "bg-muted border-border text-muted-foreground hover:bg-accent"
            }`}
            onClick={() => setLockToClaim(false)}
          >
            <Unlock className="h-3.5 w-3.5" />
            Analyze Different Property
          </button>
          {lastAnalysisMode && (
            <Badge variant={lastAnalysisMode === "EXTERNAL_PROPERTY" ? "destructive" : "secondary"} className="text-xs">
              {lastAnalysisMode === "EXTERNAL_PROPERTY" ? "External" : "Claim-Locked"}
            </Badge>
          )}
        </div>

        {/* Override Warning */}
        {isAddressOverride && (
          <Alert className="border-amber-500/50 bg-amber-500/10">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-700 dark:text-amber-400">
              You are analyzing a different property than the claim. This will not affect the claim unless confirmed.
            </AlertDescription>
          </Alert>
        )}

        {/* Address Input */}
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <MapPin className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={lockToClaim ? "Claim property address" : "Enter external property address..."}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="pl-9"
              disabled={loading || (lockToClaim && claimHasAddress)}
            />
          </div>
          <Select value={roofType} onValueChange={setRoofType}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Roof Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto-detect</SelectItem>
              <SelectItem value="gable">⛺ Gable</SelectItem>
              <SelectItem value="hip">🏠 Hip</SelectItem>
              <SelectItem value="cross_gable">✝️ Cross-Gable</SelectItem>
            </SelectContent>
          </Select>
          <Select value={exactPitch || "auto"} onValueChange={(v) => setExactPitch(v === "auto" ? "" : v)}>
            <SelectTrigger className="w-[120px]">
              <SelectValue placeholder="Pitch" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto-detect</SelectItem>
              {PITCH_OPTIONS.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => runEstimate()} disabled={loading || !address.trim()}>
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

        {isAdmin && (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Admin footprint debug</div>
                <p className="text-xs text-muted-foreground">Run the nearby-area footprint query for the currently viewed property.</p>
              </div>
              <Button variant="outline" size="sm" onClick={handleCheckNearbyAuthoritativeFootprints} disabled={checkingNearbyFootprints}>
                {checkingNearbyFootprints ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Check nearby authoritative footprints
              </Button>
            </div>

            {nearbyDebugError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{nearbyDebugError}</AlertDescription>
              </Alert>
            )}

            {nearbyDebugRows.length > 0 && (
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
                    {nearbyDebugRows.map((row, index) => (
                      <tr key={`${row.source}-${row.source_id ?? index}`} className="border-b last:border-b-0">
                        <td className="p-2">{row.source}</td>
                        <td className="p-2 text-right">{row.distance_ft} ft</td>
                        <td className="p-2 text-right">{row.area_sqft.toLocaleString()}</td>
                        <td className="p-2 text-right">{row.vertex_count ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

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
              Geocoding → Extracting footprints → Classifying edges → Inferring roof form → AI estimation...
            </p>
          </div>
        )}

        {/* Results */}
        {estimate && !loading && (
          <div className="space-y-4">
            {/* No footprint + no imagery warning */}
            {!hasFootprintGeometry && estimate.footprint_area_sqft === 0 && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  <strong>No building footprint or satellite imagery found for this address.</strong>
                  <br />
                  <span className="text-sm text-muted-foreground">
                    The system searched OpenStreetMap, NJGIN, and Esri USA Structures but found no building geometry at this location.
                    Satellite imagery may also be unavailable. You can:
                  </span>
                  <ul className="list-disc list-inside text-sm text-muted-foreground mt-1 space-y-0.5">
                    <li>Verify the address is correct and try again</li>
                    <li>Use "Edit Values" to manually enter measurements from an EagleView or HOVER report</li>
                    <li>Upload a measurement report to auto-populate</li>
                  </ul>
                </AlertDescription>
              </Alert>
            )}
            {/* Confirmation Gate */}
            {!estimate.manually_confirmed && (
              <Alert variant="destructive">
                <Lock className="h-4 w-4" />
                <AlertDescription>
                  <strong>Unconfirmed Estimate — Blocked from Downstream Use</strong>
                  <br />
                  This estimate <em>cannot</em> feed the estimate builder, material calculator, or supplement engine.
                  Review per-field confidence and authority, then choose a confirmation level before production use.
                </AlertDescription>
              </Alert>
            )}
            {estimate.manually_confirmed && estimate.confirmation_level && (
              <Alert>
                <CheckCircle2 className="h-4 w-4" />
                <AlertDescription>
                  <div className="flex items-center justify-between">
                    <div>
                      <strong>Confirmed:</strong>{" "}
                      <span className="capitalize">{estimate.confirmation_level.replace(/_/g, " ")}</span>
                      {estimate.confirmation_basis && (
                        <span className="text-muted-foreground"> — {estimate.confirmation_basis.replace(/_/g, " ")}</span>
                      )}
                    </div>
                    {estimate.confirmation_strength_score != null && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${
                          estimate.confirmation_strength_score >= 70
                            ? "border-green-500/50 text-green-600"
                            : estimate.confirmation_strength_score >= 40
                            ? "border-yellow-500/50 text-yellow-600"
                            : "border-red-500/50 text-red-600"
                        }`}
                      >
                        Strength: {estimate.confirmation_strength_score}/100
                      </Badge>
                    )}
                  </div>
                  {estimate.confirmation_notes && (
                    <p className="text-xs text-muted-foreground mt-1">{estimate.confirmation_notes}</p>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {/* Footprint geometry + quality notice */}
            {hasFootprintGeometry && (
              <Alert>
                <Shield className="h-4 w-4" />
                <AlertDescription>
                  <div className="space-y-1">
                    <div>
                      <strong>Building footprint extracted</strong> from{" "}
                      <span className={
                        (estimate.imagery_source || "").includes("Microsoft") || (estimate.imagery_source || "").includes("Local DB")
                          ? "text-green-600 font-semibold"
                          : (estimate.imagery_source || "").includes("NJGIN")
                            ? "text-blue-600 font-semibold"
                            : (estimate.imagery_source || "").includes("OpenStreetMap")
                              ? "text-orange-600 font-semibold"
                              : (estimate.imagery_source || "").includes("AI Vision")
                                ? "text-red-600 font-semibold"
                                : "font-medium"
                      }>
                        {estimate.imagery_source || "geometry source"}
                      </span>.
                      Footprint area ({estimate.footprint_area_sqft?.toLocaleString()} sqft) and perimeter ({estimate.footprint_perimeter_ft?.toLocaleString()} ft)
                      are geometry-derived. {estimate.imagery_date && `Imagery date: ${estimate.imagery_date}.`}
                    </div>
                    <div className="flex items-center gap-3 text-xs flex-wrap">
                      <span>
                        Geometry Quality:{" "}
                        <strong className={qualityColor(estimate.geometry_quality_score || 0)}>
                          {estimate.geometry_quality_score ?? "—"}/100
                        </strong>
                      </span>
                      {geoMeta && (
                        <>
                          <span>Vertices: {geoMeta.vertex_count}</span>
                          <span>Offset: {geoMeta.centroid_offset_ft} ft</span>
                          <span className="text-muted-foreground">Hash: {geoMeta.raw_polygon_hash}</span>
                        </>
                      )}
                    </div>
                    {/* Source ladder indicator */}
                    <div className="flex items-center gap-1.5 mt-1">
                      {["MS Footprints", "NJGIN", "Esri/MS", "OSM", "AI Vision"].map((src, idx) => {
                        const isActive = 
                          (idx === 0 && ((estimate.imagery_source || "").includes("Local DB") || (estimate.imagery_source || "").includes("Microsoft Building Footprints (Local"))) ||
                          (idx === 1 && (estimate.imagery_source || "").includes("NJGIN")) ||
                          (idx === 2 && (estimate.imagery_source || "").includes("Esri")) ||
                          (idx === 3 && (estimate.imagery_source || "").includes("OpenStreetMap")) ||
                          (idx === 4 && (estimate.imagery_source || "").includes("AI Vision"));
                        return (
                          <span key={src} className={`text-[9px] px-1.5 py-0.5 rounded-full border ${
                            isActive
                              ? "bg-primary/15 border-primary/50 text-primary font-semibold"
                              : "border-muted text-muted-foreground/50"
                          }`}>
                            {isActive ? "●" : "○"} {src}
                          </span>
                        );
                      })}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      ⚠️ Eave and rake values are <strong>footprint-proxy</strong> measurements — they approximate roof edges from perimeter classification but are NOT exact roof-edge measurements.
                    </div>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Phase 2C: Roof Form Inference */}
            {estimate.inferred_roof_form && (
              <div className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Home className="h-4 w-4 text-primary" />
                    Roof Form Inference
                    <Badge variant="outline" className="text-[9px]">Phase 2C</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{ROOF_FORM_ICONS[estimate.inferred_roof_form]}</span>
                    <Badge
                      variant="outline"
                      className={`text-xs ${
                        (estimate.roof_form_confidence ?? 0) >= 45
                          ? "border-green-500/50 text-green-700"
                          : (estimate.roof_form_confidence ?? 0) >= 30
                          ? "border-yellow-500/50 text-yellow-700"
                          : "border-red-500/50 text-red-600"
                      }`}
                    >
                      {ROOF_FORM_LABELS[estimate.inferred_roof_form]} — {estimate.roof_form_confidence}% confidence
                    </Badge>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">{estimate.roof_form_reasoning}</p>

                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <span className="text-muted-foreground">Dominant Axis:</span>{" "}
                    <span className="font-medium tabular-nums">
                      {estimate.dominant_axis_bearing ?? "—"}° / {estimate.dominant_axis_length_ft ?? "—"} ft
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Perp. Axis:</span>{" "}
                    <span className="font-medium tabular-nums">{estimate.perpendicular_axis_length_ft ?? "—"} ft</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Aspect Ratio:</span>{" "}
                    <span className="font-medium tabular-nums">{estimate.aspect_ratio ?? "—"}</span>
                  </div>
                </div>

                {/* Ridge & Hip/Valley candidates */}
                {(ridgeCandidates.length > 0 || hipValleyCandidates.length > 0) && (
                  <div className="mt-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs"
                      onClick={() => setShowRidgeCandidates(!showRidgeCandidates)}
                    >
                      {showRidgeCandidates ? "Hide" : "Show"} {ridgeCandidates.length} ridge + {hipValleyCandidates.length} hip/valley candidate(s)
                    </Button>
                    {showRidgeCandidates && (
                      <div className="mt-2 space-y-2">
                        {ridgeCandidates.length > 0 && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Ridge Candidates</div>
                            {ridgeCandidates.map((r, i) => (
                              <div key={i} className="flex items-center gap-2 text-[11px] text-muted-foreground py-0.5 border-b border-border/50 last:border-0">
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500 shrink-0" />
                                <span className="tabular-nums w-14">{r.length_ft} ft</span>
                                <span className="tabular-nums w-12">{r.bearing_deg}°</span>
                                <span className={`w-10 font-medium ${confidenceDot(r.confidence).replace("bg-", "text-")}`}>
                                  {r.confidence}%
                                </span>
                                <TooltipProvider delayDuration={200}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="truncate cursor-help">{r.reasoning}</span>
                                    </TooltipTrigger>
                                    <TooltipContent className="text-xs max-w-[300px]">{r.reasoning}</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </div>
                            ))}
                          </div>
                        )}
                        {hipValleyCandidates.length > 0 && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Hip/Valley Candidates</div>
                            {hipValleyCandidates.map((hv, i) => (
                              <div key={i} className="flex items-center gap-2 text-[11px] text-muted-foreground py-0.5 border-b border-border/50 last:border-0">
                                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${hv.type === "hip" ? "bg-teal-500" : "bg-rose-500"}`} />
                                <span className="capitalize w-10 font-medium">{hv.type}</span>
                                <span className="tabular-nums w-14">{hv.length_ft} ft</span>
                                <span className="tabular-nums w-12">{hv.bearing_deg}°</span>
                                <span className={`w-10 font-medium ${confidenceDot(hv.confidence).replace("bg-", "text-")}`}>
                                  {hv.confidence}%
                                </span>
                                <TooltipProvider delayDuration={200}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="truncate cursor-help">{hv.reasoning}</span>
                                    </TooltipTrigger>
                                    <TooltipContent className="text-xs max-w-[300px]">{hv.reasoning}</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Phase 2D: Tuning Applied Indicator */}
            {tuningApplied.length > 0 && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Settings2 className="h-4 w-4 text-primary" />
                  Tuning Applied
                  <Badge variant="outline" className="text-[9px]">Phase 2D</Badge>
                  <Badge variant="secondary" className="text-[9px]">{tuningApplied.length} adjustment{tuningApplied.length > 1 ? "s" : ""}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Values below have been adjusted by validation-derived tuning heuristics to correct known biases.
                </p>
                <div className="space-y-0.5">
                  {tuningApplied.map((t, i) => (
                    <div key={i} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                      <span className="font-medium capitalize">{t.field.replace(/_/g, " ")}</span>
                      <span className="tabular-nums">{t.before} → {t.after}</span>
                      <span className="text-[10px]">({t.action})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Candidate Footprint Selector */}
            {candidates.length > 1 && (
              <div className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Layers className="h-4 w-4 text-primary" />
                  {candidates.length} Candidate Footprints Found
                </div>
                <p className="text-xs text-muted-foreground">
                  Multiple building footprints were found from different sources. Selecting a different candidate will re-run the estimate and change all downstream geometry-derived values. This action is audit-logged.
                </p>
                <div className="flex gap-2 items-end">
                  <Select
                    defaultValue={String(estimate.selected_candidate_index ?? 0)}
                    onValueChange={handleCandidateSelect}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select footprint source" />
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((c, i) => (
                        <SelectItem key={i} value={String(i)}>
                          <span className="flex items-center gap-2">
                            <span className={`inline-block w-2 h-2 rounded-full ${c.geometry_quality_score >= 70 ? "bg-green-500" : c.geometry_quality_score >= 40 ? "bg-yellow-500" : "bg-red-500"}`} />
                            {c.source} — {c.area_sqft.toLocaleString()} sqft, Q:{c.geometry_quality_score}
                            {i === (estimate.selected_candidate_index ?? 0) && " ✓"}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Edge Classification Summary */}
            {edgeClassifications.length > 0 && (
              <div className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Eye className="h-4 w-4 text-primary" />
                    Edge Classification
                    <Badge variant="outline" className="text-[9px]">Footprint-Proxy</Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    onClick={() => setShowEdgeDetail(!showEdgeDetail)}
                  >
                    {showEdgeDetail ? "Hide Segments" : `Show ${edgeClassifications.length} Segments`}
                  </Button>
                </div>
                <div className="flex gap-4 text-xs">
                  {Object.entries(edgeSummary).map(([cls, totalLf]) => (
                    <div key={cls} className="flex items-center gap-1.5">
                      <span className={`inline-block w-2 h-2 rounded-full ${EDGE_COLORS[cls] || "bg-muted-foreground"}`} />
                      <span className="capitalize">{cls.replace("likely_", "").replace("_", " ")}:</span>
                      <span className="font-medium tabular-nums">{Math.round(totalLf)} LF</span>
                    </div>
                  ))}
                </div>
                {showEdgeDetail && (
                  <div className="max-h-40 overflow-y-auto mt-2 space-y-1">
                    {edgeClassifications.map((e) => (
                      <div key={e.segment_index} className="flex items-center gap-2 text-[11px] text-muted-foreground py-0.5 border-b border-border/50 last:border-0">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${EDGE_COLORS[e.classification]}`} />
                        <span className="tabular-nums w-8">#{e.segment_index}</span>
                        <span className="tabular-nums w-14">{e.length_ft} ft</span>
                        <span className="tabular-nums w-12">{e.bearing_deg}°</span>
                        <span className="capitalize font-medium w-16">{e.classification.replace("likely_", "")}</span>
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="truncate cursor-help">{e.classification_reason}</span>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs max-w-[300px]">{e.classification_reason}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                    ))}
                  </div>
                )}
              </div>
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
              {estimate.inferred_roof_form && estimate.inferred_roof_form !== "unknown" && (
                <>
                  <Separator orientation="vertical" className="h-10" />
                  <div className="text-center">
                    <div className="text-2xl font-bold">
                      {ROOF_FORM_ICONS[estimate.inferred_roof_form]}
                    </div>
                    <div className="text-xs text-muted-foreground">{ROOF_FORM_LABELS[estimate.inferred_roof_form]}</div>
                  </div>
                </>
              )}
              {hasFootprintGeometry && (
                <>
                  <Separator orientation="vertical" className="h-10" />
                  <div className="text-center">
                    <div className="text-2xl font-bold tabular-nums text-green-600">
                      {estimate.footprint_perimeter_ft?.toLocaleString() ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">Perimeter ft</div>
                  </div>
                  <Separator orientation="vertical" className="h-10" />
                  <div className="text-center">
                    <div className={`text-2xl font-bold tabular-nums ${qualityColor(estimate.geometry_quality_score || 0)}`}>
                      {estimate.geometry_quality_score ?? "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">Geo Quality</div>
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
              <span className="text-orange-500 font-medium ml-2">[Proxy]</span> = footprint-proxy
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

            {/* Shape Conflict Warning */}
            {estimate.roof_shape_conflict && (
              <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 space-y-2">
                <div className="flex items-center gap-2 font-medium text-sm">
                  <AlertTriangle className="h-4 w-4 text-yellow-600" />
                  Visible roof complexity exceeds selected footprint geometry
                </div>
                <div className="text-sm text-muted-foreground">
                  {estimate.roof_shape_conflict_reason}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-muted-foreground">Base Deterministic Squares</div>
                    <div className="font-medium">{estimate.squares ?? "—"}</div>
                  </div>
                  {estimate.shape_conflicted_squares != null && (
                    <div>
                      <div className="text-muted-foreground">Provisional Complexity-Adjusted Squares</div>
                      <div className="font-medium text-yellow-700">{estimate.shape_conflicted_squares}</div>
                    </div>
                  )}
                </div>
                {estimate.provisional_complexity_uplift_used != null && estimate.provisional_complexity_uplift_used > 1.0 && (
                  <div className="text-xs text-muted-foreground">
                    Uplift factor: ×{estimate.provisional_complexity_uplift_used} applied because visible roof complexity appears greater than the selected footprint.
                    Manual confirmation is still required.
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  Base values are computed from current geometry. Provisional adjusted values are shown
                  only because visible roof complexity appears greater than the selected footprint.
                </div>
                {estimate.candidate_footprints && estimate.candidate_footprints.length > 1 && (
                  <div className="flex gap-2 pt-1">
                    {estimate.candidate_footprints.map((c, i) => (
                      i !== estimate.selected_candidate_index && (
                        <Button key={i} size="sm" variant="outline" className="text-xs" onClick={() => runEstimate(i)}>
                          Try {c.source} (Q:{c.geometry_quality_score})
                        </Button>
                      )
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* User-Drawn Authoritative Roof Outline */}
            {estimate.user_drawn_squares != null && (
              <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3">
                <div className="font-medium text-sm">User-Drawn Authoritative Roof Outline</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm mt-2">
                  <div>
                    <div className="text-muted-foreground">User-Drawn Planar Area</div>
                    <div className="font-medium">{estimate.user_drawn_planar_area_sqft} sqft</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">User-Drawn Roof Area</div>
                    <div className="font-medium">{estimate.user_drawn_roof_area_sqft} sqft</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">User-Drawn Squares</div>
                    <div className="font-medium">{estimate.user_drawn_squares}</div>
                  </div>
                </div>
              </div>
            )}

            {/* Manual Roof Outline Editor */}
            {(estimate.roof_shape_conflict ||
              (estimate.imagery_source || "").toLowerCase().includes("ai vision") ||
              (estimate.geometry_quality_score ?? 0) < 60) && (
              <DarwinRoofOutlineStaticEditor
                roofMeasurementId={estimate.id}
                geocodedLat={estimate.geocoded_lat}
                geocodedLng={estimate.geocoded_lng}
                suggestedPolygon={estimate.suggested_roof_polygon_geojson}
                footprintPolygon={
                  estimate.footprint_polygon ??
                  estimate.candidate_footprints?.[estimate.selected_candidate_index ?? 0]?.polygon ??
                  null
                }
                roofPolygon={estimate.roof_polygon_geojson}
                userDrawnPolygon={estimate.user_drawn_roof_polygon_geojson}
                selectedFootprintSource={
                  estimate.imagery_source ??
                  estimate.candidate_footprints?.[estimate.selected_candidate_index ?? 0]?.source ??
                  null
                }
                onSaved={() => runEstimate(estimate.selected_candidate_index ?? undefined)}
              />
            )}

            {/* Facet Decomposition */}
            {estimate.facet_decomposition && (
              <div className="rounded-lg border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Layers className="h-4 w-4 text-primary" />
                    Facet Decomposition
                    <Badge variant="outline" className="text-[9px]">
                      {estimate.facet_decomposition.roof_type_used}
                    </Badge>
                    <Badge variant="secondary" className="text-[9px]">
                      {estimate.facet_decomposition.facets.length} facet{estimate.facet_decomposition.facets.length !== 1 ? "s" : ""}
                    </Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    onClick={() => setShowFacetDetail(!showFacetDetail)}
                  >
                    {showFacetDetail ? "Hide Facets" : "Show Facets"}
                  </Button>
                </div>

                {/* Facet totals summary */}
                <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-xs">
                  <div className="text-center p-2 rounded bg-muted/50">
                    <div className="font-bold tabular-nums">{Math.round(estimate.facet_decomposition.total_slope_area_sqft)}</div>
                    <div className="text-muted-foreground">Total Area sqft</div>
                  </div>
                  <div className="text-center p-2 rounded bg-muted/50">
                    <div className="font-bold tabular-nums">{estimate.facet_decomposition.total_squares.toFixed(1)}</div>
                    <div className="text-muted-foreground">Squares</div>
                  </div>
                  <div className="text-center p-2 rounded bg-blue-500/10">
                    <div className="font-bold tabular-nums">{Math.round(estimate.facet_decomposition.total_eave_lf)}</div>
                    <div className="text-muted-foreground">Eave LF</div>
                  </div>
                  <div className="text-center p-2 rounded bg-orange-500/10">
                    <div className="font-bold tabular-nums">{Math.round(estimate.facet_decomposition.total_rake_lf)}</div>
                    <div className="text-muted-foreground">Rake LF</div>
                  </div>
                  <div className="text-center p-2 rounded bg-purple-500/10">
                    <div className="font-bold tabular-nums">{Math.round(estimate.facet_decomposition.total_ridge_lf)}</div>
                    <div className="text-muted-foreground">Ridge LF</div>
                  </div>
                  <div className="text-center p-2 rounded bg-teal-500/10">
                    <div className="font-bold tabular-nums">{Math.round(estimate.facet_decomposition.total_hip_lf)}</div>
                    <div className="text-muted-foreground">Hip LF</div>
                  </div>
                </div>

                {/* Per-facet detail */}
                {showFacetDetail && (
                  <div className="space-y-2 mt-2">
                    {estimate.facet_decomposition.facets.map((facet) => (
                      <div key={facet.id} className="rounded-md border p-2.5 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium">{facet.label}</span>
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="tabular-nums">{Math.round(facet.slope_area_sqft)} sqft</span>
                            {facet.pitch && <Badge variant="outline" className="text-[9px]">{facet.pitch}</Badge>}
                            <span className="text-[9px]">×{facet.slope_factor.toFixed(3)}</span>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {facet.edges.map((edge, ei) => {
                            const edgeColor = edge.type === "eave" ? "bg-blue-500"
                              : edge.type === "rake" ? "bg-orange-500"
                              : edge.type === "ridge" ? "bg-purple-500"
                              : edge.type === "hip" ? "bg-teal-500"
                              : edge.type === "valley" ? "bg-rose-500"
                              : "bg-muted-foreground";
                            return (
                              <span key={ei} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                <span className={`inline-block w-1.5 h-1.5 rounded-full ${edgeColor}`} />
                                <span className="capitalize">{edge.type}</span>
                                <span className="tabular-nums font-medium">{Math.round(edge.length_ft)} ft</span>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {/* Decomposition notes */}
                    {estimate.facet_decomposition.decomposition_notes.length > 0 && (
                      <div className="text-[10px] text-muted-foreground space-y-0.5 pt-1 border-t">
                        {estimate.facet_decomposition.decomposition_notes.map((note, i) => (
                          <div key={i}>• {note}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Detail Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-0">
              <div>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-1">Area</h4>
                <EstimateField label="Building Footprint" value={estimate.footprint_area_sqft} unit="sqft" editKey="footprint_area_sqft" fieldKey="footprint_area_sqft" />
                <EstimateField label="Roof Planar Area" value={estimate.roof_planar_area_sqft} unit="sqft" editKey="roof_planar_area_sqft" fieldKey="roof_planar_area_sqft" />
                <EstimateField label="Slope-Adjusted Roof Area" value={estimate.estimated_roof_area_sqft} unit="sqft" editKey="estimated_roof_area_sqft" fieldKey="estimated_roof_area_sqft" />
                <EstimateField label="Squares" value={estimate.squares} editKey="squares" fieldKey="squares" />
                {estimate.shape_conflicted_squares != null && (
                  <div className="flex items-center justify-between py-0.5 text-xs">
                    <span className="text-yellow-600 font-medium">Provisional Complexity-Adjusted</span>
                    <span className="font-medium text-yellow-700">{estimate.shape_conflicted_roof_area_sqft?.toLocaleString()} sqft / {estimate.shape_conflicted_squares} sq</span>
                  </div>
                )}
                {estimate.planar_area_gain_sqft != null && estimate.planar_area_gain_sqft > 0 && (
                  <div className="flex items-center justify-between py-0.5 text-xs">
                    <span className="text-muted-foreground">Area Gain From Overhang</span>
                    <span className="font-medium">+{estimate.planar_area_gain_sqft} sqft</span>
                  </div>
                )}
                {estimate.overhang_config && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    Overhang: eave {estimate.overhang_config.eave_overhang_ft}ft, rake {estimate.overhang_config.rake_overhang_ft}ft, unknown {estimate.overhang_config.unknown_overhang_ft}ft ({estimate.overhang_config.source})
                  </div>
                )}
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
                    <Button size="sm" onClick={() => setConfirmDialogOpen(true)}>
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

            {/* Roof Area Debug Panel */}
            <DarwinRoofAreaDebug estimate={estimate} candidateDebugData={candidateDebugData} />

            {/* Benchmarking & Validation */}
            <DarwinRoofValidation claimId={claimId} estimate={estimate} />
          </div>
        )}
      </CardContent>

      {estimate && (
        <RoofConfirmationDialog
          open={confirmDialogOpen}
          onOpenChange={setConfirmDialogOpen}
          estimateId={estimate.id}
          claimId={claimId}
          confidenceScore={estimate.confidence_score}
          onConfirmed={handleConfirmationComplete}
        />
      )}
    </Card>
  );
};

/**
 * Downstream gate: returns confirmed roof estimate data or null.
 * Any estimate builder, material calculator, or supplement engine
 * MUST use this function instead of querying claim_roof_measurements directly.
 *
 * Returns the estimate only if it has been through the evidence-based confirmation flow
 * (manually_confirmed = true). The confirmation_level and confirmation_strength_score
 * are available on the returned object for downstream tools to make risk-aware decisions.
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
