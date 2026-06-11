import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Upload, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermissions";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

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
}: {
  checkId: string;
  side: "front" | "back";
  onUploaded?: () => void;
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "outline" | "ghost" | "destructive";
  className?: string;
  /** When true, the check already has this image — button is hidden. */
  hasImage?: boolean;
}) {
  const { user } = useAuth();
  const { isAdmin } = usePermissions();
  const { toast } = useToast();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  if (!isAdmin) return null;
  if (hasImage) return null;


  const column = side === "front" ? "front_image_path" : "back_image_path";
  const label = side === "front" ? "Reupload Front" : "Reupload Back";

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `checks/reupload/${checkId}/${side}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("claim-files")
        .upload(path, file, {
          contentType: file.type || "image/jpeg",
          upsert: false,
        });
      if (upErr) throw upErr;

      const { error: updErr } = await supabase
        .from("check_intake_items")
        .update({ [column]: path } as any)
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
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
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
