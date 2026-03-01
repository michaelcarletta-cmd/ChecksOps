import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";

import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { Camera, CheckCircle2, AlertTriangle, XCircle, Loader2, ScanSearch, Check, X, Filter, Upload, ImagePlus } from "lucide-react";
import { toast } from "sonner";

interface DetectedItem {
  label: string;
  confidence: number;
  bounding_box: { x: number; y: number; w: number; h: number };
  category: string;
  brand: string | null;
  model: string | null;
  brand_confidence: number;
  model_confidence: number;
  attributes: Record<string, string>;
  condition_estimate: string;
  rcv: number;
  acv: number;
  pricing_confidence: number;
  pricing_source: string;
  pricing_rationale: string;
  comparable_url: string | null;
  depreciation_rate: number;
  age_years: number;
  needs_review: boolean;
  source_photo_id: string;
  source_photo_name: string;
  // local state
  selected?: boolean;
  editing_label?: string;
  editing_brand?: string;
  editing_model?: string;
}

interface Photo {
  id: string;
  file_name: string;
  file_path: string;
  category: string | null;
}

interface InventoryPhotoScannerProps {
  claimId: string;
  onItemsAdded: () => void;
}

const CATEGORIES = ["All", "Electronics", "Furniture", "Appliances", "Clothing", "Kitchenware", "Decor", "Bedding", "Tools", "Sports", "Toys", "Other"];

const COMMON_ROOMS = [
  "Living Room", "Kitchen", "Master Bedroom", "Bedroom 2", "Bedroom 3",
  "Bathroom", "Master Bathroom", "Dining Room", "Garage", "Basement",
  "Attic", "Laundry Room", "Office/Den", "Patio/Deck", "Shed/Outbuilding",
];

type ScanStage = "idle" | "selecting" | "detecting" | "normalizing" | "pricing" | "results";

const confidenceBadge = (val: number) => {
  if (val >= 0.7) return <Badge className="bg-green-600 text-white text-xs"><CheckCircle2 className="h-3 w-3 mr-1" />{Math.round(val * 100)}%</Badge>;
  if (val >= 0.5) return <Badge className="bg-yellow-500 text-white text-xs"><AlertTriangle className="h-3 w-3 mr-1" />{Math.round(val * 100)}%</Badge>;
  return <Badge variant="destructive" className="text-xs"><XCircle className="h-3 w-3 mr-1" />{Math.round(val * 100)}%</Badge>;
};

