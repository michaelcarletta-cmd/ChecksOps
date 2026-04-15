import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Upload, FileText, CheckCircle2, AlertCircle, Save, Wand2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

interface EstimateUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  claimId: string;
  onSuccess?: () => void;
}

interface ExtractedData {
  estimate_type: string | null;
  dwelling: {
    rcv: number;
    recoverable_depreciation: number;
    non_recoverable_depreciation: number;
    deductible: number;
  };
  other_structures: {
    rcv: number;
    recoverable_depreciation: number;
    non_recoverable_depreciation: number;
    deductible: number;
  };
  contents: {
    rcv: number;
    recoverable_depreciation: number;
    non_recoverable_depreciation: number;
  };
  pwi: {
    rcv: number;
    recoverable_depreciation: number;
    non_recoverable_depreciation: number;
    deductible: number;
  };
  totals: {
    gross_total: number;
    total_depreciation: number;
    net_total: number;
  };
  line_items: Array<{
    line_item_id?: string;
    description: string;
    quantity: number;
    unit: string;
    unit_cost: number;
    total: number;
    category: string;
  }>;
  quality_review?: {
    questionable_count: number;
    questionable_line_items: QuestionableLineItem[];
  };
  estimate_record?: {
    id: string;
    version: number;
    persisted_line_items: number;
  } | null;
  review_prompt?: string;
}

interface QuestionableLineItem {
  index: number;
  line_item_id?: string;
  description: string;
  quantity: number;
  unit: string;
  unit_cost: number;
  total: number;
  category: string;
  reasons: string[];
  suggested_fixes: string[];
}

interface ExtractionStep {
  key: string;
  label: string;
  status: "started" | "completed" | "error";
  detail?: string;
  durationMs?: number;
}

