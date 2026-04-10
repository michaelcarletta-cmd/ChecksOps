import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Trash2, CheckCircle2, AlertTriangle, Bot, User, Pencil, Save, X, Search, ShieldQuestion, Camera, ShieldCheck, RefreshCw, Receipt, ArrowRightLeft, FileUp } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { BoostAgeConfidenceDialog } from "./BoostAgeConfidenceDialog";
import { InventoryItemDetailDrawer } from "./InventoryItemDetailDrawer";

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
  brand_confirmed?: boolean;
  model_confirmed?: boolean;
  price_confirmed?: boolean;
  pricing_source?: string;
  pricing_rationale?: string;
  category?: string;
  needs_review?: boolean;
  depreciation_rate?: number;
  age_years?: number;
  purchase_date_best?: string | null;
  purchase_date_low?: string | null;
  purchase_date_high?: string | null;
  age_confidence_score?: number;
  evidence_json?: EvidenceEntry[];
  needs_age_review?: boolean;
}

const CONDITIONS: Record<string, string> = {
  new: "New/Like New",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

const COMMON_ROOMS = [
  "Living Room", "Kitchen", "Master Bedroom", "Bedroom 2", "Bedroom 3",
  "Bathroom", "Master Bathroom", "Dining Room", "Garage", "Basement",
  "Attic", "Laundry Room", "Office/Den", "Patio/Deck", "Shed/Outbuilding", "Unassigned",
];

interface InventoryTableProps {
  items: InventoryItem[];
  loading: boolean;
  onRefresh: () => void;
  claimId?: string;
}

export const InventoryTable = ({ items, loading, onRefresh, claimId }: InventoryTableProps) => {
  const [boostItem, setBoostItem] = useState<InventoryItem | null>(null);
  const [detailItem, setDetailItem] = useState<InventoryItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [resolvingAll, setResolvingAll] = useState(false);
  const [editData, setEditData] = useState<{
    item_name: string;
    room_name: string;
    quantity: string;
    replacement_cost: string;
    actual_cash_value: string;
  }>({ item_name: "", room_name: "", quantity: "1", replacement_cost: "", actual_cash_value: "" });

  const filteredItems = items.filter((item) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      item.item_name.toLowerCase().includes(q) ||
      item.room_name.toLowerCase().includes(q) ||
      (item.manufacturer?.toLowerCase().includes(q) ?? false) ||
      (item.model_number?.toLowerCase().includes(q) ?? false) ||
      (item.category?.toLowerCase().includes(q) ?? false)
    );
  });

  const startEdit = (item: InventoryItem) => {
    setEditingId(item.id);
    setEditData({
      item_name: item.item_name,
      room_name: item.room_name,
      quantity: String(item.quantity),
      replacement_cost: item.replacement_cost != null ? String(item.replacement_cost) : "",
      actual_cash_value: item.actual_cash_value != null ? String(item.actual_cash_value) : "",
    });
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = async () => {
    if (!editingId) return;
    const { error } = await supabase
      .from("claim_home_inventory")
      .update({
        item_name: editData.item_name,
        room_name: editData.room_name,
        quantity: parseInt(editData.quantity) || 1,
        replacement_cost: editData.replacement_cost ? parseFloat(editData.replacement_cost) : null,
        actual_cash_value: editData.actual_cash_value ? parseFloat(editData.actual_cash_value) : null,
      } as any)
      .eq("id", editingId);

    if (error) {
      toast.error("Failed to update item");
      console.error(error);
    } else {
      toast.success("Item updated");
      setEditingId(null);
      onRefresh();
    }
  };

  const deleteItem = async (id: string) => {
    const { error } = await supabase.from("claim_home_inventory").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete");
    } else {
      toast.success("Item removed");
      onRefresh();
    }
  };

  const resolveAllAges = async () => {
    if (!claimId) return;
    setResolvingAll(true);
    try {
      const { data, error } = await supabase.functions.invoke("resolve-item-age", {
        body: { claim_id: claimId },
      });
      if (error) throw error;
      toast.success(`Age resolved for ${data?.resolved || 0} items`);
      onRefresh();
    } catch (err: any) {
      toast.error("Failed to resolve ages: " + (err.message || "Unknown error"));
      console.error(err);
    } finally {
      setResolvingAll(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <p>No inventory items yet</p>
        <p className="text-sm">Use the Scan Photos tab or add items manually</p>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search items, rooms, manufacturers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          {claimId && (
            <Button
              variant="outline"
              size="sm"
              onClick={resolveAllAges}
              disabled={resolvingAll}
              className="shrink-0 gap-1.5"
            >
              <RefreshCw className={`h-4 w-4 ${resolvingAll ? "animate-spin" : ""}`} />
              {resolvingAll ? "Resolving..." : "Resolve All Ages"}
            </Button>
          )}
        </div>
        {searchQuery && (
          <p className="text-xs text-muted-foreground">
            Showing {filteredItems.length} of {items.length} items
          </p>
        )}
      <div className="border rounded-lg overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
             <TableHead>Source</TableHead>
              <TableHead>Room</TableHead>
              <TableHead>Item</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Qty</TableHead>
              <TableHead className="text-right">RCV</TableHead>
              <TableHead className="text-right">ACV</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead>Age</TableHead>
              <TableHead>Confidence</TableHead>
              <TableHead>Evidence</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredItems.map((item) => {
              const isEditing = editingId === item.id;
              return (
                <TableRow key={item.id} className={item.needs_review ? "bg-amber-50/50 dark:bg-amber-950/10" : ""}>
                  <TableCell>
                    {item.source === "ai_photo_scan" ? (
                      <Badge variant="secondary" className="text-xs gap-1">
                        <Bot className="h-3 w-3" /> AI
                      </Badge>
                    ) : item.source === "receipt" ? (
                      <Badge variant="secondary" className="text-xs gap-1 bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
                        <Receipt className="h-3 w-3" /> Receipt
                      </Badge>
                    ) : item.source === "ale_transfer" ? (
                      <Badge variant="secondary" className="text-xs gap-1 bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300">
                        <ArrowRightLeft className="h-3 w-3" /> From ALE
                      </Badge>
                    ) : item.source === "pdf_import" ? (
                      <Badge variant="secondary" className="text-xs gap-1 bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300">
                        <FileUp className="h-3 w-3" /> PDF
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs gap-1">
                        <User className="h-3 w-3" /> Manual
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {isEditing ? (
                      <Select value={editData.room_name} onValueChange={(v) => setEditData({ ...editData, room_name: v })}>
                        <SelectTrigger className="h-7 w-32 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {COMMON_ROOMS.map((r) => (
                            <SelectItem key={r} value={r}>{r}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="font-medium text-sm">{item.room_name}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {isEditing ? (
                      <Input
                        value={editData.item_name}
                        onChange={(e) => setEditData({ ...editData, item_name: e.target.value })}
                        className="h-7 text-xs w-40"
                      />
                    ) : (
                      <div
                        className="cursor-pointer hover:text-primary transition-colors"
                        onClick={() => setDetailItem(item)}
                      >
                        <p className="text-sm font-medium underline-offset-2 hover:underline">{item.item_name}</p>
                        {item.manufacturer && (
                          <p className="text-xs text-muted-foreground">
                            {item.manufacturer} {item.model_number}
                          </p>
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {item.category && <Badge variant="secondary" className="text-xs">{item.category}</Badge>}
                  </TableCell>
                  <TableCell>
                    {isEditing ? (
                      <Input
                        type="number"
                        min="1"
                        value={editData.quantity}
                        onChange={(e) => setEditData({ ...editData, quantity: e.target.value })}
                        className="h-7 text-xs w-16"
                      />
                    ) : (
                      item.quantity
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {isEditing ? (
                      <Input
                        type="number"
                        step="0.01"
                        value={editData.replacement_cost}
                        onChange={(e) => setEditData({ ...editData, replacement_cost: e.target.value })}
                        className="h-7 text-xs w-24 ml-auto"
                        placeholder="0.00"
                      />
                    ) : (
                      <span className="font-medium">
                        {item.replacement_cost ? `$${(item.replacement_cost * item.quantity).toLocaleString()}` : "—"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {isEditing ? (
                      <Input
                        type="number"
                        step="0.01"
                        value={editData.actual_cash_value}
                        onChange={(e) => setEditData({ ...editData, actual_cash_value: e.target.value })}
                        className="h-7 text-xs w-24 ml-auto"
                        placeholder="0.00"
                      />
                    ) : (
                      <div>
                        <span className="text-sm">
                          {item.actual_cash_value ? `$${(item.actual_cash_value * item.quantity).toLocaleString()}` : "—"}
                        </span>
                        {item.depreciation_rate && item.age_years ? (
                          <p className="text-xs text-muted-foreground">
                            {Math.round(item.depreciation_rate * 100)}%/yr × {item.age_years}yr
                          </p>
                        ) : null}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {CONDITIONS[item.condition_before_loss || ""] || item.condition_before_loss}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="text-sm whitespace-nowrap">
                          {item.age_years != null ? (
                            <>
                              <span className="font-medium">~{item.age_years} yr{item.age_years !== 1 ? "s" : ""}</span>
                              {item.purchase_date_best && (
                                <p className="text-xs text-muted-foreground">
                                  ~{new Date(item.purchase_date_best).getFullYear()}
                                </p>
                              )}
                            </>
                          ) : "—"}
                        </div>
                      </TooltipTrigger>
                      {item.purchase_date_low && item.purchase_date_high && (
                        <TooltipContent>
                          <p>Range: {new Date(item.purchase_date_low).getFullYear()}–{new Date(item.purchase_date_high).getFullYear()}</p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    {item.age_confidence_score != null ? (
                      <Badge
                        variant={item.age_confidence_score >= 60 ? "default" : "destructive"}
                        className="text-xs"
                      >
                        {item.age_confidence_score}%
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 max-w-[180px]">
                      {item.evidence_json && (item.evidence_json as EvidenceEntry[]).length > 0 ? (
                        (item.evidence_json as EvidenceEntry[]).map((ev, i) => (
                          <Tooltip key={i}>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className="text-[10px] cursor-help">
                                {ev.type === "receipt" ? "📄 Receipt" :
                                 ev.type === "serial_decode" ? "🔢 Serial" :
                                 ev.type === "model_release" ? "📅 Model Year" :
                                 ev.type === "user_entered" ? "✏️ User" :
                                 ev.type === "warranty" ? "🛡️ Warranty" :
                                 ev.type === "category_prior" ? "📊 Estimate" :
                                 ev.type === "document_match" ? "📄 Document" :
                                 ev.type === "label_photo" ? "🏷️ Label" :
                                 ev.type === "label_serial_ocr" ? "🔍 Label Serial" :
                                 ev.type === "label_model_ocr" ? "🔍 Label Model" :
                                 ev.type}
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs">
                              <p className="text-xs">{ev.source}</p>
                              {ev.date && <p className="text-xs text-muted-foreground">Date: {ev.date}</p>}
                            </TooltipContent>
                          </Tooltip>
                        ))
                      ) : (
                        item.needs_age_review ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px] gap-1 text-amber-600 border-amber-300 hover:bg-amber-50"
                            onClick={() => setBoostItem(item)}
                          >
                            <ShieldCheck className="h-3 w-3" /> Boost
                          </Button>
                        ) : item.age_confidence_score != null && item.age_confidence_score < 60 ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[10px] gap-1 text-muted-foreground"
                            onClick={() => setBoostItem(item)}
                          >
                            <Camera className="h-3 w-3" /> Add evidence
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {isEditing ? (
                        <>
                          <Button variant="ghost" size="sm" onClick={saveEdit}>
                            <Save className="h-4 w-4 text-green-600" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={cancelEdit}>
                            <X className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => startEdit(item)}>
                            <Pencil className="h-4 w-4 text-muted-foreground" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => deleteItem(item.id)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {boostItem && claimId && (
        <BoostAgeConfidenceDialog
          open={!!boostItem}
          onOpenChange={(open) => !open && setBoostItem(null)}
          item={{ ...boostItem, claim_id: claimId }}
          claimId={claimId}
          onBoosted={onRefresh}
        />
      )}

      <InventoryItemDetailDrawer
        open={!!detailItem}
        onOpenChange={(open) => !open && setDetailItem(null)}
        item={detailItem}
        onBoostClick={() => {
          if (detailItem) {
            setDetailItem(null);
            setBoostItem(detailItem);
          }
        }}
      />
      </div>
    </TooltipProvider>
  );
};
