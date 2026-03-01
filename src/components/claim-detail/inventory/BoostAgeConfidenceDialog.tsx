import { useState, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { supabase } from "@/integrations/supabase/client";
import { Camera, Upload, Loader2, Tag, Calendar, Hash, ShieldCheck, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface BoostAgeConfidenceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: {
    id: string;
    item_name: string;
    manufacturer: string | null;
    model_number: string | null;
    category?: string;
    age_confidence_score?: number;
    evidence_json?: any[];
    claim_id?: string;
  };
  claimId: string;
  onBoosted: () => void;
}

export const BoostAgeConfidenceDialog = ({
  open,
  onOpenChange,
  item,
  claimId,
  onBoosted,
}: BoostAgeConfidenceDialogProps) => {
  const [serialNumber, setSerialNumber] = useState(item.model_number || "");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [uploading, setUploading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [labelPhotoUploaded, setLabelPhotoUploaded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const handleLabelPhotoUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);

    try {
      const file = files[0];
      const fileExt = file.name.split(".").pop()?.toLowerCase();
      const fileName = `${crypto.randomUUID()}.${fileExt}`;
      const filePath = `${claimId}/labels/${item.id}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from("claim-files")
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      // Update item with label photo path
      await supabase
        .from("claim_home_inventory")
        .update({ label_photo_path: filePath } as any)
        .eq("id", item.id);

      setLabelPhotoUploaded(true);
      toast.success("Label photo uploaded — will analyze during resolve");
    } catch (err: any) {
      toast.error("Upload failed: " + err.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    }
  };

  const handleBoost = async () => {
    setResolving(true);
    try {
      // Update serial number and purchase date on the item first
      const updates: Record<string, any> = {};
      if (serialNumber && serialNumber !== item.model_number) {
        updates.serial_number = serialNumber;
      }
      if (purchaseDate) {
        updates.original_purchase_date = purchaseDate;
      }

      if (Object.keys(updates).length > 0) {
        await supabase
          .from("claim_home_inventory")
          .update(updates as any)
          .eq("id", item.id);
      }

      // Trigger re-resolve for this specific item
      const { error } = await supabase.functions.invoke("resolve-item-age", {
        body: { claim_id: claimId, item_ids: [item.id] },
      });

      if (error) throw error;

      toast.success("Age confidence updated!");
      onBoosted();
      onOpenChange(false);
    } catch (err: any) {
      toast.error("Failed to resolve: " + err.message);
    } finally {
      setResolving(false);
    }
  };

  const currentConfidence = item.age_confidence_score ?? 0;
  const showLabelPrompt = ["Electronics", "Appliances", "Tools", "HVAC", "Plumbing", "Water Heater"].includes(
    item.category || ""
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Boost Age Confidence
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Current status */}
          <div className="flex items-center justify-between bg-muted/50 rounded-lg p-3">
            <div>
              <p className="font-medium text-sm">{item.item_name}</p>
              <p className="text-xs text-muted-foreground">
                {item.manufacturer || "Unknown brand"} {item.model_number || ""}
              </p>
            </div>
            <Badge variant={currentConfidence >= 60 ? "default" : "destructive"}>
              {currentConfidence}%
            </Badge>
          </div>

          {currentConfidence < 60 && (
            <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/20 rounded-md p-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>Low confidence — add evidence below to strengthen the age determination.</span>
            </div>
          )}

          <Separator />

          {/* Label photo upload */}
          {showLabelPrompt && (
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5 text-sm">
                <Tag className="h-4 w-4" /> Label / Serial Plate Photo
              </Label>
              <p className="text-xs text-muted-foreground">
                Snap the manufacturer label (back, bottom, or inside door) for near-exact age.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => handleLabelPhotoUpload(e.target.files)}
              />
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => handleLabelPhotoUpload(e.target.files)}
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => cameraInputRef.current?.click()}
                  disabled={uploading || labelPhotoUploaded}
                >
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Camera className="h-4 w-4 mr-1" />}
                  Take Photo
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || labelPhotoUploaded}
                >
                  <Upload className="h-4 w-4 mr-1" /> Upload
                </Button>
                {labelPhotoUploaded && (
                  <Badge variant="secondary" className="text-xs">✓ Uploaded</Badge>
                )}
              </div>
            </div>
          )}

          {/* Serial number */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5 text-sm">
              <Hash className="h-4 w-4" /> Serial Number
            </Label>
            <Input
              placeholder="Enter serial number from label"
              value={serialNumber}
              onChange={(e) => setSerialNumber(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Serial numbers often encode the manufacture date for major brands.
            </p>
          </div>

          {/* Purchase date */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5 text-sm">
              <Calendar className="h-4 w-4" /> Purchase Date (if known)
            </Label>
            <Input
              type="date"
              value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
            />
          </div>

          <Separator />

          <Button onClick={handleBoost} disabled={resolving} className="w-full">
            {resolving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
                Resolving...
              </>
            ) : (
              "Re-resolve Age"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
