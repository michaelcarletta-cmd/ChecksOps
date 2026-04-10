import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { Receipt, Upload, Loader2, Check, X, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface ExtractedItem {
  vendor_name: string | null;
  date: string | null;
  total: number | null;
  suggested_category: string | null;
  needs_review: boolean;
  selected: boolean;
}

interface InventoryReceiptScannerProps {
  claimId: string;
  onItemsAdded: () => void;
}

export const InventoryReceiptScanner = ({ claimId, onItemsAdded }: InventoryReceiptScannerProps) => {
  const [extractedItems, setExtractedItems] = useState<ExtractedItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fileName, setFileName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (file: File | null) => {
    if (!file) return;

    setFileName(file.name);
    setUploading(true);
    setExtractedItems([]);

    try {
      // Convert file to base64
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      const { data, error } = await supabase.functions.invoke("extract-receipt", {
        body: { imageBase64: base64, mimeType: file.type },
      });

      if (error) throw error;

      const receipts = data?.data?.receipts || [];
      if (receipts.length === 0) {
        toast.warning("No receipts detected in this image");
        return;
      }

      setExtractedItems(receipts.map((r: any) => ({ ...r, selected: true })));
      toast.success(`Found ${receipts.length} receipt(s)`);
    } catch (err: any) {
      console.error("Receipt extraction error:", err);
      toast.error(err.message || "Failed to extract receipt data");
    } finally {
      setUploading(false);
    }
  };

  const toggleItem = (idx: number) => {
    setExtractedItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, selected: !item.selected } : item))
    );
  };

  const updateItem = (idx: number, field: keyof ExtractedItem, value: any) => {
    setExtractedItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item))
    );
  };

  const handleSaveToInventory = async () => {
    const selected = extractedItems.filter((item) => item.selected && item.total != null);
    if (selected.length === 0) {
      toast.error("No items selected with valid totals");
      return;
    }

    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();

      const inserts = selected.map((item) => ({
        claim_id: claimId,
        room_name: "Contents",
        item_name: item.vendor_name || "Receipt Purchase",
        item_description: `Purchase from ${item.vendor_name || "Unknown"} on ${item.date || "unknown date"}`,
        quantity: 1,
        original_purchase_price: item.total,
        replacement_cost: item.total,
        original_purchase_date: item.date || null,
        condition_before_loss: "good",
        is_total_loss: true,
        category: item.suggested_category || "other",
        source: "receipt",
        ai_confidence: item.needs_review ? 60 : 90,
        needs_review: item.needs_review,
        notes: `Extracted from receipt: ${fileName}`,
        created_by: userData.user?.id,
      }));

      const { error } = await supabase.from("claim_home_inventory").insert(inserts as any);

      if (error) throw error;

      toast.success(`${selected.length} item(s) added to inventory`);
      setExtractedItems([]);
      setFileName("");
      if (fileRef.current) fileRef.current.value = "";
      onItemsAdded();
    } catch (err: any) {
      console.error("Save error:", err);
      toast.error("Failed to save items to inventory");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="border-2 border-dashed border-border rounded-lg p-6 text-center">
        <Receipt className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground mb-3">
          Upload a receipt photo or PDF to extract purchase details and add items to inventory
        </p>
        <div className="flex items-center justify-center gap-2">
          <Label
            htmlFor="receipt-upload"
            className="inline-flex cursor-pointer items-center rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Upload className="h-4 w-4 mr-2" />
            {uploading ? "Extracting..." : "Upload Receipt"}
          </Label>
          <Input
            id="receipt-upload"
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            disabled={uploading}
            onChange={(e) => handleFileSelect(e.target.files?.[0] || null)}
          />
        </div>
        {fileName && !uploading && (
          <p className="text-xs text-muted-foreground mt-2">File: {fileName}</p>
        )}
        {uploading && (
          <div className="flex items-center justify-center gap-2 mt-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Analyzing receipt with AI...
          </div>
        )}
      </div>

      {extractedItems.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium">Extracted Receipts ({extractedItems.length})</h4>
            <Button size="sm" onClick={handleSaveToInventory} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Check className="h-4 w-4 mr-1" />
              )}
              Add Selected to Inventory
            </Button>
          </div>

          <ScrollArea className="max-h-[400px]">
            <div className="space-y-2">
              {extractedItems.map((item, idx) => (
                <div
                  key={idx}
                  className={`border rounded-lg p-3 space-y-2 transition-colors ${
                    item.selected ? "border-primary/40 bg-primary/5" : "border-border opacity-60"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={item.selected}
                      onCheckedChange={() => toggleItem(idx)}
                      className="mt-1"
                    />
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Input
                          value={item.vendor_name || ""}
                          onChange={(e) => updateItem(idx, "vendor_name", e.target.value)}
                          placeholder="Vendor name"
                          className="h-8 text-sm max-w-[200px]"
                        />
                        <Input
                          type="date"
                          value={item.date || ""}
                          onChange={(e) => updateItem(idx, "date", e.target.value)}
                          className="h-8 text-sm w-[150px]"
                        />
                        <div className="flex items-center gap-1">
                          <span className="text-sm text-muted-foreground">$</span>
                          <Input
                            type="number"
                            step="0.01"
                            value={item.total ?? ""}
                            onChange={(e) =>
                              updateItem(idx, "total", e.target.value ? parseFloat(e.target.value) : null)
                            }
                            placeholder="Total"
                            className="h-8 text-sm w-[100px]"
                          />
                        </div>
                        {item.suggested_category && (
                          <Badge variant="outline" className="text-xs">
                            {item.suggested_category}
                          </Badge>
                        )}
                        {item.needs_review && (
                          <Badge variant="destructive" className="text-xs gap-1">
                            <AlertTriangle className="h-3 w-3" /> Review
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
};