export function EstimateUploadDialog({
  open,
  onOpenChange,
  claimId,
  onSuccess,
}: EstimateUploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [savingFixes, setSavingFixes] = useState(false);
  const [extractionSteps, setExtractionSteps] = useState<ExtractionStep[]>([]);
  const [extractedData, setExtractedData] = useState<ExtractedData | null>(null);
  const [questionableItems, setQuestionableItems] = useState<QuestionableLineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setExtractedData(null);
      setExtractionSteps([]);
      setQuestionableItems([]);
      setError(null);
    }
  };

  const handleExtract = async () => {
    if (!file) return;

    setIsProcessing(true);
    setError(null);
    setExtractionSteps([]);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("claimId", claimId);

      const { data, error: fnError } = await supabase.functions.invoke("extract-estimate", {
        body: formData,
      });

      if (fnError) throw fnError;

      if (!data.success) {
        throw new Error(data.error || "Failed to extract estimate data");
      }

      const extracted = data.data as ExtractedData;
      setExtractedData(extracted);
      setExtractionSteps(Array.isArray(data.execution_steps) ? data.execution_steps : []);
      setQuestionableItems(extracted.quality_review?.questionable_line_items || []);
      
      // Invalidate queries to refresh accounting + estimate intelligence data
      queryClient.invalidateQueries({ queryKey: ["claim-settlement", claimId] });
      queryClient.invalidateQueries({ queryKey: ["claim-estimates", claimId] });
      queryClient.invalidateQueries({ queryKey: ["estimate-line-items", claimId] });

      const questionableCount = extracted.quality_review?.questionable_count || 0;
      toast({
        title: "Estimate processed successfully",
        description:
          questionableCount > 0
            ? `Accounting updated. ${questionableCount} line item(s) need review.`
            : "Accounting and line-item extraction completed with no issues detected.",
      });

      onSuccess?.();
    } catch (err) {
      console.error("Estimate extraction error:", err);
      setError(err instanceof Error ? err.message : "Failed to process estimate");
      toast({
        title: "Error",
        description: "Failed to extract estimate data. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClose = () => {
    setFile(null);
    setExtractedData(null);
    setExtractionSteps([]);
    setQuestionableItems([]);
    setError(null);
    onOpenChange(false);
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value || 0);
  };

  const evaluateItemReasons = (item: {
    description: string;
    quantity: number;
    unit: string;
    unit_cost: number;
    total: number;
    category: string;
  }) => {
    const reasons: string[] = [];
    if (!item.description || item.description.trim().length < 5) reasons.push("Description is missing or too short.");
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) reasons.push("Quantity is missing or invalid.");
    if (!item.unit || item.unit.trim().length > 8) reasons.push("Unit is missing or malformed.");
    if (!Number.isFinite(item.total) || item.total <= 0) reasons.push("Total is missing or zero.");
    if (item.quantity > 0 && item.unit_cost > 0 && item.total > 0) {
      const expected = item.quantity * item.unit_cost;
      if (Math.abs(expected - item.total) > Math.max(2, expected * 0.2)) {
        reasons.push("Total does not match quantity × unit cost.");
      }
    }
    if (!item.category || item.category.toLowerCase() === "general") {
      reasons.push("Category needs review.");
    }
    return reasons;
  };

  const recomputeQuestionableItems = (lineItems: ExtractedData["line_items"], existing: QuestionableLineItem[]) => {
    const lineItemIdByIndex = new Map(existing.map((item) => [item.index, item.line_item_id]));
    return lineItems
      .map((item, index) => {
        const reasons = evaluateItemReasons(item);
        if (reasons.length === 0) return null;
        return {
          index,
          line_item_id: lineItemIdByIndex.get(index) || item.line_item_id,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unit_cost: item.unit_cost,
          total: item.total,
          category: item.category,
          reasons,
          suggested_fixes: [
            "Confirm description, quantities, and totals from the estimate source.",
            "Adjust category to the correct trade if needed.",
          ],
        } as QuestionableLineItem;
      })
      .filter(Boolean) as QuestionableLineItem[];
  };

  const syncQuestionableToExtractedData = (nextQuestionable: QuestionableLineItem[]) => {
    setExtractedData((prev) => {
      if (!prev) return prev;
      const nextLineItems = [...prev.line_items];
      nextQuestionable.forEach((item) => {
        if (nextLineItems[item.index]) {
          nextLineItems[item.index] = {
            ...nextLineItems[item.index],
            line_item_id: item.line_item_id || nextLineItems[item.index].line_item_id,
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            unit_cost: item.unit_cost,
            total: item.total,
            category: item.category,
          };
        }
      });
      return {
        ...prev,
        line_items: nextLineItems,
        quality_review: {
          questionable_count: nextQuestionable.length,
          questionable_line_items: nextQuestionable,
        },
        review_prompt: nextQuestionable.length > 0
          ? `Review ${nextQuestionable.length} questionable line item(s) before finalizing.`
          : "No questionable line items detected.",
      };
    });
  };

  const handleQuestionableChange = (
    itemIndex: number,
    field: "description" | "quantity" | "unit" | "unit_cost" | "total" | "category",
    value: string,
  ) => {
    const next = questionableItems.map((item, idx) => {
      if (idx !== itemIndex) return item;
      if (field === "quantity" || field === "unit_cost" || field === "total") {
        const parsed = Number(value);
        return {
          ...item,
          [field]: Number.isFinite(parsed) ? parsed : 0,
        };
      }
      return {
        ...item,
        [field]: value,
      };
    });
    const reviewed = next.map((item) => ({
      ...item,
      reasons: evaluateItemReasons(item),
    }));
    setQuestionableItems(reviewed);
    syncQuestionableToExtractedData(reviewed);
  };

  const applySuggestedFixes = () => {
    const fixed = questionableItems.map((item) => {
      const next = { ...item };
      if (!next.unit?.trim()) next.unit = "EA";
      if (!next.category?.trim()) next.category = "General";
      if (next.total <= 0 && next.quantity > 0 && next.unit_cost > 0) {
        next.total = Math.round(next.quantity * next.unit_cost * 100) / 100;
      }
      next.reasons = evaluateItemReasons(next);
      return next;
    });
    setQuestionableItems(fixed);
    syncQuestionableToExtractedData(fixed);
    toast({
      title: "Suggested fixes applied",
      description: "Darwin applied quick corrections to questionable line items.",
    });
  };

  const saveLineItemFixes = async () => {
    const itemsWithIds = questionableItems.filter((item) => item.line_item_id);
    if (itemsWithIds.length === 0) {
      toast({
        title: "No persisted line items found",
        description: "These edits are in preview only. Re-extract to persist line items first.",
        variant: "destructive",
      });
      return;
    }

    setSavingFixes(true);
    try {
      for (const item of itemsWithIds) {
        await (supabase as any)
          .from("estimate_line_items")
          .update({
            description: item.description,
            category: item.category,
            quantity: item.quantity,
            unit: item.unit,
            unit_price: item.unit_cost,
            rcv: item.total,
            acv: item.total,
          })
          .eq("id", item.line_item_id);
      }

      const nextQuestionable = extractedData
        ? recomputeQuestionableItems(extractedData.line_items, questionableItems)
        : [];
      setQuestionableItems(nextQuestionable);
      syncQuestionableToExtractedData(nextQuestionable);
      queryClient.invalidateQueries({ queryKey: ["claim-estimates", claimId] });
      queryClient.invalidateQueries({ queryKey: ["estimate-line-items", claimId] });
      toast({
        title: "Line item fixes saved",
        description: `Saved fixes for ${itemsWithIds.length} line item(s).`,
      });
    } catch (err) {
      console.error("Failed to save estimate line item fixes:", err);
      toast({
        title: "Failed to save fixes",
        description: "Please try again or re-run extraction.",
        variant: "destructive",
      });
    } finally {
      setSavingFixes(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Upload Estimate
          </DialogTitle>
          <DialogDescription>
            Upload an estimate (Xactimate, Symbility, or contractor estimate) and the financial figures will be automatically extracted and populated into accounting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* File Upload */}
          <div className="space-y-2">
            <Label htmlFor="estimate-file">Select Estimate File</Label>
            <Input
              id="estimate-file"
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.tiff,.tif"
              onChange={handleFileChange}
              disabled={isProcessing}
            />
            <p className="text-xs text-muted-foreground">
              Supported formats: PDF, PNG, JPG, TIFF
            </p>
          </div>

          {/* Error Alert */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Processing Status */}
          {isProcessing && (
            <div className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <div>
                <p className="font-medium">Processing estimate...</p>
                <p className="text-sm text-muted-foreground">
                  AI is extracting financial figures from your document
                </p>
              </div>
            </div>
          )}

          {extractionSteps.length > 0 && (
            <div className="rounded-lg border p-3 bg-muted/20 space-y-2">
              <div className="text-sm font-medium">Darwin extraction steps</div>
              <div className="space-y-1.5">
                {extractionSteps.map((step, idx) => (
                  <div key={`${step.key}-${idx}`} className="flex items-start justify-between gap-2 text-xs">
                    <div>
                      <div className="font-medium">{step.label}</div>
                      {step.detail && <div className="text-muted-foreground">{step.detail}</div>}
                    </div>
                    {typeof step.durationMs === "number" && (
                      <div className="text-muted-foreground whitespace-nowrap">
                        {(step.durationMs / 1000).toFixed(step.durationMs >= 10000 ? 0 : 1)}s
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Extracted Data Preview */}
          {extractedData && (
            <div className="space-y-4">
              <Alert className="border-primary/30 bg-primary/10">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                <AlertDescription>
                  Successfully extracted data from {extractedData.estimate_type || "estimate"}
                </AlertDescription>
              </Alert>

              <div className="grid gap-4 md:grid-cols-2">
                {/* Dwelling */}
                <div className="p-4 border rounded-lg space-y-2">
                  <h4 className="font-semibold">Dwelling</h4>
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">RCV:</span>
                      <span>{formatCurrency(extractedData.dwelling?.rcv)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Recoverable Dep:</span>
                      <span>{formatCurrency(extractedData.dwelling?.recoverable_depreciation)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Non-Rec Dep:</span>
                      <span>{formatCurrency(extractedData.dwelling?.non_recoverable_depreciation)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Deductible:</span>
                      <span>{formatCurrency(extractedData.dwelling?.deductible)}</span>
                    </div>
                  </div>
                </div>

                {/* Other Structures */}
                <div className="p-4 border rounded-lg space-y-2">
                  <h4 className="font-semibold">Other Structures</h4>
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">RCV:</span>
                      <span>{formatCurrency(extractedData.other_structures?.rcv)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Recoverable Dep:</span>
                      <span>{formatCurrency(extractedData.other_structures?.recoverable_depreciation)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Non-Rec Dep:</span>
                      <span>{formatCurrency(extractedData.other_structures?.non_recoverable_depreciation)}</span>
                    </div>
                  </div>
                </div>

                {/* Contents */}
                <div className="p-4 border rounded-lg space-y-2">
                  <h4 className="font-semibold">Personal Property</h4>
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">RCV:</span>
                      <span>{formatCurrency(extractedData.contents?.rcv)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Recoverable Dep:</span>
                      <span>{formatCurrency(extractedData.contents?.recoverable_depreciation)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Non-Rec Dep:</span>
                      <span>{formatCurrency(extractedData.contents?.non_recoverable_depreciation)}</span>
                    </div>
                  </div>
                </div>

                {/* Paid When Incurred / Ordinance and Law */}
                <div className="p-4 border rounded-lg space-y-2">
                  <h4 className="font-semibold">Ordinance & Law (Paid When Incurred)</h4>
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">RCV:</span>
                      <span>{formatCurrency(extractedData.pwi?.rcv)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Recoverable Dep:</span>
                      <span>{formatCurrency(extractedData.pwi?.recoverable_depreciation)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Non-Rec Dep:</span>
                      <span>{formatCurrency(extractedData.pwi?.non_recoverable_depreciation)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Totals Summary */}
              <div className="p-4 border rounded-lg space-y-2 bg-muted/30">
                <h4 className="font-semibold">Totals</h4>
                <div className="text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Gross Total:</span>
                    <span className="font-medium">{formatCurrency(extractedData.totals?.gross_total)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total Depreciation:</span>
                    <span>{formatCurrency(extractedData.totals?.total_depreciation)}</span>
                  </div>
                  <div className="flex justify-between border-t pt-1 mt-1">
                    <span className="font-medium">Net Total:</span>
                    <span className="font-semibold text-primary">{formatCurrency(extractedData.totals?.net_total)}</span>
                  </div>
                </div>
              </div>

              {/* Line Items Preview */}
              {extractedData.line_items && extractedData.line_items.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-semibold">Line Items ({extractedData.line_items.length})</h4>
                  <div className="max-h-40 overflow-y-auto border rounded-lg">
                    <table className="w-full text-sm">
                      <thead className="bg-muted sticky top-0">
                        <tr>
                          <th className="text-left p-2">Description</th>
                          <th className="text-right p-2">Qty</th>
                          <th className="text-right p-2">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {extractedData.line_items.slice(0, 10).map((item, idx) => (
                          <tr key={idx} className="border-t">
                            <td className="p-2 truncate max-w-[200px]">{item.description}</td>
                            <td className="p-2 text-right">{item.quantity} {item.unit}</td>
                            <td className="p-2 text-right">{formatCurrency(item.total)}</td>
                          </tr>
                        ))}
                        {extractedData.line_items.length > 10 && (
                          <tr className="border-t bg-muted/30">
                            <td colSpan={3} className="p-2 text-center text-muted-foreground">
                              +{extractedData.line_items.length - 10} more items
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {extractedData.quality_review && (
                <div className="space-y-3 border rounded-lg p-3 bg-muted/20">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="font-semibold">Line Item Review</h4>
                      <p className="text-xs text-muted-foreground">
                        {extractedData.review_prompt || "Review questionable line items before finalizing."}
                      </p>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Persisted estimate: {extractedData.estimate_record ? `v${extractedData.estimate_record.version}` : "preview only"}
                    </div>
                  </div>

                  {questionableItems.length > 0 ? (
                    <div className="space-y-3">
                      <Alert className="border-amber-300 bg-amber-50">
                        <AlertCircle className="h-4 w-4 text-amber-600" />
                        <AlertDescription className="text-amber-800">
                          Darwin flagged {questionableItems.length} questionable line item(s). Review and fix below.
                        </AlertDescription>
                      </Alert>

                      <div className="max-h-64 overflow-y-auto space-y-3 pr-1">
                        {questionableItems.map((item, idx) => (
                          <div key={`${item.index}-${idx}`} className="border rounded-md p-3 bg-background space-y-2">
                            <div className="text-xs font-medium text-muted-foreground">
                              Item #{item.index + 1}
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                              <Input
                                value={item.description}
                                onChange={(e) => handleQuestionableChange(idx, "description", e.target.value)}
                                placeholder="Description"
                              />
                              <Input
                                value={item.category}
                                onChange={(e) => handleQuestionableChange(idx, "category", e.target.value)}
                                placeholder="Category"
                              />
                              <Input
                                type="number"
                                value={item.quantity}
                                onChange={(e) => handleQuestionableChange(idx, "quantity", e.target.value)}
                                placeholder="Qty"
                              />
                              <Input
                                value={item.unit}
                                onChange={(e) => handleQuestionableChange(idx, "unit", e.target.value)}
                                placeholder="Unit"
                              />
                              <Input
                                type="number"
                                value={item.unit_cost}
                                onChange={(e) => handleQuestionableChange(idx, "unit_cost", e.target.value)}
                                placeholder="Unit Cost"
                              />
                              <Input
                                type="number"
                                value={item.total}
                                onChange={(e) => handleQuestionableChange(idx, "total", e.target.value)}
                                placeholder="Total"
                              />
                            </div>
                            {item.reasons.length > 0 && (
                              <ul className="text-xs text-amber-700 list-disc pl-4 space-y-0.5">
                                {item.reasons.map((reason, reasonIdx) => (
                                  <li key={reasonIdx}>{reason}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>

                      <div className="flex flex-wrap justify-end gap-2">
                        <Button type="button" variant="outline" onClick={applySuggestedFixes}>
                          <Wand2 className="h-4 w-4 mr-2" />
                          Apply Suggested Fixes
                        </Button>
                        <Button type="button" onClick={saveLineItemFixes} disabled={savingFixes}>
                          {savingFixes ? (
                            <>
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                              Saving...
                            </>
                          ) : (
                            <>
                              <Save className="h-4 w-4 mr-2" />
                              Save Fixes
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Alert className="border-green-300 bg-green-50">
                      <CheckCircle2 className="h-4 w-4 text-green-700" />
                      <AlertDescription className="text-green-800">
                        No questionable line items remain. This estimate is ready.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={handleClose}>
              {extractedData ? "Close" : "Cancel"}
            </Button>
            {!extractedData && (
              <Button onClick={handleExtract} disabled={!file || isProcessing}>
                {isProcessing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 mr-2" />
                    Extract & Populate
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
