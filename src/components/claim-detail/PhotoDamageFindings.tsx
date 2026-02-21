import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Search, AlertTriangle, Wrench, Sparkles, HelpCircle, Trash2, ChevronDown, ChevronRight, Camera, BarChart3, XCircle, DollarSign } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface PhotoEntry {
  photo_id: string;
  inferred_area: string;
  items: {
    item: string;
    material?: string | null;
    damage: string;
    action: "replace" | "repair" | "clean_restore" | "investigate";
    why: string;
    severity?: "minor" | "moderate" | "severe";
    trade_category_code?: string;
    repair_method?: string;
    confidence?: number;
  }[];
  missing_photo_request?: string | null;
}

interface DamageFinding {
  area: string;
  items: {
    item: string;
    material?: string;
    damage?: string;
    action: "replace" | "repair" | "clean_restore" | "investigate";
    why: string;
    severity?: string;
    trade_category_code?: string;
    repair_method?: string;
    confidence?: number;
    evidence_photo_ids?: string[];
  }[];
}

interface XactimatePlanItem {
  area: string;
  trade_groups: {
    category_code: string;
    items: {
      selector_hint: string;
      reason: string;
      linked_replace_item: string;
    }[];
  }[];
}

interface EstimateLineItem {
  area: string;
  item: string;
  action: string;
  repair_method?: string;
  unit: string;
  quantity: number;
  material_cost_per_unit: number;
  labor_cost_per_unit: number;
  total: number;
}

interface EstimateResult {
  location_used?: string;
  price_date?: string;
  line_items: EstimateLineItem[];
  subtotal_materials: number;
  subtotal_labor: number;
  tax_rate?: number;
  tax_amount: number;
  overhead_and_profit_pct?: number;
  overhead_and_profit_amount: number;
  grand_total: number;
  assumptions?: string[];
}

interface AnalysisResult {
  pass1_inventory: {
    photos: PhotoEntry[];
    notes: string[];
  };
  damage_findings?: DamageFinding[];
  xactimate_plan?: XactimatePlanItem[];
  notes?: string[];
  questions?: string[];
  estimate?: EstimateResult;
  stats: {
    total_photos: number;
    photos_processed: number;
    total_items_detected: number;
    deduped_items: number;
  };
}

const BATCH_SIZE = 7;

