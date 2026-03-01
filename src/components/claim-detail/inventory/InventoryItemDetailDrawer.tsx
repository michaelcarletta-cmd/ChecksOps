import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Progress } from "@/components/ui/progress";
import {
  Package, Calendar, Clock, ShieldCheck, Tag, Hash, Ruler,
  AlertTriangle, Camera, FileText, Bot, User,
} from "lucide-react";

interface EvidenceEntry {
  type: string;
  weight: number;
  date?: string;
  source?: string;
  snippet?: string;
  file_id?: string;
  brand?: string;
  serial?: string;
  model?: string;
  rule_used?: string;
  release_year?: number;
}

interface InventoryItem {
  id: string;
  room_name: string;
  item_name: string;
  item_description: string | null;
  quantity: number;
  original_purchase_price: number | null;
  replacement_cost: number | null;
  actual_cash_value: number | null;
  condition_before_loss: string | null;
  manufacturer: string | null;
  model_number: string | null;
  is_total_loss: boolean;
  source?: string;
  ai_confidence?: number;
  category?: string;
  depreciation_rate?: number;
  age_years?: number;
  purchase_date_best?: string | null;
  purchase_date_low?: string | null;
  purchase_date_high?: string | null;
  age_confidence_score?: number;
  evidence_json?: EvidenceEntry[];
  needs_age_review?: boolean;
}

interface InventoryItemDetailDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: InventoryItem | null;
  onBoostClick: () => void;
}

