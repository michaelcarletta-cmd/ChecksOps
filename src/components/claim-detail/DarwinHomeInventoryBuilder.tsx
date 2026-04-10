import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { Package, Plus, Camera, ClipboardList, BarChart3, FileUp, Receipt } from "lucide-react";
import { toast } from "sonner";
import { InventoryPhotoScanner } from "./inventory/InventoryPhotoScanner";
import { InventoryTable } from "./inventory/InventoryTable";
import { InventorySummary } from "./inventory/InventorySummary";
import { InventoryPDFImport } from "./inventory/InventoryPDFImport";
import { InventoryReceiptScanner } from "./inventory/InventoryReceiptScanner";

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
  damage_description: string | null;
  manufacturer: string | null;
  model_number: string | null;
  is_total_loss: boolean;
  notes: string | null;
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

interface DarwinHomeInventoryBuilderProps {
  claimId: string;
  claim: any;
}

const COMMON_ROOMS = [
  "Living Room", "Kitchen", "Master Bedroom", "Bedroom 2", "Bedroom 3",
  "Bathroom", "Master Bathroom", "Dining Room", "Garage", "Basement",
  "Attic", "Laundry Room", "Office/Den", "Patio/Deck", "Shed/Outbuilding",
];

const CONDITIONS = [
  { value: "new", label: "New/Like New" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
  { value: "poor", label: "Poor" },
];

export const DarwinHomeInventoryBuilder = ({ claimId, claim }: DarwinHomeInventoryBuilderProps) => {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    room_name: "",
    item_name: "",
    item_description: "",
    quantity: "1",
    original_purchase_price: "",
    replacement_cost: "",
    condition_before_loss: "good",
    damage_description: "",
    manufacturer: "",
    model_number: "",
    is_total_loss: true,
    notes: "",
  });

  const fetchItems = async () => {
    const { data, error } = await supabase
      .from("claim_home_inventory")
      .select("*")
      .eq("claim_id", claimId)
      .order("room_name", { ascending: true });

    if (error) {
      console.error("Error fetching inventory:", error);
    } else {
      setItems((data as any[]) || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchItems();
  }, [claimId]);

  const handleAddItem = async () => {
    if (!formData.room_name || !formData.item_name) {
      toast.error("Please fill in room and item name");
      return;
    }

    // Duplicate detection: same room + item name (case-insensitive)
    const duplicate = items.find(
      (i) =>
        i.room_name.toLowerCase() === formData.room_name.toLowerCase() &&
        i.item_name.toLowerCase() === formData.item_name.toLowerCase()
    );
    if (duplicate) {
      const confirmed = window.confirm(
        `Possible duplicate: "${formData.item_name}" in "${formData.room_name}" already exists in the inventory.\n\nDo you still want to add it?`
      );
      if (!confirmed) return;
      toast.warning("Duplicate item added — please verify");
    }

    const { data: userData } = await supabase.auth.getUser();

    const { error } = await supabase.from("claim_home_inventory").insert({
      claim_id: claimId,
      room_name: formData.room_name,
      item_name: formData.item_name,
      item_description: formData.item_description || null,
      quantity: parseInt(formData.quantity) || 1,
      original_purchase_price: formData.original_purchase_price ? parseFloat(formData.original_purchase_price) : null,
      replacement_cost: formData.replacement_cost ? parseFloat(formData.replacement_cost) : null,
      condition_before_loss: formData.condition_before_loss,
      damage_description: formData.damage_description || null,
      manufacturer: formData.manufacturer || null,
      model_number: formData.model_number || null,
      is_total_loss: formData.is_total_loss,
      notes: formData.notes || null,
      source: "manual",
      created_by: userData.user?.id,
    } as any);

    if (error) {
      toast.error("Failed to add item");
      console.error(error);
    } else {
      toast.success("Item added to inventory");
      setFormData({
        room_name: formData.room_name,
        item_name: "",
        item_description: "",
        quantity: "1",
        original_purchase_price: "",
        replacement_cost: "",
        condition_before_loss: "good",
        damage_description: "",
        manufacturer: "",
        model_number: "",
        is_total_loss: true,
        notes: "",
      });
      fetchItems();
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5 text-orange-600" />
              Home Inventory Builder
            </CardTitle>
            <CardDescription>
              AI-powered photo scanning & manual entry for contents claims
            </CardDescription>
          </div>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="h-4 w-4 mr-1" /> Add Item
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Add Inventory Item</DialogTitle>
              </DialogHeader>
              <ScrollArea className="max-h-[70vh]">
                <div className="space-y-4 pr-4">
                  <div className="space-y-2">
                    <Label>Room *</Label>
                    <Select value={formData.room_name} onValueChange={(v) => setFormData({ ...formData, room_name: v })}>
                      <SelectTrigger><SelectValue placeholder="Select room" /></SelectTrigger>
                      <SelectContent>
                        {COMMON_ROOMS.map((room) => (
                          <SelectItem key={room} value={room}>{room}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Item Name *</Label>
                    <Input placeholder='e.g., Samsung 55" Smart TV' value={formData.item_name} onChange={(e) => setFormData({ ...formData, item_name: e.target.value })} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Manufacturer</Label>
                      <Input placeholder="Samsung" value={formData.manufacturer} onChange={(e) => setFormData({ ...formData, manufacturer: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Model #</Label>
                      <Input placeholder="UN55TU7000" value={formData.model_number} onChange={(e) => setFormData({ ...formData, model_number: e.target.value })} />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>Quantity</Label>
                      <Input type="number" min="1" value={formData.quantity} onChange={(e) => setFormData({ ...formData, quantity: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Original Price</Label>
                      <Input type="number" step="0.01" placeholder="0.00" value={formData.original_purchase_price} onChange={(e) => setFormData({ ...formData, original_purchase_price: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Replacement Cost</Label>
                      <Input type="number" step="0.01" placeholder="0.00" value={formData.replacement_cost} onChange={(e) => setFormData({ ...formData, replacement_cost: e.target.value })} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Condition Before Loss</Label>
                    <Select value={formData.condition_before_loss} onValueChange={(v) => setFormData({ ...formData, condition_before_loss: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CONDITIONS.map((cond) => (
                          <SelectItem key={cond.value} value={cond.value}>{cond.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Damage Description</Label>
                    <Textarea placeholder="Describe the damage..." value={formData.damage_description} onChange={(e) => setFormData({ ...formData, damage_description: e.target.value })} />
                  </div>
                  <Button onClick={handleAddItem} className="w-full">Add to Inventory</Button>
                </div>
              </ScrollArea>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="scan" className="w-full" orientation="vertical">
          <div className="flex flex-col md:flex-row gap-4">
            <TabsList className="flex md:flex-col flex-row h-auto items-stretch bg-muted/50 p-1 rounded-lg md:w-44 shrink-0 gap-1 overflow-x-auto">
              <TabsTrigger value="scan" className="justify-start gap-2 w-full text-xs md:text-sm">
                <Camera className="h-4 w-4 shrink-0" /> <span className="hidden md:inline">Scan Photos</span><span className="md:hidden">Scan</span>
              </TabsTrigger>
              <TabsTrigger value="pdf" className="justify-start gap-2 w-full text-xs md:text-sm">
                <FileUp className="h-4 w-4 shrink-0" /> <span className="hidden md:inline">Import PDF</span><span className="md:hidden">PDF</span>
              </TabsTrigger>
              <TabsTrigger value="receipts" className="justify-start gap-2 w-full text-xs md:text-sm">
                <Receipt className="h-4 w-4 shrink-0" /> <span className="hidden md:inline">Receipts</span><span className="md:hidden">Receipts</span>
              </TabsTrigger>
              <TabsTrigger value="inventory" className="justify-start gap-2 w-full text-xs md:text-sm">
                <ClipboardList className="h-4 w-4 shrink-0" /> <span className="hidden md:inline">Inventory ({items.length})</span><span className="md:hidden">({items.length})</span>
              </TabsTrigger>
              <TabsTrigger value="summary" className="justify-start gap-2 w-full text-xs md:text-sm">
                <BarChart3 className="h-4 w-4 shrink-0" /> Summary
              </TabsTrigger>
            </TabsList>

            <div className="flex-1 min-w-0">
              <TabsContent value="scan" className="mt-0">
                <InventoryPhotoScanner claimId={claimId} onItemsAdded={fetchItems} />
              </TabsContent>

              <TabsContent value="pdf" className="mt-0">
                <InventoryPDFImport claimId={claimId} onItemsAdded={fetchItems} />
              </TabsContent>

              <TabsContent value="receipts" className="mt-0">
                <InventoryReceiptScanner claimId={claimId} onItemsAdded={fetchItems} />
              </TabsContent>

              <TabsContent value="inventory" className="mt-0">
                <InventoryTable items={items} loading={loading} onRefresh={fetchItems} claimId={claimId} />
              </TabsContent>

              <TabsContent value="summary" className="mt-0">
                <InventorySummary items={items} claimId={claimId} />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </CardContent>
    </Card>
  );
};