const ACTION_CONFIG: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
  replace: { label: "Replace", icon: <Trash2 className="h-3 w-3" />, className: "bg-destructive/15 text-destructive border-destructive/30" },
  repair: { label: "Repair", icon: <Wrench className="h-3 w-3" />, className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400 border-yellow-500/30" },
  clean_restore: { label: "Clean/Restore", icon: <Sparkles className="h-3 w-3" />, className: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30" },
  investigate: { label: "Investigate", icon: <HelpCircle className="h-3 w-3" />, className: "bg-muted text-muted-foreground border-border" },
};

const SEVERITY_CONFIG: Record<string, string> = {
  minor: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  moderate: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  severe: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

// Helper: invoke edge function with DB polling fallback for gateway timeouts
async function invokeWithPolling(claimId: string, body: any, jobKey: string, stagePrefix: string) {
  try {
    const { data, error } = await supabase.functions.invoke("photo-damage-analyzer", {
      body: { ...body, jobKey },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    return data;
  } catch (err: any) {
    const isTimeout = err.name === 'FunctionsFetchError' || err.message?.includes('Load failed') || err.message?.includes('Failed to fetch') || err.name === 'TypeError';
    if (!isTimeout) throw err;

    console.log(`Connection dropped for ${stagePrefix}, polling DB for result...`);
    // Poll DB for the saved result (edge function saves before returning)
    for (let i = 0; i < 40; i++) { // up to ~200 seconds
      await new Promise(r => setTimeout(r, 5000));
      const { data: cached } = await supabase
        .from("claim_context_pipelines")
        .select("claim_context")
        .eq("claim_id", claimId)
        .eq("stage", `${stagePrefix}_${jobKey}`)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cached?.claim_context) {
        console.log(`Got cached result for ${stagePrefix}`);
        return cached.claim_context;
      }
    }
    throw new Error("Analysis timed out after polling - please try again");
  }
}

export function PhotoDamageFindings({ claimId, photoCount, pagePhotoIds = [], currentPage = 1, totalPages = 1 }: { claimId: string; photoCount: number; pagePhotoIds?: string[]; currentPage?: number; totalPages?: number }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [activeTab, setActiveTab] = useState<"inventory" | "replace" | "xactimate" | "estimate">("replace");
  const [expandedPhotos, setExpandedPhotos] = useState<Set<string>>(new Set());
  const [progressText, setProgressText] = useState("");
  const [progressPct, setProgressPct] = useState(0);
  const cancelRef = useRef(false);
  const [estimateLoading, setEstimateLoading] = useState(false);
  // Accumulate pass1 results across multiple page analyses
  const accumulatedPhotosRef = useRef<PhotoEntry[]>([]);
  const accumulatedNotesRef = useRef<string[]>([]);

  const runAnalysis = async (analyzeAll = false) => {
    setLoading(true);
    setProgressPct(0);
    cancelRef.current = false;

    try {
      // Determine which photo IDs to analyze
      let targetPhotoIds: string[];
      let claimDescription: string;

      if (analyzeAll) {
        setProgressText("Fetching all photo IDs...");
        const { data: listData, error: listError } = await supabase.functions.invoke("photo-damage-analyzer", {
          body: { claimId, mode: "list" },
        });
        if (listError) throw listError;
        if (listData?.error) throw new Error(listData.error);
        targetPhotoIds = listData.photoIds || [];
        claimDescription = listData.claimDescription || "";
        // Reset accumulated data when doing full analysis
        accumulatedPhotosRef.current = [];
        accumulatedNotesRef.current = [];
      } else {
        // Page-by-page: use the photo IDs from the current page
        targetPhotoIds = pagePhotoIds;
        setProgressText(`Fetching claim info...`);
        const { data: listData } = await supabase.functions.invoke("photo-damage-analyzer", {
          body: { claimId, mode: "list" },
        });
        claimDescription = listData?.claimDescription || "";
      }

      if (targetPhotoIds.length === 0) {
        throw new Error("No photos to analyze");
      }

      // Create batches of 7
      const batches: string[][] = [];
      for (let i = 0; i < targetPhotoIds.length; i += BATCH_SIZE) {
        batches.push(targetPhotoIds.slice(i, i + BATCH_SIZE));
      }

      const newPhotoEntries: PhotoEntry[] = [];
      const newNotes: string[] = [];
      const totalBatches = batches.length;

      // Process each batch sequentially
      for (let i = 0; i < totalBatches; i++) {
        if (cancelRef.current) {
          newNotes.push("Analysis cancelled by user");
          break;
        }

        setProgressText(`Pass 1: Analyzing batch ${i + 1}/${totalBatches} (${batches[i].length} photos)...`);
        setProgressPct(Math.round(((i) / (totalBatches + 1)) * 100));

        try {
          const batchJobKey = `b${i}_${Date.now()}`;
          const batchData = await invokeWithPolling(claimId, { claimId, mode: "batch", photoIds: batches[i], claimDescription }, batchJobKey, "pda_batch");

          if (batchData?.photos) {
            newPhotoEntries.push(...batchData.photos);
          }
          if (batchData?.notes) {
            newNotes.push(...batchData.notes);
          }
        } catch (batchErr: any) {
          console.error(`Batch ${i + 1} failed:`, batchErr);
          for (const pid of batches[i]) {
            newPhotoEntries.push({
              photo_id: pid,
              inferred_area: "Unknown",
              items: [{ item: "Batch processing failed", damage: "N/A", action: "investigate", why: batchErr.message || "AI batch failed; rerun analysis", severity: "minor", trade_category_code: "GEN", confidence: 0 }],
              missing_photo_request: "Rerun analysis for this batch",
            });
          }
          newNotes.push(`Batch ${i + 1} failed: ${batchErr.message || "Unknown error"}`);
        }

        if (i < totalBatches - 1) {
          await new Promise(r => setTimeout(r, 800));
        }
      }

      // Ensure all target photo_ids are represented
      const processedIds = new Set(newPhotoEntries.map(p => p.photo_id));
      for (const pid of targetPhotoIds) {
        if (!processedIds.has(pid)) {
          newPhotoEntries.push({
            photo_id: pid,
            inferred_area: "Unknown",
            items: [{ item: "Missing from output", damage: "N/A", action: "investigate", why: "Missing from batch output; rerun", severity: "minor", trade_category_code: "GEN", confidence: 0 }],
            missing_photo_request: "Rerun analysis",
          });
        }
      }

      // Merge with accumulated results (replace existing photo_ids, add new ones)
      const existingById = new Map(accumulatedPhotosRef.current.map(p => [p.photo_id, p]));
      for (const entry of newPhotoEntries) {
        existingById.set(entry.photo_id, entry);
      }
      accumulatedPhotosRef.current = Array.from(existingById.values());
      accumulatedNotesRef.current = [...accumulatedNotesRef.current, ...newNotes];

      const allPhotoEntries = accumulatedPhotosRef.current;
      const allNotes = accumulatedNotesRef.current;
      const pass1Inventory = { photos: allPhotoEntries, notes: allNotes };
      const totalItems = allPhotoEntries.reduce((s, p) => s + (p.items?.length || 0), 0);

      // Pass 2 - Deduplicate (text-only)
      setProgressText(`Pass 2: Deduplicating ${totalItems} items across ${allPhotoEntries.length} photos...`);
      setProgressPct(Math.round((totalBatches / (totalBatches + 1)) * 100));

      let pass2Result: any = null;
      try {
        const dedupJobKey = `dedup_${Date.now()}`;
        setProgressText(`Pass 2: Deduplicating ${totalItems} items across ${allPhotoEntries.length} photos (may take a minute)...`);
        pass2Result = await invokeWithPolling(claimId, { claimId, mode: "deduplicate", pass1Data: pass1Inventory, claimDescription }, dedupJobKey, "pda_dedup");
      } catch (dedupErr: any) {
        console.error("Pass 2 failed:", dedupErr);
        allNotes.push(`Pass 2 deduplication failed: ${dedupErr.message || "Unknown error"}`);
      }

      const finalResult: AnalysisResult = {
        pass1_inventory: pass1Inventory,
        ...(pass2Result || {}),
        stats: {
          total_photos: analyzeAll ? targetPhotoIds.length : accumulatedPhotosRef.current.length,
          photos_processed: allPhotoEntries.length,
          total_items_detected: totalItems,
          deduped_items: pass2Result?.damage_findings?.reduce((s: number, f: any) => s + (f.items?.length || 0), 0) || 0,
        },
      };

      setResult(finalResult);
      setProgressPct(100);
      const label = analyzeAll ? "all photos" : `page ${currentPage}`;
      toast.success(`Analysis complete (${label}): ${newPhotoEntries.length} photos → ${newPhotoEntries.reduce((s, p) => s + (p.items?.length || 0), 0)} items`);
    } catch (err: any) {
      console.error("Analysis error:", err);
      toast.error(err.message || "Failed to analyze photos");
    } finally {
      setLoading(false);
      setProgressText("");
      setProgressPct(0);
    }
  };

  const generateEstimate = async () => {
    if (!result?.damage_findings) return;
    setEstimateLoading(true);
    try {
      const estimateJobKey = `est_${Date.now()}`;
      const data = await invokeWithPolling(claimId, { claimId, mode: "estimate", damage_findings: result.damage_findings }, estimateJobKey, "pda_estimate");
      setResult(prev => prev ? { ...prev, estimate: data } : prev);
      setActiveTab("estimate");
      toast.success("Cost estimate generated!");
    } catch (err: any) {
      console.error("Estimate error:", err);
      toast.error(err.message || "Failed to generate estimate");
    } finally {
      setEstimateLoading(false);
    }
  };

  const cancelAnalysis = () => {
    cancelRef.current = true;
    toast.info("Cancelling after current batch completes...");
  };

  const togglePhoto = (photoId: string) => {
    setExpandedPhotos(prev => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  };

  const expandAll = () => {
    if (result?.pass1_inventory?.photos) {
      setExpandedPhotos(new Set(result.pass1_inventory.photos.map(p => p.photo_id)));
    }
  };

  const collapseAll = () => setExpandedPhotos(new Set());

  if (!result) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Search className="h-4 w-4 text-primary" />
            Photo Damage Analyzer
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            Analyzes photos in batches of {BATCH_SIZE}, then deduplicates into a replace/repair list and Xactimate plan. Analyze page-by-page or all at once.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={() => runAnalysis(false)} disabled={loading || pagePhotoIds.length === 0} className="gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {loading ? "Analyzing..." : `Analyze This Page (${pagePhotoIds.length})`}
            </Button>
            <Button variant="outline" onClick={() => runAnalysis(true)} disabled={loading || photoCount === 0} className="gap-2">
              <Search className="h-4 w-4" />
              Analyze All {photoCount} Photos
            </Button>
            {loading && (
              <Button variant="outline" size="sm" onClick={cancelAnalysis} className="gap-1">
                <XCircle className="h-3.5 w-3.5" /> Cancel
              </Button>
            )}
          </div>
          {loading && (
            <div className="mt-3 space-y-2">
              <Progress value={progressPct} className="h-2" />
              <p className="text-xs text-muted-foreground">{progressText}</p>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  const stats = result.stats;

  return (
    <div className="space-y-4">
      {/* Stats bar */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4 text-sm">
              <span className="flex items-center gap-1"><Camera className="h-3.5 w-3.5" /> {stats.photos_processed} photos</span>
              <span className="flex items-center gap-1"><BarChart3 className="h-3.5 w-3.5" /> {stats.total_items_detected} items detected</span>
              {stats.deduped_items > 0 && <span className="text-muted-foreground">→ {stats.deduped_items} unique items</span>}
            </div>
            <div className="flex items-center gap-2">
              {loading && (
                <Button variant="outline" size="sm" onClick={cancelAnalysis} className="gap-1">
                  <XCircle className="h-3 w-3" /> Cancel
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => runAnalysis(false)} disabled={loading} className="gap-1">
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
                Analyze Page ({pagePhotoIds.length})
              </Button>
              <Button variant="ghost" size="sm" onClick={() => runAnalysis(true)} disabled={loading} className="gap-1">
                <Search className="h-3 w-3" />
                All
              </Button>
            </div>
          </div>
          {loading && (
            <div className="mb-3 space-y-1">
              <Progress value={progressPct} className="h-2" />
              <p className="text-xs text-muted-foreground">{progressText}</p>
            </div>
          )}
          {/* Tab buttons */}
          <div className="flex gap-1">
            <Button variant={activeTab === "replace" ? "default" : "ghost"} size="sm" onClick={() => setActiveTab("replace")}>
              Deduped Replace List
            </Button>
            <Button variant={activeTab === "xactimate" ? "default" : "ghost"} size="sm" onClick={() => setActiveTab("xactimate")}>
              Xactimate Plan
            </Button>
            <Button variant={activeTab === "inventory" ? "default" : "ghost"} size="sm" onClick={() => setActiveTab("inventory")}>
              Photo-by-Photo ({stats.photos_processed})
            </Button>
            <Button
              variant={activeTab === "estimate" ? "default" : "ghost"}
              size="sm"
              onClick={() => result.estimate ? setActiveTab("estimate") : generateEstimate()}
              disabled={estimateLoading || !result.damage_findings}
              className="gap-1"
            >
              {estimateLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <DollarSign className="h-3 w-3" />}
              {result.estimate ? "Estimate" : "Generate Estimate"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tab: Deduped Replace List */}
      {activeTab === "replace" && result.damage_findings && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-primary" />
              Replace / Repair List (Grouped by Area)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                 <TableRow>
                   <TableHead className="w-[130px]">Area</TableHead>
                   <TableHead>Item</TableHead>
                   <TableHead className="w-[100px]">Action</TableHead>
                   <TableHead className="w-[80px]">Severity</TableHead>
                   <TableHead>Method</TableHead>
                   <TableHead>Why</TableHead>
                   <TableHead className="w-[80px]">Photos</TableHead>
                 </TableRow>
              </TableHeader>
              <TableBody>
                {result.damage_findings.flatMap((finding) =>
                  finding.items.map((item, idx) => {
                    const config = ACTION_CONFIG[item.action] || ACTION_CONFIG.investigate;
                    return (
                      <TableRow key={`${finding.area}-${idx}`}>
                        {idx === 0 ? (
                          <TableCell rowSpan={finding.items.length} className="font-medium align-top border-r">
                            {finding.area}
                          </TableCell>
                        ) : null}
                        <TableCell className="font-medium text-sm">{item.item}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`gap-1 text-xs ${config.className}`}>
                            {config.icon}
                            {config.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {item.severity && (
                            <Badge variant="outline" className={`text-xs ${SEVERITY_CONFIG[item.severity] || ""}`}>
                              {item.severity}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{item.repair_method || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{item.why}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {item.evidence_photo_ids?.length || 0}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Tab: Xactimate Plan */}
      {activeTab === "xactimate" && result.xactimate_plan && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Xactimate Add-Item Plan
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[130px]">Area</TableHead>
                  <TableHead className="w-[70px]">CAT</TableHead>
                  <TableHead>Selector Hint</TableHead>
                  <TableHead>Linked Item</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.xactimate_plan.flatMap((plan) =>
                  plan.trade_groups.flatMap((group, gIdx) =>
                    group.items.map((item, iIdx) => (
                      <TableRow key={`${plan.area}-${gIdx}-${iIdx}`}>
                        {gIdx === 0 && iIdx === 0 ? (
                          <TableCell
                            rowSpan={plan.trade_groups.reduce((sum, g) => sum + g.items.length, 0)}
                            className="font-medium align-top border-r"
                          >
                            {plan.area}
                          </TableCell>
                        ) : null}
                        {iIdx === 0 ? (
                          <TableCell rowSpan={group.items.length} className="align-top">
                            <Badge variant="secondary" className="font-mono text-xs">
                              {group.category_code}
                            </Badge>
                          </TableCell>
                        ) : null}
                        <TableCell className="font-medium text-sm">{item.selector_hint}</TableCell>
                        <TableCell className="text-sm">{item.linked_replace_item}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{item.reason}</TableCell>
                      </TableRow>
                    ))
                  )
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Tab: Cost Estimate */}
      {activeTab === "estimate" && result.estimate && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-primary" />
                Cost Estimate
              </CardTitle>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {result.estimate.location_used && <span>📍 {result.estimate.location_used}</span>}
                {result.estimate.price_date && <span>• {result.estimate.price_date}</span>}
                <Button variant="outline" size="sm" onClick={generateEstimate} disabled={estimateLoading} className="gap-1 ml-2">
                  {estimateLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <DollarSign className="h-3 w-3" />}
                  Re-estimate
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Area</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="w-[70px]">Action</TableHead>
                  <TableHead className="w-[50px] text-right">Qty</TableHead>
                  <TableHead className="w-[50px] text-right">Unit</TableHead>
                  <TableHead className="w-[90px] text-right">Material/Unit</TableHead>
                  <TableHead className="w-[90px] text-right">Labor/Unit</TableHead>
                  <TableHead className="w-[100px] text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.estimate.line_items.map((item, idx) => {
                  const config = ACTION_CONFIG[item.action] || ACTION_CONFIG.investigate;
                  return (
                    <TableRow key={idx}>
                      <TableCell className="font-medium text-sm">{item.area}</TableCell>
                      <TableCell className="text-sm">{item.item}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`gap-1 text-xs ${config.className}`}>
                          {config.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-sm">{item.quantity}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{item.unit}</TableCell>
                      <TableCell className="text-right text-sm">${item.material_cost_per_unit.toFixed(2)}</TableCell>
                      <TableCell className="text-right text-sm">${item.labor_cost_per_unit.toFixed(2)}</TableCell>
                      <TableCell className="text-right text-sm font-medium">${item.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</TableCell>
                    </TableRow>
                  );
                })}
                <TableRow className="border-t-2">
                  <TableCell colSpan={5} />
                  <TableCell className="text-right text-sm font-medium">Materials:</TableCell>
                  <TableCell className="text-right text-sm font-medium" colSpan={2}>
                    ${result.estimate.subtotal_materials.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell colSpan={5} />
                  <TableCell className="text-right text-sm font-medium">Labor:</TableCell>
                  <TableCell className="text-right text-sm font-medium" colSpan={2}>
                    ${result.estimate.subtotal_labor.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell colSpan={5} />
                  <TableCell className="text-right text-sm text-muted-foreground">Tax{result.estimate.tax_rate ? ` (${result.estimate.tax_rate}%)` : ""}:</TableCell>
                  <TableCell className="text-right text-sm" colSpan={2}>
                    ${result.estimate.tax_amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell colSpan={5} />
                  <TableCell className="text-right text-sm text-muted-foreground">O&P{result.estimate.overhead_and_profit_pct ? ` (${result.estimate.overhead_and_profit_pct}%)` : ""}:</TableCell>
                  <TableCell className="text-right text-sm" colSpan={2}>
                    ${result.estimate.overhead_and_profit_amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                </TableRow>
                <TableRow className="border-t-2 bg-muted/50">
                  <TableCell colSpan={5} />
                  <TableCell className="text-right font-bold text-base">Grand Total:</TableCell>
                  <TableCell className="text-right font-bold text-base text-primary" colSpan={2}>
                    ${result.estimate.grand_total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
          {result.estimate.assumptions && result.estimate.assumptions.length > 0 && (
            <CardContent className="pt-3">
              <p className="text-xs font-medium mb-1">Assumptions</p>
              <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                {result.estimate.assumptions.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </CardContent>
          )}
        </Card>
      )}

      {/* Tab: Photo-by-Photo Inventory */}
      {activeTab === "inventory" && result.pass1_inventory && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Camera className="h-4 w-4 text-primary" />
                Photo-by-Photo Inventory
              </CardTitle>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={expandAll}>Expand All</Button>
                <Button variant="ghost" size="sm" onClick={collapseAll}>Collapse All</Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-1 pt-0">
            {result.pass1_inventory.photos.map((photo) => (
              <Collapsible
                key={photo.photo_id}
                open={expandedPhotos.has(photo.photo_id)}
                onOpenChange={() => togglePhoto(photo.photo_id)}
              >
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="flex items-center w-full gap-2 text-left px-3 py-2 h-auto rounded-md hover:bg-muted/50 transition-colors text-sm justify-start"
                  >
                    {expandedPhotos.has(photo.photo_id) ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                    <span className="font-medium truncate">{photo.inferred_area}</span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">{photo.items.length} items</span>
                    <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[120px]">{photo.photo_id.slice(0, 8)}…</span>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="ml-6 mb-2 border rounded-md overflow-hidden">
                    <Table>
                      <TableHeader>
                         <TableRow>
                           <TableHead>Item</TableHead>
                           <TableHead className="w-[90px]">Action</TableHead>
                           <TableHead className="w-[70px]">Severity</TableHead>
                           <TableHead>Method</TableHead>
                           <TableHead>Why</TableHead>
                         </TableRow>
                      </TableHeader>
                      <TableBody>
                        {photo.items.map((item, idx) => {
                          const config = ACTION_CONFIG[item.action] || ACTION_CONFIG.investigate;
                          return (
                            <TableRow key={idx}>
                              <TableCell className="text-sm font-medium">{item.item}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className={`gap-1 text-xs ${config.className}`}>
                                  {config.icon}
                                  {config.label}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                {item.severity && (
                                  <Badge variant="outline" className={`text-xs ${SEVERITY_CONFIG[item.severity] || ""}`}>
                                    {item.severity}
                                  </Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">{item.repair_method || "—"}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">{item.why}</TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    {photo.missing_photo_request && (
                      <div className="px-3 py-2 bg-muted/50 text-xs text-muted-foreground border-t">
                        📷 Needed: {photo.missing_photo_request}
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Notes & Questions */}
      {((result.notes && result.notes.length > 0) || (result.questions && result.questions.length > 0) || (result.pass1_inventory?.notes && result.pass1_inventory.notes.length > 0)) && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            {result.pass1_inventory?.notes && result.pass1_inventory.notes.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-1">Processing Notes</p>
                <ul className="text-sm text-muted-foreground list-disc pl-4 space-y-1">
                  {result.pass1_inventory.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
            {result.notes && result.notes.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-1">Analysis Notes</p>
                <ul className="text-sm text-muted-foreground list-disc pl-4 space-y-1">
                  {result.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
            {result.questions && result.questions.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-1">Questions for Inspector</p>
                <ul className="text-sm text-muted-foreground list-disc pl-4 space-y-1">
                  {result.questions.map((q, i) => <li key={i}>{q}</li>)}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
