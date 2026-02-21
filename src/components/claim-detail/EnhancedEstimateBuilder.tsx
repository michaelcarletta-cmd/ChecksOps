import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Calculator, Loader2, Sparkles, Plus, Trash2, Copy,
  Camera, FileText, Upload, ChevronDown, ChevronRight,
  AlertTriangle, CheckCircle, ArrowRight
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface EnhancedEstimateBuilderProps {
  claimId: string;
  claim: any;
}

interface LineItem {
  id: string;
  scope: string;
  line_code: string | null;
  description: string;
  unit: string;
  qty: number;
  qty_basis: "measured" | "allowance";
  assumptions: string | null;
  unitPrice?: number;
  total?: number;
}

interface PhotoFinding {
  area: string;
  scope: string;
  material: string | null;
  damage: string;
  severity: "minor" | "moderate" | "severe";
  recommended_action: string;
  confidence: number;
}

interface ScopeClassification {
  primary_scopes: string[];
  confidence: Record<string, number>;
  missing_info: string[];
}

interface EstimateScope {
  scope: string;
  items: Array<{
    line_code: string | null;
    description: string;
    unit: string;
    qty: number;
    qty_basis: "measured" | "allowance";
    assumptions: string | null;
  }>;
}

interface EstimateResult {
  estimate: EstimateScope[];
  missing_info_to_finalize: string[];
  questions_for_user: string[];
}

interface MeasurementReport {
  source: string | null;
  raw_text: string | null;
  sections: Record<string, any>;
}

interface BuildResult {
  scope_classification: ScopeClassification;
  photo_findings: PhotoFinding[];
  measurement_report: MeasurementReport;
  estimate_result: EstimateResult;
  pipeline_id: string;
}

type PipelineStage = "configure" | "building" | "results";

interface ClaimPhoto {
  id: string;
  file_name: string;
  category: string | null;
  ai_condition_rating: string | null;
}