export const InventoryPhotoScanner = ({ claimId, onItemsAdded }: InventoryPhotoScannerProps) => {
  const [stage, setStage] = useState<ScanStage>("idle");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>([]);
  const [detectedItems, setDetectedItems] = useState<DetectedItem[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [bulkRoom, setBulkRoom] = useState("");
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchPhotos();
  }, [claimId]);

  const fetchPhotos = async () => {
    const { data } = await supabase
      .from("claim_photos")
      .select("id, file_name, file_path, category")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false });
    setPhotos((data as Photo[]) || []);
  };

  const handleFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);

    try {
      const { data: userData } = await supabase.auth.getUser();
      let uploadedCount = 0;

      for (const file of Array.from(files)) {
        const fileExt = file.name.split('.').pop()?.toLowerCase();
        const fileName = `${crypto.randomUUID()}.${fileExt}`;
        const filePath = `${claimId}/inventory/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from("claim-files")
          .upload(filePath, file);

        if (uploadError) {
          console.error("Upload error:", uploadError);
          continue;
        }

        const { error: dbError } = await supabase
          .from("claim_photos")
          .insert({
            claim_id: claimId,
            file_path: filePath,
            file_name: file.name,
            file_size: file.size,
            category: "Contents / Personal Property",
            uploaded_by: userData.user?.id,
          });

        if (!dbError) uploadedCount++;
      }

      if (uploadedCount > 0) {
        toast.success(`Uploaded ${uploadedCount} photo(s)`);
        await fetchPhotos();
      }
    } catch (err: any) {
      toast.error("Upload failed: " + err.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  };

  const togglePhoto = (id: string) => {
    setSelectedPhotoIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const runPipeline = async () => {
    if (!selectedPhotoIds.length) {
      toast.error("Select at least one photo to scan");
      return;
    }

    setStage("detecting");
    setProgress(10);

    try {
      const { data: userData } = await supabase.auth.getUser();

      const { data: scanRun } = await supabase
        .from("inventory_scan_runs")
        .insert({
          claim_id: claimId,
          photo_ids: selectedPhotoIds,
          status: "pending",
          created_by: userData.user?.id,
        } as any)
        .select("id")
        .single();

      setProgress(20);
      setStage("normalizing");

      const { data, error } = await supabase.functions.invoke("inventory-photo-pipeline", {
        body: {
          claim_id: claimId,
          photo_ids: selectedPhotoIds,
          scan_run_id: scanRun?.id,
        },
      });

      if (error) throw error;

      setProgress(90);
      setStage("pricing");

      const items: DetectedItem[] = (data.items || []).map((item: any) => ({
        ...item,
        selected: !item.needs_review,
        editing_label: item.label,
        editing_brand: item.brand || "",
        editing_model: item.model || "",
      }));

      setDetectedItems(items);
      setProgress(100);
      setStage("results");
      toast.success(`Found ${items.length} items across ${selectedPhotoIds.length} photo(s)`);
    } catch (err: any) {
      console.error("Pipeline error:", err);
      toast.error("Scan failed: " + (err.message || "Unknown error"));
      setStage("idle");
    }
  };

  const toggleItem = (idx: number) => {
    setDetectedItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, selected: !item.selected } : item))
    );
  };

  const updateItem = (idx: number, field: string, value: string) => {
    setDetectedItems((prev) =>
      prev.map((item, i) => (i === idx ? { ...item, [field]: value } : item))
    );
  };

  const acceptAllConfirmed = () => {
    setDetectedItems((prev) =>
      prev.map((item) => ({ ...item, selected: !item.needs_review ? true : item.selected }))
    );
  };

  const selectAll = () => setDetectedItems((prev) => prev.map((item) => ({ ...item, selected: true })));
  const deselectAll = () => setDetectedItems((prev) => prev.map((item) => ({ ...item, selected: false })));

  const addToInventory = async () => {
    const selected = detectedItems.filter((i) => i.selected);
    if (!selected.length) {
      toast.error("No items selected");
      return;
    }

    const { data: userData } = await supabase.auth.getUser();
    const room = bulkRoom || "Unassigned";

    const inserts = selected.map((item) => ({
      claim_id: claimId,
      room_name: room,
      item_name: item.editing_label || item.label,
      item_description: Object.entries(item.attributes || {}).map(([k, v]) => `${k}: ${v}`).join(", ") || null,
      quantity: 1,
      replacement_cost: item.rcv,
      actual_cash_value: item.acv,
      condition_before_loss: item.condition_estimate,
      manufacturer: item.editing_brand || item.brand || null,
      model_number: item.editing_model || item.model || null,
      is_total_loss: true,
      source: "ai_photo_scan",
      ai_confidence: item.confidence,
      brand_confirmed: item.brand_confidence >= 0.7,
      model_confirmed: item.model_confidence >= 0.7,
      price_confirmed: item.pricing_confidence >= 0.7,
      pricing_source: item.pricing_source,
      pricing_rationale: item.pricing_rationale,
      comparable_url: item.comparable_url,
      category: item.category,
      attributes: item.attributes,
      source_photo_id: item.source_photo_id,
      needs_review: item.needs_review,
      depreciation_rate: item.depreciation_rate,
      age_years: item.age_years,
      created_by: userData.user?.id,
    }));

    const { error } = await supabase.from("claim_home_inventory").insert(inserts as any);

    if (error) {
      toast.error("Failed to add items");
      console.error(error);
    } else {
      toast.success(`Added ${selected.length} items to inventory`);
      setDetectedItems([]);
      setStage("idle");
      setSelectedPhotoIds([]);
      onItemsAdded();
    }
  };

  const filteredItems = categoryFilter === "All"
    ? detectedItems
    : detectedItems.filter((i) => i.category === categoryFilter);

  const selectedCount = detectedItems.filter((i) => i.selected).length;

  // Hidden file inputs
  const fileInputs = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => handleFileUpload(e.target.files)}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleFileUpload(e.target.files)}
      />
    </>
  );

  // IDLE / SELECTING
  if (stage === "idle" || stage === "selecting") {
    return (
      <div className="space-y-4">
        {fileInputs}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <ScanSearch className="h-4 w-4" />
            Select Photos to Scan
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => cameraInputRef.current?.click()}
              disabled={uploading}
            >
              <Camera className="h-4 w-4 mr-1" />
              Take Photo
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}
              Upload Photos
            </Button>
            <Button onClick={runPipeline} disabled={!selectedPhotoIds.length} size="sm">
              <ImagePlus className="h-4 w-4 mr-1" />
              Scan {selectedPhotoIds.length} Photo{selectedPhotoIds.length !== 1 ? "s" : ""}
            </Button>
          </div>
        </div>

        {photos.length === 0 ? (
          <div className="border-2 border-dashed border-border rounded-lg p-8 text-center space-y-3">
            <Camera className="h-10 w-10 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">
              No photos found. Take a photo or upload images to get started.
            </p>
            <div className="flex justify-center gap-2">
              <Button variant="outline" size="sm" onClick={() => cameraInputRef.current?.click()}>
                <Camera className="h-4 w-4 mr-1" /> Take Photo
              </Button>
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-4 w-4 mr-1" /> Upload
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {photos.map((photo) => {
              const isSelected = selectedPhotoIds.includes(photo.id);
              return (
                <div
                  key={photo.id}
                  onClick={() => togglePhoto(photo.id)}
                  className={`relative border-2 rounded-lg p-2 cursor-pointer transition-all ${
                    isSelected ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Checkbox checked={isSelected} />
                    <span className="text-xs truncate flex-1">{photo.file_name}</span>
                  </div>
                  {photo.category && photo.category !== "null" && (
                    <Badge variant="secondary" className="mt-1 text-xs">
                      {photo.category}
                    </Badge>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // PROCESSING
  if (stage === "detecting" || stage === "normalizing" || stage === "pricing") {
    const stageLabel = stage === "detecting" ? "Detecting items..." : stage === "normalizing" ? "Normalizing items..." : "Pricing items...";
    return (
      <div className="flex flex-col items-center py-12 space-y-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="font-medium">{stageLabel}</p>
        <Progress value={progress} className="w-64" />
        <p className="text-xs text-muted-foreground">
          Processing {selectedPhotoIds.length} photo{selectedPhotoIds.length !== 1 ? "s" : ""}...
        </p>
      </div>
    );
  }

  // RESULTS
  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b pb-3">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-40 h-8 text-xs">
              <SelectValue placeholder="Filter category" />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground whitespace-nowrap">Room:</span>
          <Select value={bulkRoom} onValueChange={setBulkRoom}>
            <SelectTrigger className="w-44 h-8 text-xs">
              <SelectValue placeholder="Select room..." />
            </SelectTrigger>
            <SelectContent>
              {COMMON_ROOMS.map((r) => (
                <SelectItem key={r} value={r}>{r}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex gap-1 ml-auto">
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={acceptAllConfirmed}>
            <Check className="h-3 w-3 mr-1" /> Accept Confirmed
          </Button>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={selectAll}>Select All</Button>
          <Button variant="outline" size="sm" className="text-xs h-7" onClick={deselectAll}>Clear</Button>
        </div>
      </div>

      {/* Items */}
      <div className="overflow-y-auto max-h-[60vh] border rounded-lg">
        <div className="space-y-2 p-2">
          {filteredItems.map((item, idx) => {
            const realIdx = detectedItems.indexOf(item);
            return (
              <div
                key={idx}
                className={`border rounded-lg p-3 transition-all ${
                  item.needs_review ? "border-amber-400 bg-amber-50/50 dark:bg-amber-950/20" : "border-border"
                } ${item.selected ? "ring-1 ring-primary" : ""}`}
              >
                {item.needs_review && (
                  <div className="flex items-center gap-1 mb-2 text-amber-600 text-xs font-medium">
                    <AlertTriangle className="h-3 w-3" />
                    Needs Review — Low confidence detected
                  </div>
                )}
                <div className="flex items-start gap-3">
                  <Checkbox
                    checked={item.selected}
                    onCheckedChange={() => toggleItem(realIdx)}
                    className="mt-1"
                  />
                  <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                    <div className="space-y-1">
                      <Input
                        value={item.editing_label}
                        onChange={(e) => updateItem(realIdx, "editing_label", e.target.value)}
                        className="h-7 text-xs font-medium"
                      />
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary" className="text-xs">{item.category}</Badge>
                        {confidenceBadge(item.confidence)}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Input
                        value={item.editing_brand || ""}
                        onChange={(e) => updateItem(realIdx, "editing_brand", e.target.value)}
                        placeholder="Brand"
                        className="h-7 text-xs"
                      />
                      <Input
                        value={item.editing_model || ""}
                        onChange={(e) => updateItem(realIdx, "editing_model", e.target.value)}
                        placeholder="Model"
                        className="h-7 text-xs"
                      />
                    </div>

                    <div className="flex items-center gap-3 text-xs flex-wrap">
                      <div>
                        <span className="text-muted-foreground">RCV:</span>{" "}
                        <span className="font-bold text-green-700 dark:text-green-400">${item.rcv.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">ACV:</span>{" "}
                        <span className="font-medium">${item.acv.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Age:</span>{" "}
                        <span className="font-medium">{item.age_years != null ? `~${item.age_years} yr${item.age_years !== 1 ? "s" : ""}` : "N/A"}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="outline" className="text-xs">{item.pricing_source}</Badge>
                      {confidenceBadge(item.pricing_confidence)}
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1 ml-8">{item.pricing_rationale}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between pt-3 border-t">
        <p className="text-sm text-muted-foreground">
          {selectedCount} of {detectedItems.length} items selected
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => { setStage("idle"); setDetectedItems([]); }}>
            <X className="h-4 w-4 mr-1" /> Cancel
          </Button>
          <Button onClick={addToInventory} disabled={!selectedCount}>
            <Check className="h-4 w-4 mr-1" /> Add {selectedCount} to Inventory
          </Button>
        </div>
      </div>
    </div>
  );
};
