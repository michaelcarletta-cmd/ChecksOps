import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Eye, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { DepositImageViewer } from "./DepositImageViewer";

/**
 * Reusable "View Front of Check" button.
 * Looks up the check's front_image_path, generates a signed URL,
 * and opens the existing DepositImageViewer overlay.
 *
 * Pass either `frontImagePath` directly (if you already have it) or
 * `checkId` and the button will fetch it.
 */
export function ViewCheckImageButton({
  checkId,
  frontImagePath,
  checkNumber,
  size = "sm",
  variant = "outline",
  label = "View Front of Check",
  className,
}: {
  checkId?: string | null;
  frontImagePath?: string | null;
  checkNumber?: string | null;
  size?: "default" | "sm" | "lg" | "icon";
  variant?: "default" | "outline" | "ghost" | "secondary";
  label?: string;
  className?: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (!checkId && !frontImagePath) return;
    setLoading(true);
    try {
      let path = frontImagePath ?? null;
      if (!path && checkId) {
        const { data, error } = await supabase
          .from("check_intake_items")
          .select("front_image_path")
          .eq("id", checkId)
          .single();
        if (error) throw error;
        path = (data as any)?.front_image_path ?? null;
      }
      if (!path) {
        toast({
          title: "No front image",
          description: "This check has no front image on file.",
          variant: "destructive",
        });
        return;
      }
      const { data: signed, error: signErr } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(path, 3600);
      if (signErr) throw signErr;
      setUrl(signed?.signedUrl ?? null);
      setOpen(true);
    } catch (e: any) {
      toast({
        title: "Could not open image",
        description: e?.message ?? "Failed to load check image",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        size={size}
        variant={variant}
        className={className}
        disabled={loading || (!checkId && !frontImagePath)}
        onClick={handleClick}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        ) : (
          <Eye className="h-3.5 w-3.5 mr-1.5" />
        )}
        {label}
      </Button>
      <DepositImageViewer
        open={open}
        imageUrl={url}
        title={`Front of Check${checkNumber ? ` #${checkNumber}` : ""}`}
        onClose={() => {
          setOpen(false);
          setUrl(null);
        }}
      />
    </>
  );
}