const CONDITIONS: Record<string, string> = {
  new: "New / Like New",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

const evidenceIcon = (type: string) => {
  switch (type) {
    case "receipt": return "📄";
    case "serial_decode": return "🔢";
    case "model_release": return "📅";
    case "user_entered": return "✏️";
    case "warranty": return "🛡️";
    case "category_prior": return "📊";
    case "document_match": return "📄";
    case "label_photo": return "🏷️";
    case "label_serial_ocr": return "🔍";
    case "label_model_ocr": return "🔍";
    default: return "📎";
  }
};

const evidenceLabel = (type: string) => {
  switch (type) {
    case "receipt": return "Receipt / Invoice";
    case "serial_decode": return "Serial Number Decode";
    case "model_release": return "Model Release Year";
    case "user_entered": return "User Confirmed";
    case "warranty": return "Warranty Registration";
    case "category_prior": return "Category Lifecycle Estimate";
    case "document_match": return "Document Match";
    case "label_photo": return "Label Photo Analysis";
    case "label_serial_ocr": return "Label Serial OCR";
    case "label_model_ocr": return "Label Model OCR";
    default: return type;
  }
};

export const InventoryItemDetailDrawer = ({
  open,
  onOpenChange,
  item,
  onBoostClick,
}: InventoryItemDetailDrawerProps) => {
  if (!item) return null;

  const confidence = item.age_confidence_score ?? 0;
  const evidence = (item.evidence_json || []) as EvidenceEntry[];
  const hasAge = item.age_years != null;
  const purchaseYear = item.purchase_date_best
    ? new Date(item.purchase_date_best).getFullYear()
    : null;
  const rangeLow = item.purchase_date_low
    ? new Date(item.purchase_date_low).getFullYear()
    : null;
  const rangeHigh = item.purchase_date_high
    ? new Date(item.purchase_date_high).getFullYear()
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-lg">
            <Package className="h-5 w-5 text-primary" />
            {item.item_name}
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-5 mt-4">
          {/* Item info */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Room</p>
              <p className="font-medium">{item.room_name}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Category</p>
              <p className="font-medium">{item.category || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Brand</p>
              <p className="font-medium">{item.manufacturer || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Model</p>
              <p className="font-medium">{item.model_number || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Condition</p>
              <p className="font-medium">{CONDITIONS[item.condition_before_loss || ""] || item.condition_before_loss || "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Source</p>
              <Badge variant="outline" className="text-xs gap-1">
                {item.source === "ai_photo_scan" ? (
                  <><Bot className="h-3 w-3" /> AI Scan</>
                ) : (
                  <><User className="h-3 w-3" /> Manual</>
                )}
              </Badge>
            </div>
          </div>

          {/* Pricing */}
          <div className="bg-muted/50 rounded-lg p-3">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-xs text-muted-foreground">Qty</p>
                <p className="text-lg font-bold">{item.quantity}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">RCV</p>
                <p className="text-lg font-bold text-primary">
                  {item.replacement_cost ? `$${(item.replacement_cost * item.quantity).toLocaleString()}` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">ACV</p>
                <p className="text-lg font-bold">
                  {item.actual_cash_value ? `$${(item.actual_cash_value * item.quantity).toLocaleString()}` : "—"}
                </p>
              </div>
            </div>
            {item.depreciation_rate && item.age_years ? (
              <p className="text-xs text-muted-foreground text-center mt-1">
                Depreciation: {Math.round(item.depreciation_rate * 100)}%/yr × {item.age_years} yr
              </p>
            ) : null}
          </div>

          <Separator />

          {/* Age determination section */}
          <div className="space-y-3">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Clock className="h-4 w-4" /> Age Determination
            </h3>

            {hasAge ? (
              <div className="bg-muted/30 border rounded-lg p-4 space-y-3">
                {/* Main age display */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-2xl font-bold">~{item.age_years} yr{item.age_years !== 1 ? "s" : ""}</p>
                    {purchaseYear && (
                      <p className="text-sm text-muted-foreground">
                        Likely purchased: ~{purchaseYear}
                        {rangeLow && rangeHigh && rangeLow !== rangeHigh && (
                          <span className="ml-1">(±{Math.ceil((rangeHigh - rangeLow) / 2)} yr{Math.ceil((rangeHigh - rangeLow) / 2) !== 1 ? "s" : ""})</span>
                        )}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <Badge
                      variant={confidence >= 80 ? "default" : confidence >= 60 ? "secondary" : "destructive"}
                      className="text-sm px-3 py-1"
                    >
                      {confidence}%
                    </Badge>
                    <p className="text-xs text-muted-foreground mt-1">Confidence</p>
                  </div>
                </div>

                {/* Confidence bar */}
                <Progress value={confidence} className="h-2" />

                {/* Range */}
                {rangeLow && rangeHigh && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Ruler className="h-3 w-3" />
                    Age range: {rangeLow}–{rangeHigh}
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-muted/30 border border-dashed rounded-lg p-4 text-center text-sm text-muted-foreground">
                <Clock className="h-6 w-6 mx-auto mb-2 opacity-50" />
                No age data yet — run the resolver or add evidence.
              </div>
            )}

            {/* Low confidence warning */}
            {confidence > 0 && confidence < 60 && (
              <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 rounded-md p-3">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Low confidence — needs receipt or label photo.</p>
                  <p className="text-xs mt-0.5 opacity-80">
                    Add a receipt, warranty doc, or snap a photo of the product label to improve accuracy.
                  </p>
                </div>
              </div>
            )}

            {/* Boost button */}
            {confidence < 80 && (
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2"
                onClick={onBoostClick}
              >
                <ShieldCheck className="h-4 w-4" />
                {confidence < 60 ? "Boost Confidence" : "Add More Evidence"}
              </Button>
            )}
          </div>

          <Separator />

          {/* Evidence chain */}
          <div className="space-y-3">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <FileText className="h-4 w-4" /> Evidence Chain
              {evidence.length > 0 && (
                <Badge variant="secondary" className="text-xs">{evidence.length}</Badge>
              )}
            </h3>

            {evidence.length > 0 ? (
              <div className="space-y-2">
                {evidence
                  .sort((a, b) => (b.weight || 0) - (a.weight || 0))
                  .map((ev, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-3 p-3 rounded-md bg-muted/30 border text-sm"
                    >
                      <span className="text-lg">{evidenceIcon(ev.type)}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm">{evidenceLabel(ev.type)}</p>
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            +{ev.weight}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{ev.source}</p>
                        {ev.date && (
                          <p className="text-xs mt-0.5">
                            <Calendar className="h-3 w-3 inline mr-1" />
                            {ev.date}
                          </p>
                        )}
                        {ev.snippet && (
                          <p className="text-xs text-muted-foreground mt-1 italic truncate">
                            "{ev.snippet}"
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                No evidence collected yet.
              </p>
            )}
          </div>

          {/* Description */}
          {item.item_description && (
            <>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground mb-1">Description</p>
                <p className="text-sm">{item.item_description}</p>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
