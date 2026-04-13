import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle, CheckCircle2, Eye, FileText, Trash2, Shield, Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PreviewLineItem {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  trade: string;
  depreciation_pct?: number;
  code_reference?: string | null;
  notes?: string | null;
}

interface ImportPreviewData {
  line_items: PreviewLineItem[];
  document_type: string;
  total_rcv: number | null;
  total_acv: number | null;
  extraction_confidence: number;
  extracted_text_source: string;
  extracted_text_preview?: string;
  warning_flags: string[];
  imported: number;
}

interface EstimateImportPreviewProps {
  open: boolean;
  onClose: () => void;
  data: ImportPreviewData;
  fileName: string;
  onConfirm: (items: PreviewLineItem[]) => void;
  confirming: boolean;
}

const SOURCE_LABELS: Record<string, string> = {
  clean_text: "Stored Clean Text",
  extracted_text: "Stored Extracted Text",
  multimodal_vision: "AI Vision (Multimodal)",
  plain_text: "Direct Text",
};

export function EstimateImportPreview({
  open, onClose, data, fileName, onConfirm, confirming,
}: EstimateImportPreviewProps) {
  const [items, setItems] = useState<PreviewLineItem[]>(data.line_items);
  const [showExtractedText, setShowExtractedText] = useState(false);
  const [editingText, setEditingText] = useState(data.extracted_text_preview || "");

  const confidenceLabel = data.extraction_confidence >= 0.75 ? "High" : data.extraction_confidence >= 0.45 ? "Medium" : "Low";
  const confidenceColor = data.extraction_confidence >= 0.75 ? "text-emerald-600 bg-emerald-500/15 border-emerald-500/30"
    : data.extraction_confidence >= 0.45 ? "text-amber-600 bg-amber-500/15 border-amber-500/30"
    : "text-red-600 bg-red-500/15 border-red-500/30";

  const removeItem = (index: number) => {
    setItems(prev => prev.filter((_, i) => i !== index));
  };

  const needsConfirmation = data.extraction_confidence < 0.75;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="h-4 w-4" />
            Import Preview — {fileName}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={cn("text-xs", confidenceColor)}>
              {confidenceLabel} Confidence ({Math.round(data.extraction_confidence * 100)}%)
            </Badge>
            <Badge variant="outline" className="text-xs">
              <FileText className="h-3 w-3 mr-1" />
              {SOURCE_LABELS[data.extracted_text_source] || data.extracted_text_source}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {data.document_type?.replace(/_/g, " ")}
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {items.length} items
            </Badge>
          </DialogDescription>
        </DialogHeader>

        {/* Warnings */}
        {data.warning_flags.length > 0 && (
          <Alert variant="destructive" className="py-2">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              {data.warning_flags.map((w, i) => <div key={i}>• {w}</div>)}
            </AlertDescription>
          </Alert>
        )}

        {/* Extracted text toggle */}
        {data.extracted_text_preview && (
          <div>
            <Button variant="ghost" size="sm" className="text-xs gap-1 h-6 mb-1"
              onClick={() => setShowExtractedText(!showExtractedText)}>
              <FileText className="h-3 w-3" />
              {showExtractedText ? "Hide" : "Show"} Extracted Text
            </Button>
            {showExtractedText && (
              <Textarea value={editingText} onChange={(e) => setEditingText(e.target.value)}
                className="text-xs font-mono h-32 resize-y" />
            )}
          </div>
        )}

        {/* Line items preview */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-1">
            <div className="grid grid-cols-[1fr_60px_50px_80px_80px_90px_28px] gap-1 px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b">
              <span>Description</span><span>Qty</span><span>Unit</span><span>Price</span><span>Total</span><span>Trade</span><span />
            </div>
            {items.map((item, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_60px_50px_80px_80px_90px_28px] gap-1 px-2 py-1.5 text-xs items-center hover:bg-muted/30 rounded group">
                <span className="truncate" title={item.description}>{item.description}</span>
                <span>{item.quantity}</span>
                <span className="text-muted-foreground">{item.unit}</span>
                <span>${item.unit_price.toFixed(2)}</span>
                <span className="font-medium">${(item.quantity * item.unit_price).toFixed(2)}</span>
                <Badge variant="outline" className="text-[9px] h-5 justify-center">{item.trade}</Badge>
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                  onClick={() => removeItem(idx)}>
                  <Trash2 className="h-3 w-3 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>

        {/* Totals */}
        <div className="flex items-center justify-between px-2 py-2 border-t text-xs">
          <span className="text-muted-foreground">{items.length} line items</span>
          <span className="font-semibold">
            Total: ${items.reduce((s, i) => s + i.quantity * i.unit_price, 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
        </div>

        {/* Low confidence confirmation */}
        {needsConfirmation && (
          <Alert className="py-2 border-amber-500/30 bg-amber-500/5">
            <Shield className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-xs text-amber-700">
              Extraction confidence is below 75%. Please review items carefully before importing.
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={confirming}>Cancel</Button>
          <Button onClick={() => onConfirm(items)} disabled={confirming || items.length === 0}>
            {confirming ? (
              <><Sparkles className="h-3 w-3 animate-spin mr-1" /> Importing...</>
            ) : (
              <><CheckCircle2 className="h-3 w-3 mr-1" /> Import {items.length} Items</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
