import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Trash2, CheckCircle2, AlertTriangle, Bot, User, Pencil, Save, X, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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
}

export const InventoryTable = ({ items, loading, onRefresh }: InventoryTableProps) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
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
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search items, rooms, manufacturers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
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
                      <div>
                        <p className="text-sm">{item.item_name}</p>
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
                    <span className="text-sm">
                      {item.age_years != null ? `~${item.age_years} yr${item.age_years !== 1 ? "s" : ""}` : "—"}
                    </span>
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
      </div>
    </TooltipProvider>
  );
};
