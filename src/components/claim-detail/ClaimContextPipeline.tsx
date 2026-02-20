import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Workflow, Loader2, CheckCircle, ArrowRight, Upload, Camera, FileText,
  AlertTriangle, Sparkles, ChevronDown, ChevronRight, Copy
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import type {
  ClaimContext, PhotoFinding, ScopeClassification,
  MeasurementReport, UserOverrides, EstimateResult, PipelineStage
} from "@/types/claimContext";

interface Props {
  claimId: string;
  claim: any;
}

const EMPTY_MEASUREMENT: MeasurementReport = {
  source: null,
  raw_text: null,
  sections: { roof: {}, interior: {}, siding: {}, gutters: {}, openings: {}, notes: null },
};

const DEFAULT_OVERRIDES: UserOverrides = {
  quality_grade: "standard",
  include_op: true,
  tax_rate: 0,
  price_list: null,
};

const STAGES: { key: PipelineStage; label: string; num: number }[] = [
  { key: "ingest", label: "Ingest", num: 1 },
  { key: "extract", label: "Extract & Normalize", num: 2 },
  { key: "classify", label: "Scope Classify", num: 3 },
  { key: "estimate", label: "Estimate", num: 4 },
];

export const ClaimContextPipeline = ({ claimId, claim }: Props) => {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<PipelineStage>("ingest");
  const [loading, setLoading] = useState(false);
  const [pipelineId, setPipelineId] = useState<string | null>(null);

  // Stage 1 - Ingest
  const [description, setDescription] = useState(claim?.loss_description || "");
  const [policyNotes, setPolicyNotes] = useState("");
  const [measurementFile, setMeasurementFile] = useState<File | null>(null);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());
  const [photos, setPhotos] = useState<any[]>([]);
  const [loadingPhotos, setLoadingPhotos] = useState(false);

  // Pipeline state
  const [measurementReport, setMeasurementReport] = useState<MeasurementReport>(EMPTY_MEASUREMENT);
  const [photoFindings, setPhotoFindings] = useState<PhotoFinding[]>([]);
  const [scopeClassification, setScopeClassification] = useState<ScopeClassification | null>(null);
  const [userOverrides, setUserOverrides] = useState<UserOverrides>(DEFAULT_OVERRIDES);
  const [estimateResult, setEstimateResult] = useState<EstimateResult | null>(null);

  // Expanded sections
  const [expandedScopes, setExpandedScopes] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) {
      fetchPhotos();
      setDescription(claim?.loss_description || "");
    }
  }, [open, claimId]);

  const fetchPhotos = async () => {
    setLoadingPhotos(true);
    const { data } = await supabase
      .from("claim_photos")
      .select("id, file_name, file_path, category, description, ai_material_type, ai_condition_rating, ai_analysis_summary")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false });
    setPhotos(data || []);
    if (data && data.length > 0) {
      setSelectedPhotoIds(new Set(data.map((p: any) => p.id)));
    }
    setLoadingPhotos(false);
  };

  const buildClaimContext = (): ClaimContext => ({
    claim_id: claimId,
    description,
    loss_cause: claim?.loss_type || null,
    policy_notes: policyNotes || null,
    photos: photos.filter(p => selectedPhotoIds.has(p.id)).map(p => ({
      id: p.id,
      url: p.file_path,
      caption: p.description || p.category || null,
    })),
    measurement_report: measurementReport,
    photo_findings: photoFindings,
    scope_classification: scopeClassification || { primary_scopes: [], confidence: {}, missing_info: [] },
    user_overrides: userOverrides,
  });

  // ── Stage 1 → 2: Run extraction ──
  const runExtraction = async () => {
    setLoading(true);
    try {
      // Create pipeline record
      const { data: pipeline } = await supabase
        .from("claim_context_pipelines")
        .insert([{ claim_id: claimId, stage: "extract", status: "processing", claim_context: buildClaimContext() as any }])
        .select("id")
        .single();
      if (pipeline) setPipelineId(pipeline.id);

      // 2A: Parse measurement report if provided
      let parsedMeasurement = EMPTY_MEASUREMENT;
      if (measurementFile) {
        const arrayBuffer = await measurementFile.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);
        let base64 = "";
        const chunkSize = 32768;
        for (let i = 0; i < uint8.length; i += chunkSize) {
          base64 += String.fromCharCode.apply(null, Array.from(uint8.slice(i, i + chunkSize)));
        }
        base64 = btoa(base64);

        const { data, error } = await supabase.functions.invoke("claim-context-pipeline", {
          body: { action: "parse_measurement", measurementPdfBase64: base64, measurementPdfName: measurementFile.name },
        });
        if (error) throw error;
        if (data?.measurement_report) {
          parsedMeasurement = {
            source: data.measurement_report.source || "other",
            raw_text: null,
            sections: {
              roof: data.measurement_report.sections?.roof || {},
              interior: data.measurement_report.sections?.interior || {},
              siding: data.measurement_report.sections?.siding || {},
              gutters: data.measurement_report.sections?.gutters || {},
              openings: data.measurement_report.sections?.openings || {},
              notes: data.measurement_report.sections?.notes || null,
            },
          };
        }
        toast.success("Measurement report parsed");
      }
      setMeasurementReport(parsedMeasurement);

      // 2B: Extract photo findings
      const ctx = buildClaimContext();
      ctx.measurement_report = parsedMeasurement;

      const { data: findingsData, error: findingsErr } = await supabase.functions.invoke("claim-context-pipeline", {
        body: { action: "extract_photo_findings", claimContext: ctx },
      });
      if (findingsErr) throw findingsErr;
      const findings = findingsData?.photo_findings || [];
      setPhotoFindings(findings);
      toast.success(`Extracted ${findings.length} damage findings`);

      setStage("classify");
    } catch (err: any) {
      console.error("Extraction error:", err);
      toast.error(err.message || "Extraction failed");
    } finally {
      setLoading(false);
    }
  };

  // ── Stage 3: Classify scope ──
  const runClassification = async () => {
    setLoading(true);
    try {
      const ctx = buildClaimContext();
      const { data, error } = await supabase.functions.invoke("claim-context-pipeline", {
        body: { action: "classify_scope", claimContext: ctx },
      });
      if (error) throw error;
      const classification = data?.scope_classification;
      if (classification) {
        setScopeClassification(classification);
        toast.success(`Scopes identified: ${classification.primary_scopes.join(", ")}`);
      }
      setStage("estimate");
    } catch (err: any) {
      console.error("Classification error:", err);
      toast.error(err.message || "Classification failed");
    } finally {
      setLoading(false);
    }
  };

  // ── Stage 4: Generate estimate ──
  const runEstimate = async () => {
    setLoading(true);
    try {
      const ctx = buildClaimContext();
      const { data, error } = await supabase.functions.invoke("claim-context-pipeline", {
        body: { action: "generate_estimate", claimContext: ctx, pipelineId },
      });
      if (error) throw error;
      if (data?.estimate_result) {
        setEstimateResult(data.estimate_result);
        const totalItems = data.estimate_result.estimate?.reduce((s: number, sc: any) => s + (sc.items?.length || 0), 0) || 0;
        toast.success(`Generated ${totalItems} line items across ${data.estimate_result.estimate?.length || 0} scopes`);
      } else if (data?.error) {
        toast.error(data.error);
      }
    } catch (err: any) {
      console.error("Estimate error:", err);
      toast.error(err.message || "Estimate generation failed");
    } finally {
      setLoading(false);
    }
  };

  const toggleScope = (scope: string) => {
    const next = new Set(expandedScopes);
    next.has(scope) ? next.delete(scope) : next.add(scope);
    setExpandedScopes(next);
  };

  const copyEstimate = () => {
    if (!estimateResult) return;
    const lines = estimateResult.estimate.flatMap(s =>
      s.items.map(i => `${s.scope}\t${i.line_code || ""}\t${i.description}\t${i.qty}\t${i.unit}\t${i.qty_basis}\t${i.assumptions || ""}`)
    );
    navigator.clipboard.writeText(`Scope\tCode\tDescription\tQty\tUnit\tBasis\tAssumptions\n${lines.join("\n")}`);
    toast.success("Estimate copied to clipboard");
  };

  const currentStageIdx = STAGES.findIndex(s => s.key === stage);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Workflow className="h-4 w-4" />
          Context Pipeline
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Workflow className="h-5 w-5 text-primary" />
            Claim Context Pipeline
          </DialogTitle>
        </DialogHeader>

        {/* Stage Indicator */}
        <div className="flex items-center gap-1 px-2">
          {STAGES.map((s, i) => (
            <div key={s.key} className="flex items-center gap-1">
              <Button
                type="button"
                variant={s.key === stage ? "default" : "outline"}
                size="sm"
                onClick={() => i <= currentStageIdx && setStage(s.key)}
                disabled={i > currentStageIdx}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium h-auto ${
                  i < currentStageIdx && s.key !== stage ? "opacity-80" : ""
                }`}
              >
                {i < currentStageIdx ? <CheckCircle className="h-3 w-3" /> : <span>{s.num}</span>}
                {s.label}
              </Button>
              {i < STAGES.length - 1 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
            </div>
          ))}
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-4 p-1">
            {/* ── STAGE 1: INGEST ── */}
            {stage === "ingest" && (
              <div className="space-y-4">
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">Claim Description</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <Textarea
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder="Describe the damage, what happened, and what was affected..."
                      rows={4}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">Carrier / Adjuster Notes (Optional)</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <Textarea
                      value={policyNotes}
                      onChange={e => setPolicyNotes(e.target.value)}
                      placeholder="Any notes from the carrier, adjuster communications, policy details..."
                      rows={3}
                    />
                  </CardContent>
                </Card>

                {/* Photos */}
                <Card>
                  <CardHeader className="py-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Camera className="h-4 w-4" />
                        Photos ({selectedPhotoIds.size} of {photos.length} selected)
                      </CardTitle>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelectedPhotoIds(new Set(photos.map((p: any) => p.id)))}>All</Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSelectedPhotoIds(new Set())}>None</Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {loadingPhotos ? (
                      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading photos...
                      </div>
                    ) : photos.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-2">No photos uploaded. Upload photos in the Photos tab first.</p>
                    ) : (
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-[200px] overflow-y-auto">
                        {photos.map((p: any) => (
                          <div
                            key={p.id}
                            onClick={() => {
                              const next = new Set(selectedPhotoIds);
                              next.has(p.id) ? next.delete(p.id) : next.add(p.id);
                              setSelectedPhotoIds(next);
                            }}
                            className={`flex items-start gap-2 p-2 rounded cursor-pointer text-xs transition-colors ${
                              selectedPhotoIds.has(p.id) ? "bg-primary/10 border border-primary/30" : "bg-muted/50 hover:bg-muted"
                            }`}
                          >
                            <Checkbox checked={selectedPhotoIds.has(p.id)} className="mt-0.5" />
                            <div className="min-w-0">
                              <p className="truncate font-medium">{p.file_name}</p>
                              {p.category && <Badge variant="secondary" className="text-[10px] mt-0.5">{p.category}</Badge>}
                              {p.ai_condition_rating && (
                                <Badge variant={p.ai_condition_rating.toLowerCase().includes("severe") || p.ai_condition_rating.toLowerCase().includes("failed") ? "destructive" : "outline"} className="text-[10px] mt-0.5 ml-1">
                                  {p.ai_condition_rating}
                                </Badge>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Measurement Report */}
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Upload className="h-4 w-4" />
                      Measurement Report PDF (Optional)
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <Input
                      type="file"
                      accept=".pdf"
                      onChange={e => setMeasurementFile(e.target.files?.[0] || null)}
                    />
                    {measurementFile && (
                      <Badge variant="secondary" className="mt-2 gap-1">
                        <FileText className="h-3 w-3" />
                        {measurementFile.name}
                      </Badge>
                    )}
                  </CardContent>
                </Card>

                <Button onClick={runExtraction} disabled={loading || (!description.trim() && selectedPhotoIds.size === 0)} className="w-full gap-2">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Extract & Normalize
                </Button>
              </div>
            )}

            {/* ── STAGE 2: EXTRACT RESULTS ── */}
            {stage === "extract" && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">Processing... Please wait.</p>
              </div>
            )}

            {/* ── STAGE 3: CLASSIFY ── */}
            {stage === "classify" && (
              <div className="space-y-4">
                {/* Photo Findings */}
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">Photo Findings ({photoFindings.length})</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-2">
                    {photoFindings.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No findings extracted. Pipeline will use description and measurements.</p>
                    ) : (
                      photoFindings.map((f, i) => (
                        <div key={i} className="flex items-start gap-2 p-2 rounded bg-muted/50 text-xs">
                          <Badge variant={f.severity === "severe" ? "destructive" : f.severity === "moderate" ? "default" : "secondary"} className="text-[10px] shrink-0">
                            {f.severity}
                          </Badge>
                          <div>
                            <span className="font-medium">{f.area}</span> ({f.scope})
                            <p className="text-muted-foreground">{f.damage} → {f.recommended_action}</p>
                            {f.material && <span className="text-muted-foreground">Material: {f.material}</span>}
                          </div>
                          <span className="ml-auto text-muted-foreground">{(f.confidence * 100).toFixed(0)}%</span>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>

                {/* Measurement Report Summary */}
                {measurementReport.source && (
                  <Card>
                    <CardHeader className="py-3">
                      <CardTitle className="text-sm">Measurement Report ({measurementReport.source})</CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
                        {Object.entries(measurementReport.sections).map(([key, val]) => {
                          if (key === "notes" || !val || typeof val !== "object" || Object.keys(val).length === 0) return null;
                          return (
                            <div key={key} className="p-2 bg-muted/50 rounded">
                              <p className="font-medium capitalize">{key}</p>
                              <p className="text-muted-foreground">{Object.keys(val).length} measurements</p>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* User Overrides */}
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">Estimate Settings</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Quality Grade</Label>
                        <Select value={userOverrides.quality_grade} onValueChange={v => setUserOverrides(p => ({ ...p, quality_grade: v as any }))}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="economy">Economy</SelectItem>
                            <SelectItem value="standard">Standard</SelectItem>
                            <SelectItem value="premium">Premium</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="text-xs">Tax Rate (%)</Label>
                        <Input type="number" className="h-8 text-xs" value={userOverrides.tax_rate} onChange={e => setUserOverrides(p => ({ ...p, tax_rate: parseFloat(e.target.value) || 0 }))} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch checked={userOverrides.include_op} onCheckedChange={v => setUserOverrides(p => ({ ...p, include_op: v }))} />
                      <Label className="text-xs">Include Overhead & Profit (O&P)</Label>
                    </div>
                  </CardContent>
                </Card>

                <Button onClick={runClassification} disabled={loading} className="w-full gap-2">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Classify Scopes & Route
                </Button>
              </div>
            )}

            {/* ── STAGE 4: ESTIMATE ── */}
            {stage === "estimate" && (
              <div className="space-y-4">
                {/* Scope Classification */}
                {scopeClassification && (
                  <Card>
                    <CardHeader className="py-3">
                      <CardTitle className="text-sm">Scope Classification</CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0 space-y-2">
                      <div className="flex flex-wrap gap-2">
                        {scopeClassification.primary_scopes.map(s => (
                          <Badge key={s} className="capitalize">{s}</Badge>
                        ))}
                      </div>
                      <div className="grid grid-cols-4 gap-2 text-xs">
                        {Object.entries(scopeClassification.confidence).map(([k, v]) => (
                          <div key={k} className="text-center">
                            <p className="capitalize font-medium">{k}</p>
                            <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                              <div className="bg-primary h-1.5 rounded-full" style={{ width: `${(v as number) * 100}%` }} />
                            </div>
                            <p className="text-muted-foreground mt-0.5">{((v as number) * 100).toFixed(0)}%</p>
                          </div>
                        ))}
                      </div>
                      {scopeClassification.missing_info.length > 0 && (
                        <div className="flex items-start gap-2 p-2 bg-destructive/10 border border-destructive/30 rounded text-xs">
                          <AlertTriangle className="h-3 w-3 text-destructive mt-0.5 shrink-0" />
                          <div>
                            <p className="font-medium text-destructive">Missing Info:</p>
                            <ul className="list-disc list-inside text-muted-foreground">
                              {scopeClassification.missing_info.map((m, i) => <li key={i}>{m}</li>)}
                            </ul>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Generate / Results */}
                {!estimateResult ? (
                  <Button onClick={runEstimate} disabled={loading} className="w-full gap-2">
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    Generate Estimate
                  </Button>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-semibold text-sm">Estimate Results</h3>
                      <Button variant="outline" size="sm" className="gap-1 h-7 text-xs" onClick={copyEstimate}>
                        <Copy className="h-3 w-3" /> Copy
                      </Button>
                    </div>

                    {estimateResult.estimate.map((scopeBlock, si) => (
                      <Card key={si}>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => toggleScope(scopeBlock.scope)}
                          className="w-full flex items-center justify-between p-3 h-auto hover:bg-muted/30 transition-colors rounded-none"
                        >
                          <div className="flex items-center gap-2">
                            {expandedScopes.has(scopeBlock.scope) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            <span className="font-medium capitalize text-sm">{scopeBlock.scope}</span>
                            <Badge variant="secondary" className="text-[10px]">{scopeBlock.items.length} items</Badge>
                          </div>
                        </Button>
                        {expandedScopes.has(scopeBlock.scope) && (
                          <CardContent className="pt-0">
                            <div className="space-y-1">
                              {/* Header */}
                              <div className="grid grid-cols-12 gap-1 text-[10px] font-medium text-muted-foreground px-1 pb-1 border-b">
                                <div className="col-span-1">Code</div>
                                <div className="col-span-4">Description</div>
                                <div className="col-span-1">Qty</div>
                                <div className="col-span-1">Unit</div>
                                <div className="col-span-1">Basis</div>
                                <div className="col-span-4">Assumptions</div>
                              </div>
                              {scopeBlock.items.map((item, ii) => (
                                <div key={ii} className="grid grid-cols-12 gap-1 text-xs px-1 py-1.5 hover:bg-muted/30 rounded">
                                  <div className="col-span-1 font-mono text-muted-foreground truncate">{item.line_code || "—"}</div>
                                  <div className="col-span-4">{item.description}</div>
                                  <div className="col-span-1 font-medium">{item.qty}</div>
                                  <div className="col-span-1 text-muted-foreground">{item.unit}</div>
                                  <div className="col-span-1">
                                    <Badge variant={item.qty_basis === "measured" ? "default" : "outline"} className="text-[10px]">
                                      {item.qty_basis}
                                    </Badge>
                                  </div>
                                  <div className="col-span-4 text-muted-foreground italic">{item.assumptions || "—"}</div>
                                </div>
                              ))}
                            </div>
                          </CardContent>
                        )}
                      </Card>
                    ))}

                    {/* Missing info & questions */}
                    {estimateResult.missing_info_to_finalize.length > 0 && (
                      <Card className="border-destructive/30 bg-destructive/5">
                        <CardContent className="p-3">
                          <p className="text-xs font-medium flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-destructive" /> Missing Info to Finalize</p>
                          <ul className="list-disc list-inside text-xs text-muted-foreground mt-1">
                            {estimateResult.missing_info_to_finalize.map((m, i) => <li key={i}>{m}</li>)}
                          </ul>
                        </CardContent>
                      </Card>
                    )}

                    {estimateResult.questions_for_user.length > 0 && (
                      <Card className="border-primary/30 bg-primary/5">
                        <CardContent className="p-3">
                          <p className="text-xs font-medium">Questions for You</p>
                          <ul className="list-disc list-inside text-xs text-muted-foreground mt-1">
                            {estimateResult.questions_for_user.map((q, i) => <li key={i}>{q}</li>)}
                          </ul>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};