export const EnhancedEstimateBuilder = ({ claimId, claim }: EnhancedEstimateBuilderProps) => {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<PipelineStage>("configure");
  const [building, setBuilding] = useState(false);
  const [buildProgress, setBuildProgress] = useState("");

  // Config inputs
  const [description, setDescription] = useState(claim?.loss_description || "");
  const [measurementFile, setMeasurementFile] = useState<File | null>(null);
  const [qualityGrade, setQualityGrade] = useState<"economy" | "standard" | "premium">("standard");
  const [includeOP, setIncludeOP] = useState(true);
  const [taxRate, setTaxRate] = useState(0);

  // Photos
  const [photos, setPhotos] = useState<ClaimPhoto[]>([]);
  const [loadingPhotos, setLoadingPhotos] = useState(false);

  // Results
  const [result, setResult] = useState<BuildResult | null>(null);
  const [expandedScopes, setExpandedScopes] = useState<Set<string>>(new Set());

  // Manual line items (for editing)
  const [manualItems, setManualItems] = useState<LineItem[]>([]);

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
      .select("id, file_name, category, ai_condition_rating")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false });
    setPhotos(data || []);
    setLoadingPhotos(false);
  };

  const buildEstimate = async () => {
    setBuilding(true);
    setStage("building");
    setBuildProgress("Preparing claim data...");

    try {
      // Convert measurement PDF to base64 if provided
      let measurementPdfBase64: string | null = null;
      let measurementPdfName: string | null = null;

      if (measurementFile) {
        setBuildProgress("Uploading measurement report...");
        const arrayBuffer = await measurementFile.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);
        let base64 = "";
        const chunkSize = 32768;
        for (let i = 0; i < uint8.length; i += chunkSize) {
          base64 += String.fromCharCode.apply(null, Array.from(uint8.slice(i, i + chunkSize)));
        }
        measurementPdfBase64 = btoa(base64);
        measurementPdfName = measurementFile.name;
      }

      setBuildProgress("Running photo analysis + scope classification + estimate generation...");

      const { data, error } = await supabase.functions.invoke("claim-context-pipeline", {
        body: {
          action: "build_full",
          claimId,
          measurementPdfBase64,
          measurementPdfName,
          overrides: {
            quality_grade: qualityGrade,
            include_op: includeOP,
            tax_rate: taxRate,
            price_list: null,
          },
        },
      });

      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || "Build failed");

      setResult(data);

      // Flatten line items for manual editing
      const items: LineItem[] = (data.estimate_result?.estimate || []).flatMap(
        (scope: EstimateScope, si: number) =>
          scope.items.map((item: any, ii: number) => ({
            id: `${si}-${ii}`,
            scope: scope.scope,
            line_code: item.line_code || null,
            description: item.description,
            unit: item.unit,
            qty: item.qty,
            qty_basis: item.qty_basis || "allowance",
            assumptions: item.assumptions || null,
          }))
      );
      setManualItems(items);

      // Auto-expand all scopes
      const scopes = new Set<string>((data.estimate_result?.estimate || []).map((s: EstimateScope) => s.scope));
      setExpandedScopes(scopes);

      setStage("results");
      const totalItems = items.length;
      const scopsCount = data.estimate_result?.estimate?.length || 0;
      toast.success(`Generated ${totalItems} line items across ${scopsCount} scopes`);
    } catch (err: any) {
      console.error("Build estimate error:", err);
      toast.error(err.message || "Failed to build estimate");
      setStage("configure");
    } finally {
      setBuilding(false);
      setBuildProgress("");
    }
  };

  const addLineItem = () => {
    setManualItems(prev => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        scope: "interior",
        line_code: null,
        description: "",
        unit: "SF",
        qty: 0,
        qty_basis: "allowance",
        assumptions: null,
      },
    ]);
  };

  const updateLineItem = (id: string, field: keyof LineItem, value: any) => {
    setManualItems(prev => prev.map(item => (item.id === id ? { ...item, [field]: value } : item)));
  };

  const removeLineItem = (id: string) => {
    setManualItems(prev => prev.filter(item => item.id !== id));
  };

  const copyEstimate = () => {
    const header = "Scope\tCode\tDescription\tQty\tUnit\tBasis\tAssumptions";
    const lines = manualItems.map(
      item =>
        `${item.scope}\t${item.line_code || ""}\t${item.description}\t${item.qty}\t${item.unit}\t${item.qty_basis}\t${item.assumptions || ""}`
    );
    navigator.clipboard.writeText(`${header}\n${lines.join("\n")}`);
    toast.success("Estimate copied to clipboard");
  };

  const toggleScope = (scope: string) => {
    const next = new Set(expandedScopes);
    next.has(scope) ? next.delete(scope) : next.add(scope);
    setExpandedScopes(next);
  };

  const resetBuilder = () => {
    setStage("configure");
    setResult(null);
    setManualItems([]);
    setExpandedScopes(new Set());
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Calculator className="h-4 w-4" />
          Estimate Builder
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5 text-primary" />
            AI Estimate Builder
            <Badge variant="secondary" className="text-[10px]">Photo-First Pipeline</Badge>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-4 p-1">
            {/* ── CONFIGURE STAGE ── */}
            {stage === "configure" && (
              <div className="space-y-4">
                {/* Pipeline explanation */}
                <Card className="bg-primary/5 border-primary/20">
                  <CardContent className="p-3">
                    <p className="text-xs text-muted-foreground">
                      <strong>Pipeline:</strong> Photo Findings → Scope Classification → Estimate Generation.
                      Quantities use measured data when available, otherwise flagged allowances.
                    </p>
                  </CardContent>
                </Card>

                {/* Description */}
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">Claim Description</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <Textarea
                      value={description}
                      onChange={e => setDescription(e.target.value)}
                      placeholder="Describe the damage, what happened, and what was affected..."
                      rows={3}
                    />
                  </CardContent>
                </Card>

                {/* Photos summary */}
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Camera className="h-4 w-4" />
                      Claim Photos
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {loadingPhotos ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Loading...
                      </div>
                    ) : photos.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No photos uploaded. Upload photos in the Photos tab for better results.</p>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-sm">
                          <strong>{photos.length}</strong> photos will be analyzed.
                          Categories: {[...new Set(photos.map(p => p.category || "Uncategorized"))].join(", ")}
                        </p>
                        {photos.some(p => p.ai_condition_rating) && (
                          <div className="flex flex-wrap gap-1">
                            {photos.filter(p => p.ai_condition_rating).slice(0, 8).map(p => (
                              <Badge
                                key={p.id}
                                variant={
                                  (p.ai_condition_rating || "").toLowerCase().includes("severe") ||
                                  (p.ai_condition_rating || "").toLowerCase().includes("failed")
                                    ? "destructive"
                                    : "secondary"
                                }
                                className="text-[10px]"
                              >
                                {p.file_name.substring(0, 15)}… {p.ai_condition_rating}
                              </Badge>
                            ))}
                          </div>
                        )}
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
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Full text from ALL pages will be extracted for measured quantities.
                    </p>
                  </CardContent>
                </Card>

                {/* Settings */}
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm">Estimate Settings</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Quality Grade</Label>
                        <Select value={qualityGrade} onValueChange={v => setQualityGrade(v as any)}>
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
                        <Input
                          type="number"
                          className="h-8 text-xs"
                          value={taxRate}
                          onChange={e => setTaxRate(parseFloat(e.target.value) || 0)}
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch checked={includeOP} onCheckedChange={setIncludeOP} />
                      <Label className="text-xs">Include Overhead & Profit (O&P)</Label>
                    </div>
                  </CardContent>
                </Card>

                {/* Build Button */}
                <Button
                  onClick={buildEstimate}
                  disabled={building || (!description.trim() && photos.length === 0)}
                  className="w-full gap-2"
                  size="lg"
                >
                  <Sparkles className="h-4 w-4" />
                  Build Full Estimate
                </Button>
              </div>
            )}

            {/* ── BUILDING STAGE ── */}
            {stage === "building" && (
              <div className="flex flex-col items-center justify-center py-16 space-y-6">
                <Loader2 className="h-12 w-12 animate-spin text-primary" />
                <div className="text-center space-y-2">
                  <h3 className="font-semibold">Building Estimate…</h3>
                  <p className="text-sm text-muted-foreground">{buildProgress}</p>
                  <div className="flex items-center justify-center gap-1 pt-4">
                    {["Photo Findings", "Scope Classification", "Estimate"].map((step, i) => (
                      <div key={step} className="flex items-center gap-1">
                        <div className="px-2 py-1 rounded-full bg-primary/20 text-primary text-[10px] font-medium">
                          {step}
                        </div>
                        {i < 2 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── RESULTS STAGE ── */}
            {stage === "results" && result && (
              <div className="space-y-4">
                {/* Reset / Copy buttons */}
                <div className="flex items-center justify-between">
                  <Button variant="outline" size="sm" onClick={resetBuilder} className="gap-1">
                    <ArrowRight className="h-3 w-3 rotate-180" /> New Estimate
                  </Button>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={addLineItem} className="gap-1">
                      <Plus className="h-3 w-3" /> Add Item
                    </Button>
                    <Button variant="outline" size="sm" onClick={copyEstimate} className="gap-1">
                      <Copy className="h-3 w-3" /> Copy All
                    </Button>
                  </div>
                </div>

                {/* Photo Findings Summary */}
                <Card>
                  <CardHeader className="py-2">
                    <CardTitle className="text-xs flex items-center gap-2">
                      <Camera className="h-3 w-3" />
                      Photo Findings ({result.photo_findings.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="flex flex-wrap gap-1">
                      {result.photo_findings.map((f, i) => (
                        <Badge
                          key={i}
                          variant={f.severity === "severe" ? "destructive" : f.severity === "moderate" ? "default" : "secondary"}
                          className="text-[10px]"
                        >
                          {f.area}: {f.damage}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Scope Classification */}
                <Card>
                  <CardHeader className="py-2">
                    <CardTitle className="text-xs">Scope Classification</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-2">
                    <div className="flex flex-wrap gap-1">
                      {result.scope_classification.primary_scopes.map(s => (
                        <Badge key={s} className="capitalize">{s}</Badge>
                      ))}
                    </div>
                    <div className="grid grid-cols-5 gap-2 text-xs">
                      {Object.entries(result.scope_classification.confidence).map(([k, v]) => (
                        <div key={k} className="text-center">
                          <p className="capitalize font-medium">{k}</p>
                          <div className="w-full bg-muted rounded-full h-1.5 mt-1">
                            <div className="bg-primary h-1.5 rounded-full" style={{ width: `${(v as number) * 100}%` }} />
                          </div>
                          <p className="text-muted-foreground mt-0.5">{((v as number) * 100).toFixed(0)}%</p>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Measurement Report */}
                {result.measurement_report?.source && (
                  <Card>
                    <CardHeader className="py-2">
                      <CardTitle className="text-xs flex items-center gap-2">
                        <FileText className="h-3 w-3" />
                        Measurement Report ({result.measurement_report.source})
                        {result.measurement_report.raw_text && (
                          <Badge variant="outline" className="text-[10px]">
                            {result.measurement_report.raw_text.length.toLocaleString()} chars extracted
                          </Badge>
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        {Object.entries(result.measurement_report.sections).map(([key, val]) => {
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

                <Separator />

                {/* Estimate Line Items by Scope */}
                <h3 className="font-semibold text-sm">Estimate Line Items</h3>

                {(() => {
                  // Group manual items by scope
                  const groupedByScope = manualItems.reduce<Record<string, LineItem[]>>((acc, item) => {
                    if (!acc[item.scope]) acc[item.scope] = [];
                    acc[item.scope].push(item);
                    return acc;
                  }, {});

                  return Object.entries(groupedByScope).map(([scope, items]) => (
                    <Card key={scope}>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => toggleScope(scope)}
                        className="w-full flex items-center justify-between p-3 h-auto hover:bg-muted/30 transition-colors rounded-none"
                      >
                        <div className="flex items-center gap-2">
                          {expandedScopes.has(scope) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          <span className="font-medium capitalize text-sm">{scope}</span>
                          <Badge variant="secondary" className="text-[10px]">{items.length} items</Badge>
                        </div>
                      </Button>
                      {expandedScopes.has(scope) && (
                        <CardContent className="pt-0">
                          <div className="space-y-1">
                            {/* Header */}
                            <div className="grid grid-cols-12 gap-1 text-[10px] font-medium text-muted-foreground px-1 pb-1 border-b">
                              <div className="col-span-1">Code</div>
                              <div className="col-span-4">Description</div>
                              <div className="col-span-1">Qty</div>
                              <div className="col-span-1">Unit</div>
                              <div className="col-span-1">Basis</div>
                              <div className="col-span-3">Assumptions</div>
                              <div className="col-span-1"></div>
                            </div>
                            {items.map(item => (
                              <div key={item.id} className="grid grid-cols-12 gap-1 text-xs px-1 py-1 hover:bg-muted/30 rounded items-center">
                                <div className="col-span-1">
                                  <Input
                                    value={item.line_code || ""}
                                    onChange={e => updateLineItem(item.id, "line_code", e.target.value || null)}
                                    className="h-6 text-[10px] font-mono"
                                    placeholder="—"
                                  />
                                </div>
                                <div className="col-span-4">
                                  <Input
                                    value={item.description}
                                    onChange={e => updateLineItem(item.id, "description", e.target.value)}
                                    className="h-6 text-xs"
                                  />
                                </div>
                                <div className="col-span-1">
                                  <Input
                                    type="number"
                                    value={item.qty}
                                    onChange={e => updateLineItem(item.id, "qty", parseFloat(e.target.value) || 0)}
                                    className="h-6 text-xs"
                                  />
                                </div>
                                <div className="col-span-1">
                                  <Input
                                    value={item.unit}
                                    onChange={e => updateLineItem(item.id, "unit", e.target.value)}
                                    className="h-6 text-xs"
                                  />
                                </div>
                                <div className="col-span-1">
                                  <Badge
                                    variant={item.qty_basis === "measured" ? "default" : "outline"}
                                    className="text-[10px] cursor-pointer"
                                    onClick={() => updateLineItem(item.id, "qty_basis", item.qty_basis === "measured" ? "allowance" : "measured")}
                                  >
                                    {item.qty_basis}
                                  </Badge>
                                </div>
                                <div className="col-span-3">
                                  <Input
                                    value={item.assumptions || ""}
                                    onChange={e => updateLineItem(item.id, "assumptions", e.target.value || null)}
                                    className="h-6 text-[10px] italic"
                                    placeholder="—"
                                  />
                                </div>
                                <div className="col-span-1 flex justify-center">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    onClick={() => removeLineItem(item.id)}
                                  >
                                    <Trash2 className="h-3 w-3 text-destructive" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </CardContent>
                      )}
                    </Card>
                  ));
                })()}

                {manualItems.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">No line items generated.</p>
                )}

                {/* Missing info & questions */}
                {result.estimate_result?.missing_info_to_finalize?.length > 0 && (
                  <Card className="border-destructive/30 bg-destructive/5">
                    <CardContent className="p-3">
                      <p className="text-xs font-medium flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3 text-destructive" /> Missing Info to Finalize
                      </p>
                      <ul className="list-disc list-inside text-xs text-muted-foreground mt-1">
                        {result.estimate_result.missing_info_to_finalize.map((m, i) => <li key={i}>{m}</li>)}
                      </ul>
                    </CardContent>
                  </Card>
                )}

                {result.estimate_result?.questions_for_user?.length > 0 && (
                  <Card className="border-primary/30 bg-primary/5">
                    <CardContent className="p-3">
                      <p className="text-xs font-medium">Questions for You</p>
                      <ul className="list-disc list-inside text-xs text-muted-foreground mt-1">
                        {result.estimate_result.questions_for_user.map((q, i) => <li key={i}>{q}</li>)}
                      </ul>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};
