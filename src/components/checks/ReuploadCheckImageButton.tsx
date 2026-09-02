import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Upload, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { compressCheckImage } from "@/lib/compressCheckImage";
import { isAwsStaging } from "@/lib/awsStaging";
import { useAuth } from "@/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermissions";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { CheckImageCropper } from "@/components/checks/CheckImageCropper";

/**
 * Admin-only "Reupload Front/Back Image" button. Uploads a new image to the
 * claim-files bucket and updates check_intake_items.{front,back}_image_path.
 * Used to recover checks whose original images were lost (e.g. shared from
 * an external CRM before image bytes were persisted locally).
 */
export function ReuploadCheckImageButton({
  checkId,
  side,
  onUploaded,
  size = "sm",
  variant = "outline",
  className,
  hasImage,
  imagePath,
}: {
  checkId: string;
  side: "front" | "back";
  onUploaded?: () => void;
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "outline" | "ghost" | "destructive";
  className?: string;
  /** When true, the check already has this image — button is hidden. Ignored if imagePath is provided. */
  hasImage?: boolean;
  /** The current image path. If it's a legacy signed URL (http...), the image is considered missing. */
  imagePath?: string | null;
}) {
  const { user } = useAuth();
  const { isAdmin } = usePermissions();
  const { toast } = useToast();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingCrop, setPendingCrop] = useState<File | null>(null);

  // Admins can upload/replace the check image at any status. When an image
  // already exists we simply change the label to "Replace" so it's obvious
  // the action overwrites the existing one.
  const pathIsUsable =
    imagePath !== undefined
      ? !!imagePath && !/^https?:\/\//i.test(imagePath)
      : !!hasImage;

  if (!isAdmin) return null;

  const column = side === "front" ? "front_image_path" : "back_image_path";
  const sideLabel = side === "front" ? "Front" : "Back";
  const label = pathIsUsable ? `Replace ${sideLabel}` : `Upload ${sideLabel}`;

  const handleFile = async (rawFile: File | null) => {
    if (!rawFile) return;
    setUploading(true);
    try {
      // Compress + HEIC-convert to keep the check image under CheckAlt/CPU
      // limits and consistent for the endorsement compositor.
      const file = await compressCheckImage(rawFile);
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `checks/reupload/${checkId}/${side}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("claim-files")
        .upload(path, file, {
          contentType: file.type || "image/jpeg",
          upsert: false,
        });
      if (upErr) throw upErr;

      // A freshly uploaded image becomes the new pristine original. Any prior
      // "original" pointer / composited deposit artifact refers to the OLD
      // image and must be cleared, otherwise the endorsement adjuster keeps
      // compositing on the stale back (dropping mortgage endorsements, etc.).
      const updatePayload: Record<string, unknown> = { [column]: path };
      if (side === "back") {
        updatePayload.back_image_original_path = path;
        if (!isAwsStaging()) {
          updatePayload.back_image_deposit_path = null;
          updatePayload.endorsement_render_status = "idle";
          updatePayload.endorsement_render_meta = null;
        }
      }

      const { error: updErr } = await supabase
        .from("check_intake_items")
        .update(updatePayload as any)
        .eq("id", checkId);
      if (updErr) throw updErr;


      // Best-effort audit log
      try {
        await supabase.from("check_audit_log").insert({
          check_intake_item_id: checkId,
          action: `reupload_${side}_image`,
          actor_id: user?.id ?? null,
          details: { storage_path: path, file_name: file.name },
        } as any);
      } catch {
        // ignore audit errors
      }

      toast({
        title: `${side === "front" ? "Front" : "Back"} image uploaded`,
        description: "Check image was replaced successfully.",
      });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["check-image", checkId] });
      qc.invalidateQueries({ queryKey: ["check-detail", checkId] });
      qc.invalidateQueries({ queryKey: ["check-back-img"] });
      qc.invalidateQueries({ queryKey: ["check-back-img-original-for-adjuster", checkId] });
      onUploaded?.();
    } catch (e: any) {
      toast({
        title: "Upload failed",
        description: e?.message ?? "Could not upload image",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <>
      <CheckImageCropper
        open={!!pendingCrop}
        file={pendingCrop}
        title={side === "back" ? "Crop back of check" : "Crop front of check"}
        onCancel={() => setPendingCrop(null)}
        onConfirm={(cropped) => { setPendingCrop(null); handleFile(cropped); }}
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          // PDFs skip the cropper (handled as passthrough anyway)
          if (f.type === "application/pdf") handleFile(f);
          else setPendingCrop(f);
          if (inputRef.current) inputRef.current.value = "";
        }}
      />
      <Button
        size={size}
        variant={variant}
        className={className}
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? (
          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        ) : (
          <Upload className="h-3.5 w-3.5 mr-1.5" />
        )}
        {label}
      </Button>
    </>
  );
}
